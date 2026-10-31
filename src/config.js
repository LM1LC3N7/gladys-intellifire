// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The key, the
// user id and the password of the IntelliFire account are kept here in
// memory only: never logged, never written to /data, never put in a status
// or an error.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, LIMITS, POLL_INTERVAL, SESSION, TEMPERATURE } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  address: '',
  api_key: '',
  user_id: '',
  username: '',
  password: '',
  allow_control: false,
  session_duration: SESSION.default,
  max_temperature: TEMPERATURE.defaultMax,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Addresses that are never one fireplace: broadcast, multicast, "any". */
function unusableIpv4(host) {
  const [a, b, c, d] = host.split('.').map(Number);
  return (
    (a === 0 && b === 0 && c === 0 && d === 0) ||
    (a === 255 && b === 255 && c === 255 && d === 255) ||
    (a >= 224 && a <= 239)
  );
}

/**
 * The address of the fireplace typed by the user: an IPv4 address or a host
 * name, with an optional port (a pasted URL is reduced to its host and port).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^http:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  // eslint-disable-next-line no-control-regex
  if (text === '' || text.length > 260 || /[\s\u0000-\u001f\u007f@]/.test(text)) {
    return undefined;
  }
  const match = text.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return unusableIpv4(host) ? undefined : { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

const typed = (value) => typeof value === 'string' && value.trim() !== '';

/** A whole number typed in the form, bounded; the default when missing or not a number. */
function bounded(value, { min, max, fallback, round = Math.round }) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (value === null || value === undefined || String(value).trim() === '' || !Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, round(n)));
}

/** The key of the fireplace: 16 to 128 hex digits (an even number), lower case; else ''. */
function keyOf(value) {
  const t = typeof value === 'string' ? value.trim() : '';
  return /^(?:[0-9a-f]{2}){8,64}$/i.test(t) ? t.toLowerCase() : '';
}

/** The user id: a token safe in a form body (letters, digits, `._~-`); else ''. */
function userIdOf(value) {
  const t = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9._~-]{1,128}$/.test(t) ? t : '';
}

/** A text without control characters, bounded; undefined when refused, '' when empty. */
function clean(value, max) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  if (value.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return undefined;
  return value;
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const text = String(c.address ?? '').trim();
  const address = parseAddress(text);
  const apiKey = keyOf(c.api_key);
  const userId = userIdOf(c.user_id);
  const user = clean(
    typeof c.username === 'string' ? c.username.trim() : c.username,
    LIMITS.userMax,
  );
  // The password is kept as typed: a space may be part of it.
  const password = clean(c.password, LIMITS.secretMax);
  const maxTemperature = bounded(c.max_temperature, {
    min: TEMPERATURE.min,
    max: TEMPERATURE.max,
    fallback: TEMPERATURE.defaultMax,
    round: Math.floor,
  });
  return {
    address,
    /** The text typed when it is not an address (shown in the status, cut; never with an `@`). */
    invalidAddress: text !== '' && !address && !text.includes('@') ? text.slice(0, 100) : undefined,
    addressWithAt: text.includes('@'),
    /** Key and user id of the local commands; undefined while one is missing or invalid. */
    credentials: apiKey && userId ? { apiKey, userId } : undefined,
    /** Typed but not valid, or only one of the two. */
    badCredentials:
      (typed(c.api_key) || typed(c.user_id)) && !(apiKey && userId)
        ? typed(c.api_key) && typed(c.user_id)
          ? 'invalid'
          : 'incomplete'
        : undefined,
    /** The IntelliFire account, for the "Retrieve the key" button only. */
    account: user && password ? { user, password } : undefined,
    badAccount:
      user === undefined || password === undefined
        ? 'invalid'
        : (user === '') !== (password === '')
          ? 'incomplete'
          : undefined,
    allowControl: strictTrue(c.allow_control),
    sessionMinutes: bounded(c.session_duration, {
      min: SESSION.min,
      max: SESSION.max,
      fallback: SESSION.default,
      round: Math.floor,
    }),
    maxTemperature,
    pollInterval: bounded(c.poll_interval, {
      min: POLL_INTERVAL.min,
      max: POLL_INTERVAL.max,
      fallback: POLL_INTERVAL.default,
    }),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** What identifies the key and user id, to tell a change (never stored, never logged). */
export const credentialsKey = (config) =>
  config.credentials ? JSON.stringify([config.credentials.apiKey, config.credentials.userId]) : '';

export const sameAddress = (a, b) => Boolean(a && b) && a.host === b.host && a.port === b.port;
