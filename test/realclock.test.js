// -----------------------------------------------------------------------------
// The app on the REAL clock, sped up 20 times, against a real local HTTP
// server answering like the fake module (node:http, the transport of the
// container): reads at the interval, never sooner, one request at a time,
// and a turn off at once.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { IntelliFireApp } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { API_KEY, SERIAL, USER_ID, fakeFireplace } from './fixtures/fakeFireplace.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { httpServer, reply } from './kit/http.mjs';

const SPEED = 20;
const INTERVAL = 30_000;

/** `promise`, or a failure after `ms` of the real clock (never a wait for the test timeout). */
function within(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: not done within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

test('real clock x20: a read every interval, one request at a time, a turn off at once', async (t) => {
  const dev = fakeFireplace({ timers: globalThis, applyDelayMs: 0 });
  dev.state.power = 1;
  let open = 0;
  let peak = 0;
  const answer = (method) => (r) => {
    open += 1;
    peak = Math.max(peak, open);
    setTimeout(() => (open -= 1), 2);
    return new Promise((resolve) => {
      dev
        .transport({ method, path: r.path, body: r.body, timeoutMs: 1000 })
        .then((res) => resolve(reply(res.status, res.body)));
    });
  };
  dev.latencyMs = 1;
  const server = await httpServer({
    routes: {
      'GET /poll': answer('GET'),
      'GET /get_challenge': answer('GET'),
      'POST /post': answer('POST'),
    },
  });
  const clock = realClock({ speed: SPEED });
  const gladys = createFakeGladys({ config: {} });
  await gladys.connect();
  const quiet = () => {};
  const app = new IntelliFireApp({
    gladys,
    logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  const spy = spyOn(app, 'run', clock);
  // Run whatever happens, even when an await below fails: nothing keeps the process alive.
  t.after(async () => {
    spy.restore();
    await within(app.shutdown(), 5000, 'shutdown').catch(() => {});
    clock.close();
    await server.close();
  });
  await within(
    app.connected({
      address: `127.0.0.1:${server.port}`,
      api_key: API_KEY,
      user_id: USER_ID,
      poll_interval: INTERVAL / 1000,
    }),
    10_000,
    'start',
  );
  const gaps = await within(measurePeriod(spy, { count: 3, period: INTERVAL }), 20_000, 'period');
  assert.equal(gaps.length, 2);
  assert.ok(peak <= 1, `${peak} requests at once`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const started = clock.monotonic();
  await within(
    app.setValue(undefined, {
      external_id: `ext:test-integration:intellifire:${SERIAL}:turn-off`,
    }),
    5000,
    'turn off',
  );
  assert.equal(dev.state.power, 0);
  assert.ok(clock.monotonic() - started < 4_300, 'within the ack budget');
});
