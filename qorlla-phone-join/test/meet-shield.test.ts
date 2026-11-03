import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import express from 'express';
import { Redis } from 'ioredis';
import { admitTelephoneCall, type Readiness, type SipRtpBridge } from '../src/admission.js';
import { MeetPhoneAuthority, signMeetRequest, parseSession, sessionId } from '../src/meet-authority.js';
import { ShieldClient, ShieldedAuthority, startPhoneSessionGuard } from '../src/shield.js';
import { gatewayAuth, signGatewayToken } from '../src/gateway-auth.js';
import { createRedisRateLimiter, type RedisLike } from '../src/rate-limit-redis.js';
import { verifiedBridge, type MediaGateway } from '../src/media-contract.js';
import { PostgresCallLedger, PostgresReplayStore } from '../src/ledger-pg.js';
import { createPhoneJoinRouter } from '../src/server.js';
import { terminateCall } from '../src/compose.js';
import { closeAllServers, eventually, fakeMeet, fakeShield, keypair, listen, sleep, memoryReplay, WEBHOOK_SECRET, BRIDGE_SECRET } from './support.js';

const all: Readiness = { carrierConnected: true, inboundNumberCertified: true, gatewayHealthy: true, mediaBridgeCertified: true, billingCertified: true, productionApproved: true };
const FROM = '+12025550143', req = (callId: string, over: object = {}) => ({ meetingId: '12345678901', passcode: '12345678', callId, dialedNumber: '+12025550100', callerNumber: FROM, ...over });
const goodBridge = (log: string[] = []): SipRtpBridge => ({ attach: async (id) => { log.push('attach:' + id); return { mediaEstablished: true }; }, disconnect: async (id) => { log.push('disconnect:' + id); } });
const kp = keypair(), ISS = 'qorlla-gateway';

async function setup(meetOver = {}, shieldOver: { guestEnabled?: boolean } = {}) {
  const meet = fakeMeet(meetOver), shield = fakeShield(kp.publicKeyPem, ISS); shield.known.set(meet.uuid, { guestEnabled: shieldOver.guestEnabled ?? true, ended: false });
  const m = await listen(meet.app), s = await listen(shield.app);
  const authority = new MeetPhoneAuthority({ baseUrl: m.url, webhookSecret: WEBHOOK_SECRET, bridgeSecret: BRIDGE_SECRET, directory: meet.directory, pollMs: 20 });
  const shieldClient = new ShieldClient({ url: s.url, privateKeyPem: kp.privateKeyPem, issuer: ISS });
  return { meet, shield, authority, shieldClient, shielded: new ShieldedAuthority(authority, shieldClient), close: async () => { await m.close(); await s.close(); } };
}

// ---------------------------------------------------------------- Meet signature: byte-for-byte what Meet's own code produces
test('the signature matches the known answer produced by Meet\'s real createProvider().sign', () => {
  const raw = '{"eventId":"evt_00000001","callId":"call_12345678","from":"+12025550100","meetingId":"12345678901","pin":"12345678"}';
  assert.equal(signMeetRequest(raw, 'known-answer-secret-0123456789', 1700000000), 't=1700000000,v1=ef6a0082f0654dee36f7560423109389ced04ab5c3c52cf3e821c3812992f280');
});
test('session ids carry both the meeting and the call in Meet, and nothing else is accepted', () => {
  const a = crypto.randomUUID(), b = crypto.randomUUID(); assert.deepEqual(parseSession(sessionId(a, b)), { meetingUuid: a, callRef: b });
  for (const bad of ['', 'x', a, a + '.' + 'nope', a + '.' + b + '.x', '../' + a, a.toUpperCase().slice(0, 20)]) assert.equal(parseSession(bad), null, bad);
});
test('configuration is validated: weak secrets and bad URLs are refused at construction', () => {
  const base = { baseUrl: 'http://meet', webhookSecret: WEBHOOK_SECRET, bridgeSecret: BRIDGE_SECRET, directory: { sourceIdFor: async () => null } };
  assert.throws(() => new MeetPhoneAuthority({ ...base, webhookSecret: 'short' })); assert.throws(() => new MeetPhoneAuthority({ ...base, bridgeSecret: 'short' })); assert.throws(() => new MeetPhoneAuthority({ ...base, baseUrl: 'ftp://x' }));
});

