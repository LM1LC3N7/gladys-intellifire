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
//     flame (the fireplace turns itself off at its end); a timer that cannot
//     be set turns the fireplace off at once, and the reads of the next two
//     minutes turn it off if they show the flame without that timer;
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
// key and the user id: without them, or when the fireplace refuses them, it
// is kept (in /data) and leaves as soon as new ones are saved (or a test
// read succeeds). Tried again every 250 ms for 3 s; not seen applied, it is
// kept in /data and checked every 15 s: posted again while the flame is on
// (3 times at most, then held and said in the status), let go when a read
// shows the flame off (two reads in a row when it never left), or when a
// newer turn on clicked in Gladys left. Never by time.
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
  PRESSED,
  SECOND,
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
    /** The turn off not seen applied, or undefined. */
    this.stopGuard = undefined;
    this.checking = false;
    /** A turn on from Gladys whose timer is checked: { since, minutes, serial, sentAt }. */
    this.startCheck = undefined;
    /** The fireplace refused the key or user id (403): said in the status until they change. */
    this.keyRefused = false;
    /** Monotonic time of the last click of "Retrieve the key". */
    this.cloudAt = -Infinity;
  }

  mono() {
    return this.monotonic();
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
        let result;
        try {
          result = await this.store.load();
        } catch {
          result = { unreadable: true };
        }
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
          this.startCheck = {
            since: mono - (now - start.since),
            minutes: start.minutes,
            serial: start.serial,
            sentAt: mono - (now - start.since),
          };
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

  /** The turn off not seen applied, in /data (or none). */
  persistStop() {
    const g = this.stopGuard;
    const stop = g
      ? {
          host: g.target.host,
          port: g.target.port,
          since: g.since,
          written: g.written,
          resends: g.resends,
          refused: g.refused,
        }
      : null;
    if (JSON.stringify(stop) === JSON.stringify(this.memory.stop ?? null)) {
      return Promise.resolve(true);
    }
    this.memory.stop = stop;
    return this.saveMemory();
  }

  /**
   * At the start of the container, before the configuration is read: a turn
   * off kept in /data is restored. Its key is a secret (never in /data): it
   * leaves as soon as the configuration gives it (`resumeStop`).
   */
  async boot() {
    await this.loadMemory();
    const kept = this.memory.stop;
    if (!kept || this.stopGuard) {
      return;
    }
    const guard = this.newStopGuard({ host: kept.host, port: kept.port });
    guard.since = kept.since;
    guard.written = kept.written;
    guard.resends = kept.resends;
    guard.refused = kept.refused;
    this.stopGuard = guard;
    this.logger.warn('IntelliFire: a turn off kept in /data waits for the configuration');
    if (this.configRead) {
      this.resumeStop();
    }
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}, { fresh = false } = {}) {
    this.stop();
    this.raw = raw ?? {};
    this.config = normalizeConfig(raw);
    const generation = this.generation;
    await this.fp.running;
    await this.loadMemory();
    if (generation !== this.generation) {
      return;
    }
    if (this.memory.stop && !this.stopGuard) {
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
    if (this.stopGuard) {
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
      return this.interval;
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
    this.stop();
    if (this.stopGuard?.timer) {
      this.timers.clearTimeout(this.stopGuard.timer);
      this.stopGuard.timer = undefined;
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
      await this.bounded(this.loadMemory(), TIMINGS.stopSaveWait);
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnreadable);
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.onConnected(getConfig).catch(() => {});
      }, TIMINGS.configRetry);
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
    this.configRead = true;
    if (!this.started || this.needsRestart(raw)) {
      this.started = true;
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.raw = raw ?? {};
    this.config = normalizeConfig(raw);
    if (credentialsKey(previous) !== credentialsKey(this.config)) {
      // New key or user id: a refusal is lifted, a turn off waiting for them leaves.
      this.keyRefused = false;
      if (this.stopGuard) {
        this.stopGuard.refused = false;
        this.resumeStop();
      }
    }
    if (this.config.pollInterval !== previous.pollInterval && this.fp.timer && !this.fp.running) {
      this.schedule(this.fp.online === false ? undefined : this.dueIn());
    }
    if (this.config.allowControl !== previous.allowControl) {
      this.logger.info(`IntelliFire control ${this.config.allowControl ? 'allowed' : 'disabled'}`);
    }
    if (reconnection || this.config.language !== previous.language) {
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
    if (generation !== this.generation) {
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
    await this.saveMemory();
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
    if (!this.config.address) {
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
   * last read applied. Returns whether it was applied.
   */
  applyRead(data, startedAt) {
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
    this.observeStop(data, startedAt);
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

  /** Notes added to the status: a turn off kept, a key refused, another serial. */
  withNotes(message) {
    let out = message;
    const g = this.stopGuard;
    if (g) {
      if (!this.credentialsFor(g.target) || g.refused) {
        out = join(out, T.stopWaitsKey);
      } else if (g.written && g.resends >= TIMINGS.stopResends && !g.applied) {
        out = join(out, T.stopHeld);
      } else {
        out = join(out, T.stopPending(age(this.now() - g.since)));
      }
    }
    if (this.keyRefused) {
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
      return [false, this.stopGuard ? this.withNotes(base) : base];
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
    return [true, this.withNotes(T.connected(T.summary(f.serial.slice(-4).toUpperCase(), state)))];
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
      buildDevice(this.gladys, f.serial, f.data, { language: this.config.language }),
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
      const last = this.status()[1];
      const next = T.nextRead(age(this.dueIn()));
      return Number.isFinite(this.lastAttemptAt)
        ? join(join(last, T.lastRead(age(this.mono() - this.lastAttemptAt))), next)
        : join(last, next);
    } else {
      this.clearTimer();
      await this.tick();
    }
    if (f === this.fp && f.online === true && this.stopGuard?.refused) {
      this.stopGuard.refused = false;
      this.resumeStop();
    }
    return this.status()[1];
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
    await this.inOrder(() =>
      this.applyConfig({ ...this.raw, api_key: match.apiKey, user_id: found.userId }),
    );
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
      return this.protect(received);
    }
    if (!this.config.allowControl) {
      throw this.refusal(ERRORS.disabled);
    }
    const wanted = this.commandValue(target.role, value);
    if (this.command) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const entry = { role: target.role, seq: this.protectSeq, sent: false };
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
    // Only a turn on (a newer intent) may go while a turn off is kept.
    if (this.stopGuard && entry.role !== FEATURES.TURN_ON) {
      throw this.refusal(ERRORS.stopInProgress);
    }
    if (this.paused) {
      throw this.refusal(ERRORS.paused(age(this.pausedUntil - this.mono())));
    }
    if (!this.config.credentials) {
      throw this.refusal(ERRORS.noCredentials);
    }
    if (this.keyRefused) {
      throw this.refusal(ERRORS.keyRefused);
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
      if (fresh.power && !this.isPending(role) && !this.stopGuard) {
        return undefined;
      }
      const seconds = this.config.sessionMinutes * 60;
      return {
        steps: [
          { command: COMMANDS.POWER, value: 1 },
          { command: COMMANDS.TIMER, value: seconds },
        ],
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
    return {
      steps: [{ command: COMMANDS.SETPOINT, value: wanted * 100 }],
      expect: (back) => same(back.setpoint),
      before: (back) => JSON.stringify(back.setpoint) === JSON.stringify(fresh.setpoint),
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
    if (role === FEATURES.TURN_ON) {
      // The check of the timer, in /data before the first byte (a failed or slow save refuses).
      const previous = this.memory.start;
      this.memory.start = {
        since: this.now(),
        minutes: this.config.sessionMinutes,
        serial: target.serial,
      };
      const saved = await this.bounded(
        this.saveMemory(),
        sendBy - TIMINGS.commandMinRequest - this.mono(),
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
            this.startCheck = {
              since: this.lastSentAt,
              sentAt: this.lastSentAt,
              minutes: this.config.sessionMinutes,
              serial: target.serial,
            };
          }
        },
      });
    } catch (err) {
      if (role === FEATURES.TURN_ON && (!entry.sent || clearRefusal(err))) {
        this.dropStartCheck();
      }
      if (role === FEATURES.TURN_ON && entry.sent && !clearRefusal(err)) {
        // It may have lit: the newer intent wins over a turn off kept, and the timer is checked.
        if (entry.seq === this.protectSeq) this.dropStopGuard('newer turn on, unconfirmed');
      }
      return this.commandFailed(err, entry, role);
    }
    if (role === FEATURES.TURN_ON && this.stopGuard && entry.seq === this.protectSeq) {
      // A newer turn on clicked with the option and accepted lets the turn off before it go.
      this.dropStopGuard('newer turn on');
    }
    for (const step of rest) {
      // The timer of a turn on: posted whatever the deadline of the ack; only a
      // turn off clicked meanwhile stops it (that turn off ends the flame).
      try {
        await this.client.command(address, credentials, step.command, step.value, {
          until: Math.max(answerBy, this.mono() + 2 * SECOND),
          signal: holder.signal,
          beforeSend: () => {
            if (entry.seq !== this.protectSeq) throw this.refusal(ERRORS.stopMeanwhile);
            this.lastSentAt = this.mono();
          },
        });
      } catch (err) {
        if (entry.seq !== this.protectSeq) {
          throw this.refusal(ERRORS.stopMeanwhile);
        }
        this.logger.warn(`IntelliFire: the timer could not be set (${errorReason(err)}): turn off`);
        this.dropStartCheck();
        this.protectSeq += 1;
        this.queueStop({
          target: { host: address.host, port: address.port },
          received: this.mono(),
        });
        this.followUp();
        throw this.refusal(ERRORS.noTimer);
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
      this.keyRefused = false;
      this.logger.info(`IntelliFire: ${role} confirmed by the fireplace`);
      return undefined;
    }
    this.markPending(role);
    throw this.refusal(plan.before(back) ? ERRORS.notApplied : ERRORS.sentDiffers);
  }

  markPending(role) {
    this.pending = { role, until: this.mono() + TIMINGS.pendingFor };
  }

  /** A post that failed: never "not sent" once a byte may have left. */
  commandFailed(err, entry, role) {
    const reason = errorReason(err);
    this.logger.warn(`IntelliFire: ${role} failed (${reason})`);
    if (err.kind === ERROR_KINDS.AUTH) {
      this.keyRefused = true;
      this.updateStatus().catch(() => {});
      throw this.refusal(ERRORS.keyRefused);
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

  // --- The timer of a turn on from Gladys --------------------------------------

  dropStartCheck() {
    this.startCheck = undefined;
    if (this.memory.start) {
      this.memory.start = null;
      this.saveMemory().catch(() => {});
    }
  }

  /**
   * A read during the two minutes after a turn on from Gladys: the flame on
   * with the timer asked confirms it; the flame on without it (10 s after
   * the turn on at least) turns the fireplace off.
   */
  observeStart(data, startedAt) {
    const c = this.startCheck;
    if (!c) return;
    const mono = this.mono();
    if (mono - c.since >= TIMINGS.startCheckFor) {
      this.dropStartCheck();
      return;
    }
    if (data.serial !== c.serial || startedAt <= c.sentAt || data.power !== true) return;
    if (
      data.timer === true &&
      data.timeLeft !== undefined &&
      data.timeLeft <= c.minutes * 60 + 60
    ) {
      this.dropStartCheck();
      return;
    }
    if (mono - c.since < 10 * SECOND) return;
    this.logger.warn('IntelliFire: lit from Gladys but no timer read: turn off');
    this.dropStartCheck();
    const target = this.stopTarget();
    if (target) {
      this.protectSeq += 1;
      this.queueStop({ target, received: mono });
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

  /** The key and user id of a target: those of the configuration for its address only. */
  credentialsFor(target) {
    return sameAddress(target, this.config.address) ? this.config.credentials : undefined;
  }

  /** The turn off clicked: queued before anything, answered by 4.3 s after the click. */
  async protect(received) {
    // Every command that arrived before this turn off and has not left gives way.
    this.protectSeq += 1;
    this.dropStartCheck();
    // /data holds the address of the last read: known even before the configuration.
    await this.bounded(this.loadMemory(), TIMINGS.stopSaveWait);
    const target = this.stopTarget();
    if (!target) {
      throw this.refusal(ERRORS.noAddress);
    }
    if (this.stopGuard && sameAddress(this.stopGuard.target, target)) {
      // A new click: a turn off held or refused is tried again, in full.
      this.stopGuard.refused = false;
    }
    const job = this.queueStop({ target, received });
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

  /** Queues a turn off; a click for the same target still waiting is joined. */
  queueStop({ target, received, fromBoot = false }) {
    let job = this.stops.find((j) => !j.running && sameAddress(j.target, target));
    if (job) {
      return job;
    }
    job = { target, received, fromBoot, state: { written: false }, running: false };
    job.done = new Promise((resolve) => {
      job.resolve = resolve;
    });
    this.stops.push(job);
    this.runStops();
    return job;
  }

  runStops() {
    if (this.stopWorker) {
      return;
    }
    this.stopWorker = (async () => {
      try {
        while (this.stops.length > 0) {
          const job = this.stops[0];
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
        this.stopWorker = undefined;
      }
    })();
  }

  /** A turn off kept that may leave now (key known, not refused): queued, else checked. */
  resumeStop() {
    const guard = this.stopGuard;
    if (!guard) return;
    const ready =
      this.credentialsFor(guard.target) &&
      !guard.refused &&
      !(guard.written && guard.resends >= TIMINGS.stopResends);
    if (ready && !guard.written) {
      // Never written: it leaves first, as a click would.
      this.queueStop({ target: guard.target, received: this.mono(), fromBoot: true });
    } else {
      this.armStopCheck(0);
    }
  }

  newStopGuard(target) {
    return {
      target,
      since: this.now(),
      written: false,
      sentAt: undefined,
      resends: 0,
      refused: false,
      applied: false,
      offReads: 0,
      watchUntil: -Infinity,
      timer: undefined,
    };
  }

  /**
   * What a read says of the turn off: 'done' (the flame off, the thermostat
   * not on), 'watch' (off, but a turn on sent shortly before may still
   * land), 'wait' (read too soon, or off but the turn off never left: a
   * second read decides), 'blocked' (no key accepted: never posted),
   * 'hold' (posted 4 times without effect), 'resend'.
   */
  decideStop(guard, read, readStartedAt) {
    const off = read?.power === false && read.thermostat !== true;
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
    if (!this.credentialsFor(guard.target) || guard.refused) {
      return 'blocked';
    }
    return guard.written && guard.resends >= TIMINGS.stopResends ? 'hold' : 'resend';
  }

  /** A read seen by the turn off kept: done, or checked now. */
  observeStop(read, startedAt) {
    const guard = this.stopGuard;
    if (!guard || !sameAddress(guard.target, this.config.address)) {
      return;
    }
    const decision = this.decideStop(guard, read, startedAt);
    if (decision === 'done') {
      this.dropStopGuard('applied');
    } else if (decision === 'resend' && !this.checking) {
      this.armStopCheck(0);
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
   * One turn off: its posts without a read first, then the read back that
   * alone confirms it. Unreachable, cut, silent or a 5xx: tried again every
   * 250 ms until 3 s after the click. Not confirmed: kept (in /data) and
   * checked every 15 s.
   */
  async sendStop(job) {
    const { target, state } = job;
    const retryUntil = Math.max(job.received, this.mono()) + TIMINGS.stopRetryFor;
    if (!this.stopGuard || !sameAddress(this.stopGuard.target, target)) {
      if (this.stopGuard) this.dropStopGuard('a turn off to another address');
      this.stopGuard = this.newStopGuard(target);
    }
    const guard = this.stopGuard;
    if (!job.fromBoot) {
      guard.since = this.now();
      guard.resends = 0;
      guard.refused = false;
    }
    guard.watchUntil = Math.max(guard.watchUntil, this.lastStartAt + TIMINGS.pendingFor);
    // In /data before the first byte; a save that fails or hangs never holds it (200 ms at most).
    await this.bounded(this.persistStop(), TIMINGS.stopSaveWait);
    const credentials = this.credentialsFor(target);
    if (!credentials || guard.refused) {
      // Nothing can sign it: kept, it leaves when a key is saved; the reads watch it.
      this.armStopCheck();
      this.persistStop().catch(() => {});
      this.updateStatus().catch(() => {});
      job.resolve({ error: this.refusal(ERRORS.stopWaitsKey) });
      return;
    }
    const resendOnBoot = job.fromBoot && guard.written;
    let back;
    let backStart;
    let failure;
    this.logger.info('IntelliFire: turn off');
    for (;;) {
      const holder = await this.lane.acquire('stop');
      try {
        await this.postStop(target, credentials, holder, retryUntil, () => {
          state.written = true;
          const at = this.mono();
          this.lastSentAt = at;
          if (this.stopGuard === guard) {
            guard.written = true;
            guard.sentAt = at;
            guard.watchUntil = Math.max(guard.watchUntil, this.lastStartAt + TIMINGS.pendingFor);
          }
        });
        failure = undefined;
        if (resendOnBoot && this.stopGuard === guard) {
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
      } finally {
        holder.release();
      }
      if (failure.kind === ERROR_KINDS.AUTH) {
        // Refused: not an attempt; kept until a new key or a test read succeeds.
        guard.refused = true;
        this.keyRefused = true;
        break;
      }
      const again =
        RETRYABLE.includes(failure.kind) ||
        (failure.kind === ERROR_KINDS.HTTP && failure.status >= 500);
      if (!again || this.mono() + TIMINGS.stopRetry >= retryUntil) {
        break;
      }
      await this.sleep(TIMINGS.stopRetry);
    }
    if (back && sameAddress(target, this.config.address)) {
      try {
        if (this.applyRead(back, backStart)) {
          this.publishAll().catch(() => {});
        }
      } catch {
        // No identity: the decision below still reads the flame.
      }
    }
    const decision = back === undefined ? undefined : this.decideStop(guard, back, Infinity);
    const confirmed = decision === 'done' || decision === 'watch';
    if (this.stopGuard === guard) {
      if (decision === 'done') {
        this.dropStopGuard('applied');
      } else {
        // Armed before /data is written, never awaited: a hung disk never stops the checks.
        this.armStopCheck(decision === 'watch' ? this.watchDelay(guard) : undefined);
        this.persistStop().catch(() => {});
      }
    }
    if (state.written) {
      this.followUp();
    }
    let result;
    if (confirmed) {
      this.logger.info('IntelliFire: turn off confirmed by the fireplace');
      this.keyRefused = false;
      result = {};
    } else if (failure) {
      const reason = errorReason(failure);
      this.logger.warn(`IntelliFire: turn off failed (${reason})`);
      if (failure.kind === ERROR_KINDS.AUTH) {
        result = { error: this.refusal(ERRORS.stopWaitsKey) };
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
   * The periodic check of the turn off: reads the fireplace, then posts the
   * turn off again only when `decideStop` says so. It gives its turn up to a
   * click or a command, and checks once more right before its post.
   */
  async runCheck() {
    const guard = this.stopGuard;
    if (!guard) return;
    if (this.checkMustYield() || this.checking) {
      this.armStopCheck(SECOND);
      return;
    }
    this.checking = true;
    let decision;
    let written = false;
    const target = guard.target;
    const credentials = this.credentialsFor(target);
    let holder;
    try {
      await (async () => {
        holder = await this.lane.acquire('check');
        if (this.checkMustYield() || this.stopGuard !== guard) {
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
        if (this.stopGuard !== guard) return;
        if (read && sameAddress(target, this.config.address)) {
          try {
            if (this.applyRead(read, startedAt)) this.publishAll().catch(() => {});
          } catch {
            // No identity: decided below on the flame only.
          }
          if (this.stopGuard !== guard) return;
        }
        decision = this.decideStop(guard, read, startedAt);
        if (decision !== 'resend' || !credentials) return;
        const wasWritten = guard.written;
        await this.postStop(target, credentials, holder, this.mono() + TIMINGS.readTimeout, () => {
          if (this.checkMustYield() || this.stopGuard !== guard) {
            throw new Error('a newer click or command');
          }
          this.logger.warn('IntelliFire: the flame is still on after a turn off: posted again');
          written = true;
          guard.written = true;
          guard.sentAt = this.mono();
          guard.watchUntil = Math.max(guard.watchUntil, this.lastStartAt + TIMINGS.pendingFor);
          this.lastSentAt = guard.sentAt;
        });
        // Accepted by the fireplace: a resend (a refusal or a silence is not one).
        if (wasWritten) guard.resends += 1;
        await this.sleep(TIMINGS.applyWait, holder.signal);
        if (this.stopGuard !== guard) return;
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
              if (this.applyRead(back, backStart)) this.publishAll().catch(() => {});
            } catch {
              // No identity.
            }
          }
        } catch (err) {
          if (err.kind === ERROR_KINDS.ABORTED) throw err;
        }
      })();
    } catch (err) {
      if (err?.kind === ERROR_KINDS.AUTH) {
        guard.refused = true;
        this.keyRefused = true;
      } else if (err?.kind !== ERROR_KINDS.YIELDED && err?.kind !== ERROR_KINDS.ABORTED) {
        this.logger.warn(`IntelliFire: check of the turn off failed (${errorReason(err)})`);
      }
    } finally {
      holder?.release();
      this.checking = false;
    }
    if (this.stopGuard !== guard) return;
    if (written) this.followUp();
    if (decision === 'done') {
      this.dropStopGuard('applied');
      return;
    }
    let delay;
    if (decision === 'yield') delay = SECOND;
    else if (decision === 'watch') delay = this.watchDelay(guard);
    else if (decision === 'wait' && guard.sentAt !== undefined) {
      delay = Math.max(0, guard.sentAt + TIMINGS.stopApplyDelay - this.mono());
    }
    this.armStopCheck(delay);
    this.persistStop().catch(() => {});
    this.updateStatus().catch(() => {});
  }

  /** The next read of a turn off watched for a late turn on: 15 s at most. */
  watchDelay(guard) {
    return Math.max(0, Math.min(TIMINGS.stopCheck, guard.watchUntil - this.mono() + 1));
  }

  dropStopGuard(reason) {
    const guard = this.stopGuard;
    if (!guard) return;
    if (guard.timer) this.timers.clearTimeout(guard.timer);
    this.stopGuard = undefined;
    this.logger.info(`IntelliFire: turn off let go (${reason})`);
    this.persistStop().catch(() => {});
    this.updateStatus().catch(() => {});
  }

  /** The next check of the turn off: every 15 s, whatever the interval, the failures or a pause. */
  armStopCheck(delay = TIMINGS.stopCheck) {
    const guard = this.stopGuard;
    if (!guard) return;
    const dueAt = this.mono() + delay;
    if (guard.timer) {
      if (guard.dueAt <= dueAt) return;
      this.timers.clearTimeout(guard.timer);
    }
    guard.dueAt = dueAt;
    guard.timer = this.timers.setTimeout(() => {
      guard.timer = undefined;
      if (this.stopGuard !== guard) return;
      this.runCheck().catch((err) => this.logger.warn(`IntelliFire: check: ${err.message}`));
    }, delay);
  }
}
