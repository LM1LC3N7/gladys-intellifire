// -----------------------------------------------------------------------------
// Review r1: a 403 is a challenge expired (never a refused key without
// proof); the turn off follows its fireplace (serial), not an address; the
// session of a turn on is never lifted by time; /data never waited without
// bound; a manual relight is never fought; a key refusal is lifted by a save
// or a test read; a setpoint always goes with its timer; and the guards the
// mutants of the review found untested.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOW, CFG, MINUTE, SECOND, ok, refused, setup } from './helpers.js';
import {
  API_KEY,
  HOST,
  NOW,
  OTHER_SERIAL,
  SERIAL,
  USER_ID,
  fakeFireplace,
} from './fixtures/fakeFireplace.js';
import { fileStore, memoryStore, normalizeMemory } from '../src/store.js';
import { FireplaceClient } from '../src/intellifire/client.js';
import { COMMANDS } from '../src/constants.js';
import { testClock } from './kit/clock.mjs';

const powerOffs = (dev) => dev.posts.filter((p) => p.command === 'power' && p.value === 0);
const challenges = (dev) => dev.requests.filter((r) => r.path === '/get_challenge').length;

// --- B1: 403 ---------------------------------------------------------------------

test('B1: 403s are challenges expired: retried with new challenges, the command goes', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.force403 = 4;
  ok(await t.press('fan-speed', '3'));
  assert.equal(t.dev.state.fanspeed, 3);
  assert.equal(challenges(t.dev) >= 5, true);
  assert.equal(t.app.keyRefused, false);
});

test('B1: 403s until the time runs out are never a refused key; the turn off goes later', async () => {
  const t = await setup();
  t.dev.state.power = 1;
  t.dev.latencyMs = (path) => (path === '/post' ? 700 : 5);
  t.dev.force403 = 6;
  refused(await t.press('turn-off', 1, 6 * SECOND), /Extinction : rien envoyé \(HTTP 403\)/);
  assert.equal(t.app.keyRefused, false);
  assert.equal(t.app.stopGuard.refused, false);
  t.dev.latencyMs = 5;
  await t.advance(20 * SECOND, 100);
  assert.equal(t.dev.state.power, 0);
});

test('B1: a key this serial accepted is never "refused" by 403s: the turn off is kept and retried', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.power = 1;
  ok(await t.press('fan-speed', '3'));
  t.dev.latencyMs = (path) => (path === '/post' ? 100 : 5);
  t.dev.force403 = 60;
  refused(await t.press('turn-off', 1, 6 * SECOND), /rien envoyé|réessayée/);
  assert.equal(t.app.stopGuard?.refused, false);
  assert.equal(t.app.keyRefused, false);
  await t.advance(MINUTE, 100);
  assert.equal(t.dev.state.power, 0);
});

test('B1: ten 403s, a key never accepted, this serial read: refused, kept, no automatic post', async () => {
  const t = await setup({ config: { ...CFG, api_key: 'ee'.repeat(16) } });
  t.dev.state.power = 1;
  refused(await t.press('turn-off', 1, 6 * SECOND), /refuse la clé/);
  assert.equal(t.app.stopGuard.refused, true);
  const posts = t.dev.requests.filter((r) => r.method === 'POST').length;
  await t.advance(2 * MINUTE, 200);
  assert.equal(t.dev.requests.filter((r) => r.method === 'POST').length, posts);
});

test('B1: a timer refused after the turn on: the ack says where the turn off is, exactly', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.commandStatus.time_remaining = 422;
  refused(await t.press('turn-on', 1, 8 * SECOND), /le foyer a été éteint/);
  assert.equal(t.dev.state.power, 0);
  // The turn off cannot leave before the ack (the module silent on posts): never "turned off".
  t.dev.commandStatus = {};
  t.dev.state.power = 0;
  t.dev.commandStatus.time_remaining = 422;
  t.dev.onStatus = () => {
    t.dev.down = 'unreachable';
  };
  const ack = t.fire('turn-on');
  await t.advance(6 * SECOND, 50);
  const answer = await ack;
  assert.match(String(answer.error), /minuterie/);
  assert.doesNotMatch(String(answer.error), /a été éteint/);
  t.dev.down = false;
  await t.advance(MINUTE, 200);
  assert.equal(t.dev.state.power, 0, 'the kept turn off went later');
});

