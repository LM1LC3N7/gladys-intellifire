// -----------------------------------------------------------------------------
// Review r2: the turn off belongs to the device clicked (never to the last
// fireplace read), a setpoint checks everything again before its own post
// and never lengthens a shorter timer, a kept turn off leaves within 15 s of
// the return of the module, nothing runs after shutdown(), and the guards
// the mutants of the review found untested.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOW, CFG, MINUTE, SECOND, ok, refused, setup } from './helpers.js';
import { API_KEY, HOST, OTHER_SERIAL, SERIAL, USER_ID } from './fixtures/fakeFireplace.js';
import { FireplaceClient } from '../src/intellifire/client.js';
import { ERROR_KINDS } from '../src/intellifire/http.js';
import { COMMANDS } from '../src/constants.js';

const OTHER_KEY = '99995bdb2d97b3dc7cee8a8b05dd0000';
const powerOffs = (dev) => dev.posts.filter((p) => p.command === 'power' && p.value === 0);
const posts = (dev) => dev.requests.filter((r) => r.method === 'POST').length;

/** The module at the address becomes another IntelliFire (serial and key). */
function becomeOther(dev) {
  dev.serial = OTHER_SERIAL;
  dev.apiKey = OTHER_KEY;
  dev.state.power = 0;
}

function becomeRight(dev) {
  dev.serial = SERIAL;
  dev.apiKey = API_KEY;
  dev.state.power = 1;
}

test('B1: another fireplace read at the address: the turn off of device A posts nothing to it', async () => {
  const t = await setup();
  becomeOther(t.dev);
  await t.advance(16 * SECOND, 100);
  assert.equal(t.app.fp.serial, OTHER_SERIAL, 'B was read');
  refused(await t.press('turn-off'), /autre foyer/);
  assert.equal(posts(t.dev), 0, 'nothing posted to B');
  assert.equal(t.app.stopGuard.serial, SERIAL, "A's turn off");
  assert.equal(t.app.keyRefused, false);
  assert.equal(t.app.stopGuard.refused, false);
  await t.advance(MINUTE, 200);
  assert.equal(posts(t.dev), 0);
  becomeRight(t.dev);
  await t.advance(40 * SECOND, 200);
  assert.equal(t.dev.state.power, 0, 'A back, lit: turned off');
  assert.equal(t.app.stopGuard, undefined);
});

test('B1: clicked before B is read: its 403s never count against the key of A', async () => {
  const t = await setup();
  becomeOther(t.dev);
  refused(await t.press('turn-off', 1, 8 * SECOND), /autre foyer/);
  assert.equal(t.app.keyRefused, false);
  assert.equal(t.app.stopGuard.refused, false);
  assert.equal(t.app.stopGuard.serial, SERIAL);
  becomeRight(t.dev);
  await t.advance(40 * SECOND, 200);
  assert.equal(t.dev.state.power, 0);
});

test('B1: a kept turn off of another fireplace is replaced by the one clicked', async () => {
  const t = await setup();
  t.dev.state.power = 1;
  t.dev.ignore.add('power');
  await t.press('turn-off');
  t.app.stopGuard.serial = OTHER_SERIAL;
  const old = t.app.stopGuard;
  await t.press('turn-off');
  assert.notEqual(t.app.stopGuard, old);
  assert.equal(t.app.stopGuard.serial, SERIAL);
});

test('I1: the option unticked while the timer of a setpoint is posted: no setpoint posted', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.power = 1;
  t.dev.latencyMs = (path) => (path === '/post' ? 600 : 5);
  t.dev.onPost = (command) => {
    if (command === 'time_remaining') {
      t.gladys.fake.configUpdated({ ...ALLOW, allow_control: false });
    }
  };
  const ack = t.fire('setpoint', 21);
  await t.advance(6 * SECOND, 1);
  refused(await ack, /pas autorisés/);
  assert.equal(t.dev.posts.filter((p) => p.command === 'thermostat_setpoint').length, 0);
});

test('M1: a shorter timer already running is never lengthened by a setpoint', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.power = 1;
  t.dev.state.timer = 1;
  t.dev.state.timeremaining = 600;
  ok(await t.press('setpoint', 21));
  assert.deepEqual(
    t.dev.posts.map((p) => [p.command, p.value]),
    [['thermostat_setpoint', 2100]],
  );
  assert.equal(t.dev.state.timeremaining, 600);
  assert.equal(t.app.startCheck.timerSeen, true);
  assert.equal(t.app.startCheck.minutes, 10);
});

test('I2: a long outage: the kept turn off leaves within 15 s of the return', async () => {
  const t = await setup();
  t.dev.state.power = 1;
  t.dev.down = 'unreachable';
  await t.press('turn-off');
  await t.advance(20 * MINUTE, 1000);
  t.dev.down = false;
  await t.advance(16 * SECOND, 100);
  assert.equal(t.dev.state.power, 0);
});

