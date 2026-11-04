import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshPeerAudio, type SignalData } from '../src/media/mesh-peer.js';
import type { MeetingAudioSession } from '../src/media/sip-media-gateway.js';
import { MeetingRelay, Browser } from './helpers/meeting-relay.js';
import { eventually, sleep } from './support.js';

/**
 * The gateway's mesh peer against browser stand-ins that run the browsers' own handshake, over REAL ICE + DTLS-SRTP (werift, loopback). Meet has no mixer: this is how a telephone caller becomes a meeting participant.
 */
const power = (frames: Int16Array[], hz: number) => { if (!frames.length) return 0; const x = new Int16Array(frames.length * 160); frames.forEach((f, i) => x.set(f, i * 160)); const w = (2 * Math.PI * hz) / 8000, c = 2 * Math.cos(w); let a = 0, b = 0; for (const v of x) { const t = v / 32768 + c * a - b; b = a; a = t; } return (a * a + b * b - c * a * b) / ((x.length * x.length) / 4); };
const live: (() => Promise<void> | void)[] = []; test.afterEach(async () => { for (const l of live.splice(0).reverse()) await l(); });
function gatewayPeer(relay: MeetingRelay, id: string, onSignalTap?: (d: SignalData) => void) {
  const audio = new MeshPeerAudio({ signaling: async () => { const port = relay.port(id); if (onSignalTap) { const orig = port.onSignal; port.onSignal = (cb) => orig((f, d) => { onSignalTap(d); cb(f, d); }); } return port; } });
  return audio.open({ callId: 'sip_test', meetingSessionId: 's', signal: new AbortController().signal });
}
/** Plays the role of the SIP leg: a tone INTO the meeting and a pull of the meeting's mix OUT, every 20 ms. */
function pump(session: MeetingAudioSession, hz: number) {
  const mix: Int16Array[] = []; let n = 0;
  const t = setInterval(() => { const pcm = new Int16Array(160); for (let i = 0; i < 160; i++) pcm[i] = Math.round(7000 * Math.sin((2 * Math.PI * hz * (n * 160 + i)) / 8000)); n++; session.pushFrame(pcm); const f = session.pullFrame(); if (f) mix.push(f); }, 20); t.unref?.();
  live.push(() => clearInterval(t)); return mix;
}

