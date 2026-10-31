// -----------------------------------------------------------------------------
// Review r3: one turn off kept per fireplace (serial), never let go by the
// turn off of another device; ten 403s prove a refused key only for the
// fireplace the key belongs to; a turn off never signed with a key known to
// be another fireplace's; nothing requested nor armed after shutdown(), a
// command clicked then included; and the guards the mutants found untested.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import { memoryStore, normalizeMemory } from '../src/store.js';
import { CLOUD, LIMITS } from '../src/constants.js';
import { ERROR_KINDS } from '../src/intellifire/http.js';
import { testClock } from './kit/clock.mjs';

const OTHER_KEY = '99995bdb2d97b3dc7cee8a8b05dd0000';
const deviceOf = (serial) => `ext:test-integration:intellifire:${serial}`;
const posts = (dev) => dev.requests.filter((r) => r.method === 'POST').length;
const polls = (dev) => dev.requests.filter((r) => r.path === '/poll').length;
const powerOffs = (dev) => dev.posts.filter((p) => p.command === 'power' && p.value === 0);

/** The module at the address becomes another IntelliFire (serial and key), lit. */
function becomeOther(dev, power = 1) {
  dev.serial = OTHER_SERIAL;
  dev.apiKey = OTHER_KEY;
  dev.state.power = power;
}

function becomeRight(dev, power = 1) {
  dev.serial = SERIAL;
  dev.apiKey = API_KEY;
  dev.state.power = power;
}

/** A click on a feature of the device of `serial` (the fake Gladys, the SDK wiring). */
function fireOn(t, serial, role, value = 1) {
  const id = deviceOf(serial);
  const device = t.gladys.fake.devices.find((d) => d.external_id === id) ?? { external_id: id };
  return t.gladys.fake.setValue(device, { external_id: `${id}:${role}` }, value);
}

async function pressOn(t, serial, role, value = 1, wait = 8 * SECOND) {
  const ack = fireOn(t, serial, role, value);
  await t.advance(wait, 50);
  return ack;
}

/** B read at the address and its device created from Discovery (both show a flame). */
async function otherReadAndCreated(t) {
  await t.advance(16 * SECOND, 100);
  assert.equal(t.app.fp.serial, OTHER_SERIAL, 'B read at the address');
  const b = t.gladys.fake.discoveredDevices.find((d) => d.external_id === deviceOf(OTHER_SERIAL));
  assert.ok(b, "B's device in Discovery");
  await t.until(t.gladys.fake.deviceCreated(b));
}

// --- B1: one turn off per fireplace ----------------------------------------------------

test('B1 (13e): a click on B never lets the turn off of A go; B refusing the key is B alone', async () => {
  const t = await setup({ config: ALLOW });
  becomeOther(t.dev);
  await otherReadAndCreated(t);
  refused(await t.press('turn-off'), /autre foyer/);
  assert.equal(posts(t.dev), 0, 'nothing posted to B for A');
  // The owner of the key is unknown in this run: B's turn off goes to B, which refuses it.
  refused(await pressOn(t, OTHER_SERIAL, 'turn-off'), /refuse la clé/);
  const a = t.app.guardFor(SERIAL);
  assert.ok(a, "A's turn off is still kept");
  assert.equal(a.serial, SERIAL);
  assert.equal(a.refused, false);
  assert.equal(t.app.guardFor(OTHER_SERIAL).refused, true);
  assert.deepEqual([...t.app.refusedBy], [OTHER_SERIAL], 'refused by B only');
  assert.deepEqual(
    t.store.data.stops.map((s) => s.serial),
    [SERIAL, OTHER_SERIAL],
    'both in /data',
  );
  assert.ok(
    !t.lines.some((l) => /let go/.test(l)),
    t.lines.filter((l) => /let go/.test(l)),
  );
  // A back at the address, lit: turned off.
  becomeRight(t.dev);
  await t.advance(40 * SECOND, 200);
  assert.equal(t.dev.state.power, 0, 'A turned off');
  assert.equal(t.app.guardFor(SERIAL), undefined, "A's turn off let go once applied");
  assert.ok(t.app.guardFor(OTHER_SERIAL), "B's turn off still kept (never by A's)");
  // The status names B for its note (it is not the fireplace read).
  assert.match(t.status().text, /Foyer 2222 : Une extinction attend : le foyer a refusé la clé/);
  // A's commands were never refused for B's refusal.
  ok(await t.press('fan-speed', '3'));
});

