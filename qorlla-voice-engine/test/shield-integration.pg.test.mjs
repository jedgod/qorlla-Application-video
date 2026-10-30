// Security Shield, INTEGRATED: the real Main App (server.js), the real Qorlla Meet (server/index.js, with the shield enforcing at its signaling gate), and the real Voice Engine (in process, real PostgreSQL),
// talking to each other over HTTP/WebSocket with real workload credentials. Nothing here calls a policy function directly.
// Test doubles, stated honestly: the workload "issuer" is a tiny JWKS server that publishes the main app's real public key plus the keys of the Meet process and a test operator; production needs a real workload identity
// provider (SPIFFE/SPIRE or mTLS). There is no media server in this repository, so "media access" is the Meet signaling session (the only gate that exists).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, createHash, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
import { exportJWK, importSPKI } from 'jose';
import { isolatedDb, identityProvider } from './helpers.mjs';
import { harness, ORIGIN, until } from './harness.mjs';
import { PROTOCOL } from '../src/tickets.mjs';
import { signWorkloadJwt } from '../../qorlla-meet-video/server/telephony/number-sync.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const req = createRequire(path.join(root, 'package.json'));
let ioc, bcrypt, secrets = null;
try { ioc = req('socket.io-client').io; bcrypt = req('bcryptjs'); secrets = JSON.parse(fs.readFileSync(path.join(root, '.dev-stack', 'secrets.json'), 'utf8')); } catch { /* skipped below */ }
const PASSWORD = 'Handoff-pass-9917!x', ENGINE_ADMIN = 'e'.repeat(40), ISSUER = 'qorlla-workload';
const MEET_SQL = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', 'v4_7_recording_consent.sql', 'v4_8_collab.sql', 'v4_9_recording_storage.sql', 'v4_10_admission.sql', 'v4_11_history.sql', 'v4_12_limit.sql', 'v4_13_phone.sql', 'v4_14_telephony.sql', 'v4_15_telephony_features.sql', 'v4_16_number_authority.sql', 'v4_17_shield_identity.sql', 'v4_18_billing_hold.sql'];

let db, h, engine, meet, main, jwksSrv, ports, dataDir, startMeet, children = [], keys = {};
const free = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const waitHttp = async (url, ms = 90000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url)).status < 500) return true; } catch { /* not yet */ } await sleep(300); } throw new Error('did not start: ' + url); };
const keypair = async (kid) => { const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }); return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), jwk: { ...(await exportJWK(await importSPKI(publicKey.export({ type: 'spki', format: 'pem' }), 'ES256'))), kid, alg: 'ES256', use: 'sig' } }; };
const q = (text, p) => db.pool.query(text, p);

