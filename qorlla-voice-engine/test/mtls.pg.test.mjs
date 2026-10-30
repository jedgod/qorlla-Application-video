// A3.4: certificate-based workload identity. Real certificates (generated with openssl for the run), a real mutual-TLS listener on the real engine, real PostgreSQL, real workload tokens bound to the client
// certificate. Nothing is mocked at the TLS layer: a missing, untrusted, expired or revoked certificate fails for real.
// Not proven here: a production certificate issuer/CA, automated rotation, CRL/OCSP distribution, hardware-backed keys, or SPIFFE. Revocation is by thumbprint in the Shield database.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomUUID, randomBytes } from 'node:crypto';
import { exportJWK, importSPKI } from 'jose';
import { isolatedDb, identityProvider } from './helpers.mjs';
import { harness } from './harness.mjs';
import { signWorkloadJwt, createEngineSink } from '../../qorlla-meet-video/server/telephony/number-sync.mjs';
import { mtlsFetch, certThumbprint } from '../../qorlla-meet-video/server/telephony/workload-transport.mjs';
import { QorllaInternalProvider } from '../../qorlla-meet-video/server/telephony/qorlla-internal.mjs';

const ISSUER = 'qorlla-workload', require = createRequire(import.meta.url);
let db, idp, h, r, dir, pki = {}, pem, jwksSrv, jwksUrl, mtlsPort, bridgeJwk = null, plain, bridge, bdir;
const ossl = (...args) => { const x = spawnSync('openssl', args, { encoding: 'utf8' }); if (x.status !== 0) throw new Error('openssl ' + args.slice(0, 3).join(' ') + ': ' + x.stderr); };
function pkiInit() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmtls-')); const f = (n) => path.join(dir, n);
  const ca = (name) => { ossl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', f(name + '.key'), '-out', f(name + '.crt'), '-subj', '/CN=' + name, '-days', '2'); };
  ca('test-ca'); ca('rogue-ca');
  const leaf = (name, signer, { server = false, dates = ['-days', '2'] } = {}) => {
    ossl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', f(name + '.key'), '-out', f(name + '.csr'), '-subj', '/CN=' + name);
    fs.writeFileSync(f(name + '.ext'), server ? 'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n' : 'extendedKeyUsage=clientAuth\n');
    ossl('x509', '-req', '-in', f(name + '.csr'), '-CA', f(signer + '.crt'), '-CAkey', f(signer + '.key'), '-CAcreateserial', '-out', f(name + '.crt'), ...dates, '-extfile', f(name + '.ext'));
  };
  leaf('server', 'test-ca', { server: true }); leaf('good', 'test-ca'); leaf('good2', 'test-ca'); leaf('other', 'test-ca'); leaf('rogue', 'rogue-ca');
  leaf('expired', 'test-ca', { dates: ['-not_before', '20200101000000Z', '-not_after', '20200102000000Z'] });
  for (const n of ['test-ca', 'server', 'good', 'good2', 'other', 'rogue', 'expired']) pki[n] = { cert: fs.readFileSync(f(n + '.crt')), key: fs.readFileSync(f(n + '.key')) };
}
async function workload() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = { ...(await exportJWK(await importSPKI(publicKey.export({ type: 'spki', format: 'pem' }), 'ES256'))), kid: 'w1', alg: 'ES256', use: 'sig' };
  const srv = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: bridgeJwk ? [jwk, bridgeJwk] : [jwk] })); }); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), srv, url: 'http://127.0.0.1:' + srv.address().port + '/jwks.json' };
}
/** a request over the mutual-TLS listener presenting `client` (or nothing); resolves { status, body } or { tlsError } */
const over = (client, token, p, body, method = 'POST') => new Promise((ok) => {
  const req = https.request({ host: '127.0.0.1', port: mtlsPort, path: p, method, ca: pki['test-ca'].cert, ...(client ? { cert: pki[client].cert, key: pki[client].key } : {}), headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, timeout: 8000 }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok({ status: res.statusCode, body: (() => { try { return JSON.parse(d); } catch { return {}; } })() })); });
  req.on('error', (e) => ok({ tlsError: e.code || e.message })); req.end(body === undefined ? undefined : JSON.stringify(body));
});
const tok = (sub, boundTo, o = {}) => signWorkloadJwt({ privateKeyPem: pem, kid: 'w1', issuer: ISSUER, subject: sub, cnfThumbprint: boundTo ? certThumbprint(pki[boundTo].cert) : undefined, ...o });
const PRINCIPAL = (id) => ({ accountId: id, verified: true });

