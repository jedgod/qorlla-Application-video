import crypto from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import type express from 'express';

/**
 * Gateway authentication. NOT a new scheme: it verifies the workload token Qorlla already uses between services (Meet signWorkloadJwt, the Security Shield, numbers sync):
 * an ES256 JWT {iss, sub, aud, iat, exp, jti, cnf?} with a kid, optionally bound (cnf 'x5t#S256') to the caller's mTLS certificate. What is added on top for this endpoint:
 * the token must name THIS service (aud), a known gateway (iss + kid + sub), be short-lived, be accepted once (jti recorded in a shared store), and - for the admission POST -
 * carry the SHA-256 of the exact request body (`bsh`), so a captured token cannot be used with a different body.
 */
export const AUDIENCE = 'qorlla-phone-join';
/** issuer -> kid -> PEM public key. Rotation = add the new kid, later remove the old one. */
export type TrustedKeys = Record<string, Record<string, string>>;
export interface ReplayStore { firstUse(jti: string, issuer: string, expiresAtMs: number): Promise<boolean> }
export type GatewayAuthConfig = {
  keys: TrustedKeys;
  /** Which service identities may call (`sub`), for example ['svc:phone-gateway']. */
  subjects: string[];
  replay: ReplayStore;
  audience?: string;
  /** Require the token to be bound to the TLS client certificate presented on this connection (and that the connection is mutually authenticated). Production should set this. */
  requireMtls?: boolean;
  /** Require `bsh` on the admission POST (default true). */
  requireBodyBinding?: boolean;
  maxTtlSeconds?: number;
  skewSeconds?: number;
  /** Epoch MILLISECONDS (like Date.now); injectable for tests. */
  now?: () => number;
  /** Called with the real reason for every refusal (for logs and alerts). The client only ever sees a generic 401. */
  onReject?: (reason: string, req: express.Request) => void;
};
export type Gateway = { issuer: string; subject: string; jti: string };

export class GatewayAuthError extends Error { constructor(readonly reason: string) { super(reason); } }
const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');
const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Throws GatewayAuthError(reason) unless the token is acceptable. Consumes the jti (single use). */
export async function verifyWorkloadToken(token: string, cfg: GatewayAuthConfig, ctx: { peerThumbprint?: string | null; bodySha256?: string | null } = {}): Promise<Gateway> {
  const fail = (r: string): never => { throw new GatewayAuthError(r); };
  const parts = String(token || '').split('.'); if (parts.length !== 3 || parts.some((p) => !p || !/^[A-Za-z0-9_-]+$/.test(p))) fail('malformed');
  let head: any, claims: any; try { head = JSON.parse(fromB64u(parts[0]).toString('utf8')); claims = JSON.parse(fromB64u(parts[1]).toString('utf8')); } catch { return fail('malformed'); }
  if (head?.alg !== 'ES256' || head?.typ !== 'JWT') fail('alg');                                      // no 'none', no HS256 with a public key as the secret
  if (typeof claims?.iss !== 'string' || typeof head.kid !== 'string') fail('malformed');
  const pem = cfg.keys[claims.iss]?.[head.kid]; if (!pem || !Object.prototype.hasOwnProperty.call(cfg.keys, claims.iss)) fail('unknown_issuer_or_kid');
  let sigOk = false; try { sigOk = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), { key: pem, dsaEncoding: 'ieee-p1363' }, fromB64u(parts[2])); } catch { /* bad key or signature */ }
  if (!sigOk) fail('signature');
  const now = Math.floor((cfg.now ?? Date.now)() / 1000), skew = cfg.skewSeconds ?? 30, maxTtl = cfg.maxTtlSeconds ?? 300;
  if (claims.aud !== (cfg.audience ?? AUDIENCE)) fail('audience');
  if (typeof claims.sub !== 'string' || !cfg.subjects.includes(claims.sub)) fail('subject');
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) fail('malformed');
  if (claims.iat > now + skew) fail('issued_in_future'); if (claims.exp <= now) fail('expired'); if (claims.exp - claims.iat > maxTtl) fail('ttl_too_long');
  if (typeof claims.jti !== 'string' || claims.jti.length < 16 || claims.jti.length > 200) fail('jti');
  if (cfg.requireMtls) {
    const bound = claims.cnf?.['x5t#S256']; if (typeof bound !== 'string' || !ctx.peerThumbprint || !eq(bound, ctx.peerThumbprint)) fail('certificate_binding');
  }
  if (claims.bsh !== undefined || ctx.bodySha256) { if (ctx.bodySha256 == null || typeof claims.bsh !== 'string' || !eq(claims.bsh, ctx.bodySha256)) fail('body_binding'); }
  let first = false; try { first = await cfg.replay.firstUse(claims.jti, claims.iss, claims.exp * 1000); } catch { fail('replay_store_unavailable'); }     // a replay store that is down is a refusal, never a pass
  if (!first) fail('replayed');
  return { issuer: claims.iss, subject: claims.sub, jti: claims.jti };
}