// ---------------------------------------------------------------- MeetPhoneAuthority against the fake Meet
test('Meet: correct meeting number and PIN, no waiting room - admitted, media attached, call recorded in Meet', async () => {
  const t = await setup(); const log: string[] = [];
  const r = await admitTelephoneCall(req('call_00000001'), all, t.authority, goodBridge(log)); assert.equal(r.code, 'MEDIA_CONNECTED'); assert.deepEqual(log, ['attach:call_00000001']);
  assert.equal([...t.meet.calls.values()][0].status, 'connected'); assert.ok(t.meet.log.includes('resolve')); await t.close();
});
test('Meet: wrong PIN, wrong meeting, malformed PIN, missing caller number and over-long call ids are all refused without attaching media', async () => {
  const t = await setup(); const log: string[] = [];
  for (const [why, over] of [['wrong pin', { passcode: '87654321' }], ['wrong meeting', { meetingId: '10987654321' }], ['letters in the PIN', { passcode: 'abcd1234' }], ['PIN too short', { passcode: '123' }], ['short meeting number', { meetingId: 'ABC12345' }], ['no caller number', { callerNumber: undefined }], ['call id too long for Meet', { callId: 'call_' + 'x'.repeat(116) }]] as [string, object][]) {
    const r = await admitTelephoneCall(req('call_' + Math.random().toString(36).slice(2, 10), over), all, t.authority, goodBridge(log)); assert.ok(['JOIN_DENIED', 'INVALID_JOIN_REQUEST'].includes(r.code), why + ' -> ' + r.code); assert.notEqual(r.status, 200, why);
  }
  assert.deepEqual(log, []); await t.close();
});
test('Meet: five wrong PINs from one caller lock that caller out - even the right PIN is then refused (Meet\'s own limit, not ours)', async () => {
  const t = await setup(); for (let i = 0; i < 5; i++) await admitTelephoneCall(req('call_bad0000' + i, { passcode: '00000000' }), all, t.authority, goodBridge());
  const r = await admitTelephoneCall(req('call_good0001'), all, t.authority, goodBridge()); assert.equal(r.code, 'JOIN_DENIED'); await t.close();
});
test('Meet unavailable, telephony disabled in Meet, bad signature secret, and an unresolvable meeting are 503/denial - never an admission', async () => {
  const t = await setup({ telephonyEnabled: false }); const log: string[] = [];
  assert.equal((await admitTelephoneCall(req('call_00000002'), all, t.authority, goodBridge(log))).code, 'MEETING_SERVICE_UNAVAILABLE'); await t.close();
  const u = await setup(); u.meet.state.resolveStatus = 500; assert.equal((await admitTelephoneCall(req('call_00000003'), all, u.authority, goodBridge(log))).code, 'MEETING_SERVICE_UNAVAILABLE'); await u.close();
  const w = await setup(); const wrong = new MeetPhoneAuthority({ baseUrl: (w.authority as any).cfg.baseUrl, webhookSecret: 'a-different-webhook-secret-123456', bridgeSecret: BRIDGE_SECRET, directory: w.meet.directory });
  assert.equal((await admitTelephoneCall(req('call_00000004'), all, wrong, goodBridge(log))).code, 'MEETING_SERVICE_UNAVAILABLE'); assert.ok(w.meet.log.includes('bad-signature')); await w.close();
  const down = new MeetPhoneAuthority({ baseUrl: 'http://127.0.0.1:1', webhookSecret: WEBHOOK_SECRET, bridgeSecret: BRIDGE_SECRET, directory: w.meet.directory, requestTimeoutMs: 300 }); assert.equal((await admitTelephoneCall(req('call_00000005'), all, down, goodBridge(log))).code, 'MEETING_SERVICE_UNAVAILABLE');
  assert.deepEqual(log, []);
});
test('Meet waiting room: the host admits - the caller connects; the host refuses or removes - refused, and Meet drops the waiting caller', async () => {
  for (const [decision, code] of [['connected', 'MEDIA_CONNECTED'], ['denied', 'HOST_APPROVAL_DENIED'], ['removed', 'HOST_APPROVAL_DENIED']] as const) {
    const t = await setup({ waitingRoom: true }); const log: string[] = []; const id = 'call_hostdec_' + decision;
    const p = admitTelephoneCall(req(id), all, t.authority, goodBridge(log), { hostApprovalTimeoutMs: 3000 }); assert.ok(await eventually(() => t.meet.calls.size > 0 && t.meet.log.filter((x) => x === 'poll').length >= 2), 'the caller is waiting in Meet and the gateway is polling');
    assert.equal([...t.meet.calls.values()][0].status, 'waiting'); assert.deepEqual(log, [], 'no media while the caller is waiting'); [...t.meet.calls.values()][0].status = decision;
    const r = await p; assert.equal(r.code, code); assert.equal(log.length, decision === 'connected' ? 1 : 0);
    if (decision !== 'connected') assert.ok(t.meet.log.includes('disconnect:' + id) || [...t.meet.calls.values()][0].status !== 'waiting'); await t.close();
  }
});
test('Meet waiting room: a host who never answers - timeout, the caller is ended in Meet (no ghost in the waiting list), polling stops', async () => {
  const t = await setup({ waitingRoom: true }); const id = 'call_silent_01';
  const r = await admitTelephoneCall(req(id), all, t.authority, goodBridge(), { hostApprovalTimeoutMs: 150 }); assert.equal(r.code, 'HOST_APPROVAL_TIMEOUT');
  assert.equal([...t.meet.calls.values()][0].status, 'ended'); assert.ok(t.meet.log.includes('disconnect:' + id)); const polls = t.meet.log.filter((x) => x === 'poll').length; await sleep(120); assert.equal(t.meet.log.filter((x) => x === 'poll').length, polls, 'polling stopped when the wait was aborted'); await t.close();
});
test('Meet waiting room: a meeting whose scheduled-meeting id cannot be found cannot be approved (and the caller is ended), and a wrong bridge secret is refused', async () => {
  const t = await setup({ waitingRoom: true }); const noDir = new MeetPhoneAuthority({ baseUrl: (t.authority as any).cfg.baseUrl, webhookSecret: WEBHOOK_SECRET, bridgeSecret: BRIDGE_SECRET, directory: { sourceIdFor: async () => null }, pollMs: 20 });
  assert.equal((await admitTelephoneCall(req('call_nodir_001'), all, noDir, goodBridge())).code, 'MEETING_SERVICE_UNAVAILABLE'); assert.equal([...t.meet.calls.values()][0].status, 'ended');
  const badBridge = new MeetPhoneAuthority({ baseUrl: (t.authority as any).cfg.baseUrl, webhookSecret: WEBHOOK_SECRET, bridgeSecret: 'z'.repeat(40), directory: t.meet.directory, pollMs: 20 });
  assert.equal((await admitTelephoneCall(req('call_badbr_001'), all, badBridge, goodBridge())).code, 'MEETING_SERVICE_UNAVAILABLE'); await t.close();
});
test('the same call id twice (a replayed webhook) is refused by the ledger before Meet is asked again', async () => {
  const t = await setup(); const seen = new Set<string>(), ledger = { claim: async (id: string) => (seen.has(id) ? false : (seen.add(id), true)), release: async () => {} };
  assert.equal((await admitTelephoneCall(req('call_dup00001'), all, t.authority, goodBridge(), { ledger })).code, 'MEDIA_CONNECTED'); const before = t.meet.log.length;
  assert.equal((await admitTelephoneCall(req('call_dup00001'), all, t.authority, goodBridge(), { ledger })).code, 'DUPLICATE_CALL'); assert.equal(t.meet.log.length, before); await t.close();
});