before(async () => {
  db = await isolatedDb(); if (!db) return; pkiInit(); idp = await identityProvider(); const w = await workload(); pem = w.pem; jwksSrv = w.srv; jwksUrl = w.url; h = harness({ db, idp });
  const env = { VOICE_NUMBERS_ENABLED: 'true', SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_REQUIRE_MTLS: 'true', SHIELD_WORKLOAD_JWKS_URL: jwksUrl, SHIELD_WORKLOAD_ISSUER: ISSUER, SHIELD_NUMBERS_AUTHORITY: 'svc:numbers-plans',
    SHIELD_WORKLOAD_ALLOWED: 'svc:good=shield.admin|shield.suspend|voice.admin|shield.cert.revoke;svc:other=voice.admin;svc:noscope=guest.admit;svc:numbers-plans=numbers.sync|voice.admin;svc:main-app=shield.admin|shield.suspend' };
  r = await h.replica({ env }); mtlsPort = await r.voice.listenMtls(0, '127.0.0.1', { key: pki.server.key, cert: pki.server.cert, ca: pki['test-ca'].cert });
  // the main app's bridge (its own signing key) is created BEFORE the engine first fetches the issuer's keys, so its key is known from the start
  const createShieldBridge = require('../../shield-bridge.js'); bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbridge-'));
  bridge = createShieldBridge({ dataDir: bdir, env: { SHIELD_SYNC_URL: 'https://127.0.0.1:' + mtlsPort, SHIELD_WORKLOAD_ISSUER: ISSUER }, listAccounts: () => [], transport: { fetchImpl: mtlsFetch({ ca: pki['test-ca'].cert, cert: pki.good2.cert, key: pki.good2.key }), thumbprint: certThumbprint(pki.good2.cert) }, log: { warn() {}, error() {} } }); bridgeJwk = bridge.publicJwk();
  plain = await h.replica({ env: { ...env, SHIELD_REQUIRE_MTLS: undefined }, outbox: false, maintenance: false });                 // the same engine NOT requiring mTLS (transition / backward compatibility)
});
after(async () => { if (h) await h.closeAll(); if (idp) await idp.close(); if (jwksSrv) await new Promise((ok) => jwksSrv.close(ok)); if (db) await db.drop(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); if (bdir) fs.rmSync(bdir, { recursive: true, force: true }); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable (or openssl missing)');

test('TLS layer: no certificate, a certificate from the wrong CA, and an expired certificate are refused at the handshake; the listener serves workload routes only', async (t) => {
  if (skip(t)) return;
  const t1 = tok('svc:good', 'good');
  assert.ok((await over(null, t1, '/v1/shield/admin/principals', PRINCIPAL('p0'))).tlsError, 'no client certificate');
  assert.ok((await over('rogue', tok('svc:good', 'rogue'), '/v1/shield/admin/principals', PRINCIPAL('p0'))).tlsError, 'certificate signed by another CA');
  assert.ok((await over('expired', tok('svc:good', 'expired'), '/v1/shield/admin/principals', PRINCIPAL('p0'))).tlsError, 'expired certificate');
  const ok = await over('good', t1, '/v1/shield/admin/principals', PRINCIPAL('p0'), 'PUT'); assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.equal((await over('good', tok('svc:good', 'good'), '/v1/voice/me', undefined, 'GET')).status, 404, 'user routes are not served on the workload listener');
  assert.equal((await over('good', tok('svc:good', 'good'), '/healthz', undefined, 'GET')).status, 404);
});

test('BINDING: the token must be bound to the certificate on THIS connection; a certificate alone grants nothing; a stolen token is useless; a replay is refused; scopes still come from the allow-list', async (t) => {
  if (skip(t)) return;
  const put = (client, token) => over(client, token, '/v1/shield/admin/principals', PRINCIPAL('p1'), 'PUT');
  assert.equal((await put('good', tok('svc:good', 'good'))).status, 200);
  assert.equal((await put('other', tok('svc:good', 'good'))).status, 401, 'a token bound to certificate A presented on certificate B (stolen token)');
  assert.equal((await put('good', tok('svc:good', 'other'))).status, 401, 'a token bound to B presented on A');
  assert.equal((await put('good', tok('svc:good', null))).status, 401, 'a token with no binding when mTLS is required');
  assert.equal((await put('good', 'garbage')).status, 401); assert.equal((await put('good', undefined)).status, 401, 'a valid certificate and no token');
  assert.equal((await put('good', tok('svc:noscope', 'good'))).status, 403, 'a valid certificate and a bound token WITHOUT the scope: certificate alone grants no administrative permission');
  assert.equal((await put('good', tok('svc:stranger', 'good'))).status, 403, 'a subject that is not on the allow-list');
  const once = tok('svc:good', 'good'); assert.equal((await put('good', once)).status, 200); assert.equal((await put('good', once)).status, 401, 'the same bound token twice (replay)');
  assert.equal((await put('good', tok('svc:good', 'good', { ttlSeconds: 3600 }))).status, 401, 'lifetime above 5 minutes');
  assert.ok((await db.pool.query("SELECT 1 FROM shield_events WHERE decision='DENY' AND reason='CERT_PROOF_FAILED'")).rowCount >= 3, 'refused proofs are audited');
  // the plain listener cannot carry a workload request when mTLS is required, and a bound token never works without its proof
  const viaPlain = (token) => fetch(r.base + '/v1/shield/admin/principals', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(PRINCIPAL('p2')) }).then((x) => x.status);
  assert.equal(await viaPlain(tok('svc:good', 'good')), 401); assert.equal(await viaPlain(tok('svc:good', null)), 401, 'mTLS required: unbound tokens are refused on the plain listener too');
  assert.equal((await fetch(plain.base + '/v1/shield/admin/principals', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok('svc:good', 'good') }, body: JSON.stringify(PRINCIPAL('p2')) })).status, 401, 'even where mTLS is not required, a certificate-bound token without its certificate is refused');
  assert.equal((await fetch(plain.base + '/v1/shield/admin/principals', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok('svc:good', null) }, body: JSON.stringify(PRINCIPAL('p2')) })).status, 200, 'transition: unbound tokens still work where mTLS is not required');
});

