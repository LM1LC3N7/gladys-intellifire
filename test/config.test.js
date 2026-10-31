import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress } from '../src/config.js';

test('addresses: IPv4, host names, a port; never broadcast, multicast, any, an @', () => {
  assert.deepEqual(parseAddress('192.168.1.69'), { host: '192.168.1.69', port: 80 });
  assert.deepEqual(parseAddress('http://Fire.local:8080/poll'), { host: 'fire.local', port: 8080 });
  for (const bad of [
    '255.255.255.255',
    '0.0.0.0',
    '224.0.0.1',
    'a b',
    'x\r\ny',
    'u:p@h',
    '1.2.3',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  assert.equal(normalizeConfig({ address: 'u:secret@h' }).invalidAddress, undefined);
  assert.equal(normalizeConfig({ address: 'u:secret@h' }).addressWithAt, true);
});

test('key and user id: both, hex key, safe user id; the option strictly true', () => {
  const ok = normalizeConfig({ api_key: 'ABCDEF0123456789abcdef0123456789', user_id: 'u-1' });
  assert.deepEqual(ok.credentials, { apiKey: 'abcdef0123456789abcdef0123456789', userId: 'u-1' });
  assert.equal(normalizeConfig({ api_key: 'zz', user_id: 'u' }).badCredentials, 'invalid');
  assert.equal(normalizeConfig({ api_key: 'ab'.repeat(16) }).badCredentials, 'incomplete');
  assert.equal(
    normalizeConfig({ api_key: 'ab'.repeat(16), user_id: 'a&b=c' }).credentials,
    undefined,
  );
  assert.equal(normalizeConfig({ allow_control: 'yes' }).allowControl, false);
  assert.equal(normalizeConfig({ allow_control: 'true' }).allowControl, true);
  assert.equal(normalizeConfig({ password: 'p' }).badAccount, 'incomplete');
});

test('bounds: setpoint ceiling 5..37 rounded down, timer 10..180, interval 10..600', () => {
  assert.equal(normalizeConfig({ max_temperature: 99 }).maxTemperature, 37);
  assert.equal(normalizeConfig({ max_temperature: '24.9' }).maxTemperature, 24);
  assert.equal(normalizeConfig({ max_temperature: '' }).maxTemperature, 26);
  assert.equal(normalizeConfig({ session_duration: 999 }).sessionMinutes, 180);
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 10);
});
