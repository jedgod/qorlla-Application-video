import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import express from 'express';
import { Redis } from 'ioredis';
import { admitTelephoneCall, type Readiness, type SipRtpBridge } from '../src/admission.js';
import { MeetPhoneAuthority, signMeetRequest, parseSession, sessionId, type MeetAuth } from '../src/meet-authority.js';
import { meetConfirmedBridge, startMediaKeepAlive } from '../src/meet-media.js';
import { MeetReadiness, MeetDirectoryClient } from '../src/readiness-meet.js';
import { ShieldClient, ShieldedAuthority, startPhoneSessionGuard } from '../src/shield.js';
import { gatewayAuth, signGatewayToken } from '../src/gateway-auth.js';
import { createRedisRateLimiter, type RedisLike } from '../src/rate-limit-redis.js';
import { type AudioEvidence, type MediaGateway } from '../src/media-contract.js';
import { PostgresCallLedger, PostgresReplayStore } from '../src/ledger-pg.js';
import { createPhoneJoinRouter } from '../src/server.js';
import { terminateCall } from '../src/compose.js';
import { closeAllServers, eventually, fakeMeet, fakeShield, keypair, listen, sleep, WEBHOOK_SECRET, BRIDGE_SECRET } from './support.js';

const all: Readiness = { carrierConnected: true, inboundNumberCertified: true, gatewayHealthy: true, mediaBridgeCertified: true, billingCertified: true, productionApproved: true };
const FROM = '+12025550143', req = (callId: string, over: object = {}) => ({ meetingId: '12345678901', passcode: '12345678', callId, dialedNumber: '+12025550100', callerNumber: FROM, ...over });
const kp = keypair(), ISS = 'qorlla-gateway';
const evidence = (over: Partial<AudioEvidence> = {}): AudioEvidence => ({ state: 'audio_flowing', inboundPackets: 120, outboundPackets: 118, observedMs: 2400, codec: 'opus', encrypted: true, measuredAt: Date.now(), ...over });
/** A media gateway that reports whatever evidence the test gives it (never touched by Meet itself: Meet judges what it is sent). */
const gateway = (ev: () => AudioEvidence | Promise<AudioEvidence> = () => evidence(), log: string[] = []): MediaGateway => ({ start: async (id) => { log.push('start:' + id); return ev(); }, stop: async (id, why) => { log.push('stop:' + id + ':' + why); }, onEnded: () => {} });
const workload: MeetAuth = { kind: 'workload', privateKeyPem: kp.privateKeyPem, issuer: ISS, subject: 'svc:phone-gateway' }, hmac: MeetAuth = { kind: 'hmac', secret: WEBHOOK_SECRET };

async function setup(meetOver: Parameters<typeof fakeMeet>[0] = {}, auth: MeetAuth = workload, cfg: object = {}) {
  const meet = fakeMeet({ gatewayKey: kp.publicKeyPem, ...meetOver }), shield = fakeShield(kp.publicKeyPem, ISS); shield.known.set(meet.uuid, { guestEnabled: true, ended: false });
  const m = await listen(meet.app), s = await listen(shield.app);
  const authority = new MeetPhoneAuthority({ baseUrl: m.url, auth, decisionWaitMs: 300, pollMs: 20, ...cfg }), shieldClient = new ShieldClient({ url: s.url, privateKeyPem: kp.privateKeyPem, issuer: ISS });
  const bridgeFor = (gw: MediaGateway = gateway()) => meetConfirmedBridge({ gateway: gw, meet: authority });
  return { meet, shield, authority, shieldClient, bridgeFor, baseUrl: m.url, shielded: new ShieldedAuthority(authority, shieldClient), close: async () => { await m.close(); await s.close(); } };
}

// ---------------------------------------------------------------- Meet's signature and session ids
test('the provider signature matches the known answer produced by Meet\'s real createProvider().sign', () => {
  const raw = '{"eventId":"evt_00000001","callId":"call_12345678","from":"+12025550100","meetingId":"12345678901","pin":"12345678"}';
  assert.equal(signMeetRequest(raw, 'known-answer-secret-0123456789', 1700000000), 't=1700000000,v1=ef6a0082f0654dee36f7560423109389ced04ab5c3c52cf3e821c3812992f280');
});
test('session ids carry both the meeting and the call in Meet, and nothing else is accepted', () => {
  const a = crypto.randomUUID(), b = crypto.randomUUID(); assert.deepEqual(parseSession(sessionId(a, b)), { meetingUuid: a, callRef: b });
  for (const bad of ['', 'x', a, a + '.nope', a + '.' + b + '.x', '../' + a, a.toUpperCase().slice(0, 20)]) assert.equal(parseSession(bad), null, bad);
});
test('configuration is validated at construction', () => {
  assert.throws(() => new MeetPhoneAuthority({ baseUrl: 'ftp://x', auth: hmac })); assert.throws(() => new MeetPhoneAuthority({ baseUrl: 'http://m', auth: { kind: 'hmac', secret: 'short' } }));
  assert.throws(() => new MeetPhoneAuthority({ baseUrl: 'http://m', auth: { kind: 'workload', privateKeyPem: '', issuer: 'i', subject: 's' } }));
  assert.throws(() => new MeetReadiness({ baseUrl: 'nope', auth: { privateKeyPem: 'k', issuer: 'i', subject: 's' } })); assert.throws(() => new MeetDirectoryClient({ baseUrl: 'http://m', bridgeSecret: 'short' }));
});