test("B1: the key known to be A's (A accepted it): B's turn off posts nothing to B", async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.power = 1;
  ok(await t.press('fan-speed', '3'));
  becomeOther(t.dev);
  await otherReadAndCreated(t);
  const before = posts(t.dev);
  refused(await pressOn(t, OTHER_SERIAL, 'fan-speed', '2'), /celle d'un autre foyer/);
  refused(await pressOn(t, OTHER_SERIAL, 'turn-off'), /celle d'un autre foyer/);
  await t.advance(MINUTE, 200);
  assert.equal(posts(t.dev), before, 'never signed with the key of A');
  assert.equal(t.app.refusedBy.size, 0, 'never a refused key');
  const b = t.app.guardFor(OTHER_SERIAL);
  assert.equal(b.refused, false);
  assert.match(t.status().text, /la clé configurée est celle d'un autre foyer/);
  // A's own turn off, while B is there: kept; it goes once A is back.
  refused(await t.press('turn-off'), /autre foyer/);
  becomeRight(t.dev);
  await t.advance(40 * SECOND, 200);
  assert.equal(t.dev.state.power, 0);
  assert.ok(t.app.guardFor(OTHER_SERIAL), "B's turn off never let go by A's");
});

function fakeCloud(serial = SERIAL, apikey = API_KEY) {
  return async (req) => {
    if (req.path === CLOUD.login) {
      return {
        status: 204,
        headers: {
          'set-cookie': [
            `user=${USER_ID}; Path=/`,
            'auth_cookie=abc123; HttpOnly',
            'web_client_id=w1',
          ],
        },
        body: '',
      };
    }
    if (req.path === CLOUD.locations) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ locations: [{ location_id: '11118333339267293392' }] }),
      };
    }
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        location_name: 'home',
        fireplaces: [{ serial: serial.toUpperCase(), brand: 'H&G', apikey, power: '0' }],
      }),
    };
  };
}

