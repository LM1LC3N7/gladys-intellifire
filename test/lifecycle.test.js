// -----------------------------------------------------------------------------
// Reads never sooner than the interval (restart, button, reconnection), no
// stale value sent as new, /data unreadable never overwritten.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CFG, MINUTE, SECOND, setup } from './helpers.js';
import { HOST, NOW, SERIAL, fakeFireplace } from './fixtures/fakeFireplace.js';
import { memoryStore } from '../src/store.js';
import { testClock } from './kit/clock.mjs';

const polls = (dev) => dev.requests.filter((r) => r.path === '/poll').length;

test('a read every interval, never sooner after a restart', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeFireplace({ timers: clock.timers });
  const store = memoryStore({ lastAttemptAt: NOW - 5 * SECOND });
  const t = await setup({
    clock,
    dev,
    store,
    create: false,
    config: { ...CFG, poll_interval: 30 },
  });
  assert.equal(polls(dev), 0, 'not before the interval');
  await t.advance(MINUTE + 30 * SECOND, 100);
  const n = polls(dev);
  assert.ok(n >= 2 && n <= 3, `${n} reads`);
});

test('the test button and a reconnection never read sooner than the interval', async () => {
  const t = await setup();
  const before = polls(t.dev);
  const ack = await t.gladys.fake.action('test_connection');
  assert.match(JSON.stringify(ack), /Prochaine lecture/);
  await t.until(t.app.onConnected(() => t.gladys.getConfig()));
  assert.equal(polls(t.dev), before);
});

test('values older than 2 minutes are never sent as new', async () => {
  const t = await setup({ create: false });
  t.dev.down = 'unreachable';
  await t.advance(3 * MINUTE, 200);
  const count = t.gladys.fake.states.length;
  await t.until(t.gladys.fake.deviceCreated(t.gladys.fake.discoveredDevices[0]));
  await t.advance(2 * SECOND);
  const sent = t.gladys.fake.states.slice(count);
  assert.ok(
    sent.every((s) => s.device_feature_external_id.endsWith(':status')),
    JSON.stringify(sent),
  );
  assert.equal(t.status().connected, false);
});

test('/data unreadable: never overwritten, read at once', async () => {
  const clock = testClock({ start: NOW });
  const store = memoryStore(
    { target: { host: HOST, port: 80, serial: SERIAL } },
    { unreadable: true },
  );
  const t = await setup({ clock, store, create: false });
  await t.advance(MINUTE, 100);
  assert.equal(store.saves, 0);
  assert.deepEqual(store.data.target, { host: HOST, port: 80, serial: SERIAL });
});

test('a module without serial number: not applied, said in the status', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeFireplace({ timers: clock.timers });
  dev.serial = '';
  const t = await setup({ clock, dev, create: false });
  assert.equal(t.gladys.fake.discoveredDevices.length, 0);
  assert.match(t.status().text, /numéro de série/);
});

test('an oversized answer is cut, the read fails without crashing', async () => {
  const { request } = await import('../src/intellifire/http.js');
  const { httpServer } = await import('./kit/http.mjs');
  const server = await httpServer({ routes: { '/poll': { a: 'x'.repeat(40_000) } } });
  try {
    await assert.rejects(
      request({ host: '127.0.0.1', port: server.port, path: '/poll', timeoutMs: 2000 }),
      /too large/i,
    );
  } finally {
    await server.close();
  }
});
