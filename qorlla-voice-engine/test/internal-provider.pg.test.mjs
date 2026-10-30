// Provider-neutral telecommunications: the capability contract every provider is held to, the QorllaInternalProvider (Qorlla's own identities and extensions: no carrier, no Twilio, no public numbers, no PSTN)
// run against the REAL voice engine with real workload credentials, and the revocation lifecycle of an internal call (real WebSockets, real PostgreSQL).
// What this does NOT prove: that an already-established peer-to-peer media stream stops. The server can end the call in signaling, close sockets, refuse new TURN credentials, and tell the other party; a peer that ignores
// the signal keeps its media until the relay credential expires. Only relayed media can be cut by the server.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { exportJWK, importSPKI } from 'jose';
import { isolatedDb, identityProvider } from './helpers.mjs';
import { harness, until } from './harness.mjs';
import { capabilitiesOf, assertProviderContract } from '../../qorlla-meet-video/server/telephony/provider-contract.mjs';
import { QorllaInternalProvider, createInternalProvider } from '../../qorlla-meet-video/server/telephony/qorlla-internal.mjs';
import { UnconfiguredProvider, createCarrier } from '../../qorlla-meet-video/server/telephony/provider.mjs';
import { TwilioProvider } from '../../qorlla-meet-video/server/telephony/twilio.mjs';
import { TelephonyService } from '../../qorlla-meet-video/server/telephony/service.mjs';
import { signWorkloadJwt } from '../../qorlla-meet-video/server/telephony/number-sync.mjs';

let db, idp, h, r, pem, jwksSrv, jwksUrl, provider;
const ISSUER = 'qorlla-workload', sleepMs = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function workload() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = { ...(await exportJWK(await importSPKI(publicKey.export({ type: 'spki', format: 'pem' }), 'ES256'))), kid: 'w1', alg: 'ES256', use: 'sig' };
  const srv = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); }); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), srv, url: 'http://127.0.0.1:' + srv.address().port + '/jwks.json' };
}
const tok = (sub) => signWorkloadJwt({ privateKeyPem: pem, kid: 'w1', issuer: ISSUER, subject: sub });
const ops = (method, path, body) => fetch(r.base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok('svc:ops') }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => ({})) }));

before(async () => {
  db = await isolatedDb(); if (!db) return; idp = await identityProvider(); const w = await workload(); pem = w.pem; jwksSrv = w.srv; jwksUrl = w.url; h = harness({ db, idp });
  r = await h.replica({ env: { SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_WORKLOAD_JWKS_URL: jwksUrl, SHIELD_WORKLOAD_ISSUER: ISSUER, SHIELD_WORKLOAD_ALLOWED: 'svc:numbers-plans=voice.admin;svc:ops=shield.admin|shield.suspend' } });
  provider = new QorllaInternalProvider({ engineUrl: r.base, tokenProvider: () => tok('svc:numbers-plans') });
});
after(async () => { if (h) await h.closeAll(); if (idp) await idp.close(); if (jwksSrv) await new Promise((ok) => jwksSrv.close(ok)); if (db) await db.drop(); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable');

test('CONTRACT: every provider declares what it can do and implements what it declares; undeclared means false; a provider cannot claim PSTN without public numbers', () => {
  const twilio = new TwilioProvider({ sid: 'ACabcdefghij', token: 't', fetchImpl: async () => ({}) });
  const internal = new QorllaInternalProvider({ engineUrl: 'http://127.0.0.1:1', tokenProvider: () => 'x' });
  assert.deepEqual(assertProviderContract(new UnconfiguredProvider()), { internalExtensions: false, publicNumbers: false, pstn: false });
  assert.deepEqual(assertProviderContract(twilio), { internalExtensions: false, publicNumbers: true, pstn: true }, 'the Twilio adapter is an optional compatibility module');
  assert.deepEqual(assertProviderContract(internal), { internalExtensions: true, publicNumbers: false, pstn: false });
  assert.deepEqual(capabilitiesOf({}), { internalExtensions: false, publicNumbers: false, pstn: false }); assert.deepEqual(capabilitiesOf(null), { internalExtensions: false, publicNumbers: false, pstn: false });
  assert.throws(() => assertProviderContract({ name: 'liar', configured: true, healthCheck() {}, capabilities: { publicNumbers: true } }), /listAvailableNumbers|provisionNumber/);
  assert.throws(() => assertProviderContract({ name: 'x', configured: true, healthCheck() {}, capabilities: { pstn: true, publicNumbers: false }, startCall() {}, endCall() {}, fetchCall() {}, verifyWebhook() {}, parseWebhook() {} }), /pstn requires publicNumbers/);
  assert.throws(() => assertProviderContract({ name: 'x', healthCheck() {} }), /configured/);
  // configuration: PHONE_CARRIER selects; nothing selected or incomplete = inert
  assert.equal(createCarrier({}).name, 'unconfigured'); assert.equal(createCarrier({ PHONE_CARRIER: 'internal' }).name, 'unconfigured', 'internal without an engine URL and workload key is inert');
  const configured = createCarrier({ PHONE_CARRIER: 'internal', QORLLA_ENGINE_URL: 'http://127.0.0.1:1', PHONE_ENGINE_SYNC_KEY_PEM: pem || generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }), PHONE_ENGINE_SYNC_ISSUER: ISSUER }); assert.equal(configured.name, 'qorlla-internal'); assert.equal(createInternalProvider({}), null);
  assert.equal(createCarrier({ PHONE_CARRIER: 'twilio' }).name, 'unconfigured', 'Twilio without credentials is inert too: it is optional, never required');
});

