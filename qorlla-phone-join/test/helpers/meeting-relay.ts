import { RTCPeerConnection, MediaStreamTrack, RtpHeader, RtpPacket, usePCMU, useOPUS } from 'werift';
import { encode, decode } from '../../src/media/g711.js';
import type { SignalingPort, SignalData } from '../../src/media/mesh-peer.js';

/**
 * TEST MACHINERY, not product code. (1) `MeetingRelay` behaves like Qorlla Meet's socket relay: a joiner gets the roster, signals are relayed to ONE online participant, only offer / answer / candidate are accepted (the
 * real server's allow-list), and every message is passed through JSON so nothing non-serialisable can sneak through. (2) `Browser` re-implements the handshake of public/app.js with werift (initiator offers, epochs,
 * lower id yields on glare) so the gateway's mesh peer is exercised against the same protocol logic the browsers run. A real-browser run against the real Meet is the next integration step.
 */
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const ALLOWED = ['offer', 'answer', 'candidate', 'restart', 'rebuild'];       // the real server's list since A5: restart / rebuild are the browsers' recovery requests
export class MeetingRelay {
  readonly members = new Map<string, { deliver: (from: string, data: SignalData) => void; left: (id: string) => void }>(); rejected: string[] = []; relayed = 0;
  join(id: string, deliver: (from: string, data: SignalData) => void, left: (id: string) => void) { const roster = [...this.members.keys()]; this.members.set(id, { deliver, left }); return roster; }
  leave(id: string) { this.members.delete(id); for (const m of this.members.values()) m.left(id); }
  signal(from: string, to: string, data: SignalData) {
    if (typeof to !== 'string' || !data || !ALLOWED.includes(data.type)) { this.rejected.push(String(data?.type)); return; }            // 'restart' / 'rebuild' are not on the real server's list today
    const target = this.members.get(to); if (!target) return; this.relayed++; const copy = clone(data); setImmediate(() => target.deliver(from, copy));
  }
  /** The port a gateway mesh peer uses. */
  port(selfId: string): SignalingPort {
    let onSignal: (f: string, d: SignalData) => void = () => undefined, onLeft: (id: string) => void = () => undefined, onClosed: (r: string) => void = () => undefined, open = true;
    const roster = this.join(selfId, (f, d) => open && onSignal(f, d), (id) => open && onLeft(id));
    return { selfId, roster: () => roster, send: (to, data) => { if (open) this.signal(selfId, to, data); }, onSignal: (cb) => { onSignal = cb; }, onPeerLeft: (cb) => { onLeft = cb; }, onClosed: (cb) => { onClosed = cb; },
      close: () => { if (!open) return; open = false; this.members.delete(selfId); for (const m of this.members.values()) m.left(selfId); onClosed('closed'); } };
  }
}