test('B1: a key retrieved for A: B never "refuses" it; B\'s own key saved, B\'s turn off leaves', async () => {
  const t = await setup({
    config: { ...ALLOW, username: 'me@example.com', password: 'pw' },
    cloud: fakeCloud(),
  });
  assert.match(JSON.stringify(await t.gladys.fake.action('fetch_key')), /enregistrés/);
  assert.equal(t.app.keyFor, SERIAL, 'the key is the one of A');
  becomeOther(t.dev);
  await otherReadAndCreated(t);
  refused(await pressOn(t, OTHER_SERIAL, 'turn-off'), /celle d'un autre foyer/);
  assert.equal(posts(t.dev), 0);
  assert.equal(t.app.refusedBy.size, 0);
  // B's key typed by hand: nothing known of its owner any more; B's turn off leaves to B.
  await t.until(
    t.gladys.fake.configUpdated({ ...t.gladys.fake.config, api_key: OTHER_KEY, user_id: USER_ID }),
  );
  assert.equal(t.app.keyFor, undefined);
  await t.advance(5 * SECOND, 100);
  assert.equal(t.dev.state.power, 0, 'B turned off with its own key');
  assert.equal(t.app.guardFor(OTHER_SERIAL), undefined);
});

test('B1: ten 403s prove a refused key only for the fireplace the key belongs to', async () => {
  const t = await setup();
  const err = { kind: ERROR_KINDS.AUTH };
  assert.equal(t.app.refusalProvable(SERIAL), true, 'owner unknown, never accepted');
  t.app.keyFor = OTHER_SERIAL;
  assert.equal(t.app.refusalProvable(SERIAL), false, 'retrieved for another one');
  assert.equal(t.app.keyRefusalProven(err, SERIAL), false);
  assert.equal(t.app.refusalProvable(OTHER_SERIAL), true, 'its owner may refuse it');
  t.app.keyFor = undefined;
  t.app.keyWorked.add(OTHER_SERIAL);
  assert.equal(t.app.refusalProvable(SERIAL), false, 'accepted by another one');
  assert.equal(t.app.keyRefusalProven(err, SERIAL), false);
  assert.equal(t.app.refusalProvable(OTHER_SERIAL), false, 'accepted by it');
  assert.equal(t.app.refusalProvable(undefined), false);
});

test('B1: the turn offs of two fireplaces come back from /data after a restart', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeFireplace({ timers: clock.timers });
  dev.state.power = 1;
  const store = memoryStore({
    target: { host: HOST, port: 80, serial: SERIAL },
    lastAttemptAt: NOW - 1000,
    stops: [
      { host: HOST, port: 80, serial: OTHER_SERIAL, since: NOW - 60_000, written: false },
      { host: HOST, port: 80, serial: SERIAL, since: NOW - 30_000, written: false },
    ],
  });
  const t = await setup({ clock, dev, store, boot: true, create: false });
  await t.advance(3 * SECOND, 100);
  assert.equal(dev.state.power, 0, "A's turn off left");
  assert.equal(powerOffs(dev).length, 1, 'only to A (B is not at the address)');
  assert.deepEqual(
    store.data.stops.map((s) => s.serial),
    [OTHER_SERIAL],
    "B's kept in /data",
  );
});

test("B1: an older /data's single turn off is one of the list; the list is bounded, one per serial", () => {
  const one = normalizeMemory({ stop: { host: HOST, port: 80, serial: SERIAL, since: NOW } }, NOW);
  assert.deepEqual(
    one.stops.map((s) => s.serial),
    [SERIAL],
  );
  const serials = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => c.repeat(32));
  const many = normalizeMemory(
    {
      stops: [...serials, serials[0]].map((serial) => ({
        host: HOST,
        port: 80,
        serial,
        since: NOW,
      })),
    },
    NOW,
  );
  assert.equal(many.stops.length, LIMITS.stopGuards);
  assert.equal(new Set(many.stops.map((s) => s.serial)).size, LIMITS.stopGuards);
  assert.equal(many.stops.at(-1).serial, serials[0], 'the last one of a serial wins');
  const twice = normalizeMemory(
    {
      stops: [serials[0], serials[1], serials[0]].map((serial, i) => ({
        host: HOST,
        port: 80,
        serial,
        since: NOW - i,
      })),
    },
    NOW,
  );
  assert.deepEqual(
    twice.stops.map((x) => [x.serial, x.since]),
    [
      [serials[1], NOW - 1],
      [serials[0], NOW - 2],
    ],
    'one per serial, the last one',
  );
});

test('B1: beyond the bound, the oldest turn off of another fireplace than the one read goes', async () => {
  const t = await setup();
  const target = { host: HOST, port: 80 };
  const serials = ['a', SERIAL, 'c', 'd', 'e'].map((s) => (s.length === 1 ? s.repeat(32) : s));
  for (const serial of serials) t.app.addGuard(t.app.newStopGuard(target, serial));
  assert.equal(t.app.stopGuards.length, LIMITS.stopGuards);
  assert.deepEqual(
    t.app.stopGuards.map((g) => g.serial),
    serials.slice(1),
  );
  // The one read at the address is never the one let go.
  t.app.addGuard(t.app.newStopGuard(target, 'f'.repeat(32)));
  assert.ok(t.app.guardFor(SERIAL), 'the fireplace read at the address stays');
  assert.equal(t.app.stopGuards.length, LIMITS.stopGuards);
});

