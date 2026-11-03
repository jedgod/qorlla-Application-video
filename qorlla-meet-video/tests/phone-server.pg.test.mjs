// The REAL Meet server (server/index.js, as started in production) against a real PostgreSQL schema: checks the wiring that the module tests cannot - routes, bridge authentication, the directory,
// the readiness endpoint, the sweeper timer, and gateway mode failing closed when nothing certifies the system.
//   PHONE_TEST_DATABASE_URL=postgres://user:pw@host:port/db  node --test tests/phone-server.pg.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import pg from 'pg';

const URL_ = process.env.PHONE_TEST_DATABASE_URL, skip = URL_ ? false : 'PHONE_TEST_DATABASE_URL is not set';
const SQL = path.join(import.meta.dirname, '..', 'sql'), ROOT = path.join(import.meta.dirname, '..');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', 'v4_7_recording_consent.sql', 'v4_8_collab.sql', 'v4_9_recording_storage.sql', 'v4_10_admission.sql', 'v4_11_history.sql', 'v4_12_limit.sql',
  'v4_13_phone.sql', 'v4_14_telephony.sql', 'v4_15_telephony_features.sql', 'v4_16_number_authority.sql', 'v4_17_shield_identity.sql', 'v4_18_billing_hold.sql', 'v4_19_ai_request.sql', 'v4_20_ai_consent_seq.sql', 'v4_21_handoffs.sql', 'v4_22_host_controls.sql', 'v4_24_phone_lifecycle.sql'];
const BRIDGE = crypto.randomBytes(24).toString('hex'), WEBHOOK = 'server-test-webhook-secret-0123456789', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (b) => Buffer.from(b).toString('base64url'), FROM = '+12025550143';
let schema, admin; const procs = [];
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
test.before(async () => {
  if (!URL_) return; schema = 'ms_' + Math.random().toString(36).slice(2, 9); admin = new pg.Pool({ connectionString: URL_ }); await admin.query('CREATE SCHEMA ' + schema);
  const c = await admin.connect(); try { await c.query('SET search_path=' + schema); for (const f of ORDER) await c.query(fs.readFileSync(path.join(SQL, f), 'utf8')); } finally { c.release(); }
});
test.after(async () => { for (const p of procs) { try { p.kill(); } catch { /* gone */ } } await sleep(300); if (!URL_) return; await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); });

