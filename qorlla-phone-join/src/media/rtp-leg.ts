import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { RtpHeader, RtpPacket, SrtpSession } from 'werift-rtp';
import { encode, decode, rmsDb, type G711 } from './g711.js';
import { DtmfDecoder } from './dtmf.js';
import { JitterBuffer, type JitterStats } from './jitter.js';

/**
 * The TELEPHONE side of one call: an RTP/SRTP leg over UDP carrying G.711. It owns a socket, a playout clock and nothing else. Frames in -> `pcm` events (after the jitter buffer); frames out <- `source()` (the meeting
 * mix), or silence so RTP never stops. Security: SRTP (SDES keys from the SDP), packets only from the address the SDP named (no latching onto whoever sends first), payload types and sizes validated, a hard inactivity
 * timeout, and every counter an operator needs. Counters count AUTHENTIC, VALID packets only: a flood of garbage never looks like audio.
 */
export type LegConfig = {
  bindHost: string; portRange: readonly [number, number]; remote: { address: string; port: number }; codec: G711; pt: number; dtmfPt?: number; ptime: number;
  srtp?: { localKey: Buffer; remoteKey: Buffer }; jitterDepth?: number; inactivityMs?: number; allowPortLatch?: boolean;
};
export type LegStats = {
  inboundPackets: number; outboundPackets: number; inboundBytes: number; authFailures: number; wrongSource: number; malformed: number; wrongPayload: number; dtmfEvents: number;
  jitter: JitterStats; openedAt: number; lastInboundAt: number; lastVoiceAt: number; lastRmsDb: number; encrypted: boolean; codec: G711; remoteLatchedPort: number;
};
const FRAME_SAMPLES = (ptime: number) => (8000 * ptime) / 1000, MAX_DATAGRAM = 1500;
export class RtpLeg extends EventEmitter {
  private sock?: dgram.Socket; private clock?: NodeJS.Timeout; private closed = false; private tickN = 0; private t0 = 0;
  private readonly jb: JitterBuffer<Int16Array>; private readonly dtmf = new DtmfDecoder(); private readonly inSession?: SrtpSession; private readonly outSession?: SrtpSession;
  private seq = crypto.randomInt(0, 0xffff); private ts = crypto.randomInt(0, 0x7fffffff); private readonly ssrc = crypto.randomInt(1, 0x7fffffff);
  private remote: { address: string; port: number }; private lastRtpTs = new Map<number, number>();
  private readonly s: Omit<LegStats, 'jitter'>;
  /** The meeting-side mix for this leg, called once per frame period. Return null for silence. */
  source: (() => Int16Array | null) | null = null;
  constructor(private readonly c: LegConfig) {
    super(); this.remote = { ...c.remote }; this.jb = new JitterBuffer(c.jitterDepth ?? 3, 3, c.ptime);
    if (c.srtp) {
      const mk = (k: Buffer) => ({ key: k.subarray(0, 16), salt: k.subarray(16, 30) }), l = mk(c.srtp.localKey), r = mk(c.srtp.remoteKey);
      const keys = { localMasterKey: l.key, localMasterSalt: l.salt, remoteMasterKey: r.key, remoteMasterSalt: r.salt };
      this.inSession = new SrtpSession({ keys, profile: 1 }); this.outSession = new SrtpSession({ keys, profile: 1 });
    }
    this.s = { inboundPackets: 0, outboundPackets: 0, inboundBytes: 0, authFailures: 0, wrongSource: 0, malformed: 0, wrongPayload: 0, dtmfEvents: 0, openedAt: 0, lastInboundAt: 0, lastVoiceAt: 0, lastRmsDb: -Infinity, encrypted: !!c.srtp, codec: c.codec, remoteLatchedPort: c.remote.port };
  }
  get port(): number { return (this.sock?.address() as { port: number } | undefined)?.port ?? 0; }
  async open(): Promise<number> {
    const [lo, hi] = this.c.portRange; const sock = dgram.createSocket({ type: 'udp4', recvBufferSize: 262144 }); let bound = false;
    for (let i = 0; i < 60 && !bound; i++) {
      const p = lo === hi ? lo : lo + 2 * crypto.randomInt(0, Math.floor((hi - lo) / 2) + 1);
      bound = await new Promise<boolean>((res) => { const fail = () => res(false); sock.once('error', fail); sock.bind(p, this.c.bindHost, () => { sock.off('error', fail); res(true); }); });
      if (!bound && lo === hi) break;
    }
    if (!bound) { try { sock.close(); } catch { /* never bound */ } throw new Error('no free RTP port in the configured range'); }
    this.sock = sock; sock.on('message', (m, r) => { try { this.onPacket(m, r); } catch { this.s.malformed++; } }); sock.on('error', () => this.close('socket_error'));
    this.s.openedAt = Date.now(); this.s.lastInboundAt = Date.now(); this.t0 = performance.now(); this.schedule(); return this.port;
  }
  private schedule() { if (this.closed) return; this.tickN++; const due = this.t0 + this.tickN * this.c.ptime, wait = Math.max(0, due - performance.now()); this.clock = setTimeout(() => { this.tick(); this.schedule(); }, wait); this.clock.unref?.(); }