test('ROTATION and REVOCATION: a rotated certificate needs a newly bound token; a revoked certificate is refused although it is valid, trusted and its token is fresh; revoking needs its own scope', async (t) => {
  if (skip(t)) return;
  const put = (client, token) => over(client, token, '/v1/shield/admin/principals', PRINCIPAL('p3'), 'PUT');
  assert.equal((await put('good2', tok('svc:good', 'good'))).status, 401, 'after rotation the old token does not work on the new certificate');
  assert.equal((await put('good2', tok('svc:good', 'good2'))).status, 200, 'the new certificate with a token bound to it');
  const thumb = certThumbprint(pki.good.cert);
  assert.equal((await over('other', tok('svc:other', 'other'), '/v1/shield/admin/certs/revoke', { thumbprint: thumb, reason: 'key compromised' })).status, 403, 'revocation is its own scope');
  assert.equal((await over('good2', tok('svc:good', 'good2'), '/v1/shield/admin/certs/revoke', { thumbprint: 'short', reason: 'x' })).status, 400);
  const rev = await over('good2', tok('svc:good', 'good2'), '/v1/shield/admin/certs/revoke', { thumbprint: thumb, reason: 'key compromised' }); assert.equal(rev.status, 200, JSON.stringify(rev));
  assert.equal((await put('good', tok('svc:good', 'good'))).status, 401, 'the revoked certificate is refused at once');
  assert.equal((await put('good2', tok('svc:good', 'good2'))).status, 200, 'the rotated certificate keeps working');
  assert.equal((await db.pool.query('SELECT reason FROM shield_revoked_certs WHERE thumbprint=$1', [thumb])).rows[0].reason, 'key compromised'); assert.ok((await db.pool.query("SELECT 1 FROM shield_events WHERE action='cert.revoke'")).rowCount);
  // suspension has a scope of its own: provisioning rights alone do not allow it
  assert.equal((await over('other', tok('svc:other', 'other'), '/v1/shield/admin/principals/p3/suspend', {})).status, 403);
  assert.equal((await over('good2', tok('svc:good', 'good2'), '/v1/shield/admin/principals/p3/suspend', {})).status, 200);
});