test('I2: 403s only: checked every 15 s four times, then spaced', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.power = 1;
  ok(await t.press('fan-speed', '3'));
  t.dev.force403 = 100_000;
  await t.press('turn-off');
  const guard = t.app.stopGuard;
  assert.ok(guard);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(t.app.stopDelay(guard), 15 * SECOND, `try ${i}`);
    guard.forbidden += 1;
  }
  guard.forbidden = 5;
  assert.equal(t.app.stopDelay(guard), 30 * SECOND);
  guard.forbidden = 0;
  const before = t.dev.requests.filter((r) => r.path === '/poll').length;
  await t.advance(46 * SECOND, 100);
  assert.ok(t.dev.requests.filter((r) => r.path === '/poll').length - before >= 3, 'every 15 s');
});

test('I3: after shutdown in flight, no request and no timer any more', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.power = 1;
  t.dev.ignore.add('power');
  t.dev.latencyMs = (path) => (path === '/post' ? 1500 : 5);
  const ack = t.fire('turn-off');
  await t.advance(600, 50);
  await t.app.shutdown();
  const n = t.dev.requests.length;
  await t.advance(5 * MINUTE, 500);
  await t.until(
    ack.catch(() => {}),
    10 * SECOND,
  );
  assert.equal(t.dev.requests.length, n, 'no request after shutdown');
  assert.equal(t.clock.pending, 0, 'no timer left');
});

test('I3: after shutdown following a turn on, the follow-up reads never come', async () => {
  const t = await setup({ config: ALLOW });
  ok(await t.press('turn-on'));
  await t.app.shutdown();
  const n = t.dev.requests.length;
  await t.advance(2 * MINUTE, 500);
  assert.equal(t.dev.requests.length, n);
  assert.equal(t.clock.pending, 0);
});

test('I4: a challenge already too old when it arrives is replaced before any post', async () => {
  let t = 0;
  let jump = 0;
  const paths = [];
  const transport = async (req) => {
    paths.push(req.path);
    if (req.path === '/get_challenge') {
      if (paths.filter((p) => p === '/get_challenge').length === 1) jump = 2;
      return { status: 200, headers: {}, body: '0a1b2c3d' };
    }
    req.beforeSend?.();
    return { status: 204, headers: {}, body: '' };
  };
  const now = () => {
    if (jump > 0) {
      jump -= 1;
      if (jump === 0) t += 6000;
    }
    return t;
  };
  const client = new FireplaceClient({ transport, now });
  await client.command(
    { host: HOST, port: 80 },
    { apiKey: API_KEY, userId: USER_ID },
    COMMANDS.POWER,
    0,
    {
      until: Infinity,
    },
  );
  assert.deepEqual(paths, ['/get_challenge', '/get_challenge', '/post']);
});

test('I4: the proof of a refused key needs this serial read at the address', async () => {
  const t = await setup();
  const err = { kind: ERROR_KINDS.AUTH };
  assert.equal(t.app.keyRefusalProven(err, SERIAL), true);
  t.app.fp.serial = OTHER_SERIAL;
  assert.equal(t.app.keyRefusalProven(err, SERIAL), false);
});

test('I4: a read started too soon after the post never ends the session', async () => {
  const t = await setup({ config: ALLOW });
  t.app.armSession(SERIAL, false, { minutes: 60, timerSeen: false });
  const c = t.app.startCheck;
  const off = { serial: SERIAL, power: false, thermostat: false };
  t.app.observeStart(off, c.sentAt + SECOND);
  assert.equal(t.app.startCheck, c, 'a read 1 s after the post may not show it yet');
  t.app.observeStart(off, c.sentAt + 3 * SECOND);
  assert.equal(t.app.startCheck, undefined);
});

test('r2: a kept turn off without key: the configuration still read with CFG later', async () => {
  const t = await setup({ config: { address: HOST } });
  t.dev.state.power = 1;
  await t.press('turn-off');
  await t.until(t.gladys.fake.configUpdated(CFG));
  await t.advance(3 * SECOND, 100);
  assert.equal(powerOffs(t.dev).length, 1);
});

test('I2: a module that does not answer never counts as 403s (no spacing)', async () => {
  const t = await setup();
  t.dev.state.power = 1;
  t.dev.down = 'unreachable';
  await t.press('turn-off');
  assert.equal(t.app.stopGuard.forbidden, 0);
});

test('I3: a command or a turn off ending after shutdown arms no timer', async () => {
  for (const [role, value] of [
    ['fan-speed', '3'],
    ['turn-off', 1],
  ]) {
    const t = await setup({ config: ALLOW });
    t.dev.state.power = 1;
    t.dev.ignore.add('power');
    t.dev.latencyMs = (path) => (path === '/post' ? 1500 : 5);
    const ack = t.fire(role, value);
    await t.advance(600, 50);
    await t.app.shutdown();
    await t.advance(2000, 50);
    await t.until(
      ack.catch(() => {}),
      10 * SECOND,
    );
    assert.equal(t.clock.pending, 0, `${role}: no timer armed after shutdown`);
  }
});
