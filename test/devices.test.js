import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildDevice, deviceStates, parseFeatureId } from '../src/devices.js';
import { parsePoll } from '../src/intellifire/model.js';
import { SERIAL } from './fixtures/fakeFireplace.js';

const CORE_NORMALIZE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const normalizeSupportedOptions = existsSync(CORE_NORMALIZE)
  ? createRequire(import.meta.url)(CORE_NORMALIZE).normalizeSupportedOptions
  : undefined;

const gladys = {
  externalIds: (type, id) => ({
    device: `ext:test:${type}:${id}`,
    feature: (key) => `ext:test:${type}:${id}:${key}`,
  }),
};

test('no switch nor writable binary; buttons, selects, a target temperature', () => {
  for (const language of ['fr', 'en']) {
    const device = buildDevice(gladys, SERIAL, {}, { language });
    for (const f of device.features) {
      assert.ok(f.category !== 'switch', f.external_id);
      assert.ok(!(f.type === 'binary' && !f.read_only), f.external_id);
      assert.ok(f.name.trim().length > 0);
    }
  }
});

test('every supported_options follows the rules of the core', () => {
  for (const language of ['fr', 'en']) {
    const device = buildDevice(gladys, SERIAL, {}, { language });
    for (const f of device.features.filter((x) => x.supported_options)) {
      const options = f.supported_options;
      for (const o of options) {
        assert.deepEqual(Object.keys(o).sort(), ['label', 'value']);
        assert.equal(typeof o.label, 'string');
        assert.ok(o.label.length > 0 && o.label === o.label.trim(), o.label);
        assert.ok(typeof o.value === 'string' && o.value.trim() === o.value && o.value !== '');
      }
      assert.equal(new Set(options.map((o) => `${o.value}`)).size, options.length);
      if (normalizeSupportedOptions) {
        assert.doesNotThrow(() =>
          normalizeSupportedOptions(options, {
            allowStringValues: f.category === 'text' && f.type === 'select',
          }),
        );
      }
    }
  }
});

test('states: unknown never published, a text never a 0', () => {
  const ids = gladys.externalIds('intellifire', SERIAL);
  const states = deviceStates(ids, parsePoll('{"serial":"' + SERIAL + '","power":""}'), {
    online: true,
    language: 'fr',
  });
  assert.deepEqual(
    states.map((s) => s.device_feature_external_id.split(':').pop()),
    ['status'],
  );
  assert.equal(states[0].text, 'État inconnu');
  assert.equal(parseFeatureId(`${ids.device}:turn-off`).role, 'turn-off');
  assert.equal(parseFeatureId(`${ids.device}:nope`), undefined);
});
