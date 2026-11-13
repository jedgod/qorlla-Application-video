// A minimal, dependency-free TURN client (RFC 5766 / 8656) over UDP or TCP, with long-term credentials. It exists for the M1.3 certification: it lets a test behave like a
// MALICIOUS or NON-COMPLIANT client (reuse a revoked credential, allocate again, refresh a cancelled allocation, ask for forbidden peers, replay a nonce, use TCP) without a
// browser, and it can push real traffic through a relay for the latency/bandwidth/capacity measurements.
//   const c = await TurnClient.open({ host, port, proto: 'udp' | 'tcp' });
//   const a = await c.allocate({ username, password, realm? });  -> { ok, code, relayed: {ip,port}, lifetime }  (code = STUN error code when !ok)
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const MAGIC = 0x2112a442, T = { ALLOCATE: 0x0003, REFRESH: 0x0004, SEND: 0x0016, DATA_IND: 0x0017, CREATE_PERM: 0x0008, CHANNEL_BIND: 0x0009 };
const A = { USERNAME: 0x0006, MI: 0x0008, ERROR: 0x0009, LIFETIME: 0x000d, XOR_PEER: 0x0012, DATA: 0x0013, REALM: 0x0014, NONCE: 0x0015, XOR_RELAYED: 0x0016, TRANSPORT: 0x0019, XOR_MAPPED: 0x0020, CHANNEL: 0x000c };
const pad4 = (n) => (4 - (n % 4)) % 4;
const attr = (type, val) => { const h = Buffer.alloc(4); h.writeUInt16BE(type, 0); h.writeUInt16BE(val.length, 2); return Buffer.concat([h, val, Buffer.alloc(pad4(val.length))]); };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const xorAddr = (ip, port, txid) => { const b = Buffer.alloc(8); b[1] = 1; b.writeUInt16BE(port ^ (MAGIC >>> 16), 2); const o = ip.split('.').map(Number); const m = Buffer.alloc(4); m.writeUInt32BE(MAGIC); for (let i = 0; i < 4; i++) b[4 + i] = o[i] ^ m[i]; return b; };
const parseXorAddr = (v) => { const m = Buffer.alloc(4); m.writeUInt32BE(MAGIC); const port = v.readUInt16BE(2) ^ (MAGIC >>> 16); const ip = [0, 1, 2, 3].map((i) => v[4 + i] ^ m[i]).join('.'); return { ip, port }; };

function build(type, txid, attrs, key) {
  let body = Buffer.concat(attrs);
  const head = (len) => { const h = Buffer.alloc(20); h.writeUInt16BE(type, 0); h.writeUInt16BE(len, 2); h.writeUInt32BE(MAGIC, 4); txid.copy(h, 8); return h; };
  if (key) {                                                                  // MESSAGE-INTEGRITY: HMAC-SHA1 over the message whose length already counts the 24 bytes of the attribute
    const h = head(body.length + 24), mi = createHmac('sha1', key).update(Buffer.concat([h, body])).digest();
    body = Buffer.concat([body, attr(A.MI, mi)]);
  }
  return Buffer.concat([head(body.length), body]);
}
function parse(buf) {
  if (buf.length < 20 || buf.readUInt32BE(4) !== MAGIC) return null;
  const type = buf.readUInt16BE(0), len = buf.readUInt16BE(2), txid = buf.subarray(8, 20), attrs = {}; let o = 20;
  while (o + 4 <= 20 + len) { const t = buf.readUInt16BE(o), l = buf.readUInt16BE(o + 2); attrs[t] = buf.subarray(o + 4, o + 4 + l); o += 4 + l + pad4(l); }
  return { type, txid, attrs };
}

