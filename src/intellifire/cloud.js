// -----------------------------------------------------------------------------
// The IntelliFire cloud (iftapi.net), only for the "Retrieve the key" button:
// one login per click, never by itself, never again for the reads or the
// commands (they are local). As intellifire4py 4.5.6 `IntelliFireCloudInterface`
// does it:
//   POST /a/login               form `username`, `password`: 204 and the
//                               cookies `user`, `auth_cookie`, `web_client_id`
//   GET  /a/enumlocations       { locations: [{ location_id, ... }] }
//   GET  /a/enumfireplaces?location_id=<id>
//                               { fireplaces: [{ serial, apikey, ... }] }
// The `user` cookie is the user id a local command carries, `apikey` the key
// that signs it. Only those, the serials and the location ids are read: the
// rest of the answers (the Wi-Fi name and password of the location among
// them) is never kept, logged nor shown.
//
// The password goes to iftapi.net only, over HTTPS with the certificate
// checked; the integration says who it is (User-Agent `gladys-intellifire`),
// never the app's nor intellifire4py's. Answers bounded in size and time; no
// redirection followed.
// -----------------------------------------------------------------------------

import { request as httpsRequest } from 'node:https';
import { CLOUD, LIMITS, TIMINGS } from '../constants.js';

export class CloudError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'CloudError';
    /** 'refused' (credentials), 'unreachable', 'http', 'protocol', 'none' (no fireplace). */
    this.kind = kind;
    Object.assign(this, details);
  }
}

/** One HTTPS exchange with iftapi.net: `{ status, headers, body }`. */
export function cloudRequest({ method = 'GET', path, headers = {}, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      fn(value);
    };
    const req = httpsRequest(
      {
        host: CLOUD.host,
        port: CLOUD.port,
        method,
        path,
        servername: CLOUD.host,
        headers: {
          'User-Agent': CLOUD.userAgent,
          Accept: 'application/json',
          Connection: 'close',
          ...headers,
          ...(payload
            ? {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': String(payload.length),
              }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > LIMITS.cloudBytes) {
            finish(reject, new CloudError('protocol', 'Answer too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(resolve, {
            status: res.statusCode ?? 0,
            headers: res.headers ?? {},
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', () => finish(reject, new CloudError('unreachable', 'Connection lost')));
      },
    );
    const timer = setTimeout(
      () => finish(reject, new CloudError('unreachable', 'Timeout')),
      timeoutMs,
    );
    req.on('error', (err) =>
      finish(reject, new CloudError('unreachable', `Unreachable: ${err.code ?? 'error'}`)),
    );
    req.end(payload);
  });
}

const TOKEN = /^[A-Za-z0-9._~-]{1,128}$/;
const KEY = /^(?:[0-9a-f]{2}){8,64}$/i;
const SERIAL = /^[0-9a-f]{16,64}$/i;

/** The cookies of a login answer (only the three intellifire4py reads). */
export function cookiesOf(headers) {
  const raw = headers?.['set-cookie'];
  const lines = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const out = {};
  for (const line of lines.slice(0, 20)) {
    const match = /^\s*(user|auth_cookie|web_client_id)=([^;]*)/.exec(String(line));
    if (match && TOKEN.test(match[2])) out[match[1]] = match[2];
  }
  return out;
}

function json(res) {
  if (res.status < 200 || res.status >= 300) {
    throw new CloudError('http', `HTTP ${res.status}`, { status: res.status });
  }
  try {
    const data = JSON.parse(res.body);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    // below
  }
  throw new CloudError('protocol', 'Not a JSON object');
}

/**
 * Logs in and lists the fireplaces of the account: `{ userId, fireplaces:
 * [{ serial, apiKey }] }` (serials in lower case). Throws a CloudError.
 */
export async function fetchCredentials({ user, password }, { transport = cloudRequest } = {}) {
  const timeoutMs = TIMINGS.cloudTimeout;
  const form = `username=${encodeURIComponent(user)}&password=${encodeURIComponent(password)}`;
  const login = await transport({ method: 'POST', path: CLOUD.login, body: form, timeoutMs });
  if (login.status >= 400 && login.status < 500 && login.status !== 429) {
    throw new CloudError('refused', `HTTP ${login.status}`, { status: login.status });
  }
  if (login.status !== 204) {
    throw new CloudError('http', `HTTP ${login.status}`, { status: login.status });
  }
  const cookies = cookiesOf(login.headers);
  if (!cookies.user || !cookies.auth_cookie) {
    throw new CloudError('protocol', 'No session cookie');
  }
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  const headers = { Cookie: cookie };
  const locations = json(await transport({ path: CLOUD.locations, headers, timeoutMs }));
  const ids = (Array.isArray(locations.locations) ? locations.locations : [])
    .slice(0, LIMITS.cloudItems)
    .map((l) => (typeof l?.location_id === 'string' ? l.location_id : undefined))
    .filter((id) => id !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(id));
  const fireplaces = [];
  for (const id of ids) {
    const list = json(
      await transport({
        path: `${CLOUD.fireplaces}?location_id=${encodeURIComponent(id)}`,
        headers,
        timeoutMs,
      }),
    );
    for (const f of (Array.isArray(list.fireplaces) ? list.fireplaces : []).slice(
      0,
      LIMITS.cloudItems,
    )) {
      if (typeof f?.serial === 'string' && SERIAL.test(f.serial) && KEY.test(f?.apikey ?? '')) {
        fireplaces.push({ serial: f.serial.toLowerCase(), apiKey: f.apikey.toLowerCase() });
      }
    }
  }
  return { userId: cookies.user, fireplaces };
}
