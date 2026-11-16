import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshPeerAudio, type MeshClock, type SignalData } from '../src/media/mesh-peer.js';
import type { MeetingAudioSession } from '../src/media/sip-media-gateway.js';
import { MeetingRelay, Browser } from './helpers/meeting-relay.js';
import { eventually } from './support.js';

// Gate A5.2 (gateway side): recovery is BOUNDED and stale attempts are fenced. Time is a fake clock the test advances explicitly; connection failures are delivered to the real peer connection as events;
// everything else (signalling, ICE, DTLS-SRTP) is real. The browser side of the same window is covered by the Chromium tests (test/e2e-chrome.test.ts).
const live: (() => Promise<void> | void)[] = []; test.afterEach(async () => { for (const l of live.splice(0).reverse()) await l(); });
function fakeClock() {
  let t = 0, n = 0; const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: MeshClock & { advance(ms: number): void; pending(): number } = {
    now: () => t, setTimeout: (fn, ms) => { timers.set(++n, { at: t + ms, fn }); return n; }, clearTimeout: (h) => { timers.delete(h as number); }, pending: () => timers.size,
    advance(ms) { const end = t + ms; for (;;) { const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; t = Math.max(t, next[1].at); timers.delete(next[0]); next[1].fn(); } t = end; },
  };
  return clock;
}
const OPTS = { connectTimeoutMs: 45_000, recoveryDeadlineMs: 30_000 };
async function open(relay: MeetingRelay, clock: MeshClock, id = 'g-phone', tap?: (d: SignalData) => void) {
  const audio = new MeshPeerAudio({ ...OPTS, clock, signaling: async () => { const port = relay.port(id); if (tap) { const orig = port.onSignal; port.onSignal = (cb) => orig((f, d) => { tap(d); cb(f, d); }); } return port; } });
  const session = await audio.open({ callId: 'sip_test', meetingSessionId: 's', signal: new AbortController().signal }); const closed: string[] = []; session.onClosed((r) => closed.push(r)); live.push(() => session.close()); return { session, closed };
}
const peerOf = (s: MeetingAudioSession, id: string) => (s as unknown as { peers: Map<string, { pc: { connectionStateChange: { execute(x: string): void } }; connected: boolean }> }).peers.get(id);
const silent = (relay: MeetingRelay, id: string) => { relay.members.set(id, { deliver: () => undefined, left: () => undefined }); };       // a member that is in the meeting but never answers
const deafen = (relay: MeetingRelay, id: string) => { relay.members.get(id)!.deliver = () => undefined; };                                       // from now on nothing reaches it

test('a browser that never connects is dropped at the connect deadline; with nobody else left the leg ends with the reason recovery_deadline and no timer survives', async () => {
  const relay = new MeetingRelay(), clock = fakeClock(); silent(relay, 'b-silent'); const { session, closed } = await open(relay, clock);
  assert.equal(session.stats().peers, 1); clock.advance(44_999); assert.equal(session.stats().peers, 1, 'one millisecond before the deadline'); assert.deepEqual(closed, []);
  clock.advance(1); assert.equal(session.stats().peers, 0); assert.ok(await eventually(() => closed.length === 1)); assert.deepEqual(closed, ['recovery_deadline']); assert.equal(clock.pending(), 0, 'every deadline timer was released');
});

test('one browser that cannot connect does not end the leg while another is connected; the others are untouched', async () => {
  const relay = new MeetingRelay(), clock = fakeClock(), a = new Browser('b-aaa', relay, 1000).join(); live.push(() => a.leave()); silent(relay, 'b-silent'); const { session, closed } = await open(relay, clock);
  assert.ok(await eventually(() => session.isConnected() && a.connectedTo('g-phone'), 15000)); assert.equal(session.stats().peers, 2);
  clock.advance(45_000); assert.equal(session.stats().peers, 1, 'the silent one is gone'); assert.equal(session.isConnected(), true); assert.deepEqual(closed, []); assert.equal(a.connectedTo('g-phone'), true, 'and the connected browser is not disturbed');
});

test('recovery that cannot complete ends the leg at the recovery deadline, and ICE restarts and a rebuild do NOT reset the clock', async () => {
  const relay = new MeetingRelay(), clock = fakeClock(), a = new Browser('b-aaa', relay, 1000).join(); live.push(() => a.leave()); const { session, closed } = await open(relay, clock);
  assert.ok(await eventually(() => session.isConnected() && a.connectedTo('g-phone'), 15000)); const first = peerOf(session, 'b-aaa')!; deafen(relay, 'b-aaa');          // the gateway is the offerer here
  first.pc.connectionStateChange.execute('failed'); clock.advance(20_000); for (let i = 0; i < 3; i++) first.pc.connectionStateChange.execute('failed');          // restarts 1..4: the 4th rebuilds the pair
  const second = peerOf(session, 'b-aaa'); assert.ok(second && second !== first, 'the pair was rebuilt (a new connection object)'); assert.equal(session.stats().peers, 1);
  clock.advance(9_999); assert.equal(session.stats().peers, 1, 'not yet: 29.999 s since the first failure'); assert.deepEqual(closed, []); clock.advance(1);
  assert.equal(session.stats().peers, 0); assert.ok(await eventually(() => closed.length === 1)); assert.deepEqual(closed, ['recovery_deadline']); assert.equal(clock.pending(), 0);
});