export class TurnClient {
  static async open({ host, port, proto = 'udp', timeoutMs = 4000, tlsInsecure = false }) { const c = new TurnClient({ host, port, proto, timeoutMs, tlsInsecure }); await c.ready; return c; }
  constructor({ host, port, proto, timeoutMs, tlsInsecure }) {
    Object.assign(this, { host, port, proto, timeoutMs, pending: new Map(), buf: Buffer.alloc(0), onData: null, creds: null, realm: null, nonce: null, key: null, closed: false, rx: 0 });
    const feed = (b) => { if (this.proto === 'udp') return this.#msg(b); this.buf = Buffer.concat([this.buf, b]); while (this.buf.length >= 20) { const n = 20 + this.buf.readUInt16BE(2); if (this.buf.length < n) break; this.#msg(this.buf.subarray(0, n)); this.buf = this.buf.subarray(n); } };
    this.ready = new Promise((res, rej) => {
      if (proto === 'udp') { this.sock = dgram.createSocket('udp4'); this.sock.on('message', feed); this.sock.on('error', rej); this.sock.bind(0, () => res()); }
      else { this.sock = proto === 'tls' ? tls.connect({ host, port, rejectUnauthorized: !tlsInsecure }, () => res()) : net.connect(port, host, () => res()); this.sock.on('data', feed); this.sock.on('error', rej); this.sock.on('close', () => { this.closed = true; }); }
    });
  }
  #msg(b) { const m = parse(b); if (!m) return; this.rx++; if (m.type === T.DATA_IND) { if (this.onData) this.onData({ peer: parseXorAddr(m.attrs[A.XOR_PEER]), data: m.attrs[A.DATA], at: Date.now() }); return; } const p = this.pending.get(m.txid.toString('hex')); if (p) { this.pending.delete(m.txid.toString('hex')); p(m); } }
  #write(b) { if (this.proto === 'udp') this.sock.send(b, this.port, this.host); else this.sock.write(b); }
  #rpc(type, attrs, key) {
    const txid = randomBytes(12), msg = build(type, txid, attrs, key);
    return new Promise((resolve) => { const t = setTimeout(() => { this.pending.delete(txid.toString('hex')); resolve({ timeout: true }); }, this.timeoutMs); this.pending.set(txid.toString('hex'), (m) => { clearTimeout(t); resolve(m); }); try { this.#write(msg); } catch { clearTimeout(t); resolve({ timeout: true }); } });
  }
  static #result(m) {
    if (m.timeout) return { ok: false, code: 'timeout' };
    const ok = (m.type & 0x0110) === 0x0100, out = { ok, code: 0, attrs: m.attrs };
    if (!ok && m.attrs[A.ERROR]) { const e = m.attrs[A.ERROR]; out.code = (e[2] & 7) * 100 + e[3]; }
    if (m.attrs[A.XOR_RELAYED]) out.relayed = parseXorAddr(m.attrs[A.XOR_RELAYED]);
    if (m.attrs[A.LIFETIME]) out.lifetime = m.attrs[A.LIFETIME].readUInt32BE(0);
    return out;
  }
  #auth(extra) { return [attr(A.USERNAME, Buffer.from(this.creds.username)), attr(A.REALM, Buffer.from(this.realm)), attr(A.NONCE, Buffer.from(this.nonce)), ...extra]; }
  /** One authenticated request; handles the first 401 (realm+nonce) and a 438 (stale nonce) by retrying ONCE, like a real client. */
  async #authed(type, extra, creds) {
    if (creds) { this.creds = creds; this.key = null; }
    if (!this.nonce) {                                                                         // learn realm + nonce from the unauthenticated 401
      const m = await this.#rpc(type, extra); if (m.timeout) return { ok: false, code: 'timeout' };
      const r = TurnClient.#result(m); if (r.ok) return r; if (r.code !== 401 && r.code !== 438) return r;
      this.realm = (creds && creds.realm) || m.attrs[A.REALM]?.toString(); this.nonce = m.attrs[A.NONCE]?.toString(); if (!this.nonce) return r;
    }
    this.key = createHash('md5').update(`${this.creds.username}:${this.realm}:${this.creds.password}`).digest();
    let m = await this.#rpc(type, this.#auth(extra), this.key), r = TurnClient.#result(m);
    if (r.code === 438 && m.attrs[A.NONCE]) { this.nonce = m.attrs[A.NONCE].toString(); m = await this.#rpc(type, this.#auth(extra), this.key); r = TurnClient.#result(m); }
    return r;
  }
  /** Allocate. Pass { username, password } (and optionally { nonce } to REPLAY an old nonce). */
  async allocate(creds, { lifetime } = {}) { if (creds && creds.nonce) { this.nonce = creds.nonce; this.realm = creds.realm; } const r = await this.#authed(T.ALLOCATE, [attr(A.TRANSPORT, Buffer.from([17, 0, 0, 0])), ...(lifetime ? [attr(A.LIFETIME, u32(lifetime))] : [])], creds); if (r.ok) this.relayed = r.relayed; return r; }
  refresh(lifetime = 600) { return this.#authed(T.REFRESH, [attr(A.LIFETIME, u32(lifetime))]); }
  createPermission(ip) { return this.#authed(T.CREATE_PERM, [attr(A.XOR_PEER, xorAddr(ip, 0))]); }
  channelBind(channel, ip, port) { return this.#authed(T.CHANNEL_BIND, [attr(A.CHANNEL, Buffer.concat([Buffer.from([channel >> 8, channel & 255]), Buffer.alloc(2)])), attr(A.XOR_PEER, xorAddr(ip, port))]); }
  /** A Send indication (no response): relay `data` from our allocation to peer ip:port. */
  send(ip, port, data) { const txid = randomBytes(12); this.#write(build(T.SEND, txid, [attr(A.XOR_PEER, xorAddr(ip, port)), attr(A.DATA, data)])); }
  close() { try { this.proto === 'udp' ? this.sock.close() : this.sock.destroy(); } catch { /* closed */ } this.closed = true; }
}
