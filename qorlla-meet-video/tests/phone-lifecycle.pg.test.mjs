// Telephone lifecycle in Qorlla Meet: the REAL phone module (server/phone.mjs) and gateway authentication (server/phone-gateway-auth.mjs) against a REAL PostgreSQL with Meet's real migrations.
//   PHONE_TEST_DATABASE_URL=postgres://user:pw@host:port/db  node --test tests/phone-lifecycle.pg.test.mjs      (a throw-away schema is created and dropped; without the variable the tests are skipped)
// "synthetic" evidence below is what the TEST DOUBLE sends so the rules can be exercised. It is accepted only for provider 'test-double', and none of this is certification evidence for real telephone calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import express from 'express';
import { registerPhone } from '../server/phone.mjs';
import { createGatewayAuth } from '../server/phone-gateway-auth.mjs';
import { TelephonyService } from '../server/telephony/service.mjs';
import { audioVerified, canMove, TRANSITIONS, STATES, legacyStatus } from '../server/phone-lifecycle.mjs';

const URL_ = process.env.PHONE_TEST_DATABASE_URL, skip = URL_ ? false : 'PHONE_TEST_DATABASE_URL is not set';
const SQL = path.join(import.meta.dirname, '..', 'sql');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', 'v4_7_recording_consent.sql', 'v4_8_collab.sql', 'v4_9_recording_storage.sql', 'v4_10_admission.sql', 'v4_11_history.sql', 'v4_12_limit.sql',
  'v4_13_phone.sql', 'v4_14_telephony.sql', 'v4_15_telephony_features.sql', 'v4_16_number_authority.sql', 'v4_17_shield_identity.sql', 'v4_18_billing_hold.sql', 'v4_19_ai_request.sql', 'v4_20_ai_consent_seq.sql', 'v4_21_handoffs.sql', 'v4_22_host_controls.sql', 'v4_25_phone_verification_peer.sql'];
const WEBHOOK = 'phone-webhook-secret-for-tests-0123456789', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eventually = async (cond, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(20); } return cond(); };
const FROM = '+12025550143';

let schema, admin; const pools = [], closers = [];
const poolFor = () => { const p = new pg.Pool({ connectionString: URL_, options: '-c search_path=' + schema, max: 12 }); pools.push(p); return p; };
test.before(async () => {
  if (!URL_) return; schema = 'mp_' + Math.random().toString(36).slice(2, 9); admin = new pg.Pool({ connectionString: URL_ }); await admin.query('CREATE SCHEMA ' + schema);
  const c = await admin.connect(); try { await c.query('SET search_path=' + schema); for (const f of [...ORDER, 'v4_24_phone_lifecycle.sql']) await c.query(fs.readFileSync(path.join(SQL, f), 'utf8')); await c.query(fs.readFileSync(path.join(SQL, 'v4_24_phone_lifecycle.sql'), 'utf8')); await c.query(fs.readFileSync(path.join(SQL, 'v4_26_phone_event_outbox.sql'), 'utf8')); } finally { c.release(); }   // v4.24 remains idempotent
});
test.after(async () => { for (const c of closers) await c().catch(() => {}); if (!URL_) return; for (const p of pools) await p.end().catch(() => {}); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); });

// ------------------------------------------------------------------------------------------------ harness around the REAL registerPhone
async function harness(o = {}) {
  const db = o.db ?? poolFor(), log = { emits: [], audits: [] }, phoneOnline = new Map(), names = new Map(), host = { here: false };
  const app = express(); app.use(express.json({ limit: '32kb', verify: (req, _res, buf) => { if (req.path.startsWith('/api/phone/')) req.rawBody = buf; } }));
  const io = { to: (r) => ({ emit: (ev, p) => log.emits.push({ ev, p, room: r }) }) };
  const env = { PHONE_PROVIDER: o.gatewayEnv ? '' : 'test', PHONE_WEBHOOK_SECRET: WEBHOOK, PHONE_HASH_KEY: 'k'.repeat(24), ...o.env };
  const gateway = o.gatewayEnv ? createGatewayAuth({ db: o.gatewayDb ?? db, env: { ...o.gatewayEnv, ...o.env }, now: o.now, log: { warn() {}, error() {} } }) : null;
  const resolveMeeting = async (v) => { const code = String(v || '').replace(/[\s-]/g, ''); const { rows } = await db.query('SELECT id FROM meetings WHERE meeting_code=$1', [code]); return rows[0]?.id || null; };
  const recording = { reevaluate: async () => {}, publicState: async () => o.recording ?? null, consentFor: async () => ({ ok: true }) };
  const phone = registerPhone({ app, io, db, auth: (q, s, n) => n(), member: (q, s, n) => n(), fail: (res, st, m) => res.status(st).json({ error: m }), room: (id) => 'room:' + id, audit: (m, p, a, d) => log.audits.push({ m, p, a, d }),
    resolveMeeting, activeHas: () => host.here, phoneOnline, names, recording, env, shield: o.shield, gateway, readiness: o.readiness, peers: o.peers, now: o.clock });
  const server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + server.address().port;
  closers.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  let n = 0; const uid = () => 'evt_' + Date.now().toString(36) + (n++).toString(36) + Math.random().toString(36).slice(2, 6);
  const post = (p, body, headers = {}) => { const raw = JSON.stringify(body); return fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw }); };
  // test double: the provider's own HMAC. gateway mode: pass headers yourself.
  const signedPost = async (p, body) => (await post(p, { eventId: uid(), ...body }, { 'x-qorlla-signature': phone.provider.sign(JSON.stringify({ eventId: 'x' })) })); // replaced below
  const sendDouble = async (p, body) => { const full = { eventId: uid(), ...body }, raw = JSON.stringify(full); const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qorlla-signature': phone.provider.sign(raw) }, body: raw }); return { status: r.status, body: await r.json().catch(() => ({})), full }; };
  async function meeting({ waitingRoom = false, joinBeforeHost = true } = {}) {
    const id = crypto.randomUUID(), code = String(Math.floor(1e10 + Math.random() * 9e10)); await db.query('INSERT INTO meetings(id,title,host_secret_hash,meeting_code,waiting_room,join_before_host) VALUES($1,$2,$3,$4,$5,$6)', [id, 'Test meeting', 'x', code, waitingRoom, joinBeforeHost]);
    const hostId = crypto.randomUUID(); await db.query("INSERT INTO participants(id,meeting_id,display_name,role,admission) VALUES($1,$2,'Host','host','admitted')", [hostId, id]); return { id, code, hostId, pin: await phone.setPin(id) };
  }
  const row = async (callRef) => (await db.query('SELECT * FROM phone_calls WHERE id=$1', [callRef])).rows[0];
  const states = async (callRef) => (await db.query('SELECT to_state FROM phone_call_events WHERE call_id=$1 ORDER BY id', [callRef])).rows.map((r) => r.to_state);
  return { db, app, base, phone, log, phoneOnline, host, env, post, sendDouble, meeting, row, states, uid, signedPost };
}
const good = (over = {}) => ({ state: 'audio_flowing', inboundPackets: 120, outboundPackets: 118, observedMs: 2400, codec: 'opus', encrypted: true, measuredAt: Date.now(), source: 'synthetic', ...over });
const clean = (h) => h.db.query('DELETE FROM phone_calls');       // the sweeper and some queries are global, so a test that counts their work starts from no calls
const verify = (h, m, over = {}) => h.sendDouble('/api/phone/ivr/verify', { callId: 'call_' + h.uid(), from: FROM, meetingId: m.code, pin: m.pin, ...over });
const media = (h, callId, token, ev) => h.sendDouble('/api/phone/ivr/media', { callId, mediaToken: token, evidence: ev });

test('initial lifecycle event and participant roll back when event persistence fails', { skip }, async () => {
  const h = await harness(), m = await h.meeting(), providerCallId = 'rollback_' + h.uid();
  await h.db.query(`CREATE FUNCTION test_fail_requested_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.to_state = 'REQUESTED' THEN RAISE EXCEPTION 'injected event failure'; END IF; RETURN NEW; END $$`);
  await h.db.query('CREATE TRIGGER test_fail_requested_event BEFORE INSERT ON phone_call_events FOR EACH ROW EXECUTE FUNCTION test_fail_requested_event()');
  try {
    await assert.rejects(h.phone.verifyCall({ callId: providerCallId, from: FROM, meetingId: m.code, pin: m.pin }), /injected event failure/);
    assert.equal((await h.db.query('SELECT count(*)::int AS n FROM phone_calls WHERE provider_call_id=$1', [providerCallId])).rows[0].n, 0);
    assert.equal((await h.db.query("SELECT count(*)::int AS n FROM participants WHERE meeting_id=$1 AND kind='phone'", [m.id])).rows[0].n, 0);
  } finally {
    await h.db.query('DROP TRIGGER test_fail_requested_event ON phone_call_events');
    await h.db.query('DROP FUNCTION test_fail_requested_event()');
  }
});