test('B1: a challenge older than 5 s is never posted', async () => {
  let t = 0;
  let sent = 0;
  const transport = async (req) => {
    if (req.path === '/get_challenge') return { status: 200, headers: {}, body: '0a1b2c3d' };
    // A post that connects 6 s after its challenge: refused before its first byte.
    t += 6000;
    req.beforeSend?.();
    sent += 1;
    return { status: 204, headers: {}, body: '' };
  };
  const client = new FireplaceClient({ transport, now: () => t });
  await assert.rejects(
    client.command(
      { host: HOST, port: 80 },
      { apiKey: API_KEY, userId: USER_ID },
      COMMANDS.POWER,
      0,
      {
        until: 60_000,
      },
    ),
    /Challenge too old/,
  );
  assert.equal(sent, 0);
});

test('B1: a 403 is retried with a NEW challenge each time', async () => {
  const bodies = [];
  let n = 0;
  const transport = async (req) => {
    if (req.path === '/get_challenge') {
      n += 1;
      return { status: 200, headers: {}, body: `0a1b2c${String(n).padStart(2, '0')}` };
    }
    bodies.push(req.body);
    return { status: bodies.length < 3 ? 403 : 204, headers: {}, body: '' };
  };
  const client = new FireplaceClient({ transport, now: () => 0 });
  await client.command(
    { host: HOST, port: 80 },
    { apiKey: API_KEY, userId: USER_ID },
    COMMANDS.POWER,
    0,
    {
      until: 60_000,
    },
  );
  assert.equal(new Set(bodies).size, 3, 'three signatures, three challenges');
});

// --- B2: the turn off follows the fireplace -------------------------------------------

test('B2: a kept turn off follows its fireplace to the new address typed', async () => {
  const t = await setup();
  t.dev.state.power = 1;
  t.dev.down = 'unreachable';
  refused(await t.press('turn-off'), /rien envoyé/);
  t.dev.down = false;
  const other = '192.168.1.70';
  await t.until(t.gladys.fake.configUpdated({ ...CFG, address: other }));
  await t.advance(5 * SECOND, 100);
  const toNew = t.dev.requests.filter((r) => r.method === 'POST');
  assert.ok(toNew.length > 0);
  assert.equal(t.dev.state.power, 0);
  assert.equal(t.app.stopGuard, undefined);
});

test('B2: another IntelliFire at the address never lets the turn off of this one go', async () => {
  const t = await setup();
  t.dev.state.power = 1;
  t.dev.down = 'unreachable';
  await t.press('turn-off');
  t.dev.down = false;
  t.dev.serial = OTHER_SERIAL;
  t.dev.state.power = 0;
  await t.advance(MINUTE, 200);
  assert.ok(t.app.stopGuard, 'kept');
  assert.equal(t.app.stopGuard.serial, SERIAL);
  assert.match(t.status().text, /un autre .*répond/);
  assert.equal(t.app.keyRefused, false);
  t.dev.serial = SERIAL;
  t.dev.state.power = 1;
  await t.advance(40 * SECOND, 200);
  assert.equal(t.dev.state.power, 0);
  assert.equal(t.app.stopGuard, undefined);
});

test('B2: the serial is kept in /data with the turn off', async () => {
  const t = await setup();
  t.dev.state.power = 1;
  t.dev.ignore.add('power');
  await t.press('turn-off');
  assert.equal(t.store.data.stops[0].serial, SERIAL);
});

// --- B3, I1, M5: the session of a turn on ----------------------------------------------