// ---------------------------------------------------------------- a PIN is not a connection: the whole point of the lifecycle
for (const [label, auth] of [['workload identity', workload], ['provider hmac', hmac]] as const) {
  test(`Meet (${label}): PIN -> approved, then verified media confirmed BY MEET -> MEDIA_CONNECTED; before that nothing is connected`, async () => {
    const t = await setup({}, auth), log: string[] = []; const states: string[] = [];
    const bridge = meetConfirmedBridge({ gateway: gateway(() => { states.push([...t.meet.calls.values()][0].state); return evidence(); }, log), meet: t.authority });
    const r = await admitTelephoneCall(req('call_00000001'), all, t.authority, bridge); assert.equal(r.code, 'MEDIA_CONNECTED');
    assert.deepEqual(states, ['APPROVED'], 'when the gateway started its media, Meet had only APPROVED the caller'); assert.equal([...t.meet.calls.values()][0].state, 'MEDIA_CONNECTED');
    assert.equal(t.meet.reports.length, 1); assert.equal(t.meet.reports[0].evidence.source, 'rtp'); assert.ok(t.meet.reports[0].mediaToken); await t.close();
  });
}
test('Meet answers `connected` at the PIN step (a Meet without the lifecycle): never trusted, the caller is hung up in Meet, 503', async () => {
  const t = await setup(); t.meet.state.legacyConnected = true; const log: string[] = [];
  const r = await admitTelephoneCall(req('call_00000002'), all, t.authority, t.bridgeFor(gateway(undefined, log))); assert.equal(r.code, 'MEETING_SERVICE_UNAVAILABLE'); assert.deepEqual(log, []); assert.ok(t.meet.log.includes('disconnect:call_00000002')); await t.close();
});
test('verified locally but Meet does not accept the audio (Meet judges for itself): not connected, torn down, 503', async () => {
  const t = await setup(); t.meet.state.terminateMedia = true; const log: string[] = [];
  const r = await admitTelephoneCall(req('call_00000003'), all, t.authority, t.bridgeFor(gateway(undefined, log))); assert.equal(r.code, 'MEDIA_UNAVAILABLE'); assert.ok(log.includes('stop:call_00000003:admission_disconnect')); await t.close();
});
test('weak or missing evidence never reaches "connected": the gateway refuses it locally and Meet is not even asked; no media token means nothing can be reported', async () => {
  const t = await setup(); const log: string[] = [];
  for (const ev of [evidence({ inboundPackets: 0 }), evidence({ outboundPackets: 0 }), evidence({ encrypted: false }), evidence({ state: 'ice_connected' }), evidence({ codec: 'g729' }), evidence({ measuredAt: Date.now() - 60000 }), evidence({ observedMs: 10 })]) {
    const r = await admitTelephoneCall(req('call_weak_' + crypto.randomBytes(3).toString('hex')), all, t.authority, t.bridgeFor(gateway(() => ev, log))); assert.equal(r.code, 'MEDIA_UNAVAILABLE');
  }
  assert.equal(t.meet.reports.length, 0, 'nothing weak was ever sent to Meet');
  const noToken: SipRtpBridge = meetConfirmedBridge({ gateway: gateway(), meet: t.authority }); assert.deepEqual(await noToken.attach('call_notoken_1', sessionId(t.meet.uuid, crypto.randomUUID()), { signal: new AbortController().signal }), { mediaEstablished: false }); await t.close();
});
test('Meet\'s own judgement catches what a faulty gateway sends (it re-evaluates the raw evidence): one-way audio from a gateway whose local check was bypassed is not connected', async () => {
  const t = await setup(); const a = await t.authority.verifyPhoneJoin('12345678901', '12345678', { signal: new AbortController().signal, callId: 'call_00000009', dialedNumber: '+12025550100', callerNumber: FROM });
  const reply = await t.authority.reportMedia('call_00000009', a.mediaToken!, evidence({ outboundPackets: 0 })); assert.equal(reply.result, 'connecting'); assert.equal([...t.meet.calls.values()][0].state, 'MEDIA_CONNECTING'); await t.close();
});
test('wrong PIN, wrong meeting, malformed PIN, no caller number, over-long call id: refused without attaching media', async () => {
  const t = await setup(); const log: string[] = [];
  for (const [why, over] of [['wrong pin', { passcode: '87654321' }], ['wrong meeting', { meetingId: '10987654321' }], ['letters in the PIN', { passcode: 'abcd1234' }], ['PIN too short', { passcode: '123' }], ['short meeting number', { meetingId: 'ABC12345' }], ['no caller number', { callerNumber: undefined }], ['call id too long for Meet', { callId: 'call_' + 'x'.repeat(116) }]] as [string, object][]) {
    const r = await admitTelephoneCall(req('call_' + Math.random().toString(36).slice(2, 10), over), all, t.authority, t.bridgeFor(gateway(undefined, log))); assert.notEqual(r.status, 200, why); assert.ok(['JOIN_DENIED', 'INVALID_JOIN_REQUEST'].includes(r.code), why + ' -> ' + r.code);
  }
  assert.deepEqual(log, []); await t.close();
});
test('Meet unavailable, telephony disabled in Meet, bad credentials, unreachable: 503 / refusal, never an admission', async () => {
  const log: string[] = []; const t = await setup(); t.meet.state.telephonyEnabled = false; assert.equal((await admitTelephoneCall(req('call_00000004'), all, t.authority, t.bridgeFor(gateway(undefined, log)))).code, 'MEETING_SERVICE_UNAVAILABLE'); await t.close();
  const u = await setup({}, { kind: 'hmac', secret: 'a-different-webhook-secret-123456' }); assert.equal((await admitTelephoneCall(req('call_00000005'), all, u.authority, u.bridgeFor(gateway(undefined, log)))).code, 'MEETING_SERVICE_UNAVAILABLE'); assert.ok(u.meet.log.includes('bad-auth'));
  const wrongKey = new MeetPhoneAuthority({ baseUrl: u.baseUrl, auth: { ...workload, privateKeyPem: keypair().privateKeyPem } as MeetAuth }); assert.equal((await admitTelephoneCall(req('call_00000006'), all, wrongKey, u.bridgeFor())).code, 'MEETING_SERVICE_UNAVAILABLE'); await u.close();
  const down = new MeetPhoneAuthority({ baseUrl: 'http://127.0.0.1:1', auth: hmac, requestTimeoutMs: 300 }); assert.equal((await admitTelephoneCall(req('call_00000007'), all, down, meetConfirmedBridge({ gateway: gateway(), meet: down }))).code, 'MEETING_SERVICE_UNAVAILABLE'); assert.deepEqual(log, []);
});

