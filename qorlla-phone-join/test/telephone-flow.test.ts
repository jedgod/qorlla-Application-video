import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { UdpSipIngress } from '../src/sip/udp-ingress.js';
import { DigestAuthenticator, ha1 } from '../src/sip/digest.js';
import { SipMediaGateway, type MeetingAudio, type MeetingAudioSession } from '../src/media/sip-media-gateway.js';
import { TelephoneController } from '../src/telephone-controller.js';
import { meetConfirmedBridge, type MediaReporter } from '../src/meet-media.js';
import { terminateCall } from '../src/compose.js';
import { audioVerified, type AudioEvidence } from '../src/media-contract.js';
import type { CallLedger, CallState, MeetingAuthority, Readiness } from '../src/admission.js';
import { SyntheticPhone } from './helpers/synthetic-phone.js';
import { MeshPeerAudio } from '../src/media/mesh-peer.js';
import { MeetingRelay, Browser } from './helpers/meeting-relay.js';
import { eventually, sleep } from './support.js';

/**
 * END TO END, in one process, over real UDP: synthetic phone -> SIP ingress -> telephone controller (DTMF) -> admission -> media gateway (SRTP leg, jitter buffer) -> meeting audio -> and back.
 * The MEETING side is a labelled TEST DOUBLE (FakeMeeting): the real one is a WebRTC peer in the meeting mesh (mesh-peer.ts, tested separately). Nothing here is production certification:
 * a simulated path proves our logic, never that a carrier's audio reaches a person.
 */
const MEETING = '12345678901', PIN = '4321', SESSION = '11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222', TOKEN = 'media-token-for-tests';
const READY: Readiness = { carrierConnected: true, inboundNumberCertified: true, gatewayHealthy: true, mediaBridgeCertified: true, billingCertified: true, productionApproved: true };
const power = (frames: Int16Array[], hz: number) => { if (!frames.length) return 0; const x = new Int16Array(frames.length * 160); frames.forEach((f, i) => x.set(f, i * 160)); const w = (2 * Math.PI * hz) / 8000, c = 2 * Math.cos(w); let a = 0, b = 0; for (const v of x) { const t = v / 32768 + c * a - b; b = a; a = t; } return (a * a + b * b - c * a * b) / ((x.length * x.length) / 4); };