test('CLIENTS over mutual TLS: Numbers & Plans (event sink), the internal provider and the main app bridge all authenticate with their certificate and a bound token', async (t) => {
  if (skip(t)) return;
  const fx = (client) => mtlsFetch({ ca: pki['test-ca'].cert, cert: pki[client].cert, key: pki[client].key }), base = 'https://127.0.0.1:' + mtlsPort;
  // Numbers & Plans delivering an authority event
  const sid = 'PN' + randomBytes(10).toString('hex'), sink = createEngineSink({ url: base, privateKeyPem: pem, issuer: ISSUER, kid: 'w1', fetchImpl: fx('good2'), cnfThumbprint: certThumbprint(pki.good2.cert) });
  const ev = { eventId: randomUUID(), providerNumberId: sid, version: 1, type: 'number.changed', payload: { providerNumberId: sid, e164: '+14155559911', country: 'US', kind: 'personal', accountId: 'p3', state: 'active', callerIdVerified: true, hold: false, version: 1 } };
  // the authority subject is svc:numbers-plans (default); its certificate here is 'good2'
  assert.equal((await sink(ev)).result, 'applied'); assert.equal((await sink(ev)).result, 'duplicate');
  const unbound = createEngineSink({ url: base, privateKeyPem: pem, issuer: ISSUER, kid: 'w1', fetchImpl: fx('good2') }); await assert.rejects(unbound({ ...ev, eventId: randomUUID() }), /engine_refused_401/, 'no binding, no entry');
  const wrongCert = createEngineSink({ url: base, privateKeyPem: pem, issuer: ISSUER, kid: 'w1', fetchImpl: fx('other'), cnfThumbprint: certThumbprint(pki.good2.cert) }); await assert.rejects(wrongCert({ ...ev, eventId: randomUUID() }), /engine_refused_401/, 'token bound to another certificate');
  // the internal provider managing an extension
  const prov = new QorllaInternalProvider({ engineUrl: base, fetchImpl: fx('good2'), tokenProvider: () => tok('svc:numbers-plans', 'good2') }); const a = await prov.provisionExtension('mtls-acct'); assert.match(a.extension, /^[0-9]{3,8}$/);
  assert.equal((await new QorllaInternalProvider({ engineUrl: base, fetchImpl: fx('good2'), tokenProvider: () => tok('svc:numbers-plans', 'other') }).provisionExtension('mtls-acct2').catch((e) => e.providerStatus)), 401);
  assert.equal((await new QorllaInternalProvider({ engineUrl: base, fetchImpl: mtlsFetch({ ca: pki['test-ca'].cert, cert: pki.rogue.cert, key: pki.rogue.key }), tokenProvider: () => tok('svc:numbers-plans', 'rogue') }).provisionExtension('mtls-acct3').then(() => 'ok', () => 'refused')), 'refused', 'a certificate from another CA never gets a response');
  // the main app bridge registering an account
  bridge.queue({ id: 'u_bridge1', verified: true, suspended: false }); await new Promise((ok) => setTimeout(ok, 800)); await bridge.flush();
  assert.equal((await db.pool.query("SELECT verified FROM shield_principals WHERE account_id='u_bridge1'")).rows[0]?.verified, true, 'the main app registered the account over mutual TLS');
  assert.equal(require('../../shield-bridge.js').transportFromEnv({}), null, 'no certificate configured = no transport (never a silent downgrade of a configured one: the bridge reads the files or fails)');
});
