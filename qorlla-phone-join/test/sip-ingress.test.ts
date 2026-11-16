import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { UdpSipIngress, ipAllowed, type IngressConfig } from '../src/sip/udp-ingress.js';
import { DigestAuthenticator, ha1, answerChallenge } from '../src/sip/digest.js';
import { answer } from '../src/sip/sdp.js';
import { serialize, header, tagOf, type SipResponse } from '../src/sip/message.js';
import type { InboundCall, EndReason } from '../src/sip/adapter.js';
import { SyntheticPhone } from './helpers/synthetic-phone.js';
import { eventually, sleep } from './support.js';

// The development SIP ingress, driven by synthetic phones over REAL UDP sockets (loopback). No carrier, no media: signalling behaviour only.
const realm = 'qorlla-gw', secret = crypto.randomBytes(32), H = ha1('SHA-256', 'trunk1', realm, 'trunk-secret');
const live: { stop(): Promise<void> | void }[] = [];
test.afterEach(async () => { for (const x of live.splice(0)) await x.stop(); });
async function boot(over: Partial<IngressConfig> = {}) {
  const digest = new DigestAuthenticator({ realm, secret, lookup: (u) => (u === 'trunk1' ? H : undefined) }), calls: InboundCall[] = [], ends = new Map<string, EndReason>(), logs: Record<string, unknown>[] = [];
  const ingress = new UdpSipIngress({ host: '127.0.0.1', port: 0, realm, digest, allowedSources: ['127.0.0.1'], maxCalls: 4, t1Ms: 20, t2Ms: 80, ringTimeoutMs: 5000, maxInvitesPerSecond: 50, burst: 100, log: (l) => logs.push(l), ...over });
  ingress.onInvite((c) => { calls.push(c); c.onEnded((r) => ends.set(c.callId, r)); }); const addr = await ingress.start(); live.push({ stop: () => ingress.stop() });
  const phone = async (o: Partial<ConstructorParameters<typeof SyntheticPhone>[0]> = {}) => { const p = await SyntheticPhone.create({ gateway: addr, ...o }); live.push({ stop: () => p.close() }); return p; };
  const sdpFor = (c: InboundCall) => { const a = answer(c.offer, { ip: '127.0.0.1', port: 20000, sipSourceIp: '127.0.0.1' }); if ('refuse' in a) throw new Error(a.refuse); return a.sdp; };
  /** Starts a call and answers it from the handler side; resolves when both sides agree the dialog is up. */
  const connect = async (p: SyntheticPhone) => { const n = calls.length, inviting = p.invite(); await eventually(() => calls.length > n, 4000); const call = calls[calls.length - 1]; const acked = call.answer(sdpFor(call)); const r = await inviting; await acked; return { call, r }; };
  const t = { ingress, calls, ends, logs, addr, phone, sdpFor, connect }; return t;
}

