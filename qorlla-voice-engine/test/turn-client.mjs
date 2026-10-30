// A minimal, real TURN client over UDP (RFC 5766 / 8489 long-term credentials) for certification tests: Allocate, Refresh, CreatePermission and Send/Data indications.
// It talks to a real coturn; nothing is simulated. Used to prove credential acceptance/refusal and that a relayed packet really flows (or stops flowing).
import dgram from 'node:dgram';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const MAGIC = 0x2112A442, md5 = (s) => createHash('md5').update(s).digest();
const T = { ALLOCATE: 0x0003, REFRESH: 0x0004, CREATE_PERMISSION: 0x0008, SEND: 0x0016, DATA: 0x0017 };
const A = { USERNAME: 0x0006, MI: 0x0008, ERROR: 0x0009, LIFETIME: 0x000D, XOR_PEER: 0x0012, DATA: 0x0013, REALM: 0x0014, NONCE: 0x0015, XOR_RELAYED: 0x0016, REQ_TRANSPORT: 0x0019, XOR_MAPPED: 0x0020 };
const pad4 = (n) => (4 - (n % 4)) % 4;
const attr = (type, value) => { const h = Buffer.alloc(4); h.writeUInt16BE(type, 0); h.writeUInt16BE(value.length, 2); return Buffer.concat([h, value, Buffer.alloc(pad4(value.length))]); };
const header = (type, len, tx) => { const h = Buffer.alloc(20); h.writeUInt16BE(type, 0); h.writeUInt16BE(len, 2); h.writeUInt32BE(MAGIC, 4); tx.copy(h, 8); return h; };
function xorAddr(ip, port) { const b = Buffer.alloc(8); b[1] = 1; b.writeUInt16BE(port ^ (MAGIC >>> 16), 2); const o = ip.split('.').map(Number), m = Buffer.alloc(4); m.writeUInt32BE(MAGIC); for (let i = 0; i < 4; i++) b[4 + i] = o[i] ^ m[i]; return b; }
function parseXorAddr(v) { const m = Buffer.alloc(4); m.writeUInt32BE(MAGIC); return { port: v.readUInt16BE(2) ^ (MAGIC >>> 16), ip: [0, 1, 2, 3].map((i) => v[4 + i] ^ m[i]).join('.') }; }
function parse(buf) {
  if (buf.length < 20) return null; const type = buf.readUInt16BE(0), len = buf.readUInt16BE(2), tx = buf.subarray(8, 20), attrs = {}; let o = 20;
  while (o + 4 <= 20 + len) { const t = buf.readUInt16BE(o), l = buf.readUInt16BE(o + 2); attrs[t] = buf.subarray(o + 4, o + 4 + l); o += 4 + l + pad4(l); }
  const err = attrs[A.ERROR] ? attrs[A.ERROR][2] * 100 + attrs[A.ERROR][3] : null;
  return { type, tx: tx.toString('hex'), attrs, error: err, ok: (type & 0x0110) === 0x0100, isError: (type & 0x0110) === 0x0110 };
}

export class TurnClient {
  constructor({ host, port, username, password }) { Object.assign(this, { host, port, username, password }); this.sock = dgram.createSocket('udp4'); this.pending = new Map(); this.data = []; this.nonce = null; this.realm = null;
    this.sock.on('message', (m) => { const p = parse(m); if (!p) return; if (p.type === T.DATA) { this.data.push(p.attrs[A.DATA]); return; } const w = this.pending.get(p.tx); if (w) { this.pending.delete(p.tx); w(p); } }); }
  bind() { return new Promise((ok) => this.sock.bind(0, '0.0.0.0', ok)); }
  request(type, attrsBuf, { auth = true } = {}) {
    const tx = randomBytes(12); let body = attrsBuf;
    if (auth && this.nonce) {
      body = Buffer.concat([body, attr(A.USERNAME, Buffer.from(this.username)), attr(A.REALM, Buffer.from(this.realm)), attr(A.NONCE, Buffer.from(this.nonce))]);
      const key = md5(`${this.username}:${this.realm}:${this.password}`), pre = Buffer.concat([header(type, body.length + 24, tx), body]), mi = createHmac('sha1', key).update(pre).digest();
      body = Buffer.concat([body, attr(A.MI, mi)]);
    }
    const msg = Buffer.concat([header(type, body.length, tx), body]);
    return new Promise((ok, no) => { const t = setTimeout(() => { this.pending.delete(tx.toString('hex')); no(new Error('turn_timeout')); }, 3000); this.pending.set(tx.toString('hex'), (p) => { clearTimeout(t); ok(p); }); this.sock.send(msg, this.port, this.host); });
  }
  /** -> { ok:true, relay:{ip,port}, lifetime } or { ok:false, error:code } */
  async allocate() {
    const base = attr(A.REQ_TRANSPORT, Buffer.from([17, 0, 0, 0]));
    let r = await this.request(T.ALLOCATE, base, { auth: false });
    if (r.error === 401 || r.error === 438) { this.realm = r.attrs[A.REALM].toString(); this.nonce = r.attrs[A.NONCE].toString(); r = await this.request(T.ALLOCATE, base); }
    if (!r.ok) return { ok: false, error: r.error };
    this.relay = parseXorAddr(r.attrs[A.XOR_RELAYED]); return { ok: true, relay: this.relay, lifetime: r.attrs[A.LIFETIME] ? r.attrs[A.LIFETIME].readUInt32BE(0) : null };
  }
  async refresh(lifetime = 600) { const l = Buffer.alloc(4); l.writeUInt32BE(lifetime); const r = await this.request(T.REFRESH, attr(A.LIFETIME, l)); return r.ok ? { ok: true } : { ok: false, error: r.error }; }
  async permit(ip) { const r = await this.request(T.CREATE_PERMISSION, attr(A.XOR_PEER, xorAddr(ip, 0))); return r.ok ? { ok: true } : { ok: false, error: r.error }; }
  /** Send a datagram to a peer THROUGH the relay (Send indication: no response). */
  sendTo(ip, port, payload) { const tx = randomBytes(12), body = Buffer.concat([attr(A.XOR_PEER, xorAddr(ip, port)), attr(A.DATA, Buffer.from(payload))]); this.sock.send(Buffer.concat([header(T.SEND, body.length, tx), body]), this.port, this.host); }
  close() { try { this.sock.close(); } catch { /* closed */ } }
}
/** A UDP peer standing in for "the other party": records what the relay delivers to it and can send back to the relay address. */
export function udpPeer() { const s = dgram.createSocket('udp4'), got = []; s.on('message', (m, r) => got.push({ m: m.toString(), from: r })); return new Promise((ok) => s.bind(0, '0.0.0.0', () => ok({ sock: s, port: s.address().port, got, close: () => { try { s.close(); } catch { /* closed */ } } }))); }
