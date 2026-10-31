// -----------------------------------------------------------------------------
// Review r4: a post accepted is credited only to the serial read on its own
// line (never to the turn off that sent it), so the turn off of the right
// fireplace is never held on an owner merely deduced; saving the key or a
// test that succeeds forgets the owners deduced; beyond 4 fireplaces, the
// turn off of a fireplace read lit or of the key's fireplace is never let
// go (the new click is refused instead, said in the status); ten 403s and a
// read without serial are never a refused key.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOW, CFG, SECOND, ok, refused, setup } from './helpers.js';
import {
  API_KEY,
  HOST,
  NOW,
  OTHER_SERIAL,
  SERIAL,
  fakeFireplace,
} from './fixtures/fakeFireplace.js';
import { memoryStore, normalizeMemory } from '../src/store.js';
import { LIMITS } from '../src/constants.js';
import { testClock } from './kit/clock.mjs';

const OTHER_KEY = '99995bdb2d97b3dc7cee8a8b05dd0000';
const TARGET = { host: HOST, port: 80 };
const serialOf = (c) => c.repeat(32);
const deviceOf = (serial) => `ext:test-integration:intellifire:${serial}`;

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

async function pressOn(t, serial, role, value = 1, wait = 8 * SECOND) {
  const id = deviceOf(serial);
  const ack = t.gladys.fake.setValue({ external_id: id }, { external_id: `${id}:${role}` }, value);
  await t.advance(wait, 50);
  return ack;
}

// --- B1: a post accepted is credited to the serial read on its line only ----------------

test("B1 (16c): a turn off of B accepted by A after a restart is credited to A; A's own turn off leaves", async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeFireplace({ timers: clock.timers });
  dev.state.power = 1;
  // /data: B's turn off (never left), nothing said of the serial at the address.
  const store = memoryStore({
    lastAttemptAt: NOW - 1000,
    stops: [{ host: HOST, port: 80, serial: OTHER_SERIAL, since: NOW - 60_000, written: false }],
  });
  const t = await setup({ clock, dev, store, boot: true, create: false });
  await t.advance(3 * SECOND, 100);
  assert.equal(dev.state.power, 0, "B's turn off reached the address: A accepted it");
  assert.deepEqual([...t.app.keyWorked], [SERIAL], 'credited to A, read back on that line');
  assert.ok(t.app.guardFor(OTHER_SERIAL), "B's turn off is still kept (A was read back)");
  // A relit by hand: its own turn off leaves.
  dev.state.power = 1;
  await t.advance(16 * SECOND, 100);
  const ack = await t.press('turn-off');
  assert.doesNotMatch(String(ack.error ?? ''), /autre foyer/);
  assert.equal(dev.state.power, 0, "A's own turn off left");
});

test('B1: a check whose read fails, a post accepted by another fireplace: credited to nobody', async () => {
  const t = await setup();
  becomeOther(t.dev);
  await t.advance(16 * SECOND, 100);
  assert.equal(t.app.fp.serial, OTHER_SERIAL, 'B read last');
  t.dev.down = 'unreachable';
  refused(await pressOn(t, OTHER_SERIAL, 'turn-off'), /rien envoyé/);
  // A answers at the address now, lit; its reads fail, its posts go through.
  t.dev.down = false;
  becomeRight(t.dev);
  t.dev.status['/poll'] = 500;
  await t.advance(20 * SECOND, 100);
  assert.equal(t.dev.state.power, 0, "B's turn off was accepted by A");
  assert.equal(t.app.keyWorked.size, 0, 'no serial read on that line: credited to nobody');
  delete t.dev.status['/poll'];
  t.dev.state.power = 1;
  await t.advance(16 * SECOND, 100);
  const ack = await t.press('turn-off');
  assert.doesNotMatch(String(ack.error ?? ''), /autre foyer/);
  assert.equal(t.dev.state.power, 0, "A's own turn off left");
});

