import crypto from 'node:crypto';
import { RTCPeerConnection, MediaStreamTrack, RtpHeader, RtpPacket, usePCMU, type RTCIceCandidate } from 'werift';
import { encode, decode } from './g711.js';
import { JitterBuffer } from './jitter.js';
import type { MeetingAudio, MeetingAudioSession } from './sip-media-gateway.js';

/**
 * The gateway as a PARTICIPANT of the meeting mesh. Qorlla Meet has no server-side mixer or SFU: every browser holds one RTCPeerConnection per other participant and the server only relays offers, answers and ICE
 * candidates. So the telephone caller is represented by a WebRTC peer that speaks THE SAME handshake as the browsers (public/app.js: the joiner offers to everyone already present, every message carries the pair's
 * epoch, on a simultaneous offer the lower participant id yields) and carries audio as G.711 PCMU over DTLS-SRTP (a codec every browser must support, so nothing is transcoded).
 *   meeting -> telephone: each peer's frames go through a small jitter buffer and are MIXED (sum, clipped) into the one 20 ms frame the telephone leg plays.
 *   telephone -> meeting: the caller's frame is encoded once and sent to every connected peer.
 * The browsers already hear each other directly; the caller's audio is the only thing this peer adds, and the phone only hears the mix of the others (never its own voice).
 * Signalling is a PORT (`SignalingPort`): Meet's socket.io relay is one binding, an in-process relay is another (tests).
 */
export type SignalData =
  | { type: 'offer' | 'answer'; sdp: { type: string; sdp: string }; epoch: string }
  | { type: 'candidate'; candidate: unknown; epoch?: string }
  | { type: 'restart' | 'rebuild'; epoch?: string };
export interface SignalingPort {
  readonly selfId: string;
  /** The Meet verification credential id behind this signalling session (when the binding used one). */
  readonly credentialJti?: string;
  /** Participants already in the meeting when we joined. New participants arrive through onPeerJoined; they offer to us (the joiner always offers). */
  roster(): string[];
  send(to: string, data: SignalData): void;
  onSignal(cb: (from: string, data: SignalData) => void): void;
  onPeerLeft(cb: (id: string) => void): void;
  onClosed(cb: (reason: string) => void): void;
  close(): void;
}
export type SignalingFactory = (o: { callId: string; meetingSessionId: string; mediaToken?: string; signal: AbortSignal }) => Promise<SignalingPort>;
export type MeshOptions = { signaling: SignalingFactory; iceServers?: { urls: string | string[]; username?: string; credential?: string }[]; maxRestarts?: number; connectTimeoutMs?: number; jitterDepth?: number };

type Peer = {
  id: string; pc: RTCPeerConnection; track: MediaStreamTrack; epoch?: string; remoteEpoch?: string; queue: unknown[]; restarts: number; jb: JitterBuffer<Int16Array>;
  seq: number; ts: number; ssrc: number; connected: boolean; grace?: NodeJS.Timeout; closed: boolean; decoded: number;
};
const newEpoch = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
export class MeshPeerAudio implements MeetingAudio {
  constructor(private readonly o: MeshOptions) {}
  async open(a: { callId: string; meetingSessionId: string; mediaToken?: string; signal: AbortSignal }): Promise<MeetingAudioSession> {
    const port = await this.o.signaling(a); if (a.signal.aborted) { port.close(); throw new Error('cancelled'); }
    const session = new MeshSession(port, this.o); session.start(); return session;
  }
}

