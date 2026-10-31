// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), with wall dates (a monotonic instant belongs to its process):
//   - `target`: the address and serial of the last fireplace read;
//   - `lastAttemptAt`: the time of the last read (written at most once a
//     minute, BEFORE the read), so a restart never reads sooner than the
//     interval;
//   - `stop`: the turn off not seen applied (address, serial of its
//     fireplace, since, written, resends, refused): a restart sends it again
//     as soon as the key is read (the key is a secret: never in /data, so the
//     turn off waits for the configuration after a restart);
//   - `start`: the session of a turn on (or a setpoint) from Gladys, checked
//     until a read shows its timer or the fire off: never dropped by age;
//   - `pause`: a 429/503 (until).
// No secret (no key, user id, e-mail address nor password, no hash of
// them), no personal data. The file is readable by the container user only
// (0600), bounded and repaired when read; never a special file nor a link
// (opened non-blocking, regular files only). A file that cannot be read is
// not an empty one: `load()` says so, and the app then never overwrites it.
// -----------------------------------------------------------------------------

import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { SESSION, TIMINGS } from './constants.js';
import { serialOf } from './intellifire/model.js';

export const STATE_FILE = '/data/intellifire-state.json';
const MAX_BYTES = 16 * 1024;

/**
 * Every open of /data returns at once, whatever is there (as gladys-usgs-eau
 * 8eaf822, reviewed): O_NONBLOCK (a FIFO never waits for its other end),
 * O_NOFOLLOW (a link is refused), then anything but a regular file is
 * closed before a byte is read or written. The app also bounds every wait
 * for /data in time (src/app.js).
 */
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
const WRITE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_TRUNC |
  constants.O_NONBLOCK |
  constants.O_NOFOLLOW;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  const write = async (text) => {
    const temporary = `${path}.tmp`;
    const handle = await open(temporary, WRITE_FLAGS, 0o600);
    try {
      if (!(await handle.stat()).isFile()) throw new Error('not a regular file');
      await handle.writeFile(text, 'utf8');
    } finally {
      await handle.close().catch(() => {});
    }
    await rename(temporary, path);
  };
  return {
    /** `{ data }`, `{ data: null }` (no file) or `{ unreadable: true }` (a special file included). */
    async load() {
      let handle;
      try {
        handle = await open(path, READ_FLAGS);
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_BYTES) return { unreadable: true };
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let size = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
          if (bytesRead === 0) break;
          size += bytesRead;
          if (size > MAX_BYTES) return { unreadable: true };
        }
        return { data: JSON.parse(buffer.subarray(0, size).toString('utf8')) };
      } catch (err) {
        return err?.code === 'ENOENT' ? { data: null } : { unreadable: true };
      } finally {
        await handle?.close().catch(() => {});
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const job = chain.then(
        () => write(text),
        () => write(text),
      );
      chain = job.catch(() => {});
      return job;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null, { unreadable = false, failSave = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    unreadable,
    failSave,
    /** A promise that holds every save until it resolves (a hung disk), or undefined. */
    hang: undefined,
    /** The same for the load (a frozen mount). */
    hangLoad: undefined,
    async load() {
      if (this.hangLoad) await this.hangLoad;
      if (this.unreadable) return { unreadable: true };
      return { data: this.data === null ? null : JSON.parse(JSON.stringify(this.data)) };
    },
    async save(data) {
      if (this.hang) await this.hang;
      if (this.failSave) throw new Error('disk full');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const intIn = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : undefined;

/** An address kept: a host name or IPv4 address in lower case, and a port. */
export function addressOf(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const host =
    typeof raw.host === 'string' && raw.host.length <= 253 && /^[a-z0-9.-]+$/.test(raw.host)
      ? raw.host
      : undefined;
  const port = intIn(raw.port, 1, 65535);
  return host && port ? { host, port } : undefined;
}

function normalizeStop(raw, now) {
  const address = addressOf(raw);
  if (!address) return undefined;
  // `since` only dates the status: a date in the future (a clock set back) or none: now.
  const since = Number.isFinite(raw.since) && raw.since <= now ? raw.since : now;
  return {
    ...address,
    serial: serialOf(raw.serial) ?? null,
    since,
    written: raw.written === true,
    // Never written: no resend can have been counted (a turn off that never left is never held).
    resends: raw.written === true ? (intIn(raw.resends, 0, 100) ?? 0) : 0,
    refused: raw.refused === true,
  };
}

/**
 * The check of a turn on (or a setpoint) from Gladys: never dropped by age
 * (only a read ends it); a date in the future counts as now.
 */
function normalizeStart(raw, now) {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.since)) return null;
  const minutes = intIn(raw.minutes, SESSION.min, SESSION.max);
  const serial = serialOf(raw.serial);
  if (!minutes || !serial) return null;
  return {
    since: Math.min(raw.since, now),
    minutes,
    serial,
    timerSeen: raw.timerSeen === true,
    reposted: raw.reposted === true,
    thermostat: raw.thermostat === true,
  };
}

/**
 * The persisted state, repaired and bounded (see the header). A time in the
 * future for `lastAttemptAt` counts as now: never a longer wait than the interval.
 */
export function normalizeMemory(raw, now) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const target = addressOf(data.target);
  const pause = data.pause;
  return {
    target: target ? { ...target, serial: serialOf(data.target?.serial) ?? null } : null,
    lastAttemptAt: Number.isFinite(data.lastAttemptAt) ? Math.min(data.lastAttemptAt, now) : null,
    stop: normalizeStop(data.stop, now) ?? null,
    start: normalizeStart(data.start, now),
    pause:
      pause && typeof pause === 'object' && Number.isFinite(pause.until) && pause.until > now
        ? { until: Math.min(pause.until, now + TIMINGS.rateLimitMax) }
        : null,
  };
}
