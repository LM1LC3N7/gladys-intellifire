// -----------------------------------------------------------------------------
// The app end to end on the fake module and the SDK's fake Gladys: reads,
// device, states, commands and their refusals.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOW, CFG, DEVICE, SECOND, feature, ok, refused, setup } from './helpers.js';
import { OTHER_SERIAL, SERIAL } from './fixtures/fakeFireplace.js';

test('a read: the device of the serial, its states, connected', async () => {
  const t = await setup();
  const [device] = t.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE);
  assert.ok(device.features.every((f) => !(f.category === 'switch' && f.type === 'binary')));
  assert.equal(t.state('flame-on').state, 0);
  assert.equal(t.state('temperature').state, 19);
  assert.equal(t.state('flame-height').text, '3');
  assert.equal(t.state('setpoint'), undefined, 'a setpoint of 0 is never published');
  assert.equal(t.status().connected, true);
  assert.equal(t.dev.peak, 1);
});

test('turn off: never behind the option, power 0 then thermostat 0, confirmed', async () => {
  const t = await setup();
  t.dev.state.power = 1;
  t.dev.state.thermostat = 1;
  t.dev.state.setpoint = 2100;
  ok(await t.press('turn-off'));
  assert.deepEqual(
    t.dev.posts.map((p) => [p.command, p.value]),
    [
      ['power', 0],
      ['thermostat_setpoint', 0],
    ],
  );
  assert.equal(t.dev.state.power, 0);
  assert.equal(t.app.stopGuard, undefined);
});

test('turn on, flame, fan, setpoint: refused without the option, nothing posted', async () => {
  const t = await setup();
  for (const [role, value] of [
    ['turn-on', 1],
    ['flame-height', '4'],
    ['fan-speed', '2'],
    ['setpoint', 21],
  ]) {
    refused(await t.press(role, value), /pas autorisés/);
  }
  assert.equal(t.dev.requests.filter((r) => r.method === 'POST').length, 0);
});

test('turn on: power 1 then the timer of the configuration, confirmed by the read back', async () => {
  const t = await setup({ config: { ...ALLOW, session_duration: 30 } });
  ok(await t.press('turn-on'));
  assert.deepEqual(
    t.dev.posts.map((p) => [p.command, p.value]),
    [
      ['power', 1],
      ['time_remaining', 1800],
    ],
  );
  assert.equal(t.dev.state.timer, 1);
});

test('turn on: a timer refused turns the fireplace off at once', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.commandStatus.time_remaining = 422;
  refused(await t.press('turn-on', 1, 8 * SECOND), /minuterie/);
  assert.equal(t.dev.state.power, 0);
  assert.equal(t.dev.posts.at(-2).command, 'power');
  assert.equal(t.dev.posts.at(-2).value, 0);
});

test('turn on: the reads turn it off when the timer is gone', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.ignore.add('time_remaining');
  await t.press('turn-on', 1, 25 * SECOND);
  assert.equal(t.dev.state.power, 0, 'turned off by the start check');
});

test('turn on refused while a disabling fault is listed', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.errors = [6, 642];
  refused(await t.press('turn-on'), /défaut/);
  assert.equal(t.dev.posts.length, 0);
});

test('flame height and setpoint never light the fireplace', async () => {
  const t = await setup({ config: ALLOW });
  refused(await t.press('flame-height', '5'), /éteint/);
  refused(await t.press('setpoint', 21), /éteint/);
  assert.equal(t.dev.posts.length, 0);
  t.dev.state.power = 1;
  ok(await t.press('flame-height', '5'));
  assert.equal(t.dev.state.height, 4);
  ok(await t.press('setpoint', 21));
  assert.equal(t.dev.state.setpoint, 2100);
});

test('setpoint bounded by the configuration, fan behind the option', async () => {
  const t = await setup({ config: { ...ALLOW, max_temperature: 24 } });
  t.dev.state.power = 1;
  refused(await t.press('setpoint', 25), /de 5 à 24/);
  refused(await t.press('setpoint', '21.5'), /entier/);
  ok(await t.press('fan-speed', '3'));
  assert.equal(t.dev.state.fanspeed, 3);
});

test('a command to another fireplace at the address: refused, nothing posted', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.serial = OTHER_SERIAL;
  refused(await t.press('fan-speed', '3'), /autre numéro de série/);
  assert.equal(t.dev.posts.length, 0);
  assert.notEqual(SERIAL, OTHER_SERIAL);
});

test('a wrong key: 403 twice, refused, said in the status', async () => {
  const t = await setup({ config: { ...ALLOW, api_key: 'ff'.repeat(16) } });
  t.dev.state.power = 1;
  refused(await t.press('fan-speed', '3'), /refuse la clé/);
  assert.match(t.status().text, /refusé la clé/);
});

test('a turn off without key: kept, leaves as soon as a key is saved', async () => {
  const t = await setup({ config: { address: CFG.address } });
  t.dev.state.power = 1;
  refused(await t.press('turn-off'), /gardée/);
  assert.equal(t.dev.posts.length, 0);
  assert.ok(t.app.stopGuard);
  await t.until(t.gladys.fake.configUpdated?.(CFG) ?? t.app.configUpdated(CFG));
  await t.advance(5 * SECOND);
  assert.equal(t.dev.state.power, 0);
  assert.equal(t.app.stopGuard, undefined);
});

test('feature ids: the status of a feature never listed refuses', async () => {
  const t = await setup();
  refused(await t.press('temperature', 1), /lecture seule/);
  assert.equal(feature('x'), `${DEVICE}:x`);
});
