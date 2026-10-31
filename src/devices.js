// -----------------------------------------------------------------------------
// The fireplace -> one Gladys device and its states (pure).
//
// `ext:<selector>:intellifire:<serial>`: one device per fireplace, keyed by
// the serial number `/poll` gives (32 hex digits, lower case), never by its
// IP address (it may change). The feature roles (the last part of their
// external ids) are published forever: never rename them. Every role is
// always built, so a republished device never loses a feature.
//
// No switch, no writable binary: a "turn everything off" (Google Home,
// Alexa, HomeKit, MCP, `switch.*` scenes) must never reach a gas flame.
// Turning on and off are two `button/push` features; the flame height and
// the fan speed are `text/select`, the setpoint a `thermostat/target-temperature`.
// Turn on, flame height, fan and setpoint refuse unless the configuration
// allows them; turning off is never held back (src/app.js).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { ERROR_CODES, FAN, FEATURES, FLAME, TEMPERATURE } from './constants.js';
import { ERROR_NAMES, FEATURE_NAMES, STATE_NAMES, word } from './i18n.js';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0 });
const select = {
  category: C.TEXT,
  type: T.TEXT.SELECT,
  min: 0,
  max: 0,
  read_only: false,
  has_feedback: true,
  keep_history: false,
};

/** The features, by role, in display order (the selects get their options in buildDevice). */
export const DEFINITIONS = {
  [FEATURES.STATUS]: text,
  [FEATURES.FLAME_ON]: binary,
  [FEATURES.PILOT]: binary,
  [FEATURES.HOT]: binary,
  [FEATURES.TEMPERATURE]: sensor({
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: -40,
    max: 80,
  }),
  [FEATURES.THERMOSTAT_ON]: binary,
  [FEATURES.TIMER_LEFT]: sensor({
    category: C.DURATION,
    type: T.DURATION.INTEGER,
    unit: U.MINUTES,
    min: 0,
    max: 180,
  }),
  [FEATURES.LIGHT_LEVEL]: sensor({ category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 3 }),
  [FEATURES.ERROR]: binary,
  [FEATURES.ERRORS]: text,
  [FEATURES.TURN_ON]: button,
  [FEATURES.TURN_OFF]: button,
  [FEATURES.FLAME_HEIGHT]: select,
  [FEATURES.FAN_SPEED]: select,
  [FEATURES.SETPOINT]: {
    category: C.THERMOSTAT,
    type: T.THERMOSTAT.TARGET_TEMPERATURE,
    unit: U.CELSIUS,
    min: TEMPERATURE.min,
    max: TEMPERATURE.max,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  },
};

export const ROLES = Object.keys(DEFINITIONS);
export const COMMAND_ROLES = [
  FEATURES.TURN_ON,
  FEATURES.TURN_OFF,
  FEATURES.FLAME_HEIGHT,
  FEATURES.FAN_SPEED,
  FEATURES.SETPOINT,
];

export const fireplaceIds = (gladys, serial) => gladys.externalIds('intellifire', serial);

const SERIAL = '[0-9a-f]{16,64}';

/** The serial and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) return undefined;
  const match = new RegExp(`:intellifire:(${SERIAL}):([a-z-]+)$`).exec(externalId);
  return match && ROLES.includes(match[2]) ? { serial: match[1], role: match[2] } : undefined;
}

/** The serial of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) return undefined;
  const match = new RegExp(`:intellifire:(${SERIAL})$`).exec(externalId);
  return match ? match[1] : undefined;
}

/** The options of the selects: value and label only, labels plain non-blank strings. */
export function selectOptions(role, language) {
  if (role === FEATURES.FLAME_HEIGHT) {
    const options = [];
    for (let h = FLAME.min; h <= FLAME.max; h += 1) {
      options.push({ value: String(h), label: `${h}/${FLAME.max}` });
    }
    return options;
  }
  const options = [];
  for (let s = FAN.min; s <= FAN.max; s += 1) {
    options.push({
      value: String(s),
      label: s === 0 ? word(STATE_NAMES.fanOff, language) : `${s}/${FAN.max}`,
    });
  }
  return options;
}

