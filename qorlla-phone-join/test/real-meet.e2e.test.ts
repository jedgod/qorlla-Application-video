import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import pg from 'pg';
import { admitTelephoneCall, type Readiness } from '../src/admission.js';
import { MeetPhoneAuthority } from '../src/meet-authority.js';
import { meetConfirmedBridge } from '../src/meet-media.js';
import { MeetReadiness, MeetDirectoryClient } from '../src/readiness-meet.js';
import type { AudioEvidence, MediaGateway } from '../src/media-contract.js';
import { keypair, eventually, sleep } from './support.js';

// This package against the REAL Qorlla Meet server process (branch feature/qorlla-meet-telephone-admission-meet, lifecycle v4.24), not a double: real routes, real PostgreSQL, real lifecycle, real Shield-less
// test-double mode and real gateway mode. Needs:
//   MEET_SERVER_DIR=<path to qorlla-meet-video of that branch>   PHONE_JOIN_TEST_DATABASE_URL=postgres://...   (skipped, and reported as skipped, without them)
// Gateway mode on the real server cannot reach "ready" (no carrier, no media bridge exist), so it is used here to prove the gateway identity and the readiness client against the real endpoints, and that the system
// refuses every admission. Nothing here is certification evidence for real telephone calls.
const MEET_DIR = process.env.MEET_SERVER_DIR, URL_ = process.env.PHONE_JOIN_TEST_DATABASE_URL;
const skip = !MEET_DIR || !fs.existsSync(path.join(MEET_DIR, 'server', 'index.js')) ? 'MEET_SERVER_DIR (qorlla-meet-video with the lifecycle) is not set' : !URL_ ? 'PHONE_JOIN_TEST_DATABASE_URL is not set' : false;
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', 'v4_7_recording_consent.sql', 'v4_8_collab.sql', 'v4_9_recording_storage.sql', 'v4_10_admission.sql', 'v4_11_history.sql', 'v4_12_limit.sql',
  'v4_13_phone.sql', 'v4_14_telephony.sql', 'v4_15_telephony_features.sql', 'v4_16_number_authority.sql', 'v4_17_shield_identity.sql', 'v4_18_billing_hold.sql', 'v4_19_ai_request.sql', 'v4_20_ai_consent_seq.sql', 'v4_21_handoffs.sql', 'v4_22_host_controls.sql', 'v4_24_phone_lifecycle.sql'];