/** Signs a workload credential as one of the test keys and calls the engine. */
const as = (who, method, p, body, o = {}) => fetch(engine.base + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (o.token || signWorkloadJwt({ privateKeyPem: keys[who].pem, kid: keys[who].jwk.kid, issuer: ISSUER, subject: o.sub || 'svc:' + who })) }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const mainReq = async (cookie, method, p, body) => { const r = await fetch(main.base + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }); return { status: r.status, body: await r.json().catch(() => ({})), cookie: (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ') }; };
async function account(name, { verified = false } = {}) {
  const username = name + randomBytes(2).toString('hex'), r = await mainReq('', 'POST', '/api/auth/register', { username, displayName: name, password: PASSWORD, email: username + '@example.test' }); assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = { username, id: r.body.user.id, cookie: r.cookie };
  if (verified) await verify(a); return a;
}
async function verify(a) {                                  // the REAL verify route, with a one-time token we plant in the (plain JSON) token store
  const raw = randomBytes(32).toString('hex'), file = path.join(dataDir, 'auth', 'tokens.json'), list = JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
  list.push({ hash: createHash('sha256').update(raw).digest('hex'), userId: a.id, purpose: 'verify', exp: Date.now() + 3600e3, email: a.username + '@example.test' }); fs.writeFileSync(file, JSON.stringify(list));
  const r = await mainReq('', 'POST', '/api/auth/verify', { token: raw }); assert.equal(r.status, 200, JSON.stringify(r.body));
}
const principal = (id) => until(async () => (await q('SELECT * FROM shield_principals WHERE account_id=$1', [id])).rows[0] || null, 20000);
const principalWhere = (id, pred) => until(async () => { const p = (await q('SELECT * FROM shield_principals WHERE account_id=$1', [id])).rows[0]; return p && pred(p) ? p : null; }, 20000);
async function voiceToken(a) { return mainReq(a.cookie, 'POST', '/api/voice/token', {}); }
const meetApi = async (method, p, body, { bridge = false, token } = {}) => { const r = await fetch(meet.base + p, { method, headers: { 'content-type': 'application/json', ...(bridge ? { 'x-qorlla-bridge-secret': secrets.bridge } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
async function schedule({ hostAccountId, orgId, guestAccess, waitingRoom = false, passcode = 'meet-pass-' + randomBytes(3).toString('hex') } = {}) {
  const r = await meetApi('POST', '/api/integrations/scheduled-meetings', { sourceId: 'it-' + randomUUID().slice(0, 12), title: 'Integrated meeting', ownerName: 'Host', passcodeHash: bcrypt.hashSync(passcode, 10), waitingRoom, joinBeforeHost: true, ...(hostAccountId ? { hostAccountId } : {}), ...(orgId ? { orgId } : {}), ...(typeof guestAccess === 'boolean' ? { guestAccess } : {}) }, { bridge: true });
  assert.equal(r.status, 201, JSON.stringify(r.body)); return { id: r.body.meetingId, hostSecret: r.body.hostSecret, passcode };
}
const join = (m, body, bridge = false) => meetApi('POST', `/api/meetings/${m.id}/join`, body, { bridge });
const connect = (token) => new Promise((ok) => { const s = ioc(meet.base, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 8000 }); s.once('connect', () => ok({ socket: s, ok: true })); s.once('connect_error', (e) => { s.close(); ok({ ok: false, error: e.message }); }); });

before(async () => {
  if (!ioc || !bcrypt || !secrets) return; db = await isolatedDb(); if (!db) return;
  for (const n of ['meet', 'ops']) keys[n] = await keypair(n === 'meet' ? 'wm' : 'wo');
  ports = { main: await free(), meet: await free(), agg: await free() }; dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qshield-main-'));
  // the test workload issuer: main app's REAL public key (fetched live) + the Meet process key + the operator key
  jwksSrv = http.createServer(async (_q, res) => { const k = [keys.meet.jwk, keys.ops.jwk]; try { const m = await fetch(`http://127.0.0.1:${ports.main}/.well-known/shield-workload-jwks.json`).then((r) => r.json()); k.push(...(m.keys || [])); } catch { /* main not up yet */ } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: k })); });
  await new Promise((ok) => jwksSrv.listen(ports.agg, '127.0.0.1', ok));
  const idp = await identityProvider(); h = harness({ db, idp });
  engine = await h.replica({ env: {
    VOICE_PSTN_ENABLED: 'true', VOICE_NUMBERS_ENABLED: 'true', SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_WORKLOAD_JWKS_URL: `http://127.0.0.1:${ports.agg}/`, SHIELD_WORKLOAD_ISSUER: ISSUER, VOICE_ADMIN_SECRET: ENGINE_ADMIN,
    SHIELD_WORKLOAD_ALLOWED: 'svc:main-app=shield.admin|shield.suspend;svc:meet=meet.register|meet.signal;svc:ops=shield.admin|shield.suspend|pstn.authorize|pstn.consume|pstn.settle|numbers.sync',
    VOICE_JWKS_URL: `http://127.0.0.1:${ports.main}/.well-known/voice-jwks.json`, VOICE_JWT_ISSUER: 'qorlla-main', VOICE_JWT_AUDIENCE: 'qorlla-voice', VOICE_ALLOWED_ORIGIN: ORIGIN, SHIELD_PSTN_RESERVE_CENTS: '100', SHIELD_NUMBERS_AUTHORITY: 'svc:ops' } });
  // Meet: its own schema in the same isolated database, shield enforcing, a 1 s session re-check
  const c = await db.admin.connect(); try { await c.query('SET search_path TO ' + db.schema); for (const f of MEET_SQL) { try { await c.query(fs.readFileSync(path.join(root, 'qorlla-meet-video', 'sql', f), 'utf8')); } catch (e) { throw new Error('Meet migration ' + f + ': ' + e.message); } } } finally { await c.query('SET search_path TO public').catch(() => {}); c.release(); }
  const dbUrl = db.pool.options.connectionString;      // the search_path travels in PGOPTIONS (node-pg reads it), not in the URL
  const env = (extra) => { const e = { ...process.env }; delete e.DATABASE_URL; return Object.assign(e, { PGOPTIONS: '-c search_path=' + db.schema }, extra); };
  meet = { base: `http://127.0.0.1:${ports.meet}` };
  const rec = fs.mkdtempSync(path.join(os.tmpdir(), 'qshield-rec-'));
  startMeet = (port, shieldUrl, tag) => spawn(process.execPath, ['server/index.js'], { cwd: path.join(root, 'qorlla-meet-video'), stdio: ['ignore', logOf(tag), logOf(tag)], env: env({ PORT: String(port), DATABASE_URL: dbUrl, JWT_SECRET: secrets.jwt, QORLLA_BRIDGE_SECRET: secrets.bridge, RECOVERY_ESCROW_KEY: secrets.escrow, NODE_ENV: 'development', RECORDING_MASTER_KEYS: JSON.stringify({ dev1: secrets.recordingKey }), RECORDING_ACTIVE_KEY_ID: 'dev1', RECORDING_STORE_DIR: rec, RECORDING_ADMIN_SECRET: 'test-admin-secret', PHONE_PROVIDER: 'test', PHONE_WEBHOOK_SECRET: 'phone-test-secret-123456',
    SHIELD_MEET_ENFORCE: 'true', SHIELD_URL: shieldUrl, SHIELD_MEET_KEY_PEM: keys.meet.pem.replace(/\n/g, '\\n'), SHIELD_WORKLOAD_ISSUER: ISSUER, SHIELD_WORKLOAD_KID: 'wm', SHIELD_RECHECK_SECONDS: '1' }) });
  const logOf = (n) => fs.openSync(path.join(os.tmpdir(), 'qshield-' + n + '.log'), 'w');
  children.push(spawn(process.execPath, ['server/index.js'], { cwd: path.join(root, 'qorlla-meet-video'), stdio: ['ignore', logOf('meet'), logOf('meet')], env: env({ PORT: String(ports.meet), DATABASE_URL: dbUrl, JWT_SECRET: secrets.jwt, QORLLA_BRIDGE_SECRET: secrets.bridge, RECOVERY_ESCROW_KEY: secrets.escrow, NODE_ENV: 'development', RECORDING_MASTER_KEYS: JSON.stringify({ dev1: secrets.recordingKey }), RECORDING_ACTIVE_KEY_ID: 'dev1', RECORDING_STORE_DIR: rec, RECORDING_ADMIN_SECRET: 'test-admin-secret', PHONE_PROVIDER: 'test', PHONE_WEBHOOK_SECRET: 'phone-test-secret-123456',
    SHIELD_MEET_ENFORCE: 'true', SHIELD_URL: engine.base, SHIELD_MEET_KEY_PEM: keys.meet.pem.replace(/\n/g, '\\n'), SHIELD_WORKLOAD_ISSUER: ISSUER, SHIELD_WORKLOAD_KID: 'wm', SHIELD_RECHECK_SECONDS: '1' }) }));
  main = { base: `http://127.0.0.1:${ports.main}` }; fs.mkdirSync(path.join(dataDir, 'auth'), { recursive: true }); fs.writeFileSync(path.join(dataDir, 'auth', 'tokens.json'), '[]');
  children.push(spawn(process.execPath, ['server.js'], { cwd: root, stdio: ['ignore', logOf('main'), logOf('main')], env: env({ PORT: String(ports.main), DATA_DIR: dataDir, MEET_PROBE_URL: meet.base, MEET_INTERNAL_URL: meet.base, QORLLA_BRIDGE_SECRET: secrets.bridge, MEET_DETECT: '', MEET_PUBLIC_URL: '', QORLLA_VOICE_ENABLED: 'true', VOICE_ADMIN_SECRET: ENGINE_ADMIN, VOICE_INTERNAL_URL: engine.base, VOICE_URL: engine.base,
    SHIELD_SYNC_URL: engine.base, SHIELD_WORKLOAD_ISSUER: ISSUER, SHIELD_REQUIRE_VERIFIED: 'true', SHIELD_RECONCILE_SECONDS: '2', PHONE_ADMIN_USERS: 'adminx*' }) }));
  await waitHttp(meet.base + '/api/health'); await waitHttp(main.base + '/');
});
after(async () => { for (const c of children) { try { c.kill(); } catch { /* gone */ } } if (h) await Promise.race([h.closeAll().catch(() => {}), sleep(3000)]); if (jwksSrv) await Promise.race([new Promise((ok) => jwksSrv.close(ok)), sleep(2000)]); if (db) await db.drop(); if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true }); setTimeout(() => process.exit(process.exitCode || 0), 1500).unref();       // unread keep-alive responses can hold the engine's listener open; the results are already reported
  if (process.env.SHIELD_IT_DEBUG) setTimeout(() => { console.error('ACTIVE HANDLES: ' + process._getActiveHandles().map((x) => x.constructor.name + (x.remotePort ? ' -> ' + x.remoteAddress + ':' + x.remotePort : '') + (x.localPort ? ' <' + x.localPort : '')).join(' | ')); }, 8000).unref(); });
const skip = (t) => !db && t.skip('needs PostgreSQL, the dev-stack secrets and node_modules in the repository root and qorlla-meet-video');

test('ACCOUNT REGISTRATION and USER VERIFICATION: the main app registers every account with the shield and Numbers & Plans; protected features wait for verification', async (t) => {
  if (skip(t)) return;
  const vera = await account('vera');
  const p0 = await principal(vera.id); assert.equal(p0.verified, false, 'registered, unverified');
  assert.equal((await q('SELECT verified FROM qphone_accounts WHERE account_id=$1', [vera.id])).rows[0]?.verified ?? (await until(async () => (await q('SELECT verified FROM qphone_accounts WHERE account_id=$1', [vera.id])).rows[0], 20000)).verified, false, 'Numbers & Plans knows her too');
  const refused = await voiceToken(vera); assert.equal(refused.status, 403); assert.equal(refused.body.error, 'verification_required', 'no voice identity until verified');
  assert.equal((await mainReq('', 'POST', '/api/voice/token', {})).status, 401, 'a guest (no account) has no voice either');
  await verify(vera); await principalWhere(vera.id, (p) => p.verified);
  const ok = await voiceToken(vera); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.ok(ok.body.token && ok.body.extension);
  const me = await fetch(engine.base + '/v1/voice/me', { headers: { authorization: 'Bearer ' + ok.body.token } }); assert.equal(me.status, 200);
  // the ENGINE refuses an unverified principal on its own, whatever the main app did: flip her to unverified at the shield and her still-valid token is refused for voice
  await as('ops', 'PUT', '/v1/shield/admin/principals', { accountId: vera.id, verified: false }); assert.equal((await fetch(engine.base + '/v1/voice/ws-ticket', { method: 'POST', headers: { authorization: 'Bearer ' + ok.body.token, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: randomUUID() }) })).status, 403);
  assert.equal((await fetch(engine.base + '/v1/voice/me', { headers: { authorization: 'Bearer ' + ok.body.token } })).status, 200, 'but she can still ask where she stands');
  assert.equal((await fetch(engine.base + '/v1/voice/numbers/me', { headers: { authorization: 'Bearer ' + ok.body.token } })).status, 200);
  assert.equal((await fetch(engine.base + '/v1/voice/numbers/me')).status, 401, 'no credential, no answer'); assert.equal((await fetch(engine.base + '/v1/voice/numbers/me', { headers: { authorization: 'Bearer garbage' } })).status, 401);
  await principalWhere(vera.id, (p) => p.verified);                                                 // the main app's periodic reconcile restores the truth (verified)
});