class MeshSession implements MeetingAudioSession {
  get sessionId() { return this.port.credentialJti; }
  readonly encrypted = true;                                                     // DTLS-SRTP is the only transport werift offers; a peer that is not connected carries nothing
  private readonly peers = new Map<string, Peer>(); private closedFlag = false; private listeners: ((r: string) => void)[] = [];
  private fromMeeting = 0; private toMeeting = 0; private lastFrom = 0;
  constructor(private readonly port: SignalingPort, private readonly o: MeshOptions) {}
  start() {
    this.port.onSignal((from, data) => { void this.onSignal(from, data).catch(() => undefined); });
    this.port.onPeerLeft((id) => this.drop(id));
    this.port.onClosed((r) => { void this.close('signaling_' + r); });
    for (const id of this.port.roster()) if (id !== this.port.selfId) this.create(id, true);                 // the joiner offers to everyone already present
  }
  isConnected() { return !this.closedFlag && [...this.peers.values()].some((p) => p.connected); }
  stats() { return { framesFromMeeting: this.fromMeeting, framesToMeeting: this.toMeeting, peers: this.peers.size, lastFromMeetingAt: this.lastFrom }; }
  onClosed(l: (r: string) => void) { this.listeners.push(l); }

  /** meeting -> telephone: one tick = one frame from every peer that has one, summed. */
  pullFrame(): Int16Array | null {
    if (this.closedFlag) return null; let mix: Int32Array | null = null;
    for (const p of this.peers.values()) {
      const out = p.jb.pop(); if (!out) continue; mix ??= new Int32Array(160); const f = out.frame; for (let i = 0; i < 160; i++) mix[i] += f[i];
    }
    if (!mix) return null; const pcm = new Int16Array(160); for (let i = 0; i < 160; i++) pcm[i] = Math.max(-32768, Math.min(32767, mix[i])); this.fromMeeting++; this.lastFrom = Date.now(); return pcm;
  }
  /** telephone -> meeting. */
  pushFrame(pcm: Int16Array) {
    if (this.closedFlag) return; const payload = encode('PCMU', pcm); let sent = false;
    for (const p of this.peers.values()) {
      if (!p.connected || p.closed) continue; const h = new RtpHeader({ version: 2, payloadType: 0, sequenceNumber: p.seq, timestamp: p.ts, ssrc: p.ssrc }); p.seq = (p.seq + 1) & 0xffff; p.ts = (p.ts + pcm.length) >>> 0;
      try { p.track.writeRtp(new RtpPacket(h, payload)); sent = true; } catch { /* the peer is going away */ }
    }
    if (sent) this.toMeeting++;
  }