test('concurrent duplicate provider calls have one initial event and no orphan participant', { skip }, async () => {
  const h = await harness(), m = await h.meeting(), callId = 'duplicate_' + h.uid();
  const request = { callId, from: FROM, meetingId: m.code, pin: m.pin };
  const results = await Promise.all([h.phone.verifyCall(request), h.phone.verifyCall(request)]);
  assert.deepEqual(results.map(r => r.result).sort(), ['approved', 'denied']);
  const calls = await h.db.query('SELECT id FROM phone_calls WHERE provider_call_id=$1', [callId]);
  assert.equal(calls.rowCount, 1);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM phone_call_events WHERE call_id=$1 AND from_state IS NULL AND to_state='REQUESTED'", [calls.rows[0].id])).rows[0].n, 1);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM participants WHERE meeting_id=$1 AND kind='phone'", [m.id])).rows[0].n, 1);
});

test('Meet lifecycle outbox captures committed authoritative events in order', { skip }, async () => {
  const h = await harness(), m = await h.meeting(), result = await verify(h, m);
  assert.equal(result.body.result, 'approved');
  const ref = result.body.callRef;
  const rows = (await h.db.query(`SELECT o.lifecycle_version::int,o.call_id,o.meeting_id,o.from_state,o.event_type,
    o.occurred_at=e.at AS timestamp_matches,o.source_event_id=e.id AS source_matches
    FROM phone_lifecycle_outbox o JOIN phone_call_events e ON e.id=o.source_event_id
    WHERE o.call_id=$1 ORDER BY o.lifecycle_version`, [ref])).rows;
  assert.deepEqual(rows.map(row => row.event_type), ['REQUESTED', 'VERIFIED', 'APPROVED']);
  assert.deepEqual(rows.map(row => row.lifecycle_version), [1, 2, 3]);
  assert.ok(rows.every(row => row.call_id === ref && row.meeting_id === m.id && row.timestamp_matches && row.source_matches));
  await assert.rejects(h.db.query('UPDATE phone_lifecycle_outbox SET event_type=$2 WHERE call_id=$1', [ref, 'MEDIA_CONNECTED']), /immutable/);
  await assert.rejects(h.db.query('DELETE FROM phone_lifecycle_outbox WHERE call_id=$1', [ref]), /immutable/);
  await assert.rejects(h.db.query('TRUNCATE phone_lifecycle_outbox'), /immutable/);
});

test('uncommitted Meet lifecycle snapshots are not visible and disappear on rollback', { skip }, async () => {
  const h = await harness(), m = await h.meeting(), result = await verify(h, m);
  const ref = result.body.callRef, client = await h.db.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO phone_call_events(call_id,from_state,to_state,reason) VALUES($1,'APPROVED','MEDIA_CONNECTING','rollback-test')", [ref]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM phone_lifecycle_outbox WHERE call_id=$1', [ref])).rows[0].n, 4);
    assert.equal((await h.db.query('SELECT count(*)::int AS n FROM phone_lifecycle_outbox WHERE call_id=$1', [ref])).rows[0].n, 3);
    await client.query('ROLLBACK');
    assert.equal((await h.db.query('SELECT count(*)::int AS n FROM phone_lifecycle_outbox WHERE call_id=$1', [ref])).rows[0].n, 3);
  } finally { client.release(); }
});

test('Meet rolls back call and initial history if lifecycle outbox persistence fails', { skip }, async () => {
  const h = await harness(), m = await h.meeting(), callId = 'outbox_failure_' + h.uid();
  await h.db.query(`CREATE FUNCTION test_fail_lifecycle_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected outbox failure'; END $$`);
  await h.db.query('CREATE TRIGGER test_fail_lifecycle_outbox BEFORE INSERT ON phone_lifecycle_outbox FOR EACH ROW EXECUTE FUNCTION test_fail_lifecycle_outbox()');
  try {
    await assert.rejects(h.phone.verifyCall({ callId, from: FROM, meetingId: m.code, pin: m.pin }), /injected outbox failure/);
    assert.equal((await h.db.query('SELECT count(*)::int AS n FROM phone_calls WHERE provider_call_id=$1', [callId])).rows[0].n, 0);
    assert.equal((await h.db.query("SELECT count(*)::int AS n FROM participants WHERE meeting_id=$1 AND kind='phone'", [m.id])).rows[0].n, 0);
    assert.equal((await h.db.query('SELECT count(*)::int AS n FROM phone_lifecycle_outbox WHERE meeting_id=$1', [m.id])).rows[0].n, 0);
  } finally {
    await h.db.query('DROP TRIGGER test_fail_lifecycle_outbox ON phone_lifecycle_outbox');
    await h.db.query('DROP FUNCTION test_fail_lifecycle_outbox()');
  }
});

// ================================================================================================ the state machine, pure
test('lifecycle: the transition table has no way into MEDIA_CONNECTED except from MEDIA_CONNECTING, and none out of TERMINATED', () => {
  for (const s of STATES) assert.equal(canMove(s, 'MEDIA_CONNECTED'), s === 'MEDIA_CONNECTING', s);
  assert.deepEqual(TRANSITIONS.TERMINATED, []); for (const from of ['REQUESTED', 'VERIFIED', 'AWAITING_HOST']) assert.equal(canMove(from, 'MEDIA_CONNECTED'), false, from);
  assert.equal(legacyStatus('MEDIA_CONNECTED'), 'connected'); for (const s of STATES.filter((x) => x !== 'MEDIA_CONNECTED')) assert.notEqual(legacyStatus(s), 'connected', s);
});
test('lifecycle: audioVerified is Meet\'s own judgement - two-way, encrypted, fresh, long enough, allowed codec; synthetic only when allowed', () => {
  const now = 1_800_000_000_000, ev = (o = {}) => good({ measuredAt: now - 100, source: 'rtp', ...o });
  assert.equal(audioVerified(ev(), { now }), true);
  for (const [why, o] of [['not flowing', { state: 'ice_connected' }], ['no inbound', { inboundPackets: 0 }], ['no outbound', { outboundPackets: 0 }], ['few packets', { inboundPackets: 3 }], ['short', { observedMs: 50 }], ['unencrypted', { encrypted: false }], ['codec', { codec: 'g729' }],
    ['stale', { measuredAt: now - 60000 }], ['future', { measuredAt: now + 60000 }], ['NaN', { inboundPackets: NaN }], ['string', { outboundPackets: '999' }], ['missing time', { measuredAt: undefined }]]) assert.equal(audioVerified(ev(o), { now }), false, why);
  assert.equal(audioVerified(ev({ source: 'synthetic' }), { now }), false, 'synthetic evidence is refused unless the caller is the test double'); assert.equal(audioVerified(ev({ source: 'synthetic' }), { now, allowSynthetic: true }), true);
  for (const bad of [null, undefined, 'x', 5, [], {}]) assert.equal(audioVerified(bad, { now }), false);
});