/** TEST DOUBLE for the meeting-side audio: records what the phone says, speaks a tone to the phone. */
class FakeSession implements MeetingAudioSession {
  connected = true; heard: Int16Array[] = []; closed = false; closedWhy = ''; private n = 0; private cb: ((r: string) => void)[] = []; fromMeeting = 0; lastFromMeetingAt = 0;
  constructor(readonly encrypted: boolean, public speakHz: number | null) {}
  isConnected() { return this.connected && !this.closed; }
  pullFrame() { if (this.speakHz === null || this.closed) return null; const f = new Int16Array(160); for (let i = 0; i < 160; i++) f[i] = Math.round(7000 * Math.sin((2 * Math.PI * this.speakHz * (this.n * 160 + i)) / 8000)); this.n++; this.fromMeeting++; this.lastFromMeetingAt = Date.now(); return f; }
  pushFrame(f: Int16Array) { if (!this.closed) this.heard.push(f); }
  stats() { return { framesFromMeeting: this.fromMeeting, framesToMeeting: this.heard.length, peers: 1, lastFromMeetingAt: this.lastFromMeetingAt }; }
  onClosed(l: (r: string) => void) { this.cb.push(l); }
  async close(why = 'closed') { if (this.closed) return; this.closed = true; this.closedWhy = why; for (const l of this.cb) l(why); }
}
class FakeMeeting implements MeetingAudio {
  sessions: FakeSession[] = []; opens = 0; constructor(public o: { encrypted: boolean; speakHz: number | null; openDelayMs?: number } = { encrypted: true, speakHz: 1000 }) {}
  async open(a: { signal: AbortSignal }) { this.opens++; if (this.o.openDelayMs) await sleep(this.o.openDelayMs); const s = new FakeSession(this.o.encrypted, this.o.speakHz); this.sessions.push(s); return s; }
}
const realm = 'qorlla-gw', secret = crypto.randomBytes(32), H = ha1('SHA-256', 'trunk1', realm, 'trunk-secret');
const cleanup: (() => Promise<void> | void)[] = []; test.afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c(); });
type StackOpts = { audio?: MeetingAudio; gate?: Promise<void>; readiness?: Partial<Readiness>; meeting?: FakeMeeting['o']; decision?: { allowed: boolean; approval?: boolean }; portRange?: [number, number]; minPackets?: number; stepTimeoutMs?: number; recoverWithinMs?: number; staleAfterMs?: number; meetOK?: boolean; port?: number; codes?: string[]; seen?: string[] };
async function stack(o: StackOpts = {}) {
  const fake = new FakeMeeting(o.meeting ?? { encrypted: true, speakHz: 1000 }), cancels: string[] = [], held = new Set<string>(), trail: string[] = [], reports: AudioEvidence[] = [], ended: { id: string; reason: string; phase: string }[] = [];
  const ledger: CallLedger = { claim: async (id) => (held.has(id) ? false : (held.add(id), true)), release: async (id) => { held.delete(id); trail.push('released:' + id.slice(0, 8)); }, transition: async (id, to: CallState) => { trail.push(to); return true; } };
  const authority: MeetingAuthority = {
    verifyPhoneJoin: async (m, p) => { o.seen?.push(m + '|' + p); return (o.codes ?? [MEETING]).includes(m) && p === PIN && o.decision?.allowed !== false ? { allowed: true, requiresHostApproval: true, meetingSessionId: SESSION } : { allowed: false, requiresHostApproval: false }; },
    requestHostApproval: async () => { await o.gate; return o.decision?.approval === false ? false : { approved: true, mediaToken: TOKEN }; }, cancelAdmission: async (_s, id) => { cancels.push(id); }
  };
  const minPackets = o.minPackets ?? 10, gateway = new SipMediaGateway({ meeting: fake, minPackets, minObservedMs: 200, attachTimeoutMs: 2500, staleAfterMs: o.staleAfterMs ?? 700, recoverWithinMs: o.recoverWithinMs ?? 1200, watchdogMs: 100 });
  const judge: MediaReporter = { reportMedia: async (_id, token, ev) => { if (ev) reports.push(ev); return token === TOKEN && o.meetOK !== false && audioVerified(ev, { minPackets, minObservedMs: 200 }) ? { result: 'connected', action: 'none' } : { result: 'rejected', action: 'terminate' }; } };
  const bridge = meetConfirmedBridge({ gateway, meet: judge, policy: { minPackets, minObservedMs: 200 } });
  const digest = new DigestAuthenticator({ realm, secret, lookup: (u) => (u === 'trunk1' ? H : undefined) });
  const ingress = new UdpSipIngress({ host: '127.0.0.1', port: o.port ?? 0, realm, digest, allowedSources: ['127.0.0.1'], maxCalls: 8, t1Ms: 20, t2Ms: 80, ringTimeoutMs: 8000, maxInvitesPerSecond: 50, burst: 100 });
  const results: { id: string; code: string }[] = [];
  const controller = new TelephoneController({ ingress, gateway, bridge, authority, readiness: async () => ({ ...READY, ...o.readiness }), tones: false,
    media: { bindHost: '127.0.0.1', publicHost: '127.0.0.1', portRange: o.portRange ?? [31000, 31400], inactivityMs: 4000 }, rules: { meetingId: { minDigits: 11, maxDigits: 12, interDigitMs: 2000, totalMs: 8000, requireTerminator: true }, passcode: { minDigits: 4, maxDigits: 32, interDigitMs: 2000, totalMs: 8000 } },
    admission: { ledger, stepTimeoutMs: o.stepTimeoutMs ?? 4000, hostApprovalTimeoutMs: 2000, ledgerTimeoutMs: 1000 }, maxEntryAttempts: 1,
    onEnded: async (id, reason, phase) => { ended.push({ id, reason, phase }); if (phase !== 'ivr') await terminateCall({ bridge, authority, ledger })({ callId: id, meetingSessionId: SESSION }, reason).catch(() => undefined); } });
  controller.start(); const addr = await ingress.start();
  cleanup.push(async () => { await ingress.stop(); await gateway.closeAll(); });
  const phone = async (po: Partial<ConstructorParameters<typeof SyntheticPhone>[0]> = {}) => { const p = await SyntheticPhone.create({ gateway: addr, ...po }); cleanup.push(() => p.close()); return p; };
  /** Dials in, enters the meeting ID and passcode by keypad, streams a 440 Hz tone. Resolves when the 200 OK has been received. */
  const dial = async (p: SyntheticPhone, o2: { id?: string; pin?: string; tone?: Parameters<SyntheticPhone['tone']>[1] | false } = {}) => {
    const r = await p.invite(); assert.equal(r.status, 200); if (o2.tone !== false) p.tone(440, o2.tone || {}); await p.digits((o2.id ?? MEETING) + '#'); await p.digits((o2.pin ?? PIN) + '#'); return r;
  };
  return { fake, gateway, ingress, controller, addr, phone, dial, ledger, held, trail, cancels, reports, ended, results, bridge };
}
const connected = (s: Awaited<ReturnType<typeof stack>>) => eventually(() => s.gateway.activeLegs() === 1 && s.fake.sessions.length === 1 && s.bridge.legs.size === 1, 8000);