test('QorllaInternalProvider against the REAL engine: provisions, releases and checks extensions with a workload credential; public numbers and PSTN fail closed; a refused or unreachable engine is not a success', async (t) => {
  if (skip(t)) return;
  assert.equal((await provider.healthCheck()).ok, true);
  const a = await provider.provisionExtension('acct-one'); assert.equal(a.created, true); assert.match(a.extension, /^[0-9]{3,8}$/); assert.notEqual(a.extension, '911');
  const again = await provider.provisionExtension('acct-one'); assert.equal(again.created, false); assert.equal(again.extension, a.extension, 'idempotent: the same account always gets the same extension');
  assert.deepEqual(await provider.extensionExists('acct-one'), { exists: true, enabled: true, extension: a.extension }); assert.deepEqual(await provider.extensionExists('acct-never'), { exists: false, enabled: false, extension: null });
  assert.equal((await provider.releaseExtension('acct-one')).released, true); assert.equal((await provider.extensionExists('acct-one')).enabled, false, 'released = disabled; the extension is never handed to anyone else');
  for (const [m, code] of [['provisionNumber', 'PUBLIC_NUMBERS_NOT_SUPPORTED'], ['releaseNumber', 'PUBLIC_NUMBERS_NOT_SUPPORTED'], ['numberExists', 'PUBLIC_NUMBERS_NOT_SUPPORTED'], ['findOwnedByE164', 'PUBLIC_NUMBERS_NOT_SUPPORTED'], ['startCall', 'PSTN_NOT_SUPPORTED'], ['endCall', 'PSTN_NOT_SUPPORTED']]) await assert.rejects(provider[m]({}), (e) => e.code === code, m);
  assert.deepEqual(await provider.listAvailableNumbers('US'), []);
  // credentials: wrong subject, no scope, no credential, and an engine that is not there
  const refused = new QorllaInternalProvider({ engineUrl: r.base, tokenProvider: () => tok('svc:ops') }); await assert.rejects(refused.provisionExtension('x1'), (e) => e.providerStatus === 401 || e.providerStatus === 403, 'a workload without voice.admin');
  const anon = new QorllaInternalProvider({ engineUrl: r.base, tokenProvider: () => 'not.a.jwt' }); await assert.rejects(anon.provisionExtension('x2'), (e) => e.providerStatus === 401);
  const gone = new QorllaInternalProvider({ engineUrl: 'http://127.0.0.1:9', tokenProvider: () => tok('svc:numbers-plans'), timeoutMs: 800 }); assert.equal((await gone.healthCheck()).ok, false); await assert.rejects(gone.provisionExtension('x3'));
  assert.ok(!(await r.admin('GET', '/identities?ids=x1,x2,x3')).body.identities.length, 'nothing was created by the refused calls');
});

