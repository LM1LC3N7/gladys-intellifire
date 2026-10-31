// -----------------------------------------------------------------------------
// The integration: the IntelliFire fireplace typed in the configuration (one
// address; the key and user id of the IntelliFire account to sign its
// commands), one read of `/poll` every poll interval, its Gladys device and
// states, the transport badge, the "Test the connection" and "Retrieve the
// key" buttons, the commands (turn on, flame height, fan speed, setpoint:
// only when the configuration allows them) and the turn off (never held
// back). index.js only wires the SDK handlers to it.
//
// One HTTP exchange at a time on the line (src/lane.js): a read, a command
// (its fresh read, its challenges and posts, its read back), the turn off.
//
// Reads:
//   - never sooner than the interval after the last one: not for the test
//     button, a Discovery scan, a reconnection to Gladys, a configuration
//     saved unchanged, nor a restart (the time of the last read is kept in
//     /data, written at most once a minute, BEFORE the read); only the reads
//     that follow a command (5 s, 20 s) and the checks of a turn off;
//   - the serial number of every read is the identity: the values go to the
//     device of that serial; a read without one is not applied;
//   - a read is applied only when it started after the last post left and
//     after the read last applied (order of departure, never of answer);
//     values older than 2 minutes are never sent as new.
//
// Commands (turn on, flame height, fan speed, setpoint):
//   - refused unless "Allow turning on, the flame, the fan and the setpoint"
//     is on, checked on arrival and again right before every post (in
//     `beforeSend`, nothing in between);
//   - decided on a fresh read (serial, state), never on the state in memory;
//     refused when a value they need is missing; the flame height and the
//     setpoint refused while the fireplace is off (they never light it), the
//     turn on refused while a fault that disables it is listed;
//   - the setpoint bounded to 5 °C .. the highest setpoint of the
//     configuration (26 °C by default, 37 °C at most);
//   - a turn on always sets the timer of the configuration right after the
//     flame, a setpoint right before it (the thermostat mode has no safety
//     shutdown of its own); a timer that cannot be set turns the fireplace
//     off at once; then the reads watch the session (kept in /data, never
//     lifted by time): the timer read or the fire read off ends it, the fire
//     without the timer gets it posted once more, then the turn off; a
//     thermostat session still burning after its end is turned off;
//   - one at a time; the first post leaves by 3.5 s after the click or not
//     at all; answered by 4.3 s; confirmed only by a read back showing what
//     was asked ("sent, not applied yet" when it shows what was there
//     before, "sent, without confirmation" when it cannot be read).
//
// The turn off (power 0, then thermostat setpoint 0) protects: never held
// back by the option, a read or a command in progress (it ends them), a
// failed read, a 429/503 pause, a fireplace never read, nor a configuration
// not read yet (it goes to the address of the last read kept in /data). A
// command that arrived before it and has not left gives way. It needs the
// key and the user id: without them, when its fireplace refuses them (on
// proof only: a 403 is a challenge expired; that fireplace only), or when
// the key is known to be another fireplace's (accepted by it, or retrieved
// for it), it is kept (in /data) and leaves as soon as a key is saved (or a
// test succeeds). Each fireplace (serial) has its own turn off kept (4 at
// most), which follows the configured address; another serial at the
// address gets nothing and never lets it go, nor does the turn off of
// another device. Tried again every 250 ms for 3 s; not seen applied, it is
// kept in /data and checked every 15 s (spaced up to 1 h while nothing can
// leave): posted again while the flame is on (3 times at most, then held
// and said in the status), let go when a read of its serial shows the fire
// off (two reads in a row when it never left), or when a newer turn on of
// that fireplace clicked in Gladys left. Never by time. After shutdown()
// nothing is requested nor armed: a command is refused, a turn off kept in
// /data for the next start.
//
// Clocks: `monotonic` paces everything in memory; the wall clock only dates
// what /data keeps for the next process.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { credentialsKey, normalizeConfig, sameAddress } from './config.js';
import {
  COMMANDS,
  FAN,
  FEATURES,
  FLAME,
  LIMITS,
  PRESSED,
  SECOND,
  SESSION,
  TEMPERATURE,
  TIMINGS,
} from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  deviceStates,
  errorsText,
  fireplaceIds,
  parseDeviceId,
  parseFeatureId,
  statusText,
} from './devices.js';
import { ERRORS, T, age, join, word } from './i18n.js';
import { fetchCredentials } from './intellifire/cloud.js';
import { FireplaceClient, errorReason } from './intellifire/client.js';
import { ERROR_KINDS, FireplaceError } from './intellifire/http.js';
import { blockingErrors } from './intellifire/model.js';
import { Lane } from './lane.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

/** A clear refusal of a post (403, another 4xx, a 429/503, a redirection): not applied. */
const clearRefusal = (err) =>
  err?.kind === ERROR_KINDS.AUTH ||
  err?.kind === ERROR_KINDS.RATE_LIMITED ||
  (err?.kind === ERROR_KINDS.HTTP && err.status >= 300 && err.status < 500);

const RETRYABLE = [
  ERROR_KINDS.UNREACHABLE,
  ERROR_KINDS.TIMEOUT,
  ERROR_KINDS.ABORTED,
  ERROR_KINDS.PROTOCOL,
  ERROR_KINDS.RATE_LIMITED,
];

/** The last 4 digits of a serial, as the device name and the status show it. */
const shortId = (serial) => serial.slice(-4).toUpperCase();

const freshFireplace = () => ({
  serial: undefined,
  data: undefined,
  /** Monotonic time the last applied read started (-Infinity: none). */
  readAt: -Infinity,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  noIdentity: false,
  otherSerial: false,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
});

