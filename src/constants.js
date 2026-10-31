// -----------------------------------------------------------------------------
// IntelliFire constants, manifest keys, limits and timings.
//
// An IntelliFire gas fireplace (Hearth & Home Technologies: Heat & Glo,
// Heatilator, Majestic, Monessen, Quadra-Fire) with its IFT Wi-Fi module
// answers a small HTTP API on the local network, the one intellifire4py 4.5.6
// (MIT, jeeftor, the library of the IntelliFire integration of Home
// Assistant) uses:
//   GET  /poll            the state of the fireplace, JSON, no authentication;
//   GET  /get_challenge   a hex challenge (valid about 10 s);
//   POST /post            `command=<c>&value=<v>&user=<user id>&response=<r>`
//                         with r = hex SHA-256(key + SHA-256(key + challenge +
//                         "post:command=<c>&value=<v>")), key and challenge as
//                         bytes: 2xx accepted, 403 a challenge or a key refused.
// The key (`apikey`) and the user id (the `user` cookie) are those of the
// IntelliFire account (iftapi.net): typed by the user, or fetched once by the
// "Retrieve the key" button (src/intellifire/cloud.js).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/** The version of the integration (package.json, bumped by the release). */
export const VERSION = (() => {
  try {
    const { version } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    return /^\d+\.\d+\.\d+$/.test(version) ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export const DEFAULT_PORT = 80;

export const PATHS = {
  poll: '/poll',
  challenge: '/get_challenge',
  post: '/post',
};

/** The local commands sent (intellifire4py IntelliFireCommand.local_command, min, max). */
export const COMMANDS = {
  POWER: { name: 'power', min: 0, max: 1 },
  FLAME_HEIGHT: { name: 'flame_height', min: 0, max: 4 },
  FAN_SPEED: { name: 'fan_speed', min: 0, max: 4 },
  /** Hundredths of °C; 0 turns the thermostat mode off. */
  SETPOINT: { name: 'thermostat_setpoint', min: 0, max: 3700 },
  /** Seconds, multiples of 60; 0 cancels the timer. */
  TIMER: { name: 'time_remaining', min: 0, max: 10_800 },
};

/**
 * The error codes of `errors` (intellifire4py IntelliFireErrorCode, from the
 * Android app). `blocks`: a start from Gladys is refused while it is listed.
 */
export const ERROR_CODES = {
  2: { key: 'pilot_flame', blocks: true },
  4: { key: 'flame', blocks: true },
  6: { key: 'fan_delay', blocks: false },
  64: { key: 'maintenance', blocks: false },
  129: { key: 'disabled', blocks: true },
  130: { key: 'pilot_flame', blocks: true },
  132: { key: 'fan', blocks: false },
  133: { key: 'lights', blocks: false },
  134: { key: 'accessory', blocks: false },
  144: { key: 'soft_lock_out', blocks: true },
  145: { key: 'disabled', blocks: true },
  642: { key: 'offline', blocks: true },
  3269: { key: 'ecm_offline', blocks: true },
};

/** The thermostat setpoint (°C, whole degrees): the limit of the API is 37 °C. */
export const TEMPERATURE = {
  min: 5,
  max: 37,
  defaultMax: 26,
};

/** Flame height as Gladys shows it: 1 to 5 (the API's 0 to 4). */
export const FLAME = { min: 1, max: 5 };
/** Fan speed: 0 (off) to 4. */
export const FAN = { min: 0, max: 4 };

/** The timer set at every turn on from Gladys, in minutes (the API allows 180 at most). */
export const SESSION = {
  min: 10,
  max: 180,
  default: 60,
};

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  STATUS: 'status',
  FLAME_ON: 'flame-on',
  PILOT: 'pilot',
  HOT: 'hot',
  TEMPERATURE: 'temperature',
  THERMOSTAT_ON: 'thermostat-on',
  TIMER_LEFT: 'timer-left',
  LIGHT_LEVEL: 'light-level',
  ERROR: 'error',
  ERRORS: 'errors',
  TURN_ON: 'turn-on',
  TURN_OFF: 'turn-off',
  FLAME_HEIGHT: 'flame-height',
  FAN_SPEED: 'fan-speed',
  SETPOINT: 'setpoint',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  FETCH_KEY: 'fetch_key',
};

/** The value a `button/push` feature sends. */
export const PRESSED = 1;

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 10,
  max: 600,
  default: 15,
};

/** The IntelliFire cloud, used only by the "Retrieve the key" button. */
export const CLOUD = {
  host: 'iftapi.net',
  port: 443,
  login: '/a/login',
  locations: '/a/enumlocations',
  fireplaces: '/a/enumfireplaces',
  /** The integration says who it is: never the User-Agent of the app nor of intellifire4py. */
  userAgent: `gladys-intellifire/${VERSION} (+https://github.com/LM1LC3N7/gladys-intellifire)`,
};

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** The largest answer read (a poll is under 1 KB): cut beyond. */
  responseBytes: 16 * 1024,
  /** An answer of the cloud (lists of locations and fireplaces). */
  cloudBytes: 64 * 1024,
  /** Longest text kept from an answer (firmware). */
  textLength: 40,
  /** The most error codes read. */
  errors: 16,
  /** The most locations and fireplaces walked through in the cloud. */
  cloudItems: 20,
  /** E-mail address and password of the IntelliFire account. */
  userMax: 254,
  secretMax: 256,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One request of the polling (the Wi-Fi module answers in well under 1 s on a LAN). */
  readTimeout: 4 * SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** 429 or 503: Retry-After bounded to 1 min .. 6 h, 5 min without (kept in /data). */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 5 * MINUTE,
  /** The time of the last read is written to /data at most this often, before the read. */
  attemptWriteEvery: MINUTE,
  /** `getConfig()` failed: tried again this often, forever. */
  configRetry: 30 * SECOND,
  /** ... every 5 s while a turn off waits for the key it gives. */
  configRetryStop: 5 * SECOND,
  /** The longest wait for /data (a load, a save before a turn on): beyond, done without it. */
  dataWait: 2 * SECOND,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** Values older than this are never sent as new (reconnection, device created). */
  freshFor: 2 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): the first post must leave by
   * 3.5 s after the click, or the command is refused unsent; the ack comes
   * by 4.3 s, after which the command is "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** The least time a request of a command gets. */
  commandMinRequest: 250,
  /** A challenge is used within this time after it was received (the module keeps it ~10 s). */
  challengeMaxAge: 5 * SECOND,
  /** Challenges asked for one command at most (intellifire4py: 10). */
  challengeTries: 10,
  /** After a post, the read back waits this long. */
  applyWait: 500,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A command not confirmed: a new one is always sent for this long (never "already so"). */
  pendingFor: 90 * SECOND,
  /** A session of Gladys: the fire on without its timer this long after the post: acted on. */
  timerGrace: 10 * SECOND,
  /** A thermostat session of Gladys: turned off this long after the end of its time. */
  sessionMargin: 2 * MINUTE,
  /** The turn off: tried again every 250 ms until 3 s after the click. */
  stopRetry: 250,
  stopRetryFor: 3_000,
  /** The turn off waits at most this long for /data before its first byte. */
  stopSaveWait: 200,
  /** A turn off not seen applied: checked every 15 s. */
  stopCheck: 15 * SECOND,
  /** ... spaced up to this while nothing can leave (unreachable, 403s). */
  stopCheckMax: HOUR,
  /** A read that started this soon after the turn off left may not show it yet. */
  stopApplyDelay: 2 * SECOND,
  /** A turn off not applied is posted again at most 3 times (then held, said in the status). */
  stopResends: 3,
  /** Two clicks of "Retrieve the key" at least this far apart (one login per click). */
  cloudMinSpacing: 10 * SECOND,
  cloudTimeout: 10 * SECOND,
};
