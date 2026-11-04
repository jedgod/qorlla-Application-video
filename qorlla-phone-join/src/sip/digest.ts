import crypto from 'node:crypto';

/**
 * SIP digest authentication (RFC 3261 section 22, RFC 7616 / 8760): SHA-256 by default, MD5 only when an operator names it (some trunks cannot do better). Nonces are signed and expire; a response can be used only once
 * (the nonce count must increase); qop=auth is required; the credential store holds H(user:realm:password) and never the password. Everything fails closed: unknown user, wrong realm, stale or forged nonce, replay.
 */
export type DigestAlgorithm = 'SHA-256' | 'MD5';
export type DigestOptions = {
  realm: string; secret: Buffer;                                              // HMAC key for nonces: at least 32 random bytes, from the deployment's secret store, never committed
  lookup: (username: string) => string | undefined;                           // -> HA1 (hex) for that user, or undefined
  algorithms?: readonly DigestAlgorithm[]; nonceTtlMs?: number; maxOutstanding?: number; now?: () => number;
};
export type DigestResult = { ok: true; username: string } | { ok: false; reason: 'missing' | 'malformed' | 'unknown_user' | 'bad_realm' | 'bad_nonce' | 'stale' | 'replay' | 'bad_algorithm' | 'bad_uri' | 'bad_response' };
const hash = (alg: DigestAlgorithm, s: string) => crypto.createHash(alg === 'SHA-256' ? 'sha256' : 'md5').update(s).digest('hex');
export const ha1 = (alg: DigestAlgorithm, username: string, realm: string, password: string) => hash(alg, `${username}:${realm}:${password}`);
const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function parseAuth(value: string): Record<string, string> | null {
  const m = /^Digest\s+(.+)$/is.exec(value.trim()); if (!m || m[1].length > 1024) return null; const out: Record<string, string> = {};
  const re = /([a-z]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))\s*(?:,|$)/gi; let x: RegExpExecArray | null, consumed = 0;
  while ((x = re.exec(m[1]))) { out[x[1].toLowerCase()] = (x[2] ?? x[3]).replace(/\\(.)/g, '$1'); consumed += x[0].length; }
  return consumed > 0 ? out : null;
}

export class DigestAuthenticator {
  private readonly seen = new Map<string, { nc: number; at: number }>();
  private readonly algs: readonly DigestAlgorithm[]; private readonly ttl: number; private readonly max: number; private readonly now: () => number;
  constructor(private readonly o: DigestOptions) {
    if (o.secret.length < 32) throw new Error('the digest nonce secret must be at least 32 bytes');
    this.algs = o.algorithms?.length ? o.algorithms : ['SHA-256']; this.ttl = o.nonceTtlMs ?? 30_000; this.max = o.maxOutstanding ?? 10_000; this.now = o.now ?? Date.now;
  }
  private sign(body: string) { return crypto.createHmac('sha256', this.o.secret).update(body).digest('base64url').slice(0, 32); }
  private nonce(): string { const body = `${this.now().toString(36)}.${crypto.randomBytes(12).toString('base64url')}`; return `${body}.${this.sign(body)}`; }
  /** One WWW-Authenticate value per accepted algorithm (the client picks the strongest it supports). */
  challenge(stale = false): string[] {
    this.prune(); const nonce = this.nonce();
    return this.algs.map((a) => `Digest realm="${this.o.realm}", nonce="${nonce}", algorithm=${a}, qop="auth"${stale ? ', stale=true' : ''}`);
  }
  private prune() { const t = this.now(); for (const [n, v] of this.seen) if (t - v.at > this.ttl * 2) this.seen.delete(n); while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value as string); }
  verify(method: string, requestUri: string, authorization: string | undefined): DigestResult {
    if (!authorization) return { ok: false, reason: 'missing' }; const p = parseAuth(authorization); if (!p) return { ok: false, reason: 'malformed' };
    const { username, realm, nonce, uri, response, cnonce, nc, qop } = p, alg = (p.algorithm ?? 'MD5').toUpperCase() as DigestAlgorithm;
    if (!username || !realm || !nonce || !uri || !response || !cnonce || !nc) return { ok: false, reason: 'malformed' };
    if (qop !== 'auth' || !/^[0-9a-f]{8}$/i.test(nc) || username.length > 128 || cnonce.length > 128) return { ok: false, reason: 'malformed' };
    if (!this.algs.includes(alg)) return { ok: false, reason: 'bad_algorithm' }; if (realm !== this.o.realm) return { ok: false, reason: 'bad_realm' };
    const parts = nonce.split('.'); if (parts.length !== 3 || !eq(parts[2], this.sign(`${parts[0]}.${parts[1]}`))) return { ok: false, reason: 'bad_nonce' };
    const issued = parseInt(parts[0], 36); if (!Number.isFinite(issued) || this.now() - issued > this.ttl || issued > this.now() + 1000) return { ok: false, reason: 'stale' };
    if (uri !== requestUri) return { ok: false, reason: 'bad_uri' };
    const h1 = this.o.lookup(username); if (!h1 || !/^[0-9a-f]+$/i.test(h1)) return { ok: false, reason: 'unknown_user' };
    const expect = hash(alg, `${h1}:${nonce}:${nc}:${cnonce}:${qop}:${hash(alg, `${method}:${uri}`)}`); if (!eq(expect, response.toLowerCase())) return { ok: false, reason: 'bad_response' };
    const count = parseInt(nc, 16), prev = this.seen.get(nonce); if (prev && count <= prev.nc) return { ok: false, reason: 'replay' };   // a captured Authorization header is worthless the second time
    this.seen.set(nonce, { nc: count, at: this.now() }); return { ok: true, username };
  }
}

/** Client side (for the synthetic test phones and for tools): builds the Authorization header answering a challenge. */
export function answerChallenge(c: { challenge: string; method: string; uri: string; username: string; password: string; nc?: number; cnonce?: string }): string {
  const p = parseAuth(c.challenge)!, alg = (p.algorithm ?? 'MD5').toUpperCase() as DigestAlgorithm, nc = (c.nc ?? 1).toString(16).padStart(8, '0'), cnonce = c.cnonce ?? crypto.randomBytes(8).toString('hex');
  const response = hash(alg, `${ha1(alg, c.username, p.realm, c.password)}:${p.nonce}:${nc}:${cnonce}:auth:${hash(alg, `${c.method}:${c.uri}`)}`);
  return `Digest username="${c.username}", realm="${p.realm}", nonce="${p.nonce}", uri="${c.uri}", response="${response}", algorithm=${alg}, cnonce="${cnonce}", qop=auth, nc=${nc}`;
}
