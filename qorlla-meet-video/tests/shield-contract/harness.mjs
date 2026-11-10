// A5.5 Phase A harness: the REAL Security Shield (qorlla-voice-engine, loaded read-only from SHIELD_ENGINE_DIR, in process, on its own isolated PostgreSQL schema) and the REAL Meet server (server/index.js as a
// child process, shield enforcing, telephone test-double provider) talking over HTTP with real ES256 workload credentials. No Shield behaviour is faked. Nothing here changes the Shield or Meet; the harness only
// seeds data, calls routes and reads rows. Credentials are generated per run and never printed. Skipped (by the test files) unless SHIELD_ENGINE_DIR and PHONE_TEST_DATABASE_URL are set.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { signWorkloadJwt } from '../../server/telephony/number-sync.mjs';

export const ENGINE_DIR = process.env.SHIELD_ENGINE_DIR, DB_URL = process.env.PHONE_TEST_DATABASE_URL;
export const skipReason = !ENGINE_DIR || !fs.existsSync(path.join(ENGINE_DIR, 'src', 'app.mjs')) ? 'SHIELD_ENGINE_DIR (the qorlla-voice-engine checkout) is not set' : !DB_URL ? 'PHONE_TEST_DATABASE_URL is not set' : false;
const ROOT = path.resolve(import.meta.dirname, '..', '..'), SQL = path.join(ROOT, 'sql'), ISSUER = 'qorlla-workload', WEBHOOK = 'shield-contract-webhook-secret-0123456789';
const MEET_SQL = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', 'v4_7_recording_consent.sql', 'v4_8_collab.sql', 'v4_9_recording_storage.sql', 'v4_10_admission.sql', 'v4_11_history.sql', 'v4_12_limit.sql',
  'v4_13_phone.sql', 'v4_14_telephony.sql', 'v4_15_telephony_features.sql', 'v4_16_number_authority.sql', 'v4_17_shield_identity.sql', 'v4_18_billing_hold.sql', 'v4_19_ai_request.sql', 'v4_20_ai_consent_seq.sql', 'v4_21_handoffs.sql', 'v4_22_host_controls.sql', 'v4_24_phone_lifecycle.sql', 'v4_25_phone_verification_peer.sql', 'v4_29_phone_gateway_media_bridge.sql'];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const until = async (fn, ms = 8000, step = 100) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const rnd = (n) => Array.from({ length: n }, () => crypto.randomInt(10)).join('');