test('recovery that succeeds stops the clock: the leg is still up long after the deadline would have passed', async () => {
  const relay = new MeetingRelay(), clock = fakeClock(), a = new Browser('b-aaa', relay, 1000).join(); live.push(() => a.leave()); const { session, closed } = await open(relay, clock);
  assert.ok(await eventually(() => session.isConnected() && a.connectedTo('g-phone'), 15000)); const p = peerOf(session, 'b-aaa')!;
  p.pc.connectionStateChange.execute('failed'); clock.advance(10_000); p.pc.connectionStateChange.execute('connected'); clock.advance(300_000);
  assert.equal(session.stats().peers, 1); assert.equal(session.isConnected(), true); assert.deepEqual(closed, []);
  p.pc.connectionStateChange.execute('disconnected'); clock.advance(29_999); assert.equal(session.stats().peers, 1, 'a NEW outage gets a fresh budget'); clock.advance(1); assert.equal(session.stats().peers, 0);
});

test('a late offer of a superseded connection does not bring it back', async () => {
  const relay = new MeetingRelay(), clock = fakeClock(), offers: SignalData[] = []; silent(relay, 'b-zzz'); const { session } = await open(relay, clock, 'g-phone', (d) => { if (d.type === 'offer') offers.push(d); });
  const a = new Browser('b-aaa', relay, 1000).join(); live.push(() => a.leave());                                                                       // joined AFTER the gateway: it is the offerer
  assert.ok(await eventually(() => offers.length > 0 && session.isConnected() && a.connectedTo('g-phone'), 15000)); deafen(relay, 'b-aaa'); peerOf(session, 'b-aaa')!.pc.connectionStateChange.execute('failed'); clock.advance(30_000);
  assert.equal(peerOf(session, 'b-aaa'), undefined, 'dropped at the recovery deadline'); assert.equal(session.stats().peers, 1, 'only the silent member remains');
  relay.members.get('g-phone')!.deliver('b-aaa', offers[0]);                                                                                            // the browser\'s ORIGINAL offer arrives late
  await new Promise((r) => setTimeout(r, 300)); assert.equal(peerOf(session, 'b-aaa'), undefined, 'ignored: the epoch belongs to a connection that was closed'); assert.equal(session.stats().peers, 1);
});

test('after the session is over, late SDP and ICE are ignored, nothing is created, and no timer is left', async () => {
  const relay = new MeetingRelay(), clock = fakeClock(), offers: SignalData[] = []; silent(relay, 'b-zzz'); const { session, closed } = await open(relay, clock, 'g-phone', (d) => { if (d.type === 'offer') offers.push(d); });
  const a = new Browser('b-aaa', relay, 1000).join(); live.push(() => a.leave()); assert.ok(await eventually(() => offers.length > 0 && session.isConnected(), 15000));
  const stale = offers[0], deliver = relay.members.get('g-phone')!.deliver; await session.close('revoked'); assert.deepEqual(closed, ['revoked']); assert.equal(relay.members.get('g-phone'), undefined, 'the port left the relay');
  deliver('b-aaa', stale); deliver('b-aaa', { type: 'candidate', candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 }, epoch: 'x' } as SignalData);
  await new Promise((r) => setTimeout(r, 200)); assert.equal(session.stats().peers, 0); assert.equal(clock.pending(), 0); assert.equal(session.pullFrame(), null);
});

test('the gateway\'s signalling is lost while a recovery is running: the session closes with that reason and the recovery timers are released', async () => {
  const relay = new MeetingRelay(), clock = fakeClock(), a = new Browser('b-aaa', relay, 1000).join(); live.push(() => a.leave()); const { session, closed } = await open(relay, clock);
  assert.ok(await eventually(() => session.isConnected() && a.connectedTo('g-phone'), 15000)); peerOf(session, 'b-aaa')!.pc.connectionStateChange.execute('failed'); assert.ok(clock.pending() > 0, 'a recovery deadline is running');
  relay.members.get('g-phone')!.left('x'); await session.close('signaling_transport_close'); assert.deepEqual(closed, ['signaling_transport_close']); assert.equal(clock.pending(), 0); clock.advance(1_000_000); assert.deepEqual(closed, ['signaling_transport_close'], 'a stale deadline cannot fire later');
});
