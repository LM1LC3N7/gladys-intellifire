// -----------------------------------------------------------------------------
// The local API of the fireplace (src/constants.js PATHS): a read of
// `/poll`, and a command = a fresh challenge then its signed post. One
// request at a time is the business of the caller (src/lane.js): this client
// only chains the requests of one command.
//
// A post answered 403 to a challenge received less than 5 s before is the
// key or the user id refused, but a challenge may also have just expired:
// a second post with a NEW challenge is tried once (time allowing); a 403
// again is a refusal (`ERROR_KINDS.AUTH`). Reads are never retried here; a
// post is never sent twice for one challenge.
// -----------------------------------------------------------------------------

import { COMMANDS, PATHS, TIMINGS } from '../constants.js';
import { FireplaceError, ERROR_KINDS, request as httpRequest } from './http.js';
import { parseChallenge, parsePoll, signedForm } from './model.js';

/** Retry-After in ms (seconds only: the module has no clock worth comparing). */
function retryAfterOf(headers) {
  const raw = headers?.['retry-after'];
  return typeof raw === 'string' && /^\s*\d{1,6}\s*$/.test(raw) ? Number(raw) * 1000 : undefined;
}

function statusError(res) {
  const { status } = res;
  if (status === 429 || status === 503) {
    return new FireplaceError(ERROR_KINDS.RATE_LIMITED, `HTTP ${status}`, {
      status,
      retryAfter: retryAfterOf(res.headers),
    });
  }
  return new FireplaceError(ERROR_KINDS.HTTP, `HTTP ${status}`, {
    status,
    redirect: status >= 300 && status < 400,
  });
}

/** Whether a command value is within the range of the API (intellifire4py `_range_check`). */
export function inRange(command, value) {
  return Number.isInteger(value) && value >= command.min && value <= command.max;
}

export class FireplaceClient {
  constructor({ transport = httpRequest, now = () => performance.now() } = {}) {
    this.transport = transport;
    this.now = now;
  }

  async get(target, path, { timeoutMs, signal }) {
    const res = await this.transport({
      host: target.host,
      port: target.port,
      path,
      timeoutMs,
      signal,
    });
    if (res.status < 200 || res.status >= 300) {
      throw Object.assign(statusError(res), { sent: true });
    }
    return res.body;
  }

  /** `GET /poll`: the parsed state (src/intellifire/model.js parsePoll). */
  async poll(target, options) {
    const data = parsePoll(await this.get(target, PATHS.poll, options));
    if (!data) {
      throw new FireplaceError(ERROR_KINDS.PROTOCOL, 'Not a JSON object', { sent: true });
    }
    return data;
  }

  /**
   * One command: a challenge, then its signed post. `beforeSend` runs right
   * before the first byte of each post (never before a challenge, which
   * changes nothing) and may refuse it. `until` (monotonic) bounds the whole
   * command. Resolves when a post is answered 2xx; throws a FireplaceError
   * whose `sent` says whether a post may have reached the fireplace.
   */
  async command(target, credentials, command, value, { until, signal, beforeSend }) {
    if (!inRange(command, value)) {
      throw new FireplaceError(ERROR_KINDS.PROTOCOL, 'Value out of range');
    }
    let sent = false;
    const left = () => Math.round(until - this.now());
    // `post`: the error of a post keeps its own `sent` (a byte may have left);
    // a challenge is only a nonce, so its error says what the posts before did.
    const step = async (fn, post) => {
      if (left() < TIMINGS.commandMinRequest / 2) {
        throw new FireplaceError(sent ? ERROR_KINDS.TIMEOUT : ERROR_KINDS.LATE, 'No time left', {
          sent,
        });
      }
      try {
        return await fn(Math.max(1, left()));
      } catch (err) {
        if (err instanceof FireplaceError) err.sent = post ? err.sent || sent : sent;
        throw err;
      }
    };
    for (let attempt = 1; ; attempt += 1) {
      const challenge = parseChallenge(
        // A challenge is only a nonce: asking for it changes nothing (`sent` stays as it was).
        await step((timeoutMs) => this.get(target, PATHS.challenge, { timeoutMs, signal }), false),
      );
      if (!challenge) {
        throw new FireplaceError(ERROR_KINDS.PROTOCOL, 'No challenge', { sent });
      }
      const receivedAt = this.now();
      const body = signedForm(credentials, challenge, command.name, value);
      const res = await step(
        (timeoutMs) =>
          this.transport({
            host: target.host,
            port: target.port,
            method: 'POST',
            path: PATHS.post,
            body,
            timeoutMs,
            signal,
            beforeSend: () => {
              if (this.now() - receivedAt > TIMINGS.challengeMaxAge) {
                throw new Error('Challenge too old');
              }
              beforeSend?.();
              sent = true;
            },
          }),
        true,
      );
      if (res.status >= 200 && res.status < 300) {
        return { attempts: attempt };
      }
      // Answered with a refusal (a 4xx): that post was not applied. A 5xx may have been.
      sent = res.status >= 500;
      if (res.status === 403 && attempt === 1 && left() >= TIMINGS.commandMinRequest * 2) {
        // A challenge just expired, or a key refused: one more try with a new challenge.
        continue;
      }
      if (res.status === 403) {
        throw new FireplaceError(ERROR_KINDS.AUTH, 'HTTP 403', { status: 403, sent: false });
      }
      throw Object.assign(statusError(res), { sent });
    }
  }
}

/** A short reason for the status and the logs (never a body, never a header). */
export function errorReason(err) {
  if (err?.kind === ERROR_KINDS.HTTP) {
    return err.redirect ? `HTTP ${err.status} (redirect)` : `HTTP ${err.status}`;
  }
  if (err?.kind === ERROR_KINDS.AUTH) return 'HTTP 403';
  return err?.kind ?? 'error';
}

export { COMMANDS };