export const deviceName = (serial) => `IntelliFire ${serial.slice(-4).toUpperCase()}`;

/** The Gladys device of the fireplace read (`data` of parsePoll, `serial` known). */
export function buildDevice(gladys, serial, data, { language }) {
  const ids = fireplaceIds(gladys, serial);
  const params = [{ name: 'serial', value: serial }];
  if (data?.firmware) params.push({ name: 'firmware', value: data.firmware });
  return {
    name: deviceName(serial),
    external_id: ids.device,
    model: 'IntelliFire',
    should_poll: false,
    features: ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...DEFINITIONS[role],
      ...(role === FEATURES.FLAME_HEIGHT || role === FEATURES.FAN_SPEED
        ? { supported_options: selectOptions(role, language) }
        : {}),
    })),
    params,
  };
}

/** The text of the status feature. */
export function statusText(data, language) {
  if (data.power === undefined) return word(STATE_NAMES.unknown, language);
  if (!data.power) return word(data.hot ? STATE_NAMES.offHot : STATE_NAMES.off, language);
  return word(
    data.height === undefined ? STATE_NAMES.on : STATE_NAMES.onHeight(data.height + 1),
    language,
  );
}

/** The names of the error codes (unknown codes by their number), or "none". */
export function errorsText(codes, language) {
  if (codes.length === 0) return word(ERROR_NAMES.none, language);
  return codes
    .map((c) => (ERROR_CODES[c] ? word(ERROR_NAMES[ERROR_CODES[c].key], language) : `#${c}`))
    .join(', ');
}

/**
 * The current values of the fireplace's device, from one read. Offline:
 * only the status (Gladys keeps the last value of the others). A field
 * unknown is never published (never as 0).
 */
export function deviceStates(ids, data, { online, language }) {
  if (!online) {
    return [
      {
        device_feature_external_id: ids.feature(FEATURES.STATUS),
        text: word(STATE_NAMES.offline, language),
      },
    ];
  }
  const states = [];
  const add = (role, value) => {
    const { min, max } = DEFINITIONS[role];
    if (value !== undefined && Number.isFinite(value) && value >= min && value <= max) {
      states.push({ role, state: value });
    }
  };
  const bit = (value) => (value === undefined ? undefined : value ? 1 : 0);
  states.push({ role: FEATURES.STATUS, text: statusText(data, language) });
  add(FEATURES.FLAME_ON, bit(data.power));
  add(FEATURES.PILOT, bit(data.pilot));
  add(FEATURES.HOT, bit(data.hot));
  add(FEATURES.TEMPERATURE, data.temperature);
  add(FEATURES.THERMOSTAT_ON, bit(data.thermostat));
  if (data.setpoint?.on) add(FEATURES.SETPOINT, data.setpoint.celsius);
  if (data.timer === false) add(FEATURES.TIMER_LEFT, 0);
  if (data.timer === true && data.timeLeft !== undefined) {
    add(FEATURES.TIMER_LEFT, Math.ceil(data.timeLeft / 60));
  }
  add(FEATURES.LIGHT_LEVEL, data.light);
  if (data.errors !== undefined) {
    add(FEATURES.ERROR, data.errors.length > 0 ? 1 : 0);
    states.push({ role: FEATURES.ERRORS, text: errorsText(data.errors, language) });
  }
  if (data.height !== undefined) {
    states.push({ role: FEATURES.FLAME_HEIGHT, text: String(data.height + 1) });
  }
  if (data.fanSpeed !== undefined) {
    states.push({ role: FEATURES.FAN_SPEED, text: String(data.fanSpeed) });
  }
  return states.map(({ role, ...value }) => ({
    device_feature_external_id: ids.feature(role),
    ...value,
  }));
}