  private onPacket(raw: Buffer, from: dgram.RemoteInfo) {
    if (this.closed) return; if (raw.length < 12 || raw.length > MAX_DATAGRAM) { this.s.malformed++; return; }
    if (from.address !== this.remote.address || (from.port !== this.remote.port && !this.c.allowPortLatch)) { this.s.wrongSource++; return; }
    if ((raw[0] & 0xc0) !== 0x80) { this.s.malformed++; return; }                                                       // RTP version 2 only
    if (raw[1] >= 192 && raw[1] <= 223) return;                                                                         // RTCP multiplexed on the same port: not audio, ignored
    let plain: Buffer = raw;
    if (this.inSession) { try { plain = this.inSession.decrypt(raw) as Buffer; } catch { this.s.authFailures++; return; } }        // authentication failed: dropped, never counted as audio
    let pkt: RtpPacket; try { pkt = RtpPacket.deSerialize(plain); } catch { this.s.malformed++; return; }
    if (from.port !== this.remote.port) { this.remote.port = from.port; this.s.remoteLatchedPort = from.port; }                  // only reachable with allowPortLatch, and only AFTER the packet authenticated
    const h = pkt.header, now = Date.now();
    if (h.payloadType === this.c.dtmfPt && this.c.dtmfPt !== undefined) {
      this.jb.skip(h.sequenceNumber); const d = this.dtmf.decode(h.ssrc, h.timestamp, pkt.payload); this.s.inboundPackets++; this.s.lastInboundAt = now; if (d) { this.s.dtmfEvents++; this.emit('dtmf', d); } return;
    }
    if (h.payloadType !== this.c.pt) { this.s.wrongPayload++; return; }
    const n = pkt.payload.length, frame = FRAME_SAMPLES(this.c.ptime); if (n === 0 || n > frame * 3 || n % frame !== 0 && n !== frame) { this.s.malformed++; return; }
    this.s.inboundPackets++; this.s.inboundBytes += n; this.s.lastInboundAt = now;
    const pcm = decode(this.c.codec, pkt.payload); this.jb.push(h.sequenceNumber, pcm, performance.now(), h.timestamp / 8);
  }

  private tick() {
    if (this.closed) return; const now = Date.now();
    const out = this.jb.pop(); if (out) { const db = rmsDb(out.frame); this.s.lastRmsDb = db; if (db > -50) this.s.lastVoiceAt = now; this.emit('pcm', out.frame, out.concealed); }
    this.sendFrame(this.source?.() ?? new Int16Array(FRAME_SAMPLES(this.c.ptime)));
    if (now - this.s.lastInboundAt > (this.c.inactivityMs ?? 10_000)) this.close('no_inbound_rtp');                                    // the telephone stopped sending: the call is dead
  }
  private sendFrame(pcm: Int16Array) {
    if (!this.sock || this.closed) return; const header = new RtpHeader({ version: 2, payloadType: this.c.pt, sequenceNumber: this.seq, timestamp: this.ts, ssrc: this.ssrc, marker: this.s.outboundPackets === 0 });
    const payload = encode(this.c.codec, pcm); this.seq = (this.seq + 1) & 0xffff; this.ts = (this.ts + pcm.length) >>> 0;
    const buf = this.outSession ? (this.outSession.encrypt(payload, header) as Buffer) : new RtpPacket(header, payload).serialize();
    this.sock.send(buf, this.remote.port, this.remote.address, (e) => { if (!e) this.s.outboundPackets++; });
  }
  stats(): LegStats { return { ...this.s, jitter: { ...this.jb.stats } }; }
  close(reason = 'closed') { if (this.closed) return; this.closed = true; clearTimeout(this.clock); try { this.sock?.close(); } catch { /* already closed */ } this.sock = undefined; this.source = null; this.emit('closed', reason); this.removeAllListeners('pcm'); }
}