test('the gateway peer joins a meeting of two browsers: DTLS-SRTP connects, the caller\'s voice reaches both, and the caller hears the MIX of the two (never itself)', async () => {
  const relay = new MeetingRelay(), a = new Browser('b-aaa', relay, 1000).join(), b = new Browser('b-bbb', relay, 1500).join(); live.push(() => { a.leave(); b.leave(); });
  const session = await gatewayPeer(relay, 'g-phone'); live.push(() => session.close()); const heardByPhone = pump(session, 440);
  await eventually(() => session.isConnected() && a.connectedTo('g-phone') && b.connectedTo('g-phone'), 15000); assert.equal(session.encrypted, true); assert.equal(session.stats().peers, 2);
  const why = () => JSON.stringify({ p1000: power(heardByPhone.slice(-30), 1000), p1500: power(heardByPhone.slice(-30), 1500), a440: power(a.heard.slice(-30), 440), b440: power(b.heard.slice(-30), 440), mixN: heardByPhone.length, aN: a.heard.length, bN: b.heard.length });
  await eventually(() => power(heardByPhone.slice(-30), 1000) > 0.003 && power(heardByPhone.slice(-30), 1500) > 0.003 && power(a.heard.slice(-30), 440) > 0.01 && power(b.heard.slice(-30), 440) > 0.01, 15000).then((ok) => assert.ok(ok, 'tones arrived: ' + why()));
  const tail = heardByPhone.slice(-30); assert.ok(power(tail, 440) < 0.0005, 'the caller does not hear its own voice: ' + power(tail, 440)); assert.ok(power(a.heard.slice(-30), 1500) < 0.001, 'browsers hear each other directly, not through the gateway');
  assert.ok(await eventually(() => session.stats().framesFromMeeting > 20 && session.stats().framesToMeeting > 20, 5000), JSON.stringify(session.stats()));
});
test('a participant who joins AFTER the gateway offers to it and is connected; one who leaves is dropped and the call continues; when everyone has left the session reports not connected', async () => {
  const relay = new MeetingRelay(), a = new Browser('b-aaa', relay, 1000).join(); live.push(() => a.leave()); const session = await gatewayPeer(relay, 'g-phone'); live.push(() => session.close()); pump(session, 440);
  await eventually(() => session.isConnected() && a.connectedTo('g-phone'), 15000); const late = new Browser('b-late', relay, 2000).join(); live.push(() => late.leave());
  await eventually(() => late.connectedTo('g-phone') && session.stats().peers === 2, 15000); await eventually(() => power(late.heard.slice(-30), 440) > 0.01, 15000);
  a.leave(); await eventually(() => session.stats().peers === 1); assert.equal(session.isConnected(), true); late.leave(); await eventually(() => session.stats().peers === 0); assert.equal(session.isConnected(), false);
});
test('simultaneous offers (glare): both sides offer at once, the lower participant id yields, the other keeps its offer, and exactly one connection results', async () => {
  const relay = new MeetingRelay(), b = new Browser('b-aaa', relay, 1000).join();                       // the browser's id sorts BELOW the gateway's, so the browser must yield
  const audio = new MeshPeerAudio({ signaling: async () => ({ ...relay.port('g-zzz'), roster: () => ['b-aaa'] }) });                       // the gateway believes the browser is present: it offers
  const opening = audio.open({ callId: 'c', meetingSessionId: 's', signal: new AbortController().signal }); b.initiate('g-zzz');          // ...and so does the browser, at the same moment
  const session = await opening; live.push(() => { b.leave(); return session.close(); }); const sent: string[] = []; void sent;
  await eventually(() => session.isConnected() && b.connectedTo('g-zzz'), 20000); assert.equal(session.stats().peers, 1); assert.equal(b.peers.size, 1); assert.equal(relay.rejected.length, 0);
});
test('hostile or stale signalling is ignored: wrong epoch, unknown types, garbage, a candidate for a peer that does not exist; the session survives and still connects', async () => {
  const relay = new MeetingRelay(), a = new Browser('b-aaa', relay, 1000).join(); live.push(() => a.leave()); const session = await gatewayPeer(relay, 'g-phone'); live.push(() => session.close()); pump(session, 440);
  const port = relay.members.get('g-phone')!; for (const d of [{ type: 'answer', sdp: { type: 'answer', sdp: 'v=0' }, epoch: 'stale' }, { type: 'candidate', candidate: { candidate: 'x' }, epoch: 'stale' }, { type: 'bogus' }, null, 'string', { type: 'offer', sdp: { type: 'offer', sdp: 'garbage' }, epoch: 'e1' }] as unknown as SignalData[]) port.deliver('b-zzz-ghost', d);
  port.deliver('b-aaa', { type: 'answer', sdp: { type: 'answer', sdp: 'v=0' }, epoch: 'not-the-pairs-epoch' }); await eventually(() => session.isConnected() && a.connectedTo('g-phone'), 15000); await sleep(100); assert.equal(session.stats().peers >= 1, true);
});
test('close: every peer connection is closed, the signalling is released, listeners fire once, and nothing flows afterwards; the relay never saw the gateway\'s restart/rebuild (the real server would reject them)', async () => {
  const relay = new MeetingRelay(), a = new Browser('b-aaa', relay, 1000).join(); live.push(() => a.leave()); const session = await gatewayPeer(relay, 'g-phone'); let closed = 0; session.onClosed(() => closed++); pump(session, 440);
  await eventually(() => session.isConnected(), 15000); await session.close('test'); await session.close('again'); assert.equal(closed, 1); assert.equal(session.isConnected(), false); assert.equal(session.pullFrame(), null); assert.equal(relay.members.has('g-phone'), false);
  const before = a.heard.length; session.pushFrame(new Int16Array(160).fill(9000)); await sleep(150); assert.ok(a.heard.length - before < 12, 'at most the frames already in flight'); assert.equal(relay.rejected.length, 0, 'the gateway sent only message types the real server relays');
});

test('ICE restart: when a browser asks (restart), the gateway re-offers with NEW ICE credentials (a real restart, not a repeat offer), the connection comes back, and audio keeps flowing both ways', async () => {
  const relay = new MeetingRelay(), a = new Browser('b-aaa', relay, 1000).join(); live.push(() => a.leave()); const session = await gatewayPeer(relay, 'g-phone'); live.push(() => session.close()); const heardByPhone = pump(session, 440);
  await eventually(() => session.isConnected() && a.connectedTo('g-phone'), 15000); await eventually(() => power(a.heard.slice(-25), 440) > 0.01 && power(heardByPhone.slice(-25), 1000) > 0.003, 15000); const first = a.offerUfrags.length;
  a.restart('g-phone'); await eventually(() => a.offerUfrags.length > first, 10000); assert.ok(a.offerUfrags.length > first, 'the gateway sent a new offer');
  const known = new Set(a.offerUfrags.slice(0, first)); assert.ok(a.offerUfrags.slice(first).some((u) => u && !known.has(u)), 'the new offer carries new ICE credentials: ' + a.offerUfrags.join(','));
  await eventually(() => session.isConnected() && a.connectedTo('g-phone'), 15000); const nA = a.heard.length, nP = heardByPhone.length; await sleep(800);
  assert.ok(a.heard.length > nA + 10 && heardByPhone.length > nP + 10, 'audio flows both ways after the restart'); assert.ok(power(a.heard.slice(-25), 440) > 0.01); assert.equal(relay.rejected.length, 0, 'the relay carried the restart request');
});