// ---------------------------------------------------------------- host approval: durable, bounded, explicit
for (const [label, auth] of [['workload long-poll', workload], ['hmac status polling', hmac]] as const) {
  test(`waiting room (${label}): the host approves -> the media token arrives with the decision -> verified media -> MEDIA_CONNECTED`, async () => {
    const t = await setup({ waitingRoom: true }, auth); const log: string[] = [], id = 'call_host_ok_01';
    const p = admitTelephoneCall(req(id), all, t.authority, t.bridgeFor(gateway(undefined, log)), { hostApprovalTimeoutMs: 5000 });
    assert.ok(await eventually(() => t.meet.calls.size === 1 && (t.meet.log.includes('decision-poll') || auth.kind === 'hmac'))); assert.deepEqual(log, [], 'no media while the caller waits'); t.meet.host(id, 'APPROVED');
    assert.equal((await p).code, 'MEDIA_CONNECTED'); assert.equal([...t.meet.calls.values()][0].state, 'MEDIA_CONNECTED'); assert.deepEqual((log as unknown as string[]).filter((x) => x.startsWith('start:')), ['start:' + id]); await t.close();
  });
}
test('waiting room: refused / timed out by Meet -> refused, no media, and nothing is left waiting in Meet', async () => {
  for (const [to, code] of [['REFUSED', 'HOST_APPROVAL_DENIED'], ['TIMED_OUT', 'HOST_APPROVAL_DENIED']] as const) {
    const t = await setup({ waitingRoom: true }); const log: string[] = [], id = 'call_host_no_' + to; const p = admitTelephoneCall(req(id), all, t.authority, t.bridgeFor(gateway(undefined, log)), { hostApprovalTimeoutMs: 5000 });
    assert.ok(await eventually(() => t.meet.calls.size === 1)); t.meet.host(id, to); assert.equal((await p).code, code); assert.deepEqual(log, []); await t.close();
  }
});
test('waiting room: a host who never answers - the admission stops waiting, the long-poll is aborted (not left running), the caller is ended in Meet', async () => {
  const t = await setup({ waitingRoom: true }, workload, { decisionWaitMs: 15000 }); const id = 'call_silent_01';
  const r = await admitTelephoneCall(req(id), all, t.authority, t.bridgeFor(), { hostApprovalTimeoutMs: 250 }); assert.equal(r.code, 'HOST_APPROVAL_TIMEOUT');
  assert.ok(await eventually(() => t.meet.state.openLongPolls === 0), 'the abandoned long-poll was cancelled'); assert.ok(t.meet.log.includes('decision-poll-aborted')); assert.equal([...t.meet.calls.values()][0].state, 'CANCELLED'); assert.ok(t.meet.log.includes('disconnect:' + id)); await t.close();
});
test('Meet admits but does not identify the meeting: the caller is ended in Meet and the admission fails closed', async () => {
  const t = await setup(); t.meet.state.omitMeetingId = true; const r = await admitTelephoneCall(req('call_nomid_01'), all, t.authority, t.bridgeFor()); assert.equal(r.code, 'MEETING_SERVICE_UNAVAILABLE'); assert.ok(t.meet.log.includes('disconnect:call_nomid_01')); await t.close();
});
test('the same call id twice (a replayed webhook) is refused by the ledger before Meet is asked again', async () => {
  const t = await setup(); const seen = new Set<string>(), ledger = { claim: async (id: string) => (seen.has(id) ? false : (seen.add(id), true)), release: async () => {} };
  assert.equal((await admitTelephoneCall(req('call_dup00001'), all, t.authority, t.bridgeFor(), { ledger })).code, 'MEDIA_CONNECTED'); const before = t.meet.log.length;
  assert.equal((await admitTelephoneCall(req('call_dup00001'), all, t.authority, t.bridgeFor(), { ledger })).code, 'DUPLICATE_CALL'); assert.equal(t.meet.log.length, before); await t.close();
});

