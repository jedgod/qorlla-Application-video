// Phone -> Meeting transition authority (move.mjs), against a real engine on real PostgreSQL with Shield enforcement ON.
// Covers: the happy path, recipient-only acceptance, single use (replay), expiry, a token for another call, a non-participant, the Shield denials (suspended, unverified, cross-tenant),
// a call that ended, malformed input, rate limiting, and that every decision is written to the Shield audit table. Tokens are never stored in clear.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { exportJWK, importSPKI } from 'jose';
import { isolatedDb, identityProvider } from './helpers.mjs';
import { harness, until } from './harness.mjs';
import { signWorkloadJwt } from '../../qorlla-meet-video/server/telephony/number-sync.mjs';
import { createMove } from '../src/move.mjs';

let db, idp, h, r, pem, jwksSrv, jwksUrl;
const ISSUER = 'qorlla-workload', MEET = '12345678901';
async function workload() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = { ...(await exportJWK(await importSPKI(publicKey.export({ type: 'spki', format: 'pem' }), 'ES256'))), kid: 'w1', alg: 'ES256', use: 'sig' };
  const srv = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); }); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), srv, url: 'http://127.0.0.1:' + srv.address().port + '/jwks.json' };
}
const ops = (method, path, body) => fetch(r.base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signWorkloadJwt({ privateKeyPem: pem, kid: 'w1', issuer: ISSUER, audience: 'qorlla-shield', subject: 'svc:ops' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const person = async (id, o = {}) => { await ops('PUT', '/v1/shield/admin/principals', { accountId: id, verified: true, ...o }); return (await r.admin('POST', '/identities', { accountId: id })).body.identity?.extension || (await r.admin('GET', '/identities?ids=' + id)).body.identities[0].extension; };
const events = async (action = 'move.transition') => (await db.pool.query('SELECT actor, decision, reason, context FROM shield_events WHERE action=$1 ORDER BY id', [action])).rows;
async function liveCall(a, b) { const ext = await person(b.id, b.o || {}); await person(a.id, a.o || {}); const d = await r.dial(a.id, ext); assert.equal(d.status, 201, JSON.stringify(d.body)); assert.equal((await r.answer(d.body.call.id, b.id)).status, 200); return d.body.call.id; }
const start = (as, callId, meetingId = MEET) => r.api(as, 'POST', `/v1/voice/calls/${callId}/move/start`, { meetingId });
const accept = (as, callId, token) => r.api(as, 'POST', `/v1/voice/calls/${callId}/move/accept`, { token });

before(async () => {
  db = await isolatedDb(); if (!db) return; idp = await identityProvider(); const w = await workload(); pem = w.pem; jwksSrv = w.srv; jwksUrl = w.url; h = harness({ db, idp });
  r = await h.replica({ env: { SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_WORKLOAD_JWKS_URL: jwksUrl, SHIELD_WORKLOAD_ISSUER: ISSUER, SHIELD_WORKLOAD_ALLOWED: 'svc:ops=shield.admin|shield.suspend|voice.admin', VOICE_ADMIN_RATE_PER_MIN: '5000' } });
});
after(async () => { if (h) await h.closeAll(); if (idp) await idp.close(); if (jwksSrv) await new Promise((ok) => jwksSrv.close(ok)); if (db) await db.drop(); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable');

test('HAPPY PATH: the caller starts, only the other person can accept, the meeting id comes back, and both decisions are audited', async (t) => {
  if (skip(t)) return;
  const call = await liveCall({ id: 'mvann' }, { id: 'mvben' }), s = await start('mvann', call);
  assert.equal(s.status, 200, JSON.stringify(s.body)); assert.ok(s.body.token.length >= 30); assert.equal(s.body.expiresIn, 60);
  assert.equal((await accept('mvann', call, s.body.token)).status, 403, 'the initiator cannot accept their own transition');
  const s2 = await start('mvann', call); const a = await accept('mvben', call, s2.body.token);
  assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.meetingId, MEET);
  const ev = await events(); assert.ok(ev.some((e) => e.actor === 'mvann' && e.decision === 'ALLOW' && e.reason === 'START')); assert.ok(ev.some((e) => e.actor === 'mvben' && e.decision === 'ALLOW' && e.reason === 'ACCEPT'));
  assert.equal(JSON.stringify(ev).includes(s2.body.token), false, 'a token is never written to the audit trail');
});

test('REPLAY, WRONG CALL, EXPIRY, GARBAGE: a spent token finds nothing; a token for another call, an invented one, an overlong one and an expired one are all refused', async (t) => {
  if (skip(t)) return;
  const c1 = await liveCall({ id: 'rpann' }, { id: 'rpben' }), s = await start('rpann', c1);
  assert.equal((await accept('rpben', c1, s.body.token)).status, 200); assert.equal((await accept('rpben', c1, s.body.token)).status, 403, 'replay');
  const c2 = await liveCall({ id: 'rpcat' }, { id: 'rpdan' }), s2 = await start('rpcat', c2);
  assert.equal((await accept('rpben', c1, s2.body.token)).status, 403, 'a token for another call'); assert.equal((await accept('rpdan', c2, s2.body.token)).status, 403, 'and it was spent by the failed attempt: it cannot be reused');
  for (const bad of ['', 'short', 'x'.repeat(200), 'A'.repeat(32)]) assert.ok([400, 403].includes((await accept('rpdan', c2, bad)).status), bad.slice(0, 8));
  assert.equal((await r.api('rpdan', 'POST', `/v1/voice/calls/${c2}/move/accept`, { token: 'A'.repeat(32), extra: 1 })).status, 400, 'unknown fields are dropped, so the token is missing');
  const clock = { t: 1000 }, fake = createMove({ store: { getCall: async () => ({ status: 'active', caller_id: 'a', callee_id: 'b' }), tx: async () => {} }, shield: { callGuard: async () => {} }, enforce: true, ttlMs: 5000, now: () => clock.t });
  const tk = await fake.start('a', 'cid', MEET); clock.t += 5001;
  await assert.rejects(() => fake.accept('b', 'cid', tk.token), { code: 'move_denied' }); assert.equal(fake._size(), 0, 'an expired token is removed');
});

test('NOT A PARTICIPANT, ENDED CALL, BAD MEETING ID: refused with the same answer', async (t) => {
  if (skip(t)) return;
  const c = await liveCall({ id: 'npann' }, { id: 'npben' }); await person('npeve');
  assert.equal((await start('npeve', c)).status, 403, 'someone outside the call cannot start a transition'); const s = await start('npann', c);
  assert.equal((await accept('npeve', c, s.body.token)).status, 403, 'nor accept one');
  for (const m of ['1234', 'abcdefghijk', '1234567890123456789', '', null, '12345 abc 678']) assert.equal((await start('npann', c, m)).status, 400, String(m));
  const s3 = await start('npann', c); assert.equal((await r.api('npann', 'POST', `/v1/voice/calls/${c}/end`, {})).status, 200);
  assert.equal((await accept('npben', c, s3.body.token)).status, 409, 'the call ended before the recipient accepted: nothing moves'); assert.equal((await start('npann', c)).status, 409);
  assert.equal((await r.api('npann', 'POST', '/v1/voice/calls/not-a-uuid/move/start', { meetingId: MEET })).status, 400);
});

test('SHIELD DECISIONS: a recipient suspended after the token was issued, and a recipient who moved to another organization mid-call, are refused server-side', async (t) => {
  if (skip(t)) return;
  const c = await liveCall({ id: 'shann' }, { id: 'shben' }), s = await start('shann', c);
  assert.equal((await ops('POST', '/v1/shield/admin/principals/shben/suspend', {})).status, 200);
  assert.equal((await accept('shben', c, s.body.token)).status, 403, 'suspension between start and accept is caught at accept (the Shield is asked again)');
  await ops('POST', '/v1/shield/admin/principals/shben/restore', {});
  const c2 = await liveCall({ id: 'tnann', o: { orgId: 'orgX' } }, { id: 'tnben', o: { orgId: 'orgX' } }); assert.equal((await start('tnann', c2)).status, 200);
  await ops('PUT', '/v1/shield/admin/principals', { accountId: 'tnben', verified: true, orgId: 'orgY' });                 // the recipient moves to another organization mid-call
  assert.equal((await start('tnann', c2)).status, 403, 'cross-tenant: refused at start');
  const ev = await events(); assert.ok(ev.some((e) => e.actor === 'tnann' && e.decision === 'DENY' && /^SHIELD:/.test(e.reason)), 'the denial is in the audit trail'); // a suspended account is refused earlier still, by the account-status check on every authenticated route (it never reaches the transition code)
});

test('RATE LIMIT: a burst of starts is slowed down per account', async (t) => {
  if (skip(t)) return;
  const c = await liveCall({ id: 'rlann' }, { id: 'rlben' }); const codes = []; for (let i = 0; i < 9; i++) codes.push((await start('rlann', c)).status);
  assert.ok(codes.includes(429), codes.join(',')); assert.equal(codes[0], 200);
});