// ================================================================================================ 1. a verified PIN is not a connection
test('PIN verified, no waiting room: the caller is APPROVED - not connected, not online, not in the room, not counted', { skip }, async () => {
  const h = await harness(), m = await h.meeting(); const r = await verify(h, m);
  assert.equal(r.status, 200); assert.equal(r.body.result, 'approved'); assert.ok(r.body.callRef); assert.ok(r.body.mediaToken && r.body.mediaToken.length >= 30); assert.notEqual(r.body.result, 'connected');
  const c = await h.row(r.body.callRef); assert.equal(c.state, 'APPROVED'); assert.equal(c.status, 'waiting'); assert.equal(c.connected_at, null); assert.equal(c.media_verified_at, null); assert.ok(c.media_nonce_hash && c.media_nonce_hash !== r.body.mediaToken, 'only a hash of the token is stored');
  assert.deepEqual(await h.states(c.id), ['REQUESTED', 'VERIFIED', 'APPROVED']); assert.equal(h.phoneOnline.get(m.id)?.size ?? 0, 0); assert.equal(h.log.emits.filter((e) => e.ev === 'participant-online').length, 0);
  assert.equal((await h.db.query('SELECT count(*)::int AS n FROM participant_sessions WHERE participant_id=$1', [c.participant_id])).rows[0].n, 0);
  assert.equal((await h.phone.calls(m.id))[0].status, 'waiting'); assert.equal((await h.phone.calls(m.id))[0].state, 'APPROVED'); assert.equal(await h.phone.statusOf(c.provider_call_id, 'test-double'), 'approved');
});
test('only verified two-way encrypted audio connects the caller; then it is online, in the room, counted and in the history', { skip }, async () => {
  const h = await harness(), m = await h.meeting(); const v = (await verify(h, m)).body, c0 = await h.row(v.callRef);
  const r = await media(h, c0.provider_call_id, v.mediaToken, good()); assert.equal(r.body.result, 'connected');
  const c = await h.row(v.callRef); assert.equal(c.state, 'MEDIA_CONNECTED'); assert.equal(c.status, 'connected'); assert.ok(c.connected_at && c.media_verified_at); assert.equal(c.media_evidence.inboundPackets, 120);
  assert.deepEqual(await h.states(c.id), ['REQUESTED', 'VERIFIED', 'APPROVED', 'MEDIA_CONNECTING', 'MEDIA_CONNECTED']);
  assert.equal(h.phoneOnline.get(m.id).size, 1); assert.equal(h.log.emits.filter((e) => e.ev === 'participant-online').length, 1);
  assert.equal((await h.db.query('SELECT count(*)::int AS n FROM participant_sessions WHERE participant_id=$1 AND disconnected_at IS NULL', [c.participant_id])).rows[0].n, 1);
  const again = await media(h, c0.provider_call_id, v.mediaToken, good()); assert.equal(again.body.refreshed, true); assert.equal(h.log.emits.filter((e) => e.ev === 'participant-online').length, 1, 'a refresh does not announce the caller twice');
});
test('NO other evidence connects: one-way, silent, few packets, unencrypted, wrong codec, stale, from the future, malformed, wrong or missing token, a real gateway claiming synthetic audio', { skip }, async () => {
  const h = await harness(), m = await h.meeting(); const v = (await verify(h, m)).body, c0 = await h.row(v.callRef);
  const bad = [['one-way out', good({ inboundPackets: 0 })], ['one-way in', good({ outboundPackets: 0 })], ['silent signalling', good({ state: 'ice_connected', inboundPackets: 0, outboundPackets: 0 })], ['negotiating', good({ state: 'negotiating' })], ['few packets', good({ inboundPackets: 4 })],
    ['short', good({ observedMs: 10 })], ['unencrypted', good({ encrypted: false })], ['codec', good({ codec: 'speex' })], ['stale', good({ measuredAt: Date.now() - 60000 })], ['future', good({ measuredAt: Date.now() + 600000 })], ['NaN', good({ outboundPackets: 'lots' })], ['empty', {}], ['null', null]];
  for (const [why, ev] of bad) { const r = await media(h, c0.provider_call_id, v.mediaToken, ev); assert.notEqual(r.body.result, 'connected', why); assert.equal((await h.row(v.callRef)).status, 'waiting', why); assert.notEqual((await h.row(v.callRef)).state, 'MEDIA_CONNECTED', why); }
  for (const tok of [undefined, '', 'wrong', v.mediaToken + 'x', crypto.randomBytes(24).toString('base64url')]) { const r = await media(h, c0.provider_call_id, tok, good()); assert.equal(r.body.result, 'denied', String(tok)); }
  assert.equal((await h.row(v.callRef)).state === 'MEDIA_CONNECTED', false); assert.equal(h.log.emits.filter((e) => e.ev === 'participant-online').length, 0);
});
test('the database itself refuses a connected call without verified media', { skip }, async () => {
  const h = await harness(), m = await h.meeting(); const v = (await verify(h, m)).body;
  await assert.rejects(h.db.query("UPDATE phone_calls SET status='connected' WHERE id=$1", [v.callRef]), /phone_calls_connected_means_media/);
  await assert.rejects(h.db.query("UPDATE phone_calls SET state='MEDIA_CONNECTED', status='connected' WHERE id=$1", [v.callRef]), /phone_calls_media_needs_evidence/);
  await assert.rejects(h.db.query("UPDATE phone_calls SET state='BOGUS' WHERE id=$1", [v.callRef]), /phone_calls_state_check/);
  await assert.rejects(h.db.query("UPDATE phone_call_events SET reason='x'"), /append-only/); await assert.rejects(h.db.query('DELETE FROM phone_call_events'), /append-only/);
});
test('a state cannot be skipped: media for a call that was never approved changes nothing', { skip }, async () => {
  const h = await harness(), m = await h.meeting({ waitingRoom: true }); const r = (await verify(h, m)).body; assert.equal(r.result, 'waiting'); const c = await h.row(r.callRef); assert.equal(c.state, 'AWAITING_HOST'); assert.equal(c.media_nonce_hash, null);
  const x = await media(h, c.provider_call_id, 'anything', good()); assert.equal(x.body.result, 'denied'); assert.equal((await h.row(r.callRef)).state, 'AWAITING_HOST');
});

// ================================================================================================ 2. host approval
test('waiting room: the host approves -> APPROVED (not connected); the host refuses -> REFUSED, participant denied, caller hung up', { skip }, async () => {
  const h = await harness(), m = await h.meeting({ waitingRoom: true });
  const a = (await verify(h, m)).body, ca = await h.row(a.callRef); assert.equal(a.result, 'waiting'); assert.equal(ca.state, 'AWAITING_HOST'); assert.equal(ca.status, 'waiting');
  await h.db.query("UPDATE participants SET admission='admitted', wait_reason=NULL WHERE id=$1", [ca.participant_id]); await h.phone.onAdmission(m.id, [ca.participant_id], true);
  const ca2 = await h.row(a.callRef); assert.equal(ca2.state, 'APPROVED'); assert.equal(ca2.status, 'waiting', 'approval is not a connection'); assert.equal(h.phoneOnline.get(m.id)?.size ?? 0, 0);
  const b = (await verify(h, m)).body, cb = await h.row(b.callRef); await h.phone.onAdmission(m.id, [cb.participant_id], false);
  const cb2 = await h.row(b.callRef); assert.equal(cb2.state, 'REFUSED'); assert.equal(cb2.status, 'denied'); assert.equal((await h.db.query('SELECT admission FROM participants WHERE id=$1', [cb.participant_id])).rows[0].admission, 'denied');
  assert.ok(h.phone.provider.calls.some((x) => x.op === 'hangup' && x.callId === cb.provider_call_id)); assert.deepEqual(await h.states(cb.id), ['REQUESTED', 'VERIFIED', 'AWAITING_HOST', 'REFUSED']);
});
test('waiting room end to end (test double): approved by the host -> the status route hands over the media token once -> verified media -> connected', { skip }, async () => {
  const h = await harness(), m = await h.meeting({ waitingRoom: true }); const w = (await verify(h, m, { callId: 'call_wr_00000001' })).body; assert.equal(w.result, 'waiting'); assert.equal(w.meetingId, m.id); const c = await h.row(w.callRef);
  const st = (id) => h.sendDouble('/api/phone/ivr/status', { callId: id }); const before = await st('call_wr_00000001'); assert.equal(before.body.decision, 'pending'); assert.equal(before.body.mediaToken, undefined);
  await h.db.query("UPDATE participants SET admission='admitted' WHERE id=$1", [c.participant_id]); await h.phone.onAdmission(m.id, [c.participant_id], true);
  const a = await st('call_wr_00000001'); assert.equal(a.body.decision, 'approved'); assert.ok(a.body.mediaToken); assert.equal((await st('call_wr_00000001')).body.mediaToken, undefined, 'only once'); assert.equal((await h.row(w.callRef)).status, 'waiting');
  assert.equal((await media(h, 'call_wr_00000001', a.body.mediaToken, good())).body.result, 'connected'); assert.equal((await h.row(w.callRef)).state, 'MEDIA_CONNECTED'); assert.equal((await st('nope')).body.result, 'unknown');
});
test('host absent (no waiting room, join-before-host off): the caller waits and is APPROVED when the host arrives, still not connected', { skip }, async () => {
  const h = await harness(), m = await h.meeting({ joinBeforeHost: false }); const r = (await verify(h, m)).body; assert.equal(r.result, 'waiting'); const c = await h.row(r.callRef);
  await h.phone.onHostArrived(m.id); assert.equal((await h.row(r.callRef)).state, 'APPROVED'); assert.equal((await h.row(r.callRef)).status, 'waiting'); assert.equal(c.state, 'AWAITING_HOST');
});
test('a host who never answers: the call times out by itself (sweeper) and the caller is hung up', { skip }, async () => {
  const h = await harness({ env: { PHONE_APPROVAL_TIMEOUT_MS: '900' } }); await clean(h); const m = await h.meeting({ waitingRoom: true }); const r = (await verify(h, m)).body, c = await h.row(r.callRef);
  assert.deepEqual(await h.phone.sweep(), { approval: 0, media: 0, stale: 0, retried: 0, orphaned: 0 }, 'nothing is due yet'); await sleep(1100); const s = await h.phone.sweep(); assert.equal(s.approval, 1);
  const t = await h.row(r.callRef); assert.equal(t.state, 'TIMED_OUT'); assert.equal(t.status, 'ended'); assert.equal(t.end_reason, 'approval_timeout'); assert.ok(h.phone.provider.calls.some((x) => x.op === 'hangup' && x.callId === c.provider_call_id));
  assert.equal((await h.phone.sweep()).approval, 0, 'the sweeper is idempotent');
});
test('two sweepers at once (two replicas) time a call out exactly once', { skip }, async () => {
  const a = await harness({ env: { PHONE_APPROVAL_TIMEOUT_MS: '100' } }); await clean(a); const m = await a.meeting({ waitingRoom: true }); const r = (await verify(a, m)).body; await sleep(200);
  const b = await harness({ db: a.db, env: { PHONE_APPROVAL_TIMEOUT_MS: '100' } }); const out = await Promise.all([a.phone.sweep(), b.phone.sweep(), a.phone.sweep(), b.phone.sweep()]);
  assert.equal(out.reduce((n, x) => n + x.approval, 0), 1); assert.deepEqual(await a.states(r.callRef), ['REQUESTED', 'VERIFIED', 'AWAITING_HOST', 'TIMED_OUT']);
});