// ---------------------------------------------------------------- keeping calls proven
test('keep-alive: live calls are re-measured and re-reported; a call Meet no longer accepts, or tells to terminate, is torn down at once', async () => {
  const t = await setup(); const log: string[] = [], bridge = meetConfirmedBridge({ gateway: gateway(undefined, log), meet: t.authority }), ended: string[] = [];
  assert.equal((await admitTelephoneCall(req('call_keep_0001'), all, t.authority, bridge)).code, 'MEDIA_CONNECTED'); assert.equal(bridge.legs.size, 1);
  const ka = startMediaKeepAlive({ legs: bridge.legs, measure: async () => evidence(), meet: t.authority, terminate: async (id, why) => { ended.push(id + ':' + why); await bridge.disconnect(id); }, intervalMs: 3_600_000, log: { error() {} } });
  await ka.tick(); assert.equal(t.meet.reports.length, 2); assert.deepEqual(ended, []);
  await ka.tick(); t.meet.host('call_keep_0001', 'REFUSED'); await ka.tick(); assert.deepEqual(ended, ['call_keep_0001:meet_terminated']); assert.equal(bridge.legs.size, 0); assert.ok(log.includes('stop:call_keep_0001:admission_disconnect'));
  await ka.tick(); assert.equal(ended.length, 1, 'nothing left to report'); ka.stop(); await t.close();
});
test('keep-alive: evidence that fails (silence, one-way) or a leg that cannot be measured is reported as it is, and Meet\'s answer decides', async () => {
  const t = await setup(); const bridge = meetConfirmedBridge({ gateway: gateway(), meet: t.authority }), ended: string[] = []; await admitTelephoneCall(req('call_keep_0002'), all, t.authority, bridge);
  const ka = startMediaKeepAlive({ legs: bridge.legs, measure: async () => evidence({ outboundPackets: 0 }), meet: t.authority, terminate: async (id, why) => { ended.push(id + ':' + why); bridge.legs.delete(id); }, intervalMs: 3_600_000, log: { error() {} } });
  await ka.tick(); assert.deepEqual(ended, ['call_keep_0002:meet_not_connected']); ka.stop(); await t.close();
});
test('keep-alive: Meet unreachable - the leg stays and the error is logged (Meet\'s own stale-media sweeper ends the call if reports do not resume)', async () => {
  const t = await setup(); const bridge = meetConfirmedBridge({ gateway: gateway(), meet: t.authority }), errors: string[] = []; await admitTelephoneCall(req('call_keep_0003'), all, t.authority, bridge);
  const dead = new MeetPhoneAuthority({ baseUrl: 'http://127.0.0.1:1', auth: workload, requestTimeoutMs: 200 }); const ka = startMediaKeepAlive({ legs: bridge.legs, measure: async () => evidence(), meet: dead, terminate: async () => { throw new Error('must not terminate'); }, intervalMs: 3_600_000, log: { error: (m) => errors.push(String(m)) } });
  await ka.tick(); assert.equal(bridge.legs.size, 1); assert.equal(errors.length, 1); ka.stop(); await t.close();
});