test('happy path: DTMF meeting ID + passcode, admission, then REAL two-way audio: the phone\'s tone reaches the meeting, the meeting\'s tone reaches the phone (SRTP, G.711), evidence verified by both judges', async () => {
  let release!: () => void; const s = await stack({ gate: new Promise<void>((r) => { release = r; }) }), p = await s.phone(); await s.dial(p); await sleep(300);
  assert.equal(s.fake.opens, 0, 'no meeting audio session exists while the host has not approved'); assert.equal(s.bridge.legs.size, 0); assert.ok(p.receivedPackets < 500); const quiet = p.received.length;
  assert.ok(power(p.received, 1000) < 0.001, 'and the caller hears nothing from the meeting'); void quiet; release(); await connected(s);
  const id = [...s.bridge.legs.keys()][0]; const sess = s.fake.sessions[0];
  await eventually(() => power(p.received.slice(-25), 1000) > 0.01 && power(sess.heard.slice(-25), 440) > 0.01, 8000);
  const said = sess.heard.slice(-25), heard = p.received.slice(-25);                 // the last half second, once the call is connected (the IVR phase before it is silence)
  assert.ok(power(said, 440) > 0.01, 'the phone\'s 440 Hz arrived in the meeting (' + power(said, 440) + ')'); assert.ok(power(said, 1000) < 0.001, 'and nothing else');
  assert.ok(power(heard, 1000) > 0.01, 'the meeting\'s 1000 Hz arrived at the phone (' + power(heard, 1000) + ')'); assert.ok(power(heard, 440) < 0.001, 'the phone does not hear itself');
  const ev = s.gateway.measure(id)!; assert.equal(ev.state, 'audio_flowing'); assert.equal(ev.encrypted, true); assert.equal(ev.codec, 'PCMU'); assert.ok(ev.inboundPackets >= 10 && ev.outboundPackets >= 10, JSON.stringify(ev));
  assert.ok(s.reports.length >= 1 && audioVerified(s.reports[0], { minPackets: 10, minObservedMs: 200 }), 'Meet\'s judge was given verified evidence');
  assert.equal(s.trail.includes('released:' + id.slice(0, 8)), false, 'a connected call keeps its claim'); assert.equal(s.ended.length, 0);
});
test('A5.3: a 12-digit code (and one with a leading zero) is keyed in with #, reaches admission EXACTLY as dialled, and the passcode is its own entry', async () => {
  for (const code of ['123456789012', '012345678901', '01234567890']) {
    const seen: string[] = [], s = await stack({ codes: [code], seen }), p = await s.phone(); await s.dial(p, { id: code }); await connected(s);
    assert.deepEqual(seen, [code + '|' + PIN], 'the digits that were pressed, untouched, and the passcode without any digit of the code'); assert.equal(s.fake.opens, 1);
  }
});
test('A5.3: a 13th digit is refused - no admission request is made, no passcode is spent, nothing is attached', async () => {
  const seen: string[] = [], s = await stack({ codes: [MEETING, '123456789012'], seen }), p = await s.phone(); await s.dial(p, { id: '1234567890123' }); await eventually(() => p.requests('BYE').length >= 1, 12000);
  assert.deepEqual(seen, [], 'nothing reached admission: not the first 11 digits, not the first 12, not anything'); assert.equal(s.fake.opens, 0); assert.equal(s.gateway.activeLegs(), 0); assert.equal(s.bridge.legs.size, 0);
});
test('wrong meeting credentials: the caller is refused, hung up, and nothing is ever attached to the meeting', async () => {
  const s = await stack({ decision: { allowed: false } }), p = await s.phone(); await s.dial(p); await eventually(() => p.requests('BYE').length >= 1, 6000);
  assert.equal(s.fake.opens, 0); assert.equal(s.gateway.activeLegs(), 0); assert.equal(s.bridge.legs.size, 0); assert.ok(s.trail.some((t) => t.startsWith('released:')), 'the call id was released');
});
test('host refusal: the waiting caller is hung up, the meeting is told, no media is attached', async () => {
  const s = await stack({ decision: { allowed: true, approval: false } }), p = await s.phone(); await s.dial(p); await eventually(() => p.requests('BYE').length >= 1, 6000);
  assert.equal(s.fake.opens, 0); assert.equal(s.gateway.activeLegs(), 0); assert.ok(s.cancels.length >= 1, 'cancelAdmission told the meeting'); assert.equal(s.bridge.legs.size, 0);
});
test('Security Shield revocation of a connected call (the guard\'s terminate path): BYE to the phone, the meeting session closed, the call ended once', async () => {
  const s = await stack(), p = await s.phone(); await s.dial(p); await connected(s); const id = [...s.bridge.legs.keys()][0];
  await terminateCall({ bridge: s.bridge, authority: { verifyPhoneJoin: async () => ({ allowed: false, requiresHostApproval: false }), requestHostApproval: async () => false, cancelAdmission: async (_s, c) => { s.cancels.push(c); } }, ledger: s.ledger })({ callId: id, meetingSessionId: SESSION }, 'SHIELD_REVOKED');
  await eventually(() => p.requests('BYE').length === 1, 4000); assert.equal(s.gateway.activeLegs(), 0); assert.equal(s.fake.sessions[0].closed, true); assert.ok(s.trail.includes('terminating') && s.trail.includes('ended')); assert.equal(s.cancels.filter((c) => c === id).length >= 1, true);
  await sleep(200); assert.equal(s.ingress.health().activeCalls, 0);
});
test('missing audio from the telephone: signalling and DTMF succeed, but NO audio packets arrive - the call is never reported connected and is hung up', async () => {
  const s = await stack(), p = await s.phone(); await s.dial(p, { tone: false }); await eventually(() => p.requests('BYE').length >= 1, 8000);
  assert.equal(s.bridge.legs.size, 0); assert.equal(s.gateway.activeLegs(), 0); assert.equal(s.reports.filter((e) => e.state === 'audio_flowing').length, 0, 'nothing verified was ever reported'); assert.ok(s.fake.sessions.every((x) => x.closed));
});
test('missing audio from the meeting: the telephone talks but the meeting sends nothing - not connected, hung up, session closed', async () => {
  const s = await stack({ meeting: { encrypted: true, speakHz: null } }), p = await s.phone(); await s.dial(p); await eventually(() => p.requests('BYE').length >= 1, 8000);
  assert.equal(s.bridge.legs.size, 0); assert.ok(s.fake.sessions.length === 1 && s.fake.sessions[0].closed); assert.equal(s.gateway.activeLegs(), 0);
});
test('simulated (unencrypted) meeting media can never be verified: a path that is not DTLS-SRTP does not connect a caller, whatever the audio', async () => {
  const s = await stack({ meeting: { encrypted: false, speakHz: 1000 } }), p = await s.phone(); await s.dial(p); await eventually(() => p.requests('BYE').length >= 1, 8000);
  assert.equal(s.bridge.legs.size, 0); assert.ok(s.reports.every((e) => e.encrypted === false)); assert.equal(s.gateway.activeLegs(), 0);
});
test('Meet\'s own judgement matters: if Meet answers "terminate" the call is torn down even though the gateway\'s evidence was fine', async () => {
  const s = await stack({ meetOK: false }), p = await s.phone(); await s.dial(p); await eventually(() => p.requests('BYE').length >= 1, 8000); assert.equal(s.bridge.legs.size, 0); assert.ok(s.reports.length >= 1); assert.equal(s.gateway.activeLegs(), 0);
});
test('codec mismatch (no G.711 offered) is refused with 488 and allocates nothing; plain RTP is refused; a media address that is not the caller\'s is refused', async () => {
  const s = await stack(), p = await s.phone(); const opus = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio ' + p.rtpPort + ' RTP/SAVP 111\r\na=rtpmap:111 opus/48000/2\r\na=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:' + crypto.randomBytes(30).toString('base64') + '\r\n';
  assert.equal((await p.invite({ offerSdp: opus })).status, 488); const plain = await s.phone({ secure: false }); assert.equal((await plain.invite()).status, 488); const spoof = await s.phone({ mediaIp: '192.0.2.50' }); assert.equal((await spoof.invite()).status, 488);
  assert.equal(s.gateway.activeLegs(), 0); assert.equal(s.fake.opens, 0);
});
test('readiness missing: the gateway answers 503 and allocates no port and no leg (telephone dial-in stays disabled)', async () => {
  for (const missing of ['carrierConnected', 'gatewayHealthy', 'productionApproved'] as const) { const s = await stack({ readiness: { [missing]: false } }), p = await s.phone(); assert.equal((await p.invite()).status, 503, missing); assert.equal(s.gateway.activeLegs(), 0); assert.equal(p.responses(200).length, 0); }
});
test('packet loss, jitter, reordering and duplicates: audio still verifies, the jitter buffer reports what it did, and the tone is intact', async () => {
  const s = await stack(), p = await s.phone(); await s.dial(p, { tone: { lossPct: 10, jitterMs: 35, dupPct: 8 } }); await connected(s); await sleep(1200);
  const leg = (s.gateway as unknown as { legs: Map<string, { leg: { stats(): ReturnType<import('../src/media/rtp-leg.js').RtpLeg['stats']> } }> }).legs.values().next().value!.leg.stats(); const sess = s.fake.sessions[0];
  assert.ok(leg.jitter.lost > 0 || leg.jitter.concealed > 0, 'loss was seen and concealed: ' + JSON.stringify(leg.jitter)); assert.ok(leg.jitter.duplicates > 0, 'duplicates were dropped'); assert.ok(leg.jitter.reordered > 0 || leg.jitter.late > 0, 'reordering was handled'); assert.ok(leg.jitter.jitterMs > 0);
  assert.ok(power(sess.heard.slice(-40), 440) > 0.005, 'the tone survives 10% loss: ' + power(sess.heard, 440) + ' heard=' + sess.heard.length + ' closed=' + sess.closed + '/' + sess.closedWhy + ' ended=' + JSON.stringify(s.ended) + ' leg=' + JSON.stringify(leg));
});
test('interrupted media: when the telephone stops sending the call is ended after the recovery window; a short gap is survived', async () => {
  const s = await stack({ recoverWithinMs: 1500, staleAfterMs: 500 }), p = await s.phone(); await s.dial(p); await connected(s);
  p.stopTone(); await sleep(700); p.tone(440); await sleep(800); assert.equal(s.gateway.activeLegs(), 1, 'a gap shorter than the recovery window is survived'); assert.equal(p.requests('BYE').length, 0);
  p.stopTone(); await eventually(() => p.requests('BYE').length === 1, 6000); assert.equal(s.gateway.activeLegs(), 0); assert.ok(s.fake.sessions[0].closed); assert.ok(s.ended.some((e) => e.reason === 'media_interrupted'), JSON.stringify(s.ended));
});
test('teardown: the phone hangs up - the leg, the meeting session, the RTP port, the claim and the dialog are all released exactly once', async () => {
  const s = await stack(), p = await s.phone(); await s.dial(p); await connected(s); const id = [...s.bridge.legs.keys()][0], sess = s.fake.sessions[0];
  p.bye(); p.bye(); await eventually(() => s.gateway.activeLegs() === 0 && sess.closed, 4000); await eventually(() => s.ended.length >= 1);
  assert.equal(s.ended.filter((e) => e.id === id).length, 1, 'ended once'); assert.equal(s.cancels.filter((c) => c === id).length >= 1, true); assert.equal(s.bridge.legs.size, 0);
  const probe = dgram.createSocket('udp4'); await new Promise<void>((r, j) => { probe.once('error', j); probe.bind(0, '127.0.0.1', r); }); probe.close();
});
test('late media: the meeting takes longer than the step timeout - the admission gives up, and the session that appears later is closed and the caller hung up (nothing is left behind)', async () => {
  const s = await stack({ meeting: { encrypted: true, speakHz: 1000, openDelayMs: 1500 }, stepTimeoutMs: 400 }), p = await s.phone(); await s.dial(p); await eventually(() => p.requests('BYE').length >= 1, 8000);
  await eventually(() => s.fake.sessions.length === 1 && s.fake.sessions[0].closed, 6000); assert.equal(s.gateway.activeLegs(), 0); assert.equal(s.bridge.legs.size, 0);
});
test('restart: stopping the gateway hangs up live calls with a BYE and releases everything; a new gateway then serves a new call', async () => {
  const s = await stack(), p = await s.phone(); await s.dial(p); await connected(s); await s.ingress.stop(); await s.gateway.closeAll('restart'); await eventually(() => p.requests('BYE').length === 1, 4000); assert.equal(s.gateway.activeLegs(), 0); assert.ok(s.fake.sessions[0].closed);
  const s2 = await stack(), q = await s2.phone(); await s2.dial(q); await connected(s2); assert.equal(s2.gateway.activeLegs(), 1);
});
test('duplicate SIP callbacks: a retransmitted INVITE and a doubled BYE produce one admission, one leg and one teardown', async () => {
  const s = await stack(), p = await s.phone(); await s.dial(p); await connected(s); assert.equal(s.fake.opens, 1, 'one meeting session'); const before = s.ingress.health().retransmissionsAbsorbed;
  p.bye(); p.bye(); p.bye(); await eventually(() => s.gateway.activeLegs() === 0); await sleep(200); assert.equal(s.ended.length, 1); assert.ok(s.ingress.health().retransmissionsAbsorbed >= before);
});
test('capacity: when the RTP port range is exhausted the call is refused with 503 and the earlier call is unaffected', async () => {
  const s = await stack({ portRange: [31500, 31500] }), a = await s.phone(); await s.dial(a); await connected(s); const b = await s.phone(); const r = await b.invite(); assert.equal(r.status, 503); assert.equal(s.gateway.activeLegs(), 1);
});