// ================================================================================================ 3. timeouts, late media, lost media, orphans
test('approved but the gateway never delivers audio: TIMED_OUT; media that appears LATER is refused, the call is ORPHANED and the gateway is told to terminate it', { skip }, async () => {
  const h = await harness({ env: { PHONE_MEDIA_TIMEOUT_MS: '120' } }); await clean(h); const m = await h.meeting(); const v = (await verify(h, m)).body, c = await h.row(v.callRef);
  await sleep(220); assert.equal((await h.phone.sweep()).media, 1); assert.equal((await h.row(v.callRef)).state, 'TIMED_OUT');
  const late = await media(h, c.provider_call_id, v.mediaToken, good()); assert.equal(late.body.action, 'terminate'); const o = await h.row(v.callRef); assert.equal(o.state, 'ORPHANED'); assert.equal(o.status, 'ended'); assert.equal(h.phoneOnline.get(m.id)?.size ?? 0, 0);
  assert.ok(h.log.audits.some((a) => a.a === 'phone.late_media')); assert.deepEqual(await h.states(v.callRef), ['REQUESTED', 'VERIFIED', 'APPROVED', 'TIMED_OUT', 'ORPHANED']);
  const again = await media(h, c.provider_call_id, v.mediaToken, good({ state: 'closed' })); assert.equal(again.body.action, 'terminate'); const ack = await h.sendDouble('/api/phone/ivr/disconnect', { callId: c.provider_call_id, type: 'bye' });
  assert.equal(ack.body.result, 'ended'); const done = await h.row(v.callRef); assert.equal(done.state, 'TERMINATED'); assert.ok(done.hangup_confirmed_at);
});
test('connected audio must KEEP being verified: fresh reports keep the call; silence from the gateway ends it (media_lost); a report that no longer passes ends it', { skip }, async () => {
  const h = await harness({ env: { PHONE_MEDIA_STALE_MS: '1200' } }); await clean(h); const m = await h.meeting(); const v = (await verify(h, m)).body, c = await h.row(v.callRef); await media(h, c.provider_call_id, v.mediaToken, good());
  await sleep(700); await media(h, c.provider_call_id, v.mediaToken, good()); await sleep(700); assert.equal((await h.phone.sweep()).stale, 0, 'refreshed, so still fresh (1.4 s after connecting, 0.7 s after the refresh)'); assert.equal((await h.row(v.callRef)).state, 'MEDIA_CONNECTED');
  await sleep(1300); assert.equal((await h.phone.sweep()).stale, 1); const t = await h.row(v.callRef); assert.equal(t.state, 'TERMINATED'); assert.equal(t.end_reason, 'media_lost'); assert.equal(h.phoneOnline.get(m.id)?.size ?? 0, 0);
  assert.equal(h.log.emits.filter((e) => e.ev === 'participant-offline').length, 1);
  const w = await harness(), mw = await w.meeting(); const vw = (await verify(w, mw)).body, cw = await w.row(vw.callRef); await media(w, cw.provider_call_id, vw.mediaToken, good());
  const r = await media(w, cw.provider_call_id, vw.mediaToken, good({ outboundPackets: 0 })); assert.equal(r.body.action, 'terminate'); assert.equal((await w.row(vw.callRef)).state, 'TERMINATED');
});
test('unconfirmed hang-ups are retried, and past the limit become ORPHANED with an alert (the gateway never confirmed the leg is gone)', { skip }, async () => {
  const reports = []; const h = await harness({ env: { PHONE_PROVIDER: '', PHONE_HANGUP_CONFIRM_MS: '300', PHONE_ORPHAN_AFTER_MS: '2500' }, shield: { enforce: false, report: async (k, ref) => { reports.push([k, ref]); return true; } } }); await clean(h);
  const m = await h.meeting(), pid = crypto.randomUUID(), cid = crypto.randomUUID(); await h.db.query("INSERT INTO participants(id,meeting_id,display_name,role,admission,kind) VALUES($1,$2,'Phone','guest','denied','phone')", [pid, m.id]);
  await h.db.query("INSERT INTO phone_calls(id,meeting_id,provider,provider_call_id,caller_hash,status,state,participant_id,terminated_at,ended_at) VALUES($1,$2,'gateway','call_unconf_0001','h','ended','TIMED_OUT',$3,now(),now())", [cid, m.id, pid]);
  await sleep(500); assert.equal((await h.phone.sweep()).retried, 1); assert.equal((await h.row(cid)).state, 'TIMED_OUT'); await sleep(2300); const s = await h.phone.sweep(); assert.equal(s.orphaned, 1);
  assert.equal((await h.row(cid)).state, 'ORPHANED'); assert.deepEqual(reports, [['phone_termination_failed', cid]], 'A5.5: the kind the Shield accepts for a leg that could not be terminated'); assert.ok(h.log.audits.some((a) => a.a === 'phone.orphaned'));
  await h.db.query("UPDATE phone_calls SET hangup_confirmed_at=now() WHERE id=$1", [cid]); assert.equal((await h.phone.sweep()).retried, 0, 'once the gateway confirms, nothing is retried');
});
test('the meeting ending hangs every call up, whatever its state', { skip }, async () => {
  const h = await harness(), m = await h.meeting(); const a = (await verify(h, m)).body; const b = (await verify(h, m)).body; const cb = await h.row(b.callRef); await media(h, cb.provider_call_id, b.mediaToken, good());
  assert.equal(await h.phone.endAll(m.id, 'meeting_ended'), 2); assert.equal((await h.row(a.callRef)).state, 'CANCELLED'); assert.equal((await h.row(b.callRef)).state, 'TERMINATED'); assert.equal(h.phoneOnline.get(m.id)?.size ?? 0, 0);
});
test('a PIN revoked while a caller is connected ends the call; a removed caller is banned and cannot come back', { skip }, async () => {
  const h = await harness(), m = await h.meeting(); const v = (await verify(h, m)).body, c = await h.row(v.callRef); await media(h, c.provider_call_id, v.mediaToken, good());
  await h.db.query("UPDATE phone_calls SET status=status WHERE id=$1", [c.id]); await h.phone.revokePin(m.id); assert.equal((await h.row(v.callRef)).state, 'TERMINATED');
  const m2 = await h.meeting(), v2 = (await verify(h, m2)).body, c2 = await h.row(v2.callRef); await h.db.query('INSERT INTO phone_bans(meeting_id, caller_hash) VALUES($1,$2) ON CONFLICT DO NOTHING', [m2.id, c2.caller_hash]);
  await h.phone.endAll(m2.id, 'x'); const again = await verify(h, m2); assert.equal(again.body.result, 'denied');
});

// ================================================================================================ 4. Security Shield
const fakeShield = (o = {}) => { const s = { enforce: true, calls: [], reports: [], decision: { allow: true }, revoke: [], down: false, async authorize(meetingId, participantId) { s.calls.push(['authorize', meetingId, participantId]); if (s.down) throw new Error('shield down'); return s.decision; },
  async recheck(list) { s.calls.push(['recheck', list.length]); if (s.down) return null; return { revoke: list.filter((p) => s.revoke.includes(p.participantId)).map((p) => ({ meetingId: p.meetingId, participantId: p.participantId, reason: 'SUSPENDED' })) }; }, async report(k, r) { s.reports.push([k, r]); return true; }, ...o }; return s; };