test('SUSPENDED ACCOUNT: signed out of the main app, refused by the engine, voice WebSocket terminated, restorable', async (t) => {
  if (skip(t)) return;
  const adm = await account('adminx'); const sam = await account('sam', { verified: true }); await principalWhere(sam.id, (p) => p.verified);
  const tok = (await voiceToken(sam)).body.token; const tk = await fetch(engine.base + '/v1/voice/ws-ticket', { method: 'POST', headers: { authorization: 'Bearer ' + tok, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: randomUUID() }) }); assert.equal(tk.status, 200);
  const ws = new WebSocket(engine.base.replace('http', 'ws') + '/v1/voice/ws', [PROTOCOL, 'ticket.' + (await tk.json()).ticket], { origin: ORIGIN }); await new Promise((ok, no) => { ws.once('open', ok); ws.once('error', no); }); const closed = new Promise((ok) => ws.once('close', (code) => ok(code)));
  assert.equal((await mainReq(sam.cookie, 'POST', '/api/admin/accounts/' + sam.id + '/suspend', { suspended: true })).status, 403, 'an ordinary account cannot suspend anyone');
  const sus = await mainReq(adm.cookie, 'POST', '/api/admin/accounts/' + sam.id + '/suspend', { suspended: true }); assert.equal(sus.status, 200, JSON.stringify(sus.body));
  assert.equal(await Promise.race([closed, sleep(15000).then(() => 'still-open')]), 4003, 'the open voice WebSocket was terminated');
  assert.equal((await mainReq(sam.cookie, 'POST', '/api/voice/token', {})).status, 401, 'main app session is gone');
  assert.equal((await mainReq('', 'POST', '/api/auth/login', { username: sam.username, password: PASSWORD })).status, 403, 'cannot sign in');
  assert.equal((await fetch(engine.base + '/v1/voice/me', { headers: { authorization: 'Bearer ' + tok } })).status, 403, 'the still-unexpired voice token is refused by the engine');
  assert.equal((await principalWhere(sam.id, (p) => p.suspended)).suspended, true);
  assert.equal((await mainReq(adm.cookie, 'POST', '/api/admin/accounts/' + adm.id + '/suspend', { suspended: true })).status, 409, 'an administrator cannot lock themselves out');
  assert.equal((await mainReq(adm.cookie, 'POST', '/api/admin/accounts/' + sam.id + '/suspend', { suspended: false })).status, 200); await principalWhere(sam.id, (p) => !p.suspended);
  const back = await mainReq('', 'POST', '/api/auth/login', { username: sam.username, password: PASSWORD }); assert.equal(back.status, 200); await sleep(1100);
  const t2 = await voiceToken({ cookie: back.cookie }); assert.equal(t2.status, 200); assert.equal((await fetch(engine.base + '/v1/voice/me', { headers: { authorization: 'Bearer ' + t2.body.token } })).status, 200);
});