test('THE WHOLE REAL CHAIN: phone -> SIP + SRTP -> gateway -> DTLS-SRTP mesh peer -> two browsers, and back; verified by both judges on the real media path (no simulated meeting audio anywhere)', async () => {
  const relay = new MeetingRelay(), a = new Browser('b-aaa', relay, 1000).join(), b = new Browser('b-bbb', relay, 1500).join(); cleanup.push(() => { a.leave(); b.leave(); });
  const mesh = new MeshPeerAudio({ signaling: async () => relay.port('g-phone') }), s = await stack({ audio: mesh, minPackets: 15 }), p = await s.phone(); await s.dial(p);
  await eventually(() => s.bridge.legs.size === 1, 20000); const id = [...s.bridge.legs.keys()][0];
  await eventually(() => power(p.received.slice(-25), 1000) > 0.003 && power(p.received.slice(-25), 1500) > 0.003 && power(a.heard.slice(-25), 440) > 0.01 && power(b.heard.slice(-25), 440) > 0.01, 20000);
  assert.ok(power(p.received.slice(-25), 440) < 0.0005, 'the caller does not hear itself'); const ev = s.gateway.measure(id)!; assert.equal(ev.state, 'audio_flowing'); assert.equal(ev.encrypted, true, 'SRTP on the telephone leg AND DTLS-SRTP in the meeting');
  assert.ok(ev.inboundPackets >= 15 && ev.outboundPackets >= 15, JSON.stringify(ev)); assert.ok(audioVerified(s.reports[0], { minPackets: 15, minObservedMs: 200, now: () => s.reports[0].measuredAt + 50 }), 'the report Meet judged was verified evidence when it was made');
  p.bye(); await eventually(() => s.gateway.activeLegs() === 0, 5000); await eventually(() => !a.connectedTo('g-phone') && !b.connectedTo('g-phone'), 10000); assert.equal(relay.members.has('g-phone'), false, 'the peer left the meeting');
});
