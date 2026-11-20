import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import { createShield } from '../src/shield.mjs';

// v2.3: the workload credential check tells a WRONG credential (401, the caller's fault) from a FAILURE OF THE CHECK (503, ours: logged, retryable). Both fail closed. No PostgreSQL needed.
const { publicKey, privateKey } = await generateKeyPair('ES256'); const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }, jwks = createLocalJWKSet({ keys: [jwk] });
const sign = (o = {}) => new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(o.iss || 'iss').setAudience(o.aud || 'qorlla-shield').setSubject('svc:t').setJti(o.jti || 'jti-' + Math.random().toString(36).slice(2) + 'xxxxxxxxxxxx').setIssuedAt().setExpirationTime('2m').sign(privateKey);
const mk = (db) => createShield({ store: { tx: async () => {} }, db, jwks, env: { SHIELD_ENABLED: 'true', SHIELD_WORKLOAD_ISSUER: 'iss', SHIELD_WORKLOAD_ALLOWED: 'svc:t=x.do' } });
const run = async (shield, token) => { const out = { status: null, next: false, body: null }, res = { once() {}, status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; } }; await shield.requireWorkload('x.do')({ get: (n) => (n.toLowerCase() === 'authorization' && token ? 'Bearer ' + token : ''), socket: {} }, res, () => { out.next = true; }); return out; };

test('a valid credential passes; wrong, foreign-audience, garbage and missing credentials are 401', async () => {
  const ok = mk({ query: async () => ({ rowCount: 1, rows: [{}] }) });
  assert.equal((await run(ok, await sign())).next, true);
  for (const bad of [await sign({ iss: 'other' }), await sign({ aud: 'someone-else' }), 'not.a.jwt', '', undefined]) { const o = await run(ok, bad); assert.equal(o.status, 401, String(bad).slice(0, 20)); assert.equal(o.next, false); }
});

test('a replayed credential is 401 (and is not let through)', async () => {
  let seen = false; const s = mk({ query: async (sql) => { if (/shield_workload_jti/.test(sql)) { const first = !seen; seen = true; return { rowCount: first ? 1 : 0, rows: [] }; } return { rowCount: 1, rows: [] }; } });
  const tok = await sign(); assert.equal((await run(s, tok)).next, true); const again = await run(s, tok); assert.equal(again.status, 401); assert.equal(again.next, false);
});

test('a failure of the CHECK itself (the database is down) is 503 "workload_check_unavailable", logged, and still never lets the request through', async () => {
  const s = mk({ query: async () => { throw new Error('connection terminated'); } }), errs = []; const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
  try { const o = await run(s, await sign()); assert.equal(o.status, 503); assert.deepEqual(o.body, { error: 'workload_check_unavailable' }); assert.equal(o.next, false); } finally { console.error = orig; }
  assert.ok(errs.some((e) => /workload_check_failed/.test(e)), 'the failure is logged for an operator');
});
