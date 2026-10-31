// -----------------------------------------------------------------------------
// The checks a command passes twice (on arrival, then right before its post)
// and the rules of reads and of a turn off that never left.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOW, CFG, MINUTE, SECOND, refused, setup } from './helpers.js';
import { HOST } from './fixtures/fakeFireplace.js';

const slowPoll = (dev, ms) => {
  dev.latencyMs = (path) => (path === '/poll' ? ms : 5);
};
const polls = (dev) => dev.requests.filter((r) => r.path === '/poll').length;

test('the option unticked while the fresh read runs: nothing posted', async () => {
  const t = await setup({ config: ALLOW });
  slowPoll(t.dev, 800);
  const ack = t.fire('fan-speed', '3');
  await t.advance(200);
  await t.until(t.gladys.fake.configUpdated({ ...ALLOW, allow_control: false }));
  await t.advance(5 * SECOND, 50);
  refused(await ack, /pas autorisés/);
  assert.equal(t.dev.posts.length, 0);
});

test('the setpoint ceiling lowered while the fresh read runs: refused', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.power = 1;
  slowPoll(t.dev, 800);
  const ack = t.fire('setpoint', 25);
  await t.advance(200);
  await t.until(t.gladys.fake.configUpdated({ ...ALLOW, max_temperature: 22 }));
  await t.advance(5 * SECOND, 50);
  refused(await ack, /de 5 à 22/);
  assert.equal(t.dev.posts.length, 0);
});

test('a command waiting for the line behind a turn off never posts after it', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.power = 1;
  slowPoll(t.dev, 1500);
  for (let i = 0; i < 400 && t.app.lane.holder?.kind !== 'read'; i += 1) await t.advance(100, 100);
  assert.equal(t.app.lane.holder?.kind, 'read');
  const fan = t.fire('fan-speed', '4');
  await t.advance(20);
  const off = t.fire('turn-off');
  t.dev.latencyMs = 5;
  await t.advance(8 * SECOND, 50);
  await off;
  refused(await fan, /extinction a été cliquée/);
  assert.equal(t.dev.posts.filter((p) => p.command === 'fan_speed').length, 0);
});

test('a read that started before a post is never applied', async () => {
  const t = await setup();
  const data = { ...t.app.fp.data, power: true };
  const before = t.app.mono();
  t.app.lastSentAt = t.app.mono();
  assert.equal(t.app.applyRead(data, before), false);
  assert.equal(t.app.fp.data.power, false);
});

test('a long interval: values older than 2 minutes never sent to a device created later', async () => {
  const t = await setup({ config: { ...CFG, poll_interval: 600 }, create: false });
  await t.advance(3 * MINUTE, 200);
  const count = t.gladys.fake.states.length;
  await t.until(t.gladys.fake.deviceCreated(t.gladys.fake.discoveredDevices[0]));
  await t.advance(2 * SECOND);
  assert.equal(t.gladys.fake.states.length, count);
});

test('a turn off that never left needs two reads in a row showing the fire off', async () => {
  const t = await setup({ config: { address: HOST } });
  t.dev.state.power = 1;
  await t.press('turn-off');
  assert.ok(t.app.stopGuard);
  t.dev.state.power = 0;
  const n = polls(t.dev);
  for (let i = 0; i < 400 && polls(t.dev) === n; i += 1) await t.advance(100, 100);
  await t.advance(100);
  assert.ok(t.app.stopGuard, 'one read is not enough');
  await t.advance(40 * SECOND, 100);
  assert.equal(t.app.stopGuard, undefined);
});
