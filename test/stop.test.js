// -----------------------------------------------------------------------------
// The turn off is never held back: the option, a 429 pause, a configuration
// not read, a read stuck, a command in flight, a restart, a hung /data, a key
// refused (kept until a new one). Resent 3 times at most, then held; let go
// by a read showing the flame off, never by time.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOW, CFG, MINUTE, SECOND, ok, refused, setup } from './helpers.js';
import { API_KEY, HOST, NOW, USER_ID, fakeFireplace } from './fixtures/fakeFireplace.js';
import { memoryStore } from '../src/store.js';
import { testClock } from './kit/clock.mjs';

const powerOffs = (dev) => dev.posts.filter((p) => p.command === 'power' && p.value === 0);

test('during a 429 pause: the turn off still goes', async () => {
  const t = await setup();
  t.dev.state.power = 1;
  t.dev.status['/poll'] = 429;
  await t.advance(16 * SECOND);
  assert.ok(t.app.paused);
  await t.press('turn-off');
  assert.equal(powerOffs(t.dev).length, 1);
  assert.equal(t.dev.state.power, 0);
});

test('getConfig() failing in connected: retried every 30 s; a turn off waits for the key, then goes', async () => {
  const t = await setup({ getConfigFails: 1, create: false });
  assert.match(t.status().text, /ne peut pas être lue/);
  t.dev.state.power = 1;
  const ack = t.fire('turn-off');
  await t.advance(5 * SECOND, 50);
  refused(await ack, /Aucune adresse|gardée/);
  await t.advance(30 * SECOND, 100);
  assert.equal(t.app.configRead, true);
  assert.equal(t.status().connected, true);
  assert.ok(t.app.config.credentials);
});

test('a read stuck on a silent module is cut: the turn off posts at once', async () => {
  const t = await setup();
  t.dev.state.power = 1;
  t.dev.silent.add('/poll');
  await t.advance(15 * SECOND + 100);
  assert.equal(t.app.lane.holder?.kind, 'read');
  const clickAt = t.clock.monotonic();
  await t.press('turn-off');
  const off = powerOffs(t.dev)[0];
  assert.ok(off && off.at - clickAt < SECOND, 'posted within a second');
  assert.equal(t.dev.peak, 1, 'one exchange at a time');
});

test('nothing clicked before a turn off leaves after it', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.power = 1;
  t.dev.latencyMs = (path) => (path === '/poll' ? 400 : 5);
  const fan = t.fire('fan-speed', '4');
  await t.advance(50);
  const off = t.fire('turn-off');
  await t.advance(6 * SECOND, 50);
  refused(await fan, /extinction/i);
  await off;
  assert.equal(t.dev.posts.filter((p) => p.command === 'fan_speed').length, 0);
  assert.equal(powerOffs(t.dev).length, 1);
});

test('restart: a turn off kept in /data goes once the configuration gives the key', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeFireplace({ timers: clock.timers });
  dev.state.power = 1;
  const store = memoryStore({
    target: { host: HOST, port: 80, serial: dev.serial },
    lastAttemptAt: NOW - 1000,
    stop: { host: HOST, port: 80, since: NOW - 60_000, written: true, resends: 0 },
  });
  const t = await setup({ clock, dev, store, boot: true, create: false });
  assert.equal(powerOffs(t.dev).length, 1);
  assert.equal(t.dev.state.power, 0);
  assert.equal(t.app.stopGuard, undefined);
  assert.equal(store.data.stop, null);
});

test('a hung /data never holds a turn off nor the next click', async () => {
  const t = await setup();
  t.dev.state.power = 1;
  t.store.hang = new Promise(() => {});
  t.dev.ignore.add('power');
  await t.press('turn-off');
  await t.press('turn-off');
  assert.equal(powerOffs(t.dev).length, 2);
  t.dev.ignore.clear();
  await t.press('turn-off');
  assert.equal(t.dev.state.power, 0);
});

test('not applied: posted again 3 times, then held; let go when a read shows it off', async () => {
  const t = await setup();
  t.dev.state.power = 1;
  t.dev.ignore.add('power');
  refused(await t.press('turn-off'), /montre encore la flamme/);
  await t.advance(2 * MINUTE, 100);
  assert.equal(powerOffs(t.dev).length, 4);
  assert.match(t.status().text, /4 fois/);
  await t.advance(2 * MINUTE, 100);
  assert.equal(powerOffs(t.dev).length, 4, 'never more than 3 resends');
  assert.ok(t.app.stopGuard, 'never let go by time');
  t.dev.state.power = 0;
  await t.advance(40 * SECOND, 100);
  assert.equal(t.app.stopGuard, undefined);
});

test('a key refused: the turn off kept, never tried by itself, goes with a new key', async () => {
  const bad = { address: HOST, api_key: 'ff'.repeat(16), user_id: USER_ID };
  const t = await setup({ config: bad });
  t.dev.state.power = 1;
  refused(await t.press('turn-off'), /gardée/);
  const posts = t.dev.requests.filter((r) => r.method === 'POST').length;
  await t.advance(3 * MINUTE, 200);
  assert.equal(t.dev.requests.filter((r) => r.method === 'POST').length, posts);
  assert.match(t.status().text, /attend une clé/);
  assert.equal(t.store.data.stop.refused, true);
  await t.until(t.gladys.fake.configUpdated({ ...bad, api_key: API_KEY }));
  await t.advance(3 * SECOND);
  assert.equal(t.dev.state.power, 0);
  assert.equal(t.app.stopGuard, undefined);
});

test('a newer turn on clicked with the option lets a held turn off go', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.power = 1;
  t.dev.ignore.add('power');
  await t.press('turn-off');
  assert.ok(t.app.stopGuard);
  refused(await t.press('fan-speed', '2'), /extinction est en cours/);
  t.dev.ignore.clear();
  t.dev.state.power = 0;
  ok(await t.press('turn-on'));
  assert.equal(t.app.stopGuard, undefined);
  assert.equal(t.dev.state.power, 1);
});

test('turn on: /data that fails refuses before any post', async () => {
  const t = await setup({ config: ALLOW });
  t.store.failSave = true;
  refused(await t.press('turn-on'), /data/);
  assert.equal(t.dev.posts.length, 0);
});

test('secrets: never in the logs, /data nor the status', async () => {
  const t = await setup({ config: CFG });
  t.dev.state.power = 1;
  await t.press('turn-off');
  const all = JSON.stringify([t.lines, t.store.data, t.gladys.fake.connectionStatus]);
  assert.ok(!all.includes(API_KEY));
  assert.ok(!all.includes(USER_ID));
});