test('Shield enforced: allow -> approved; refuse or unreachable -> refused, REFUSED state, participant denied, never approved', { skip }, async () => {
  const sh = fakeShield(), h = await harness({ shield: sh }); await clean(h); const m = await h.meeting();
  assert.equal((await verify(h, m)).body.result, 'approved'); assert.equal(sh.calls.filter((c) => c[0] === 'authorize').length, 1);
  sh.decision = { allow: false, reason: 'GUEST_NOT_ALLOWED' }; const r = (await verify(h, m)).body; assert.equal(r.result, 'denied'); const refused = (await h.db.query("SELECT * FROM phone_calls WHERE state='REFUSED'")).rows[0];
  assert.match(refused.end_reason, /^shield_guest_not_allowed/); assert.equal((await h.db.query('SELECT admission FROM participants WHERE id=$1', [refused.participant_id])).rows[0].admission, 'denied'); assert.ok(h.log.audits.some((a) => a.a === 'phone.shield_refused'));
  sh.decision = { allow: true }; sh.down = true; assert.equal((await verify(h, m)).body.result, 'denied', 'an unreachable Shield is a refusal, never an approval');
  const none = await harness({ shield: { enforce: true } }), mn = await none.meeting(); assert.equal((await verify(none, mn)).body.result, 'denied', 'enforced with no way to ask the Shield');
});
test('Shield is asked AGAIN before media connects: approved, then revoked before audio -> REFUSED and the gateway is told to terminate', { skip }, async () => {
  const sh = fakeShield(), h = await harness({ shield: sh }), m = await h.meeting(); const v = (await verify(h, m)).body, c = await h.row(v.callRef);
  sh.decision = { allow: false, reason: 'SUSPENDED' }; const r = await media(h, c.provider_call_id, v.mediaToken, good()); assert.equal(r.body.action, 'terminate'); const t = await h.row(v.callRef); assert.equal(t.state, 'REFUSED'); assert.equal(h.phoneOnline.get(m.id)?.size ?? 0, 0);
});
test('Shield re-check of OPEN calls: a revocation ends the call at once; an unreachable Shield ends calls only after the grace period', { skip }, async () => {
  let skew = 0; const sh = fakeShield(), h = await harness({ shield: sh, clock: () => Date.now() + skew, env: { SHIELD_RECHECK_GRACE_SECONDS: '60' } }); await clean(h); const m = await h.meeting();
  const a = (await verify(h, m)).body, ca = await h.row(a.callRef); await media(h, ca.provider_call_id, a.mediaToken, good()); const b = (await verify(h, m)).body, cb = await h.row(b.callRef);
  assert.deepEqual(await h.phone.shieldSweep(), { revoked: 0 }); sh.revoke = [ca.participant_id]; assert.deepEqual(await h.phone.shieldSweep(), { revoked: 1 });
  assert.equal((await h.row(a.callRef)).state, 'TERMINATED'); assert.match((await h.row(a.callRef)).end_reason, /^shield_suspended/); assert.equal((await h.row(b.callRef)).state, 'APPROVED'); assert.ok(h.phone.provider.calls.some((x) => x.op === 'hangup' && x.callId === ca.provider_call_id));
  assert.equal(h.phoneOnline.get(m.id)?.size ?? 0, 0, 'the revoked caller left the room'); sh.revoke = [];
  // A5.5: an unreachable Shield. A call that is not yet connected ends AT ONCE (admission and promotion are fail-closed); an already-connected call keeps its grace period, measured from the FIRST failed recheck.
  const c3 = (await verify(h, m)).body, cc = await h.row(c3.callRef); await media(h, cc.provider_call_id, c3.mediaToken, good()); assert.equal((await h.row(c3.callRef)).state, 'MEDIA_CONNECTED');
  sh.down = true; assert.deepEqual(await h.phone.shieldSweep(), { revoked: 1 }, 'the approved-but-not-connected call ends at once'); assert.equal((await h.row(b.callRef)).state, 'REFUSED'); assert.equal(cb.state, 'APPROVED'); assert.equal((await h.row(c3.callRef)).state, 'MEDIA_CONNECTED', 'the connected call is inside its grace period');
  skew += 30_000; assert.deepEqual(await h.phone.shieldSweep(), { revoked: 0 }, 'still inside the grace period (30 s after the first failed recheck)'); skew += 40_000; assert.deepEqual(await h.phone.shieldSweep(), { revoked: 1 }, 'past the grace period (70 s after the FIRST failure) the connected call ends');
  assert.equal((await h.row(c3.callRef)).state, 'TERMINATED'); assert.match((await h.row(c3.callRef)).end_reason, /^shield_shield_unavailable/);
});
test('gateway mode never runs without the Shield, even when SHIELD_MEET_ENFORCE is off', { skip }, async () => {
  const ks = keys(), h = await harness({ gatewayEnv: gwEnv(ks), env: { PHONE_GATEWAY_ENABLED: 'true' }, readiness: async () => ({ readiness: ALL }) }), m = await h.meeting();
  const r = await gpost(h, ks, '/api/phone/ivr/verify', 'phone.verify', { eventId: h.uid(), callId: 'call_' + h.uid(), from: FROM, meetingId: m.code, pin: m.pin }); assert.equal(r.body.result, 'denied');
});

