// -----------------------------------------------------------------------------
// The parsers and the signature, against the fixtures of intellifire4py 4.5.6
// (tests/fixtures, MIT, anonymized captures of a real module) and a vector
// computed with its formula (`_construct_payload`) in Python.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  blockingErrors,
  int,
  parseChallenge,
  parsePoll,
  setpointOf,
  signedForm,
} from '../src/intellifire/model.js';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/reference/${name}`, import.meta.url), 'utf8');

test('the poll of the reference fixture', () => {
  const data = parsePoll(fixture('local_poll.json'));
  assert.equal(data.serial, 'bd0e054b5d6df7afbc8f9b28c9011111');
  assert.equal(data.power, false);
  assert.equal(data.height, 4);
  assert.equal(data.fanSpeed, 1);
  assert.equal(data.light, 3);
  assert.equal(data.temperature, 17);
  assert.equal(data.hasThermostat, true);
  assert.deepEqual(data.errors, []);
  // 17 hundredths of °C (intellifire4py: thermostat_setpoint_c == 0.17): not a setpoint.
  assert.equal(data.setpoint, undefined);
  assert.equal(data.firmware, '1.3.0');
});

test('errors 6 and 642: the offline module refuses a start, the fan delay does not', () => {
  const data = parsePoll(fixture('error_6_642.json'));
  assert.deepEqual(data.errors, [6, 642]);
  assert.deepEqual(blockingErrors(data.errors), [642]);
  assert.deepEqual(blockingErrors([64, 9999]), [9999], 'an unknown code blocks, in doubt');
});

test('strict numbers: empty, null, true, decimals and out of range are unknown, never 0', () => {
  for (const value of ['', ' ', null, true, '1.5', 1.5, '0x1', [], {}]) {
    assert.equal(int(value, 0, 4), undefined, JSON.stringify(value));
  }
  assert.equal(int('3', 0, 4), 3);
  assert.equal(int(5, 0, 4), undefined);
  const data = parsePoll(JSON.stringify({ serial: 'x', power: '', height: null, temperature: '' }));
  assert.equal(data.serial, undefined);
  assert.equal(data.power, undefined);
  assert.equal(data.height, undefined);
  assert.equal(data.temperature, undefined);
  assert.equal(parsePoll('[1]'), undefined);
  assert.equal(parsePoll('nope'), undefined);
  assert.equal(parsePoll('{"__proto__":{"power":1}}').power, undefined);
});

test('the setpoint in hundredths of °C', () => {
  assert.deepEqual(setpointOf(2100), { on: true, celsius: 21 });
  assert.deepEqual(setpointOf('2150'), { on: true, celsius: 21.5 });
  assert.deepEqual(setpointOf(0), { on: false });
  assert.equal(setpointOf(17), undefined);
  assert.equal(setpointOf(3701), undefined);
});

test('a challenge: even hex only', () => {
  assert.equal(parseChallenge(' 0A1B2C3D\n'), '0a1b2c3d');
  assert.equal(parseChallenge('0A1B2C3'), undefined);
  assert.equal(parseChallenge('<html>'), undefined);
  assert.equal(parseChallenge(''), undefined);
});

test('the signature of intellifire4py', () => {
  const form = signedForm(
    { apiKey: '12345bdb2d97b3dc7cee8a8b05dd5ffa', userId: 'u1' },
    '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
    'power',
    0,
  );
  assert.equal(
    form,
    'command=power&value=0&user=u1&response=0b7d0d75abf845b50ef78fba2045305f3c862db25a9dca83e8485da31dcb97ef',
  );
});