test('B3: lit without answer, module away 3 min, back without timer: timed or off', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.silent.add('/post');
  refused(await t.press('turn-on', 1, 6 * SECOND));
  t.dev.silent.clear();
  t.dev.apply('power', 1);
  t.dev.down = 'unreachable';
  await t.advance(3 * MINUTE, 500);
  assert.ok(t.app.startCheck, 'never lifted by time');
  t.dev.down = false;
  await t.advance(MINUTE, 200);
  assert.ok(t.dev.state.power === 0 || t.dev.state.timer === 1);
});

test('B3: a session kept in /data for hours is resumed after a restart', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeFireplace({ timers: clock.timers });
  dev.state.power = 1;
  dev.ignore.add('time_remaining');
  const store = memoryStore({
    target: { host: HOST, port: 80, serial: SERIAL },
    start: { since: NOW - 5 * 3600_000, minutes: 60, serial: SERIAL },
  });
  const t = await setup({ clock, dev, store, create: false });
  assert.ok(t.app.startCheck);
  await t.advance(MINUTE, 200);
  assert.equal(dev.posts.filter((p) => p.command === 'time_remaining').length, 1, 'once more');
  assert.equal(dev.state.power, 0, 'then off');
});

test('B3: a session date in the future counts as now', () => {
  const m = normalizeMemory({ start: { since: NOW + 3600_000, minutes: 60, serial: SERIAL } }, NOW);
  assert.equal(m.start.since, NOW);
});

test('I1: the fire read off ends the session: a relight by hand is never fought', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.ignore.add('time_remaining');
  await t.press('turn-on', 1, 3 * SECOND);
  t.dev.state.power = 0;
  await t.advance(16 * SECOND, 100);
  assert.equal(t.app.startCheck, undefined);
  t.dev.state.power = 1;
  await t.advance(MINUTE, 200);
  assert.equal(powerOffs(t.dev).length, 0);
});

test('B3: the timer must not exceed the session (a longer one is not the session)', async () => {
  const t = await setup({ config: { ...ALLOW, session_duration: 30 } });
  t.dev.onlyTimer = 7200;
  t.dev.ignore.add('time_remaining');
  await t.press('turn-on', 1, 3 * SECOND);
  t.dev.state.timer = 1;
  t.dev.state.timeremaining = 7200;
  await t.advance(MINUTE, 200);
  assert.equal(t.dev.state.power, 0, 'a timer of 2 h is not the 30 min asked');
});

// --- B4: /data -----------------------------------------------------------------------------

test('B4: a FIFO at the state path is unreadable at once, never read nor waited for', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ifr-fifo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  execFileSync('mkfifo', [path]);
  const started = Date.now();
  assert.deepEqual(await fileStore(path).load(), { unreadable: true });
  assert.ok(Date.now() - started < 1000);
  execFileSync('mkfifo', [`${path}.tmp`]);
  await assert.rejects(fileStore(path).save({ a: 1 }));
});

test('B4: /data load frozen: start finishes, reads go, a key saved applies', async () => {
  const clock = testClock({ start: NOW });
  const store = memoryStore();
  store.hangLoad = new Promise(() => {});
  const t = await setup({ clock, store, create: false, config: { address: HOST } });
  assert.ok(t.dev.requests.some((r) => r.path === '/poll'));
  t.dev.state.power = 1;
  await t.press('turn-off');
  await t.until(t.gladys.fake.configUpdated(CFG));
  await t.advance(5 * SECOND, 100);
  assert.equal(t.dev.state.power, 0);
});

test('B4: /data save frozen and a 429: the reads resume, the test button answers', async () => {
  const t = await setup();
  t.store.hang = new Promise(() => {});
  t.dev.status['/poll'] = 429;
  await t.advance(16 * SECOND, 100);
  assert.ok(t.app.paused);
  delete t.dev.status['/poll'];
  const ack = t.gladys.fake.action('test_connection');
  await t.advance(SECOND, 100);
  assert.ok(await ack);
  const n = t.dev.requests.filter((r) => r.path === '/poll').length;
  await t.advance(6 * MINUTE, 500);
  assert.ok(t.dev.requests.filter((r) => r.path === '/poll').length > n);
  assert.equal(t.app.fp.running, undefined);
});