test('B1: two different serials read on the line of a post: credited to nobody', async () => {
  const t = await setup();
  assert.equal(t.app.creditKey({ serial: SERIAL }, { serial: OTHER_SERIAL }), undefined);
  assert.equal(t.app.creditKey(undefined, { power: true }), undefined);
  assert.equal(t.app.keyWorked.size, 0);
  assert.equal(t.app.creditKey({ serial: SERIAL }, undefined), SERIAL);
  assert.deepEqual([...t.app.keyWorked], [SERIAL]);
});

test('B1: a command read back on another serial: its post is credited to nobody', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.onPost = (command) => {
    // The module at the address changes between the post and the read back.
    if (command === 'fan_speed') becomeOther(t.dev);
  };
  refused(await t.press('fan-speed', '3'), /sans confirmation \(serial\)/);
  assert.equal(t.app.keyWorked.size, 0);
});

test('B1: saving the key (the same one too) or a test that succeeds forgets the owners deduced', async () => {
  const t = await setup({ config: ALLOW });
  t.app.keyWorked.add(OTHER_SERIAL);
  t.app.keyFor = OTHER_SERIAL;
  await t.until(t.gladys.fake.configUpdated(ALLOW));
  assert.equal(t.app.keyWorked.size, 0, 'the same key saved: the owners deduced are forgotten');
  assert.equal(t.app.keyFor, OTHER_SERIAL, 'the word of the cloud stays for the same key');
  t.app.keyWorked.add(OTHER_SERIAL);
  // A test answered by the last read (less than an interval ago).
  await t.until(t.gladys.fake.action('test_connection'));
  assert.equal(t.app.keyWorked.size, 0, 'a test answered by the last good read forgets them');
  // A test that reads now (the last read failed, the next one is overdue).
  t.dev.down = 'unreachable';
  await t.advance(31 * SECOND, 100);
  assert.equal(t.app.fp.online, false);
  t.dev.down = false;
  t.app.keyWorked.add(OTHER_SERIAL);
  await t.until(t.gladys.fake.action('test_connection'));
  assert.equal(t.app.fp.online, true);
  assert.equal(t.app.keyWorked.size, 0, 'a test read that succeeds forgets them');
  await t.until(t.gladys.fake.configUpdated({ ...ALLOW, api_key: OTHER_KEY }));
  assert.equal(t.app.keyFor, undefined, 'another key: the serial it was retrieved for too');
});

// --- I1: the bound never lets go a turn off still needed ------------------------------------