// ---------------------------------------------------------------- Security Shield
test('Shield: allowed meeting - admitted; the Shield sees a guest with the call as participant, after approval where approval is needed', async () => {
  const t = await setup(); assert.equal((await admitTelephoneCall(req('call_shield001'), all, t.shielded, goodBridge())).code, 'MEDIA_CONNECTED'); assert.deepEqual(t.shield.log, ['authorize:admitted']); await t.close();
  const w = await setup({ waitingRoom: true }); const p = admitTelephoneCall(req('call_shield002'), all, w.shielded, goodBridge(), { hostApprovalTimeoutMs: 3000 }); assert.ok(await eventually(() => w.meet.log.filter((x) => x === 'poll').length >= 2)); assert.deepEqual(w.shield.log, [], 'not consulted while the caller is only waiting'); [...w.meet.calls.values()][0].status = 'connected';
  assert.equal((await p).code, 'MEDIA_CONNECTED'); assert.deepEqual(w.shield.log, ['authorize:admitted']); await w.close();
});
test('Shield: guests not allowed, or meeting ended - refused, the caller is removed from the meeting, and no media is attached', async () => {
  const t = await setup({}, { guestEnabled: false }); const log: string[] = [];
  const r = await admitTelephoneCall(req('call_shield003'), all, t.shielded, goodBridge(log)); assert.equal(r.code, 'JOIN_DENIED'); assert.deepEqual(log, []); assert.equal([...t.meet.calls.values()][0].status, 'ended', 'Meet had already connected the caller; it is hung up there'); await t.close();
  const e = await setup(); e.shield.known.get(e.meet.uuid)!.ended = true; assert.equal((await admitTelephoneCall(req('call_shield004'), all, e.shielded, goodBridge(log))).code, 'JOIN_DENIED'); assert.deepEqual(log, []); await e.close();
});
test('Shield: an unreachable Shield, a Shield that refuses our token, or a garbage answer is NEVER an admission (503, caller ended in Meet)', async () => {
  const t = await setup(); t.shield.state.unreachable = true; const log: string[] = [];
  assert.equal((await admitTelephoneCall(req('call_shield005'), all, t.shielded, goodBridge(log))).code, 'MEETING_SERVICE_UNAVAILABLE'); assert.equal([...t.meet.calls.values()][0].status, 'ended'); assert.deepEqual(log, []); await t.close();
  const u = await setup(); const wrongKey = new ShieldedAuthority(u.authority, new ShieldClient({ url: (u.shieldClient as any).cfg.url, privateKeyPem: keypair().privateKeyPem, issuer: ISS }));
  assert.equal((await admitTelephoneCall(req('call_shield006'), all, wrongKey, goodBridge(log))).code, 'JOIN_DENIED'); assert.ok(u.shield.log.some((x) => x.startsWith('auth-refused')));
  const g = new ShieldClient({ url: (u.shieldClient as any).cfg.url, privateKeyPem: kp.privateKeyPem, issuer: ISS, fetchImpl: (async () => new Response('<html>oops</html>', { status: 200 })) as typeof fetch });
  assert.deepEqual(await g.authorize(u.meet.uuid, crypto.randomUUID(), 'admitted'), { allow: false, reason: 'SHIELD_REFUSED' }); assert.equal(await g.recheck([{ meetingId: u.meet.uuid, participantId: crypto.randomUUID() }]), null);
  assert.deepEqual(log, []); await u.close();
});
test('Shield: waiting or denied admission states are never allowed through the client', async () => {
  const t = await setup(); for (const adm of ['waiting', 'denied'] as const) assert.equal((await t.shieldClient.authorize(t.meet.uuid, crypto.randomUUID(), adm)).allow, false, adm); await t.close();
});
test('Shield re-check: a meeting that ended revokes the call - media, meeting and ledger are all ended; an unreachable Shield ends calls only after the grace period', async () => {
  const t = await setup(); const log: string[] = [], ended: string[] = [], bridge = goodBridge(log);
  const r = await admitTelephoneCall(req('call_guard0001'), all, t.shielded, bridge); assert.equal(r.code, 'MEDIA_CONNECTED'); const callRef = [...t.meet.calls.keys()][0];
  const open = [{ callId: 'call_guard0001', meetingSessionId: sessionId(t.meet.uuid, callRef) }]; let now = 1_000_000;
  const terminate = async (c: typeof open[0], why: string) => { ended.push(c.callId + ':' + why); await terminateCall({ bridge, authority: t.authority })(c, why); };
  const guard = startPhoneSessionGuard({ shield: t.shieldClient, listOpen: async () => open, terminate, intervalMs: 3_600_000, graceMs: 60_000, now: () => now });
  await guard.tick(); assert.deepEqual(ended, [], 'healthy: nothing revoked');
  t.shield.state.unreachable = true; now += 30_000; await guard.tick(); assert.deepEqual(ended, [], 'unreachable but inside the grace period'); now += 61_000; await guard.tick(); assert.deepEqual(ended, ['call_guard0001:SHIELD_UNAVAILABLE'], 'past the grace period: fail closed');
  t.shield.state.unreachable = false; ended.length = 0; now += 1000; t.shield.state.revoke.set(callRef, 'MEETING_ENDED'); await guard.tick(); assert.deepEqual(ended, ['call_guard0001:MEETING_ENDED']);
  assert.ok(log.includes('disconnect:call_guard0001')); assert.equal(t.meet.calls.get(callRef)!.status, 'ended'); guard.stop(); await t.close();
});
test('terminateCall: media first, then Meet, then the record; a bridge that cannot disconnect leaves the call orphaned and says so', async () => {
  const order: string[] = []; const ledger = { claim: async () => true, release: async () => {}, transition: async (_id: string, to: string) => { order.push('ledger:' + to); return true; } };
  const authority = { verifyPhoneJoin: async () => ({ allowed: false, requiresHostApproval: false }), requestHostApproval: async () => false, cancelAdmission: async () => { order.push('meet'); } };
  await terminateCall({ bridge: { attach: async () => ({ mediaEstablished: true }), disconnect: async () => { order.push('media'); } }, authority, ledger })({ callId: 'c1', meetingSessionId: 's' }, 'why'); assert.deepEqual(order, ['ledger:terminating', 'media', 'meet', 'ledger:ended']);
  order.length = 0; await assert.rejects(terminateCall({ bridge: { attach: async () => ({ mediaEstablished: true }), disconnect: async () => { throw new Error('down'); } }, authority, ledger })({ callId: 'c2', meetingSessionId: 's' }, 'why')); assert.deepEqual(order, ['ledger:terminating', 'meet', 'ledger:orphaned']);
});