export class IntelliFireApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'intellifire' }),
    transport,
    cloud,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.cloud = cloud;
    this.client = new FireplaceClient({ transport, now: monotonic });
    this.publisher = new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.lane = new Lane();
    this.config = normalizeConfig();
    this.raw = {};
    this.memory = normalizeMemory(null, now());
    this.memoryUnreadable = false;
    this.memoryLoaded = undefined;
    this.fp = freshFireplace();
    this.generation = 0;
    this.started = false;
    this.configRead = false;
    this.configSeq = 0;
    this.savedRaw = undefined;
    this.configChain = Promise.resolve();
    this.configTimer = undefined;
    this.pausedUntil = -Infinity;
    this.lastAttemptAt = -Infinity;
    this.attemptSavedAt = -Infinity;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** Monotonic time the last post left (a read begun before it is not applied). */
    this.lastSentAt = -Infinity;
    /** The command running: { role, seq, sent }. */
    this.command = undefined;
    /** A command sent and not confirmed: { role, until } (never "already so" meanwhile). */
    this.pending = undefined;
    /** Monotonic time the last turn on left. */
    this.lastStartAt = -Infinity;
    /** Counts the turn offs: a command that arrived before the current count gives way. */
    this.protectSeq = 0;
    this.stops = [];
    this.stopWorker = undefined;
    /**
     * The turn offs not seen applied, one per fireplace (serial), oldest
     * first, `LIMITS.stopGuards` at most: a click for another fireplace never
     * lets one go.
     */
    this.stopGuards = [];
    this.checking = false;
    /**
     * The session of a turn on (or a setpoint) from Gladys, checked by the
     * reads until its timer is seen set or the fire seen off (never lifted by
     * time): { since (wall), sentAt (mono), minutes, serial, timerSeen,
     * reposted, thermostat }.
     */
    this.startCheck = undefined;
    /**
     * Serials that refused the current key or user id (10 × 403, on proof):
     * until a new save, a test read or a key retrieved. Their commands are
     * refused; the other fireplaces are never concerned.
     */
    this.refusedBy = new Set();
    /** Serials that accepted a post signed with the current key (a 403 then is a challenge). */
    this.keyWorked = new Set();
    /** The serial the current key was retrieved for ("Retrieve the key"), in this run. */
    this.keyFor = undefined;
    /** Monotonic time of the last click of "Retrieve the key". */
    this.cloudAt = -Infinity;
    /** Set by shutdown(): no request nor timer any more. */
    this.closed = false;
  }

  mono() {
    return this.monotonic();
  }

  /** The turn off kept that was clicked last (the status, the tests), or undefined. */
  get stopGuard() {
    return this.stopGuards.at(-1);
  }

  /** Whether a fireplace refused the current key (on proof). */
  get keyRefused() {
    return this.refusedBy.size > 0;
  }

  /**
   * The serials the current key belongs to, as far as this run knows: those
   * that accepted a post signed with it, and the one it was retrieved for.
   */
  keyOwners() {
    const owners = new Set(this.keyWorked);
    if (this.keyFor) owners.add(this.keyFor);
    return owners;
  }

  /** Whether the current key is known to be another fireplace's than `serial`. */
  keyIsOthers(serial) {
    if (!serial) return false;
    const owners = this.keyOwners();
    return owners.size > 0 && !owners.has(serial);
  }

  /**
   * Whether ten 403s from `serial` (read at the address) prove that it
   * refuses the current key: never when it accepted that key, never when the
   * key belongs to another fireplace (accepted by it, or retrieved for it).
   */
  refusalProvable(serial) {
    return Boolean(serial) && !this.keyWorked.has(serial) && !this.keyIsOthers(serial);
  }

  /** Waits `ms`; ends at once when `signal` aborts (a turn off takes the line). */
  sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const done = () => {
        this.timers.clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = this.timers.setTimeout(done, Math.max(0, ms));
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * `promise` raced against `ms` and `signal`: `{ done: true, value }`, or
   * `{ done: false }`. Never an unbounded wait while the line is held.
   */
  async bounded(promise, ms, signal) {
    let timer;
    let onAbort;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve({ done: false }), Math.max(0, ms));
      onAbort = () => resolve({ done: false });
      if (signal?.aborted) onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([
        promise.then(
          (value) => ({ done: true, value }),
          () => ({ done: true, value: undefined }),
        ),
        late,
      ]);
    } finally {
      this.timers.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // --- /data -------------------------------------------------------------------

  /** Loads /data once (the turn off kept there belongs to the whole run). */
  loadMemory() {
    if (!this.memoryLoaded) {
      this.memoryLoaded = (async () => {
        // Bounded: a frozen mount is unreadable for this run (never overwritten).
        const loaded = await this.bounded(
          Promise.resolve().then(() => this.store.load()),
          TIMINGS.dataWait,
        );
        const result = loaded.done && loaded.value ? loaded.value : { unreadable: true };
        const now = this.now();
        const mono = this.mono();
        if (result?.unreadable) {
          this.memoryUnreadable = true;
          this.logger.warn('IntelliFire: /data cannot be read: it is never overwritten');
          this.memory = normalizeMemory(null, now);
          return;
        }
        this.memory = normalizeMemory(result?.data ?? null, now);
        if (this.memory.pause) {
          this.pausedUntil = Math.max(this.pausedUntil, mono + (this.memory.pause.until - now));
        }
        const start = this.memory.start;
        if (start && !this.startCheck) {
          // Resumed whatever its age: only a read ends it.
          this.startCheck = { ...start, sentAt: mono - (now - start.since) };
          this.logger.warn('IntelliFire: the check of a turn on from Gladys is resumed');
        }
      })();
    }
    return this.memoryLoaded;
  }

  async saveMemory() {
    if (this.memoryUnreadable) {
      return false;
    }
    try {
      await this.store.save(this.memory);
      return true;
    } catch (err) {
      this.logger.warn(`IntelliFire: saving the state to /data failed: ${err.message}`);
      return false;
    }
  }

  /** The turn offs not seen applied, in /data (one per fireplace). */
  persistStop() {
    const stops = this.stopGuards.map((g) => ({
      host: g.target.host,
      port: g.target.port,
      serial: g.serial ?? null,
      since: g.since,
      written: g.written,
      resends: g.resends,
      refused: g.refused,
    }));
    if (JSON.stringify(stops) === JSON.stringify(this.memory.stops ?? [])) {
      return Promise.resolve(true);
    }
    this.memory.stops = stops;
    return this.saveMemory();
  }

  /**
   * At the start of the container, before the configuration is read: the
   * turn offs kept in /data are restored (those not kept in memory yet).
   * Their key is a secret (never in /data): they leave as soon as the
   * configuration gives it (`resumeStop`).
   */
  async boot() {
    await this.loadMemory();
    let restored = 0;
    for (const kept of this.memory.stops ?? []) {
      const serial = kept.serial ?? undefined;
      if (this.stopGuards.some((g) => g.serial === serial)) continue;
      const guard = this.newStopGuard({ host: kept.host, port: kept.port }, serial);
      guard.since = kept.since;
      guard.written = kept.written;
      guard.resends = kept.resends;
      guard.refused = kept.refused;
      this.addGuard(guard);
      restored += 1;
    }
    if (restored === 0) {
      return;
    }
    this.logger.warn(
      `IntelliFire: ${restored} turn off(s) kept in /data wait for the configuration`,
    );
    if (this.configRead) {
      this.resumeStop();
    }
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}, { fresh = false } = {}) {
    if (this.closed) {
      // Closed: a configuration that arrives after shutdown() starts nothing.
      return;
    }
    this.stop();
    this.raw = raw ?? {};
    this.config = normalizeConfig(raw);
    const generation = this.generation;
    await this.fp.running;
    await this.loadMemory();
    if (generation !== this.generation) {
      return;
    }
    if (this.memory.stops?.length > 0) {
      await this.boot();
    }
    this.fp = freshFireplace();
    const kept = this.memory.target;
    if (this.config.address && sameAddress(kept, this.config.address) && kept.serial) {
      this.fp.serial = kept.serial;
    }
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (this.stopGuards.length > 0) {
      // The turn offs follow the fireplace to the address configured now.
      this.followAddress();
      this.resumeStop();
    }
    if (!this.config.address) {
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status()[1], generation);
    if (generation !== this.generation) {
      return;
    }
    const wait = fresh ? 0 : this.firstWait();
    if (wait > 0) {
      this.schedule(wait);
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  /** The wait before the first read after a container start, from the time kept in /data. */
  firstWait() {
    if (this.memoryUnreadable) {
      // The time of the last read is unknown: one read now (a local module, no quota).
      return 0;
    }
    const stored = this.memory.lastAttemptAt;
    if (stored === null) {
      return 0;
    }
    this.lastAttemptAt = Math.max(this.lastAttemptAt, this.mono() - (this.now() - stored));
    // A read may have left up to a minute after the time kept (written at most once a minute).
    const due = stored + TIMINGS.attemptWriteEvery + this.interval;
    return Math.min(this.interval, Math.max(0, due - this.now()));
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    for (const handle of this.fp.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.fp.followUps.clear();
    if (this.lane.holder?.kind === 'read') {
      this.lane.holder.controller.abort();
    }
    this.publisher.stop();
  }

  /** The container stops: every timer (the turn off is in /data), and /data written. */
  async shutdown() {
    // Closed: nothing is requested nor armed any more (a test that stops the app
    // in flight ends; in the container the process exits).
    this.closed = true;
    this.lane.holder?.controller.abort();
    this.stop();
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    for (const guard of this.stopGuards) {
      if (guard.timer) {
        this.timers.clearTimeout(guard.timer);
        guard.timer = undefined;
      }
    }
    this.memory.lastAttemptAt = Number.isFinite(this.lastAttemptAt)
      ? this.now() - (this.mono() - this.lastAttemptAt)
      : this.memory.lastAttemptAt;
    await this.bounded(this.saveMemory(), 2 * SECOND);
  }

  clearTimer() {
    if (this.fp.timer) {
      this.timers.clearTimeout(this.fp.timer);
      this.fp.timer = undefined;
    }
  }

  /**
   * Connected to Gladys: reads the configuration, tried again every 30 s
   * while it fails (with a status), forever, then `connected`.
   */
  async onConnected(getConfig) {
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    const seq = this.configSeq;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      this.logger.warn(`IntelliFire: reading the configuration failed: ${err.message}`);
      await this.loadMemory();
      // Tried again, sooner while a turn off waits for the key.
      const retry = () => {
        this.configTimer = this.timers.setTimeout(
          () => {
            this.configTimer = undefined;
            this.onConnected(getConfig).catch(() => {});
          },
          this.stopGuards.length > 0 ? TIMINGS.configRetryStop : TIMINGS.configRetry,
        );
      };
      // A request that fails after shutdown() arms nothing (it would retry forever).
      if (!this.closed) retry();
      if (this.closed) return;
      const known = this.gladys.config;
      if (!this.configRead && known && typeof known === 'object' && Object.keys(known).length > 0) {
        // The configuration the SDK read just before 'connected': used meanwhile.
        this.logger.info('IntelliFire: the configuration read at the connection is used meanwhile');
        await this.inOrder(() => this.connected(known));
        return;
      }
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnreadable);
      return;
    }
    // A configuration saved after this request left wins over its answer.
    await this.inOrder(() => this.connected(seq !== this.configSeq ? this.savedRaw : raw));
  }

  /** Configurations (read or saved) applied one at a time, in their order of arrival. */
  inOrder(fn) {
    const run = this.configChain.then(fn);
    this.configChain = run.catch(() => {});
    return run;
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection, resend
   * what Gladys keeps in memory only (status, Discovery list, badge), without
   * reading the fireplace nor sending old values.
   */
  async connected(raw = {}) {
    if (this.closed) return;
    this.configRead = true;
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.applyConfig(raw, { reconnection: true });
  }

  /** Only a new address restarts (an interval only reschedules, new credentials resume a turn off). */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null);
  }

  /** The configuration saved: applied in order of arrival, the last one wins. */
  configUpdated(raw = {}) {
    this.configSeq += 1;
    this.savedRaw = raw;
    return this.inOrder(() => this.applyConfig(raw));
  }

  async applyConfig(raw, { reconnection = false } = {}) {
    if (this.closed) return;
    this.configRead = true;
    if (!this.started || this.needsRestart(raw)) {
      this.started = true;
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.raw = raw ?? {};
    this.config = normalizeConfig(raw);
    const newKey = credentialsKey(previous) !== credentialsKey(this.config);
    if (newKey) {
      // Another key: nothing known of whom it belongs to yet.
      this.keyWorked.clear();
      this.keyFor = undefined;
    }
    if (newKey || !reconnection) {
      // Key or user id saved (the same ones too): a refusal is lifted, a turn off waiting leaves.
      this.liftKeyRefusal();
    }
    if (this.config.pollInterval !== previous.pollInterval && this.fp.timer && !this.fp.running) {
      this.schedule(this.fp.online === false ? undefined : this.dueIn());
    }
    if (this.config.allowControl !== previous.allowControl) {
      this.logger.info(`IntelliFire control ${this.config.allowControl ? 'allowed' : 'disabled'}`);
    }
    if (
      reconnection ||
      this.config.language !== previous.language ||
      this.config.maxTemperature !== previous.maxTemperature
    ) {
      this.published = undefined;
      this.badge = undefined;
      this.lastStatus = undefined;
    }
    if (reconnection) {
      this.gladys.forgetPublishedStates?.();
    }
    await this.publishAll();
  }

  async setStatus(connected, message, generation = this.generation) {
    if (generation !== this.generation || this.closed) {
      return;
    }
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- Pause -----------------------------------------------------------------

  get paused() {
    return this.mono() < this.pausedUntil;
  }

  /** A 429 or a 503: every path waits but the turn off, kept in /data. */
  async pause(err) {
    const length = Math.min(
      TIMINGS.rateLimitMax,
      Math.max(TIMINGS.rateLimitMin, err?.retryAfter ?? TIMINGS.rateLimitDefault),
    );
    this.pausedUntil = Math.max(this.pausedUntil, this.mono() + length);
    this.memory.pause = { until: this.now() + (this.pausedUntil - this.mono()) };
    // Never awaited: a hung /data never holds the reads (nor the test button).
    this.saveMemory().catch(() => {});
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  dueIn(mono = this.mono()) {
    return Math.max(0, this.lastAttemptAt + this.interval - mono);
  }

  schedule(delay) {
    const f = this.fp;
    this.clearTimer();
    if (this.closed) return;
    const mono = this.mono();
    let wait;
    if (this.paused) {
      wait = Math.max(this.pausedUntil - mono, this.interval);
    } else {
      wait = delay ?? (f.online === false ? f.wait : this.interval);
    }
    const generation = this.generation;
    f.timer = this.timers.setTimeout(
      () => {
        f.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch((err) =>
            this.logger.error(`IntelliFire refresh failed: ${err.message}`),
          );
        }
      },
      Math.max(0, wait ?? this.interval),
    );
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const f = this.fp;
    if (this.closed) return Promise.resolve();
    if (!f.running) {
      f.running = this.run().finally(() => {
        f.running = undefined;
      });
    }
    return f.running;
  }

  /** The time of this read, in memory and (at most once a minute) in /data, BEFORE it. */
  async noteAttempt() {
    const mono = this.mono();
    this.lastAttemptAt = mono;
    if (mono - this.attemptSavedAt >= TIMINGS.attemptWriteEvery) {
      this.attemptSavedAt = mono;
      this.memory.lastAttemptAt = this.now();
      // Bounded: a hung disk never stops the reads.
      await this.bounded(this.saveMemory(), TIMINGS.stopSaveWait);
    }
  }

  async run() {
    const generation = this.generation;
    if (!this.config.address || this.closed) {
      return;
    }
    if (this.paused) {
      await this.updateStatus();
      this.schedule();
      return;
    }
    let delay;
    await this.noteAttempt();
    if (generation !== this.generation) {
      return;
    }
    try {
      const holder = await this.lane.acquire('read');
      const startedAt = this.mono();
      let data;
      try {
        if (generation !== this.generation) {
          throw new FireplaceError(ERROR_KINDS.ABORTED, 'Configuration changed');
        }
        data = await this.client.poll(this.config.address, {
          timeoutMs: TIMINGS.readTimeout,
          signal: holder.signal,
        });
      } finally {
        holder.release();
      }
      if (generation !== this.generation) {
        return;
      }
      this.applyRead(data, startedAt);
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      if (err?.kind === ERROR_KINDS.ABORTED) {
        // The line was taken (a turn off, a command): not a failure, nothing applied.
        this.logger.debug('IntelliFire: read ended by a turn off or a command');
      } else {
        delay = await this.failed(err);
      }
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /**
   * A read (poll, fresh read of a command, read back, check of a turn off):
   * applied when it has an identity and started after the last post and the
   * last read applied. Returns whether it was applied. `decided`: the turn
   * off kept whose own check made this read (it decides on it itself).
   */
  applyRead(data, startedAt, decided) {
    const f = this.fp;
    if (!data.serial) {
      throw new FireplaceError(ERROR_KINDS.PROTOCOL, 'No serial number', { identity: true });
    }
    f.online = true;
    f.failures = 0;
    f.wait = undefined;
    f.error = undefined;
    f.noIdentity = false;
    if (startedAt <= this.lastSentAt || startedAt <= f.readAt) {
      this.logger.debug('IntelliFire: read begun before a post or an applied read, not applied');
      return false;
    }
    const kept = this.memory.target;
    f.otherSerial = Boolean(
      kept?.serial && sameAddress(kept, this.config.address) && kept.serial !== data.serial,
    );
    f.serial = data.serial;
    f.data = data;
    f.readAt = startedAt;
    this.saveTarget();
    this.observeStop(data, startedAt, decided);
    this.observeStart(data, startedAt);
    return true;
  }

  /** The address and serial of the last read, in /data (never awaited). */
  saveTarget() {
    const a = this.config.address;
    if (!a || !this.fp.serial) return;
    const target = { host: a.host, port: a.port, serial: this.fp.serial };
    if (JSON.stringify(target) !== JSON.stringify(this.memory.target)) {
      this.memory.target = target;
      this.saveMemory().catch(() => {});
    }
  }

  /** A failed read: the delay before the next one. */
  async failed(err) {
    const f = this.fp;
    const reason = errorReason(err);
    if (err.kind === ERROR_KINDS.RATE_LIMITED) {
      await this.pause(err);
      this.logger.warn(`IntelliFire: ${reason}, pause`);
      return undefined;
    }
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(f.failures, TIMINGS.backoff.length - 1)],
    );
    f.failures += 1;
    f.online = false;
    f.wait = wait;
    f.error = reason;
    f.noIdentity = Boolean(err.identity);
    this.logger.warn(`IntelliFire: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  /** What the status says of one turn off kept. */
  stopNote(g) {
    if (!this.credentialsFor(g.target)) return T.stopWaitsKey;
    if (g.refused) return T.stopKeyRefused;
    if (this.keyIsOthers(g.serial)) return T.stopForeignKey;
    if (g.otherSerial) return T.stopOtherSerial;
    if (g.written && g.resends >= TIMINGS.stopResends && !g.applied) return T.stopHeld;
    return T.stopPending(age(this.now() - g.since));
  }

  /** Notes added to the status: the turn offs kept, a key refused, another serial. */
  withNotes(message) {
    let out = message;
    const several = this.stopGuards.length > 1;
    const current = this.stopSerial();
    for (const g of this.stopGuards) {
      const note = this.stopNote(g);
      // Several fireplaces, or another one than the fireplace read: the note names its own
      // (the last 4 digits of its serial).
      const named = g.serial && (several || g.serial !== current);
      out = join(out, named ? T.ofFireplace(shortId(g.serial), note) : note);
    }
    if (current && this.refusedBy.has(current) && !this.guardFor(current)?.refused) {
      out = join(out, T.keyRefused);
    } else if (!this.config.credentials) {
      out = join(out, this.config.badCredentials ? T.badCredentials : T.noCredentials);
    }
    if (this.fp.otherSerial) {
      out = join(out, T.otherSerial);
    }
    return out;
  }

  /** `[connected, message]` of the configuration screen. */
  status() {
    const f = this.fp;
    const c = this.config;
    if (!c.address) {
      const base = c.addressWithAt
        ? T.addressWithAt
        : c.invalidAddress
          ? T.badAddress(c.invalidAddress)
          : T.noAddress;
      return [false, this.stopGuards.length > 0 ? this.withNotes(base) : base];
    }
    if (this.paused) {
      return [false, this.withNotes(T.paused(age(this.pausedUntil - this.mono())))];
    }
    if (f.online === false) {
      if (f.noIdentity) return [false, this.withNotes(T.noIdentity)];
      return [
        false,
        this.withNotes(T.unreachable(f.error ?? 'error', age(f.wait ?? this.interval))),
      ];
    }
    if (!f.data) {
      return [false, this.withNotes(f.timer ? T.waiting(age(this.dueIn())) : T.connecting)];
    }
    const state = {
      en: statusText(f.data, 'en'),
      fr: statusText(f.data, 'fr'),
    };
    return [true, this.withNotes(T.connected(T.summary(shortId(f.serial), state)))];
  }

  async updateStatus(generation = this.generation) {
    const [connected, message] = this.status();
    await this.setStatus(connected, message, generation);
  }

  // --- Gladys ----------------------------------------------------------------

  /** Whether the values in memory are recent enough to be sent as current. */
  fresh(mono = this.mono()) {
    return Boolean(this.fp.data) && mono - this.fp.readAt <= TIMINGS.freshFor;
  }

  async publishAll() {
    const generation = this.generation;
    await this.publishDevices();
    if (generation !== this.generation) return;
    this.queueStates();
    await this.flush();
    if (generation !== this.generation) return;
    await this.publishBadge();
    if (generation !== this.generation) return;
    await this.updateStatus(generation);
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  async publishDevices() {
    const f = this.fp;
    if (!f.serial || !f.data) {
      return;
    }
    const devices = [
      buildDevice(this.gladys, f.serial, f.data, {
        language: this.config.language,
        maxTemperature: this.config.maxTemperature,
      }),
    ];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /** The states of the last read, only when it is fresh (never old values as new). */
  queueStates(created = this.createdFeatures()) {
    const f = this.fp;
    if (!f.serial) return;
    const online = f.online !== false;
    if (online && !this.fresh()) return;
    const ids = fireplaceIds(this.gladys, f.serial);
    for (const state of deviceStates(ids, f.data ?? {}, {
      online,
      language: this.config.language,
    })) {
      const { device_feature_external_id: id, ...value } = state;
      if (created.has(id)) {
        this.publisher.push(id, value);
      }
    }
  }

  /** The badge of every IntelliFire device created. */
  async publishBadge() {
    const entries = [];
    for (const device of this.gladys.devices ?? []) {
      const serial = parseDeviceId(device?.external_id);
      if (!serial || fireplaceIds(this.gladys, serial).device !== device.external_id) continue;
      const reachable = serial === this.fp.serial && this.fp.online === true && !this.paused;
      entries.push({
        external_id: device.external_id,
        transport: reachable ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) return;
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): its last values, when fresh, at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device of the last read, sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration buttons -------------------------------------------------

  /**
   * A read now, unless the last one is more recent than the interval (then
   * its result). A success lets a turn off refused by the fireplace try
   * once more.
   */
  async testConnection() {
    const f = this.fp;
    if (!this.config.address || this.paused) {
      return this.status()[1];
    }
    if (f.running) {
      await f.running;
    } else if (this.dueIn() > 0) {
      // The last read (less than an interval ago) answers; a good one lifts a refused key too.
      if (f.online === true) this.liftKeyRefusal();
      const last = this.status()[1];
      const next = T.nextRead(age(this.dueIn()));
      return Number.isFinite(this.lastAttemptAt)
        ? join(join(last, T.lastRead(age(this.mono() - this.lastAttemptAt))), next)
        : join(last, next);
    } else {
      this.clearTimer();
      await this.tick();
    }
    if (f === this.fp && f.online === true) {
      // A test read that succeeds lifts a refused key: the commands and a kept turn off try again.
      this.liftKeyRefusal();
    }
    return this.status()[1];
  }

  /** A key refusal lifted (key saved, test read, key retrieved): the turn offs kept leave. */
  liftKeyRefusal() {
    this.refusedBy.clear();
    if (this.stopGuards.length > 0) {
      for (const guard of this.stopGuards) guard.refused = false;
      this.resumeStop();
    }
  }

  /**
   * "Retrieve the key": one login to the IntelliFire cloud per click (10 s
   * apart at least), the key of the fireplace whose serial was read at the
   * address, saved in the configuration by `setConfig`. Never shown.
   */
  async fetchKey() {
    const c = this.config;
    if (c.badAccount === 'invalid') return T.badAccount;
    if (!c.account) return c.badAccount ? T.badAccount : T.noAccount;
    const serial = this.fp.serial ?? this.memory.target?.serial ?? undefined;
    if (!serial) return T.readFirst;
    const since = this.mono() - this.cloudAt;
    if (since < TIMINGS.cloudMinSpacing) return T.tooSoon(age(TIMINGS.cloudMinSpacing - since));
    this.cloudAt = this.mono();
    let found;
    try {
      found = await fetchCredentials(c.account, this.cloud ? { transport: this.cloud } : {});
    } catch (err) {
      this.logger.warn(`IntelliFire cloud: ${err.kind ?? 'error'} (${err.message})`);
      return err.kind === 'refused' ? T.cloudRefused : T.cloudFailed(err.message);
    }
    const match = found.fireplaces.find((fp) => fp.serial === serial);
    if (!match) return T.notInAccount(found.fireplaces.length);
    try {
      await this.gladys.setConfig({ api_key: match.apiKey, user_id: found.userId });
    } catch (err) {
      return T.keyNotSaved(err.code ?? err.status ?? 'error');
    }
    this.logger.info('IntelliFire: key and user id retrieved from the cloud and saved');
    await this.inOrder(async () => {
      // The configuration as it is when this turn comes (one saved before applies first).
      const saved = { ...this.raw, api_key: match.apiKey, user_id: found.userId };
      await this.applyConfig(saved);
      // The key is that of this serial (not a secret, in memory only): ten 403s prove a
      // refused key for this fireplace only, never for another one at the address.
      if (credentialsKey(this.config) === credentialsKey(normalizeConfig(saved))) {
        this.keyFor = serial;
      }
    });
    return T.keySaved;
  }

  // --- Commands --------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /** The value of a command, strictly (null, '', true or 1.5 are never numbers). */
  commandValue(role, value) {
    if (role === FEATURES.TURN_ON) {
      if (value === PRESSED || value === String(PRESSED)) return PRESSED;
      throw this.refusal(ERRORS.badButton);
    }
    const n =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\s*\d{1,3}(?:\.0+)?\s*$/.test(value)
          ? Number(value.trim())
          : NaN;
    const [low, high] =
      role === FEATURES.FLAME_HEIGHT
        ? [FLAME.min, FLAME.max]
        : role === FEATURES.FAN_SPEED
          ? [FAN.min, FAN.max]
          : [TEMPERATURE.min, this.config.maxTemperature];
    if (!Number.isInteger(n) || n < low || n > high) {
      throw this.refusal(ERRORS.badValue(low, high));
    }
    return n;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.mono();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    if (target.role === FEATURES.TURN_OFF) {
      // Never held back: whatever the value, the option, a read or a command.
      return this.protect(received, target.serial);
    }
    if (!this.config.allowControl) {
      throw this.refusal(ERRORS.disabled);
    }
    const wanted = this.commandValue(target.role, value);
    if (this.command) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const entry = { role: target.role, serial: target.serial, seq: this.protectSeq, sent: false };
    this.command = entry;
    try {
      return await this.runCommand(target, wanted, received, entry);
    } finally {
      if (this.command === entry) {
        this.command = undefined;
      }
    }
  }

  /** The checks before any request of a command, and again right before each post. */
  checkCommand(generation, entry) {
    if (this.closed) {
      // After shutdown(): nothing requested any more (no read, no challenge, no post).
      throw this.refusal(ERRORS.closed);
    }
    if (!this.config.allowControl) {
      throw this.refusal(ERRORS.disabled);
    }
    if (generation !== this.generation || !this.config.address) {
      throw this.refusal(ERRORS.unknownFireplace);
    }
    if (entry.seq !== this.protectSeq) {
      throw this.refusal(ERRORS.stopMeanwhile);
    }
    if (this.stops.length > 0 || this.stopWorker) {
      throw this.refusal(ERRORS.stopInProgress);
    }
    // Only a turn on (a newer intent) may go while a turn off of this fireplace is kept.
    if (this.guardFor(entry.serial) && entry.role !== FEATURES.TURN_ON) {
      throw this.refusal(ERRORS.stopInProgress);
    }
    if (this.paused) {
      throw this.refusal(ERRORS.paused(age(this.pausedUntil - this.mono())));
    }
    if (!this.config.credentials) {
      throw this.refusal(ERRORS.noCredentials);
    }
    if (this.refusedBy.has(entry.serial)) {
      throw this.refusal(ERRORS.keyRefused);
    }
    // Signed only with its own key: never with a key known to be another fireplace's.
    if (this.keyIsOthers(entry.serial)) {
      throw this.refusal(ERRORS.notItsKey);
    }
  }

  isPending(role) {
    return this.pending?.role === role && this.mono() < this.pending.until;
  }

  /**
   * What to post, from the fresh read: `{ steps: [{ command, value }],
   * expect, before }`, or undefined when it is already so.
   */
  plan(role, wanted, fresh) {
    if (fresh.power === undefined) {
      throw this.refusal(ERRORS.missing);
    }
    if (role === FEATURES.TURN_ON) {
      if (fresh.errors === undefined) {
        throw this.refusal(ERRORS.missing);
      }
      const blocking = blockingErrors(fresh.errors);
      if (blocking.length > 0) {
        throw this.refusal(
          ERRORS.faults({ en: errorsText(blocking, 'en'), fr: errorsText(blocking, 'fr') }),
        );
      }
      // Already on: nothing posted (a turn on never re-arms the timer of a fire lit elsewhere).
      if (fresh.power && !this.isPending(role) && !this.guardFor(fresh.serial)) {
        return undefined;
      }
      const seconds = this.config.sessionMinutes * 60;
      return {
        steps: [
          { command: COMMANDS.POWER, value: 1 },
          { command: COMMANDS.TIMER, value: seconds },
        ],
        session: { minutes: this.config.sessionMinutes, timerSeen: false },
        expect: (back) =>
          back.power === true &&
          back.timer === true &&
          back.timeLeft !== undefined &&
          back.timeLeft <= seconds,
        before: (back) => back.power === false,
      };
    }
    if (role === FEATURES.FAN_SPEED) {
      if (fresh.hasFan !== true) throw this.refusal(ERRORS.noFan);
      if (fresh.fanSpeed === undefined) throw this.refusal(ERRORS.missing);
      if (fresh.fanSpeed === wanted && !this.isPending(role)) return undefined;
      return {
        steps: [{ command: COMMANDS.FAN_SPEED, value: wanted }],
        expect: (back) => back.fanSpeed === wanted,
        before: (back) => back.fanSpeed === fresh.fanSpeed,
      };
    }
    // The flame height and the setpoint never light the fireplace.
    if (!fresh.power) {
      throw this.refusal(ERRORS.isOff);
    }
    if (role === FEATURES.FLAME_HEIGHT) {
      const raw = wanted - 1;
      if (fresh.height === undefined) throw this.refusal(ERRORS.missing);
      if (fresh.height === raw && !this.isPending(role)) return undefined;
      return {
        steps: [{ command: COMMANDS.FLAME_HEIGHT, value: raw }],
        expect: (back) => back.height === raw,
        before: (back) => back.height === fresh.height,
      };
    }
    if (fresh.hasThermostat !== true) throw this.refusal(ERRORS.noThermostat);
    if (fresh.setpoint === undefined) throw this.refusal(ERRORS.missing);
    // Bounded again on the latest configuration (it may have been lowered meanwhile).
    if (wanted < TEMPERATURE.min || wanted > this.config.maxTemperature) {
      throw this.refusal(ERRORS.badValue(TEMPERATURE.min, this.config.maxTemperature));
    }
    const same = (s) => s?.on === true && s.celsius === wanted;
    if (same(fresh.setpoint) && !this.isPending(role)) return undefined;
    // The thermostat mode has no 9 h safety shutdown of its own (intellifire4py
    // issue 312): the timer of the session first, the setpoint after it. A
    // timer already running and not longer than the session is kept (never
    // lengthened); the session then ends with it.
    const seconds = this.config.sessionMinutes * 60;
    const running =
      fresh.timer === true &&
      fresh.timeLeft !== undefined &&
      fresh.timeLeft > 0 &&
      fresh.timeLeft <= seconds;
    const setpointStep = { command: COMMANDS.SETPOINT, value: wanted * 100 };
    return {
      steps: running ? [setpointStep] : [{ command: COMMANDS.TIMER, value: seconds }, setpointStep],
      session: running
        ? {
            minutes: Math.min(
              this.config.sessionMinutes,
              Math.max(SESSION.min, Math.ceil(fresh.timeLeft / 60)),
            ),
            timerSeen: true,
          }
        : { minutes: this.config.sessionMinutes, timerSeen: false },
      expect: (back) => same(back.setpoint),
      before: (back) => JSON.stringify(back.setpoint) === JSON.stringify(fresh.setpoint),
      setpoint: true,
    };
  }

  async runCommand(target, wanted, received, entry) {
    const generation = this.generation;
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    this.checkCommand(generation, entry);
    if (!this.configRead) {
      throw this.refusal(ERRORS.notReadYet);
    }
    // The line, or nothing sent: a turn that never comes by 3.5 s is given up.
    const giveUp = new AbortController();
    const giveUpTimer = this.timers.setTimeout(
      () => giveUp.abort(),
      Math.max(0, sendBy - TIMINGS.commandMinRequest - this.mono()),
    );
    let holder;
    try {
      holder = await this.lane.acquire('command', { signal: giveUp.signal });
    } catch {
      throw this.refusal(ERRORS.tooSlow);
    } finally {
      this.timers.clearTimeout(giveUpTimer);
    }
    try {
      return await this.commandOnLine(target, wanted, entry, holder, {
        generation,
        sendBy,
        answerBy,
      });
    } finally {
      holder.release();
    }
  }

  async commandOnLine(target, wanted, entry, holder, { generation, sendBy, answerBy }) {
    const { role } = target;
    const address = this.config.address;
    const credentials = this.config.credentials;
    let fresh;
    const readStart = this.mono();
    try {
      if (this.mono() >= sendBy - TIMINGS.commandMinRequest) {
        throw new FireplaceError(ERROR_KINDS.LATE, 'Too late');
      }
      fresh = await this.client.poll(address, {
        timeoutMs: Math.max(
          TIMINGS.commandMinRequest,
          Math.min(TIMINGS.readTimeout, sendBy - TIMINGS.commandMinRequest - this.mono()),
        ),
        signal: holder.signal,
      });
    } catch (err) {
      if (err.kind === ERROR_KINDS.RATE_LIMITED) {
        this.pause(err).catch(() => {});
      }
      if (err.kind === ERROR_KINDS.ABORTED && entry.seq !== this.protectSeq) {
        throw this.refusal(ERRORS.stopMeanwhile);
      }
      throw this.refusal(
        err.kind === ERROR_KINDS.LATE ? ERRORS.tooSlow : ERRORS.unknownState(errorReason(err)),
      );
    }
    if (generation !== this.generation) {
      throw this.refusal(ERRORS.unknownFireplace);
    }
    // The identity first: never a command to another fireplace than this device.
    if (!fresh.serial || fresh.serial !== target.serial) {
      throw this.refusal(ERRORS.otherFireplace);
    }
    try {
      if (this.applyRead(fresh, readStart)) {
        this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
      }
    } catch {
      // Without identity: refused just above.
    }
    const plan = this.plan(role, wanted, fresh);
    if (!plan) {
      this.checkCommand(generation, entry);
      return undefined;
    }
    this.checkCommand(generation, entry);
    if (plan.session) {
      // The check of the session, in /data before the first byte (a failed or slow save refuses).
      const previous = this.memory.start;
      this.memory.start = {
        since: this.now(),
        minutes: plan.session.minutes,
        serial: target.serial,
        timerSeen: plan.session.timerSeen,
        reposted: false,
        thermostat: Boolean(plan.setpoint),
      };
      const saved = await this.bounded(
        this.saveMemory(),
        Math.min(TIMINGS.dataWait, sendBy - TIMINGS.commandMinRequest - this.mono()),
        holder.signal,
      );
      if (!saved.done || !saved.value) {
        this.memory.start = previous;
        if (entry.seq !== this.protectSeq) throw this.refusal(ERRORS.stopMeanwhile);
        throw this.refusal(saved.done ? ERRORS.notSaved : ERRORS.tooSlow);
      }
    }
    if (this.mono() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
    this.logger.info(`IntelliFire: ${role}`);
    const [first, ...rest] = plan.steps;
    try {
      await this.client.command(address, credentials, first.command, first.value, {
        until: answerBy - TIMINGS.applyWait,
        signal: holder.signal,
        beforeSend: () => {
          // The option, the configuration and the turn offs checked again right before the byte.
          this.checkCommand(generation, entry);
          if (this.mono() > sendBy) {
            throw this.refusal(ERRORS.tooSlow);
          }
          entry.sent = true;
          this.lastSentAt = this.mono();
          if (role === FEATURES.TURN_ON) {
            this.lastStartAt = this.lastSentAt;
          }
          if (plan.session) {
            this.armSession(target.serial, Boolean(plan.setpoint), plan.session);
          }
        },
      });
      this.keyWorked.add(target.serial);
    } catch (err) {
      if (plan.session && (!entry.sent || clearRefusal(err))) {
        this.dropStartCheck();
      }
      if (role === FEATURES.TURN_ON && entry.sent && !clearRefusal(err)) {
        // It may have lit: the newer intent wins over the turn off of this fireplace kept,
        // and the session is checked.
        if (entry.seq === this.protectSeq) {
          this.dropGuard(this.guardFor(target.serial), 'newer turn on, unconfirmed');
        }
      }
      return this.commandFailed(err, entry, role, target.serial);
    }
    if (
      role === FEATURES.TURN_ON &&
      this.guardFor(target.serial) &&
      entry.seq === this.protectSeq
    ) {
      // A newer turn on clicked with the option and accepted lets the turn off before it go
      // (this fireplace's only: another fireplace's turn off is never let go by it).
      this.dropGuard(this.guardFor(target.serial), 'newer turn on');
    }
    for (const step of rest) {
      // Posted whatever the deadline of the ack; only a turn off clicked meanwhile stops it.
      try {
        const sensitive = role !== FEATURES.TURN_ON;
        await this.client.command(address, credentials, step.command, step.value, {
          // The timer of a turn on goes whatever the deadline of the ack (it only
          // ends the fire); a setpoint has the deadline and checks of a first post.
          until: sensitive
            ? answerBy - TIMINGS.applyWait
            : Math.max(answerBy, this.mono() + 2 * SECOND),
          signal: holder.signal,
          beforeSend: () => {
            if (entry.seq !== this.protectSeq) throw this.refusal(ERRORS.stopMeanwhile);
            if (sensitive) {
              this.checkCommand(generation, entry);
              if (this.mono() > sendBy) throw this.refusal(ERRORS.tooSlow);
            }
            this.lastSentAt = this.mono();
          },
        });
      } catch (err) {
        if (entry.seq !== this.protectSeq) {
          throw this.refusal(ERRORS.stopMeanwhile);
        }
        if (role !== FEATURES.TURN_ON) {
          // The setpoint after its timer: not sent or refused; the session checks the fire.
          return this.commandFailed(err, entry, role, target.serial);
        }
        this.logger.warn(`IntelliFire: the timer could not be set (${errorReason(err)}): turn off`);
        this.dropStartCheck();
        this.protectSeq += 1;
        const job = this.queueStop({
          target: { host: address.host, port: address.port },
          received: this.mono(),
          serial: target.serial,
        });
        // The line goes to the turn off now; the ack says where it is, exactly.
        holder.release();
        const outcome = await this.bounded(job.done, answerBy - this.mono());
        this.followUp();
        if (outcome.done && !outcome.value?.error) throw this.refusal(ERRORS.noTimerOff);
        throw this.refusal(job.state.written ? ERRORS.noTimerSent : ERRORS.noTimerKept);
      }
    }
    // The read back alone confirms it.
    await this.sleep(
      Math.min(TIMINGS.applyWait, answerBy - TIMINGS.commandMinRequest - this.mono()),
      holder.signal,
    );
    let back;
    const backStart = this.mono();
    try {
      back = await this.client.poll(address, {
        timeoutMs: Math.max(TIMINGS.commandMinRequest, answerBy - this.mono()),
        signal: holder.signal,
      });
    } catch (err) {
      this.markPending(role);
      this.followUp();
      throw this.refusal(ERRORS.sentUnconfirmed(errorReason(err)));
    }
    this.followUp();
    if (back.serial !== target.serial) {
      this.markPending(role);
      throw this.refusal(ERRORS.sentUnconfirmed('serial'));
    }
    if (this.applyRead(back, backStart)) {
      this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
    }
    if (plan.expect(back)) {
      this.pending = undefined;
      this.logger.info(`IntelliFire: ${role} confirmed by the fireplace`);
      return undefined;
    }
    this.markPending(role);
    if (plan.setpoint && !plan.before(back)) {
      // Another setpoint read back than the one sent (a unit read wrong?): the thermostat off.
      this.logger.warn('IntelliFire: the setpoint read back differs: thermostat setpoint 0');
      try {
        await this.client.command(address, credentials, COMMANDS.SETPOINT, 0, {
          until: this.mono() + 2 * SECOND,
          signal: holder.signal,
          beforeSend: () => {
            this.lastSentAt = this.mono();
          },
        });
      } catch (err) {
        this.logger.warn(`IntelliFire: setpoint 0 failed (${errorReason(err)})`);
      }
      throw this.refusal(ERRORS.setpointDiffers);
    }
    throw this.refusal(plan.before(back) ? ERRORS.notApplied : ERRORS.sentDiffers);
  }

  markPending(role) {
    this.pending = { role, until: this.mono() + TIMINGS.pendingFor };
  }

  /**
   * Whether ten posts answered 403 prove a refused key: only when that
   * serial is the one read at the address, never for a serial that accepted
   * this key nor when the key belongs to another one (`refusalProvable`;
   * intellifire4py reads a 403 as a challenge expired).
   */
  keyRefusalProven(err, serial) {
    return (
      err?.kind === ERROR_KINDS.AUTH && this.refusalProvable(serial) && this.fp.serial === serial
    );
  }

  /** A post that failed: never "not sent" once a byte may have left. */
  commandFailed(err, entry, role, serial) {
    const reason = errorReason(err);
    this.logger.warn(`IntelliFire: ${role} failed (${reason})`);
    if (this.keyRefusalProven(err, serial)) {
      this.refusedBy.add(serial);
      this.updateStatus().catch(() => {});
      throw this.refusal(ERRORS.keyRefused);
    }
    if (err.kind === ERROR_KINDS.AUTH || err.kind === ERROR_KINDS.CHALLENGE) {
      // 403s, not a proof of a refused key: refused this time, never "key refused".
      this.followUp();
      throw this.refusal(ERRORS.challengeRefused);
    }
    if (!err.sent) {
      if (err.cause instanceof Error && err.kind === ERROR_KINDS.YIELDED) {
        // A refusal of beforeSend (option off, a turn off, too late): its own words.
        throw err.cause;
      }
      if (err.kind === ERROR_KINDS.ABORTED && entry.seq !== this.protectSeq) {
        throw this.refusal(ERRORS.stopMeanwhile);
      }
      if (err.kind === ERROR_KINDS.RATE_LIMITED) {
        this.pause(err).catch(() => {});
      }
      if (clearRefusal(err)) {
        this.followUp();
        throw this.refusal(ERRORS.refused(reason));
      }
      throw this.refusal(err.kind === ERROR_KINDS.LATE ? ERRORS.tooSlow : ERRORS.notSent(reason));
    }
    // A 5xx, a silence, a cut: it may have reached the fireplace.
    this.markPending(role);
    this.followUp();
    throw this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  /**
   * Spaced reads after a command: its effect, then a check (each a new read).
   * The reads of an earlier command not done yet are replaced.
   */
  followUp() {
    const generation = this.generation;
    const f = this.fp;
    for (const handle of f.followUps) {
      this.timers.clearTimeout(handle);
    }
    f.followUps.clear();
    if (this.closed) return;
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        f.followUps.delete(handle);
        if (generation === this.generation && !this.paused) {
          Promise.resolve(f.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('IntelliFire refresh failed'));
        }
      }, delay);
      f.followUps.add(handle);
    }
  }

  // --- The session of a turn on (or a setpoint) from Gladys ----------------------

  /** Armed right before the first byte of a turn on or of the timer of a setpoint. */
  armSession(serial, thermostat, { minutes, timerSeen }) {
    if (this.closed) return;
    const c = {
      since: this.now(),
      sentAt: this.mono(),
      minutes,
      serial,
      timerSeen,
      reposted: false,
      thermostat,
    };
    this.startCheck = c;
    this.persistSession();
  }

  /** The session in /data (never awaited: a hung disk never holds a read). */
  persistSession() {
    const c = this.startCheck;
    this.memory.start = c
      ? {
          since: c.since,
          minutes: c.minutes,
          serial: c.serial,
          timerSeen: c.timerSeen,
          reposted: c.reposted,
          thermostat: c.thermostat,
        }
      : null;
    this.saveMemory().catch(() => {});
  }

  dropStartCheck(reason) {
    if (this.startCheck && reason) {
      this.logger.info(`IntelliFire: session of Gladys ended (${reason})`);
    }
    this.startCheck = undefined;
    if (this.memory.start) {
      this.persistSession();
    }
  }

  /** The session ends by a turn off from Gladys (it goes now, whatever the option). */
  endSessionByTurnOff(reason) {
    const c = this.startCheck;
    this.logger.warn(`IntelliFire: ${reason}: turn off`);
    this.dropStartCheck();
    const target = this.stopTarget();
    if (target) {
      this.protectSeq += 1;
      this.queueStop({ target, received: this.mono(), serial: c?.serial });
    }
  }

  /**
   * A read seen by the session (started 2 s after its last post at least,
   * this serial): never lifted by time.
   *   - the fire off (flame off, thermostat off): the session is over, even
   *     if it is lit again by hand later (never fought);
   *   - the timer seen (no more than the session): over for a turn on; a
   *     thermostat session lasts until the end of its time;
   *   - the fire on without that timer, 10 s after the post: the timer posted
   *     once more, then the turn off;
   *   - a thermostat session past its end, the fire or the thermostat on: turn off.
   */
  observeStart(data, startedAt) {
    const c = this.startCheck;
    if (!c || data.serial !== c.serial || startedAt <= c.sentAt + TIMINGS.stopApplyDelay) return;
    let changed = false;
    if (data.thermostat === true && !c.thermostat) {
      c.thermostat = true;
      changed = true;
    }
    const thermostatOff = data.thermostat === false || data.hasThermostat === false;
    if (data.power === false && thermostatOff) {
      this.dropStartCheck('fire seen off');
      return;
    }
    const burning = data.power === true || data.thermostat === true;
    const seconds = c.minutes * 60;
    if (!c.timerSeen) {
      const timerOk =
        data.timer === true && data.timeLeft !== undefined && data.timeLeft <= seconds + 60;
      if (timerOk) {
        c.timerSeen = true;
        changed = true;
        if (!c.thermostat) {
          this.dropStartCheck('timer seen');
          return;
        }
      } else if (burning && this.mono() - c.sentAt >= TIMINGS.timerGrace) {
        if (!c.reposted) {
          c.reposted = true;
          c.sentAt = this.mono();
          c.since = this.now();
          this.persistSession();
          this.repostTimer(c);
          return;
        }
        this.endSessionByTurnOff('lit from Gladys but no timer read');
        return;
      }
    }
    if (
      c.timerSeen &&
      c.thermostat &&
      this.mono() >= c.sentAt + seconds * SECOND + TIMINGS.sessionMargin
    ) {
      if (burning) {
        this.endSessionByTurnOff('end of the thermostat session of Gladys');
      } else {
        this.dropStartCheck('end of the session');
      }
      return;
    }
    if (changed) this.persistSession();
  }

  /** The timer of a session posted once more (a module may ignore it while it lights). */
  async repostTimer(c) {
    if (this.closed) return;
    const target = this.stopTarget();
    const credentials = target && this.credentialsFor(target);
    if (!credentials) {
      this.endSessionByTurnOff('no key to post the timer again');
      return;
    }
    const seq = this.protectSeq;
    let holder;
    try {
      holder = await this.lane.acquire('check');
      if (this.startCheck !== c || seq !== this.protectSeq) return;
      this.logger.warn(
        'IntelliFire: no timer read after a turn on from Gladys: timer posted again',
      );
      await this.client.command(target, credentials, COMMANDS.TIMER, c.minutes * 60, {
        until: this.mono() + TIMINGS.readTimeout,
        signal: holder.signal,
        beforeSend: () => {
          if (this.startCheck !== c || seq !== this.protectSeq) throw new Error('a turn off');
          this.lastSentAt = this.mono();
          c.sentAt = this.lastSentAt;
        },
      });
      this.keyWorked.add(c.serial);
    } catch (err) {
      holder?.release();
      holder = undefined;
      if (this.startCheck === c && seq === this.protectSeq) {
        this.endSessionByTurnOff(`timer posted again failed (${errorReason(err)})`);
      }
    } finally {
      holder?.release();
      this.followUp();
    }
  }

  // --- The turn off (protective) -----------------------------------------------

  /** Where a turn off goes: the configured address, else the last one read (in /data). */
  stopTarget() {
    if (this.config.address) {
      return { host: this.config.address.host, port: this.config.address.port };
    }
    const kept = this.memory.target;
    return kept ? { host: kept.host, port: kept.port } : undefined;
  }

  /** The serial a turn off is for: the one read, else the one kept in /data, else unknown. */
  stopSerial() {
    return this.fp.serial ?? this.memory.target?.serial ?? undefined;
  }

  /** The key and user id of a target: those of the configuration for its address only. */
  credentialsFor(target) {
    return sameAddress(target, this.config.address) ? this.config.credentials : undefined;
  }

  /**
   * The turn off kept for `serial`, or undefined. A turn off kept without
   * serial (an /data written before serials were kept) stands for any one.
   */
  guardFor(serial) {
    return (
      this.stopGuards.find((g) => g.serial === serial) ??
      (serial ? this.stopGuards.find((g) => !g.serial) : undefined)
    );
  }

  hasGuard(guard) {
    return Boolean(guard) && this.stopGuards.includes(guard);
  }

  /**
   * A new turn off kept: one per fireplace, `LIMITS.stopGuards` at most.
   * Beyond, the oldest one of a fireplace that is neither this one nor the
   * one read at the address is let go (logged).
   */
  addGuard(guard) {
    this.stopGuards.push(guard);
    while (this.stopGuards.length > LIMITS.stopGuards) {
      const current = this.stopSerial();
      const oldest =
        this.stopGuards.find((g) => g !== guard && (!current || g.serial !== current)) ??
        this.stopGuards[0];
      this.dropGuard(oldest, `more than ${LIMITS.stopGuards} fireplaces with a turn off kept`);
    }
    return guard;
  }

  /** The turn offs kept follow their fireplace to the address configured now. */
  followAddress() {
    const a = this.config.address;
    if (!a) return;
    let moved = false;
    for (const g of this.stopGuards) {
      if (sameAddress(g.target, a)) continue;
      g.target = { host: a.host, port: a.port };
      g.otherSerial = false;
      moved = true;
    }
    if (!moved) return;
    this.logger.info('IntelliFire: the turn offs kept follow the fireplace to the new address');
    this.persistStop().catch(() => {});
  }

  /** The turn off clicked: queued before anything, answered by 4.3 s after the click. */
  async protect(received, serial) {
    // Every command that arrived before this turn off and has not left gives way.
    this.protectSeq += 1;
    this.dropStartCheck();
    // /data holds the address of the last read: known even before the configuration.
    await this.bounded(this.loadMemory(), TIMINGS.stopSaveWait);
    const target = this.stopTarget();
    if (!target) {
      throw this.refusal(ERRORS.noAddress);
    }
    // The turn off belongs to the device clicked (its serial), never to the last fireplace read.
    const owner = serial ?? this.stopSerial();
    const kept = this.guardFor(owner);
    if (kept) {
      // A new click: this fireplace's turn off held or refused is tried again, in full.
      kept.refused = false;
    }
    const job = this.queueStop({ target, received, serial: owner });
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.mono());
    let timer;
    const outcome = await new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve({ late: true }), answerIn);
      job.done.then(resolve);
    });
    this.timers.clearTimeout(timer);
    if (outcome.late) {
      throw this.refusal(job.state.written ? ERRORS.stopUnconfirmed : ERRORS.stopPending);
    }
    if (outcome.error) {
      throw outcome.error;
    }
    return undefined;
  }

  /** Queues a turn off; a click for the same fireplace and target still waiting is joined. */
  queueStop({ target, received, fromBoot = false, serial }) {
    if (this.closed) {
      return this.keepClosed({ target, serial });
    }
    let job = this.stops.find(
      (j) => !j.running && j.serial === serial && sameAddress(j.target, target),
    );
    if (job) {
      return job;
    }
    job = { target, received, fromBoot, serial, state: { written: false }, running: false };
    job.done = new Promise((resolve) => {
      job.resolve = resolve;
    });
    this.stops.push(job);
    this.runStops();
    return job;
  }

  /**
   * After shutdown(): nothing leaves any more. The turn off is kept (in
   * /data, never awaited) and leaves at the next start of the integration.
   */
  keepClosed({ target, serial }) {
    const guard = this.guardFor(serial) ?? this.addGuard(this.newStopGuard(target, serial));
    if (!guard.serial && serial) guard.serial = serial;
    this.persistStop().catch(() => {});
    const job = { target, serial, state: { written: false } };
    job.done = Promise.resolve({ error: this.refusal(ERRORS.stopClosed) });
    return job;
  }

  runStops() {
    if (this.stopWorker) {
      return;
    }
    // Cleared at the end of its last turn, never before it is set (it may end at once).
    let worker;
    let finished = false;
    worker = (async () => {
      try {
        while (this.stops.length > 0) {
          const job = this.stops[0];
          if (this.closed) {
            this.keepClosed(job).done.then(job.resolve);
            this.stops.shift();
            continue;
          }
          job.running = true;
          try {
            await this.sendStop(job);
          } catch (err) {
            this.logger.warn(`IntelliFire: turn off failed: ${err.message}`);
            job.resolve({ error: this.refusal(ERRORS.stopPending) });
          }
          this.stops.shift();
        }
      } finally {
        finished = true;
        if (this.stopWorker === worker) this.stopWorker = undefined;
      }
    })();
    if (!finished) this.stopWorker = worker;
  }

  /** The turn offs kept that may leave now (key known, not refused): queued, else checked. */
  resumeStop() {
    if (this.closed) return;
    this.followAddress();
    for (const guard of [...this.stopGuards]) {
      const ready =
        this.credentialsFor(guard.target) &&
        !guard.refused &&
        !this.keyIsOthers(guard.serial) &&
        !(guard.written && guard.resends >= TIMINGS.stopResends);
      if (ready && !guard.written) {
        // Never written: it leaves first, as a click would.
        this.queueStop({
          target: guard.target,
          received: this.mono(),
          fromBoot: true,
          serial: guard.serial,
        });
      } else {
        this.armStopCheck(guard, 0);
      }
    }
  }

  newStopGuard(target, serial) {
    return {
      target,
      serial,
      since: this.now(),
      written: false,
      sentAt: undefined,
      resends: 0,
      refused: false,
      otherSerial: false,
      applied: false,
      offReads: 0,
      forbidden: 0,
      watchUntil: -Infinity,
      timer: undefined,
    };
  }

  /** Whether the last read of the address shows another fireplace than this turn off's. */
  otherAtAddress(guard) {
    return Boolean(
      guard.serial &&
      this.fp.serial &&
      this.fp.serial !== guard.serial &&
      sameAddress(guard.target, this.config.address),
    );
  }

  /**
   * What a read says of the turn off: 'other' (another serial answers at
   * the address, or no serial read now and the last read of the address
   * shows another one: nothing posted, nothing applied), 'done' (the flame
   * off, the thermostat off), 'watch' (off, but a turn on sent shortly
   * before may still land), 'wait' (read too soon, or off but the turn off
   * never left: a second read decides), 'blocked' (no key, a key refused on
   * proof, or a key known to be another fireplace's), 'hold' (posted 4
   * times without effect), 'resend'.
   */
  decideStop(guard, read, readStartedAt) {
    if (
      (read?.serial && guard.serial && read.serial !== guard.serial) ||
      (!read?.serial && this.otherAtAddress(guard))
    ) {
      guard.otherSerial = true;
      guard.offReads = 0;
      return 'other';
    }
    guard.otherSerial = false;
    if (
      read?.serial &&
      !guard.serial &&
      !this.stopGuards.some((g) => g !== guard && g.serial === read.serial)
    ) {
      // A turn off kept without serial (an older /data) is the one of the fireplace read.
      guard.serial = read.serial;
      this.persistStop().catch(() => {});
    }
    const off =
      read?.power === false && (read.thermostat === false || read.hasThermostat === false);
    if (off) {
      if (guard.written && (guard.sentAt === undefined || readStartedAt >= guard.sentAt)) {
        guard.applied = true;
        return this.mono() < guard.watchUntil ? 'watch' : 'done';
      }
      guard.offReads += 1;
      return guard.offReads >= 2 ? 'done' : 'wait';
    }
    guard.offReads = 0;
    guard.applied = false;
    if (guard.sentAt !== undefined && readStartedAt < guard.sentAt + TIMINGS.stopApplyDelay) {
      return 'wait';
    }
    if (!this.credentialsFor(guard.target) || guard.refused || this.keyIsOthers(guard.serial)) {
      return 'blocked';
    }
    return guard.written && guard.resends >= TIMINGS.stopResends ? 'hold' : 'resend';
  }

  /**
   * A read seen by the turn offs kept: done, or checked now. `decided`: the
   * turn off whose own check made this read (it decides on it once, itself).
   */
  observeStop(read, startedAt, decided) {
    for (const guard of [...this.stopGuards]) {
      if (guard === decided || !sameAddress(guard.target, this.config.address)) continue;
      const decision = this.decideStop(guard, read, startedAt);
      if (decision === 'done') {
        this.dropGuard(guard, 'applied');
      } else if (decision === 'resend' && !this.checking) {
        this.armStopCheck(guard, 0);
      }
    }
  }

  /**
   * The posts of a turn off on the line held: power 0 (the turn off), then
   * the thermostat setpoint 0 (no thermostat lights it again), the second one
   * best effort. `mark` runs right before the first byte of the first one.
   */
  async postStop(target, credentials, holder, until, mark) {
    await this.client.command(target, credentials, COMMANDS.POWER, 0, {
      until,
      signal: holder.signal,
      beforeSend: mark,
    });
    if (this.fp.data?.hasThermostat === false) return;
    try {
      await this.client.command(target, credentials, COMMANDS.SETPOINT, 0, {
        until: Math.max(until, this.mono() + TIMINGS.commandMinRequest * 4),
        signal: holder.signal,
        beforeSend: () => {
          this.lastSentAt = this.mono();
        },
      });
    } catch (err) {
      if (err.kind === ERROR_KINDS.ABORTED) throw err;
      this.logger.debug(
        `IntelliFire: thermostat off after the turn off failed (${errorReason(err)})`,
      );
    }
  }

  /**
   * After ten 403s to a turn off: a read on the line held says whether this
   * fireplace refuses the key. Returns 'other' (another serial at the
   * address), 'foreign' (the key is known to be another fireplace's: never a
   * refusal), 'refused' (proof: this serial read at the address, a key it
   * never accepted and not known to be another one's; marked for this
   * serial only) or 'retry'.
   */
  async judgeForbidden(guard, target, holder) {
    let read;
    try {
      read = await this.client.poll(target, {
        timeoutMs: TIMINGS.readTimeout,
        signal: holder.signal,
      });
    } catch {
      return 'retry';
    }
    if (read.serial && guard.serial && read.serial !== guard.serial) {
      guard.otherSerial = true;
      return 'other';
    }
    const serial = guard.serial ?? read.serial;
    if (!read.serial || read.serial !== serial) return 'retry';
    if (this.keyIsOthers(serial)) return 'foreign';
    if (!this.refusalProvable(serial)) return 'retry';
    guard.refused = true;
    this.refusedBy.add(serial);
    return 'refused';
  }

  /**
   * One turn off: its posts without a read first, then the read back that
   * alone confirms it. Unreachable, cut, silent, a 5xx or 403s: tried again
   * every 250 ms until 3 s after the click. Not confirmed: kept (in /data)
   * and checked every 15 s (spaced up to 1 h while nothing leaves).
   */
  async sendStop(job) {
    const { target, state } = job;
    const retryUntil = Math.max(job.received, this.mono()) + TIMINGS.stopRetryFor;
    // One turn off per fireplace: a click for another serial never lets this one go.
    const guard = this.guardFor(job.serial) ?? this.addGuard(this.newStopGuard(target, job.serial));
    guard.target = target;
    // A turn off kept without serial (an older /data) belongs to the device clicked.
    if (!guard.serial && job.serial) guard.serial = job.serial;
    if (!job.fromBoot) {
      guard.since = this.now();
      guard.resends = 0;
      guard.refused = false;
      guard.forbidden = 0;
    }
    guard.watchUntil = Math.max(guard.watchUntil, this.lastStartAt + TIMINGS.pendingFor);
    // In /data before the first byte; a save that fails or hangs never holds it (200 ms at most).
    await this.bounded(this.persistStop(), TIMINGS.stopSaveWait);
    const credentials = this.credentialsFor(target);
    if (this.otherAtAddress(guard)) {
      // The last read at the address is another fireplace: nothing posted to it,
      // no refusal counted; the checks read the address and post once this one is back.
      guard.otherSerial = true;
      this.armStopCheck(guard);
      this.persistStop().catch(() => {});
      this.updateStatus().catch(() => {});
      job.resolve({ error: this.refusal(ERRORS.stopOtherSerial) });
      return;
    }
    const foreign = this.keyIsOthers(guard.serial);
    if (!credentials || guard.refused || foreign) {
      // Nothing can sign it (no key, a key it refused, another fireplace's key): kept, it
      // leaves when a key is saved; the reads watch it.
      this.armStopCheck(guard);
      this.persistStop().catch(() => {});
      this.updateStatus().catch(() => {});
      job.resolve({
        error: this.refusal(
          !credentials
            ? ERRORS.stopWaitsKey
            : guard.refused
              ? ERRORS.stopKeyRefused
              : ERRORS.stopForeignKey,
        ),
      });
      return;
    }
    const resendOnBoot = job.fromBoot && guard.written;
    let back;
    let backStart;
    let failure;
    let judged;
    this.logger.info('IntelliFire: turn off');
    for (;;) {
      const holder = await this.lane.acquire('stop');
      // A post answered with a refusal (403s) never applied: written as before it.
      const before = { state: state.written, guard: guard.written, sentAt: guard.sentAt };
      try {
        await this.postStop(target, credentials, holder, retryUntil, () => {
          state.written = true;
          const at = this.mono();
          this.lastSentAt = at;
          if (this.hasGuard(guard)) {
            guard.written = true;
            guard.sentAt = at;
            guard.forbidden = 0;
            guard.watchUntil = Math.max(guard.watchUntil, this.lastStartAt + TIMINGS.pendingFor);
          }
        });
        failure = undefined;
        if (guard.serial ?? this.fp.serial) this.keyWorked.add(guard.serial ?? this.fp.serial);
        if (resendOnBoot && this.hasGuard(guard)) {
          guard.resends += 1;
        }
        await this.sleep(
          Math.min(TIMINGS.applyWait, job.received + TIMINGS.commandAnswerBy - 600 - this.mono()),
        );
        try {
          backStart = this.mono();
          back = await this.client.poll(target, {
            timeoutMs: Math.max(
              TIMINGS.commandMinRequest,
              job.received + TIMINGS.commandAnswerBy - this.mono(),
            ),
            signal: holder.signal,
          });
        } catch (err) {
          this.logger.debug(`IntelliFire: read back of the turn off failed (${errorReason(err)})`);
        }
        break;
      } catch (err) {
        failure = err;
        if (!err.sent) {
          state.written = before.state;
          guard.written = before.guard;
          guard.sentAt = before.sentAt;
        }
        if (err.kind === ERROR_KINDS.AUTH) {
          judged = await this.judgeForbidden(guard, target, holder);
        }
      } finally {
        holder.release();
      }
      // Ten 403s: this serial refuses the key (kept until a new key, a test read or a
      // click), another fireplace answers, or the key is another fireplace's.
      if (judged === 'refused' || judged === 'other' || judged === 'foreign') break;
      const again =
        RETRYABLE.includes(failure.kind) ||
        failure.kind === ERROR_KINDS.AUTH ||
        failure.kind === ERROR_KINDS.CHALLENGE ||
        (failure.kind === ERROR_KINDS.HTTP && failure.status >= 500);
      if (!again || this.closed || this.mono() + TIMINGS.stopRetry >= retryUntil) {
        break;
      }
      await this.sleep(TIMINGS.stopRetry);
    }
    if (back && sameAddress(target, this.config.address)) {
      try {
        if (this.applyRead(back, backStart, guard)) {
          this.publishAll().catch(() => {});
        }
      } catch {
        // No identity: the decision below still reads the flame.
      }
    }
    const decision = back === undefined ? undefined : this.decideStop(guard, back, Infinity);
    const confirmed = decision === 'done' || decision === 'watch';
    const forbidden = failure?.kind === ERROR_KINDS.AUTH || failure?.kind === ERROR_KINDS.CHALLENGE;
    if (forbidden && !state.written && this.hasGuard(guard)) guard.forbidden += 1;
    if (this.hasGuard(guard)) {
      if (decision === 'done') {
        this.dropGuard(guard, 'applied');
      } else {
        // Armed before /data is written, never awaited: a hung disk never stops the checks.
        this.armStopCheck(guard, decision === 'watch' ? this.watchDelay(guard) : undefined);
        this.persistStop().catch(() => {});
      }
    }
    if (state.written) {
      this.followUp();
    }
    let result;
    if (confirmed) {
      this.logger.info('IntelliFire: turn off confirmed by the fireplace');
      result = {};
    } else if (judged === 'other') {
      result = { error: this.refusal(ERRORS.stopOtherSerial) };
    } else if (judged === 'foreign') {
      result = { error: this.refusal(ERRORS.stopForeignKey) };
    } else if (failure) {
      const reason = errorReason(failure);
      this.logger.warn(`IntelliFire: turn off failed (${reason})`);
      if (judged === 'refused') {
        result = { error: this.refusal(ERRORS.stopKeyRefused) };
      } else if (!state.written) {
        result = { error: this.refusal(ERRORS.stopNotSent(reason)) };
      } else {
        result = { error: this.refusal(ERRORS.sentUnconfirmed(reason)) };
      }
    } else {
      result = { error: this.refusal(back ? ERRORS.stopNotApplied : ERRORS.stopUnconfirmed) };
    }
    this.updateStatus().catch(() => {});
    job.resolve(result);
  }

  /** Whether a click or a command waits or runs: a check gives way to them. */
  checkMustYield() {
    return this.stops.length > 0 || Boolean(this.stopWorker) || Boolean(this.command);
  }

  /**
   * The periodic check of one turn off kept: reads the fireplace, then posts
   * the turn off again only when `decideStop` says so. It gives its turn up
   * to a click or a command, and checks once more right before its post.
   * One check at a time (the turn offs of other fireplaces wait 1 s).
   */
  async runCheck(guard) {
    if (this.closed || !this.hasGuard(guard)) return;
    if (this.checkMustYield() || this.checking) {
      this.armStopCheck(guard, SECOND);
      return;
    }
    this.checking = true;
    let decision;
    let written = false;
    let attempted = false;
    let forbiddenFailure = false;
    let undo;
    const target = guard.target;
    const credentials = this.credentialsFor(target);
    let holder;
    try {
      await (async () => {
        holder = await this.lane.acquire('check');
        if (this.checkMustYield() || !this.hasGuard(guard)) {
          decision = 'yield';
          return;
        }
        const startedAt = this.mono();
        let read;
        try {
          read = await this.client.poll(target, {
            timeoutMs: TIMINGS.readTimeout,
            signal: holder.signal,
          });
        } catch (err) {
          if (err.kind === ERROR_KINDS.ABORTED) throw err;
          read = undefined;
        }
        if (!this.hasGuard(guard)) return;
        if (read && sameAddress(target, this.config.address)) {
          try {
            if (this.applyRead(read, startedAt, guard)) this.publishAll().catch(() => {});
          } catch {
            // No identity: decided below on the flame only.
          }
          if (!this.hasGuard(guard)) return;
        }
        decision = this.decideStop(guard, read, startedAt);
        if (decision !== 'resend' || !credentials) return;
        const wasWritten = guard.written;
        const sentAtBefore = guard.sentAt;
        attempted = true;
        undo = () => {
          written = false;
          guard.written = wasWritten;
          guard.sentAt = sentAtBefore;
        };
        await this.postStop(target, credentials, holder, this.mono() + TIMINGS.readTimeout, () => {
          if (this.checkMustYield() || !this.hasGuard(guard)) {
            throw new Error('a newer click or command');
          }
          this.logger.warn('IntelliFire: the flame is still on after a turn off: posted again');
          written = true;
          guard.written = true;
          guard.forbidden = 0;
          guard.sentAt = this.mono();
          guard.watchUntil = Math.max(guard.watchUntil, this.lastStartAt + TIMINGS.pendingFor);
          this.lastSentAt = guard.sentAt;
        });
        if (guard.serial) this.keyWorked.add(guard.serial);
        // Accepted by the fireplace: a resend (a refusal or a silence is not one).
        if (wasWritten) guard.resends += 1;
        await this.sleep(TIMINGS.applyWait, holder.signal);
        if (!this.hasGuard(guard)) return;
        try {
          const backStart = this.mono();
          const back = await this.client.poll(target, {
            timeoutMs: TIMINGS.readTimeout,
            signal: holder.signal,
          });
          const after = this.decideStop(guard, back, Infinity);
          if (after === 'done' || after === 'watch') decision = after;
          if (sameAddress(target, this.config.address)) {
            try {
              if (this.applyRead(back, backStart, guard)) this.publishAll().catch(() => {});
            } catch {
              // No identity.
            }
          }
        } catch (err) {
          if (err.kind === ERROR_KINDS.ABORTED) throw err;
        }
      })();
    } catch (err) {
      if (!err?.sent) undo?.();
      forbiddenFailure = err?.kind === ERROR_KINDS.AUTH || err?.kind === ERROR_KINDS.CHALLENGE;
      if (err?.kind === ERROR_KINDS.AUTH && holder && this.hasGuard(guard)) {
        // Marks this serial as refusing the key, on proof only (never another fireplace).
        await this.judgeForbidden(guard, target, holder);
      } else if (err?.kind !== ERROR_KINDS.YIELDED && err?.kind !== ERROR_KINDS.ABORTED) {
        this.logger.warn(`IntelliFire: check of the turn off failed (${errorReason(err)})`);
      }
    } finally {
      holder?.release();
      this.checking = false;
    }
    if (!this.hasGuard(guard)) return;
    if (attempted && !written && forbiddenFailure) guard.forbidden += 1;
    if (written) this.followUp();
    if (decision === 'done') {
      this.dropGuard(guard, 'applied');
      return;
    }
    let delay;
    if (decision === 'yield') delay = SECOND;
    else if (decision === 'watch') delay = this.watchDelay(guard);
    else if (decision === 'wait' && guard.sentAt !== undefined) {
      delay = Math.max(0, guard.sentAt + TIMINGS.stopApplyDelay - this.mono());
    }
    this.armStopCheck(guard, delay);
    this.persistStop().catch(() => {});
    this.updateStatus().catch(() => {});
  }

  /** The next read of a turn off watched for a late turn on: 15 s at most. */
  watchDelay(guard) {
    return Math.max(0, Math.min(TIMINGS.stopCheck, guard.watchUntil - this.mono() + 1));
  }

  /**
   * 15 s; after 4 tries in a row answered only 403, doubled each time up to
   * 1 h. A module that does not answer is checked every 15 s (a local read
   * costs nothing): the turn off leaves within 15 s of its return.
   */
  stopDelay(guard) {
    const extra = Math.max(0, (guard?.forbidden ?? 0) - 4);
    return Math.min(TIMINGS.stopCheckMax, TIMINGS.stopCheck * 2 ** Math.min(extra, 10));
  }

  /** One turn off let go (applied, a newer turn on of its fireplace, the bound). */
  dropGuard(guard, reason) {
    const index = guard ? this.stopGuards.indexOf(guard) : -1;
    if (index < 0) return;
    if (guard.timer) this.timers.clearTimeout(guard.timer);
    guard.timer = undefined;
    this.stopGuards.splice(index, 1);
    this.logger.info(`IntelliFire: turn off let go (${reason})`);
    this.persistStop().catch(() => {});
    this.updateStatus().catch(() => {});
  }

  /** The next check of a turn off kept: whatever the interval, the failures or a pause. */
  armStopCheck(guard, delay) {
    if (this.closed || !this.hasGuard(guard)) return;
    const wait = delay ?? this.stopDelay(guard);
    const dueAt = this.mono() + wait;
    if (guard.timer) {
      if (guard.dueAt <= dueAt) return;
      this.timers.clearTimeout(guard.timer);
    }
    guard.dueAt = dueAt;
    guard.timer = this.timers.setTimeout(() => {
      guard.timer = undefined;
      if (!this.hasGuard(guard)) return;
      this.runCheck(guard).catch((err) => this.logger.warn(`IntelliFire: check: ${err.message}`));
    }, wait);
  }
}