// ---------------------------------------------------------------- readiness from the authoritative service
async function readinessServer(answer: () => { status?: number; body?: unknown; delayMs?: number; raw?: string }) {
  const app = express(); const seen = { auth: '' as string, hits: 0 };
  app.get('/api/phone/ivr/readiness', async (req, res) => { seen.hits++; seen.auth = String(req.get('authorization') || ''); const a = answer(); if (a.delayMs) await sleep(a.delayMs); res.status(a.status ?? 200); if (a.raw !== undefined) return void res.type('application/json').send(a.raw); res.json(a.body); });
  const s = await listen(app); return { ...s, seen };
}
const mkReadiness = (url: string, o: object = {}) => new MeetReadiness({ baseUrl: url, auth: { privateKeyPem: kp.privateKeyPem, issuer: ISS, subject: 'svc:phone-gateway' }, cacheMs: 0, ...o });
test('readiness: exactly what Meet says, nothing more - only boolean true counts, and the request is a gateway-audience token', async () => {
  let body: unknown = { readiness: all, generatedAt: new Date().toISOString(), maxAgeMs: 5000 }; const s = await readinessServer(() => ({ body }));
  const r = mkReadiness(s.url); assert.deepEqual(await r.get(), all); const tok = s.seen.auth.replace('Bearer ', '').split('.'); const claims = JSON.parse(Buffer.from(tok[1], 'base64url').toString()); assert.equal(claims.aud, 'qorlla-phone-gateway'); assert.equal(claims.sub, 'svc:phone-gateway');
  body = { readiness: { ...all, billingCertified: 'true', productionApproved: 1, gatewayHealthy: false }, generatedAt: new Date().toISOString() }; const v = await r.get(); assert.equal(v.billingCertified, false); assert.equal(v.productionApproved, false); assert.equal(v.gatewayHealthy, false); assert.equal(v.carrierConnected, true);
  body = { readiness: { carrierConnected: true }, generatedAt: new Date().toISOString() }; assert.equal(Object.values(await r.get()).filter(Boolean).length, 1, 'missing flags are false'); await s.close();
});
test('readiness FAILS CLOSED: errors, timeouts, malformed, stale, from the future, wrong shape - all six false, never thrown', async () => {
  const none = { carrierConnected: false, inboundNumberCertified: false, gatewayHealthy: false, mediaBridgeCertified: false, billingCertified: false, productionApproved: false }, fresh = () => new Date().toISOString();
  const cases: [string, () => { status?: number; body?: unknown; raw?: string; delayMs?: number }][] = [['500', () => ({ status: 500, body: {} })], ['401', () => ({ status: 401, body: {} })], ['503', () => ({ status: 503, body: {} })], ['not json', () => ({ raw: '<html>' })], ['null', () => ({ raw: 'null' })],
    ['no readiness', () => ({ body: { generatedAt: fresh() } })], ['readiness is an array', () => ({ body: { readiness: [true, true, true, true, true, true], generatedAt: fresh() } })], ['no timestamp', () => ({ body: { readiness: all } })], ['stale', () => ({ body: { readiness: all, generatedAt: new Date(Date.now() - 600_000).toISOString() } })],
    ['from the future', () => ({ body: { readiness: all, generatedAt: new Date(Date.now() + 600_000).toISOString() } })], ['garbage timestamp', () => ({ body: { readiness: all, generatedAt: 'tomorrow' } })], ['server says its answer is short-lived', () => ({ body: { readiness: all, generatedAt: new Date(Date.now() - 3000).toISOString(), maxAgeMs: 1000 } })], ['slow', () => ({ body: { readiness: all, generatedAt: fresh() }, delayMs: 600 })]];
  for (const [why, a] of cases) { const s = await readinessServer(a), r = mkReadiness(s.url, { timeoutMs: 300 }); assert.deepEqual(await r.get(), none, why); assert.ok(r.lastError, why); await s.close(); }
  assert.deepEqual(await mkReadiness('http://127.0.0.1:1', { timeoutMs: 300 }).get(), none, 'unreachable');
});
test('readiness: a good answer is reused briefly, a failure is never cached, and it recovers the moment Meet does', async () => {
  let ok = true; const s = await readinessServer(() => (ok ? { body: { readiness: all, generatedAt: new Date().toISOString() } } : { status: 500, body: {} })); let t = Date.now(); const r = mkReadiness(s.url, { cacheMs: 1000, now: () => t });
  assert.equal((await r.get()).productionApproved, true); ok = false; assert.equal((await r.get()).productionApproved, true, 'inside the cache window'); t += 1500; assert.equal((await r.get()).productionApproved, false, 'after it, the failure is seen at once'); assert.equal(s.seen.hits, 2);
  ok = true; assert.equal((await r.get()).productionApproved, true, 'recovered'); await s.close();
});
test('readiness drives the router: not ready -> 503 and nothing else is called; ready -> the admission runs', async () => {
  let ready = false; const s = await readinessServer(() => ({ body: { readiness: ready ? all : { ...all, productionApproved: false }, generatedAt: new Date().toISOString() } })), t = await setup();
  const rd = mkReadiness(s.url), a = express(); const allow: express.RequestHandler = (_q, _r, n) => n(); a.use('/api/v1/phone-join', createPhoneJoinRouter({ readiness: () => rd.get(), authority: t.authority, bridge: t.bridgeFor(), authenticateGateway: allow, verifyWebhook: allow, rateLimit: allow })); const srv = await listen(a);
  const post = (id: string) => fetch(srv.url + '/api/v1/phone-join/inbound/admit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req(id)) });
  const no = await post('call_rd_0000001'); assert.equal(no.status, 503); assert.deepEqual(t.meet.log, [], 'Meet was not asked while telephony is not ready'); ready = true; const yes = await post('call_rd_0000002'); assert.equal(yes.status, 200); assert.equal(((await yes.json()) as any).code, 'MEDIA_CONNECTED'); await srv.close(); await s.close(); await t.close();
});
test('directory client: strict parsing, one meeting per number, errors are errors', async () => {
  const uuid = crypto.randomUUID(); let answer: { status: number; body: unknown } = { status: 200, body: { meetingId: uuid, sourceId: 'sched_1', locked: false, waitingRoom: true } }; const app = express(); app.get('/api/integrations/phone/meetings/:d', (rq, rs) => { if (rq.get('x-qorlla-bridge-secret') !== BRIDGE_SECRET) return void rs.status(401).json({}); rs.status(answer.status).json(answer.body); }); const s = await listen(app);
  const c = new MeetDirectoryClient({ baseUrl: s.url, bridgeSecret: BRIDGE_SECRET }); assert.deepEqual(await c.resolve('123 4567 8901'), { meetingId: uuid, sourceId: 'sched_1', locked: false, waitingRoom: true }); assert.equal(await c.resolve('123'), null);
  answer = { status: 200, body: { meetingId: uuid, sourceId: null } }; assert.equal((await c.resolve('12345678901'))!.sourceId, null, 'an instant meeting has no scheduled-meeting id'); answer = { status: 404, body: {} }; assert.equal(await c.resolve('12345678901'), null);
  for (const bad of [{ status: 409, body: {} }, { status: 500, body: {} }, { status: 200, body: { meetingId: 'not-a-uuid', sourceId: null } }, { status: 200, body: { meetingId: uuid, sourceId: '../x' } }, { status: 200, body: {} }]) { answer = bad; await assert.rejects(c.resolve('12345678901'), () => true, JSON.stringify(bad)); }
  await assert.rejects(new MeetDirectoryClient({ baseUrl: s.url, bridgeSecret: 'z'.repeat(40) }).resolve('12345678901')); await s.close();
});

// ---------------------------------------------------------------- Security Shield (defence in depth: Meet asks the Shield too, and so does the gateway)
test('Shield: allowed meeting - admitted; the Shield sees a guest with the call as participant, after approval where approval is needed', async () => {
  const t = await setup(); assert.equal((await admitTelephoneCall(req('call_shield001'), all, t.shielded, t.bridgeFor())).code, 'MEDIA_CONNECTED'); assert.deepEqual(t.shield.log, ['authorize:admitted']); await t.close();
  const w = await setup({ waitingRoom: true }); const p = admitTelephoneCall(req('call_shield002'), all, w.shielded, w.bridgeFor(), { hostApprovalTimeoutMs: 5000 }); assert.ok(await eventually(() => w.meet.log.includes('decision-poll'))); assert.deepEqual(w.shield.log, [], 'not consulted while the caller is only waiting');
  w.meet.host('call_shield002', 'APPROVED'); assert.equal((await p).code, 'MEDIA_CONNECTED'); assert.deepEqual(w.shield.log, ['authorize:admitted']); await w.close();
});
test('Shield: guests not allowed, or meeting ended - refused, the caller is removed from the meeting, and no media is attached', async () => {
  const t = await setup(); t.shield.known.get(t.meet.uuid)!.guestEnabled = false; const log: string[] = [];
  const r = await admitTelephoneCall(req('call_shield003'), all, t.shielded, t.bridgeFor(gateway(undefined, log))); assert.equal(r.code, 'JOIN_DENIED'); assert.deepEqual(log, []); assert.ok(t.meet.log.includes('disconnect:call_shield003')); await t.close();
  const e = await setup(); e.shield.known.get(e.meet.uuid)!.ended = true; assert.equal((await admitTelephoneCall(req('call_shield004'), all, e.shielded, e.bridgeFor(gateway(undefined, log)))).code, 'JOIN_DENIED'); assert.deepEqual(log, []); await e.close();
});
test('Shield: an unreachable Shield, a Shield that refuses our token, or a garbage answer is NEVER an admission', async () => {
  const t = await setup(); t.shield.state.unreachable = true; const log: string[] = [];
  assert.equal((await admitTelephoneCall(req('call_shield005'), all, t.shielded, t.bridgeFor(gateway(undefined, log)))).code, 'MEETING_SERVICE_UNAVAILABLE'); assert.ok(t.meet.log.includes('disconnect:call_shield005')); assert.deepEqual(log, []); await t.close();
  const u = await setup(); const wrongKey = new ShieldedAuthority(u.authority, new ShieldClient({ url: (u.shieldClient as any).cfg.url, privateKeyPem: keypair().privateKeyPem, issuer: ISS }));
  assert.equal((await admitTelephoneCall(req('call_shield006'), all, wrongKey, u.bridgeFor(gateway(undefined, log)))).code, 'JOIN_DENIED'); assert.ok(u.shield.log.some((x) => x.startsWith('auth-refused')));
  const g = new ShieldClient({ url: (u.shieldClient as any).cfg.url, privateKeyPem: kp.privateKeyPem, issuer: ISS, fetchImpl: (async () => new Response('<html>oops</html>', { status: 200 })) as typeof fetch });
  assert.deepEqual(await g.authorize(u.meet.uuid, crypto.randomUUID(), 'admitted'), { allow: false, reason: 'SHIELD_REFUSED' }); assert.equal(await g.recheck([{ meetingId: u.meet.uuid, participantId: crypto.randomUUID() }]), null); assert.deepEqual(log, []); await u.close();
});
test('Shield: waiting or denied admission states are never allowed through the client', async () => {
  const t = await setup(); for (const adm of ['waiting', 'denied'] as const) assert.equal((await t.shieldClient.authorize(t.meet.uuid, crypto.randomUUID(), adm)).allow, false, adm); await t.close();
});
test('Shield re-check: a revoked call is ended everywhere (media, Meet, ledger); an unreachable Shield ends calls only after the grace period', async () => {
  const t = await setup(); const log: string[] = [], ended: string[] = [], bridge = meetConfirmedBridge({ gateway: gateway(undefined, log), meet: t.authority });
  assert.equal((await admitTelephoneCall(req('call_guard0001'), all, t.shielded, bridge)).code, 'MEDIA_CONNECTED'); const callRef = [...t.meet.calls.keys()][0];
  const open = [{ callId: 'call_guard0001', meetingSessionId: sessionId(t.meet.uuid, callRef) }]; let now = 1_000_000;
  const terminate = async (c: typeof open[0], why: string) => { ended.push(c.callId + ':' + why); await terminateCall({ bridge, authority: t.authority })(c, why); };
  const guard = startPhoneSessionGuard({ shield: t.shieldClient, listOpen: async () => open, terminate, intervalMs: 3_600_000, graceMs: 60_000, now: () => now });
  await guard.tick(); assert.deepEqual(ended, []); t.shield.state.unreachable = true; now += 30_000; await guard.tick(); assert.deepEqual(ended, []); now += 61_000; await guard.tick(); assert.deepEqual(ended, ['call_guard0001:SHIELD_UNAVAILABLE']);
  t.shield.state.unreachable = false; ended.length = 0; now += 1000; t.shield.state.revoke.set(callRef, 'MEETING_ENDED'); await guard.tick(); assert.deepEqual(ended, ['call_guard0001:MEETING_ENDED']);
  assert.ok(log.includes('stop:call_guard0001:admission_disconnect')); assert.ok(t.meet.log.includes('disconnect:call_guard0001')); guard.stop(); await t.close();
});
test('terminateCall: media first, then Meet, then the record; a bridge that cannot disconnect leaves the call orphaned and says so', async () => {
  const order: string[] = []; const ledger = { claim: async () => true, release: async () => {}, transition: async (_id: string, to: string) => { order.push('ledger:' + to); return true; } };
  const authority = { verifyPhoneJoin: async () => ({ allowed: false, requiresHostApproval: false }), requestHostApproval: async () => false, cancelAdmission: async () => { order.push('meet'); } };
  await terminateCall({ bridge: { attach: async () => ({ mediaEstablished: true }), disconnect: async () => { order.push('media'); } }, authority, ledger })({ callId: 'c1', meetingSessionId: 's' }, 'why'); assert.deepEqual(order, ['ledger:terminating', 'media', 'meet', 'ledger:ended']);
  order.length = 0; await assert.rejects(terminateCall({ bridge: { attach: async () => ({ mediaEstablished: true }), disconnect: async () => { throw new Error('down'); } }, authority, ledger })({ callId: 'c2', meetingSessionId: 's' }, 'why')); assert.deepEqual(order, ['ledger:terminating', 'meet', 'ledger:orphaned']);
});

// ---------------------------------------------------------------- everything together, over HTTP, with real PostgreSQL and Redis when available
const DB = process.env.PHONE_JOIN_TEST_DATABASE_URL, REDIS = process.env.PHONE_JOIN_TEST_REDIS_URL;
test('FULL PIPELINE over HTTP: signed gateway token + body hash, Redis limit, PostgreSQL ledger, Meet (lifecycle), Shield, verified media confirmed by Meet', { skip: DB && REDIS ? false : 'PHONE_JOIN_TEST_DATABASE_URL and PHONE_JOIN_TEST_REDIS_URL are required' }, async () => {
  const schema = 'pj_e2e_' + Math.random().toString(36).slice(2, 8), admin = new pg.Pool({ connectionString: DB }); await admin.query('CREATE SCHEMA ' + schema);
  const c0 = await admin.connect(); try { await c0.query('SET search_path=' + schema); await c0.query(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'sql', '001_phone_join.sql'), 'utf8')); } finally { c0.release(); }
  const pool = new pg.Pool({ connectionString: DB, options: '-c search_path=' + schema }), redis = new Redis(REDIS!), prefix = 'pje2e:' + Math.random().toString(36).slice(2, 8);
  const t = await setup(); const auth = gatewayAuth({ keys: { [ISS]: { w1: kp.publicKeyPem } }, subjects: ['svc:phone-gateway'], replay: new PostgresReplayStore(pool) });
  const limit = createRedisRateLimiter({ redis: redis as unknown as RedisLike, windowMs: 60_000, max: 4, prefix, keyOf: (r) => (r as any).gateway?.issuer ?? null });
  const ledger = new PostgresCallLedger(pool, 'gw-e2e'), a = express(); a.use('/api/v1/phone-join', createPhoneJoinRouter({ readiness: async () => all, authority: t.shielded, bridge: t.bridgeFor(), authenticateGateway: auth.authenticateGateway, verifyWebhook: auth.verifyWebhook, rateLimit: limit, admission: { ledger } }));
  const srv = await listen(a);
  const post = (body: object, tokenOver: object = {}) => { const raw = JSON.stringify(body); return fetch(srv.url + '/api/v1/phone-join/inbound/admit', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signGatewayToken({ privateKeyPem: kp.privateKeyPem, issuer: ISS, subject: 'svc:phone-gateway', body: raw, ...tokenOver }) }, body: raw }); };
  try {
    assert.equal((await fetch(srv.url + '/api/v1/phone-join/inbound/admit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, 'no token');
    const ok = await post(req('call_e2e00001')); assert.equal(ok.status, 200); assert.equal(((await ok.json()) as any).code, 'MEDIA_CONNECTED');
    assert.equal(await ledger.stateOf('call_e2e00001'), 'connected'); assert.equal((await ledger.listConnected()).length, 1); assert.equal([...t.meet.calls.values()][0].state, 'MEDIA_CONNECTED', 'Meet and the gateway agree');
    assert.equal((await post(req('call_e2e00001'))).status, 409); const bad = await post(req('call_e2e00002', { passcode: '00000000' })); assert.equal(bad.status, 403); assert.equal(await ledger.stateOf('call_e2e00002'), null);
    assert.deepEqual([await post(req('call_e2e00003')), await post(req('call_e2e00004'))].map((r) => r.status), [200, 429], 'the fifth request in the window is limited');
    const hist = (await admin.query(`SELECT to_state FROM ${schema}.phone_join_call_events WHERE call_id='call_e2e00001' ORDER BY id`)).rows.map((r) => r.to_state); assert.deepEqual(hist, ['claimed', 'authorizing', 'attaching', 'connected']);
  } finally { await srv.close(); await t.close(); await redis.quit(); await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); }
});
test('FULL PIPELINE: with any readiness condition not met, nothing is called - not Meet, not the Shield, not the ledger', async () => {
  const t = await setup(); const touched: string[] = []; const ledger = { claim: async () => { touched.push('ledger'); return true; }, release: async () => {} };
  const r = await admitTelephoneCall(req('call_notready1'), { ...all, billingCertified: false }, t.shielded, t.bridgeFor(gateway(undefined, touched)), { ledger }); assert.equal(r.code, 'PHONE_JOIN_UNAVAILABLE'); assert.deepEqual(touched, []); assert.deepEqual(t.meet.log, []); assert.deepEqual(t.shield.log, []); await t.close();
});
test.after(closeAllServers);