test('QORLLA MEET SIGNALING: guests cannot create meetings, need the passcode and host approval; approved guests get meeting-scoped access only; accounts need the shield; revoked sessions are terminated', async (t) => {
  if (skip(t)) return;
  const host = await account('hosta', { verified: true }); await principalWhere(host.id, (p) => p.verified);
  const m = await schedule({ hostAccountId: host.id, waitingRoom: true });
  // guests cannot create meetings, and a browser cannot claim an account
  assert.equal((await meetApi('POST', '/api/meetings', { title: 'Mine', name: 'Guesty' })).status, 403, 'guest/anonymous meeting creation is refused');
  assert.equal((await join(m, { name: 'Guest', passcode: 'wrong-pass' })).status, 403, 'wrong passcode');
  const g = await join(m, { name: 'Guest One', passcode: m.passcode, accountId: host.id }); assert.equal(g.status, 200); assert.equal(g.body.admission, 'waiting', 'a waiting room holds the guest');
  assert.equal((await q('SELECT account_id FROM participants WHERE id=$1', [g.body.participantId])).rows[0].account_id, null, 'an account id sent by a browser is ignored: still a guest');
  const waiting = await connect(g.body.token); assert.equal(waiting.ok, false, 'no signaling session without host approval');
  // the host (account via the trusted bridge) gets in; only the real host account can be host
  const hj = await join(m, { name: 'Host', hostSecret: m.hostSecret, accountId: host.id }, true); assert.equal(hj.status, 200); const hs = await connect(hj.body.token); assert.equal(hs.ok, true, 'the real host');
  const fake = await join(m, { name: 'Imposter', hostSecret: m.hostSecret, accountId: 'u_someone_else' }, true); assert.equal((await connect(fake.body.token)).ok, false, 'host credential used by another account: refused by the shield');
  const anonHost = await join(m, { name: 'Anon', hostSecret: m.hostSecret }, true); assert.equal((await connect(anonHost.body.token)).ok, false, 'host credential with no account: refused');
  assert.equal((await meetApi('POST', `/api/meetings/${m.id}/admit`, { participantId: g.body.participantId }, { token: hj.body.token })).status, 200);
  const gs = await connect(g.body.token); assert.equal(gs.ok, true, 'approved guest connects');
  const audit = (await q("SELECT decision, reason FROM shield_events WHERE action='meet.signal' AND actor=$1", ['guest:' + g.body.participantId])).rows; assert.ok(audit.some((e) => e.decision === 'DENY' || e.reason === 'guest'), 'recorded'); assert.ok(audit.some((e) => e.decision === 'ALLOW' && e.reason === 'guest'), 'approved as a GUEST (meeting-scoped, no host/member rights)');
  assert.equal((await meetApi('POST', `/api/meetings/${m.id}/end`, {}, { token: g.body.token })).status, 403, 'a guest cannot end the meeting'); assert.equal((await meetApi('POST', `/api/meetings/${m.id}/admit`, { all: true }, { token: g.body.token })).status, 403, 'or admit people');
  assert.equal((await meetApi('GET', `/api/meetings/${m.id}/waiting`, undefined, { token: g.body.token })).status, 403);
  const other = await schedule({ hostAccountId: host.id }); assert.equal((await meetApi('GET', `/api/meetings/${other.id}`, undefined, { token: g.body.token })).status, 403, 'a guest credential works for its own meeting only');
  // guests get nothing from Qorlla Voice or Numbers
  for (const [p, mth] of [['/v1/voice/me', 'GET'], ['/v1/voice/calls', 'POST'], ['/v1/voice/numbers/me', 'GET']]) assert.equal((await fetch(engine.base + p, { method: mth, headers: { authorization: 'Bearer ' + g.body.token, 'content-type': 'application/json' }, body: mth === 'POST' ? '{}' : undefined })).status, 401, 'the guest credential is not a voice credential: ' + p);
  assert.equal((await mainReq('', 'POST', '/api/voice/token', {})).status, 401); assert.equal((await mainReq('', 'POST', '/api/phone/calls', { to: '+16502530000' })).status, 401, 'no PSTN for a guest');
  assert.ok(!(await q("SELECT 1 FROM voice_identities WHERE account_id LIKE 'guest%'")).rowCount, 'a guest never gets an extension');
  // an unverified registered account has guest rights only; a meeting that bars guests refuses it
  const unv = await account('newbie'); await principal(unv.id); const closedMeeting = await schedule({ hostAccountId: host.id, guestAccess: false });
  const uj = await join(closedMeeting, { name: 'Newbie', passcode: closedMeeting.passcode, accountId: unv.id }, true); assert.equal((await connect(uj.body.token)).ok, false, 'unverified account in a members-only meeting: refused');
  const uj2 = await join(m, { name: 'Newbie', passcode: m.passcode, accountId: unv.id }, true); await meetApi('POST', `/api/meetings/${m.id}/admit`, { all: true }, { token: hj.body.token }); const us = await connect(uj2.body.token); assert.equal(us.ok, true);
  assert.ok((await q("SELECT 1 FROM shield_events WHERE action='meet.signal' AND actor=$1 AND decision='ALLOW' AND reason='guest'", [unv.id])).rowCount, 'an unverified account is admitted with GUEST rights');
  // a suspended member's open session is terminated by the periodic re-check, and cannot come back
  const mem = await account('member', { verified: true }); await principalWhere(mem.id, (p) => p.verified); const mj = await join(m, { name: 'Member', passcode: m.passcode, accountId: mem.id }, true); await meetApi('POST', `/api/meetings/${m.id}/admit`, { all: true }, { token: hj.body.token });
  const ms = await connect(mj.body.token); assert.equal(ms.ok, true); const revoked = new Promise((ok) => { ms.socket.once('session_revoked', (e) => ok(e.reason)); ms.socket.once('disconnect', () => ok('disconnect')); });
  await as('ops', 'POST', `/v1/shield/admin/principals/${encodeURIComponent(mem.id)}/suspend`, {});
  assert.ok(['SUSPENDED', 'disconnect'].includes(await Promise.race([revoked, sleep(15000).then(() => 'still-open')])), 'the open Meet session was terminated');
  assert.equal((await connect(mj.body.token)).ok, false, 'and it cannot reconnect');
  for (const s of [hs, gs, us, waiting]) s.socket?.close();
});