type BPeer = { pc: RTCPeerConnection; track: MediaStreamTrack; epoch?: string; remoteEpoch?: string; queue: unknown[]; seq: number; ts: number; connected: boolean };
export class Browser {
  readonly peers = new Map<string, BPeer>(); offerUfrags: string[] = []; heard: Int16Array[] = []; private timer?: NodeJS.Timeout; private n = 0; closed = false; opusOffered = 0;
  constructor(readonly id: string, private readonly relay: MeetingRelay, private readonly hz: number | null) {}
  join() { const roster = this.relay.join(this.id, (f, d) => { void this.onSignal(f, d).catch(() => undefined); }, (id) => this.drop(id)); for (const id of roster) this.create(id, true); this.timer = setInterval(() => this.speak(), 20); this.timer.unref?.(); return this; }
  private send(to: string, d: SignalData) { if (!this.closed) this.relay.signal(this.id, to, d); }
  private create(id: string, initiator: boolean): BPeer {
    const have = this.peers.get(id); if (have) return have; const pc = new RTCPeerConnection({ codecs: { audio: [useOPUS(), usePCMU()] }, iceServers: [] }), track = new MediaStreamTrack({ kind: 'audio' });
    const p: BPeer = { pc, track, queue: [], seq: 1000, ts: 5000, connected: false }; if (initiator) p.epoch = Math.random().toString(36).slice(2); this.peers.set(id, p); pc.addTrack(track);
    pc.onIceCandidate.subscribe((c) => { if (c) this.send(id, { type: 'candidate', candidate: c.toJSON(), epoch: p.epoch ?? p.remoteEpoch }); });
    pc.onTrack.subscribe((t) => { t.onReceiveRtp.subscribe((rtp) => { if (rtp.header.payloadType === 0 && rtp.payload.length === 160) this.heard.push(decode('PCMU', rtp.payload)); }); });
    pc.connectionStateChange.subscribe((s) => { p.connected = s === 'connected'; });
    if (initiator) void pc.createOffer().then(async (o) => { this.opusOffered += /opus/i.test(o.sdp) ? 1 : 0; await pc.setLocalDescription(o); this.send(id, { type: 'offer', sdp: { type: 'offer', sdp: pc.localDescription!.sdp }, epoch: p.epoch! }); });
    return p;
  }
  private async onSignal(id: string, data: SignalData) {
    let p = this.peers.get(id);
    if (data.type === 'offer') {
      if (p?.epoch) { if (this.id < id) { this.drop(id); p = undefined; } else return; } else if (p?.remoteEpoch && p.remoteEpoch !== data.epoch) { this.drop(id); p = undefined; }
      p ??= this.create(id, false); p.remoteEpoch = data.epoch; this.offerUfrags.push(/a=ice-ufrag:(\S+)/.exec(data.sdp.sdp)?.[1] ?? ''); await p.pc.setRemoteDescription(data.sdp as never); for (const c of p.queue.splice(0)) await p.pc.addIceCandidate(c as never).catch(() => undefined);
      const a = await p.pc.createAnswer(); await p.pc.setLocalDescription(a); this.send(id, { type: 'answer', sdp: { type: 'answer', sdp: p.pc.localDescription!.sdp }, epoch: data.epoch }); return;
    }
    if (!p || ('epoch' in data && data.epoch && data.epoch !== (p.epoch ?? p.remoteEpoch))) return;
    if (data.type === 'answer' && p.pc.signalingState === 'have-local-offer') { await p.pc.setRemoteDescription(data.sdp as never); for (const c of p.queue.splice(0)) await p.pc.addIceCandidate(c as never).catch(() => undefined); }
    else if (data.type === 'candidate') { if (p.pc.remoteDescription) await p.pc.addIceCandidate(data.candidate as never).catch(() => undefined); else p.queue.push(data.candidate); }
  }
  private speak() {
    if (this.hz === null || this.closed) return; const pcm = new Int16Array(160); for (let i = 0; i < 160; i++) pcm[i] = Math.round(7000 * Math.sin((2 * Math.PI * this.hz * (this.n * 160 + i)) / 8000)); this.n++; const payload = encode('PCMU', pcm);
    for (const p of this.peers.values()) if (p.connected) { try { p.track.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 0, sequenceNumber: p.seq++ & 0xffff, timestamp: p.ts, ssrc: 777 }), payload)); p.ts = (p.ts + 160) >>> 0; } catch { /* closing */ } }
  }
  private drop(id: string) { const p = this.peers.get(id); if (!p) return; this.peers.delete(id); void p.pc.close().catch(() => undefined); }
  /** Starts an offer toward `id` as if it had just appeared in this browser's roster (used to create a genuine simultaneous offer). */
  initiate(id: string) { this.create(id, true); }
  /** What a browser does when its connection to `id` is down (public/app.js recoverPeer, answering side): ask the offerer to restart ICE. */
  restart(id: string) { const p = this.peers.get(id); if (p) this.send(id, { type: 'restart', epoch: p.remoteEpoch }); }
  connectedTo(id: string) { return !!this.peers.get(id)?.connected; }
  leave() { this.closed = true; clearInterval(this.timer); this.relay.leave(this.id); for (const id of [...this.peers.keys()]) this.drop(id); }
}
