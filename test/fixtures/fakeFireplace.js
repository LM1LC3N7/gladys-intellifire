// -----------------------------------------------------------------------------
// A fake IntelliFire Wi-Fi module behind the transport of
// src/intellifire/client.js (no network), built from intellifire4py 4.5.6:
//   - `GET /poll`: the fields of tests/fixtures/local_poll.json (anonymized
//     capture of that repository), with a plausible setpoint (hundredths of °C);
//   - `GET /get_challenge`: a new hex challenge;
//   - `POST /post`: the form `command, value, user, response`, the response
//     checked as `_construct_payload` computes it against the challenges of
//     the last 10 s: 403 otherwise; the command applied after `applyDelayMs`.
// Effects (as the app and Home Assistant show them): power 0 cancels the
// timer; a setpoint of 0 turns the thermostat mode off, above 0 on.
// Its timers are those of the test clock.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { ERROR_KINDS, FireplaceError } from '../../src/intellifire/http.js';

export const HOST = '192.168.1.69';
export const SERIAL = 'bd0e054b5d6df7afbc8f9b28c9011111';
export const OTHER_SERIAL = 'aa0e054b5d6df7afbc8f9b28c9012222';
export const API_KEY = '12345bdb2d97b3dc7cee8a8b05dd5ffa';
export const USER_ID = 'u1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6';
export const NOW = Date.parse('2026-10-28T10:00:00Z');

const sha = (buf) => createHash('sha256').update(buf).digest();

export function fakeFireplace({ timers, latencyMs = 5, applyDelayMs = 20 } = {}) {
  const dev = {
    serial: SERIAL,
    state: {
      power: 0,
      pilot: 0,
      hot: 0,
      height: 2,
      fanspeed: 1,
      light: 3,
      temperature: 19,
      thermostat: 0,
      setpoint: 0,
      timer: 0,
      timeremaining: 0,
      errors: [],
      feature_fan: 1,
      feature_light: 1,
      feature_thermostat: 1,
      power_vent: 0,
      fw_ver_str: '1.3.0',
      fw_version: '0x01030000',
    },
    apiKey: API_KEY,
    userId: USER_ID,
    latencyMs,
    applyDelayMs,
    /** Fails every request with this kind ('unreachable', 'timeout'), or false. */
    down: false,
    /** Paths answered with a status: { '/poll': 503 }. */
    status: {},
    /** Commands answered with a status: { time_remaining: 422 }. */
    commandStatus: {},
    /** The next N posts answered 403 whatever their signature (challenges expired). */
    force403: 0,
    /** Commands accepted but never applied: Set of names. */
    ignore: new Set(),
    /** Paths that never answer (until the timeout or an abort). */
    silent: new Set(),
    /** Every request: { method, path, body, at }. */
    requests: [],
    /** Posts accepted: { command, value, at }. */
    posts: [],
    challenges: [],
    open: 0,
    peak: 0,
    timers,
    clock: () => 0,
  };

  dev.pollBody = () => JSON.stringify({ name: '', serial: dev.serial, ...dev.state });

  dev.apply = (command, value) => {
    const s = dev.state;
    if (command === 'power') {
      s.power = value;
      if (value === 0) {
        s.timer = 0;
        s.timeremaining = 0;
      } else {
        s.hot = 1;
      }
    } else if (command === 'flame_height') s.height = value;
    else if (command === 'fan_speed') s.fanspeed = value;
    else if (command === 'thermostat_setpoint') {
      s.setpoint = value;
      s.thermostat = value > 0 ? 1 : 0;
    } else if (command === 'time_remaining') {
      s.timer = value > 0 ? 1 : 0;
      s.timeremaining = value;
    }
  };

  dev.signed = (challenge, command, value) => {
    const key = Buffer.from(dev.apiKey, 'hex');
    const payload = Buffer.from(`post:command=${command}&value=${value}`);
    return sha(
      Buffer.concat([key, sha(Buffer.concat([key, Buffer.from(challenge, 'hex'), payload]))]),
    ).toString('hex');
  };

  const route = (method, path, body) => {
    if (dev.status[path]) return { status: dev.status[path], body: '' };
    if (method === 'GET' && path === '/poll') return { status: 200, body: dev.pollBody() };
    if (method === 'GET' && path === '/get_challenge') {
      const challenge = createHash('md5').update(String(Math.random())).digest('hex');
      dev.challenges.push(challenge);
      if (dev.challenges.length > 5) dev.challenges.shift();
      return { status: 200, body: challenge.toUpperCase() };
    }
    if (method === 'POST' && path === '/post') {
      if (dev.force403 > 0) {
        dev.force403 -= 1;
        return { status: 403, body: '' };
      }
      const form = Object.fromEntries(new URLSearchParams(body ?? ''));
      const value = Number(form.value);
      const ok =
        form.user === dev.userId &&
        dev.challenges.some((c) => dev.signed(c, form.command, form.value) === form.response);
      if (!ok) return { status: 403, body: '' };
      if (dev.commandStatus[form.command]) {
        dev.onStatus?.(form.command);
        return { status: dev.commandStatus[form.command], body: '' };
      }
      dev.posts.push({ command: form.command, value, at: dev.clock() });
      dev.onPost?.(form.command, value);
      if (!dev.ignore.has(form.command)) {
        timers.setTimeout(() => dev.apply(form.command, value), dev.applyDelayMs);
      }
      return { status: 204, body: '' };
    }
    return { status: 404, body: '' };
  };

  dev.transport = ({ method = 'GET', path, body, timeoutMs, signal, beforeSend }) =>
    new Promise((resolve, reject) => {
      const fail = (kind, message, sent, cause) =>
        reject(Object.assign(new FireplaceError(kind, message), { sent, cause }));
      if (signal?.aborted) return fail(ERROR_KINDS.ABORTED, 'Aborted', false);
      if (dev.down === 'unreachable') {
        timers.setTimeout(() => fail(ERROR_KINDS.UNREACHABLE, 'Unreachable', false), dev.latencyMs);
        return undefined;
      }
      try {
        beforeSend?.();
      } catch (err) {
        return fail(ERROR_KINDS.YIELDED, err.message, false, err);
      }
      dev.requests.push({ method, path, body, at: dev.clock() });
      dev.open += 1;
      dev.peak = Math.max(dev.peak, dev.open);
      let done = false;
      const end = (fn) => {
        if (done) return;
        done = true;
        dev.open -= 1;
        timers.clearTimeout(timeout);
        timers.clearTimeout(answer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => end(() => fail(ERROR_KINDS.ABORTED, 'Aborted', true));
      signal?.addEventListener('abort', onAbort, { once: true });
      const timeout = timers.setTimeout(
        () => end(() => fail(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout', true)),
        timeoutMs ?? 5000,
      );
      let answer;
      if (dev.down === 'timeout' || dev.silent.has(path)) return undefined;
      answer = timers.setTimeout(
        () =>
          end(() => {
            const res = route(method, path, body);
            resolve({ status: res.status, headers: {}, body: res.body });
          }),
        typeof dev.latencyMs === 'function' ? dev.latencyMs(path) : dev.latencyMs,
      );
      return undefined;
    });

  return dev;
}