const peerThumbprint = (req: express.Request): string | null => {
  const s = req.socket as TLSSocket; if (!s || !(s as any).encrypted || !s.authorized) return null;
  const cert = s.getPeerCertificate(true); return cert && cert.raw ? b64u(crypto.createHash('sha256').update(cert.raw).digest()) : null;
};
const bearer = (req: express.Request) => { const h = String(req.get('authorization') || ''); return /^Bearer /.test(h) ? h.slice(7).trim() : ''; };

/** Express middleware: `authenticateGateway` for GET routes, `verifyWebhook` for the admission POST (also reads the raw body, checks `bsh`, and hands the parsed JSON on). */
export function gatewayAuth(cfg: GatewayAuthConfig) {
  const deny = (req: express.Request, res: express.Response, reason: string) => { try { cfg.onReject?.(reason, req); } catch { /* logging must not break the refusal */ } res.setHeader('Cache-Control', 'no-store'); res.status(401).json({ code: 'AUTH_REQUIRED' }); };
  const authenticateGateway: express.RequestHandler = async (req, res, next) => {
    try { (req as any).gateway = await verifyWorkloadToken(bearer(req), cfg, { peerThumbprint: cfg.requireMtls ? peerThumbprint(req) : null }); next(); }
    catch (e) { deny(req, res, e instanceof GatewayAuthError ? e.reason : 'error'); }
  };
  const verifyWebhook: express.RequestHandler = async (req, res, next) => {
    try {
      const chunks: Buffer[] = []; let size = 0, tooBig = false;
      await new Promise<void>((resolve, reject) => { req.on('data', (c: Buffer) => { size += c.length; if (size > 8 * 1024) { tooBig = true; return; } chunks.push(c); }); req.on('end', resolve); req.on('error', reject); });
      if (tooBig) return void res.status(413).json({ code: 'INVALID_REQUEST' });
      const raw = Buffer.concat(chunks), sha = b64u(crypto.createHash('sha256').update(raw).digest());
      const needBinding = cfg.requireBodyBinding !== false;
      (req as any).gateway = await verifyWorkloadToken(bearer(req), cfg, { peerThumbprint: cfg.requireMtls ? peerThumbprint(req) : null, bodySha256: needBinding ? sha : null });
      let body: unknown; try { body = JSON.parse(raw.toString('utf8') || 'null'); } catch { return void res.status(400).json({ code: 'INVALID_REQUEST' }); }
      (req as any).body = body; (req as any)._body = true;                                                  // the stream is consumed: body-parser must not wait for it
      next();
    } catch (e) { deny(req, res, e instanceof GatewayAuthError ? e.reason : 'error'); }
  };
  return { authenticateGateway, verifyWebhook };
}

/** For the gateway side and for tests: mints a token in the same format as Meet's signWorkloadJwt, plus the optional body binding. */
export function signGatewayToken(o: { privateKeyPem: string; kid?: string; issuer: string; subject: string; audience?: string; ttlSeconds?: number; now?: number; cnfThumbprint?: string; body?: string | Buffer }): string {
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const head = b64u(Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: o.kid ?? 'w1' })));
  const claims = b64u(Buffer.from(JSON.stringify({ iss: o.issuer, sub: o.subject, aud: o.audience ?? AUDIENCE, iat: now, exp: now + (o.ttlSeconds ?? 120), jti: crypto.randomUUID() + crypto.randomUUID(),
    ...(o.cnfThumbprint ? { cnf: { 'x5t#S256': o.cnfThumbprint } } : {}), ...(o.body !== undefined ? { bsh: b64u(crypto.createHash('sha256').update(o.body).digest()) } : {}) })));
  return head + '.' + claims + '.' + b64u(crypto.sign('sha256', Buffer.from(head + '.' + claims), { key: o.privateKeyPem, dsaEncoding: 'ieee-p1363' }));
}