test('ORGANIZATION ISOLATION at the Meet gate: members of another organization are refused (or admitted as guests only where guests are allowed)', async (t) => {
  if (skip(t)) return;
  const a = await account('orga', { verified: true }), b = await account('orgb', { verified: true }), host = await account('orghost', { verified: true });
  for (const [x, org] of [[a, 'orgA'], [b, 'orgB'], [host, 'orgA']]) { await principalWhere(x.id, (p) => p.verified); await as('ops', 'PUT', '/v1/shield/admin/principals', { accountId: x.id, orgId: org, verified: true }); }
  await sleep(2500); assert.equal((await q('SELECT org_id FROM shield_principals WHERE account_id=$1', [a.id])).rows[0].org_id, 'orgA', 'the main app\'s periodic sync does not overwrite the tenant assigned by the authoritative backend');
  const m = await schedule({ hostAccountId: host.id, orgId: 'orgA', guestAccess: false });
  const ja = await join(m, { name: 'A', passcode: m.passcode, accountId: a.id }, true); const sa = await connect(ja.body.token); assert.equal(sa.ok, true, 'same organization'); sa.socket?.close();
  assert.ok((await q("SELECT 1 FROM shield_events WHERE action='meet.signal' AND actor=$1 AND reason='member'", [a.id])).rowCount);
  const jb = await join(m, { name: 'B', passcode: m.passcode, accountId: b.id }, true); assert.equal((await connect(jb.body.token)).ok, false, 'another organization');
  assert.ok((await q("SELECT 1 FROM shield_events WHERE action='meet.signal' AND actor=$1 AND decision='DENY' AND reason='CROSS_TENANT'", [b.id])).rowCount);
  const open = await schedule({ hostAccountId: host.id, orgId: 'orgA', guestAccess: true }); const jb2 = await join(open, { name: 'B', passcode: open.passcode, accountId: b.id }, true); const sb = await connect(jb2.body.token); assert.equal(sb.ok, true); sb.socket?.close();
  assert.ok((await q("SELECT 1 FROM shield_events WHERE action='meet.signal' AND actor=$1 AND decision='ALLOW' AND reason='guest'", [b.id])).rowCount, 'outsiders get guest rights only');
  const jh = await join(m, { name: 'Host', hostSecret: m.hostSecret, accountId: host.id }, true); const sh = await connect(jh.body.token); assert.equal(sh.ok, true); sh.socket?.close();
});

