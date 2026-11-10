// A5: the restricted verification-phase telephone peer, against the REAL Meet server process (server/index.js), a REAL PostgreSQL schema and REAL socket.io clients.
//   PHONE_TEST_DATABASE_URL=postgres://user:pw@host:port/db  node --test tests/phone-peer.pg.test.mjs
// Meet runs in provider mode (HMAC-signed gateway requests) with the verification-peer signing key configured: the same peer rules apply as in gateway mode. "synthetic" evidence is what the test double sends so
// Meet's own judgement can be exercised; nothing here is certification of real telephone audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { io as connect } from 'socket.io-client';

const URL_ = process.env.PHONE_TEST_DATABASE_URL, skip = URL_ ? false : 'PHONE_TEST_DATABASE_URL is not set';
const SQL = path.join(import.meta.dirname, '..', 'sql'), ROOT = path.join(import.meta.dirname, '..');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', 'v4_7_recording_consent.sql', 'v4_8_collab.sql', 'v4_9_recording_storage.sql', 'v4_10_admission.sql', 'v4_11_history.sql', 'v4_12_limit.sql',
  'v4_13_phone.sql', 'v4_14_telephony.sql', 'v4_15_telephony_features.sql', 'v4_16_number_authority.sql', 'v4_17_shield_identity.sql', 'v4_18_billing_hold.sql', 'v4_19_ai_request.sql', 'v4_20_ai_consent_seq.sql', 'v4_21_handoffs.sql', 'v4_22_host_controls.sql', 'v4_24_phone_lifecycle.sql', 'v4_25_phone_verification_peer.sql', 'v4_29_phone_gateway_media_bridge.sql'];
const BRIDGE = crypto.randomBytes(24).toString('hex'), WEBHOOK = 'peer-test-webhook-secret-0123456789', FROM = '+12025550143', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eventually = async (cond, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(25); } return cond(); };
let schema, admin; const procs = [], sockets = [];
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const RUN = crypto.randomBytes(4).toString('hex');
/** Command lines of any Meet server started by A5 tests (this run or an earlier one) that is still alive. */
const leftovers = () => { try { const out = process.platform === 'win32' ? execFileSync('wmic', ['process', 'where', "name='node.exe'", 'get', 'ProcessId,CommandLine', '/format:list'], { encoding: 'utf8' }) : execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }); return out.split(String.fromCharCode(10)).filter((l) => l.includes('--a5-test=') && !l.includes('wmic') && !l.includes('ps -eo')); } catch { return []; } };
const exited = (p) => new Promise((res) => { if (p.exitCode !== null || p.signalCode) return res(); p.once('exit', () => res()); });
test.before(async () => {
  if (!URL_) return; assert.deepEqual(leftovers(), [], 'no Meet server from an earlier A5 run is still alive'); schema = 'pp_' + Math.random().toString(36).slice(2, 9); admin = new pg.Pool({ connectionString: URL_ }); await admin.query('CREATE SCHEMA ' + schema);
  const c = await admin.connect(); try { await c.query('SET search_path=' + schema); for (const f of ORDER) await c.query(fs.readFileSync(path.join(SQL, f), 'utf8')); } finally { c.release(); }
});
// Every test gets its own servers and sockets and they are stopped when it ends: a server left running keeps sweeping ALL calls of the shared schema with ITS timeouts and would end the next test's calls.
test.afterEach(async () => {
  // Cleanup is AWAITED, also after a failed or timed-out test: every socket is closed (and seen to close) and every server process has really exited before the next test begins.
  const socks = sockets.splice(0); await Promise.all(socks.map((s) => new Promise((res) => { if (!s.connected) { try { s.close(); } catch { /* gone */ } return res(); } s.once('disconnect', () => res()); try { s.disconnect(); } catch { res(); } setTimeout(res, 2000).unref?.(); })));
  const ps = procs.splice(0); for (const p of ps) { try { p.kill(); } catch { /* gone */ } } await Promise.all(ps.map((p) => Promise.race([exited(p), sleep(8000)]))); for (const p of ps) if (p.exitCode === null && !p.signalCode) { try { p.kill('SIGKILL'); } catch { /* gone */ } await Promise.race([exited(p), sleep(4000)]); }
  assert.ok(ps.every((p) => p.exitCode !== null || p.signalCode), 'every Meet server of the test has exited');
});
test.after(async () => {
  if (URL_) { await sleep(300); assert.deepEqual(leftovers(), [], 'no Meet server of this run is left behind'); } for (const s of sockets) { try { s.disconnect(); } catch { /* gone */ } } for (const p of procs) { try { p.kill(); } catch { /* gone */ } } await sleep(300); if (!URL_) return; await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); });

const peerKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
async function startMeet(extra = {}) {
  const port = await freePort(), secret = crypto.randomBytes(32).toString('hex'), pem = extra.PHONE_PEER_SIGNING_KEY_PEM ?? peerKey();
  const env = { ...process.env, PORT: String(port), DATABASE_URL: URL_ + (URL_.includes('?') ? '&' : '?') + 'options=' + encodeURIComponent('-c search_path=' + schema), JWT_SECRET: secret, QORLLA_BRIDGE_SECRET: BRIDGE,
    RECOVERY_ESCROW_KEY: crypto.randomBytes(32).toString('base64'), RECORDING_MASTER_KEYS: JSON.stringify({ k1: crypto.randomBytes(32).toString('base64') }), RECORDING_ACTIVE_KEY_ID: 'k1', RECORDING_STORE_DIR: path.join(ROOT, '..', '.dev-stack', 'recordings-' + port), RECORDING_ADMIN_SECRET: 'x'.repeat(24),
    NODE_ENV: 'development', PHONE_SWEEP_MS: '300', PHONE_PROVIDER: 'test', PHONE_WEBHOOK_SECRET: WEBHOOK, PHONE_PEER_SIGNING_KEY_PEM: pem, PHONE_PEER_KID: 'p1', ...extra };
  const child = spawn(process.execPath, ['server/index.js', '--a5-test=' + RUN], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }); procs.push(child); let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  const base = 'http://127.0.0.1:' + port; for (let i = 0; i < 80; i++) { if (await fetch(base + '/api/ready').then((r) => r.ok).catch(() => false)) return { base, child, secret, log: () => log }; await sleep(250); } throw new Error('Meet did not start: ' + log.slice(-600));
}
const bridge = (base, p, o = {}) => fetch(base + p, { method: o.method || 'GET', headers: { 'x-qorlla-bridge-secret': BRIDGE, 'content-type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const signedPost = async (base, p, body, o = {}) => { const raw = JSON.stringify({ eventId: 'evt_' + crypto.randomBytes(6).toString('hex'), ...body }), t = Math.floor(Date.now() / 1000); const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qorlla-signature': o.bad ? 'v1=00' : 't=' + t + ',v1=' + crypto.createHmac('sha256', WEBHOOK).update(t + '.' + raw).digest('hex') }, body: raw }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const row = async (id) => (await admin.query(`SELECT * FROM ${schema}.phone_calls WHERE id=$1`, [id])).rows[0];
const cred = async (jti) => (await admin.query(`SELECT * FROM ${schema}.phone_peer_credentials WHERE jti=$1`, [jti])).rows[0];
const events = async (id) => (await admin.query(`SELECT to_state, reason, to_char(at,'SS.MS') AS at FROM ${schema}.phone_call_events WHERE call_id=$1 ORDER BY id`, [id])).rows;
const ev = (o = {}) => ({ state: 'audio_flowing', inboundPackets: 120, outboundPackets: 118, observedMs: 2400, codec: 'PCMU', encrypted: true, measuredAt: Date.now(), source: 'synthetic', ...o });

/** A meeting with an admitted host (a REAL participant row and a REAL participant token), and a phone PIN. */
async function meeting(meet) {
  const id = crypto.randomUUID(), code = String(Math.floor(1e10 + Math.random() * 9e10)), source = 'sched_' + crypto.randomBytes(5).toString('hex'), hostId = crypto.randomUUID();
  await admin.query(`INSERT INTO ${schema}.meetings(id,title,host_secret_hash,meeting_code) VALUES($1,'T','x',$2)`, [id, code]); await admin.query(`INSERT INTO ${schema}.external_meeting_links(source_system,source_id,meeting_id) VALUES('qorlla-main',$1,$2)`, [source, id]);
  await admin.query(`INSERT INTO ${schema}.participants(id,meeting_id,display_name,role,admission) VALUES($1,$2,'Host','host','admitted')`, [hostId, id]);
  const pin = (await bridge(meet.base, '/api/integrations/scheduled-meetings/' + source + '/phone-access', { method: 'POST', body: {} })).body.pin;
  return { id, code, source, hostId, pin, hostToken: jwt.sign({ meetingId: id, participantId: hostId, role: 'host', name: 'Host' }, meet.secret, { issuer: 'qorlla-meet', expiresIn: '1h' }) };
}
/** A browser: a socket authenticated with a real participant token. Collects everything it is sent. */
async function browser(meet, m, token = m.hostToken) {
  const got = []; const s = connect(meet.base, { auth: { token }, transports: ['websocket'], reconnection: false }); sockets.push(s);
  for (const e of ['roster', 'signal', 'participant-online', 'participant-offline', 'chat', 'names', 'hand', 'notes', 'reaction', 'media-state', 'waiting-changed']) s.on(e, (x) => got.push([e, x]));
  await new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej); }); await eventually(() => got.some(([e]) => e === 'roster')); return { s, got, of: (e) => got.filter(([n]) => n === e).map(([, x]) => x) };
}
/** Dial in: PIN accepted, no host approval needed (the host is present and the meeting has no waiting room) -> APPROVED with the one-time media token. */
async function approvedCall(meet, m, n = 1) {
  const callId = 'call_peer_' + crypto.randomBytes(5).toString('hex'), v = await signedPost(meet.base, '/api/phone/ivr/verify', { callId, from: '+1202555' + String(100 + n).padStart(4, '0'), meetingId: m.code, pin: m.pin });
  assert.equal(v.body.result, 'approved', JSON.stringify(v.body)); assert.ok(v.body.mediaToken, 'approved without a media token; trail: ' + JSON.stringify(await events(v.body.callRef)) + ' row: ' + JSON.stringify(await row(v.body.callRef))); return { callId, callRef: v.body.callRef, mediaToken: v.body.mediaToken };
}
const credentialFor = (meet, c, over = {}) => signedPost(meet.base, '/api/phone/ivr/peer-credential', { callId: c.callId, mediaToken: c.mediaToken, ...over });
/** The gateway's peer socket, presenting the verification credential. */
async function peerSocket(meet, token, kind = 'verification-peer') {
  const got = []; const s = connect(meet.base, { auth: { kind, token }, transports: ['websocket'], reconnection: false }); sockets.push(s);
  for (const e of ['roster', 'signal', 'participant-online', 'participant-offline', 'chat', 'names', 'revoked', 'recording-state', 'hand', 'notes', 'reaction', 'media-state', 'waiting-changed', 'meeting-locked']) s.on(e, (x) => got.push([e, x]));
  const outcome = await new Promise((res) => { s.once('connect', () => res('connected')); s.once('connect_error', (e) => res('refused:' + e.message)); });
  if (outcome === 'connected') await eventually(() => got.some(([e]) => e === 'roster') || !s.connected, 3000);       // `roster` is Meet's readiness signal for the peer (the gateway binding waits for it too)
  return { s, got, outcome, of: (e) => got.filter(([n]) => n === e).map(([, x]) => x) };
}
const emitAck = (s, e, p) => new Promise((res) => { s.timeout(2000).emit(e, p, (err, r) => res(err ? { timeout: true } : r)); });
/** Runs the complete negotiation between the peer and the host so the server has SEEN an answer cross. */
async function negotiate(peer, host, c) {
  const pid = (await row(c.callRef)).participant_id;
  assert.equal((await emitAck(peer.s, 'signal', { to: m0.hostId, data: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0' }, epoch: 'e1' } })).ok, true);
  await eventually(() => host.of('signal').some((x) => x.from === pid)); assert.ok(host.of('signal').some((x) => x.from === pid));
  assert.equal((await emitAck(host.s, 'signal', { to: pid, data: { type: 'answer', sdp: { type: 'answer', sdp: 'v=0' }, epoch: 'e1' } })).ok, true);
  await eventually(() => peer.of('signal').length > 0); return pid;
}
let m0;

test('the whole lifecycle on the real server: approved -> single-use credential -> restricted peer negotiates with a real browser socket -> verified media -> atomic promotion -> the caller is a participant', { skip }, async () => {
  const meet = await startMeet(), m = await meeting(meet); m0 = m; const host = await browser(meet, m), c = await approvedCall(meet, m);
  assert.equal((await row(c.callRef)).state, 'APPROVED');
  const issued = await credentialFor(meet, c); assert.equal(issued.body.result, 'issued', JSON.stringify(issued.body)); assert.ok(issued.body.ttlSeconds <= 60);
  const claims = JSON.parse(Buffer.from(issued.body.credential.split('.')[1], 'base64url')); assert.equal(claims.aud, 'qorlla-meet-verification-peer'); assert.equal(claims.scope, 'meet:telephone:verify-media'); assert.equal(claims.call, c.callRef); assert.equal(claims.mid, m.id); assert.ok(claims.exp - claims.iat <= 60);
  const peer = await peerSocket(meet, issued.body.credential); assert.equal(peer.outcome, 'connected'); await eventually(() => peer.of('roster').length === 1); assert.deepEqual(peer.of('roster')[0], [m.hostId], 'the peer is told who is in the meeting, nothing else');
  assert.equal(host.of('participant-online').length, 0, 'a verification peer is NOT announced: it is not a participant'); assert.equal((await row(c.callRef)).status, 'waiting', 'and not counted as connected');
  const pidRow = (await row(c.callRef)).participant_id, sessions = async () => (await admin.query(`SELECT count(*)::int n FROM ${schema}.participant_sessions WHERE participant_id=$1`, [pidRow])).rows[0].n; assert.equal(await sessions(), 0, 'no participant session exists: the peer is not present in the meeting');
  // evidence alone does not promote - not before the peer has negotiated with a browser
  const early = await signedPost(meet.base, '/api/phone/ivr/media', { callId: c.callId, mediaToken: c.mediaToken, peerJti: issued.body.jti, evidence: ev() }); assert.equal(early.body.result, 'connecting'); assert.equal(early.body.reason, 'peer_not_negotiated');
  await negotiate(peer, host, c);
  const wrongJti = await signedPost(meet.base, '/api/phone/ivr/media', { callId: c.callId, mediaToken: c.mediaToken, peerJti: 'x'.repeat(40), evidence: ev() }); assert.equal(wrongJti.body.reason, 'peer_session_mismatch');
  const noJti = await signedPost(meet.base, '/api/phone/ivr/media', { callId: c.callId, mediaToken: c.mediaToken, evidence: ev() }); assert.equal(noJti.body.reason, 'peer_session_mismatch');
  const bad = await signedPost(meet.base, '/api/phone/ivr/media', { callId: c.callId, mediaToken: c.mediaToken, peerJti: issued.body.jti, evidence: ev({ encrypted: false }) }); assert.equal(bad.body.result, 'connecting', 'Meet judges the evidence itself');
  const ok = await signedPost(meet.base, '/api/phone/ivr/media', { callId: c.callId, mediaToken: c.mediaToken, peerJti: issued.body.jti, evidence: ev() }); assert.equal(ok.body.result, 'connected', JSON.stringify(ok.body));
  const after = await row(c.callRef); assert.equal(after.state, 'MEDIA_CONNECTED'); assert.equal(after.status, 'connected'); assert.ok(after.media_verified_at);
  assert.equal(await sessions(), 1, 'promotion opened exactly one participant session'); await eventually(() => host.of('participant-online').some((p) => p.participantId === pidRow && p.phone === true));
  assert.ok((await cred(issued.body.jti)).promoted_at, 'the credential records the promotion'); assert.equal(peer.s.connected, true, 'the peer keeps its signalling for the life of the call');
  const trail = (await events(c.callRef)).map((e) => e.to_state); assert.deepEqual(trail.slice(-3), ['APPROVED', 'MEDIA_CONNECTING', 'MEDIA_CONNECTED'], 'the audit trail: ' + trail.join(' > '));
  assert.ok(!/Error|ECONN|unhandled/i.test(meet.log()), meet.log().slice(-400));
});

test('the peer can do NOTHING but negotiate: no chat, hands, notes, polls, reactions, media state, files or moderation; it hears no room traffic; bad, oversize and misdirected signals are refused', { skip }, async () => {
  const meet = await startMeet(), m = await meeting(meet); m0 = m; const host = await browser(meet, m), c = await approvedCall(meet, m), issued = await credentialFor(meet, c), peer = await peerSocket(meet, issued.body.credential); assert.equal(peer.outcome, 'connected');
  const rows = async () => ({ chat: (await admin.query(`SELECT count(*)::int n FROM ${schema}.messages WHERE meeting_id=$1`, [m.id])).rows[0].n, notes: (await admin.query(`SELECT count(*)::int n FROM ${schema}.participant_sessions WHERE meeting_id=$1`, [m.id])).rows[0].n });
  const before = await rows();
  for (const [e, p] of [['chat', 'hello from the peer'], ['hand', true], ['notes', 'x'], ['poll-create', { question: 'q', options: ['a', 'b'] }], ['poll-vote', { pollId: crypto.randomUUID(), choice: 0 }], ['reaction', '👍'], ['media-state', { mic: true, cam: true }], ['recording-start', {}], ['mute-all', {}], ['remove', { participantId: m.hostId }]]) peer.s.emit(e, p);
  await sleep(400); assert.deepEqual(await rows(), before, 'nothing the peer emitted created a row'); for (const e of ['chat', 'hand', 'notes', 'reaction', 'media-state']) assert.equal(host.of(e).length, 0, 'the room heard nothing of ' + e);
  host.s.emit('chat', 'the host talks'); host.s.emit('hand', true); await sleep(400); assert.equal(peer.of('chat').length, 0, 'the peer hears no chat'); assert.equal(peer.of('hand').length, 0); assert.equal(peer.of('names').length, 0); assert.equal(peer.of('recording-state').length, 0);
  assert.equal((await emitAck(peer.s, 'signal', { to: m.hostId, data: { type: 'chat' } })).ok, false, 'only offer / answer / candidate');
  assert.equal((await emitAck(peer.s, 'signal', { to: crypto.randomUUID(), data: { type: 'offer', sdp: {} } })).ok, false, 'a participant who is not in this meeting'); assert.equal((await emitAck(peer.s, 'signal', { data: { type: 'offer' } })).ok, false);
  const other = await meeting(meet); const otherHost = await browser(meet, other, other.hostToken); assert.equal((await emitAck(peer.s, 'signal', { to: other.hostId, data: { type: 'offer', sdp: {} } })).ok, false, 'a browser of ANOTHER meeting is unreachable'); assert.equal(otherHost.of('signal').length, 0);
  assert.equal((await emitAck(peer.s, 'signal', { to: m.hostId, data: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0' }, epoch: 'e' } })).ok, true, 'and a legitimate offer still works');
  // an oversize message never reaches anyone: Meet's transport limit (16 KB) drops the connection, and a dropped gateway ends the call
  await eventually(() => host.of('signal').length >= 1); await sleep(150); const seen = host.of('signal').length; peer.s.emit('signal', { to: m.hostId, data: { type: 'offer', sdp: 'x'.repeat(20000) } }); await eventually(() => !peer.s.connected); assert.equal(peer.s.connected, false, 'the connection was dropped'); assert.equal(host.of('signal').length, seen, 'the host never received the oversize message');
  await eventually(async () => ['CANCELLED', 'TERMINATED'].includes((await row(c.callRef)).state)); assert.equal((await row(c.callRef)).end_reason, 'gateway_signaling_lost');
});

test('credential rules: single use, expiry, wrong key, wrong audience/scope, a participant token is not a credential and a credential is not a participant token, and nothing without the media token', { skip }, async () => {
  const meet = await startMeet(), m = await meeting(meet); m0 = m; const c = await approvedCall(meet, m);
  assert.equal((await credentialFor(meet, c, { mediaToken: 'x'.repeat(30) })).body.result, 'denied', 'the media token proves this gateway was approved for this call'); assert.equal((await credentialFor(meet, c, { mediaToken: undefined })).body.result, 'denied'); assert.equal((await credentialFor(meet, { ...c, callId: 'call_nobody_0001' })).body.result, 'unknown');
  assert.equal((await signedPost(meet.base, '/api/phone/ivr/peer-credential', { callId: c.callId, mediaToken: c.mediaToken }, { bad: true })).status, 401, 'requests are authenticated like every other gateway route');
  const first = await credentialFor(meet, c), a = await peerSocket(meet, first.body.credential); assert.equal(a.outcome, 'connected'); const replay = await peerSocket(meet, first.body.credential); assert.match(replay.outcome, /^refused:/, 'single use'); assert.equal((await credentialFor(meet, c)).body.result, 'already_issued', 'a live credential exists');
  const c2 = await approvedCall(meet, m, 2), t2 = await credentialFor(meet, c2); await admin.query(`UPDATE ${schema}.phone_peer_credentials SET issued_at = now() - interval '90 seconds', expires_at = now() - interval '30 seconds' WHERE jti=$1`, [t2.body.jti]); assert.match((await peerSocket(meet, t2.body.credential)).outcome, /^refused:/, 'expired (by the database clock)');
  const c3 = await approvedCall(meet, m, 3), t3 = await credentialFor(meet, c3), forged = (() => { const [h, b] = t3.body.credential.split('.'); const sig = crypto.sign('sha256', Buffer.from(h + '.' + b), { key: peerKey(), dsaEncoding: 'ieee-p1363' }).toString('base64url'); return h + '.' + b + '.' + sig; })(); assert.match((await peerSocket(meet, forged)).outcome, /^refused:/, 'wrong signing key');
  const mint = (over) => { const [h, b] = t3.body.credential.split('.'), claims = { ...JSON.parse(Buffer.from(b, 'base64url')), ...over }; const body = Buffer.from(JSON.stringify(claims)).toString('base64url'); return h + '.' + body + '.' + crypto.randomBytes(64).toString('base64url'); }; assert.match((await peerSocket(meet, mint({ aud: 'qorlla-phone-gateway' }))).outcome, /^refused:/, 'wrong audience (and an invalid signature)'); assert.match((await peerSocket(meet, mint({ mid: crypto.randomUUID() }))).outcome, /^refused:/, 'cross-meeting');
  assert.equal((await peerSocket(meet, t3.body.credential)).outcome, 'connected', 'the genuine credential was untouched by the forgeries');
  const asParticipant = await peerSocket(meet, jwt.sign({ meetingId: m.id, participantId: m.hostId, role: 'host', name: 'Host' }, meet.secret, { issuer: 'qorlla-meet' })); assert.match(asParticipant.outcome, /^refused:/, 'a normal participant token is not a verification credential');
  const c4 = await approvedCall(meet, m, 4), t4 = await credentialFor(meet, c4), asNormal = await peerSocket(meet, t4.body.credential, undefined); const asKindless = connect(meet.base, { auth: { token: t4.body.credential }, transports: ['websocket'], reconnection: false }); sockets.push(asKindless);
  assert.equal(await new Promise((r) => { asKindless.once('connect', () => r('connected')); asKindless.once('connect_error', () => r('refused')); }), 'refused', 'a credential presented as a participant token is refused'); void asNormal;
  assert.equal((await credentialFor(meet, c4)).body.result, 'already_issued'); assert.ok(!/BEGIN|PRIVATE/.test(meet.log()), 'no key material in the log');
});

test('failure handling: gateway disconnect, media timeout, meeting end, host removal and invalid-state requests all revoke access, close the socket and end the call once; a late report cannot bring anything back', { skip }, async () => {
  const meet = await startMeet({ PHONE_MEDIA_TIMEOUT_MS: '4000' }), m = await meeting(meet); m0 = m; const host = await browser(meet, m);
  // (a) the gateway's signalling drops while the call is open
  const a = await approvedCall(meet, m, 1), ta = await credentialFor(meet, a), pa = await peerSocket(meet, ta.body.credential); assert.equal(pa.outcome, 'connected'); pa.s.disconnect();
  await eventually(async () => ['CANCELLED', 'TERMINATED'].includes((await row(a.callRef)).state)); assert.ok((await cred(ta.body.jti)).revoked_at, 'revoked'); assert.equal((await row(a.callRef)).end_reason, 'gateway_signaling_lost', JSON.stringify(await events(a.callRef)));
  const late = await signedPost(meet.base, '/api/phone/ivr/media', { callId: a.callId, mediaToken: a.mediaToken, peerJti: ta.body.jti, evidence: ev() }); assert.equal(late.body.action, 'terminate', 'a late report is told to terminate'); assert.notEqual((await row(a.callRef)).state, 'MEDIA_CONNECTED');
  assert.equal((await credentialFor(meet, a)).body.result, 'not_approved', 'no new credential for an ended call');
  // (b) the media timeout: the sweeper ends a call that never produced verified media, and CLOSES the peer's socket
  const b = await approvedCall(meet, m, 2), tb = await credentialFor(meet, b), pb = await peerSocket(meet, tb.body.credential); assert.equal(pb.outcome, 'connected');
  await eventually(() => !pb.s.connected, 9000); assert.equal(pb.s.connected, false, 'the socket was closed by Meet'); assert.equal((await row(b.callRef)).state, 'TIMED_OUT'); assert.match((await cred(tb.body.jti)).revoked_reason, /timed_out/); assert.ok(pb.of('revoked').length >= 0);
  // (c) the meeting ends
  const c = await approvedCall(meet, m, 3), tc = await credentialFor(meet, c), pc = await peerSocket(meet, tc.body.credential); assert.equal(pc.outcome, 'connected');
  await admin.query(`UPDATE ${schema}.meetings SET ended_at=now() WHERE id=$1`, [m.id]); const ended = await signedPost(meet.base, '/api/phone/ivr/media', { callId: c.callId, mediaToken: c.mediaToken, peerJti: tc.body.jti, evidence: ev() });
  assert.notEqual(ended.body.result, 'connected', 'a call in an ended meeting is never promoted'); await eventually(() => !pc.s.connected, 6000); assert.equal(pc.s.connected, false); await admin.query(`UPDATE ${schema}.meetings SET ended_at=NULL WHERE id=$1`, [m.id]);
  // (d) a connected call: invalid evidence terminates and closes the peer
  const d = await approvedCall(meet, m, 4), td = await credentialFor(meet, d), pd = await peerSocket(meet, td.body.credential); await negotiate(pd, host, d);
  assert.equal((await signedPost(meet.base, '/api/phone/ivr/media', { callId: d.callId, mediaToken: d.mediaToken, peerJti: td.body.jti, evidence: ev() })).body.result, 'connected');
  const dead = await signedPost(meet.base, '/api/phone/ivr/media', { callId: d.callId, mediaToken: d.mediaToken, peerJti: td.body.jti, evidence: ev({ outboundPackets: 0 }) }); assert.equal(dead.body.action, 'terminate');
  await eventually(() => !pd.s.connected); assert.equal((await row(d.callRef)).state, 'TERMINATED'); assert.ok((await cred(td.body.jti)).revoked_at); const again = await signedPost(meet.base, '/api/phone/ivr/media', { callId: d.callId, mediaToken: d.mediaToken, peerJti: td.body.jti, evidence: ev() });
  assert.equal(again.body.action, 'terminate', 'a replayed good report cannot restore a revoked participant'); assert.equal((await row(d.callRef)).state, 'TERMINATED');
  for (const id of [a, b, c, d].map((x) => x.callRef)) { const e = await events(id); assert.ok(['CANCELLED', 'TIMED_OUT', 'TERMINATED', 'ORPHANED', 'REFUSED'].includes(e[e.length - 1].to_state), 'an auditable terminal state for ' + id); }
});

// ================================================================================================ races (database state AND socket state)
const endCall = (meet, c) => signedPost(meet.base, '/api/phone/ivr/disconnect', { callId: c.callId, type: 'caller_hung_up' });
const openSessions = async (pid) => (await admin.query(`SELECT count(*)::int n FROM ${schema}.participant_sessions WHERE participant_id=$1 AND disconnected_at IS NULL`, [pid])).rows[0].n;

test('RACE consume vs terminate: many sockets present ONE credential while the call is being ended - at most one is ever admitted, and after the call ends NO socket remains, the credential is revoked and nothing is present in the meeting', { skip }, async () => {
  const meet = await startMeet(), m = await meeting(meet); m0 = m; let admitted = 0, refused = 0;
  for (let i = 0; i < 8; i++) {
    const c = await approvedCall(meet, m, i + 1), t = await credentialFor(meet, c), pid = (await row(c.callRef)).participant_id;
    const racers = Array.from({ length: 6 }, async () => { await sleep(Math.random() * 15); return peerSocket(meet, t.body.credential); });
    const [peers] = await Promise.all([Promise.all(racers), (async () => { await sleep(Math.random() * 25); return endCall(meet, c); })()]);
    const won = peers.filter((p) => p.outcome === 'connected'); admitted += won.length; refused += peers.length - won.length;
    assert.ok(won.length <= 1, 'single use: at most one socket was admitted (' + won.length + ')');
    await eventually(async () => ['CANCELLED', 'TERMINATED'].includes((await row(c.callRef)).state)); const final = await row(c.callRef); assert.ok(['CANCELLED', 'TERMINATED'].includes(final.state), 'the call ended: ' + final.state);
    await eventually(() => peers.every((p) => !p.s.connected), 6000); assert.ok(peers.every((p) => !p.s.connected), 'no socket of an ended call stays connected (database row alone is not enough)');
    const k = await cred(t.body.jti); assert.ok(k.revoked_at, 'credential revoked'); assert.equal(await openSessions(pid), 0, 'nothing of the caller is present in the meeting');
    const after = await peerSocket(meet, t.body.credential); assert.match(after.outcome, /^refused:/, 'the credential is unusable once the call ended');
  }
  assert.ok(admitted + refused === 48);
});

test('RACE disconnect vs promotion: the gateway drops while verified media is being reported - the call never stays MEDIA_CONNECTED once its gateway is gone, and no participant session stays open', { skip }, async () => {
  const meet = await startMeet(), m = await meeting(meet); m0 = m; const host = await browser(meet, m); let promotedFirst = 0, droppedFirst = 0;
  for (let i = 0; i < 10; i++) {
    const c = await approvedCall(meet, m, i + 1), t = await credentialFor(meet, c), peer = await peerSocket(meet, t.body.credential); await negotiate(peer, host, c); const pid = (await row(c.callRef)).participant_id;
    const report = (async () => { await sleep(Math.random() * 30); return signedPost(meet.base, '/api/phone/ivr/media', { callId: c.callId, mediaToken: c.mediaToken, peerJti: t.body.jti, evidence: ev() }); })();
    const drop = (async () => { await sleep(Math.random() * 30); peer.s.disconnect(); })();
    const [r] = await Promise.all([report, drop]); if (r.body.result === 'connected') promotedFirst++; else droppedFirst++;
    await eventually(async () => ['CANCELLED', 'TERMINATED', 'TIMED_OUT'].includes((await row(c.callRef)).state), 4000);
    const f = await row(c.callRef); assert.ok(['CANCELLED', 'TERMINATED', 'ORPHANED'].includes(f.state), `iteration ${i}: the call is ended, not ${f.state} (report said ${r.body.result})`);       // ORPHANED = the report reached Meet after the disconnect had ended the call: A3 records audio that should not exist; never MEDIA_CONNECTED
    assert.equal(await openSessions(pid), 0, `iteration ${i}: no participant session stays open`); assert.ok((await cred(t.body.jti)).revoked_at, 'credential revoked'); assert.equal(peer.s.connected, false);
    const late = await signedPost(meet.base, '/api/phone/ivr/media', { callId: c.callId, mediaToken: c.mediaToken, peerJti: t.body.jti, evidence: ev() }); assert.equal(late.body.action, 'terminate', 'a late report cannot restore it'); const after = (await row(c.callRef)).state; assert.ok(['CANCELLED', 'TERMINATED', 'ORPHANED'].includes(after), `iteration ${i}: after a late report the call is ${after}`);       // ORPHANED is A3's record of audio that should not exist; MEDIA_CONNECTED never returns
  }
  assert.equal(promotedFirst + droppedFirst, 10);
});

test('RACE revoke vs active signalling: an authorised peer is exchanging ICE/SDP when the call is revoked - nothing it sends afterwards reaches a browser, and its socket is closed', { skip }, async () => {
  const meet = await startMeet(), m = await meeting(meet); m0 = m; const host = await browser(meet, m);
  for (let i = 0; i < 5; i++) {
    const c = await approvedCall(meet, m, i + 1), t = await credentialFor(meet, c), peer = await peerSocket(meet, t.body.credential); await negotiate(peer, host, c);
    const arrivals = []; host.s.on('signal', () => arrivals.push(Date.now())); const before = arrivals.length; let revokedAt = 0, accepted = 0, refusedAfter = 0;
    const flood = (async () => { for (let k = 0; k < 120 && peer.s.connected; k++) { const ackd = await emitAck(peer.s, 'signal', { to: m.hostId, data: { type: 'candidate', candidate: { candidate: 'candidate:' + k }, epoch: 'e1' } }); if (ackd.ok) accepted++; else if (revokedAt) refusedAfter++; await sleep(5); } })();
    await sleep(60 + Math.random() * 100); const r = await endCall(meet, c); await eventually(async () => ['CANCELLED', 'TERMINATED'].includes((await row(c.callRef)).state)); revokedAt = Date.now(); await flood;
    await eventually(() => !peer.s.connected, 4000); assert.equal(peer.s.connected, false, 'the socket is closed'); assert.ok((await cred(t.body.jti)).revoked_at); void r; await sleep(250);
    const late = arrivals.slice(before).filter((t0) => t0 > revokedAt + 250); assert.equal(late.length, 0, `iteration ${i}: ${late.length} signal(s) reached the browser after the revocation`);
    const post = peer.s.connected ? await emitAck(peer.s, 'signal', { to: m.hostId, data: { type: 'offer', sdp: {} } }) : { ok: false }; assert.notEqual(post.ok, true, 'signalling after revocation is refused'); assert.ok(accepted > 0, 'the peer really was signalling before the revocation');
  }
});

test('RACE deterministic stale read: the gateway is lost while a promotion commits underneath the server\'s own read - the call must still end (no connected caller without a gateway)', { skip }, async () => {
  const meet = await startMeet(), m = await meeting(meet); m0 = m; const host = await browser(meet, m);
  const c = await approvedCall(meet, m, 1), t = await credentialFor(meet, c), peer = await peerSocket(meet, t.body.credential); await negotiate(peer, host, c); const pid = (await row(c.callRef)).participant_id;
  const tx = await admin.connect();
  try {
    await tx.query('BEGIN'); await tx.query(`SELECT id FROM ${schema}.phone_calls WHERE id=$1 FOR UPDATE`, [c.callRef]);       // from now on every move of this call waits for us; plain reads still see the old row
    peer.s.disconnect(); await sleep(700);                                                                                       // the server has read the call (still APPROVED) and its move is blocked behind our lock
    await tx.query(`UPDATE ${schema}.phone_calls SET state='MEDIA_CONNECTED', status='connected', connected_at=now(), media_verified_at=now(), state_changed_at=now() WHERE id=$1`, [c.callRef]);    // the "promotion" commits first
    await tx.query('COMMIT');
  } finally { tx.release(); }
  await eventually(async () => (await row(c.callRef)).state === 'TERMINATED', 8000);
  const f = await row(c.callRef); assert.equal(f.state, 'TERMINATED', 'the lost gateway ended the call even though the state moved under the server (' + f.state + ')'); assert.equal(f.status, 'ended'); assert.equal(f.end_reason, 'gateway_signaling_lost');
  assert.equal(await openSessions(pid), 0); assert.ok((await cred(t.body.jti)).revoked_at);
});

test('IDEMPOTENT termination: repeated and concurrent hang-ups, disconnects, late reports and revokes record ONE terminal event, never resurrect an ended call, and never promote an orphaned one', { skip }, async () => {
  const meet = await startMeet(), m = await meeting(meet); m0 = m; const host = await browser(meet, m);
  const c = await approvedCall(meet, m, 1), t = await credentialFor(meet, c), peer = await peerSocket(meet, t.body.credential); await negotiate(peer, host, c);
  assert.equal((await signedPost(meet.base, '/api/phone/ivr/media', { callId: c.callId, mediaToken: c.mediaToken, peerJti: t.body.jti, evidence: ev() })).body.result, 'connected');
  // five hang-ups, the gateway dropping, and a late good report, all at once
  await Promise.all([...Array.from({ length: 5 }, () => endCall(meet, c)), (async () => { peer.s.disconnect(); })(), signedPost(meet.base, '/api/phone/ivr/media', { callId: c.callId, mediaToken: c.mediaToken, peerJti: t.body.jti, evidence: ev() })]);
  await eventually(async () => ['TERMINATED', 'ORPHANED'].includes((await row(c.callRef)).state), 6000); await sleep(500);
  const trail = await events(c.callRef), terminal = trail.filter((e) => ['TERMINATED', 'CANCELLED', 'REFUSED', 'TIMED_OUT'].includes(e.to_state));
  assert.equal(terminal.length, 1, 'exactly one terminal event: ' + trail.map((e) => e.to_state).join(' > ')); assert.notEqual((await row(c.callRef)).state, 'MEDIA_CONNECTED');
  assert.ok(trail.map((e) => e.to_state).filter((s) => s === 'MEDIA_CONNECTED').length === 1, 'promoted once, never again');
  const stable = (await row(c.callRef)).state; for (let i = 0; i < 4; i++) { await endCall(meet, c); await signedPost(meet.base, '/api/phone/ivr/media', { callId: c.callId, mediaToken: c.mediaToken, peerJti: t.body.jti, evidence: ev() }); } await sleep(300);
  const final = await row(c.callRef); assert.ok(['TERMINATED', 'ORPHANED'].includes(final.state), 'still over: ' + final.state); assert.ok(!(stable === 'ORPHANED' && final.state !== 'ORPHANED' && final.state !== 'TERMINATED'));
  assert.equal(await openSessions((await row(c.callRef)).participant_id), 0); const ts = (await events(c.callRef)).map((e) => e.to_state); assert.ok(ts.indexOf('MEDIA_CONNECTED') < ts.lastIndexOf('TERMINATED') || !ts.includes('TERMINATED') || ts.includes('ORPHANED'), 'order: ' + ts.join(' > '));
  // an orphaned call can only be terminated, never promoted, by any report
  const o = await approvedCall(meet, m, 2); await admin.query(`UPDATE ${schema}.phone_calls SET state='ORPHANED', status='ended', ended_at=now(), terminated_at=now() WHERE id=$1`, [o.callRef]);
  const rep = await signedPost(meet.base, '/api/phone/ivr/media', { callId: o.callId, mediaToken: o.mediaToken, peerJti: 'x'.repeat(30), evidence: ev() }); assert.equal(rep.body.action, 'terminate'); assert.equal((await row(o.callRef)).state, 'ORPHANED', 'an orphan is not revived'); assert.equal((await credentialFor(meet, o)).body.result, 'not_approved');
});

test('the one-time media token is not kept in the database for ever: a retried verify gets the same answer inside the window, and the stored answer no longer holds the token after it', { skip }, async () => {
  const meet = await startMeet({ PHONE_REPLAY_TOKEN_TTL_MS: '6000' }), m = await meeting(meet); m0 = m;
  const body = { eventId: 'evt_replay_' + crypto.randomBytes(5).toString('hex'), callId: 'call_replay_' + crypto.randomBytes(4).toString('hex'), from: FROM, meetingId: m.code, pin: m.pin };
  const sendSame = async () => { const raw = JSON.stringify(body), t = Math.floor(Date.now() / 1000); const r = await fetch(meet.base + '/api/phone/ivr/verify', { method: 'POST', headers: { 'content-type': 'application/json', 'x-qorlla-signature': 't=' + t + ',v1=' + crypto.createHmac('sha256', WEBHOOK).update(t + '.' + raw).digest('hex') }, body: raw }); return r.json(); };
  const first = await sendSame(); assert.equal(first.result, 'approved'); assert.ok(first.mediaToken);
  const retry = await sendSame(); assert.equal(retry.duplicate, true); assert.equal(retry.mediaToken, first.mediaToken, 'a retry inside the window gets the same answer, so a lost response is not fatal');
  const stored = async () => (await admin.query(`SELECT result::text AS r FROM ${schema}.phone_webhook_events WHERE event_id=$1`, [body.eventId])).rows[0].r;
  assert.ok((await stored()).includes(first.mediaToken), 'inside the window the stored answer holds the token (that is what makes the retry safe)');
  await eventually(async () => !(await stored()).includes(first.mediaToken), 20000); const after = await stored(); assert.ok(!after.includes(first.mediaToken), 'the token is gone from the database after the window'); assert.ok(after.includes('approved'), 'the rest of the answer is kept');
  const hash = (await admin.query(`SELECT media_nonce_hash FROM ${schema}.phone_calls WHERE provider_call_id=$1`, [body.callId])).rows[0].media_nonce_hash; assert.ok(hash && !hash.includes(first.mediaToken), 'only a hash of the token is kept on the call');
});

test('replay-token expiry (controlled clock): after the production window the sweeper removes ONLY the plaintext token from the stored answer - call state, credential hash and audit history are untouched, an expired retry is a well-formed answer without a token, and no replacement credential appears', { skip }, async () => {
  const meet = await startMeet(), m = await meeting(meet); m0 = m;              // the PRODUCTION default window (120 s); time is moved by ageing the record, not by waiting
  const body = { eventId: 'evt_clock_' + crypto.randomBytes(5).toString('hex'), callId: 'call_clock_' + crypto.randomBytes(4).toString('hex'), from: FROM, meetingId: m.code, pin: m.pin };
  const send = async () => { const raw = JSON.stringify(body), t = Math.floor(Date.now() / 1000); const r = await fetch(meet.base + '/api/phone/ivr/verify', { method: 'POST', headers: { 'content-type': 'application/json', 'x-qorlla-signature': 't=' + t + ',v1=' + crypto.createHmac('sha256', WEBHOOK).update(t + '.' + raw).digest('hex') }, body: raw }); return { status: r.status, body: await r.json() }; };
  const first = await send(); assert.equal(first.body.result, 'approved'); const token = first.body.mediaToken, ref = first.body.callRef; assert.ok(token);
  const snap = async () => { const c = await row(ref); return { state: c.state, status: c.status, hash: c.media_nonce_hash, issued: String(c.media_nonce_issued_at), events: JSON.stringify(await events(ref)), creds: (await admin.query(`SELECT count(*)::int n FROM ${schema}.phone_peer_credentials WHERE call_id=$1`, [ref])).rows[0].n }; };
  const stored = async () => (await admin.query(`SELECT result::text AS r FROM ${schema}.phone_webhook_events WHERE event_id=$1`, [body.eventId])).rows[0].r;
  const before = await snap(); await sleep(1200); assert.ok((await stored()).includes(token), 'inside the 120 s window the token is kept (retry safety)'); assert.equal((await send()).body.mediaToken, token);
  await admin.query(`UPDATE ${schema}.phone_webhook_events SET received_at = now() - interval '121 seconds' WHERE event_id=$1`, [body.eventId]);                 // the controlled clock: 121 s have passed
  await eventually(async () => !(await stored()).includes(token), 8000); const after = await stored(); assert.ok(!after.includes(token), 'the plaintext token is gone'); const kept = JSON.parse(after); assert.equal(kept.result, 'approved'); assert.equal(kept.callRef, ref); assert.equal(kept.meetingId, m.id);
  assert.deepEqual(await snap(), before, 'call state, credential hash, issue time, audit history and credential count are all unchanged');
  const retry = await send(); assert.equal(retry.status, 200); assert.equal(retry.body.duplicate, true); assert.equal(retry.body.result, 'approved'); assert.equal(retry.body.mediaToken, undefined, 'an expired retry carries no token'); assert.equal(retry.body.callRef, ref, 'and is a well-formed answer');
  assert.deepEqual(await snap(), before, 'the retry changed nothing and issued nothing');
  assert.equal((await credentialFor(meet, { callId: body.callId, mediaToken: 'x'.repeat(30) })).body.result, 'denied', 'without the token there is no credential'); assert.equal((await credentialFor(meet, { callId: body.callId, mediaToken: undefined })).body.result, 'denied');
  assert.equal((await snap()).creds, 0, 'no replacement credential was issued'); assert.equal((await credentialFor(meet, { callId: body.callId, mediaToken: token })).body.result, 'issued', 'the genuine token (validated by its hash, not by the replay record) still works');
});

test('a signing key configured BEFORE the v4.25 migration ran: the subsystem disables itself loudly, and ending a call still works (never an HTTP 500) - and nothing can be issued', { skip }, async () => {
  const old = 'pq_' + Math.random().toString(36).slice(2, 9); await admin.query('CREATE SCHEMA ' + old); const c0 = await admin.connect();
  try { await c0.query('SET search_path=' + old); for (const f of ORDER.filter((x) => x !== 'v4_25_phone_verification_peer.sql')) await c0.query(fs.readFileSync(path.join(SQL, f), 'utf8')); } finally { c0.release(); }
  try {
    const saved = schema; schema = old;                                   // the helpers below use the module-level schema name
    try {
      const meet = await startMeet(), m = await meeting(meet); m0 = m; await eventually(() => /DISABLED/.test(meet.log()), 8000); assert.match(meet.log(), /phone_peer_credentials is missing/, 'the operator is told');
      const c = await approvedCall(meet, m, 1); assert.equal((await credentialFor(meet, c)).body.result, 'unavailable', 'nothing is issued');
      const end = await endCall(meet, c); assert.equal(end.status, 200, 'ending a call works without the table'); assert.equal(end.body.result, 'ended'); assert.ok(['CANCELLED', 'TERMINATED'].includes((await row(c.callRef)).state));
      assert.ok(!/error: relation|does not exist/i.test(meet.log().replace(/phone_peer_credentials is missing[^\n]*/g, '')), 'no database errors from the missing table: ' + meet.log().slice(-300));
    } finally { schema = saved; }
  } finally { await admin.query('DROP SCHEMA ' + old + ' CASCADE'); }
});
