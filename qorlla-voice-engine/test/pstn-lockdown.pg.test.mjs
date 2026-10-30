// PSTN lockdown and the account-to-account (internal extension) calling rules, against a real engine on real PostgreSQL with real workload credentials.
// Approved scope: Qorlla-to-Qorlla voice by internal extension only. Public numbers and PSTN are DISABLED by default; the feature flag is defense in depth, not permission to deploy PSTN.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { exportJWK, importSPKI } from 'jose';
import pg from 'pg';
import { isolatedDb, identityProvider } from './helpers.mjs';
import { harness, until, ADMIN } from './harness.mjs';
import { signWorkloadJwt } from '../../qorlla-meet-video/server/telephony/number-sync.mjs';

let db, idp, h, r, pem, jwksSrv, jwksUrl;
const ISSUER = 'qorlla-workload', EXACT = { error: 'feature_disabled', feature: 'pstn', message: 'Public telephone calling is disabled.' };
async function workload() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = { ...(await exportJWK(await importSPKI(publicKey.export({ type: 'spki', format: 'pem' }), 'ES256'))), kid: 'w1', alg: 'ES256', use: 'sig' };
  const srv = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); }); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), srv, url: 'http://127.0.0.1:' + srv.address().port + '/jwks.json' };
}
const tok = (sub) => signWorkloadJwt({ privateKeyPem: pem, kid: 'w1', issuer: ISSUER, subject: sub });
const call = (rep, sub, method, path, body, headers = {}) => fetch(rep.base + path, { method, headers: { 'content-type': 'application/json', ...(sub ? { authorization: 'Bearer ' + tok(sub) } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => ({})) }));
const BASE_ENV = () => ({ SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_WORKLOAD_JWKS_URL: jwksUrl, SHIELD_WORKLOAD_ISSUER: ISSUER, SHIELD_WORKLOAD_ALLOWED: 'svc:pstn=pstn.authorize|pstn.consume|pstn.settle;svc:admin=shield.admin;svc:numbers-plans=numbers.sync;svc:lowly=guest.admit', SHIELD_NUMBERS_AUTHORITY: 'svc:numbers-plans' });
// variants only answer HTTP: with no Redis bus, a second outbox worker on the same database would swallow events that belong to the replica holding the sockets
const withFlag = (name, value, o = {}) => h.replica({ outbox: false, maintenance: false, ...o, env: { ...BASE_ENV(), ...(value === undefined ? {} : { [name]: value }) } });
const PSTN = [['POST', '/v1/shield/pstn/authorize', { requestId: randomUUID(), accountId: 'x1', destination: '+16502530000', callerId: '+14155550101' }], ['POST', '/v1/shield/pstn/consume', { authorizationId: randomUUID(), accountId: 'x1', destination: '+16502530000', callerId: '+14155550101' }], ['POST', '/v1/shield/pstn/settle', { authorizationId: randomUUID(), actualCents: 1 }], ['POST', '/v1/shield/pstn/terminations', {}]];
const principal = (id, o = {}) => call(r, 'svc:admin', 'PUT', '/v1/shield/admin/principals', { accountId: id, verified: true, ...o });
const person = async (id, o) => { await principal(id, o); return (await r.admin('POST', '/identities', { accountId: id })).body.identity.extension; };