// ================================================================================================ 5. duplicates and concurrency
test('duplicate callbacks: the same event id returns the stored answer with no second effect; the same call id under a new event id is refused', { skip }, async () => {
  const h = await harness(), m = await h.meeting(), body = { eventId: 'evt_dup_00000001', callId: 'call_dup_00000001', from: FROM, meetingId: m.code, pin: m.pin };
  const send = async (p, b) => { const raw = JSON.stringify(b); const r = await fetch(h.base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qorlla-signature': h.phone.provider.sign(raw) }, body: raw }); return r.json(); };
  const a = await send('/api/phone/ivr/verify', body), b = await send('/api/phone/ivr/verify', body); assert.equal(a.result, 'approved'); assert.equal(b.duplicate, true); assert.equal(b.callRef, a.callRef); assert.equal((await h.db.query("SELECT count(*)::int AS n FROM phone_calls WHERE provider_call_id='call_dup_00000001'")).rows[0].n, 1);
  assert.equal((await send('/api/phone/ivr/verify', { ...body, eventId: 'evt_dup_00000002' })).result, 'denied'); const mr = { eventId: 'evt_dup_media_001', callId: body.callId, mediaToken: a.mediaToken, evidence: good() };
  assert.equal((await send('/api/phone/ivr/media', mr)).result, 'connected'); assert.equal((await send('/api/phone/ivr/media', mr)).duplicate, true); assert.equal(h.log.emits.filter((e) => e.ev === 'participant-online').length, 1);
  assert.equal((await send('/api/phone/ivr/disconnect', { eventId: 'evt_dup_end_0001', callId: body.callId, type: 'bye' })).result, 'ended'); assert.equal((await send('/api/phone/ivr/disconnect', { eventId: 'evt_dup_end_0001', callId: body.callId })).duplicate, true);
  assert.equal((await send('/api/phone/ivr/disconnect', { eventId: 'evt_dup_end_0002', callId: body.callId, type: 'bye' })).result, 'ended', 'a second hang-up with a new event id changes nothing'); assert.equal((await h.row(a.callRef)).state, 'TERMINATED');
});
test('concurrent admissions of ONE call id (replayed webhooks across replicas): exactly one call row and one approval', { skip }, async () => {
  const a = await harness(), b = await harness({ db: a.db }), m = await a.meeting(), callId = 'call_race_00000001';
  const results = await Promise.all([a, b, a, b, a, b, a, b].map((h, i) => verify(h, m, { callId, eventId: 'evt_race_' + i + '_' + a.uid() })));
  assert.equal(results.filter((r) => r.body.result === 'approved').length, 1); assert.equal((await a.db.query('SELECT count(*)::int AS n FROM phone_calls WHERE provider_call_id=$1', [callId])).rows[0].n, 1);
});
test('concurrent media reports for one approved call connect it exactly once', { skip }, async () => {
  const a = await harness(), b = await harness({ db: a.db }), m = await a.meeting(); const v = (await verify(a, m)).body, c = await a.row(v.callRef);
  const out = await Promise.all([a, b, a, b, a, b].map((h) => media(h, c.provider_call_id, v.mediaToken, good())));
  assert.ok(out.every((r) => ['connected', 'connecting'].includes(r.body.result))); assert.equal((await a.states(v.callRef)).filter((s) => s === 'MEDIA_CONNECTED').length, 1); assert.equal(a.log.emits.filter((e) => e.ev === 'participant-online').length + b.log.emits.filter((e) => e.ev === 'participant-online').length, 1);
});

// ================================================================================================ 6. gateway authentication (real ES256 tokens)
const keys = () => { const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }); return { priv: privateKey.export({ type: 'pkcs8', format: 'pem' }), pub: publicKey.export({ type: 'spki', format: 'pem' }) }; };
const other = keys(); const ISS = 'qorlla-phone-gateway-1', SUB = 'svc:phone-gateway';
const ALL = { carrierConnected: true, inboundNumberCertified: true, gatewayHealthy: true, mediaBridgeCertified: true, billingCertified: true, productionApproved: true };
const gwEnv = (k, over = {}) => ({ PHONE_GATEWAY_KEYS_JSON: JSON.stringify({ [ISS]: { w1: k.pub } }), PHONE_GATEWAY_SUBJECTS_JSON: JSON.stringify({ [SUB]: ['phone.verify', 'phone.media', 'phone.end', 'phone.decision', 'phone.health', 'phone.consent', 'phone.readiness'] }), PHONE_GATEWAY_REQUIRE_MTLS: 'false', ...over });
const b64 = (b) => Buffer.from(b).toString('base64url');
function mint(k, { scope, sub = SUB, iss = ISS, kid = 'w1', aud = 'qorlla-phone-gateway', ttl = 120, now = Math.floor(Date.now() / 1000), body, cnf, alg = 'ES256', jti } = {}) {
  const head = b64(JSON.stringify({ alg, typ: 'JWT', kid })), claims = b64(JSON.stringify({ iss, sub, aud, iat: now, exp: now + ttl, jti: jti ?? crypto.randomUUID() + crypto.randomUUID(), ...(cnf ? { cnf: { 'x5t#S256': cnf } } : {}), ...(body !== undefined ? { bsh: b64(crypto.createHash('sha256').update(body).digest()) } : {}) }));
  return head + '.' + claims + '.' + b64(crypto.sign('sha256', Buffer.from(head + '.' + claims), { key: k.priv, dsaEncoding: 'ieee-p1363' }));
}
const gpost = async (h, k, p, scope, body, o = {}) => { const raw = JSON.stringify(body); const r = await fetch(h.base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(o.noToken ? {} : { authorization: 'Bearer ' + (o.token ?? mint(k, { scope, body: raw, ...o.mint })) }) }, body: o.rawOverride ?? raw }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const gget = async (h, k, p, o = {}) => { const r = await fetch(h.base + p, { headers: o.noToken ? {} : { authorization: 'Bearer ' + (o.token ?? mint(k, { ...o.mint })) } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
// In gateway mode a call is promoted only if Meet's own record says a verification peer of THAT gateway session has negotiated with a browser (phone-peer.mjs; the real thing is tested against the real server in phone-peer.pg.test.mjs).
// These module tests stand in for it with a peer that is live and has negotiated, so the lifecycle rules around it can be exercised.
const livePeers = () => ({ configured: true, notReady: () => null, promote: async () => {}, revoke: async () => true, notifyOffline: () => {} });
const gwHarness = async (k, o = {}) => { const { env, gw, ...rest } = { peers: livePeers(), ...o }; return harness({ gatewayEnv: gwEnv(k, gw), env: { PHONE_GATEWAY_ENABLED: 'true', ...env }, readiness: async () => ({ readiness: ALL }), shield: fakeShield(), ...rest }); };
const vbody = (h, m, over = {}) => ({ eventId: h.uid(), callId: 'call_' + h.uid(), from: FROM, meetingId: m.code, pin: m.pin, ...over });

test('gateway mode is OFF unless explicitly enabled, and without gateway keys the original provider scheme is unchanged', { skip }, async () => {
  const k = keys(), off = await harness({ gatewayEnv: gwEnv(k), readiness: async () => ({ readiness: ALL }) }), m = await off.meeting();
  assert.equal((await gpost(off, k, '/api/phone/ivr/verify', 'phone.verify', vbody(off, m))).status, 503); assert.equal(off.phone.enabled, false);
  const partial = await harness({ gatewayEnv: { PHONE_GATEWAY_KEYS_JSON: JSON.stringify({ [ISS]: { w1: k.pub } }) }, env: { PHONE_GATEWAY_ENABLED: 'true', PHONE_PROVIDER: 'test' } }); assert.equal(partial.phone.gatewayMode, false, 'half a configuration does not switch gateway mode on');
  const legacy = await harness(), ml = await legacy.meeting(); assert.equal((await verify(legacy, ml)).body.result, 'approved');
});
test('gateway authentication: no token, bad token, the provider HMAC, wrong audience / subject / scope / key / algorithm / expiry / body, and a replay are all refused', { skip }, async () => {
  const k = keys(), h = await gwHarness(k), m = await h.meeting(), V = '/api/phone/ivr/verify', send = (o) => gpost(h, k, V, 'phone.verify', vbody(h, m), o);
  assert.equal((await send({ noToken: true })).status, 401); assert.equal((await send({ token: 'garbage' })).status, 401);
  const raw = JSON.stringify(vbody(h, m)), tsec = Math.floor(Date.now() / 1000), hmac = await fetch(h.base + V, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qorlla-signature': 't=' + tsec + ',v1=' + crypto.createHmac('sha256', WEBHOOK).update(tsec + '.' + raw).digest('hex') }, body: raw }); assert.equal(hmac.status, 401, 'the provider HMAC is not accepted in gateway mode');
  const cases = [['audience', { mint: { aud: 'qorlla-shield' } }, 401], ['subject', { mint: { sub: 'svc:meet' } }, 401], ['issuer', { mint: { iss: 'someone' } }, 401], ['kid', { mint: { kid: 'w9' } }, 401], ['expired', { mint: { now: Math.floor(Date.now() / 1000) - 1000 } }, 401],
    ['future', { mint: { now: Math.floor(Date.now() / 1000) + 600 } }, 401], ['ttl', { mint: { ttl: 3600 } }, 401], ['alg', { mint: { alg: 'HS256' } }, 401]];
  for (const [why, o, st] of cases) assert.equal((await send(o)).status, st, why);
  assert.equal((await send({ token: mint(other, { scope: 'x', body: raw }) })).status, 401, 'signed by another key');
  const t = mint(k, { body: JSON.stringify(vbody(h, m)) }); assert.equal((await gpost(h, k, V, 'x', vbody(h, m), { token: t })).status, 401, 'body hash does not match the body sent');
  const fixed = vbody(h, m), tok = mint(k, { body: JSON.stringify(fixed) }); assert.equal((await gpost(h, k, V, 'x', fixed, { token: tok })).status, 200); assert.equal((await gpost(h, k, V, 'x', fixed, { token: tok })).status, 401, 'replayed token');
  assert.ok(h.log.audits.some((a) => a.a === 'phone.gateway_refused'));
});
test('a valid gateway token for another scope does NOT authorise this operation (restricted identity, scopes are server-side)', { skip }, async () => {
  const k = keys(), h = await harness({ gatewayEnv: { ...gwEnv(k), PHONE_GATEWAY_SUBJECTS_JSON: JSON.stringify({ [SUB]: ['phone.media'], 'svc:phone-monitor': ['phone.health'] }) }, env: { PHONE_GATEWAY_ENABLED: 'true' }, readiness: async () => ({ readiness: ALL }), shield: fakeShield() }), m = await h.meeting();
  assert.equal((await gpost(h, k, '/api/phone/ivr/verify', 'phone.verify', vbody(h, m))).status, 403, 'a media-only identity cannot admit callers');
  assert.equal((await gpost(h, k, '/api/phone/ivr/gateway-health', 'phone.health', { instance: 'gw1', healthy: true }, { mint: { sub: 'svc:phone-monitor' } })).status, 200);
  assert.equal((await gpost(h, k, '/api/phone/ivr/media', 'phone.media', { eventId: 'evt_mon_00000001', callId: 'call_unknown_0001', evidence: good() }, { mint: { sub: 'svc:phone-monitor' } })).status, 403, 'a health-only identity cannot report media');
  assert.equal((await gpost(h, k, '/api/phone/ivr/media', 'phone.media', { eventId: 'evt_mon_00000002', callId: 'call_unknown_0001', evidence: good() })).status, 200);
});
test('key rotation: both kids work during the overlap; retiring the old kid refuses its tokens; an unknown kid never works', { skip }, async () => {
  const oldK = keys(), newK = keys(); const both = await harness({ gatewayEnv: { ...gwEnv(oldK), PHONE_GATEWAY_KEYS_JSON: JSON.stringify({ [ISS]: { w1: oldK.pub, w2: newK.pub } }) }, env: { PHONE_GATEWAY_ENABLED: 'true' }, readiness: async () => ({ readiness: ALL }), shield: fakeShield() }), m = await both.meeting();
  const hb = (h, k, kid) => gpost(h, k, '/api/phone/ivr/gateway-health', 'phone.health', { instance: 'gw1', healthy: true }, { mint: { kid } });
  assert.equal((await hb(both, oldK, 'w1')).status, 200); assert.equal((await hb(both, newK, 'w2')).status, 200); assert.equal((await hb(both, newK, 'w1')).status, 401, 'right key, wrong kid');
  const retired = await harness({ db: both.db, gatewayEnv: { ...gwEnv(newK), PHONE_GATEWAY_KEYS_JSON: JSON.stringify({ [ISS]: { w2: newK.pub } }) }, env: { PHONE_GATEWAY_ENABLED: 'true' } }); assert.equal((await hb(retired, oldK, 'w1')).status, 401); assert.equal((await hb(retired, newK, 'w2')).status, 200); void m;
});
test('replay protection and the request budget are shared by every replica (PostgreSQL), and a database outage is a refusal', { skip }, async () => {
  const k = keys(), a = await gwHarness(k, { gw: { PHONE_GATEWAY_RATE_LIMIT: '6' } }), b = await harness({ db: a.db, gatewayEnv: gwEnv(k, { PHONE_GATEWAY_RATE_LIMIT: '6' }), env: { PHONE_GATEWAY_ENABLED: 'true' } });
  const t = mint(k, { body: JSON.stringify({ instance: 'gw1', healthy: true }) }); const sends = await Promise.all([a, b, a, b].map((h) => fetch(h.base + '/api/phone/ivr/gateway-health', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: JSON.stringify({ instance: 'gw1', healthy: true }) }).then((r) => r.status)));
  assert.equal(sends.filter((s) => s === 200).length, 1, 'one replica accepted the captured token, the others refused it'); assert.equal(sends.filter((s) => s === 401).length, 3);
  const hb = (h) => gpost(h, k, '/api/phone/ivr/gateway-health', 'phone.health', { instance: 'gw1', healthy: true }); const codes = []; for (let i = 0; i < 6; i++) codes.push((await hb(i % 2 ? a : b)).status); assert.ok(codes.includes(429), 'the shared budget (6 per minute) was exceeded across two replicas: ' + codes.join(','));
  const dead = new pg.Pool({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none', max: 1, connectionTimeoutMillis: 300 }); pools.push(dead); const down = await harness({ gatewayDb: dead, gatewayEnv: gwEnv(k), env: { PHONE_GATEWAY_ENABLED: 'true' } });
  assert.equal((await gpost(down, k, '/api/phone/ivr/gateway-health', 'phone.health', { instance: 'gw1', healthy: true })).status, 503, 'database outage: refused, never allowed');
});
test('gateway admission needs ALL SIX readiness conditions from an authoritative source: any false, missing, malformed or failing source refuses (and creates no call)', { skip }, async () => {
  const k = keys(); const cases = [['all true', { readiness: ALL }, 200], ['one false', { readiness: { ...ALL, billingCertified: false } }, 503], ['one missing', { readiness: (({ productionApproved, ...r }) => r)(ALL) }, 503], ['truthy not true', { readiness: { ...ALL, gatewayHealthy: 'yes' } }, 503],
    ['empty', { readiness: {} }, 503], ['no readiness field', {}, 503], ['null', null, 503], ['array', { readiness: [true, true, true, true, true, true] }, 503]];
  for (const [why, answer, status] of cases) { const h = await gwHarness(k, { readiness: async () => answer }), m = await h.meeting(); const r = await gpost(h, k, '/api/phone/ivr/verify', 'phone.verify', vbody(h, m)); assert.equal(r.status, status, why); if (status === 503) assert.equal((await h.db.query('SELECT count(*)::int AS n FROM phone_calls WHERE meeting_id=$1', [m.id])).rows[0].n, 0, why + ': no call'); }
  const throwing = await gwHarness(k, { readiness: async () => { throw new Error('authority down'); } }), mt = await throwing.meeting(); assert.equal((await gpost(throwing, k, '/api/phone/ivr/verify', 'phone.verify', vbody(throwing, mt))).status, 503);
  const none = await harness({ gatewayEnv: gwEnv(k), env: { PHONE_GATEWAY_ENABLED: 'true' }, shield: fakeShield() }), mn = await none.meeting(); assert.equal((await gpost(none, k, '/api/phone/ivr/verify', 'phone.verify', vbody(none, mn))).status, 503, 'no readiness source configured');
});
test('gateway mode end to end: verify -> approved -> real-looking media -> connected; synthetic evidence from a real gateway is refused; in-flight calls can still be ended when readiness drops', { skip }, async () => {
  const k = keys(); let ready = ALL; const h = await gwHarness(k, { readiness: async () => ({ readiness: ready }) }), m = await h.meeting();
  const v = await gpost(h, k, '/api/phone/ivr/verify', 'phone.verify', vbody(h, m)); assert.equal(v.body.result, 'approved'); const c = await h.row(v.body.callRef); assert.equal(c.provider, 'gateway');
  const syn = await gpost(h, k, '/api/phone/ivr/media', 'phone.media', { eventId: h.uid(), callId: c.provider_call_id, mediaToken: v.body.mediaToken, evidence: good({ source: 'synthetic' }) }); assert.equal(syn.body.result, 'connecting'); assert.equal((await h.row(c.id)).status, 'waiting');
  const real = await gpost(h, k, '/api/phone/ivr/media', 'phone.media', { eventId: h.uid(), callId: c.provider_call_id, mediaToken: v.body.mediaToken, evidence: good({ source: 'rtp' }) }); assert.equal(real.body.result, 'connected'); assert.equal((await h.row(c.id)).state, 'MEDIA_CONNECTED');
  ready = { ...ALL, productionApproved: false }; const end = await gpost(h, k, '/api/phone/ivr/disconnect', 'phone.end', { eventId: h.uid(), callId: c.provider_call_id, type: 'bye' }); assert.equal(end.body.result, 'ended'); assert.equal((await h.row(c.id)).state, 'TERMINATED');
  assert.equal((await gpost(h, k, '/api/phone/ivr/verify', 'phone.verify', vbody(h, m))).status, 503, 'but no NEW caller is admitted');
});

// ================================================================================================ 7. durable, bounded host decision (replaces polling)
test('host decision: bounded long-poll, durable state, the media token is issued exactly once, silence times out, concurrency is capped, scope is enforced', { skip }, async () => {
  const k = keys(), h = await gwHarness(k, { env: { PHONE_APPROVAL_TIMEOUT_MS: '2500', PHONE_DECISION_MAX_WAITERS: '2' } }), m = await h.meeting({ waitingRoom: true }), D = (id, wait) => gget(h, k, '/api/phone/ivr/calls/' + id + '/decision?waitMs=' + wait);
  const a = (await gpost(h, k, '/api/phone/ivr/verify', 'phone.verify', vbody(h, m))).body, ca = await h.row(a.callRef); assert.equal(a.result, 'waiting');
  const t0 = Date.now(); const pend = await D(a.callRef, 300); assert.equal(pend.body.decision, 'pending'); assert.ok(Date.now() - t0 >= 250 && Date.now() - t0 < 2500, 'waited, but bounded');
  const waiting = D(a.callRef, 5000); await sleep(150); await h.db.query("UPDATE participants SET admission='admitted' WHERE id=$1", [ca.participant_id]); await h.phone.onAdmission(m.id, [ca.participant_id], true);
  const done = await waiting; assert.equal(done.body.decision, 'approved'); assert.ok(done.body.mediaToken, 'the token arrives with the decision'); assert.equal((await D(a.callRef, 0)).body.mediaToken, undefined, 'and only once');
  const tok = done.body.mediaToken; const r = await gpost(h, k, '/api/phone/ivr/media', 'phone.media', { eventId: h.uid(), callId: ca.provider_call_id, mediaToken: tok, evidence: good({ source: 'rtp' }) }); assert.equal(r.body.result, 'connected');
  const b = (await gpost(h, k, '/api/phone/ivr/verify', 'phone.verify', vbody(h, m))).body; const t1 = Date.now(); const to = await D(b.callRef, 5000); assert.equal(to.body.decision, 'timed_out'); assert.ok(Date.now() - t1 < 4800, 'the approval timeout ended the wait before the 5 s the caller was willing to wait'); assert.equal((await h.row(b.callRef)).state, 'TIMED_OUT');
  const c3 = (await gpost(h, k, '/api/phone/ivr/verify', 'phone.verify', vbody(h, m))).body; const sat = await Promise.all([D(c3.callRef, 400), D(c3.callRef, 400), D(c3.callRef, 400)]); assert.ok(sat.some((x) => x.status === 429), 'more waiters than the cap are turned away: ' + sat.map((x) => x.status));
  assert.equal((await D('not-a-uuid', 0)).status, 404); assert.equal((await D(crypto.randomUUID(), 0)).status, 404); assert.equal((await gget(h, k, '/api/phone/ivr/calls/' + c3.callRef + '/decision', { noToken: true })).status, 401);
  const lim = await harness({ db: h.db, gatewayEnv: { ...gwEnv(k), PHONE_GATEWAY_SUBJECTS_JSON: JSON.stringify({ [SUB]: ['phone.media'] }) }, env: { PHONE_GATEWAY_ENABLED: 'true' } }); assert.equal((await gget(lim, k, '/api/phone/ivr/calls/' + c3.callRef + '/decision')).status, 403);
});
test('gateway readiness route: its own scope, the authoritative answer, 503 when the source fails, absent outside gateway mode', { skip }, async () => {
  const k = keys(); let answer = { readiness: ALL, generatedAt: new Date().toISOString() }; const h = await gwHarness(k, { readiness: async () => { if (!answer) throw new Error('down'); return answer; } });
  const r = await gget(h, k, '/api/phone/ivr/readiness'); assert.equal(r.status, 200); assert.deepEqual(r.body.readiness, ALL); assert.equal((await gget(h, k, '/api/phone/ivr/readiness', { noToken: true })).status, 401);
  const lim = await harness({ db: h.db, gatewayEnv: { ...gwEnv(k), PHONE_GATEWAY_SUBJECTS_JSON: JSON.stringify({ [SUB]: ['phone.verify'] }) }, env: { PHONE_GATEWAY_ENABLED: 'true' }, readiness: async () => answer }); assert.equal((await gget(lim, k, '/api/phone/ivr/readiness')).status, 403, 'verify scope is not readiness scope');
  answer = null; assert.equal((await gget(h, k, '/api/phone/ivr/readiness')).status, 503); const plain = await harness(); assert.equal((await fetch(plain.base + '/api/phone/ivr/readiness')).status, 404);
});
test('without gateway mode the decision route does not exist (the test double and carrier paths are unchanged)', { skip }, async () => {
  const h = await harness(), r = await fetch(h.base + '/api/phone/ivr/calls/' + crypto.randomUUID() + '/decision'); assert.equal(r.status, 404);
});

// ================================================================================================ 8. mutual TLS (real certificates)
test('mTLS: the token must carry the thumbprint of the certificate the gateway presented on THIS connection', { skip: skip || (() => { try { execFileSync('openssl', ['version']); return false; } catch { return 'openssl not available'; } })() }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtls-')), run = (...a) => execFileSync('openssl', a, { cwd: dir, stdio: 'ignore' });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=test-ca', '-days', '2');
  for (const [name, cn] of [['server', 'localhost'], ['gw', 'phone-gateway'], ['rogue', 'rogue']]) { run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=' + cn); fs.writeFileSync(path.join(dir, name + '.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n'); run('x509', '-req', '-in', name + '.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', name + '.crt', '-days', '2', '-extfile', name + '.ext'); }
  const rd = (f) => fs.readFileSync(path.join(dir, f)), thumb = (f) => b64(crypto.createHash('sha256').update(new crypto.X509Certificate(rd(f)).raw).digest());
  const k = keys(), db = poolFor(), gw = createGatewayAuth({ db, env: gwEnv(k, { PHONE_GATEWAY_REQUIRE_MTLS: 'true' }), log: { warn() {} } }); let seen = null;
  const app = express(); app.get('/x', async (req, res) => { try { seen = await gw.authenticate(req, 'phone.health', null); res.json({ ok: true }); } catch (e) { res.status(e.status).json({ reason: e.reason }); } });
  const server = https.createServer({ key: rd('server.key'), cert: rd('server.crt'), ca: rd('ca.crt'), requestCert: true, rejectUnauthorized: true }, app); await new Promise((r) => server.listen(0, '127.0.0.1', r)); closers.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const call = (cert, token) => new Promise((resolve, reject) => { const req = https.request({ host: '127.0.0.1', port: server.address().port, path: '/x', ca: rd('ca.crt'), key: cert ? rd(cert + '.key') : undefined, cert: cert ? rd(cert + '.crt') : undefined, headers: { authorization: 'Bearer ' + token }, agent: false }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') })); }); req.on('error', reject); req.end(); });
  assert.equal((await call('gw', mint(k, { cnf: thumb('gw.crt') }))).status, 200, 'token bound to the certificate that was presented');
  const stolen = await call('rogue', mint(k, { cnf: thumb('gw.crt') })); assert.equal(stolen.status, 401); assert.equal(stolen.body.reason, 'certificate_binding');
  assert.equal((await call('gw', mint(k))).body.reason, 'certificate_binding', 'an unbound token is refused when mTLS is required');
  await assert.rejects(call(null, mint(k, { cnf: thumb('gw.crt') })), 'a connection with no client certificate never reaches the handler'); assert.equal(seen.subject, SUB); fs.rmSync(dir, { recursive: true, force: true });
});

// ================================================================================================ 9. authoritative readiness (stored, fresh evidence)
test('readiness is computed from stored, FRESH evidence; nothing static; each condition fails closed on its own', { skip }, async () => {
  const db = poolFor(), flags = 'dialin,bridge,billing,production', mk = (carrier, bridge, env = {}) => new TelephonyService({ db, carrier, bridge, audio: {}, env: { PHONE_FEATURES: flags, ...env } });
  const carrier = { name: 'rt-' + Math.random().toString(36).slice(2, 6), configured: true }, up = { ready: true }, reset = async () => { for (const t of ['qphone_gates', 'qphone_provider_status', 'phone_gateway_health']) await db.query('DELETE FROM ' + t); await db.query('DELETE FROM qphone_usage'); await db.query("DELETE FROM qphone_numbers WHERE provider=$1", [carrier.name]); };
  await reset(); let r = await mk(carrier, { ready: false }).phoneReadiness(); assert.deepEqual(Object.values(r.readiness), [false, false, false, false, false, false], 'an empty system is not ready'); assert.ok(r.generatedAt);
  const gate = (g, ago = '1 hour') => db.query("INSERT INTO qphone_gates(gate, certified_at, evidence_ref, evidence_sha256, certified_by) VALUES($1, now() - $2::interval, 'ev', 'abc', 'op') ON CONFLICT (gate) DO UPDATE SET certified_at=EXCLUDED.certified_at", [g, ago]);
  const setup = async () => { await reset(); await db.query("INSERT INTO qphone_provider_status(provider, health_ok, health_checked_at, webhook_verified_at) VALUES($1,true,now(),now())", [carrier.name]); await db.query("SET session_replication_role = replica"); await db.query("INSERT INTO qphone_numbers(e164, provider, provider_number_id, country, kind, state) VALUES('+12025550188',$1,$2,'US','dialin','active')", [carrier.name, 'pn_' + carrier.name]); await db.query("INSERT INTO qphone_usage(provider, provider_usage_id, state) VALUES($1,$2,'reconciled')", [carrier.name, 'u_' + carrier.name]); await db.query("SET session_replication_role = DEFAULT");
    for (const g of ['dialin', 'bridge', 'billing', 'production']) await gate(g); await db.query("INSERT INTO phone_gateway_health(instance, healthy, observed_at) VALUES('gw1', true, now())"); };
  await setup(); r = await mk(carrier, up).phoneReadiness(); assert.deepEqual(r.readiness, ALL, JSON.stringify(r.why));
  const probe = async (label, mutate, key, svc = () => mk(carrier, up)) => { await setup(); await mutate(); const x = await svc().phoneReadiness(); assert.equal(x.readiness[key], false, label); assert.equal(Object.values(x.readiness).filter(Boolean).length < 6, true, label); };
  await probe('carrier unhealthy', () => db.query('UPDATE qphone_provider_status SET health_ok=false'), 'carrierConnected');
  await probe('carrier health stale', () => db.query("UPDATE qphone_provider_status SET health_checked_at = now() - interval '2 hours'"), 'carrierConnected');
  await probe('no signed webhook', () => db.query('UPDATE qphone_provider_status SET webhook_verified_at = NULL'), 'carrierConnected');
  await probe('carrier not configured', async () => {}, 'carrierConnected', () => mk({ ...carrier, configured: false }, up));
  await probe('no dial-in number', () => db.query("DELETE FROM qphone_numbers WHERE provider=$1", [carrier.name]).catch(async () => { await db.query('SET session_replication_role = replica'); await db.query("DELETE FROM qphone_numbers WHERE provider=$1", [carrier.name]); await db.query('SET session_replication_role = DEFAULT'); }), 'inboundNumberCertified');
  await probe('dialin gate expired', () => gate('dialin', '200 days'), 'inboundNumberCertified');
  await probe('dialin flag off', async () => {}, 'inboundNumberCertified', () => mk(carrier, up, { PHONE_FEATURES: 'bridge,billing,production' }));
  await probe('no gateway heartbeat', () => db.query('DELETE FROM phone_gateway_health'), 'gatewayHealthy');
  await probe('gateway heartbeat stale', () => db.query("UPDATE phone_gateway_health SET observed_at = now() - interval '5 minutes'"), 'gatewayHealthy');
  await probe('gateway reports unhealthy', () => db.query('UPDATE phone_gateway_health SET healthy=false'), 'gatewayHealthy');
  await probe('no bridge installed', async () => {}, 'mediaBridgeCertified', () => mk(carrier, { ready: false }));
  await probe('bridge gate missing', () => db.query("DELETE FROM qphone_gates WHERE gate='bridge'"), 'mediaBridgeCertified');
  await probe('billing not reconciled', () => db.query('DELETE FROM qphone_usage'), 'billingCertified');
  await probe('billing gate expired', () => gate('billing', '120 days'), 'billingCertified');
  await probe('no production approval', () => db.query("DELETE FROM qphone_gates WHERE gate='production'"), 'productionApproved');
  await probe('production flag off', async () => {}, 'productionApproved', () => mk(carrier, up, { PHONE_FEATURES: 'dialin,bridge,billing' }));
  await probe('gate without evidence', () => db.query("UPDATE qphone_gates SET evidence_sha256='' WHERE gate='production'"), 'productionApproved');
  await reset();
});

// ================================================================================================ A5: evidence alone never promotes in gateway mode
test('gateway mode: perfect audio evidence does NOT connect a call when no verification peer exists (not configured) or the peer is not ready - fail closed', { skip }, async () => {
  const k = keys(); const cases = [['no peer subsystem at all', null, 'verification_peer_not_configured'], ['peer subsystem present but not configured', { configured: false }, 'verification_peer_not_configured'], ['configured, but no live negotiated peer for this call', { ...livePeers(), notReady: () => 'no_verification_peer' }, 'no_verification_peer'], ['peer of a different gateway session', { ...livePeers(), notReady: () => 'peer_session_mismatch' }, 'peer_session_mismatch']];
  for (const [why, peers, reason] of cases) {
    const h = await gwHarness(k, { peers }), m = await h.meeting(), v = await gpost(h, k, '/api/phone/ivr/verify', 'phone.verify', vbody(h, m)); assert.equal(v.body.result, 'approved', why);
    const c = await h.row(v.body.callRef), r = await gpost(h, k, '/api/phone/ivr/media', 'phone.media', { eventId: h.uid(), callId: c.provider_call_id, mediaToken: v.body.mediaToken, evidence: good({ source: 'rtp' }) });
    assert.equal(r.body.result, 'connecting', why); assert.equal(r.body.reason, reason, why); assert.notEqual((await h.row(v.body.callRef)).state, 'MEDIA_CONNECTED', why); assert.equal((await h.row(v.body.callRef)).status, 'waiting', why);
  }
});