test('B1: no serial read now and the last read shows another fireplace: nothing posted blind', async () => {
  const t = await setup();
  becomeOther(t.dev, 0);
  await t.advance(16 * SECOND, 100);
  refused(await t.press('turn-off'), /autre foyer/);
  t.dev.status['/poll'] = 500;
  await t.advance(MINUTE, 200);
  assert.equal(posts(t.dev), 0, 'never posted to the address while B was the last read');
  delete t.dev.status['/poll'];
  becomeRight(t.dev);
  await t.advance(40 * SECOND, 200);
  assert.equal(t.dev.state.power, 0);
});

test('B1: a turn off that never left: its own check read is counted once (two reads needed)', async () => {
  const t = await setup({ config: { address: HOST, poll_interval: 600 } });
  t.dev.state.power = 1;
  refused(await t.press('turn-off'), /gardée/);
  t.dev.state.power = 0;
  const n = polls(t.dev);
  for (let i = 0; i < 300 && polls(t.dev) === n; i += 1) await t.advance(100, 100);
  await t.advance(200, 100);
  assert.equal(polls(t.dev), n + 1);
  assert.ok(t.app.guardFor(SERIAL), 'one read is not enough');
  await t.advance(20 * SECOND, 100);
  assert.equal(t.app.guardFor(SERIAL), undefined, 'two reads in a row');
});

// --- I1: the guards of r3 with no test -----------------------------------------------

test('I1: a turn off kept without serial (an older /data) takes the serial clicked', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeFireplace({ timers: clock.timers });
  becomeOther(dev, 0);
  // Nothing read yet in this run: the module does not answer at the start.
  dev.down = 'unreachable';
  const store = memoryStore({
    target: { host: HOST, port: 80, serial: OTHER_SERIAL },
    lastAttemptAt: NOW - 1000,
    stop: { host: HOST, port: 80, since: NOW - 60_000, written: false },
  });
  const t = await setup({
    clock,
    dev,
    store,
    boot: true,
    create: false,
    config: { address: HOST },
  });
  assert.equal(t.app.stopGuards.length, 1);
  assert.equal(t.app.stopGuards[0].serial, undefined, 'kept without serial');
  // Clicked on A before any read of this run (B was the last one read, in /data).
  refused(await t.press('turn-off'), /autre foyer/);
  assert.equal(t.app.stopGuards.length, 1, 'the same turn off');
  assert.equal(t.app.stopGuards[0].serial, SERIAL, "it is A's");
  dev.down = false;
  await t.until(t.gladys.fake.configUpdated(CFG));
  await t.advance(MINUTE, 200);
  assert.equal(posts(dev), 0, 'nothing posted to B');
  becomeRight(dev);
  await t.advance(40 * SECOND, 200);
  assert.equal(dev.state.power, 0, 'A back, lit: turned off');
});

test('I1: the post of a setpoint leaves by 3.5 s after the click or not at all', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.power = 1;
  let challenges = 0;
  // The timer of the session answers at ~3.4 s; the challenge of the setpoint at ~3.56 s.
  t.dev.latencyMs = (path) => {
    if (path === '/post') return 3400;
    if (path === '/get_challenge') return (challenges += 1) === 1 ? 5 : 150;
    return 5;
  };
  const ack = t.fire('setpoint', 21);
  await t.advance(6 * SECOND, 1);
  refused(await ack, /à temps/);
  const setpoints = t.dev.requests.filter(
    (r) => r.method === 'POST' && /thermostat_setpoint/.test(r.body ?? ''),
  );
  assert.equal(setpoints.length, 0, 'no setpoint posted after 3.5 s');
  assert.equal(challenges, 2, 'the setpoint got as far as its challenge');
});