test("I1 (16a): beyond 4 fireplaces, the turn off of A (lit, the key's) is never let go; the new click is refused", async () => {
  const t = await setup();
  t.dev.state.power = 1;
  t.dev.ignore.add('power');
  refused(await t.press('turn-off'), /montre encore la flamme/);
  assert.ok(t.app.keyWorked.has(SERIAL), 'A accepted the key (read back on the line)');
  const others = ['b', 'c', 'd', 'e'].map(serialOf);
  const acks = [];
  for (const serial of others) {
    t.dev.serial = serial;
    t.dev.apiKey = '77'.repeat(16);
    await t.advance(16 * SECOND, 100);
    assert.equal(t.app.fp.serial, serial);
    acks.push(await pressOn(t, serial, 'turn-off', 1, 6 * SECOND));
  }
  assert.match(
    String(acks[3].error),
    /pas gardée, et rien n'a pu être envoyé maintenant : 4 autres foyers/,
  );
  assert.equal(t.app.stopGuards.length, LIMITS.stopGuards);
  assert.ok(t.app.guardFor(SERIAL), "A's turn off is never let go");
  assert.equal(t.app.guardFor(others[3]), undefined, 'the new one is not kept');
  assert.match(t.status().text, /Une extinction du foyer EEEE n'a pas été gardée/);
  // A back at the address, lit: turned off.
  t.dev.ignore.clear();
  becomeRight(t.dev);
  await t.advance(40 * SECOND, 200);
  assert.equal(t.dev.state.power, 0);
});

test('I1: the turn off let go is first one that cannot leave, then one read off, then one never read', async () => {
  const t = await setup();
  const guard = (c, lit, extra = {}) =>
    Object.assign(t.app.newStopGuard(TARGET, serialOf(c)), { lit }, extra);
  t.app.stopGuards = [
    guard('c', undefined),
    guard('b', false),
    guard('d', false, { refused: true }),
  ];
  t.app.addGuard(guard('x', true));
  assert.equal(t.app.addGuard(guard('e', undefined)).serial, serialOf('e'));
  assert.equal(t.app.guardFor(serialOf('d')), undefined, 'the one that cannot leave first');
  assert.match(t.status().text, /L'extinction gardée pour le foyer DDDD a été levée/);
  t.app.addGuard(guard('f', undefined));
  assert.equal(t.app.guardFor(serialOf('b')), undefined, 'then the one read off');
  t.app.addGuard(guard('g', undefined));
  assert.equal(t.app.guardFor(serialOf('c')), undefined, 'then the oldest never read');
  assert.ok(t.app.guardFor(serialOf('x')), 'one read lit: never');
});

test("I1: the key's fireplace, one read lit and the one read at the address are never let go", async () => {
  const t = await setup();
  const guard = (serial, lit) => Object.assign(t.app.newStopGuard(TARGET, serial), { lit });
  t.app.keyWorked.add(serialOf('a'));
  t.app.stopGuards = [
    guard(serialOf('a'), false),
    guard(serialOf('b'), true),
    guard(SERIAL, false),
    guard(serialOf('c'), true),
  ];
  assert.equal(t.app.fp.serial, SERIAL);
  assert.equal(t.app.addGuard(guard(serialOf('d'), undefined)), undefined, 'none may go: not kept');
  assert.equal(t.app.stopGuards.length, LIMITS.stopGuards);
  // The same through a click: refused, nothing posted, said in the ack and the status.
  const posts = t.dev.requests.filter((r) => r.method === 'POST').length;
  refused(await pressOn(t, serialOf('d'), 'turn-off'), /pas gardée/);
  assert.equal(t.dev.requests.filter((r) => r.method === 'POST').length, posts);
  assert.match(t.status().text, /Une extinction du foyer DDDD n'a pas été gardée/);
  // Room again (one let go when seen off): a new click on it is kept, the note goes.
  t.app.dropGuard(t.app.guardFor(serialOf('c')), 'seen off');
  refused(await pressOn(t, serialOf('d'), 'turn-off'), /autre foyer/);
  assert.ok(t.app.guardFor(serialOf('d')));
  assert.doesNotMatch(t.status().text, /n'a pas été gardée/);
});

test('I1: a note of the bound goes when the configuration is saved', async () => {
  const t = await setup();
  const guard = (c, lit) => Object.assign(t.app.newStopGuard(TARGET, serialOf(c)), { lit });
  t.app.stopGuards = ['a', 'b', 'c', 'd'].map((c) => guard(c, false));
  t.app.addGuard(guard('e', undefined));
  await t.advance(SECOND);
  assert.match(t.status().text, /foyer AAAA a été levée/);
  await t.until(t.gladys.fake.configUpdated(CFG));
  assert.doesNotMatch(t.status().text, /a été levée/);
});

test('I1: the flame of a turn off kept follows the reads of its fireplace', async () => {
  const t = await setup({ config: { address: HOST, poll_interval: 600 } });
  refused(await t.press('turn-off'), /gardée/);
  assert.equal(t.app.guardFor(SERIAL).lit, false, 'read off at the click');
  t.dev.state.power = 1;
  await t.advance(15 * SECOND, 100);
  assert.equal(t.app.guardFor(SERIAL).lit, true, 'its check read it lit');
  t.dev.state.power = 0;
  await t.advance(15 * SECOND, 100);
  assert.ok(t.app.guardFor(SERIAL), 'never left: one read off is not enough');
  assert.equal(t.app.guardFor(SERIAL).lit, false, 'read off since');
});

test('B1: the timer posted again is credited to nobody (no read on its line)', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.ignore.add('time_remaining');
  await t.press('turn-on', 1, 3 * SECOND);
  assert.ok(t.app.startCheck, 'the session of the turn on is watched');
  await t.until(t.gladys.fake.action('test_connection'));
  assert.equal(t.app.keyWorked.size, 0);
  // When the timer is posted again, another fireplace with the same key answers at the address.
  t.dev.onPost = (command) => {
    if (command === 'time_remaining') t.dev.serial = OTHER_SERIAL;
  };
  await t.advance(20 * SECOND, 100);
  assert.ok(t.dev.serial === OTHER_SERIAL, 'the timer was posted again');
  assert.equal(t.app.keyWorked.has(SERIAL), false, 'never credited to the session');
});

test('I1: the flame last read is kept with each turn off in /data', async () => {
  const t = await setup();
  t.dev.state.power = 1;
  t.dev.ignore.add('power');
  await t.press('turn-off');
  assert.equal(t.app.guardFor(SERIAL).lit, true);
  assert.equal(t.store.data.stops[0].lit, true);
  const m = normalizeMemory(
    { stops: [{ host: HOST, port: 80, serial: SERIAL, since: NOW, lit: 'yes' }] },
    NOW,
  );
  assert.equal(m.stops[0].lit, null, 'not a boolean: never read');
  const clock = testClock({ start: NOW });
  const dev = fakeFireplace({ timers: clock.timers });
  dev.down = 'unreachable';
  const store = memoryStore({
    stops: [{ host: HOST, port: 80, serial: OTHER_SERIAL, since: NOW, written: true, lit: true }],
  });
  const u = await setup({ clock, dev, store, boot: true, create: false, config: CFG });
  assert.equal(u.app.guardFor(OTHER_SERIAL).lit, true, 'restored');
});

// --- I2: ten 403s and a read without serial are never a refused key ---------------------------

test('I2: ten 403s, then a read without serial: tried again, never "key refused"', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeFireplace({ timers: clock.timers });
  dev.serial = '';
  dev.state.power = 1;
  const t = await setup({
    clock,
    dev,
    create: false,
    config: { ...CFG, api_key: 'ee'.repeat(16) },
  });
  const ack = await t.press('turn-off', 1, 6 * SECOND);
  refused(ack, /HTTP 403/);
  assert.doesNotMatch(String(ack.error), /refuse la clé/);
  assert.equal(t.app.guardFor(SERIAL).refused, false);
  assert.equal(t.app.refusedBy.size, 0);
  const guard = t.app.newStopGuard(TARGET, SERIAL);
  const holder = { signal: new AbortController().signal };
  assert.equal(await t.until(t.app.judgeForbidden(guard, TARGET, holder), 5 * SECOND), 'retry');
  ok({ success: guard.refused === false });
});

test('I1: not kept for the bound, the turn off of the fireplace at the address is still tried once', async () => {
  const t = await setup();
  const guard = (c) => Object.assign(t.app.newStopGuard(TARGET, serialOf(c)), { lit: true });
  t.app.stopGuards = ['a', 'b', 'c', 'd'].map(guard);
  t.dev.state.power = 1;
  t.dev.ignore.add('power');
  refused(await t.press('turn-off'), /envoyée une fois, pas vue appliquée, et pas gardée/);
  assert.equal(t.dev.posts.filter((p) => p.command === 'power' && p.value === 0).length, 1);
  assert.equal(t.app.guardFor(SERIAL), undefined, 'not kept');
  assert.equal(t.app.stopGuards.length, LIMITS.stopGuards);
  assert.match(t.status().text, /Une extinction du foyer 1111 n'a pas été gardée/);
  t.dev.ignore.clear();
  ok(await t.press('turn-off'));
  assert.equal(t.dev.state.power, 0, 'tried again on a new click: applied');
  assert.doesNotMatch(t.status().text, /1111 n'a pas été gardée/, 'applied: the note goes');
});