test('WORKLOAD IDENTITY end to end: replayed, wrong-scope, foreign and anonymous credentials cannot invoke privileged shield APIs', async (t) => {
  if (skip(t)) return;
  const tk = signWorkloadJwt({ privateKeyPem: keys.meet.pem, kid: 'wm', issuer: ISSUER, subject: 'svc:meet' });
  assert.equal((await as('meet', 'POST', '/v1/shield/meet/recheck', { participants: [] }, { token: tk })).status, 200); assert.equal((await as('meet', 'POST', '/v1/shield/meet/recheck', { participants: [] }, { token: tk })).status, 401, 'replayed credential');
  assert.equal((await as('meet', 'PUT', '/v1/shield/admin/principals', { accountId: 'x1', verified: true })).status, 403, 'Meet cannot register principals'); assert.equal((await as('meet', 'POST', '/v1/shield/pstn/authorize', {})).status, 403, 'nor authorize PSTN calls');
  assert.equal((await as('ops', 'POST', '/v1/shield/meet/authorize', {}, { sub: 'svc:not-listed' })).status, 403, 'a valid signature for an unlisted workload');
  assert.equal((await as('ops', 'GET', '/v1/voice/admin/identities', undefined, { token: 'a.b.c' })).status, 401, 'garbage');
  assert.equal((await fetch(engine.base + '/v1/shield/meet/authorize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, 'anonymous');
  assert.equal((await fetch(engine.base + '/v1/shield/admin/principals', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-voice-admin-secret': ENGINE_ADMIN }, body: '{}' })).status, 401, 'the shared admin secret is not workload identity for shield APIs');
  const mainTok = await (async () => { const jwks = await fetch(`http://127.0.0.1:${ports.main}/.well-known/shield-workload-jwks.json`).then((r) => r.json()); return jwks.keys.length; })(); assert.equal(mainTok, 1, 'the main app publishes its own workload key');
});

test('PSTN through the integrated services: unregistered, international and unowned-caller-ID calls are denied; emergency suspension of an account with a live call tells the gateway to hang up', async (t) => {
  if (skip(t)) return;
  const pat = await account('pat', { verified: true }), adm = await account('plainadm', { verified: true }); await principalWhere(pat.id, (p) => p.verified);
  const pstn = (b) => as('ops', 'POST', '/v1/shield/pstn/authorize', { requestId: randomUUID(), accountId: pat.id, destination: '+16502530000', callerId: '+14155550101', ...b });
  assert.equal((await pstn({})).body.reason, 'NO_ORGANIZATION', 'a main-app account with no organization has no PSTN');
  await as('ops', 'PUT', '/v1/shield/admin/orgs', { orgId: 'orgP', pstnEnabled: true, allowedCountries: ['US'], maxActiveCalls: 2, maxCallsHour: 10, spendLimitCents: 1000 }); await as('ops', 'PUT', '/v1/shield/admin/principals', { accountId: pat.id, orgId: 'orgP', verified: true });
  assert.equal((await pstn({ destination: '+442071838750' })).body.reason, 'DESTINATION_COUNTRY_NOT_ALLOWED', 'international call not authorized');
  assert.equal((await pstn({ destination: '+19005551234' })).body.reason, 'DESTINATION_CLASS_BLOCKED'); assert.equal((await pstn({})).body.reason, 'CALLER_ID_NOT_OWNED', 'no number from the authority: no caller ID');
  const sid = 'PN' + randomBytes(10).toString('hex'), ev = { providerNumberId: sid, e164: '+14155550101', country: 'US', kind: 'personal', accountId: pat.id, state: 'active', callerIdVerified: true, hold: false, version: 1 };
  assert.equal((await as('ops', 'POST', '/v1/shield/numbers/events', { eventId: randomUUID(), providerNumberId: sid, version: 1, type: 'number.changed', payload: ev })).body.result, 'applied');
  const ok = await pstn({}); assert.equal(ok.body.allow, true, JSON.stringify(ok.body)); assert.equal((await as('ops', 'POST', '/v1/shield/pstn/consume', { authorizationId: ok.body.authorizationId, accountId: pat.id, destination: '+16502530000', callerId: '+14155550101' })).body.valid, true);
  const sus = await mainReq(adm.cookie, 'POST', '/api/admin/accounts/' + pat.id + '/suspend', { suspended: true }); assert.equal(sus.status, 403, 'only listed administrators');
  const adm2 = await account('adminx', { verified: true }); assert.equal((await mainReq(adm2.cookie, 'POST', '/api/admin/accounts/' + pat.id + '/suspend', { suspended: true })).status, 200);
  await principalWhere(pat.id, (p) => p.suspended); const term = await as('ops', 'POST', '/v1/shield/pstn/terminations', {}); assert.ok(term.body.terminate.includes(ok.body.authorizationId), 'the gateway is told which live call to terminate');
  assert.equal((await as('ops', 'POST', '/v1/shield/pstn/settle', { authorizationId: ok.body.authorizationId, actualCents: 5 })).body.settled, true, 'the outcome is recorded'); assert.equal((await pstn({})).body.reason, 'SUSPENDED');
  assert.ok((await q("SELECT 1 FROM shield_events WHERE action='principal.suspend' AND actor=$1", [pat.id])).rowCount);
});

test('MAIN APP built-in meeting room: guests and unverified accounts cannot create meetings; suspending an account ends its live signaling session', async (t) => {
  if (skip(t)) return;
  const create = (cookie) => mainReq(cookie, 'POST', '/api/meetings/create', { topic: 'Built-in room', durationMinutes: 30 });
  assert.equal((await create('')).status, 401, 'a guest cannot create a meeting'); const unv = await account('unvcreate'); assert.equal((await create(unv.cookie)).status, 403, 'an unverified account cannot either');
  const host = await account('roomhost', { verified: true }); const adm = await account('adminx', { verified: true }); const made = await create(host.cookie); assert.equal(made.status, 201, JSON.stringify(made.body));
  const meetingId = made.body.meetingId || made.body.meeting?.meetingId || made.body.id; assert.ok(meetingId, JSON.stringify(made.body));
  const sock = ioc(main.base, { extraHeaders: { cookie: host.cookie }, transports: ['websocket'], reconnection: false }); await new Promise((ok, no) => { sock.once('connect', ok); sock.once('connect_error', no); });
  const events = []; sock.on('error_response', (e) => events.push(e)); sock.emit('join_room', { meetingId, userName: 'Host' }); await sleep(700); assert.equal(events.length, 0, 'the account joined its own room: ' + JSON.stringify(events));
  const gone = new Promise((ok) => { sock.once('session_revoked', (e) => ok(e.reason)); sock.once('disconnect', () => ok('disconnect')); });
  assert.equal((await mainReq(adm.cookie, 'POST', '/api/admin/accounts/' + host.id + '/suspend', { suspended: true })).status, 200);
  assert.ok(['account_suspended', 'disconnect'].includes(await Promise.race([gone, sleep(8000).then(() => 'still-open')])), 'the built-in room session was terminated'); sock.close();
});

test('PSTN and public numbers are OFF in the real Meet and main app by default: the internal service routes refuse before any provider operation, while account sync still works', async (t) => {
  if (skip(t)) return;
  const bridge = (method, p, body) => meetApi(method, '/api/integrations/telephony' + p, body, { bridge: true });
  const PSTN = { error: 'feature_disabled', feature: 'pstn', message: 'Public telephone calling is disabled.' }, NUM = { error: 'feature_disabled', feature: 'numbers', message: 'Public telephone numbers are disabled.' };
  for (const [m, p, b] of [['POST', '/calls', { to: '+16502530000', idempotencyKey: 'k-12345678' }], ['GET', '/calls'], ['GET', '/calls/' + randomUUID()], ['POST', '/calls/' + randomUUID() + '/end']]) { const x = await bridge(m, p, b); assert.equal(x.status, 403, p); assert.deepEqual(x.body, PSTN, p); }
  for (const [m, p, b] of [['POST', '/numbers/request', { country: 'US', idempotencyKey: 'k-12345678' }], ['GET', '/numbers/available?country=US'], ['GET', '/numbers'], ['POST', '/numbers/' + randomUUID() + '/state', { state: 'suspended' }], ['POST', '/numbers/' + randomUUID() + '/reassign', { to: 'x', reason: 'because' }], ['POST', '/numbers/' + randomUUID() + '/caller-id', { verified: true }], ['POST', '/numbers/reconcile'], ['GET', '/numbers/snapshot']]) { const x = await bridge(m, p, b); assert.equal(x.status, 403, p); assert.deepEqual(x.body, NUM, p); }
  for (const w of ['voice', 'status']) { const x = await fetch(meet.base + '/api/integrations/telephony/webhooks/twilio/' + w, { method: 'POST' }); assert.equal(x.status, 404, 'webhook path under the bridge prefix does not exist'); }
  const hook = await fetch(meet.base + '/api/telephony/webhooks/twilio/voice', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'CallSid=CA1' }); assert.equal(hook.status, 403, 'carrier webhooks are refused before signature handling'); assert.deepEqual(await hook.json(), PSTN);
  assert.equal((await fetch(meet.base + '/api/integrations/telephony/calls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, 'no bridge secret: still 401, authentication comes first');
  assert.equal((await bridge('PUT', '/accounts/' + encodeURIComponent('gate-check'), { verified: true, suspended: false })).status, 200, 'account standing sync is not PSTN and keeps working');
  // through the main app: a signed-in user cannot place a PSTN call
  const u = await account('phoneuser', { verified: true }); const viaMain = await mainReq(u.cookie, 'POST', '/api/phone/calls', { to: '+16502530000', idempotencyKey: 'k-' + randomUUID().slice(0, 10) }); assert.ok([403, 503].includes(viaMain.status), 'main app: ' + viaMain.status + ' ' + JSON.stringify(viaMain.body));
  assert.equal((await mainReq('', 'POST', '/api/phone/calls', { to: '+16502530000' })).status, 401, 'a guest has no PSTN');
});

test('FAIL CLOSED: when the shield is unreachable (or answers an error) Meet grants NO signaling session, to hosts, members or guests', async (t) => {
  if (skip(t)) return;
  const host = await account('lasthost', { verified: true }); await principalWhere(host.id, (p) => p.verified); const m = await schedule({ hostAccountId: host.id });
  const hj = await join(m, { name: 'Host', hostSecret: m.hostSecret, accountId: host.id }, true); const s1 = await connect(hj.body.token); assert.equal(s1.ok, true, 'works while the shield is reachable'); s1.socket?.close();
  // a second Meet process on the same database whose shield URL points at a port nobody listens on
  const dead = await free(), port2 = await free(); children.push(startMeet(port2, 'http://127.0.0.1:' + dead, 'meet-dead')); await waitHttp('http://127.0.0.1:' + port2 + '/api/health');
  const viaDead = async (body, bridge) => (await fetch('http://127.0.0.1:' + port2 + '/api/meetings/' + m.id + '/join', { method: 'POST', headers: { 'content-type': 'application/json', ...(bridge ? { 'x-qorlla-bridge-secret': secrets.bridge } : {}) }, body: JSON.stringify(body) })).json();
  const tryConnect = (token) => new Promise((ok) => { const sk = ioc('http://127.0.0.1:' + port2, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 8000 }); sk.once('connect', () => { sk.close(); ok(true); }); sk.once('connect_error', () => { sk.close(); ok(false); }); });
  assert.equal(await tryConnect((await viaDead({ name: 'Host', hostSecret: m.hostSecret, accountId: host.id }, true)).token), false, 'shield unreachable: no host session');
  assert.equal(await tryConnect((await viaDead({ name: 'Guest', passcode: m.passcode }, false)).token), false, 'shield unreachable: no guest session');
  // and a Meet that was never configured for the shield while enforcement is on refuses everything too
  const port3 = await free(); children.push(startMeet(port3, '', 'meet-unconfigured')); await waitHttp('http://127.0.0.1:' + port3 + '/api/health');
  const j3 = await (await fetch('http://127.0.0.1:' + port3 + '/api/meetings/' + m.id + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Guest', passcode: m.passcode }) })).json();
  assert.equal(await new Promise((ok) => { const sk = ioc('http://127.0.0.1:' + port3, { auth: { token: j3.token }, transports: ['websocket'], reconnection: false, timeout: 8000 }); sk.once('connect', () => { sk.close(); ok(true); }); sk.once('connect_error', () => { sk.close(); ok(false); }); }), false, 'enforcement on but shield not configured: refused');
});