test('I1: getConfig() failing after shutdown() re-arms nothing', async () => {
  const t = await setup();
  let calls = 0;
  let fail;
  const getConfig = () => {
    calls += 1;
    if (calls === 1) {
      return new Promise((_, reject) => {
        fail = reject;
      });
    }
    return Promise.reject(new Error('Gladys unreachable'));
  };
  const connecting = t.app.onConnected(getConfig);
  await t.advance(100);
  await t.until(t.app.shutdown(), 5 * SECOND);
  fail(new Error('Gladys unreachable'));
  await t.until(connecting, 5 * SECOND);
  await t.advance(2 * MINUTE, 1000);
  assert.equal(calls, 1, 'never asked again');
  assert.equal(t.app.configTimer, undefined);
  assert.equal(t.clock.pending, 0, 'no timer');
});

test('I1: after shutdown(), a new address saved, a command, a turn off and every entry point: no request, no timer', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.power = 1;
  t.dev.ignore.add('power');
  refused(await t.press('turn-off'), /montre encore la flamme/);
  const guard = t.app.guardFor(SERIAL);
  assert.ok(guard);
  const session = {
    since: NOW,
    sentAt: t.clock.monotonic(),
    minutes: 60,
    serial: SERIAL,
    timerSeen: false,
    reposted: false,
    thermostat: false,
  };
  await t.until(t.app.shutdown(), 5 * SECOND);
  const n = t.dev.requests.length;
  // A new address saved: nothing started (no read, no publisher, no timer).
  await t.until(t.gladys.fake.configUpdated({ ...ALLOW, address: '192.168.1.70' }), 5 * SECOND);
  assert.equal(t.app.publisher.timer, undefined, 'the publisher stays stopped');
  // A command clicked: refused before any request.
  refused(await t.until(fireOn(t, SERIAL, 'fan-speed', '3'), 5 * SECOND), /s'arrête/);
  // A turn off clicked: nothing sent, kept in /data for the next start.
  refused(await t.until(fireOn(t, SERIAL, 'turn-off'), 5 * SECOND), /prochain démarrage/);
  assert.ok(t.store.data.stops.some((s) => s.serial === SERIAL));
  // Every way in, called directly.
  t.app.schedule(SECOND);
  assert.equal(t.app.fp.timer, undefined, 'schedule');
  t.app.tick();
  assert.equal(t.app.fp.running, undefined, 'tick');
  t.app.followUp();
  t.app.armSession(SERIAL, false, { minutes: 60, timerSeen: false });
  assert.equal(t.app.startCheck, undefined, 'armSession');
  t.app.startCheck = session;
  await t.until(t.app.repostTimer(session), 5 * SECOND);
  t.app.startCheck = undefined;
  t.app.armStopCheck(guard, 0);
  assert.equal(guard.timer, undefined, 'armStopCheck');
  await t.until(t.app.runCheck(guard), 5 * SECOND);
  const job = t.app.queueStop({ target: { host: HOST, port: 80 }, received: 0, serial: SERIAL });
  assert.equal(t.app.stops.length, 0, 'queueStop');
  assert.equal(t.app.stopWorker, undefined, 'no worker');
  refused({ success: false, error: (await job.done).error.message }, /prochain démarrage/);
  t.app.resumeStop();
  await t.advance(2 * MINUTE, 500);
  assert.equal(t.dev.requests.length, n, 'no request after shutdown');
  assert.equal(t.clock.pending, 0, 'no timer after shutdown');
});

