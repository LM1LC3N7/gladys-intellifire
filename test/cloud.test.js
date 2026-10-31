// -----------------------------------------------------------------------------
// "Retrieve the key": one login per click, the key of the serial read, saved
// by setConfig; the password and the Wi-Fi password of the location never
// logged, kept nor shown. Answers shaped as intellifire4py's fixtures.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookiesOf, fetchCredentials } from '../src/intellifire/cloud.js';
import { CLOUD } from '../src/constants.js';
import { SECOND, setup } from './helpers.js';
import { API_KEY, HOST, SERIAL, USER_ID } from './fixtures/fakeFireplace.js';

const PASSWORD = 'Sup3r-secret pw';
const WIFI = 'wifi-pass-should-never-show';

function fakeCloud({ status = 204, serial = SERIAL } = {}) {
  const calls = [];
  const transport = async (req) => {
    calls.push(req);
    if (req.path === CLOUD.login) {
      return {
        status,
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
        body: JSON.stringify({
          locations: [{ location_id: '11118333339267293392', wifi_password: WIFI }],
        }),
      };
    }
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        location_name: 'home',
        fireplaces: [{ serial: serial.toUpperCase(), brand: 'H&G', apikey: API_KEY, power: '0' }],
      }),
    };
  };
  return { calls, transport };
}

test('the cookies: only user, auth_cookie and web_client_id, safe tokens', () => {
  assert.deepEqual(cookiesOf({ 'set-cookie': ['user=a1; Path=/', 'x=y', 'auth_cookie=b;'] }), {
    user: 'a1',
    auth_cookie: 'b',
  });
  assert.deepEqual(cookiesOf({ 'set-cookie': 'user=a\r\nb' }), {});
});

test('fetchCredentials: the form, the cookie sent, the list read', async () => {
  const cloud = fakeCloud();
  const found = await fetchCredentials(
    { user: 'me@example.com', password: PASSWORD },
    { transport: cloud.transport },
  );
  assert.equal(found.userId, USER_ID);
  assert.deepEqual(found.fireplaces, [{ serial: SERIAL, apiKey: API_KEY }]);
  assert.equal(
    cloud.calls[0].body,
    `username=me%40example.com&password=${encodeURIComponent(PASSWORD)}`,
  );
  assert.match(cloud.calls[1].headers.Cookie, /user=.*auth_cookie=abc123/);
  assert.match(cloud.calls[2].path, /location_id=11118333339267293392$/);
  assert.match(CLOUD.userAgent, /^gladys-intellifire\//);
  await assert.rejects(
    fetchCredentials(
      { user: 'a', password: 'b' },
      { transport: fakeCloud({ status: 401 }).transport },
    ),
    { kind: 'refused' },
  );
});

test('the button: saves the key of the serial read; secrets never logged nor shown', async () => {
  const cloud = fakeCloud();
  const t = await setup({
    config: { address: HOST, username: 'me@example.com', password: PASSWORD },
    cloud: cloud.transport,
  });
  const ack = await t.gladys.fake.action('fetch_key');
  assert.match(JSON.stringify(ack), /enregistrés/);
  assert.equal(t.gladys.fake.config.api_key, API_KEY);
  assert.equal(t.gladys.fake.config.user_id, USER_ID);
  assert.ok(t.app.config.credentials, 'applied at once');
  const again = await t.gladys.fake.action('fetch_key');
  assert.match(JSON.stringify(again), /Un essai par clic/);
  assert.equal(cloud.calls.filter((c) => c.path === CLOUD.login).length, 1);
  await t.advance(11 * SECOND);
  const everything = JSON.stringify([
    t.lines,
    t.gladys.fake.connectionStatusHistory ?? t.gladys.fake.connectionStatus,
    t.store.data,
    ack,
  ]);
  for (const secret of [PASSWORD, WIFI, API_KEY, USER_ID]) {
    assert.ok(!everything.includes(secret), `${secret.slice(0, 4)}... leaked`);
  }
});

test('the button: another serial in the account, nothing saved', async () => {
  const t = await setup({
    config: { address: HOST, username: 'me@example.com', password: PASSWORD },
    cloud: fakeCloud({ serial: 'ab'.repeat(16) }).transport,
  });
  const ack = await t.gladys.fake.action('fetch_key');
  assert.match(JSON.stringify(ack), /Aucun foyer du compte/);
  assert.equal(t.gladys.fake.config.api_key, undefined);
});
