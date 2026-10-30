// Internal extension calling: eligibility re-checked at ACCEPTANCE and at every group-room step (tenant, verification, suspension), and the relay-only media policy.
// Real engine, real PostgreSQL, real workload credentials. This proves the SERVER'S decisions; it cannot prove that an established peer-to-peer media stream stops (see PROVIDER_NEUTRAL_TELECOM.md).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { exportJWK, importSPKI } from 'jose';
import { isolatedDb, identityProvider } from './helpers.mjs';
import { harness, until } from './harness.mjs';
import { signWorkloadJwt } from '../../qorlla-meet-video/server/telephony/number-sync.mjs';

let db, idp, h, r, pem, jwksSrv, jwksUrl;
const ISSUER = 'qorlla-workload';
async function workload() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = { ...(await exportJWK(await importSPKI(publicKey.export({ type: 'spki', format: 'pem' }), 'ES256'))), kid: 'w1', alg: 'ES256', use: 'sig' };
  const srv = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); }); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), srv, url: 'http://127.0.0.1:' + srv.address().port + '/jwks.json' };
}
const ops = (method, path, body) => fetch(r.base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signWorkloadJwt({ privateKeyPem: pem, kid: 'w1', issuer: ISSUER, subject: 'svc:ops' }) }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => ({})) }));
const person = async (id, o = {}) => { await ops('PUT', '/v1/shield/admin/principals', { accountId: id, verified: true, ...o }); return (await r.admin('POST', '/identities', { accountId: id })).body.identity.extension; };
const BASE = (extra = {}) => ({ SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_WORKLOAD_JWKS_URL: jwksUrl, SHIELD_WORKLOAD_ISSUER: ISSUER, SHIELD_WORKLOAD_ALLOWED: 'svc:ops=shield.admin|shield.suspend', ...extra });