// --- I2: key refusal lifted ------------------------------------------------------------------

test('I2: the same key saved again, or a test read, lifts a refusal for the commands', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.power = 1;
  t.app.refusedBy.add(SERIAL);
  refused(await t.press('fan-speed', '3'), /refuse la clé/);
  await t.until(t.gladys.fake.configUpdated(ALLOW));
  ok(await t.press('fan-speed', '3'));
  t.app.refusedBy.add(SERIAL);
  await t.advance(16 * SECOND, 100);
  await t.until(t.gladys.fake.action('test_connection'));
  ok(await t.press('fan-speed', '2'));
});

// --- I3, M2: the setpoint ---------------------------------------------------------------------

test('I3: a setpoint always posts the timer of the session first, then ends the thermostat session', async () => {
  const t = await setup({ config: { ...ALLOW, session_duration: 10 } });
  t.dev.state.power = 1;
  ok(await t.press('setpoint', 21));
  assert.deepEqual(
    t.dev.posts.map((p) => [p.command, p.value]),
    [
      ['time_remaining', 600],
      ['thermostat_setpoint', 2100],
    ],
  );
  assert.equal(t.app.startCheck.thermostat, true);
  // The module's timer would end the flame; here the thermostat keeps it going.
  t.dev.ignore.add('power');
  await t.advance(13 * MINUTE, 1000);
  assert.ok(powerOffs(t.dev).length >= 1, 'turned off at the end of the session');
  assert.equal(t.dev.state.thermostat, 0);
});

test('M2: a setpoint read back other than sent: the thermostat setpoint set to 0', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.power = 1;
  t.dev.onPost = undefined;
  const apply = t.dev.apply;
  t.dev.apply = (c, v) => apply(c, c === 'thermostat_setpoint' && v > 0 ? 21 : v);
  refused(await t.press('setpoint', 21), /remise à 0/);
  assert.deepEqual(t.dev.posts.at(-1), {
    ...t.dev.posts.at(-1),
    command: 'thermostat_setpoint',
    value: 0,
  });
});

test('M7: a read without the thermostat field is not "thermostat off"', async () => {
  const t = await setup();
  t.dev.state.power = 1;
  t.dev.ignore.add('power');
  await t.press('turn-off');
  const guard = t.app.stopGuard;
  assert.equal(t.app.decideStop(guard, { serial: SERIAL, power: false }, Infinity), 'resend');
  assert.equal(
    t.app.decideStop(guard, { serial: SERIAL, power: false, thermostat: false }, Infinity),
    'done',
  );
});

// --- I4: guards of checkCommand and others ----------------------------------------------------

test('I4: a command is refused while a turn off is queued or running', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.power = 1;
  t.dev.latencyMs = (path) => (path === '/post' ? 300 : 5);
  const off = t.fire('turn-off');
  await t.advance(20);
  refused(await t.press('fan-speed', '3'), /extinction est en cours/);
  await off;
});

test('I4: a command is refused during a pause, and no read goes then', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.status['/poll'] = 429;
  await t.advance(16 * SECOND, 100);
  delete t.dev.status['/poll'];
  const n = t.dev.requests.length;
  refused(await t.press('fan-speed', '3'), /demandé d'attendre/);
  await t.advance(30 * SECOND, 200);
  assert.equal(t.dev.requests.length, n, 'nothing read during the pause');
});

test('I4: a command is refused while the key is refused', async () => {
  const t = await setup({ config: ALLOW });
  t.app.refusedBy.add(SERIAL);
  refused(await t.press('fan-speed', '3'), /refuse la clé/);
  assert.equal(t.dev.posts.length, 0);
});