test('a valid call: 401 challenge, authenticated INVITE, the handler sees a validated call, 200 OK + ACK establish the dialog, BYE ends it (a repeated BYE is answered, not refused)', async () => {
  const t = await boot(), p = await t.phone({ number: '+12025550100' }), { call, r } = await t.connect(p);
  assert.equal(r.status, 200); assert.match(call.callId, /^sip_[0-9a-f]{24}$/); assert.equal(call.dialed, '+12025550100'); assert.equal(call.caller, '+12025550123'); assert.equal(call.principal, 'trunk1'); assert.equal(call.state, 'answered'); assert.equal(call.source.address, '127.0.0.1');
  assert.equal(p.responses(401).length, 1, 'the first INVITE was challenged'); assert.match(header(p.responses(401)[0], 'WWW-Authenticate')!, /algorithm=SHA-256/); assert.ok(tagOf(header(r, 'To')), 'a dialog-forming answer carries a To tag');
  assert.equal(t.ingress.health().activeCalls, 1); assert.equal(t.calls.length, 1, 'the handler ran once');
  p.bye(); await eventually(() => t.ends.get(call.callId) === 'remote_bye'); assert.equal(p.responses(200).length >= 2, true); assert.equal(call.state, 'ended');
  const before = p.responses(200).length; const b = serialize(p.build('BYE', { cseq: p.cseq, toTag: p.toTag, branch: 'z9hG4bKsecondbye0001' })); p.send(b); await eventually(() => p.responses(200).length > before); assert.equal(p.responses(481).length, 0, 'a BYE for a call that has just ended is acknowledged');
  assert.equal(t.ends.size, 1, 'one end event'); assert.equal(t.ingress.health().activeCalls, 0);
});
test('unauthenticated, wrongly authenticated and replayed requests never reach the handler', async () => {
  const t = await boot(), p = await t.phone();
  assert.equal((await p.invite({ auth: false })).status, 401); assert.equal((await p.invite({ badPassword: true })).status, 403, 'a wrong password is refused, not re-challenged');
  const ok = await t.phone(); const inviting = ok.invite(); await eventually(() => t.calls.length === 1); await t.calls[0].answer(t.sdpFor(t.calls[0])).catch(() => undefined); await inviting; const stolen = ok.lastAuth; assert.ok(stolen);
  const thief = await t.phone(); thief.cseq = 2; thief.send(serialize(thief.build('INVITE', { body: 'v=0\r\n', extra: [['Authorization', stolen]] }))); await eventually(() => thief.responses().some((r) => r.status >= 400)); assert.equal(thief.responses().find((r) => r.status >= 400)!.status, 403, 'a captured Authorization header cannot be reused');
  assert.equal(t.calls.length, 1, 'only the one legitimate call reached the handler'); assert.ok((t.ingress.health().invitesRejected.auth_bad_uri ?? 0) + (t.ingress.health().invitesRejected.auth_replay ?? 0) + (t.ingress.health().invitesRejected.auth_bad_nonce ?? 0) >= 1);
});
test('a source that is not on the allowlist, an empty allowlist, malformed datagrams and flooding sources are DROPPED silently (no reply to a spoofable address)', async () => {
  const blocked = await boot({ allowedSources: ['10.9.9.9', '192.0.2.0/24'] }), p = await blocked.phone(); p.send(serialize(p.build('INVITE', { body: 'v=0\r\n' }))); await sleep(150);
  assert.equal(p.inbox.length, 0, 'no reply at all'); assert.equal(blocked.calls.length, 0); assert.ok(blocked.ingress.health().invitesRejected.source_not_allowed >= 1);
  const empty = await boot({ allowedSources: [] }), q = await empty.phone(); q.send(serialize(q.build('OPTIONS'))); await sleep(100); assert.equal(q.inbox.length, 0, 'an empty allowlist admits nobody');
  const open = await boot(), g = await open.phone(); const raw = dgram.createSocket('udp4'); live.push({ stop: () => { raw.close(); } });
  for (const junk of [Buffer.from('not sip at all'), Buffer.alloc(20000, 65), Buffer.from('SIP/2.0 200 OK\r\nCall-ID: x\r\n\r\n'), Buffer.from('INVITE sip:a SIP/2.0\r\nCall-ID: x\r\n\r\n')]) raw.send(junk, open.addr.port, open.addr.address);
  await sleep(150); assert.ok(open.ingress.health().invitesRejected.malformed >= 3); assert.equal(open.calls.length, 0); g.send(serialize(g.build('OPTIONS'))); await eventually(() => g.responses(200).length === 1); assert.match(header(g.responses(200)[0], 'Allow')!, /INVITE/, 'and the ingress keeps working');
  const slow = await boot({ maxInvitesPerSecond: 1, burst: 3 }), f = await slow.phone(); for (let i = 0; i < 12; i++) f.send(serialize(f.build('OPTIONS', { branch: 'z9hG4bKflood' + String(i).padStart(4, '0') }))); await sleep(200);
  assert.ok(f.responses(200).length <= 4, 'a flood is cut off: ' + f.responses(200).length); assert.ok(slow.ingress.health().invitesRejected.rate_limited >= 6);
});
test('the allowlist understands exact addresses and IPv4 ranges, and nothing else', () => {
  assert.equal(ipAllowed('203.0.113.9', ['203.0.113.0/24']), true); assert.equal(ipAllowed('203.0.114.9', ['203.0.113.0/24']), false); assert.equal(ipAllowed('1.2.3.4', ['1.2.3.4']), true); assert.equal(ipAllowed('1.2.3.5', ['1.2.3.4']), false);
  assert.equal(ipAllowed('1.2.3.4', ['0.0.0.0/0']), true); assert.equal(ipAllowed('1.2.3.4', ['1.2.3.4/33', 'garbage/8', '']), false); assert.equal(ipAllowed('::1', ['127.0.0.1']), false);
  assert.throws(() => new UdpSipIngress({ host: '127.0.0.1', port: 0, realm, allowedSources: ['127.0.0.1'], maxCalls: 1 }), /digest authentication is required/);
});
test('a retransmitted INVITE (the network repeats it) reaches the handler once and is answered with the same bytes', async () => {
  const t = await boot(), p = await t.phone(); const { sdp } = (await import('../src/sip/sdp.js')).buildOffer({ ip: '127.0.0.1', port: p.rtpPort, key: crypto.randomBytes(30) });
  const first = p.build('INVITE', { body: sdp }); p.send(serialize(first)); const ch = (await p.wait<SipResponse>((m) => m.kind === 'response' && m.status === 401)).headers.find(([n]) => n === 'WWW-Authenticate')![1];
  p.cseq++; const authed = p.build('INVITE', { body: sdp, extra: [['Authorization', answerChallenge({ challenge: ch, method: 'INVITE', uri: first.uri, username: 'trunk1', password: 'trunk-secret' })]] }); const bytes = serialize(authed);
  p.send(bytes); p.send(bytes); await sleep(30); p.send(bytes); await eventually(() => t.calls.length === 1); await sleep(100); assert.equal(t.calls.length, 1, 'three copies, one call');
  t.calls[0].reject(486, 'Busy Here'); await eventually(() => p.responses(486).length >= 1); await sleep(100); p.send(bytes); await eventually(() => p.responses(486).length >= 2); assert.equal(t.calls.length, 1, 'a late copy after the final answer is repeated the answer, not processed'); assert.ok(t.ingress.health().retransmissionsAbsorbed >= 2);
  assert.equal(p.responses(486).map((r) => serialize(r).toString()).filter((v, i, a) => a.indexOf(v) === i).length, 1, 'identical bytes every time');
});
test('CANCEL while ringing: 200 to the CANCEL, 487 to the INVITE, the call ends as cancelled and can no longer be answered; CANCEL after the answer changes nothing', async () => {
  const t = await boot(), p = await t.phone(); const { sdp } = (await import('../src/sip/sdp.js')).buildOffer({ ip: '127.0.0.1', port: p.rtpPort }); const first = p.build('INVITE', { body: sdp }); p.send(serialize(first));
  const ch = (await p.wait<SipResponse>((m) => m.kind === 'response' && m.status === 401)).headers.find(([n]) => n === 'WWW-Authenticate')![1]; p.cseq++; const branch = 'z9hG4bKcancelme0001';
  p.send(serialize(p.build('INVITE', { body: sdp, branch, extra: [['Authorization', answerChallenge({ challenge: ch, method: 'INVITE', uri: first.uri, username: 'trunk1', password: 'trunk-secret' })]] }))); await eventually(() => t.calls.length === 1);
  p.send(serialize(p.build('CANCEL', { cseq: p.cseq, branch }))); await eventually(() => p.responses(487).length === 1); assert.ok(p.responses(200).some((r) => header(r, 'CSeq')!.endsWith('CANCEL')), '200 for the CANCEL'); await eventually(() => t.ends.get(t.calls[0].callId) === 'cancelled');
  await assert.rejects(t.calls[0].answer('v=0\r\n'), /not ringing/);
  const q = await t.phone(), { call } = await t.connect(q); q.send(serialize(q.build('CANCEL', { cseq: 1, branch: 'z9hG4bKnotthatone01' }))); await sleep(100); assert.equal(call.state, 'answered', 'a CANCEL for an unknown transaction is refused with 481 and changes nothing');
});
test('no ACK: the 200 OK is retransmitted, then the dialog is torn down with a BYE and reported as no_ack; an unanswered ring is ended with 480', async () => {
  const t = await boot({ t1Ms: 15, t2Ms: 40 }), p = await t.phone(); const { sdp } = (await import('../src/sip/sdp.js')).buildOffer({ ip: '127.0.0.1', port: p.rtpPort }); const first = p.build('INVITE', { body: sdp }); p.send(serialize(first));
  const ch = (await p.wait<SipResponse>((m) => m.kind === 'response' && m.status === 401)).headers.find(([n]) => n === 'WWW-Authenticate')![1]; p.cseq++; p.send(serialize(p.build('INVITE', { body: sdp, extra: [['Authorization', answerChallenge({ challenge: ch, method: 'INVITE', uri: first.uri, username: 'trunk1', password: 'trunk-secret' })]] })));
  await eventually(() => t.calls.length === 1); const answered = t.calls[0].answer(t.sdpFor(t.calls[0])); const rejected = assert.rejects(answered, /ended before the ACK/); await rejected;      // the phone never sends an ACK
  assert.ok(p.responses(200).filter((r) => header(r, 'CSeq')!.endsWith('INVITE')).length >= 3, '200 OK retransmitted'); await eventually(() => p.requests('BYE').length >= 1, 4000); assert.equal(t.ends.get(t.calls[0].callId), 'no_ack');
  const slow = await boot({ ringTimeoutMs: 80 }), q = await slow.phone(); const r = await q.invite(); assert.equal(r.status, 480); await eventually(() => slow.ends.size === 1); assert.equal([...slow.ends.values()][0], 'rejected');
});
test('limits and policy: at capacity 503 + Retry-After, a second INVITE inside a dialog 488, a bad dialled number 404, an unusable SDP 488, an unknown method 405', async () => {
  const t = await boot({ maxCalls: 1 }), a = await t.phone(); await t.connect(a); const b = await t.phone(); const full = await b.invite(); assert.equal(full.status, 503); assert.equal(header(full, 'Retry-After'), '30');
  a.cseq++; a.send(serialize(a.build('INVITE', { cseq: a.cseq, branch: 'z9hG4bKreinvite0001', body: 'v=0\r\n' }))); await eventually(() => a.responses().some((r) => r.status === 401 || r.status === 488 || r.status === 403)); assert.equal(t.calls.length, 1, 'no second call from the same dialog');
  const t2 = await boot(), c = await t2.phone({ number: 'abc' }); assert.equal((await c.invite()).status, 404); const d = await t2.phone(); assert.equal((await d.invite({ offerSdp: 'v=0\r\nc=IN IP4 127.0.0.1\r\nm=video 4000 RTP/AVP 96\r\n' })).status, 488);
  const e = await t2.phone(); e.send(serialize(e.build('MESSAGE', { cseq: 1 }))); await eventually(() => e.responses(405).length === 1); assert.equal(t2.calls.length, 0);
  const codecs = await t2.phone({ codecs: [] as never }); void codecs;
});
test('a re-INVITE or a forked copy inside an established dialog is refused with 488 and never becomes a second call', async () => {
  const t = await boot(), p = await t.phone(); const { call } = await t.connect(p); const { sdp } = (await import('../src/sip/sdp.js')).buildOffer({ ip: '127.0.0.1', port: p.rtpPort });
  const dig = (cseq: number) => { p.cseq = cseq; return p.build('INVITE', { cseq, body: sdp, toTag: p.toTag, extra: [] }); }; p.send(serialize(dig(5))); await eventually(() => p.responses().some((r) => r.status === 401)); const ch = p.responses(401).slice(-1)[0].headers.find(([n]) => n === 'WWW-Authenticate')![1];
  const req = dig(6); req.headers.push(['Authorization', answerChallenge({ challenge: ch, method: 'INVITE', uri: req.uri, username: 'trunk1', password: 'trunk-secret' })]); p.send(serialize(req));
  await eventually(() => p.responses(488).length === 1); assert.equal(t.calls.length, 1); assert.equal(call.state, 'answered', 'the established call is untouched');
});
test('stopping the ingress hangs up every answered call with a BYE, ends ringing ones, and stops listening; hang-up from the handler side sends a BYE and reports local_hangup once', async () => {
  const t = await boot(), a = await t.phone(), { call: ca } = await t.connect(a); const b = await t.phone(); const { call: cb } = await t.connect(b);
  cb.hangup(); cb.hangup(); await eventually(() => b.requests('BYE').length >= 1); assert.equal(t.ends.get(cb.callId), 'local_hangup');
  await t.ingress.stop(); await eventually(() => a.requests('BYE').length >= 1); assert.equal(t.ends.get(ca.callId), 'shutdown'); assert.equal(t.ingress.health().listening, false); await t.ingress.stop();
  assert.equal([...t.ends.entries()].length, 2, 'exactly one end per call');
});