// ---------------------------------------------------------------- everything together, over HTTP, with real PostgreSQL and Redis when available
const DB = process.env.PHONE_JOIN_TEST_DATABASE_URL, REDIS = process.env.PHONE_JOIN_TEST_REDIS_URL;
test('FULL PIPELINE over HTTP: signed gateway token + body hash, Redis limit, PostgreSQL ledger, Meet, Shield and verified media', { skip: DB && REDIS ? false : 'PHONE_JOIN_TEST_DATABASE_URL and PHONE_JOIN_TEST_REDIS_URL are required' }, async () => {
  const schema = 'pj_e2e_' + Math.random().toString(36).slice(2, 8), admin = new pg.Pool({ connectionString: DB }); await admin.query('CREATE SCHEMA ' + schema);
  const c0 = await admin.connect(); try { await c0.query('SET search_path=' + schema); await c0.query(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'sql', '001_phone_join.sql'), 'utf8')); } finally { c0.release(); }
  const pool = new pg.Pool({ connectionString: DB, options: '-c search_path=' + schema }), redis = new Redis(REDIS!), prefix = 'pje2e:' + Math.random().toString(36).slice(2, 8);
  const t = await setup({ waitingRoom: false }); const gw: MediaGateway = { start: async () => ({ state: 'audio_flowing', inboundPackets: 200, outboundPackets: 200, observedMs: 4000, codec: 'opus', encrypted: true, measuredAt: Date.now() }), stop: async () => {}, onEnded: () => {} };
  const auth = gatewayAuth({ keys: { [ISS]: { w1: kp.publicKeyPem } }, subjects: ['svc:phone-gateway'], replay: new PostgresReplayStore(pool) });
  const limit = createRedisRateLimiter({ redis: redis as unknown as RedisLike, windowMs: 60_000, max: 4, prefix, keyOf: (r) => (r as any).gateway?.issuer ?? null });
  const ledger = new PostgresCallLedger(pool, 'gw-e2e'), a = express();
  a.use('/api/v1/phone-join', createPhoneJoinRouter({ readiness: async () => all, authority: t.shielded, bridge: verifiedBridge(gw), authenticateGateway: auth.authenticateGateway, verifyWebhook: auth.verifyWebhook, rateLimit: limit, admission: { ledger } }));
  const srv = await listen(a);
  const post = (body: object, tokenOver: object = {}) => { const raw = JSON.stringify(body); return fetch(srv.url + '/api/v1/phone-join/inbound/admit', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signGatewayToken({ privateKeyPem: kp.privateKeyPem, issuer: ISS, subject: 'svc:phone-gateway', body: raw, ...tokenOver }) }, body: raw }); };
  try {
    assert.equal((await fetch(srv.url + '/api/v1/phone-join/inbound/admit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, 'no token');
    const ok = await post(req('call_e2e00001')); assert.equal(ok.status, 200); assert.equal(((await ok.json()) as any).code, 'MEDIA_CONNECTED');
    assert.equal(await ledger.stateOf('call_e2e00001'), 'connected'); assert.equal((await ledger.listConnected()).length, 1);
    const dup = await post(req('call_e2e00001')); assert.equal(dup.status, 409);
    const bad = await post(req('call_e2e00002', { passcode: '00000000' })); assert.equal(bad.status, 403); assert.equal(await ledger.stateOf('call_e2e00002'), null);
    const limited = [await post(req('call_e2e00003')), await post(req('call_e2e00004'))]; assert.deepEqual(limited.map((r) => r.status), [200, 429], 'the fifth request in the window is limited (4 allowed: 3 above + this one)');
    const hist = (await admin.query(`SELECT to_state FROM ${schema}.phone_join_call_events WHERE call_id='call_e2e00001' ORDER BY id`)).rows.map((r) => r.to_state); assert.deepEqual(hist, ['claimed', 'authorizing', 'attaching', 'connected']);
  } finally { await srv.close(); await t.close(); await redis.quit(); await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); }
});
test('FULL PIPELINE: with every readiness condition not met, nothing is called - not Meet, not the Shield, not the ledger', async () => {
  const t = await setup(); const touched: string[] = []; const ledger = { claim: async () => { touched.push('ledger'); return true; }, release: async () => {} };
  const r = await admitTelephoneCall(req('call_notready1'), { ...all, billingCertified: false }, t.shielded, goodBridge(touched), { ledger }); assert.equal(r.code, 'PHONE_JOIN_UNAVAILABLE'); assert.deepEqual(touched, []); assert.deepEqual(t.meet.log, []); assert.deepEqual(t.shield.log, []); await t.close(); void memoryReplay;
});
test.after(closeAllServers);