async function startMeet(extra = {}) {
  const port = await freePort(), env = { ...process.env, PORT: String(port), DATABASE_URL: URL_ + (URL_.includes('?') ? '&' : '?') + 'options=' + encodeURIComponent('-c search_path=' + schema), JWT_SECRET: crypto.randomBytes(32).toString('hex'), QORLLA_BRIDGE_SECRET: BRIDGE,
    RECOVERY_ESCROW_KEY: crypto.randomBytes(32).toString('base64'), RECORDING_MASTER_KEYS: JSON.stringify({ k1: crypto.randomBytes(32).toString('base64') }), RECORDING_ACTIVE_KEY_ID: 'k1', RECORDING_STORE_DIR: path.join(ROOT, '..', '.dev-stack', 'recordings-' + port), RECORDING_ADMIN_SECRET: 'x'.repeat(24),
    NODE_ENV: 'development', PHONE_SWEEP_MS: '300', ...extra };
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }); procs.push(child); let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  const base = 'http://127.0.0.1:' + port; for (let i = 0; i < 80; i++) { if (await fetch(base + '/api/ready').then((r) => r.ok).catch(() => false)) return { base, child, log: () => log }; await sleep(250); } throw new Error('Meet did not start: ' + log.slice(-600));
}
const seedMeeting = async () => {
  const id = crypto.randomUUID(), code = String(Math.floor(1e10 + Math.random() * 9e10)), source = 'sched_' + crypto.randomBytes(5).toString('hex');
  await admin.query(`INSERT INTO ${schema}.meetings(id,title,host_secret_hash,meeting_code) VALUES($1,'T','x',$2)`, [id, code]); await admin.query(`INSERT INTO ${schema}.external_meeting_links(source_system,source_id,meeting_id) VALUES('qorlla-main',$1,$2)`, [source, id]);
  return { id, code, source };
};
const bridge = (base, p, o = {}) => fetch(base + p, { method: o.method || 'GET', headers: { 'x-qorlla-bridge-secret': o.secret ?? BRIDGE, 'content-type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const dbRow = async (id) => (await admin.query(`SELECT * FROM ${schema}.phone_calls WHERE id=$1`, [id])).rows[0];
const sendDouble = async (base, p, body) => { const raw = JSON.stringify({ eventId: 'evt_' + crypto.randomBytes(6).toString('hex'), ...body }), t = Math.floor(Date.now() / 1000); const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qorlla-signature': 't=' + t + ',v1=' + crypto.createHmac('sha256', WEBHOOK).update(t + '.' + raw).digest('hex') }, body: raw }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const ev = (o = {}) => ({ state: 'audio_flowing', inboundPackets: 120, outboundPackets: 118, observedMs: 2400, codec: 'opus', encrypted: true, measuredAt: Date.now(), source: 'synthetic', ...o });

test('real Meet server: PIN -> approved -> verified media -> connected, seen through the bridge-secret call list; directory and readiness endpoints; the sweeper timer runs on its own', { skip }, async () => {
  const meet = await startMeet({ PHONE_PROVIDER: 'test', PHONE_WEBHOOK_SECRET: WEBHOOK, PHONE_MEDIA_TIMEOUT_MS: '1500', PHONE_APPROVAL_TIMEOUT_MS: '60000' }), m = await seedMeeting();
  // directory: one-to-one, bridge-authenticated, no guessing
  assert.equal((await bridge(meet.base, '/api/integrations/phone/meetings/' + m.code, { secret: 'wrong' })).status, 401); assert.equal((await bridge(meet.base, '/api/integrations/phone/meetings/' + m.code, { secret: '' })).status, 401);
  const dir = await bridge(meet.base, '/api/integrations/phone/meetings/' + m.code); assert.equal(dir.status, 200); assert.deepEqual({ meetingId: dir.body.meetingId, sourceId: dir.body.sourceId }, { meetingId: m.id, sourceId: m.source });
  assert.equal((await bridge(meet.base, '/api/integrations/phone/meetings/123')).status, 400); assert.equal((await bridge(meet.base, '/api/integrations/phone/meetings/99999999999')).status, 404);
  await admin.query(`UPDATE ${schema}.meetings SET ended_at=now() WHERE id=$1`, [m.id]); assert.equal((await bridge(meet.base, '/api/integrations/phone/meetings/' + m.code)).status, 404, 'an ended meeting is not resolvable'); await admin.query(`UPDATE ${schema}.meetings SET ended_at=NULL WHERE id=$1`, [m.id]);
  // readiness: an empty system is not ready, from the real service
  assert.equal((await bridge(meet.base, '/api/integrations/telephony/phone-readiness', { secret: 'wrong' })).status, 401); const rd = await bridge(meet.base, '/api/integrations/telephony/phone-readiness');
  assert.equal(rd.status, 200); assert.deepEqual(Object.values(rd.body.readiness), [false, false, false, false, false, false]); assert.ok(rd.body.generatedAt);
  // the lifecycle through the real routes
  const pin = (await bridge(meet.base, '/api/integrations/scheduled-meetings/' + m.source + '/phone-access', { method: 'POST', body: {} })).body.pin; assert.match(pin, /^\d{8}$/);
  const v = await sendDouble(meet.base, '/api/phone/ivr/verify', { callId: 'call_srv_00000001', from: FROM, meetingId: m.code, pin }); assert.equal(v.body.result, 'approved'); assert.notEqual(v.body.result, 'connected');
  let list = await bridge(meet.base, '/api/integrations/scheduled-meetings/' + m.source + '/phone-calls'); assert.equal(list.body.calls[0].status, 'waiting'); assert.equal(list.body.calls[0].state, 'APPROVED');
  const c = await sendDouble(meet.base, '/api/phone/ivr/media', { callId: 'call_srv_00000001', mediaToken: v.body.mediaToken, evidence: ev() }); assert.equal(c.body.result, 'connected');
  list = await bridge(meet.base, '/api/integrations/scheduled-meetings/' + m.source + '/phone-calls'); assert.equal(list.body.calls[0].status, 'connected'); assert.equal(list.body.calls[0].state, 'MEDIA_CONNECTED');
  assert.equal((await fetch(meet.base + '/api/phone/ivr/calls/' + v.body.callRef + '/decision')).status, 404, 'no decision route outside gateway mode');
  // the server's own sweeper timer: an approved call whose gateway never reports audio ends by itself
  const pin2 = (await bridge(meet.base, '/api/integrations/scheduled-meetings/' + m.source + '/phone-access', { method: 'POST', body: {} })).body.pin; const v2 = await sendDouble(meet.base, '/api/phone/ivr/verify', { callId: 'call_srv_00000002', from: '+12025550144', meetingId: m.code, pin: pin2 });
  assert.equal(v2.body.result, 'approved'); assert.ok(await (async () => { for (let i = 0; i < 60; i++) { if ((await dbRow(v2.body.callRef)).state === 'TIMED_OUT') return true; await sleep(250); } return false; })(), 'the media timeout fired without anyone calling it');
  assert.ok(!/Error|ECONN|unhandled/i.test(meet.log().replace(/phone-gateway\].*REQUIRE_MTLS/g, '')), 'no errors in the server log: ' + meet.log().slice(-300));
});

test('real Meet server in GATEWAY MODE: not enabled -> 503; enabled but nothing certifies the system -> admission refused (503) and no call is created; heartbeats and readiness work; the health route needs its own scope', { skip }, async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }), priv = privateKey.export({ type: 'pkcs8', format: 'pem' }), pub = publicKey.export({ type: 'spki', format: 'pem' });
  const gwEnv = { PHONE_GATEWAY_KEYS_JSON: JSON.stringify({ 'gw-1': { w1: pub } }), PHONE_GATEWAY_SUBJECTS_JSON: JSON.stringify({ 'svc:phone-gateway': ['phone.verify', 'phone.health'], 'svc:phone-media': ['phone.media'] }), PHONE_GATEWAY_REQUIRE_MTLS: 'false' };
  const mint = (body, o = {}) => { const now = Math.floor(Date.now() / 1000), head = b64(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'w1' })), claims = b64(JSON.stringify({ iss: 'gw-1', sub: o.sub ?? 'svc:phone-gateway', aud: o.aud ?? 'qorlla-phone-gateway', iat: now, exp: now + 120, jti: crypto.randomUUID() + crypto.randomUUID(), bsh: b64(crypto.createHash('sha256').update(body).digest()) })); return head + '.' + claims + '.' + b64(crypto.sign('sha256', Buffer.from(head + '.' + claims), { key: priv, dsaEncoding: 'ieee-p1363' })); };
  const post = (base, p, obj, o) => { const raw = JSON.stringify(obj); return fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + mint(raw, o) }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })); };
  const off = await startMeet({ ...gwEnv }), m = await seedMeeting(); const pin = (await bridge(off.base, '/api/integrations/scheduled-meetings/' + m.source + '/phone-access', { method: 'POST', body: {} })).body.pin;
  const body = { eventId: 'evt_gw_00000001', callId: 'call_gw_00000001', from: FROM, meetingId: m.code, pin };
  assert.equal((await post(off.base, '/api/phone/ivr/verify', body)).status, 503, 'gateway configured but PHONE_GATEWAY_ENABLED is not true');
  const on = await startMeet({ ...gwEnv, PHONE_GATEWAY_ENABLED: 'true' });
  const hb = await post(on.base, '/api/phone/ivr/gateway-health', { instance: 'gw-a', healthy: true }); assert.equal(hb.status, 200);
  assert.equal((await post(on.base, '/api/phone/ivr/gateway-health', { instance: 'gw-a', healthy: true }, { aud: 'qorlla-shield' })).status, 401, 'a token minted for another audience');
  assert.equal((await post(on.base, '/api/phone/ivr/gateway-health', { instance: 'gw-a', healthy: true }, { sub: 'svc:phone-media' })).status, 403, 'the media identity cannot send health');
  const rd = await bridge(on.base, '/api/integrations/telephony/phone-readiness'); assert.equal(rd.body.readiness.gatewayHealthy, true, 'the heartbeat is the evidence'); assert.equal(rd.body.readiness.productionApproved, false);
  const r = await post(on.base, '/api/phone/ivr/verify', body); assert.equal(r.status, 503); assert.equal(r.body.code, 'PHONE_JOIN_UNAVAILABLE');
  assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${schema}.phone_calls WHERE meeting_id=$1`, [m.id])).rows[0].n, 0, 'a refused admission creates nothing');
  const legacy = await sendDouble(on.base, '/api/phone/ivr/verify', body); assert.equal(legacy.status, 401, 'the provider HMAC is not accepted in gateway mode');
});
