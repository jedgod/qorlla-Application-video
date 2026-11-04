import crypto from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';
import { parse, serialize, respond, header, topVia, cseq, tagOf, uriOf, type SipRequest, type SipResponse, type Header } from './message.js';
import { parseOffer, type Offer } from './sdp.js';
import type { SipIngress, InboundCall, EndReason, SipHealth, Logger } from './adapter.js';
import type { DigestAuthenticator } from './digest.js';

/**
 * Development SIP ingress over UDP (RFC 3261 server transactions for INVITE / CANCEL / BYE / ACK / OPTIONS). Production needs SIP over TLS from the carrier's SBC; this class exists so the whole admission and media path can
 * be driven by isolated synthetic phones. It implements the SipIngress contract and nothing else.
 *
 * Fail closed: an empty allowlist admits nobody; digest is required unless explicitly switched off; unparsable datagrams, unknown sources and flooding sources are DROPPED (no reply: a reply to a spoofed source is an
 * amplification vector). Authenticated-but-unacceptable requests get a proper final response.
 */
export type IngressConfig = {
  host: string; port: number; publicAddress?: string; realm: string; digest?: DigestAuthenticator; requireDigest?: boolean;
  allowedSources: readonly string[];                                  // exact IPs or IPv4 CIDRs; EMPTY means nobody
  maxCalls: number; maxInvitesPerSecond?: number; burst?: number; maxTrackedSources?: number;
  t1Ms?: number; t2Ms?: number; ringTimeoutMs?: number; log?: Logger; tombstoneMs?: number;
};
const T1 = 500, T2 = 4000;
export function ipAllowed(ip: string, list: readonly string[]): boolean {
  const v4 = (s: string) => (net.isIPv4(s) ? s.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0 : null);
  for (const e of list) {
    if (!e.includes('/')) { if (e === ip) return true; continue; }
    const [base, bitsS] = e.split('/'), bits = Number(bitsS), b = v4(base), x = v4(ip); if (b === null || x === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; if ((b & mask) === (x & mask)) return true;
  }
  return false;
}
const mask = (n: string) => (n.length > 4 ? '*'.repeat(n.length - 4) + n.slice(-4) : n);
type Remote = { address: string; port: number };
type Dialog = {
  key: string; id: string; sipCallId: string; remoteTag: string; localTag: string; remote: Remote; invite: SipRequest; inviteTx: string; state: 'ringing' | 'answered' | 'ended'; principal: string;
  ok?: Buffer; timers: Set<NodeJS.Timeout>; ended: ((r: EndReason) => void)[]; acked: boolean; ackWaiters: { ok: () => void; fail: (e: Error) => void }[]; byeCseq: number; byeSent: boolean; endReason?: EndReason; call?: InboundCall;
};

export class UdpSipIngress implements SipIngress {
  private sock?: dgram.Socket; private handler: (c: InboundCall) => void | Promise<void> = () => undefined;
  private readonly tx = new Map<string, { resp: Buffer; at: number; final: boolean }>();             // server transactions by key: what to repeat when the network repeats the request
  private readonly dialogs = new Map<string, Dialog>(); private readonly tomb = new Map<string, number>();
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly stats: SipHealth = { listening: false, activeCalls: 0, invitesAccepted: 0, invitesRejected: {}, retransmissionsAbsorbed: 0 };
  private bound: { address: string; port: number } = { address: '', port: 0 }; private stopped = false;
  private readonly t1: number; private readonly t2: number; private readonly log: Logger;
  constructor(private readonly c: IngressConfig) { this.t1 = c.t1Ms ?? T1; this.t2 = c.t2Ms ?? T2; this.log = c.log ?? (() => undefined); if (c.requireDigest !== false && !c.digest) throw new Error('digest authentication is required (pass a DigestAuthenticator, or set requireDigest:false for an ACL-only lab)'); }
  onInvite(h: (c: InboundCall) => void | Promise<void>) { this.handler = h; }
  health(): SipHealth { return { ...this.stats, listening: !!this.sock && !this.stopped, activeCalls: [...this.dialogs.values()].filter((d) => d.state !== 'ended').length, invitesRejected: { ...this.stats.invitesRejected } }; }
  async start() {
    this.sock = dgram.createSocket('udp4'); this.sock.on('message', (m, r) => { try { this.onDatagram(m, { address: r.address, port: r.port }); } catch (e) { this.err('datagram', e); } });
    await new Promise<void>((res, rej) => { this.sock!.once('error', rej); this.sock!.bind(this.c.port, this.c.host, () => { this.sock!.off('error', rej); res(); }); });
    this.sock.on('error', (e) => this.err('socket', e)); const a = this.sock.address(); this.bound = { address: this.c.publicAddress ?? a.address, port: a.port }; this.stats.listening = true; this.log({ event: 'sip_listening', address: a.address, port: a.port }); return this.bound;
  }
  async stop() {
    if (this.stopped) return; this.stopped = true;
    for (const d of [...this.dialogs.values()]) if (d.state === 'answered') this.sendBye(d), this.finish(d, 'shutdown'); else if (d.state === 'ringing') { this.final(d, 480, 'Temporarily Unavailable'); this.finish(d, 'shutdown'); }
    await new Promise<void>((r) => (this.sock ? this.sock.close(() => r()) : r())); this.sock = undefined;
  }
  private err(where: string, e: unknown) { this.stats.lastErrorAt = Date.now(); this.stats.lastError = where + ': ' + (e instanceof Error ? e.message : String(e)).slice(0, 120); this.log({ event: 'sip_error', where, message: this.stats.lastError }); }
  private reject(why: string) { this.stats.invitesRejected[why] = (this.stats.invitesRejected[why] ?? 0) + 1; }
  private send(buf: Buffer, to: Remote) { this.sock?.send(buf, to.port, to.address, (e) => { if (e) this.err('send', e); }); }

  private allow(ip: string): boolean {                                                                    // token bucket per source address, bounded table
    const rate = this.c.maxInvitesPerSecond ?? 5, burst = this.c.burst ?? 10, now = Date.now(); let b = this.buckets.get(ip);
    if (!b) { if (this.buckets.size >= (this.c.maxTrackedSources ?? 5000)) this.buckets.delete(this.buckets.keys().next().value as string); b = { tokens: burst, at: now }; this.buckets.set(ip, b); }
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate); b.at = now; if (b.tokens < 1) return false; b.tokens -= 1; return true;
  }
  private onDatagram(raw: Buffer, from: Remote) {
    if (this.stopped) return;
    if (!ipAllowed(from.address, this.c.allowedSources)) { this.reject('source_not_allowed'); this.log({ event: 'sip_dropped', reason: 'source_not_allowed', source: from.address }); return; }
    if (!this.allow(from.address)) { this.reject('rate_limited'); this.log({ event: 'sip_dropped', reason: 'rate_limited', source: from.address }); return; }
    const m = parse(raw); if (!m || m.kind !== 'request') { this.reject(m ? 'response_ignored' : 'malformed'); return; }
    const via = topVia(m), cs = cseq(m), callId = header(m, 'Call-ID'), fromH = header(m, 'From');
    if (!via || !cs || cs.method !== m.method && m.method !== 'ACK' || !callId || callId.length > 128 || !fromH || !header(m, 'To')) { this.reject('malformed'); return; }
    const txKey = `${via.branch}|${via.sentBy}|${m.method === 'ACK' || m.method === 'CANCEL' ? (m.method === 'CANCEL' ? 'INVITE' : 'ACK') : m.method}`;
    if (m.method === 'INVITE') return this.onInvite_(m, from, txKey, callId, fromH);
    if (m.method === 'ACK') return this.onAck(m, callId, fromH);
    if (m.method === 'CANCEL') return this.onCancel(m, from, txKey);
    if (m.method === 'BYE') return this.onBye(m, from, txKey, callId, fromH);
    if (m.method === 'OPTIONS') return this.reply(m, from, txKey, respond(m, 200, 'OK', { extra: [['Allow', 'INVITE, ACK, CANCEL, BYE, OPTIONS']] }));
    this.reply(m, from, txKey, respond(m, 405, 'Method Not Allowed', { extra: [['Allow', 'INVITE, ACK, CANCEL, BYE, OPTIONS']] }));
  }
  /** Sends a response and remembers it, so a retransmitted request is answered with the SAME bytes and never processed twice. */
  private reply(req: SipRequest, to: Remote, txKey: string, resp: SipResponse) {
    const buf = serialize(resp); if (resp.status >= 200 || !this.tx.has(txKey)) this.tx.set(txKey, { resp: buf, at: Date.now(), final: resp.status >= 200 }); this.send(buf, to);
    if (this.tx.size > 20000) for (const [k, v] of this.tx) if (Date.now() - v.at > 64 * this.t1 + 1000) this.tx.delete(k);
  }
  private repeated(txKey: string, to: Remote): boolean { const t = this.tx.get(txKey); if (!t) return false; this.stats.retransmissionsAbsorbed++; this.send(t.resp, to); return true; }
  private dialogOf(callId: string, remoteTag: string | undefined) { return remoteTag ? this.dialogs.get(`${callId}|${remoteTag}`) : undefined; }

  private onInvite_(m: SipRequest, from: Remote, txKey: string, sipCallId: string, fromH: string) {
    if (this.repeated(txKey, from)) return;                                                                // the same INVITE again (retransmission): repeat our last answer, do nothing else
    const remoteTag = tagOf(fromH); this.reply(m, from, txKey, respond(m, 100, 'Trying'));              // remembered, so a retransmission while the call is still ringing is absorbed too
    const refuse = (status: number, reason: string, why: string, extra: Header[] = []) => { this.reject(why); this.reply(m, from, txKey, respond(m, status, reason, { extra })); this.log({ event: 'sip_invite_refused', why, status, source: from.address }); };
    if (!remoteTag) return refuse(400, 'Bad Request', 'no_from_tag'); if (Number(header(m, 'Max-Forwards') ?? 70) <= 0) return refuse(483, 'Too Many Hops', 'max_forwards');
    let principal = 'acl:' + from.address;
    if (this.c.requireDigest !== false) {
      const r = this.c.digest!.verify('INVITE', m.uri, header(m, 'Authorization'));
      if (!r.ok) { if (r.reason === 'missing' || r.reason === 'stale') return refuse(401, 'Unauthorized', 'challenge', this.c.digest!.challenge(r.reason === 'stale').map((v) => ['WWW-Authenticate', v] as Header)); return refuse(403, 'Forbidden', 'auth_' + r.reason); }
      principal = r.username;
    }
    const key = `${sipCallId}|${remoteTag}`; if (this.dialogs.has(key)) return refuse(488, 'Not Acceptable Here', 'reinvite_unsupported');   // a second INVITE inside a dialog (re-INVITE, forked copy): not supported, and never a second call
    if ([...this.dialogs.values()].filter((d) => d.state !== 'ended').length >= this.c.maxCalls) return refuse(503, 'Service Unavailable', 'at_capacity', [['Retry-After', '30']]);
    const dialed = uriOf(m.uri)?.user ?? '', caller = uriOf(fromH)?.user ?? '';
    if (!/^\+?\d{3,20}$/.test(dialed)) return refuse(404, 'Not Found', 'bad_dialed_number');
    const offer = parseOffer(m.body); if ('refuse' in offer) return refuse(488, 'Not Acceptable Here', 'sdp_' + offer.refuse);
    const d: Dialog = { key, id: 'sip_' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 24), sipCallId, remoteTag, localTag: crypto.randomBytes(6).toString('hex'), remote: from, invite: m, inviteTx: txKey, state: 'ringing', principal, timers: new Set(), ended: [], acked: false, ackWaiters: [], byeCseq: 1, byeSent: false };
    this.dialogs.set(key, d); this.stats.invitesAccepted++;
    const call = this.makeCall(d, /^\+?\d{1,20}$/.test(caller) ? caller : 'anonymous', dialed, offer); d.call = call;
    this.timer(d, this.c.ringTimeoutMs ?? 30_000, () => { if (d.state === 'ringing') { this.final(d, 480, 'Temporarily Unavailable'); this.finish(d, 'rejected'); } });
    this.log({ event: 'sip_invite', callId: d.id, caller: mask(call.caller), principal, source: from.address });
    Promise.resolve().then(() => this.handler(call)).catch((e) => { this.err('handler', e); if (d.state === 'ringing') this.final(d, 500, 'Server Error'); this.finish(d, 'handler_error'); });
  }
  private makeCall(d: Dialog, caller: string, dialed: string, offer: Offer): InboundCall {
    const self = this;
    return { callId: d.id, caller, dialed, principal: d.principal, source: d.remote, offer,
      get state() { return d.state; },
      answer: (sdp: string) => self.answer(d, sdp), reject: (s, r) => { if (d.state === 'ringing') { self.final(d, s, r); self.finish(d, 'rejected'); } },
      hangup: () => { if (d.state === 'answered') { self.sendBye(d); self.finish(d, 'local_hangup'); } else if (d.state === 'ringing') { self.final(d, 487, 'Request Terminated'); self.finish(d, 'local_hangup'); } },
      onEnded: (l) => { if (d.state === 'ended') queueMicrotask(() => l(d.endReason!)); else d.ended.push(l); } };
  }
  private timer(d: Dialog, ms: number, fn: () => void) { const t = setTimeout(() => { d.timers.delete(t); fn(); }, ms); t.unref?.(); d.timers.add(t); return t; }
  private final(d: Dialog, status: number, reason: string, o: { extra?: Header[]; body?: string } = {}) { this.reply(d.invite, d.remote, d.inviteTx, respond(d.invite, status, reason, { toTag: d.localTag, ...o })); }
  private contact(): Header { return ['Contact', `<sip:qorlla@${this.bound.address}:${this.bound.port}>`]; }
  private answer(d: Dialog, sdp: string): Promise<void> {
    if (d.state !== 'ringing') return Promise.reject(new Error('call is not ringing'));
    d.state = 'answered'; this.final(d, 200, 'OK', { extra: [this.contact()], body: sdp }); d.ok = this.tx.get(d.inviteTx)!.resp;
    return new Promise<void>((resolve, reject) => {
      d.ackWaiters.push({ ok: resolve, fail: reject }); let wait = this.t1;
      const again = () => { if (d.acked || d.state !== 'answered') return; this.send(d.ok!, d.remote); wait = Math.min(wait * 2, this.t2); this.timer(d, wait, again); };
      this.timer(d, wait, again);
      this.timer(d, 64 * this.t1, () => { if (!d.acked && d.state === 'answered') { this.sendBye(d); this.finish(d, 'no_ack'); } });          // no ACK in 64*T1: the other side never confirmed; the call is dead
    });
  }
  private onAck(m: SipRequest, sipCallId: string, fromH: string) {
    const d = this.dialogOf(sipCallId, tagOf(fromH)); if (!d || d.state !== 'answered' || tagOf(header(m, 'To')) !== d.localTag) return;           // an ACK for a non-2xx answer or an unknown dialog is simply absorbed
    if (!d.acked) { d.acked = true; for (const w of d.ackWaiters.splice(0)) w.ok(); }
  }
  private onCancel(m: SipRequest, from: Remote, txKey: string) {
    if (this.repeated(txKey + '|CANCEL', from)) return; const d = [...this.dialogs.values()].find((x) => x.inviteTx === txKey);
    if (!d) return this.reply(m, from, txKey + '|CANCEL', respond(m, 481, 'Call/Transaction Does Not Exist'));
    this.reply(m, from, txKey + '|CANCEL', respond(m, 200, 'OK'));
    if (d.state === 'ringing') { this.final(d, 487, 'Request Terminated'); this.finish(d, 'cancelled'); }                  // CANCEL after the answer has no effect (RFC 3261 9.2): the caller must BYE
  }
  private onBye(m: SipRequest, from: Remote, txKey: string, sipCallId: string, fromH: string) {
    if (this.repeated(txKey, from)) return; const tag = tagOf(fromH), d = this.dialogOf(sipCallId, tag);
    if (!d) { if (tag && this.tomb.has(`${sipCallId}|${tag}`)) return this.reply(m, from, txKey, respond(m, 200, 'OK')); return this.reply(m, from, txKey, respond(m, 481, 'Call/Transaction Does Not Exist')); }   // a BYE for a call that just ended is answered 200, not 481
    this.reply(m, from, txKey, respond(m, 200, 'OK')); if (d.state !== 'ended') this.finish(d, 'remote_bye');
  }
  private sendBye(d: Dialog) {
    if (d.byeSent) return; d.byeSent = true; const via = `SIP/2.0/UDP ${this.bound.address}:${this.bound.port};branch=z9hG4bK${crypto.randomBytes(8).toString('hex')}`;
    const bye: SipRequest = { kind: 'request', method: 'BYE', uri: `sip:${uriOf(header(d.invite, 'Contact'))?.user || 'caller'}@${d.remote.address}:${d.remote.port}`, body: '', headers: [['Via', via], ['Max-Forwards', '70'], ['From', `${header(d.invite, 'To')};tag=${d.localTag}`], ['To', header(d.invite, 'From')!], ['Call-ID', d.sipCallId], ['CSeq', `${d.byeCseq} BYE`]] };
    const buf = serialize(bye); let wait = this.t1, n = 0; const again = () => { if (n++ >= 6 || !this.sock) return; this.send(buf, d.remote); wait = Math.min(wait * 2, this.t2); const t = setTimeout(again, wait); t.unref?.(); }; again();   // a few retransmissions; the call is already treated as ended locally
  }
  private finish(d: Dialog, reason: EndReason) {
    if (d.state === 'ended') return; const was = d.state; d.state = 'ended'; d.endReason = reason; for (const t of d.timers) clearTimeout(t); d.timers.clear();
    for (const w of d.ackWaiters.splice(0)) w.fail(new Error('call ended before the ACK: ' + reason));
    this.tomb.set(d.key, Date.now() + (this.c.tombstoneMs ?? 32_000)); this.dialogs.delete(d.key); if (this.tomb.size > 5000) for (const [k, u] of this.tomb) if (u < Date.now()) this.tomb.delete(k);
    this.log({ event: 'sip_call_ended', callId: d.id, reason, wasAnswered: was === 'answered' }); for (const l of d.ended.splice(0)) { try { l(reason); } catch (e) { this.err('ended-listener', e); } }
  }
}
