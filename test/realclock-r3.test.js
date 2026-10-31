// -----------------------------------------------------------------------------
// Scenario 13e of review r3 on the REAL clock (sped up 20 times) and real
// HTTP: two IntelliFire answer in turn at the address (A, whose key is
// configured, then B, another serial and key), and both devices are created.
// A's turn off is clicked while B answers (kept, nothing posted), then B's:
// A's turn off is never let go, B's 403s never touch A's key, and A, back
// at the address and lit, is turned off. Every wait is bounded; the app,
// its timers and the server are stopped in `t.after`.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { IntelliFireApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { API_KEY, OTHER_SERIAL, SERIAL, USER_ID, fakeFireplace } from './fixtures/fakeFireplace.js';
import { realClock } from './kit/clock.mjs';
import { httpServer, reply } from './kit/http.mjs';

const SPEED = 20;
const OTHER_KEY = '99995bdb2d97b3dc7cee8a8b05dd0000';
const deviceOf = (serial) => `ext:test-integration:intellifire:${serial}`;

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

/** Waits until `fn()` holds, checked every 10 ms of the real clock; fails after `ms`. */
async function until(fn, ms, what) {
  const deadline = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > deadline) throw new Error(`${what}: not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('real clock x20 (review r3, 13e): a click on B never lets the turn off of A go', async (t) => {
  const a = fakeFireplace({ timers: globalThis, latencyMs: 1, applyDelayMs: 0 });
  const b = fakeFireplace({ timers: globalThis, latencyMs: 1, applyDelayMs: 0 });
  b.serial = OTHER_SERIAL;
  b.apiKey = OTHER_KEY;
  a.state.power = 1;
  b.state.power = 1;
  // The module answering at the address.
  let here = a;
  const answer = (method) => (r) =>
    here.transport({ method, path: r.path, body: r.body, timeoutMs: 1000 }).then(
      (res) => reply(res.status, res.body),
      () => 'drop',
    );
  const server = await httpServer({
    routes: {
      'GET /poll': answer('GET'),
      'GET /get_challenge': answer('GET'),
      'POST /post': answer('POST'),
    },
  });
  const clock = realClock({ speed: SPEED });
  const gladys = createFakeGladys({
    config: {
      address: `127.0.0.1:${server.port}`,
      api_key: API_KEY,
      user_id: USER_ID,
      poll_interval: 10,
    },
  });
  const lines = [];
  const note = (line) => lines.push(String(line));
  const logger = { debug: note, info: note, warn: note, error: note };
  const app = new IntelliFireApp({
    gladys,
    logger,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  registerHandlers(gladys, app, logger);
  // Run whatever happens, even when an await below fails: nothing keeps the process alive.
  t.after(async () => {
    await within(app.shutdown(), 5000, 'shutdown').catch(() => {});
    clock.close();
    await server.close();
  });
  const created = async (serial) => {
    const device = gladys.fake.discoveredDevices.find((d) => d.external_id === deviceOf(serial));
    assert.ok(device, `${serial.slice(-4)} in Discovery`);
    await within(gladys.fake.deviceCreated(device), 5000, 'device created');
  };
  const turnOff = (serial) =>
    within(
      gladys.fake.setValue(
        { external_id: deviceOf(serial) },
        { external_id: `${deviceOf(serial)}:turn-off` },
        1,
      ),
      5000,
      'turn off',
    );

  await within(gladys.connect(), 10_000, 'start');
  await until(() => app.fp.serial === SERIAL, 5000, 'A read');
  await created(SERIAL);
  // B answers at the address now; it is read and its device created too.
  here = b;
  await until(() => app.fp.serial === OTHER_SERIAL, 5000, 'B read');
  await created(OTHER_SERIAL);

  const ackA = await turnOff(SERIAL);
  assert.equal(ackA.success, false);
  assert.match(String(ackA.error), /autre foyer/);
  assert.equal(b.requests.filter((r) => r.method === 'POST').length, 0, 'nothing posted to B');
  const ackB = await turnOff(OTHER_SERIAL);
  assert.equal(ackB.success, false, 'B refuses the key of A');

  const kept = app.guardFor(SERIAL);
  assert.ok(kept && kept.serial === SERIAL, "A's turn off is still kept");
  assert.equal(kept.refused, false);
  assert.equal(app.refusedBy.has(SERIAL), false, "A's key never counted as refused");
  assert.ok(app.guardFor(OTHER_SERIAL), "B's turn off kept too");
  assert.ok(!lines.some((l) => /let go/.test(l)), 'no turn off let go');

  // A back at the address, lit: turned off within 45 s of the app (a check every 15 s), wide margin.
  here = a;
  const back = performance.now();
  await until(() => a.state.power === 0, 8000, 'A turned off');
  assert.ok(performance.now() - back < 45_000 / SPEED + 2000, 'within 45 s of the app');
  assert.ok(
    a.posts.some((p) => p.command === 'power' && p.value === 0),
    "A's turn off posted to A",
  );
  // Let go once a read shows it applied (the read back, 0.5 s of the app later).
  await until(() => app.guardFor(SERIAL) === undefined, 3000, "A's turn off let go once applied");
  assert.ok(app.guardFor(OTHER_SERIAL), "B's turn off never let go by A's");
});