test('I4: too late right before the post: nothing posted', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.latencyMs = (path) => (path === '/get_challenge' ? 3580 : 5);
  refused(await t.press('fan-speed', '3', 8 * SECOND), /à temps|Rien envoyé/);
  assert.equal(t.dev.posts.length, 0);
});

test('I4: already lit: a turn on posts nothing (never re-arms a timer)', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.power = 1;
  ok(await t.press('turn-on'));
  assert.equal(t.dev.posts.length, 0);
});

test('I4: no configuration yet: the turn off goes to the address kept in /data', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeFireplace({ timers: clock.timers });
  dev.state.power = 1;
  const store = memoryStore({ target: { host: HOST, port: 80, serial: SERIAL } });
  const t = await setup({ clock, dev, store, create: false, getConfigHangs: true, config: {} });
  refused(await t.press('turn-off'), /pas de clé/);
  assert.equal(t.app.stopGuard.target.host, HOST);
});

// --- Mutants of the r1 replay -----------------------------------------------------------------

test('I4: a turn on clicked while a turn off is on its way is refused (never lit after it)', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.power = 1;
  t.dev.latencyMs = (path) => (path === '/post' ? 300 : 5);
  const off = t.fire('turn-off');
  await t.advance(20);
  refused(await t.press('turn-on'), /extinction est en cours/);
  await off;
  await t.advance(10 * SECOND, 100);
  assert.equal(t.dev.state.power, 0);
});

test('I4: a setpoint above the ceiling is refused on arrival, before any read', async () => {
  const t = await setup({ config: ALLOW });
  const n = t.dev.requests.length;
  refused(await t.press('setpoint', 30, 100), /de 5 à 26/);
  assert.equal(t.dev.requests.length, n);
});

test('I4: a test button that reads lifts a refused turn off', async () => {
  const t = await setup();
  t.dev.state.power = 1;
  t.dev.ignore.add('power');
  await t.press('turn-off');
  t.dev.ignore.clear();
  t.app.stopGuard.refused = true;
  t.app.refusedBy.add(SERIAL);
  t.app.lastAttemptAt = -Infinity;
  t.app.clearTimer();
  const ack = t.gladys.fake.action('test_connection');
  await t.advance(5 * SECOND, 50);
  await ack;
  assert.equal(t.app.keyRefused, false);
  assert.equal(t.dev.state.power, 0);
});

test('I4: no read goes during a pause, even asked', async () => {
  const t = await setup();
  t.dev.status['/poll'] = 429;
  await t.advance(16 * SECOND, 100);
  delete t.dev.status['/poll'];
  const n = t.dev.requests.length;
  await t.until(t.app.tick());
  assert.equal(t.dev.requests.length, n);
});

test('I4: a turn off date in the future counts as now', () => {
  const m = normalizeMemory({ stop: { host: HOST, port: 80, since: NOW + 3600_000 } }, NOW);
  assert.equal(m.stops[0].since, NOW);
});

test('B1: ten 403s on a command, the key accepted before: never "key refused"', async () => {
  const t = await setup({ config: ALLOW });
  ok(await t.press('fan-speed', '3'));
  t.dev.force403 = 10;
  refused(await t.press('fan-speed', '2'), /403 à chaque défi/);
  assert.equal(t.app.keyRefused, false);
  ok(await t.press('fan-speed', '2'));
});

test('B4: a FIFO holding JSON is still never read', async (t) => {
  const { openSync, writeSync, closeSync, constants } = await import('node:fs');
  const dir = await mkdtemp(join(tmpdir(), 'ifr-fifo2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  execFileSync('mkfifo', [path]);
  const fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
  try {
    writeSync(fd, '{"lastAttemptAt":1}');
    assert.deepEqual(await fileStore(path).load(), { unreadable: true });
  } finally {
    closeSync(fd);
  }
});