const all: Readiness = { carrierConnected: true, inboundNumberCertified: true, gatewayHealthy: true, mediaBridgeCertified: true, billingCertified: true, productionApproved: true };
const BRIDGE = crypto.randomBytes(24).toString('hex'), WEBHOOK = 'real-meet-webhook-secret-0123456789', FROM = '+12025550143', kp = keypair();
let schema = '', admin: pg.Pool; const procs: ChildProcess[] = [];
const freePort = () => new Promise<number>((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
test.before(async () => {
  if (skip) return; schema = 'rm_' + Math.random().toString(36).slice(2, 9); admin = new pg.Pool({ connectionString: URL_ }); await admin.query('CREATE SCHEMA ' + schema);
  const c = await admin.connect(); try { await c.query('SET search_path=' + schema); for (const f of ORDER) await c.query(fs.readFileSync(path.join(MEET_DIR!, 'sql', f), 'utf8')); } finally { c.release(); }
});
test.after(async () => { for (const p of procs) { try { p.kill(); } catch { /* gone */ } } await sleep(300); if (skip) return; await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); });

async function startMeet(extra: Record<string, string> = {}) {
  const port = await freePort(), store = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-rec-'));
  const env = { ...process.env, PORT: String(port), DATABASE_URL: URL_ + (URL_!.includes('?') ? '&' : '?') + 'options=' + encodeURIComponent('-c search_path=' + schema), JWT_SECRET: crypto.randomBytes(32).toString('hex'), QORLLA_BRIDGE_SECRET: BRIDGE, RECOVERY_ESCROW_KEY: crypto.randomBytes(32).toString('base64'),
    RECORDING_MASTER_KEYS: JSON.stringify({ k1: crypto.randomBytes(32).toString('base64') }), RECORDING_ACTIVE_KEY_ID: 'k1', RECORDING_STORE_DIR: store, RECORDING_ADMIN_SECRET: 'x'.repeat(24), NODE_ENV: 'development', PHONE_SWEEP_MS: '300', ...extra };
  const child = spawn(process.execPath, ['server/index.js'], { cwd: MEET_DIR!, env, stdio: ['ignore', 'pipe', 'pipe'] }); procs.push(child); let log = ''; child.stdout!.on('data', (d) => (log += d)); child.stderr!.on('data', (d) => (log += d));
  const base = 'http://127.0.0.1:' + port; for (let i = 0; i < 80; i++) { if (await fetch(base + '/api/ready').then((r) => r.ok).catch(() => false)) return { base, log: () => log }; await sleep(250); } throw new Error('Meet did not start: ' + log.slice(-600));
}
const seed = async (waitingRoom = false) => { const id = crypto.randomUUID(), code = String(Math.floor(1e10 + Math.random() * 9e10)), source = 'sched_' + crypto.randomBytes(5).toString('hex');
  await admin.query(`INSERT INTO ${schema}.meetings(id,title,host_secret_hash,meeting_code,waiting_room) VALUES($1,'T','x',$2,$3)`, [id, code, waitingRoom]); await admin.query(`INSERT INTO ${schema}.external_meeting_links(source_system,source_id,meeting_id) VALUES('qorlla-main',$1,$2)`, [source, id]); return { id, code, source }; };
const bridgeCall = (base: string, p: string, o: { method?: string; body?: object } = {}) => fetch(base + p, { method: o.method ?? 'GET', headers: { 'x-qorlla-bridge-secret': BRIDGE, 'content-type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as any }));
const pinFor = async (base: string, source: string) => (await bridgeCall(base, '/api/integrations/scheduled-meetings/' + source + '/phone-access', { method: 'POST', body: {} })).body.pin as string;
const callsOf = async (base: string, source: string) => (await bridgeCall(base, '/api/integrations/scheduled-meetings/' + source + '/phone-calls')).body.calls as { id: string; status: string; state: string }[];
const evidence = (o: Partial<AudioEvidence> = {}): AudioEvidence => ({ state: 'audio_flowing', inboundPackets: 120, outboundPackets: 118, observedMs: 2400, codec: 'opus', encrypted: true, measuredAt: Date.now(), ...o });
const gw = (ev: () => AudioEvidence = () => evidence(), log: string[] = []): MediaGateway => ({ start: async (id) => { log.push('start:' + id); return ev(); }, stop: async (id) => { log.push('stop:' + id); }, onEnded: () => {} });
const request = (m: { code: string }, pin: string, id: string, over: object = {}) => ({ meetingId: m.code, passcode: pin, callId: id, dialedNumber: '+12025550100', callerNumber: FROM, ...over });

test('REAL Meet (test-double mode): PIN -> approved -> this package\'s verified media -> Meet itself says connected; weak media is refused by the package AND by Meet; the hang-up is confirmed', { skip }, async () => {
  const meet = await startMeet({ PHONE_PROVIDER: 'test', PHONE_WEBHOOK_SECRET: WEBHOOK }), m = await seed(), pin = await pinFor(meet.base, m.source);
  const authority = new MeetPhoneAuthority({ baseUrl: meet.base, auth: { kind: 'hmac', secret: WEBHOOK }, pollMs: 50 }), log: string[] = [];
  const r = await admitTelephoneCall(request(m, pin, 'call_real_000001'), all, authority, meetConfirmedBridge({ gateway: gw(undefined, log), meet: authority })); assert.equal(r.code, 'MEDIA_CONNECTED'); assert.deepEqual(log, ['start:call_real_000001']);
  let list = await callsOf(meet.base, m.source); assert.equal(list.length, 1); assert.equal(list[0].status, 'connected'); assert.equal(list[0].state, 'MEDIA_CONNECTED');
  // a faulty gateway that skips its own check: Meet still judges the raw evidence
  const v = await authority.verifyPhoneJoin(m.code, pin, { signal: new AbortController().signal, callId: 'call_real_000002', dialedNumber: '+12025550100', callerNumber: '+12025550144' }); assert.equal(v.requiresHostApproval, false); assert.ok(v.mediaToken);
  assert.equal((await authority.reportMedia('call_real_000002', v.mediaToken!, evidence({ outboundPackets: 0 }))).result, 'connecting'); assert.equal((await authority.reportMedia('call_real_000002', 'wrong-token', evidence())).result, 'denied');
  list = await callsOf(meet.base, m.source); assert.equal(list.find((c) => c.state === 'MEDIA_CONNECTING')?.status, 'waiting', 'one-way audio is not connected, in Meet\'s own record');
  assert.equal((await authority.reportMedia('call_real_000002', v.mediaToken!, evidence())).result, 'connected');
  // the hang-up: Meet ends the call, and a later media report from a leg that should not exist is told to terminate
  await authority.callEnded('call_real_000001'); assert.equal((await authority.reportMedia('call_real_000001', 'x', evidence())).action, 'terminate'); list = await callsOf(meet.base, m.source); assert.equal(list.filter((c) => c.status === 'connected').length, 1);
  const states = (await admin.query(`SELECT to_state FROM ${schema}.phone_call_events e JOIN ${schema}.phone_calls c ON c.id=e.call_id WHERE c.provider_call_id='call_real_000001' ORDER BY e.id`)).rows.map((x) => x.to_state);
  assert.deepEqual(states, ['REQUESTED', 'VERIFIED', 'APPROVED', 'MEDIA_CONNECTING', 'MEDIA_CONNECTED', 'TERMINATED']);
});
test('REAL Meet: media that never arrives times out in Meet by itself; media that shows up LATE is told to terminate (ORPHANED); the package\'s own media timeout and Meet agree', { skip }, async () => {
  const meet = await startMeet({ PHONE_PROVIDER: 'test', PHONE_WEBHOOK_SECRET: WEBHOOK, PHONE_MEDIA_TIMEOUT_MS: '1500' }), m = await seed(), pin = await pinFor(meet.base, m.source);
  const authority = new MeetPhoneAuthority({ baseUrl: meet.base, auth: { kind: 'hmac', secret: WEBHOOK } }), log: string[] = []; let release = () => {}; const slow = new Promise<void>((r) => { release = r; });
  const gateway: MediaGateway = { start: async (id) => { log.push('start:' + id); await slow; return evidence(); }, stop: async (id) => { log.push('stop:' + id); }, onEnded: () => {} };
  const bridge = meetConfirmedBridge({ gateway, meet: authority }); const orphans: boolean[] = [];
  const r = await admitTelephoneCall(request(m, pin, 'call_real_000010'), all, authority, bridge, { stepTimeoutMs: 3000, onLateMedia: (_id, ok) => orphans.push(ok) }); assert.equal(r.code, 'MEDIA_UNAVAILABLE'); assert.ok(log.includes('stop:call_real_000010'), 'torn down at the package\'s own timeout');
  assert.ok(await eventually(async () => ['TIMED_OUT', 'TERMINATED'].includes((await callsOf(meet.base, m.source))[0].state), 12000), 'Meet ended the approved call without any audio'); assert.equal((await admin.query(`SELECT end_reason FROM ${schema}.phone_calls WHERE provider_call_id='call_real_000010'`)).rows[0].end_reason, 'media_timeout', 'Meet timed it out by itself, before the package gave up'); release();
  assert.ok(await eventually(() => orphans.length === 1, 5000), 'the late leg was found and terminated by the package'); assert.deepEqual(orphans, [true]);
  assert.ok(await eventually(async () => Number((await admin.query(`SELECT count(*)::int AS n FROM ${schema}.audit_events WHERE event_type='phone.late_media' AND meeting_id=$1`, [m.id])).rows[0].n) >= 1, 8000), 'Meet, told about that late audio, refused it and recorded it in its audit trail');
  assert.ok(log.filter((x) => x === 'stop:call_real_000010').length >= 2, 'the late leg was disconnected again when it appeared');
});
test('REAL Meet: a waiting-room caller whose host never answers - the wait is bounded, the decision is Meet\'s durable one, and the caller is not left waiting', { skip }, async () => {
  const meet = await startMeet({ PHONE_PROVIDER: 'test', PHONE_WEBHOOK_SECRET: WEBHOOK, PHONE_APPROVAL_TIMEOUT_MS: '1200' }), m = await seed(true), pin = await pinFor(meet.base, m.source);
  const authority = new MeetPhoneAuthority({ baseUrl: meet.base, auth: { kind: 'hmac', secret: WEBHOOK }, pollMs: 100 }), log: string[] = []; const t0 = Date.now();
  const r = await admitTelephoneCall(request(m, pin, 'call_real_000020'), all, authority, meetConfirmedBridge({ gateway: gw(undefined, log), meet: authority }), { hostApprovalTimeoutMs: 8000 });
  assert.equal(r.code, 'HOST_APPROVAL_DENIED'); assert.ok(Date.now() - t0 < 7000, 'ended by Meet\'s approval timeout, not by the 8 s the gateway was willing to wait'); assert.deepEqual(log, []); const c = (await callsOf(meet.base, m.source))[0]; assert.ok(['TIMED_OUT', 'TERMINATED'].includes(c.state), c.state); assert.equal(c.status, 'ended'); assert.equal((await admin.query(`SELECT end_reason FROM ${schema}.phone_calls WHERE provider_call_id='call_real_000020'`)).rows[0].end_reason, 'approval_timeout', 'Meet recorded WHY it ended');
});
test('REAL Meet: wrong PIN / wrong meeting are refused, and Meet\'s per-caller lockout (its own limit) holds', { skip }, async () => {
  const meet = await startMeet({ PHONE_PROVIDER: 'test', PHONE_WEBHOOK_SECRET: WEBHOOK }), m = await seed(), pin = await pinFor(meet.base, m.source), authority = new MeetPhoneAuthority({ baseUrl: meet.base, auth: { kind: 'hmac', secret: WEBHOOK } });
  const bridge = meetConfirmedBridge({ gateway: gw(), meet: authority }); for (let i = 0; i < 5; i++) assert.equal((await admitTelephoneCall(request(m, '00000000', 'call_real_bad_' + i + '0000'), all, authority, bridge)).code, 'JOIN_DENIED');
  assert.equal((await admitTelephoneCall(request(m, pin, 'call_real_000030'), all, authority, bridge)).code, 'JOIN_DENIED', 'locked out: even the right PIN is refused');
  assert.equal((await admitTelephoneCall(request({ code: '10987654321' }, pin, 'call_real_000031', { callerNumber: '+12025550177' }), all, authority, bridge)).code, 'JOIN_DENIED'); assert.deepEqual(await callsOf(meet.base, m.source), []);
});
test('REAL Meet in GATEWAY MODE: this package\'s workload token is accepted (heartbeat), readiness is read from the real endpoint and is NOT ready, and every admission is refused with nothing created', { skip }, async () => {
  const gwEnv = { PHONE_GATEWAY_KEYS_JSON: JSON.stringify({ 'qorlla-gateway': { w1: kp.publicKeyPem } }), PHONE_GATEWAY_SUBJECTS_JSON: JSON.stringify({ 'svc:phone-gateway': ['phone.verify', 'phone.media', 'phone.end', 'phone.decision', 'phone.health', 'phone.readiness'] }), PHONE_GATEWAY_REQUIRE_MTLS: 'false', PHONE_GATEWAY_ENABLED: 'true' };
  const meet = await startMeet(gwEnv), m = await seed(), pin = await pinFor(meet.base, m.source), auth = { kind: 'workload' as const, privateKeyPem: kp.privateKeyPem, issuer: 'qorlla-gateway', subject: 'svc:phone-gateway' };
  const authority = new MeetPhoneAuthority({ baseUrl: meet.base, auth }), readiness = new MeetReadiness({ baseUrl: meet.base, auth, cacheMs: 0 });
  assert.equal(await authority.heartbeat('gw-e2e', true), true, 'the real Meet accepted this package\'s gateway token'); const rd = await readiness.get(); assert.equal(readiness.lastError, null);
  assert.deepEqual(rd, { carrierConnected: false, inboundNumberCertified: false, gatewayHealthy: true, mediaBridgeCertified: false, billingCertified: false, productionApproved: false }, 'from the real endpoint: only the heartbeat is true');
  const refused = await admitTelephoneCall(request(m, pin, 'call_real_000040'), all, authority, meetConfirmedBridge({ gateway: gw(), meet: authority })); assert.equal(refused.status, 503, 'Meet refuses admission while its own readiness is not all true'); assert.deepEqual(await callsOf(meet.base, m.source), []);
  const wrong = new MeetPhoneAuthority({ baseUrl: meet.base, auth: { ...auth, subject: 'svc:meet' } }); assert.equal(await wrong.heartbeat('x', true), false, 'an identity Meet does not know is refused'); assert.equal(await new MeetReadiness({ baseUrl: meet.base, auth: { ...auth, audience: 'qorlla-shield' }, cacheMs: 0 }).get().then((r) => r.gatewayHealthy), false, 'a token minted for another audience is refused');
  const dir = new MeetDirectoryClient({ baseUrl: meet.base, bridgeSecret: BRIDGE }); assert.deepEqual(await dir.resolve(m.code), { meetingId: m.id, sourceId: m.source, locked: false, waitingRoom: false }); assert.equal(await dir.resolve('99999999999'), null);
});
