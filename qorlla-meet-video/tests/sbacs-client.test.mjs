import test from 'node:test';
import assert from 'node:assert/strict';
import crypto, { generateKeyPairSync } from 'node:crypto';
import { createSbacsClient, mintToken, AUDIENCE } from '../server/sbacs-client.mjs';
import { createEnforcement, sbacsFromEnv } from '../server/sbacs-enforce.mjs';

// Unit tests of Meet's SBACS client and enforcement defaults with an injected fetch. The contract against the REAL portal API is tested in qorlla-portal/tests/sbacs-meet-integration.test.mjs.
const kp = generateKeyPairSync('ed25519'), pem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
const reply = (status, json) => async () => ({ status, json: async () => json });
const mk = (fetchImpl, over = {}) => createSbacsClient({ mode: 'enforce', baseUrl: 'http://portal.test', service: 'meet', privateKeyPem: pem, fetchImpl, ...over });

test('tokens: Ed25519, issuer qorlla-<service>, audience, five-minute ceiling, verifiable with the public key only', () => {
  const t = mintToken({ service: 'storage', privateKey: kp.privateKey, now: 1_800_000_000_000, ttlSec: 120 }); const [h, body, sig] = t.split('.'); assert.equal(h, 'qsv2');
  const c = JSON.parse(Buffer.from(body, 'base64url')); assert.deepEqual([c.iss, c.sub, c.aud, c.exp - c.iat], ['qorlla-storage', 'storage', AUDIENCE, 120]); assert.ok(c.jti.length >= 8);
  assert.equal(crypto.verify(null, Buffer.from('qsv2.' + body), kp.publicKey, Buffer.from(sig, 'base64url')), true); assert.equal(crypto.verify(null, Buffer.from('qsv2.' + body + 'x'), kp.publicKey, Buffer.from(sig, 'base64url')), false);
});
test('off makes no call; shadow reports but never refuses; enforce refuses and distinguishes quota from denial', async () => {
  let n = 0; const f = async () => { n++; return { status: 200, json: async () => ({ allowed: false, reason: 'not_in_plan', upgradeAvailable: true }) }; };
  assert.deepEqual(await createSbacsClient({ mode: 'off', fetchImpl: f }).check({}), { ok: true, skipped: 'off' }); assert.equal(n, 0);
  const sh = await mk(f, { mode: 'shadow' }).check({ accountId: 'a', feature: 'meet.recording' }); assert.equal(sh.ok, true); assert.equal(sh.shadow.reason, 'not_in_plan');
  const en = await mk(f).check({ accountId: 'a', feature: 'meet.recording' }); assert.deepEqual([en.ok, en.kind, en.reason, en.upgradeAvailable], [false, 'denied', 'not_in_plan', true]);
  const q = await mk(reply(403, { ok: false, reason: 'quota_exhausted' })).reserve({ accountId: 'a', feature: 'storage.mb', idempotencyKey: 'k-12345678' }); assert.equal(q.kind, 'quota');
  assert.equal((await mk(reply(200, { ok: true, reservationId: 'r1' })).reserve({ accountId: 'a', feature: 'storage.mb', idempotencyKey: 'k-12345678' })).reservationId, 'r1');
});
test('fail closed: 5xx, 429, 404 (credential refused), timeouts, network errors and malformed answers are all "unavailable"; settling operations report truthfully even in shadow mode', async () => {
  for (const [why, f] of [['500', reply(500, {})], ['503', reply(503, {})], ['429', reply(429, {})], ['404 credential', reply(404, {})], ['401', reply(401, {})], ['network', async () => { throw new TypeError('fetch failed'); }], ['timeout', async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }], ['not json', async () => ({ status: 200, json: async () => { throw new Error('x'); } })]]) {
    const r = await mk(f).check({ accountId: 'a', feature: 'meet.create' }); assert.deepEqual([r.ok, r.kind], [false, 'unavailable'], why);
  }
  const sh = mk(reply(500, {}), { mode: 'shadow' }); assert.equal((await sh.check({ accountId: 'a', feature: 'x' })).ok, true); assert.equal((await sh.finalize({ accountId: 'a', reservationId: 'r' })).kind, 'unavailable');
});
test('circuit breaker opens after consecutive failures, answers at once, then probes after the window', async () => {
  let clock = 1000, hits = 0, up = false; const f = async () => { hits++; return up ? { status: 200, json: async () => ({ allowed: true }) } : { status: 503, json: async () => ({}) }; };
  const c = mk(f, { breakerFailures: 3, breakerOpenMs: 5000, now: () => clock });
  for (let i = 0; i < 3; i++) await c.check({ accountId: 'a', feature: 'meet.create' }); assert.equal(hits, 3); assert.equal((await c.check({ accountId: 'a', feature: 'meet.create' })).reason, 'circuit_open'); assert.equal(hits, 3, 'no call while open');
  up = true; clock += 6000; assert.equal((await c.check({ accountId: 'a', feature: 'meet.create' })).ok, true); assert.equal(c.breaker().open, false);
});
test('configuration errors stop the service at start-up; with SBACS_MODE unset nothing is active and nothing is refused', async () => {
  assert.throws(() => sbacsFromEnv({ SBACS_MODE: 'enforce' }, null, () => {}), /portal base URL/); assert.throws(() => sbacsFromEnv({ SBACS_MODE: 'enforce', SBACS_URL: 'http://p' }, null, () => {}), /private key/); assert.throws(() => sbacsFromEnv({ SBACS_MODE: 'nope' }, null, () => {}), /off, shadow or enforce/);
  const ok = sbacsFromEnv({ SBACS_MODE: 'enforce', SBACS_URL: 'http://p', SBACS_MEET_PRIVATE_KEY_B64: Buffer.from(pem).toString('base64'), SBACS_STORAGE_PRIVATE_KEY_PEM: pem }, null, () => {}); assert.equal(ok.active, true);
  const off = sbacsFromEnv({}, null); assert.equal(off.active, false); assert.deepEqual(await off.gate('meet.recording', null), { ok: true }); assert.deepEqual(await off.beforeChunk({}), { ok: true, ticket: null }); assert.deepEqual(await off.beginRecording('m', 's'), { ok: true, ticket: null });
  assert.equal(createEnforcement({ mode: 'off' }).active, false);
});
