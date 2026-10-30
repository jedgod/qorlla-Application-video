// A3.4 / A3.5 against the REAL processes: the real Qorlla Meet (server/index.js) and the real main app (server.js) talk to the engine ONLY over mutual TLS (SHIELD_REQUIRE_MTLS=true), with certificate files they re-read
// while running. Real certificates (openssl), real PostgreSQL, real sockets. Tested: normal operation, certificate ROTATION WITHOUT RESTART, REVOCATION of the certificate a process is currently using (its already-open
// connection is not trusted any further), recovery by rotation, and the alerts all of that raises.
// Not proven: a production CA, automated issuance, CRL/OCSP, hardware-backed keys; behaviour across hosts.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, randomBytes, createHash, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { exportJWK, importSPKI } from 'jose';
import { isolatedDb, identityProvider } from './helpers.mjs';
import { harness, until } from './harness.mjs';
import { signWorkloadJwt } from '../../qorlla-meet-video/server/telephony/number-sync.mjs';
import { certThumbprint } from '../../qorlla-meet-video/server/telephony/workload-transport.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..'), req = createRequire(path.join(root, 'package.json'));
let ioc, bcrypt, secrets = null; try { ioc = req('socket.io-client').io; bcrypt = req('bcryptjs'); secrets = JSON.parse(fs.readFileSync(path.join(root, '.dev-stack', 'secrets.json'), 'utf8')); } catch { /* skipped below */ }
const ISSUER = 'qorlla-workload', PASSWORD = 'Handoff-pass-9917!x', ENGINE_ADMIN = 'e'.repeat(40);
const MEET_SQL = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', 'v4_7_recording_consent.sql', 'v4_8_collab.sql', 'v4_9_recording_storage.sql', 'v4_10_admission.sql', 'v4_11_history.sql', 'v4_12_limit.sql', 'v4_13_phone.sql', 'v4_14_telephony.sql', 'v4_15_telephony_features.sql', 'v4_16_number_authority.sql', 'v4_17_shield_identity.sql', 'v4_18_billing_hold.sql'];
let db, h, engine, mtlsPort, dir, pki = {}, keys = {}, ports, jwksSrv, children = [], meetBase, mainBase, dataDir, mtlsEngineBase;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const free = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const waitHttp = async (url, ms = 90000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url)).status < 500) return true; } catch { /* not yet */ } await sleep(300); } throw new Error('did not start: ' + url); };
const ossl = (...a) => { const x = spawnSync('openssl', a, { encoding: 'utf8' }); if (x.status !== 0) throw new Error('openssl: ' + x.stderr); };
const f = (n) => path.join(dir, n);
const leaf = (name, server) => { ossl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', f(name + '.key'), '-out', f(name + '.csr'), '-subj', '/CN=' + name); fs.writeFileSync(f(name + '.ext'), server ? 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' : 'extendedKeyUsage=clientAuth\n'); ossl('x509', '-req', '-in', f(name + '.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f(name + '.crt'), '-days', '2', '-extfile', f(name + '.ext')); pki[name] = { cert: fs.readFileSync(f(name + '.crt')), key: fs.readFileSync(f(name + '.key')) }; };
const keypair = async (kid) => { const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }); return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), jwk: { ...(await exportJWK(await importSPKI(publicKey.export({ type: 'spki', format: 'pem' }), 'ES256'))), kid, alg: 'ES256', use: 'sig' } }; };
const q = (text, p) => db.pool.query(text, p);
/** Operator calls over mTLS with the 'ops' certificate. */
const ops = (method, p, body) => new Promise((ok) => {
  const token = signWorkloadJwt({ privateKeyPem: keys.ops.pem, kid: 'wo', issuer: ISSUER, subject: 'svc:ops', cnfThumbprint: certThumbprint(pki.ops.cert) });
  const rq = https.request({ host: '127.0.0.1', port: mtlsPort, path: p, method, ca: pki.ca.cert, cert: pki.ops.cert, key: pki.ops.key, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, timeout: 8000 }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok({ status: res.statusCode, body: (() => { try { return JSON.parse(d); } catch { return {}; } })() })); });
  rq.on('error', (e) => ok({ tlsError: e.code })); rq.end(body === undefined ? undefined : JSON.stringify(body));
});
const mainReq = async (cookie, method, p, body) => { const r = await fetch(mainBase + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }); return { status: r.status, body: await r.json().catch(() => ({})), cookie: (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ') }; };
async function account(name, verified) {
  const username = name + randomBytes(2).toString('hex'), r = await mainReq('', 'POST', '/api/auth/register', { username, displayName: name, password: PASSWORD, email: username + '@example.test' }); assert.equal(r.status, 201, JSON.stringify(r.body)); const a = { username, id: r.body.user.id, cookie: r.cookie };
  if (verified) { const raw = randomBytes(32).toString('hex'), file = path.join(dataDir, 'auth', 'tokens.json'), list = JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); list.push({ hash: createHash('sha256').update(raw).digest('hex'), userId: a.id, purpose: 'verify', exp: Date.now() + 3600e3, email: username + '@example.test' }); fs.writeFileSync(file, JSON.stringify(list)); assert.equal((await mainReq('', 'POST', '/api/auth/verify', { token: raw })).status, 200); }
  return a;
}
const meetApi = async (method, p, body, { bridge = false, token } = {}) => { const r = await fetch(meetBase + p, { method, headers: { 'content-type': 'application/json', ...(bridge ? { 'x-qorlla-bridge-secret': secrets.bridge } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const schedule = async (hostAccountId) => { const passcode = 'meet-pass-' + randomBytes(3).toString('hex'), r = await meetApi('POST', '/api/integrations/scheduled-meetings', { sourceId: 'mt-' + randomUUID().slice(0, 12), title: 'mTLS meeting', ownerName: 'Host', passcodeHash: bcrypt.hashSync(passcode, 10), waitingRoom: false, joinBeforeHost: true, hostAccountId }, { bridge: true }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { id: r.body.meetingId, hostSecret: r.body.hostSecret, passcode }; };
const joinAsHost = (m, accountId) => meetApi('POST', `/api/meetings/${m.id}/join`, { name: 'Host', hostSecret: m.hostSecret, accountId }, { bridge: true });
const connect = (token) => new Promise((ok) => { const s = ioc(meetBase, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 8000 }); s.once('connect', () => ok({ socket: s, ok: true })); s.once('connect_error', (e) => { s.close(); ok({ ok: false, error: e.message }); }); });
const alerts = async () => (await ops('GET', '/v1/shield/alerts?state=active', undefined)).body.alerts || [];
const writeCreds = (who, from) => { fs.copyFileSync(f(from + '.key'), f(who + '-live.key')); fs.copyFileSync(f(from + '.crt'), f(who + '-live.crt')); };

before(async () => {
  if (!ioc || !bcrypt || !secrets) return; db = await isolatedDb(); if (!db) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmtlsp-')); ossl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', f('ca.key'), '-out', f('ca.crt'), '-subj', '/CN=proc-ca', '-days', '2'); pki.ca = { cert: fs.readFileSync(f('ca.crt')) };
  leaf('server', true); for (const n of ['ops', 'meet1', 'meet2', 'meet3', 'main1', 'main2']) leaf(n);
  writeCreds('meet', 'meet1'); writeCreds('main', 'main1'); fs.copyFileSync(f('ca.crt'), f('ca-live.crt'));
  for (const n of ['meet', 'ops']) keys[n] = await keypair(n === 'meet' ? 'wm' : 'wo');
  ports = { main: await free(), meet: await free(), agg: await free() }; dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qshield-main-')); fs.mkdirSync(path.join(dataDir, 'auth'), { recursive: true }); fs.writeFileSync(path.join(dataDir, 'auth', 'tokens.json'), '[]');
  jwksSrv = http.createServer(async (_q, res) => { const k = [keys.meet.jwk, keys.ops.jwk]; try { k.push(...((await fetch(`http://127.0.0.1:${ports.main}/.well-known/shield-workload-jwks.json`).then((r) => r.json())).keys || [])); } catch { /* main not up yet */ } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: k })); }); await new Promise((ok) => jwksSrv.listen(ports.agg, '127.0.0.1', ok));
  const idp = await identityProvider(); h = harness({ db, idp });
  engine = await h.replica({ env: { SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_REQUIRE_MTLS: 'true', SHIELD_WORKLOAD_JWKS_URL: `http://127.0.0.1:${ports.agg}/`, SHIELD_WORKLOAD_ISSUER: ISSUER, VOICE_ADMIN_SECRET: ENGINE_ADMIN,
    SHIELD_WORKLOAD_ALLOWED: 'svc:main-app=shield.admin|shield.suspend;svc:meet=meet.register|meet.signal|alerts.report;svc:ops=shield.admin|shield.suspend|shield.cert.revoke|alerts.read|alerts.ack',
    SHIELD_ALERT_INTERVAL_SECONDS: '1', VOICE_JWKS_URL: `http://127.0.0.1:${ports.main}/.well-known/voice-jwks.json`, VOICE_JWT_ISSUER: 'qorlla-main', VOICE_JWT_AUDIENCE: 'qorlla-voice' } });
  mtlsPort = await engine.voice.listenMtls(0, '127.0.0.1', { key: pki.server.key, cert: pki.server.cert, ca: pki.ca.cert }); mtlsEngineBase = 'https://127.0.0.1:' + mtlsPort;
  const c = await db.admin.connect(); try { await c.query('SET search_path TO ' + db.schema); for (const m of MEET_SQL) await c.query(fs.readFileSync(path.join(root, 'qorlla-meet-video', 'sql', m), 'utf8')); } finally { await c.query('SET search_path TO public').catch(() => {}); c.release(); }
  const env = (extra) => { const e = { ...process.env }; delete e.DATABASE_URL; return Object.assign(e, { PGOPTIONS: '-c search_path=' + db.schema }, extra); }, logOf = (n) => fs.openSync(path.join(os.tmpdir(), 'qshield-' + n + '.log'), 'w');
  meetBase = `http://127.0.0.1:${ports.meet}`; mainBase = `http://127.0.0.1:${ports.main}`; const rec = fs.mkdtempSync(path.join(os.tmpdir(), 'qshield-rec-'));
  const tls = (who) => ({ SHIELD_CLIENT_CERT: f(who + '-live.crt'), SHIELD_CLIENT_KEY: f(who + '-live.key'), SHIELD_CA: f('ca-live.crt'), SHIELD_CERT_RELOAD_SECONDS: '1' });
  children.push(spawn(process.execPath, ['server/index.js'], { cwd: path.join(root, 'qorlla-meet-video'), stdio: ['ignore', logOf('mmeet'), logOf('mmeet')], env: env({ PORT: String(ports.meet), DATABASE_URL: db.pool.options.connectionString, JWT_SECRET: secrets.jwt, QORLLA_BRIDGE_SECRET: secrets.bridge, RECOVERY_ESCROW_KEY: secrets.escrow, NODE_ENV: 'development', RECORDING_MASTER_KEYS: JSON.stringify({ dev1: secrets.recordingKey }), RECORDING_ACTIVE_KEY_ID: 'dev1', RECORDING_STORE_DIR: rec, RECORDING_ADMIN_SECRET: 'test-admin-secret', PHONE_PROVIDER: 'test', PHONE_WEBHOOK_SECRET: 'phone-test-secret-123456',
    SHIELD_MEET_ENFORCE: 'true', SHIELD_URL: mtlsEngineBase, SHIELD_MEET_KEY_PEM: keys.meet.pem.replace(/\n/g, '\\n'), SHIELD_WORKLOAD_ISSUER: ISSUER, SHIELD_WORKLOAD_KID: 'wm', SHIELD_RECHECK_SECONDS: '1', ...tls('meet') }) }));
  children.push(spawn(process.execPath, ['server.js'], { cwd: root, stdio: ['ignore', logOf('mmain'), logOf('mmain')], env: env({ PORT: String(ports.main), DATA_DIR: dataDir, MEET_PROBE_URL: meetBase, MEET_INTERNAL_URL: meetBase, QORLLA_BRIDGE_SECRET: secrets.bridge, MEET_DETECT: '', MEET_PUBLIC_URL: '', SHIELD_SYNC_URL: mtlsEngineBase, SHIELD_WORKLOAD_ISSUER: ISSUER, SHIELD_REQUIRE_VERIFIED: 'true', SHIELD_RECONCILE_SECONDS: '2', PHONE_ADMIN_USERS: 'adminx*', ...tls('main') }) }));
  await waitHttp(meetBase + '/api/health'); await waitHttp(mainBase + '/');
});
after(async () => { for (const c of children) { try { c.kill(); } catch { /* gone */ } } if (h) await Promise.race([h.closeAll().catch(() => {}), sleep(3000)]); if (jwksSrv) await Promise.race([new Promise((ok) => jwksSrv.close(ok)), sleep(2000)]); if (db) await db.drop(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true }); setTimeout(() => process.exit(process.exitCode || 0), 1500).unref(); });
const skip = (t) => !db && t.skip('needs PostgreSQL, openssl, the dev-stack secrets and node_modules');

test('REAL PROCESSES over mutual TLS: the main app registers accounts, Meet asks the Shield before every signaling session, suspension reaches open Meet sessions; no certificate failure alerts in normal operation', async (t) => {
  if (skip(t)) return;
  const host = await account('hosta', true); const p = await until(async () => (await q('SELECT * FROM shield_principals WHERE account_id=$1', [host.id])).rows.find((x) => x.verified) || null, 20000); assert.ok(p, 'the main app process registered a verified account through the mTLS listener');
  const m = await schedule(host.id), j = await joinAsHost(m, host.id), s1 = await connect(j.body.token); assert.equal(s1.ok, true, 'Meet process -> engine over mTLS: authorized'); assert.ok((await q("SELECT 1 FROM shield_events WHERE action='meet.signal' AND decision='ALLOW' AND actor=$1", [host.id])).rowCount);
  const guest = await meetApi('POST', `/api/meetings/${m.id}/join`, { name: 'Guest', passcode: m.passcode }); const g = await connect(guest.body.token); assert.equal(g.ok, true);
  const gone = new Promise((ok) => { s1.socket.once('session_revoked', (e) => ok(e.reason)); s1.socket.once('disconnect', () => ok('disconnect')); }); assert.equal((await ops('POST', `/v1/shield/admin/principals/${encodeURIComponent(host.id)}/suspend`, {})).status, 200);
  assert.ok(['SUSPENDED', 'disconnect'].includes(await Promise.race([gone, sleep(15000).then(() => 'still-open')])), 'the open Meet session was terminated after a suspension that came over mTLS'); g.socket.close();
  assert.equal((await alerts()).filter((a) => /certificate|binding|revoked|replay/.test(a.kind)).length, 0, 'no certificate or binding alerts while everything is healthy');
});

test('ROTATION WITHOUT RESTART: replacing the certificate files of the RUNNING Meet process takes effect on its own; the old certificate can then be revoked without any outage', async (t) => {
  if (skip(t)) return;
  const host = await account('rotator', true); await until(async () => (await q('SELECT 1 FROM shield_principals WHERE account_id=$1 AND verified', [host.id])).rowCount, 20000);
  const m = await schedule(host.id), join = async () => { const j = await joinAsHost(m, host.id); return (await connect(j.body.token)); };
  const before = await join(); assert.equal(before.ok, true); before.socket.close();
  writeCreds('meet', 'meet2'); await sleep(2500);                                       // the process re-reads its files (SHIELD_CERT_RELOAD_SECONDS=1) and starts presenting meet2
  assert.equal((await ops('POST', '/v1/shield/admin/certs/revoke', { thumbprint: certThumbprint(pki.meet1.cert), reason: 'rotated out' })).status, 200);
  const after = await join(); assert.equal(after.ok, true, 'Meet kept working after its OLD certificate was revoked: it had already rotated to the new one without a restart'); after.socket.close();
  const stillMain = (await alerts()).filter((a) => a.kind === 'revoked_certificate_attempt'); assert.equal(stillMain.length, 0, 'nobody used the revoked certificate after rotation');
  // a corrupt drop of new files must not take the service down: it keeps the last good credentials
  fs.writeFileSync(f('meet-live.crt'), 'not a certificate'); await sleep(2500); const corrupt = await join(); assert.equal(corrupt.ok, true, 'a corrupt rotation keeps the previous good credentials'); corrupt.socket.close(); writeCreds('meet', 'meet2');
});

test('REVOCATION of the certificate a process is USING: its established connection is not trusted any further (fail closed, alerted); rotating to a fresh certificate restores service with no restart', async (t) => {
  if (skip(t)) return;
  const host = await account('revoked', true); await until(async () => (await q('SELECT 1 FROM shield_principals WHERE account_id=$1 AND verified', [host.id])).rowCount, 20000);
  const m = await schedule(host.id), join = async () => connectJoin(await joinAsHost(m, host.id)), connectJoin = (j) => connect(j.body.token);
  const ok = await join(); assert.equal(ok.ok, true, 'works with meet2 (keep-alive connection open)'); ok.socket.close();
  assert.equal((await ops('POST', '/v1/shield/admin/certs/revoke', { thumbprint: certThumbprint(pki.meet2.cert), reason: 'key stolen' })).status, 200);
  const refused = await join(); assert.equal(refused.ok, false, 'the very next request is refused: revocation is checked per request, so an already-open connection gains nothing');
  const rev = await until(async () => (await alerts()).find((a) => a.kind === 'revoked_certificate_attempt' && a.severity === 'critical') || null, 10000); assert.ok(rev, 'a critical alert names the revoked certificate'); assert.equal(rev.context.detail.discriminator, certThumbprint(pki.meet2.cert)); assert.equal(rev.context.workload, 'svc:meet');
  writeCreds('meet', 'meet3'); await sleep(2500); const back = await join(); assert.equal(back.ok, true, 'a new certificate restores service without restarting Meet'); back.socket.close();
  // the main app process: revoke its certificate, then rotate it, all while running
  const before = await account('pre-rotate', false); assert.ok(await until(async () => (await q('SELECT 1 FROM shield_principals WHERE account_id=$1', [before.id])).rowCount, 20000));
  assert.equal((await ops('POST', '/v1/shield/admin/certs/revoke', { thumbprint: certThumbprint(pki.main1.cert), reason: 'main app key stolen' })).status, 200); await sleep(1200);
  const blocked = await account('blocked', false); await sleep(3500); assert.equal((await q('SELECT 1 FROM shield_principals WHERE account_id=$1', [blocked.id])).rowCount, 0, 'with its certificate revoked the main app can no longer register accounts');
  assert.ok(await until(async () => (await alerts()).find((a) => a.kind === 'revoked_certificate_attempt' && a.context.workload === 'svc:main-app') || null, 10000), 'and that is alerted');
  writeCreds('main', 'main2'); assert.ok(await until(async () => (await q('SELECT 1 FROM shield_principals WHERE account_id=$1', [blocked.id])).rowCount, 30000), 'after rotation the main app catches up on its own (retry + reconcile), no restart');
});