test("B1: a turn on of A neither lets B's kept turn off go nor is made to post by it", async () => {
  const t = await setup({ config: ALLOW });
  t.dev.state.power = 1;
  ok(await t.press('fan-speed', '3'));
  becomeOther(t.dev);
  await otherReadAndCreated(t);
  refused(await pressOn(t, OTHER_SERIAL, 'turn-off'), /celle d'un autre foyer/);
  becomeRight(t.dev);
  await t.advance(16 * SECOND, 100);
  assert.equal(t.app.fp.serial, SERIAL);
  // A already lit: nothing posted (B's turn off kept is not A's).
  const before = posts(t.dev);
  ok(await t.press('turn-on'));
  assert.equal(posts(t.dev), before, 'already lit: nothing posted');
  // A off, then lit from Gladys: B's turn off is still kept.
  t.dev.state.power = 0;
  await t.advance(16 * SECOND, 100);
  ok(await t.press('turn-on'));
  assert.equal(t.dev.state.power, 1);
  assert.ok(t.app.guardFor(OTHER_SERIAL), "B's turn off never let go by A's turn on");
  // A's own turn off kept (not applied), then A lit from Gladys: A's goes, B's stays.
  t.dev.ignore.add('power');
  refused(await t.press('turn-off'), /montre encore la flamme/);
  assert.ok(t.app.guardFor(SERIAL));
  t.dev.ignore.clear();
  ok(await t.press('turn-on'));
  assert.equal(t.app.guardFor(SERIAL), undefined, "A's turn off let go by A's newer turn on");
  assert.ok(t.app.guardFor(OTHER_SERIAL), "B's turn off still kept");
});

test('M1: after shutdown(): no configuration applied, a turn off of another fireplace kept in /data, no status', async () => {
  const t = await setup({ config: ALLOW });
  await t.until(t.app.shutdown(), 5 * SECOND);
  const statuses = t.gladys.fake.connectionStatuses.length;
  // The same address with another key: not applied.
  await t.until(t.gladys.fake.configUpdated({ ...ALLOW, api_key: OTHER_KEY }), 5 * SECOND);
  assert.equal(t.app.config.credentials.apiKey, API_KEY, 'the configuration is not applied');
  // A start asked directly: nothing armed.
  await t.until(t.app.start(ALLOW, { fresh: true }), 5 * SECOND);
  assert.equal(t.app.publisher.timer, undefined);
  // The turn off of a fireplace with no turn off kept yet: kept in /data for the next start.
  refused(await t.until(fireOn(t, OTHER_SERIAL, 'turn-off'), 5 * SECOND), /prochain démarrage/);
  assert.deepEqual(
    t.store.data.stops.map((x) => x.serial),
    [OTHER_SERIAL],
  );
  // Its note would change the status: never sent after shutdown.
  await t.until(t.app.updateStatus(), 5 * SECOND);
  assert.equal(t.gladys.fake.connectionStatuses.length, statuses, 'no status after shutdown');
  // A worker of the turn offs that ends at once is never left behind as running.
  const job = {
    target: { host: HOST, port: 80 },
    received: 0,
    serial: SERIAL,
    state: { written: false },
    running: false,
  };
  job.done = new Promise((resolve) => {
    job.resolve = resolve;
  });
  t.app.stops.push(job);
  t.app.runStops();
  assert.equal(t.app.stopWorker, undefined, 'no worker left set');
  assert.equal(t.app.stops.length, 0);
  await t.advance(MINUTE, 500);
  assert.equal(t.clock.pending, 0);
});

test('B1: ten 403s from a fireplace whose key is known to be another one: "foreign", never a refusal', async () => {
  const t = await setup();
  t.app.keyWorked.add(SERIAL);
  becomeOther(t.dev);
  // A turn off kept without serial (an older /data) posted to the address, B answering there.
  const guard = t.app.newStopGuard({ host: HOST, port: 80 }, undefined);
  const holder = { signal: new AbortController().signal };
  const judged = await t.until(
    t.app.judgeForbidden(guard, { host: HOST, port: 80 }, holder),
    5 * SECOND,
  );
  assert.equal(judged, 'foreign');
  assert.equal(guard.refused, false);
  assert.equal(t.app.refusedBy.size, 0);
});