before(async () => {
  db = await isolatedDb(); if (!db) return; idp = await identityProvider(); const w = await workload(); pem = w.pem; jwksSrv = w.srv; jwksUrl = w.url; h = harness({ db, idp });
  r = await withFlag('VOICE_PSTN_ENABLED', undefined, { outbox: true, maintenance: true });                                    // the production default: nothing set
});
after(async () => { if (h) await h.closeAll(); if (idp) await idp.close(); if (jwksSrv) await new Promise((ok) => jwksSrv.close(ok)); if (db) await db.drop(); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable');

test('PSTN is OFF when the flag is missing, false, empty or any value other than exactly "true"; a valid PSTN-scoped workload cannot bypass it; every PSTN route is gated', async (t) => {
  if (skip(t)) return;
  for (const value of [undefined, 'false', '', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', 'enabled']) {
    const rep = value === undefined ? r : await withFlag('VOICE_PSTN_ENABLED', value);
    for (const [m, p, b] of (value === undefined || value === 'false' || value === 'TRUE' ? PSTN : PSTN.slice(0, 1))) {
      const x = await call(rep, 'svc:pstn', m, p, b); assert.equal(x.status, 403, `${JSON.stringify(value)} ${p}`); assert.deepEqual(x.body, EXACT, `${JSON.stringify(value)} ${p}: exact refusal, no account or call details`);
    }
  }
  // authentication is still required and still comes first
  for (const [m, p, b] of PSTN) { assert.equal((await call(r, null, m, p, b)).status, 401, 'anonymous: ' + p); assert.equal((await call(r, null, m, p, b, { authorization: 'Bearer garbage' })).status, 401); assert.equal((await call(r, null, m, p, b, { 'x-voice-admin-secret': ADMIN })).status, 401, 'the shared admin secret is no bypass'); assert.equal((await call(r, 'svc:lowly', m, p, b)).status, 403); }
  const lowly = await call(r, 'svc:lowly', 'POST', '/v1/shield/pstn/authorize', PSTN[0][2]); assert.notEqual(lowly.body.error, 'feature_disabled', 'a workload without the scope is refused for lacking it');
  // only the exact value turns the gate off (the legacy PSTN tests do this in isolated test environments)
  const on = await withFlag('VOICE_PSTN_ENABLED', 'true'); const x = await call(on, 'svc:pstn', 'POST', '/v1/shield/pstn/authorize', PSTN[0][2]); assert.equal(x.status, 403); assert.equal(x.body.reason, 'UNKNOWN_PRINCIPAL', 'with the flag on the request reaches the normal checks');
  // public numbers: same default-off rule, same shape
  for (const rep of [r, await withFlag('VOICE_NUMBERS_ENABLED', 'false'), await withFlag('VOICE_NUMBERS_ENABLED', 'TRUE')]) for (const p of ['/v1/shield/numbers/events', '/v1/shield/numbers/reconcile', '/v1/shield/numbers/status']) { const y = await call(rep, 'svc:numbers-plans', 'POST', p, { numbers: [] }); assert.equal(y.status, 403, p); assert.deepEqual(y.body, { error: 'feature_disabled', feature: 'numbers', message: 'Public telephone numbers are disabled.' }); }
  const numOn = await withFlag('VOICE_NUMBERS_ENABLED', 'true'); assert.notEqual((await call(numOn, 'svc:numbers-plans', 'POST', '/v1/shield/numbers/status', {})).body.error, 'feature_disabled');
});

test('PSTN disabled does not touch internal calling: two verified accounts call each other by extension; a public telephone number is refused as PSTN; malformed and unknown destinations fail closed', async (t) => {
  if (skip(t)) return;
  const ea = await person('ann'), eb = await person('ben'); const a = await r.connect('ann'), b = await r.connect('ben');
  const d = await r.dial('ann', eb); assert.equal(d.status, 201, JSON.stringify(d.body)); assert.equal(d.body.call.caller_id, 'ann'); assert.ok(await until(() => b.of('incoming')[0]), 'signaling reaches the callee');
  assert.equal((await r.answer(d.body.call.id, 'ben')).status, 200); assert.ok(await until(() => a.inbox.find((m) => m.call?.status === 'active')), 'ringing, accept, active');
  assert.equal((await r.api('ann', 'POST', `/v1/voice/calls/${d.body.call.id}/end`, {})).status, 200, 'hang up works'); a.close(); b.close();
  // a user-supplied identity can never substitute for the authenticated one
  const forged = await r.api('ben', 'POST', '/v1/voice/calls', { extension: ea, idempotencyKey: 'k-' + randomUUID(), deviceId: r.device('ben'), accountId: 'ann', callerId: 'ann', from: 'ann', caller_id: 'ann', callerExtension: eb });
  assert.equal(forged.body.call.caller_id, 'ben', 'the caller is the authenticated account, whatever the body says');
  await r.api('ben', 'POST', `/v1/voice/calls/${forged.body.call.id}/end`, {});
  // public numbers and PSTN-looking destinations: refused as PSTN, creating nothing
  for (const dest of ['+16502530000', '+442071838750', '+911']) { const x = await r.api('ann', 'POST', '/v1/voice/calls', { extension: dest, idempotencyKey: 'k-' + randomUUID(), deviceId: r.device('ann') }); assert.equal(x.status, 403, dest); assert.deepEqual(x.body, EXACT); }
  // malformed, unknown or ambiguous identifiers fail closed and look the same as "no such recipient"
  for (const bad of ['hello', '12 3', '123,456', '12', '123456789', '１２３４', '0x1234', '12;34', '911', '112']) assert.equal((await r.api('ann', 'POST', '/v1/voice/calls', { extension: bad, idempotencyKey: 'k-' + randomUUID(), deviceId: r.device('ann') })).status, 400, 'invalid: ' + bad);
  assert.equal((await r.api('ann', 'POST', '/v1/voice/calls', { extension: '99999999', idempotencyKey: 'k-' + randomUUID(), deviceId: r.device('ann') })).status, 404, 'unknown extension');
  assert.equal((await r.api('ann', 'POST', '/v1/voice/calls', { extension: ea, idempotencyKey: 'k-' + randomUUID(), deviceId: r.device('ann') })).status, 404, 'nobody can call themselves');
  // duplicated identifiers cannot exist: the service refuses, and so does the database
  assert.equal((await r.admin('POST', '/identities', { accountId: 'dup-claimant', extension: eb })).status, 409, 'an extension that is taken cannot be given again');
  await assert.rejects(db.pool.query("INSERT INTO voice_identities(account_id, extension) VALUES('dup-direct', $1)", [eb]), /unique|duplicate/i);
  assert.equal((await r.admin('POST', '/identities', { accountId: 'emerg', extension: '911' })).status, 400, 'an emergency number can never be an extension');
});

test('WHO MAY CALL: guests and foreign credentials, unverified and suspended accounts, and other tenants are all refused; the refusal for another tenant is the same as for an unknown extension', async (t) => {
  if (skip(t)) return;
  const e = {}; for (const n of ['ava', 'bo']) e[n] = await person(n);
  const dial = (as, ext) => r.api(as, 'POST', '/v1/voice/calls', { extension: ext, idempotencyKey: 'k-' + randomUUID(), deviceId: r.device(as) });
  // guests and anything that is not a main-app voice token
  for (const authz of [undefined, 'Bearer garbage', 'Bearer ' + 'm'.repeat(43), 'Bearer ' + await idp.token('ava', { aud: 'qorlla-meet-media' }), 'Bearer ' + await idp.token('ava', { iss: 'someone-else' })]) {
    const x = await fetch(r.base + '/v1/voice/calls', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.qorlla.test', ...(authz ? { authorization: authz } : {}) }, body: JSON.stringify({ extension: e.bo, idempotencyKey: 'k-' + randomUUID(), deviceId: randomUUID() }) }); assert.equal(x.status, 401, String(authz).slice(0, 20));
    assert.equal((await fetch(r.base + '/v1/voice/ws-ticket', { method: 'POST', headers: { 'content-type': 'application/json', ...(authz ? { authorization: authz } : {}) }, body: JSON.stringify({ deviceId: randomUUID() }) })).status, 401);
  }
  assert.equal((await dial('stranger-never-registered', e.bo)).status, 401, 'a valid token for a principal the shield never heard of');
  // unverified
  await principal('newbie', { verified: false }); await r.admin('POST', '/identities', { accountId: 'newbie' }); assert.equal((await dial('newbie', e.bo)).status, 403); assert.equal((await dial('newbie', e.bo)).body.error, 'identity_unverified'); assert.equal((await r.api('newbie', 'POST', '/v1/voice/ws-ticket', { deviceId: randomUUID() })).status, 403);
  await principal('lately', { verified: false }); const lateExt = (await r.admin('POST', '/identities', { accountId: 'lately' })).body.identity.extension; assert.equal((await dial('ava', lateExt)).status, 404, 'an unverified account cannot be called either');
  // suspended: neither places nor receives
  const sue = await person('sue'); assert.equal((await dial('sue', e.bo)).status, 201); await r.api('sue', 'POST', '/v1/voice/calls/' + (await r.api('sue', 'GET', '/v1/voice/calls/live')).body.call.id + '/end', {});
  assert.equal((await call(r, 'svc:admin', 'POST', '/v1/shield/admin/principals/sue/suspend', {})).status, 200);
  assert.equal((await dial('sue', e.bo)).status, 403, 'a suspended account cannot place a call'); assert.equal((await dial('bo', sue)).status, 404, 'nor receive one');
  // tenants: same tenant OK, other tenant refused exactly like an unknown extension
  await call(r, 'svc:admin', 'PUT', '/v1/shield/admin/orgs', { orgId: 'orgA' }); await call(r, 'svc:admin', 'PUT', '/v1/shield/admin/orgs', { orgId: 'orgB' });
  const t1 = await person('ana', { orgId: 'orgA' }), t2 = await person('abe', { orgId: 'orgA' }), t3 = await person('cal', { orgId: 'orgB' });
  const same = await dial('ana', t2); assert.equal(same.status, 201, 'two verified accounts in one tenant'); await r.api('ana', 'POST', `/v1/voice/calls/${same.body.call.id}/end`, {});
  const cross = await dial('ana', t3), unknown = await dial('ana', '99999998'); assert.equal(cross.status, 404); assert.deepEqual(cross.body, unknown.body, 'a caller cannot tell another tenant\'s extension from a missing one');
  assert.equal((await dial('cal', t1)).status, 404, 'and not the other way round'); assert.equal((await dial('ava', t1)).status, 404, 'the default namespace cannot reach a tenant'); assert.equal((await dial('ana', e.ava ?? e.bo)).status, 404, 'nor a tenant the default namespace');
  assert.equal((await call(r, 'svc:admin', 'POST', '/v1/shield/admin/orgs/orgA/suspend', {})).status, 200); assert.equal((await dial('ana', t2)).status, 403, 'a suspended organization cannot call');
});

test('INTERNAL CALLS kill switch: only the exact value "false" turns internal calling off (calls and new rooms), with the same refusal shape; hanging up is never blocked', async (t) => {
  if (skip(t)) return;
  const off = await withFlag('VOICE_INTERNAL_CALLS_ENABLED', 'false'); const ex = await person('kay'); await person('lee');
  const x = await off.api('kay', 'POST', '/v1/voice/calls', { extension: ex, idempotencyKey: 'k-' + randomUUID(), deviceId: off.device('kay') }); assert.equal(x.status, 403); assert.deepEqual(x.body, { error: 'feature_disabled', feature: 'internal_calls', message: 'Internal calling is disabled.' });
  assert.equal((await off.api('kay', 'POST', '/v1/voice/rooms', {})).status, 403);
  assert.equal((await off.api('kay', 'GET', '/v1/voice/me')).status, 200, 'reading your own state still works');
  for (const v of [undefined, 'true', 'TRUE', '', '0']) { const rep = await withFlag('VOICE_INTERNAL_CALLS_ENABLED', v); const el = (await rep.admin('GET', '/identities?ids=lee')).body.identities[0].extension; assert.equal((await rep.api('kay', 'POST', '/v1/voice/calls', { extension: el, idempotencyKey: 'k-' + randomUUID(), deviceId: rep.device('kay') })).status, 201, 'on by default: ' + JSON.stringify(v)); await rep.api('kay', 'POST', '/v1/voice/calls/' + (await rep.api('kay', 'GET', '/v1/voice/calls/live')).body.call.id + '/end', {}); }
});
