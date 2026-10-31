// -----------------------------------------------------------------------------
// The answers of the fireplace (pure parsers) and the signature of a command.
//
// `GET /poll` (intellifire4py IntelliFirePollData, local aliases): every
// field is read strictly. A field missing, empty, of another type or out of
// its range is UNKNOWN (undefined), never 0: `Number('')` is 0 in
// JavaScript, so nothing goes through Number() without a pattern first.
//   serial          32 hex digits: the identity of the fireplace
//   power           the flame (0/1)          pilot     continuous pilot (0/1)
//   hot             the glass is hot (0/1)   height    flame height 0-4
//   fanspeed        0-4                      light     0-3
//   temperature     room temperature, whole °C
//   thermostat      thermostat mode on (0/1)
//   setpoint        the thermostat setpoint in hundredths of °C (intellifire4py
//                   `thermostat_setpoint_c = setpoint / 100`; `set_thermostat_c`
//                   sends °C × 100); 0 = no setpoint
//   timer           sleep timer on (0/1)     timeremaining  seconds left
//   errors          list of error codes      feature_fan, feature_light,
//   fw_ver_str      firmware                 feature_thermostat: what it has
// The temperature is in °C as the module sends it: no °F conversion here.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { COMMANDS, ERROR_CODES, LIMITS } from '../constants.js';

/** A whole number within [min, max], from a number or a plain digit string; else undefined. */
export function int(value, min, max) {
  let n;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && /^-?\d{1,6}$/.test(value)) {
    n = Number(value);
  } else {
    return undefined;
  }
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/** 0 or 1 (or "0"/"1") as a boolean; anything else undefined. */
export function flag(value) {
  const n = int(value, 0, 1);
  return n === undefined ? undefined : n === 1;
}

/** A serial number: 16 to 64 hex digits, in lower case; else undefined. */
export function serialOf(value) {
  return typeof value === 'string' && /^[0-9a-f]{16,64}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

function text(value) {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t !== '' && t.length <= LIMITS.textLength && /^[\x20-\x7e]+$/.test(t) ? t : undefined;
}

/**
 * The setpoint in hundredths of °C: `{ on: false }` for 0 (none), the °C
 * for 500 to 3700 (5 to 37 °C), undefined otherwise (a value under 5 °C
 * other than 0 is not a setpoint any IntelliFire app sets).
 */
export function setpointOf(value) {
  const raw = int(value, 0, COMMANDS.SETPOINT.max);
  if (raw === undefined) return undefined;
  if (raw === 0) return { on: false };
  if (raw < 500) return undefined;
  return { on: true, celsius: raw / 100 };
}

/** The error codes (at most LIMITS.errors), each a whole number; undefined when not a list. */
export function errorsOf(value) {
  if (!Array.isArray(value) || value.length > LIMITS.errors) return undefined;
  const codes = [];
  for (const entry of value) {
    const code = int(entry, 0, 65_535);
    if (code === undefined) return undefined;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/** The error codes that refuse a start from Gladys (unknown codes included: in doubt). */
export const blockingErrors = (codes) => codes.filter((c) => ERROR_CODES[c]?.blocks !== false);

/**
 * The answer of `GET /poll`: `{ serial, power, ... }`, each field undefined
 * when unreadable. Throws when it is not a JSON object.
 */
export function parsePoll(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const own = (key) => (Object.hasOwn(data, key) ? data[key] : undefined);
  return {
    serial: serialOf(own('serial')),
    power: flag(own('power')),
    pilot: flag(own('pilot')),
    hot: flag(own('hot')),
    height: int(own('height'), 0, 4),
    fanSpeed: int(own('fanspeed'), 0, 4),
    light: int(own('light'), 0, 3),
    temperature: int(own('temperature'), -40, 80),
    thermostat: flag(own('thermostat')),
    setpoint: setpointOf(own('setpoint')),
    timer: flag(own('timer')),
    timeLeft: int(own('timeremaining'), 0, COMMANDS.TIMER.max),
    errors: errorsOf(own('errors')),
    hasFan: flag(own('feature_fan')),
    hasLight: flag(own('feature_light')),
    hasThermostat: flag(own('feature_thermostat')),
    firmware: text(own('fw_ver_str')),
  };
}

/** A challenge of `GET /get_challenge`: an even number of hex digits (8 to 128), else undefined. */
export function parseChallenge(body) {
  const t = typeof body === 'string' ? body.trim() : '';
  return /^(?:[0-9a-f]{2}){4,64}$/i.test(t) ? t.toLowerCase() : undefined;
}

/**
 * The form of `POST /post` (intellifire4py `_construct_payload`):
 * response = SHA-256(key ‖ SHA-256(key ‖ challenge ‖ "post:command=c&value=v")),
 * key and challenge taken as bytes.
 */
export function signedForm({ apiKey, userId }, challenge, command, value) {
  const key = Buffer.from(apiKey, 'hex');
  const payload = Buffer.from(`post:command=${command}&value=${value}`, 'utf8');
  const inner = createHash('sha256')
    .update(Buffer.concat([key, Buffer.from(challenge, 'hex'), payload]))
    .digest();
  const response = createHash('sha256')
    .update(Buffer.concat([key, inner]))
    .digest('hex');
  return `command=${command}&value=${value}&user=${userId}&response=${response}`;
}