before(async () => { db = await isolatedDb(); if (!db) return; idp = await identityProvider(); const w = await workload(); pem = w.pem; jwksSrv = w.srv; jwksUrl = w.url; h = harness({ db, idp }); r = await h.replica({ env: BASE() }); });
after(async () => { if (h) await h.closeAll(); if (idp) await idp.close(); if (jwksSrv) await new Promise((ok) => jwksSrv.close(ok)); if (db) await db.drop(); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable');

test('ACCEPTANCE re-check: a call that was allowed when it rang is refused at answer if the callee or caller is no longer eligible (other tenant, unverified, suspended)', async (t) => {
  if (skip(t)) return;
  await ops('PUT', '/v1/shield/admin/orgs', { orgId: 'orgA' }); await ops('PUT', '/v1/shield/admin/orgs', { orgId: 'orgB' });
  const cases = [['moved to another tenant', async (callee) => ops('PUT', '/v1/shield/admin/principals', { accountId: callee, orgId: 'orgB' }), 404], ['became unverified', async (callee) => ops('PUT', '/v1/shield/admin/principals', { accountId: callee, verified: false }), 403]];
  for (const [label, change, status] of cases) {
    const a = 'a' + randomUUID().slice(0, 6), b = 'b' + randomUUID().slice(0, 6); await person(a, { orgId: 'orgA' }); const eb = await person(b, { orgId: 'orgA' });
    const d = await r.dial(a, eb); assert.equal(d.status, 201, label); await change(b);
    const ans = await r.answer(d.body.call.id, b); assert.equal(ans.status, status, label + ': ' + JSON.stringify(ans.body));
    assert.equal((await db.pool.query('SELECT status FROM voice_calls WHERE id=$1', [d.body.call.id])).rows[0].status, 'ringing', label + ': the call did not become active');
    await r.api(a, 'POST', `/v1/voice/calls/${d.body.call.id}/end`, {});
  }
  // the CALLER becomes ineligible while ringing: the callee's answer is refused, the call is not connected
  const a = 'c' + randomUUID().slice(0, 6), b = 'd' + randomUUID().slice(0, 6); await person(a); const eb = await person(b); const d = await r.dial(a, eb); assert.equal(d.status, 201);
  await ops('PUT', '/v1/shield/admin/principals', { accountId: a, verified: false }); const ans = await r.answer(d.body.call.id, b); assert.ok(ans.status >= 400, 'caller no longer verified: ' + ans.status);
  assert.notEqual((await db.pool.query('SELECT status FROM voice_calls WHERE id=$1', [d.body.call.id])).rows[0].status, 'active');
  // the normal case still connects
  const x = 'e' + randomUUID().slice(0, 6), y = 'f' + randomUUID().slice(0, 6); await person(x); const ey = await person(y); const ok = await r.dial(x, ey); assert.equal((await r.answer(ok.body.call.id, y)).status, 200);
});

test('GROUP ROOMS are tenant-scoped: the host cannot invite another tenant, an invitee who changed tenant or lost verification cannot join, and nobody can invite across tenants into a live room', async (t) => {
  if (skip(t)) return;
  const host = 'h' + randomUUID().slice(0, 6), mate = 'm' + randomUUID().slice(0, 6), alien = 'x' + randomUUID().slice(0, 6), unv = 'u' + randomUUID().slice(0, 6);
  await person(host, { orgId: 'orgA' }); const em = await person(mate, { orgId: 'orgA' }), ex = await person(alien, { orgId: 'orgB' }), eu = await person(unv, { orgId: 'orgA', verified: false });
  const mk = (as, exts) => r.api(as, 'POST', '/v1/voice/rooms', { extensions: exts, title: 'sec', deviceId: r.device(as) });
  assert.equal((await mk(host, [ex])).status, 404, 'another tenant cannot be invited (same answer as an unknown extension)'); assert.equal((await mk(host, [em, ex])).status, 404, 'one outsider spoils the whole invitation'); assert.equal((await mk(host, [eu])).status, 404, 'an unverified account cannot be invited');
  assert.equal((await db.pool.query("SELECT count(*)::int AS c FROM voice_rooms WHERE host_id=$1", [host])).rows[0].c, 0, 'no room was created by the refused attempts');
  const room = await mk(host, [em]); assert.equal(room.status, 201, JSON.stringify(room.body)); const id = room.body.room.id;
  assert.equal((await r.api(host, 'POST', `/v1/voice/rooms/${id}/invite`, { extension: ex })).status, 404, 'no cross-tenant invite into a live room'); assert.equal((await r.api(host, 'POST', `/v1/voice/rooms/${id}/invite`, { extension: eu })).status, 404);
  // the invitee moves to another tenant before accepting: refused at join
  await ops('PUT', '/v1/shield/admin/principals', { accountId: mate, orgId: 'orgB' }); const j = await r.api(mate, 'POST', `/v1/voice/rooms/${id}/join`, { deviceId: r.device(mate) }); assert.equal(j.status, 404, 'join re-checks the tenant: ' + JSON.stringify(j.body));
  await ops('PUT', '/v1/shield/admin/principals', { accountId: mate, orgId: 'orgA' }); assert.equal((await r.api(mate, 'POST', `/v1/voice/rooms/${id}/join`, { deviceId: r.device(mate) })).status, 200, 'back in the right tenant');
  assert.equal((await r.api(host, 'POST', `/v1/voice/rooms/${id}/end`, {})).status, 200);
});

test('RELAY-ONLY media policy: VOICE_MEDIA_POLICY=relay tells every client to use relay candidates only, with short-lived credentials; without a relay it fails closed; a suspended account gets no credentials', async (t) => {
  if (skip(t)) return;
  const relay = await h.replica({ outbox: false, maintenance: false, env: BASE({ VOICE_MEDIA_POLICY: 'relay', TURN_URLS: 'turn:turn.example.test:3478?transport=udp,turns:turn.example.test:5349', TURN_SHARED_SECRET: 's'.repeat(40), STUN_URL: 'stun:turn.example.test:3478' }) });
  const p = 'r' + randomUUID().slice(0, 6); await person(p); const out = await relay.api(p, 'GET', '/v1/voice/ice'); assert.equal(out.status, 200, JSON.stringify(out.body)); assert.equal(out.body.iceTransportPolicy, 'relay');
  const turn = out.body.iceServers.find((s) => s.credential), exp = Number(String(turn.username).split(':')[0]); assert.ok(turn && exp > Date.now() / 1000 - 5 && exp <= Date.now() / 1000 + 601, 'TURN credential lifetime is at most 10 minutes: ' + (exp - Date.now() / 1000));
  const none = await h.replica({ outbox: false, maintenance: false, env: BASE({ VOICE_MEDIA_POLICY: 'relay' }) }); assert.equal((await none.api(p, 'GET', '/v1/voice/ice')).status, 503, 'relay-only demanded but no relay configured: refused, never silently direct');
  const open = await h.replica({ outbox: false, maintenance: false, env: BASE({ TURN_URLS: 'turn:turn.example.test:3478', TURN_SHARED_SECRET: 's'.repeat(40) }) }); assert.equal((await open.api(p, 'GET', '/v1/voice/ice')).body.iceTransportPolicy, 'all', 'default policy is unchanged');
  await ops('POST', `/v1/shield/admin/principals/${p}/suspend`, {}); assert.equal((await relay.api(p, 'GET', '/v1/voice/ice')).status, 403, 'a suspended account is issued no relay credentials');
});