test('SERVICE: Numbers & Plans refuses public numbers and PSTN when the configured provider does not declare them; internal extensions need no carrier', async (t) => {
  if (skip(t)) return;
  const fs = await import('node:fs'); const sql = (f) => fs.readFileSync(new URL('../../qorlla-meet-video/sql/' + f, import.meta.url), 'utf8');
  await db.pool.query(sql('v4_14_telephony.sql')); await db.pool.query(sql('v4_16_number_authority.sql')); await db.pool.query(sql('v4_18_billing_hold.sql')); await db.pool.query("INSERT INTO qphone_provider_status(provider, health_ok, health_checked_at) VALUES('qorlla-internal', true, now())");
  const svc = new TelephonyService({ db: db.pool, carrier: provider, bridge: { ready: false }, audio: { ready: false }, env: { PHONE_ALLOWED_COUNTRIES: 'US' } }), ADMIN = { id: 'ops1', admin: true };
  await svc.syncAccount({ accountId: 'acct-two', verified: true, suspended: false });
  await assert.rejects(svc.requestNumber(ADMIN, { country: 'US', assignTo: 'acct-two', idempotencyKey: 'k-' + randomUUID().slice(0, 8) }), (e) => e.code === 'PUBLIC_NUMBERS_NOT_SUPPORTED');
  assert.deepEqual((await svc.availableNumbers(ADMIN, 'US')).numbers, []);
  await assert.rejects(svc.startCall({ id: 'acct-two' }, { to: '+16502530000', idempotencyKey: 'c-' + randomUUID().slice(0, 8) }), (e) => e.code === 'PSTN_NOT_SUPPORTED');
  assert.equal((await db.pool.query('SELECT count(*)::int AS c FROM qphone_provisioning_requests')).rows[0].c, 0, 'nothing was queued');
});

test('INTERNAL CALL LIFECYCLE and REVOCATION: a suspended account\'s call ends, its sockets close, it gets no new relay credentials and cannot call; the other party is told; restoring brings it back', async (t) => {
  if (skip(t)) return;
  const names = ['alice', 'bob']; const ext = {};
  for (const n of names) { await ops('PUT', '/v1/shield/admin/principals', { accountId: n, verified: true }); ext[n] = (await provider.provisionExtension(n)).extension; }
  const a = await r.connect('alice'), b = await r.connect('bob'); const d = await r.dial('alice', ext.bob); assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.ok(await until(() => b.of('incoming')[0]), 'bob is rung'); assert.equal((await r.answer(d.body.call.id, 'bob')).status, 200); assert.ok(await until(() => a.of('state', (m) => m.call?.status === 'active')[0] || a.inbox.find((m) => m.call?.status === 'active')), 'the call is active for both');
  assert.equal((await r.api('alice', 'GET', '/v1/voice/ice')).status, 200, 'relay credentials while in good standing');
  const closed = a.closed, sus = await ops('POST', '/v1/shield/admin/principals/alice/suspend', {}); assert.equal(sus.status, 200);
  assert.equal(await Promise.race([closed, sleepMs(8000).then(() => 'still-open')]), 4003, 'alice\'s signaling socket is closed');
  assert.ok(await until(() => b.inbox.find((m) => m.call?.status === 'ended' && m.call?.end_reason === 'account_disabled'), 8000), 'bob is told the call ended (account_disabled): a cooperative client tears its media down');
  assert.equal((await r.api('alice', 'GET', '/v1/voice/ice')).status, 403, 'no new relay credentials for a suspended account');
  assert.equal((await r.api('alice', 'POST', '/v1/voice/ws-ticket', { deviceId: randomUUID() })).status, 403); assert.equal((await r.dial('alice', ext.bob)).status, 403, 'alice cannot call');
  const toAlice = await r.dial('bob', ext.alice); assert.ok(toAlice.status >= 400, 'and nobody can call alice: ' + toAlice.status);
  assert.equal((await db.pool.query("SELECT count(*)::int AS c FROM voice_calls WHERE status IN ('ringing','active')")).rows[0].c, 0, 'no live call remains in the database');
  assert.equal((await ops('POST', '/v1/shield/admin/principals/alice/restore', {})).body.suspended, false); assert.equal((await provider.extensionExists('alice')).enabled, true, 'restoring brings the identity back');
  await sleepMs(1100); const a2 = await r.connect('alice'); const d2 = await r.dial('alice', ext.bob); assert.equal(d2.status, 201, 'a fresh session can call again'); a2.close(); b.close();
});
