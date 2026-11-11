import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.mjs';

// PORTAL_ALLOWED_ORIGIN may list several origins (the same site over http and https, by name and by LAN address). The first is the public address.
test('PORTAL_ALLOWED_ORIGIN accepts a comma separated list; the first is the public origin', () => {
  const c = loadConfig({ PORTAL_ALLOWED_ORIGIN: ' http://localhost:4800/ , https://10.0.0.176:4843,https://localhost:4843 ,' });
  assert.equal(c.origin, 'http://localhost:4800');
  assert.deepEqual(c.origins, ['http://localhost:4800', 'https://10.0.0.176:4843', 'https://localhost:4843']);
  const one = loadConfig({ PORTAL_ALLOWED_ORIGIN: 'https://qorlla.example' }); assert.deepEqual(one.origins, ['https://qorlla.example']); assert.equal(one.origin, 'https://qorlla.example');
  assert.deepEqual(loadConfig({}).origins, []);
});