  private create(id: string, initiator: boolean): Peer {
    const existing = this.peers.get(id); if (existing) return existing;
    const pc = new RTCPeerConnection({ codecs: { audio: [usePCMU()] }, iceServers: this.o.iceServers ?? [] }), track = new MediaStreamTrack({ kind: 'audio' });
    const peer: Peer = { id, pc, track, queue: [], restarts: 0, jb: new JitterBuffer<Int16Array>(this.o.jitterDepth ?? 2), seq: crypto.randomInt(0, 0xffff), ts: crypto.randomInt(0, 0x7fffffff), ssrc: crypto.randomInt(1, 0x7fffffff), connected: false, closed: false, decoded: 0 };
    if (initiator) peer.epoch = newEpoch(); this.peers.set(id, peer); pc.addTrack(track);
    pc.onIceCandidate.subscribe((c: RTCIceCandidate | undefined) => { if (c && !peer.closed) this.port.send(id, { type: 'candidate', candidate: c.toJSON(), epoch: peer.epoch ?? peer.remoteEpoch }); });
    pc.onTrack.subscribe((t: MediaStreamTrack) => { t.onReceiveRtp.subscribe((rtp: RtpPacket) => { if (peer.closed || rtp.header.payloadType !== 0 || rtp.payload.length !== 160) return; peer.decoded++; peer.jb.push(rtp.header.sequenceNumber, decode('PCMU', rtp.payload), performance.now(), rtp.header.timestamp / 8); }); });
    pc.connectionStateChange.subscribe((s: string) => {
      if (peer.closed) return; clearTimeout(peer.grace);
      if (s === 'connected') { peer.connected = true; peer.restarts = 0; }
      else { peer.connected = false; if (s === 'failed') this.recover(peer); else if (s === 'disconnected') { peer.grace = setTimeout(() => { if (!peer.closed && !peer.connected) this.recover(peer); }, 4000); peer.grace.unref?.(); } }
    });
    if (initiator) void this.offer(peer, false);
    return peer;
  }
  private async offer(peer: Peer, iceRestart: boolean) {
    try { const o = await peer.pc.createOffer(); await peer.pc.setLocalDescription(o); void iceRestart; this.port.send(peer.id, { type: 'offer', sdp: toInit(peer.pc.localDescription), epoch: peer.epoch! }); } catch { this.drop(peer.id); }
  }
  /** A connection that is down: the offering side re-offers, the answering side asks (browsers do the same); after repeated failures the pair is rebuilt from scratch. */
  private recover(peer: Peer) {
    if (this.closedFlag || this.peers.get(peer.id) !== peer) return;
    if (++peer.restarts > (this.o.maxRestarts ?? 3)) { const wasOfferer = !!peer.epoch; this.drop(peer.id); if (wasOfferer) this.create(peer.id, true); else this.port.send(peer.id, { type: 'rebuild', epoch: peer.remoteEpoch }); return; }
    if (peer.epoch && peer.pc.signalingState === 'stable') void this.offer(peer, true); else if (!peer.epoch) this.port.send(peer.id, { type: 'restart', epoch: peer.remoteEpoch });
  }
  private async onSignal(id: string, data: SignalData) {
    if (this.closedFlag || !data || typeof data !== 'object') return; let peer = this.peers.get(id);
    if (data.type === 'offer') {
      if (peer?.epoch) { if (this.port.selfId < id) { this.drop(id); peer = undefined; } else return; }                  // both sides offered at once: the lower id yields, the other keeps its offer
      else if (peer?.remoteEpoch && peer.remoteEpoch !== data.epoch) { this.drop(id); peer = undefined; }              // the other side rebuilt its connection
      peer ??= this.create(id, false); peer.remoteEpoch = data.epoch;
      await peer.pc.setRemoteDescription(data.sdp as never); await this.flush(peer); const answer = await peer.pc.createAnswer(); await peer.pc.setLocalDescription(answer);
      this.port.send(id, { type: 'answer', sdp: toInit(peer.pc.localDescription), epoch: data.epoch }); return;
    }
    if (!peer || ('epoch' in data && data.epoch && data.epoch !== (peer.epoch ?? peer.remoteEpoch))) return;                // a message from a connection that no longer exists
    if (data.type === 'answer') { if (peer.pc.signalingState === 'have-local-offer') { await peer.pc.setRemoteDescription(data.sdp as never); await this.flush(peer); } }
    else if (data.type === 'candidate') { if (peer.pc.remoteDescription) { try { await peer.pc.addIceCandidate(data.candidate as never); } catch { /* a candidate the stack rejects is ignored, as in the browsers */ } } else peer.queue.push(data.candidate); }
    else if (data.type === 'restart') { if (peer.epoch) this.recover(peer); }
    else if (data.type === 'rebuild') { if (peer.epoch) { this.drop(id); this.create(id, true); } }
  }
  private async flush(peer: Peer) { for (const c of peer.queue.splice(0)) { try { await peer.pc.addIceCandidate(c as never); } catch { /* ignored */ } } }
  private drop(id: string) { const p = this.peers.get(id); if (!p) return; p.closed = true; p.connected = false; clearTimeout(p.grace); this.peers.delete(id); void p.pc.close().catch(() => undefined); }
  async close(reason = 'closed') {
    if (this.closedFlag) return; this.closedFlag = true; for (const id of [...this.peers.keys()]) this.drop(id); try { this.port.close(); } catch { /* already closed */ }
    for (const l of this.listeners.splice(0)) { try { l(reason); } catch { /* a listener must not break teardown */ } }
  }
}
const toInit = (d: { type: string; sdp: string } | null | undefined) => ({ type: d?.type ?? 'offer', sdp: d?.sdp ?? '' });
