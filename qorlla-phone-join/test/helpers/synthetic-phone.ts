import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { RtpHeader, RtpPacket, SrtpSession } from 'werift-rtp';
import { parse, serialize, header, tagOf, type SipMessage, type SipRequest, type SipResponse, type Header } from '../../src/sip/message.js';
import { answerChallenge } from '../../src/sip/digest.js';
import { buildOffer } from '../../src/sip/sdp.js';
import { encode, decode } from '../../src/media/g711.js';
import { dtmfPayload } from '../../src/media/dtmf.js';

/**
 * A SYNTHETIC telephone for development tests: its own UDP sockets, real SIP signalling with digest, real RTP/SRTP with G.711, DTMF, and controllable loss / jitter / silence. It is test machinery, not a carrier:
 * nothing it proves is production certification.
 */
export type PhoneOptions = { gateway: { address: string; port: number }; username?: string; password?: string; number?: string; secure?: boolean; codecs?: ('PCMU' | 'PCMA')[]; dtmfPt?: number | null; direction?: string; mediaIp?: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export class SyntheticPhone {
  readonly inbox: SipMessage[] = []; sip!: dgram.Socket; rtp!: dgram.Socket; sipPort = 0; rtpPort = 0;
  sipCallId = crypto.randomBytes(8).toString('hex') + '@phone'; fromTag = crypto.randomBytes(5).toString('hex'); toTag?: string; cseq = 1; answerSdp = ''; target?: { address: string; port: number };
  private localKey: Buffer = crypto.randomBytes(30); private remoteKey?: Buffer; private out?: SrtpSession; private inn?: SrtpSession;
  private seq = crypto.randomInt(0, 60000); private ts = crypto.randomInt(0, 1_000_000); private ssrc = crypto.randomInt(1, 1e9); private pt = 0; private codec: 'PCMU' | 'PCMA' = 'PCMU'; private dtmfPt = 101; private sender?: NodeJS.Timeout;
  lastAuth = ''; digitLog: { d: string; at: number }[] = []; received: Int16Array[] = []; receivedPackets = 0; dtmfSent = 0; rawRtp: Buffer[] = [];
  constructor(readonly o: PhoneOptions) {}
  static async create(o: PhoneOptions) { const p = new SyntheticPhone(o); await p.bind(); return p; }
  private async bind() {
    this.sip = dgram.createSocket('udp4'); this.rtp = dgram.createSocket('udp4');
    await Promise.all([new Promise<void>((r) => this.sip.bind(0, '127.0.0.1', r)), new Promise<void>((r) => this.rtp.bind(0, '127.0.0.1', r))]);
    this.sipPort = this.sip.address().port; this.rtpPort = this.rtp.address().port;
    this.sip.on('message', (m) => { const x = parse(m); if (x) this.inbox.push(x); });
    this.rtp.on('message', (m) => this.onRtp(m));
  }
  private onRtp(raw: Buffer) {
    this.rawRtp.push(raw); if (!this.inn) return; let plain = raw; if (this.remoteKey) { try { plain = this.inn.decrypt(raw) as Buffer; } catch { return; } }
    const p = RtpPacket.deSerialize(plain); if (p.header.payloadType !== this.pt) return; this.receivedPackets++; this.received.push(decode(this.codec, p.payload));
  }
  async wait<T extends SipMessage = SipMessage>(pred: (m: SipMessage) => boolean, ms = 3000): Promise<T> {
    const end = Date.now() + ms; let seen = 0;
    while (Date.now() < end) { for (; seen < this.inbox.length; seen++) if (pred(this.inbox[seen])) return this.inbox[seen] as T; await sleep(5); }
    throw new Error('timed out waiting for a SIP message; received: ' + this.inbox.map((m) => (m.kind === 'response' ? m.status : m.method)).join(','));
  }
  responses = (status?: number) => this.inbox.filter((m): m is SipResponse => m.kind === 'response' && (status === undefined || m.status === status));
  requests = (method: string) => this.inbox.filter((m): m is SipRequest => m.kind === 'request' && m.method === method);
  send(buf: Buffer) { this.sip.send(buf, this.o.gateway.port, this.o.gateway.address); }
  private uri(): string { return `sip:${(this.o.number ?? '+12025550100').replace(/^$/, '+12025550100')}@${this.o.gateway.address}:${this.o.gateway.port}`; }
  build(method: string, o: { cseq?: number; branch?: string; extra?: Header[]; body?: string; toTag?: string; uri?: string } = {}): SipRequest {
    const to = `<sip:${this.dialed()}@${this.o.gateway.address}>` + (o.toTag ? `;tag=${o.toTag}` : '');
    return { kind: 'request', method, uri: o.uri ?? this.uri(), body: o.body ?? '', headers: [['Via', `SIP/2.0/UDP 127.0.0.1:${this.sipPort};branch=${o.branch ?? 'z9hG4bK' + crypto.randomBytes(6).toString('hex')};rport`], ['Max-Forwards', '70'],
      ['From', `<sip:+12025550123@127.0.0.1>;tag=${this.fromTag}`], ['To', to], ['Call-ID', this.sipCallId], ['CSeq', `${o.cseq ?? this.cseq} ${method}`], ['Contact', `<sip:phone@127.0.0.1:${this.sipPort}>`], ...(o.extra ?? []), ...(o.body ? ([['Content-Type', 'application/sdp']] as Header[]) : [])] };
  }
  private dialed() { return (this.o.number ?? '+12025550100'); }
  /** INVITE with the digest dance. Resolves with the final response (200, or the refusal). */
  async invite(o: { auth?: boolean; badPassword?: boolean; offerSdp?: string; replayAuth?: string } = {}): Promise<SipResponse> {
    const { sdp, key } = o.offerSdp ? { sdp: o.offerSdp, key: undefined } : buildOffer({ ip: this.o.mediaIp ?? '127.0.0.1', port: this.rtpPort, secure: this.o.secure, codecs: this.o.codecs, dtmfPt: this.o.dtmfPt, key: this.localKey, direction: this.o.direction });
    if (key) this.localKey = key; const uri = this.uri();
    let req = this.build('INVITE', { body: sdp }); this.send(serialize(req)); this.target = this.o.gateway;
    if (o.auth === false) return this.finalResponse(req);
    let r = await this.finalResponse(req);
    if (r.status === 401) {
      const ch = r.headers.filter(([n]) => n === 'WWW-Authenticate').map(([, v]) => v).sort().reverse()[0];                       // the strongest offered
      this.cseq++; const authz = o.replayAuth ?? answerChallenge({ challenge: ch, method: 'INVITE', uri, username: this.o.username ?? 'trunk1', password: o.badPassword ? 'wrong-password' : (this.o.password ?? 'trunk-secret') });
      this.lastAuth = authz; req = this.build('INVITE', { body: sdp, extra: [['Authorization', authz]] }); this.send(serialize(req)); r = await this.finalResponse(req);
    }
    if (r.status === 200) { this.toTag = tagOf(header(r, 'To')); this.answerSdp = r.body; this.send(serialize(this.build('ACK', { cseq: this.cseq, toTag: this.toTag }))); this.setupMedia(r.body); }
    return r;
  }
  private async finalResponse(req: SipRequest): Promise<SipResponse> {
    const branch = /branch=([^;]+)/.exec(header(req, 'Via')!)![1];
    return this.wait<SipResponse>((m) => m.kind === 'response' && m.status >= 200 && header(m, 'Via')!.includes(branch) && header(m, 'CSeq') === header(req, 'CSeq'), 4000);
  }
  private setupMedia(sdp: string) {
    const port = Number(/m=audio (\d+)/.exec(sdp)![1]); this.target = { address: this.o.gateway.address, port }; this.pt = Number(/m=audio \d+ \S+ (\d+)/.exec(sdp)![1]); this.codec = this.pt === 0 ? 'PCMU' : 'PCMA';
    const c = /a=crypto:\d+ AES_CM_128_HMAC_SHA1_80 inline:([A-Za-z0-9+/]{40})/.exec(sdp);
    if (c) { this.remoteKey = Buffer.from(c[1], 'base64'); const L = this.localKey, R = this.remoteKey; const keys = { localMasterKey: L.subarray(0, 16), localMasterSalt: L.subarray(16, 30), remoteMasterKey: R.subarray(0, 16), remoteMasterSalt: R.subarray(16, 30) }; this.out = new SrtpSession({ keys, profile: 1 }); this.inn = new SrtpSession({ keys, profile: 1 }); }
    else this.inn = {} as SrtpSession;
    this.dtmfPt = Number(/a=rtpmap:(\d+) telephone-event/.exec(sdp)?.[1] ?? 101);
  }
  /** Sends one RTP packet to the gateway (encrypted when the call is SRTP). */
  private closed = false;
  rtpOut(payload: Buffer, o: { pt?: number; seq?: number; ts?: number; marker?: boolean } = {}) {
    if (this.closed) return Buffer.alloc(0); if (!this.target) throw new Error('no media target'); const h = new RtpHeader({ version: 2, payloadType: o.pt ?? this.pt, sequenceNumber: o.seq ?? this.seq, timestamp: o.ts ?? this.ts, ssrc: this.ssrc, marker: !!o.marker });
    const buf = this.out ? (this.out.encrypt(payload, h) as Buffer) : new RtpPacket(h, payload).serialize(); try { this.rtp.send(buf, this.target.port, this.target.address); } catch { /* closed while a delayed packet was pending */ } return buf;
  }
  frame(pcm: Int16Array, o: { seq?: number; ts?: number } = {}) { const b = this.rtpOut(encode(this.codec, pcm), o); this.seq = ((o.seq ?? this.seq) + 1) & 0xffff; this.ts = ((o.ts ?? this.ts) + pcm.length) >>> 0; return b; }
  /** Streams a sine tone as 20 ms frames until stop(); `lossPct` drops frames, `jitterMs` delays each by a random amount (which also reorders), `dupPct` repeats frames. */
  tone(hz: number, o: { lossPct?: number; jitterMs?: number; dupPct?: number; amplitude?: number } = {}) {
    this.stopTone(); let n = 0; const amp = o.amplitude ?? 8000;
    this.sender = setInterval(() => {
      const pcm = new Int16Array(160); for (let i = 0; i < 160; i++) pcm[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * (n * 160 + i)) / 8000)); n++;
      const seq = this.seq, ts = this.ts; this.seq = (this.seq + 1) & 0xffff; this.ts = (this.ts + 160) >>> 0;
      if (Math.random() * 100 < (o.lossPct ?? 0)) return; const go = () => { const b = this.rtpOut(encode(this.codec, pcm), { seq, ts }); if (!this.closed && Math.random() * 100 < (o.dupPct ?? 0)) { try { this.rtp.send(b, this.target!.port, this.target!.address); } catch { /* closed */ } } };
      o.jitterMs ? setTimeout(go, Math.random() * o.jitterMs) : go();
    }, 20); this.sender.unref?.();
  }
  stopTone() { clearInterval(this.sender); this.sender = undefined; }
  /** RFC 4733 digit: start packets, then three end packets (as phones send them), all with the same RTP timestamp. */
  async digit(d: string) {
    this.digitLog.push({ d, at: Date.now() });
    const ts = this.ts; for (let i = 0; i < 3; i++) { this.rtpOut(dtmfPayload(d, 160 * (i + 1), false), { pt: this.dtmfPt, ts, seq: this.seq++ & 0xffff, marker: i === 0 }); await sleep(20); }
    for (let i = 0; i < 3; i++) this.rtpOut(dtmfPayload(d, 640, true), { pt: this.dtmfPt, ts, seq: this.seq++ & 0xffff }); this.ts = (this.ts + 960) >>> 0; this.dtmfSent++; await sleep(60);
  }
  async digits(s: string) { for (const d of s) await this.digit(d); }
  bye() { this.cseq++; this.send(serialize(this.build('BYE', { cseq: this.cseq, toTag: this.toTag }))); }
  cancel(branch: string) { this.send(serialize(this.build('CANCEL', { cseq: 1, branch }))); }
  /** Mean power of the received audio at `hz` (Goertzel), 0..1 of full scale; used to prove that a specific tone really arrived. */
  power(hz: number, fromFrame = 0): number {
    const frames = this.received.slice(fromFrame); if (!frames.length) return 0; const x = new Int16Array(frames.length * 160); frames.forEach((f, i) => x.set(f, i * 160));
    const w = (2 * Math.PI * hz) / 8000, c = 2 * Math.cos(w); let a = 0, b = 0; for (const v of x) { const t = v / 32768 + c * a - b; b = a; a = t; } return (a * a + b * b - c * a * b) / (x.length * x.length / 4);
  }
  close() { this.closed = true; this.stopTone(); try { this.sip.close(); } catch { /* closed */ } try { this.rtp.close(); } catch { /* closed */ } }
}