/** One contract environment. Options: allowed (the Shield's workload allow-list), requireMtls (SHIELD_REQUIRE_MTLS on the Shield). */
export async function startContract({ allowed, requireMtls = false, recheckSeconds = '1', graceSeconds = undefined, pendingGraceSeconds = '3', peer = false } = {}) {
  const req = createRequire(path.join(ENGINE_DIR, 'package.json')), jose = req('jose');
  process.env.VOICE_TEST_DATABASE_URL = DB_URL;                                                                          // the engine's own helpers read this: a dedicated test database, isolated schemas
  const imp = (f) => import(pathToFileURL(path.join(ENGINE_DIR, f)).href), { isolatedDb, identityProvider } = await imp('test/helpers.mjs'), { harness } = await imp('test/harness.mjs');
  const db = await isolatedDb(); if (!db) throw new Error('the Shield test database is not reachable');
  const keys = {}; for (const [who, kid] of [['meet', 'wm'], ['ops', 'wo'], ['gateway', 'wg']]) { const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }); keys[who] = { kid, pem: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), jwk: { ...(await jose.exportJWK(await jose.importSPKI(kp.publicKey.export({ type: 'spki', format: 'pem' }), 'ES256'))), kid, alg: 'ES256', use: 'sig' } }; }
  const jwks = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: Object.values(keys).map((k) => k.jwk) })); });
  await new Promise((r) => jwks.listen(0, '127.0.0.1', r));
  const idp = await identityProvider(), h = harness({ db, idp });
  const allow = allowed || 'svc:meet=meet.register|meet.signal;svc:ops=shield.admin|shield.suspend|alerts.report|alerts.read';
  const engineEnv = { SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_WORKLOAD_JWKS_URL: 'http://127.0.0.1:' + jwks.address().port + '/', SHIELD_WORKLOAD_ISSUER: ISSUER, SHIELD_WORKLOAD_ALLOWED: allow };
  const engine = await h.replica({ env: { ...engineEnv, ...(requireMtls ? { SHIELD_REQUIRE_MTLS: 'true' } : {}) } });
  /** Calls the real Shield as one of the test workloads. `o.token` replaces the credential; `o.cnf` binds it to a certificate thumbprint (which a plain-HTTP request cannot prove). */
  const shieldAt = async (base, who, method, p, body, o = {}) => {
    const token = o.token ?? signWorkloadJwt({ privateKeyPem: keys[who].pem, kid: keys[who].kid, issuer: ISSUER, subject: o.sub ?? 'svc:' + who, ...(o.cnf ? { cnfThumbprint: o.cnf } : {}) });
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const shield = (who, method, p, body, o) => shieldAt(engine.base, who, method, p, body, o);
  /** A second Shield on the same database with different settings (for example SHIELD_REQUIRE_MTLS=true). */
  const variant = async (extra) => { const r = await h.replica({ env: { ...engineEnv, ...extra } }); return { base: r.base, call: (who, method, p, body, o) => shieldAt(r.base, who, method, p, body, o) }; };
  const sq = (text, params) => db.pool.query(text, params);
  // ---- a transparent proxy between Meet and the Shield: `outage.down = true` makes the Shield UNREACHABLE for Meet (connections are destroyed) without touching the Shield; false restores it
  const outage = { down: false, since: null }; let shieldBase = engine.base;
  const proxy = http.createServer((q, r) => { if (outage.down) { if (outage.hang) return; return q.socket.destroy(); } const u = new URL(shieldBase + q.url); const up = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: q.method, headers: q.headers }, (ur) => { r.writeHead(ur.statusCode, ur.headers); ur.pipe(r); }); up.on('error', () => q.socket.destroy()); q.pipe(up); });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r)); const proxyUrl = 'http://127.0.0.1:' + proxy.address().port;
  const setOutage = (down, hang = false) => { outage.down = down; outage.hang = down && hang; outage.since = down ? Date.now() : null; };
  // ---- the real Meet server, shield enforcing, in its own schema of the same test database
  const admin = new pg.Pool({ connectionString: DB_URL }), meetSchema = 'sc_' + crypto.randomBytes(4).toString('hex'); await admin.query('CREATE SCHEMA ' + meetSchema);
  { const c = await admin.connect(); try { await c.query('SET search_path=' + meetSchema); for (const f of MEET_SQL) await c.query(fs.readFileSync(path.join(SQL, f), 'utf8')); } finally { c.release(); } }
  const BRIDGE = crypto.randomBytes(24).toString('hex'), port = await freePort(), logFile = path.join(os.tmpdir(), 'shield-contract-meet-' + port + '.log'), log = fs.openSync(logFile, 'w');
  const meetEnv = { ...process.env, PORT: String(port), DATABASE_URL: DB_URL + (DB_URL.includes('?') ? '&' : '?') + 'options=' + encodeURIComponent('-c search_path=' + meetSchema), JWT_SECRET: crypto.randomBytes(32).toString('hex'), QORLLA_BRIDGE_SECRET: BRIDGE,
    RECOVERY_ESCROW_KEY: crypto.randomBytes(32).toString('base64'), RECORDING_MASTER_KEYS: JSON.stringify({ k1: crypto.randomBytes(32).toString('base64') }), RECORDING_ACTIVE_KEY_ID: 'k1', RECORDING_STORE_DIR: path.join(os.tmpdir(), 'shield-contract-rec-' + port), RECORDING_ADMIN_SECRET: 'x'.repeat(24),
    NODE_ENV: 'development', PHONE_PROVIDER: 'test', PHONE_WEBHOOK_SECRET: WEBHOOK, PHONE_SWEEP_MS: '300', PHONE_MAX_FAILS_CALLER: '1000', PHONE_MAX_FAILS_MEETING: '1000',
    SHIELD_MEET_ENFORCE: 'true', SHIELD_URL: proxyUrl, SHIELD_MEET_KEY_PEM: keys.meet.pem.replace(/\n/g, '\\n'), SHIELD_WORKLOAD_ISSUER: ISSUER, SHIELD_WORKLOAD_KID: keys.meet.kid, SHIELD_RECHECK_SECONDS: recheckSeconds, SHIELD_PENDING_GRACE_SECONDS: String(pendingGraceSeconds), ...(peer ? { PHONE_PEER_SIGNING_KEY_PEM: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }), PHONE_PEER_KID: 'p1' } : {}), ...(graceSeconds ? { SHIELD_RECHECK_GRACE_SECONDS: String(graceSeconds) } : {}) };
  delete meetEnv.NODE_OPTIONS;
  const base = 'http://127.0.0.1:' + port; let child = null;
  const startMeetProc = async () => { child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: meetEnv, stdio: ['ignore', log, log] }); if (!(await until(async () => fetch(base + '/api/ready').then((r) => r.ok).catch(() => false), 60000, 250))) throw new Error('Meet did not start: ' + fs.readFileSync(logFile, 'utf8').slice(-400)); };
  await startMeetProc();
  /** Kills the Meet process (a hard stop) and starts a new one on the same port, database and secrets: what a restart during a Shield outage looks like. */
  const restartMeet = async () => { const old = child; try { old.kill('SIGKILL'); } catch { /* gone */ } await new Promise((r) => (old.exitCode !== null || old.signalCode ? r() : old.once('exit', r))); await startMeetProc(); };
  const bridge = async (p, o = {}) => { const r = await fetch(base + p, { method: o.method || 'GET', headers: { 'x-qorlla-bridge-secret': BRIDGE, 'content-type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const hook = async (p, body) => { const raw = JSON.stringify({ eventId: 'evt_' + crypto.randomBytes(6).toString('hex'), ...body }), t = Math.floor(Date.now() / 1000); const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qorlla-signature': 't=' + t + ',v1=' + crypto.createHmac('sha256', WEBHOOK).update(t + '.' + raw).digest('hex') }, body: raw }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  let n = 0;
  /** A meeting as the main app's scheduling creates it, with the identity facts the Shield is told about (host account, organization, guest policy). */
  async function meeting({ guestEnabled = true, hostAccountId = null, orgId = null, ownerless = false } = {}) {
    if (!ownerless && !hostAccountId) { orgId = orgId || 'org-' + crypto.randomBytes(3).toString('hex'); hostAccountId = 'acct-host-' + crypto.randomBytes(3).toString('hex'); await putOrg(orgId); await putPrincipal(hostAccountId, { orgId }); }          // A5.5: a telephone caller needs an owned meeting; pass ownerless: true for the exception
    const id = crypto.randomUUID(), code = '5' + rnd(11), source = 'sched_' + crypto.randomBytes(5).toString('hex');
    await admin.query(`INSERT INTO ${meetSchema}.meetings(id,title,host_secret_hash,meeting_code,host_account_id,org_id,guest_enabled) VALUES($1,'Contract','x',$2,$3,$4,$5)`, [id, code, hostAccountId, orgId, guestEnabled]);
    await admin.query(`INSERT INTO ${meetSchema}.external_meeting_links(source_system,source_id,meeting_id) VALUES('qorlla-main',$1,$2)`, [source, id]);
    return { id, code, source, hostAccountId, orgId };
  }
  const pinFor = async (m) => (await bridge('/api/integrations/scheduled-meetings/' + m.source + '/phone-access', { method: 'POST', body: {} })).body.pin;
  /** A telephone caller dials in through Meet's real verify route. */
  async function dial(m, pin) { n += 1; const callId = 'call_contract_' + crypto.randomBytes(5).toString('hex'); const r = await hook('/api/phone/ivr/verify', { callId, from: '+1202555' + String(1000 + n), meetingId: m.code, pin: pin ?? await pinFor(m) }); return { callId, ...r }; }
  const callRow = async (callId) => (await admin.query(`SELECT * FROM ${meetSchema}.phone_calls WHERE provider_call_id=$1`, [callId])).rows[0];
  const goodEvidence = () => ({ state: 'audio_flowing', inboundPackets: 120, outboundPackets: 118, observedMs: 2400, codec: 'opus', encrypted: true, measuredAt: Date.now(), source: 'synthetic' });
  /** Drives an approved call to MEDIA_CONNECTED the way the provider test double does (Meet judges the evidence itself). */
  async function connect(callId, mediaToken) { return hook('/api/phone/ivr/media', { callId, mediaToken, evidence: goodEvidence() }); }
  async function stopEngine() { await engine.stop(); }
  async function close() { try { child.kill(); } catch { /* gone */ } await new Promise((r) => proxy.close(r)); await sleep(300); await h.closeAll().catch(() => {}); await new Promise((r) => jwks.close(r)); await db.drop().catch(() => {}); await admin.query('DROP SCHEMA IF EXISTS ' + meetSchema + ' CASCADE').catch(() => {}); await admin.end().catch(() => {}); try { fs.rmSync(meetEnv.RECORDING_STORE_DIR, { recursive: true, force: true }); } catch { /* gone */ } }
  const meetLog = () => fs.readFileSync(logFile, 'utf8');
  /** A real host participant row and a real host token for a meeting, so the host's own routes (end meeting) can be used. */
  const jwt = createRequire(path.join(ROOT, 'package.json'))('jsonwebtoken');
  const hostToken = async (m) => { const hostId = crypto.randomUUID(); await admin.query(`INSERT INTO ${meetSchema}.participants(id,meeting_id,display_name,role,admission) VALUES($1,$2,'Host','host','admitted')`, [hostId, m.id]); return jwt.sign({ meetingId: m.id, participantId: hostId, role: 'host', name: 'Host' }, meetEnv.JWT_SECRET, { issuer: 'qorlla-meet', expiresIn: '1h' }); };
  const endMeeting = async (m) => { const t = await hostToken(m); const r = await fetch(base + '/api/meetings/' + m.id + '/end', { method: 'POST', headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: '{}' }); return r.status; };
  const credential = (d) => hook('/api/phone/ivr/peer-credential', { callId: d.callId, mediaToken: d.body.mediaToken });
  const credRows = async (callRowId) => (await admin.query(`SELECT jti, consumed_at, revoked_at, revoked_reason, expires_at, issued_at FROM ${meetSchema}.phone_peer_credentials WHERE call_id=$1 ORDER BY issued_at`, [callRowId])).rows;
  const counters = async () => (await bridge('/api/integrations/phone/counters')).body;
  const auditRows = async (type) => (await admin.query(`SELECT meeting_id, detail, created_at FROM ${meetSchema}.audit_events WHERE event_type=$1 ORDER BY id`, [type])).rows;
  const putPrincipal = (accountId, { orgId = null, verified = true } = {}) => sq('INSERT INTO shield_principals(account_id, org_id, verified) VALUES($1,$2,$3) ON CONFLICT (account_id) DO UPDATE SET org_id=$2, verified=$3', [accountId, orgId, verified]);
  const putOrg = (orgId) => sq('INSERT INTO shield_orgs(org_id) VALUES($1) ON CONFLICT DO NOTHING', [orgId]);
  const authorize = (meetingId, participantId, o = {}) => shield('meet', 'POST', '/v1/shield/meet/authorize', { meetingId, participantId, role: 'guest', admission: 'admitted', ...o });
  const register = (m, extra = {}) => shield('meet', 'POST', '/v1/shield/meet/register', { meetingId: m.id, orgId: m.orgId ?? null, hostAccountId: m.hostAccountId ?? null, guestEnabled: true, endsAt: new Date(Date.now() + 3600e3).toISOString(), ...extra });
  return { adminMeet: admin, engine, db, keys, shield, variant, endMeeting, setOutage, outage, restartMeet, credential, credRows, counters, auditRows, sq, meeting, pinFor, dial, callRow, connect, bridge, hook, stopEngine, close, meetLog, putPrincipal, putOrg, authorize, register, meetSchema, base, h, ISSUER };
}
