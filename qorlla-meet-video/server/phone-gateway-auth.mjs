// Authentication of the telephone gateway to Qorlla Meet.
//
// The token is the one Qorlla already uses between services (see telephony/number-sync.mjs signWorkloadJwt and shield-client.mjs): an ES256 JWT {iss, sub, aud, iat, exp, jti, cnf?} with a `kid`.
// What makes this a RESTRICTED identity rather than "any valid Meet token":
//   - its own audience (default 'qorlla-phone-gateway'): a token minted for the Shield, numbers sync or any other Meet operation is refused here, and this one is refused there;
//   - its own subjects, each mapped SERVER-SIDE to the scopes it may use (phone.verify, phone.media, phone.end, phone.decision, phone.health). A token cannot claim scopes;
//   - its own keys per issuer and kid (rotation = publish the new kid, retire the old one later);
//   - one use (jti recorded in PostgreSQL, shared by every Meet replica), short life (<= 300 s), a bounded clock skew;
//   - on POST, the SHA-256 of the exact body (`bsh`), so a captured token cannot carry a different body;
//   - when required (the default), the token is bound to the TLS client certificate of the connection (cnf 'x5t#S256') and the connection must be mutually authenticated;
//   - a request budget per gateway identity and scope, counted in PostgreSQL (the in-memory express-rate-limit counters are per process).
// Every dependency failure (database down, bad configuration) is a refusal. Nothing the caller says about itself (headers, body fields) is trusted.
import crypto from 'node:crypto';

export const GATEWAY_AUDIENCE = 'qorlla-phone-gateway';
export const SCOPES = ['phone.verify', 'phone.consent', 'phone.media', 'phone.end', 'phone.decision', 'phone.health', 'phone.readiness', 'phone.peer'];
export class GatewayError extends Error { constructor(status, reason) { super(reason); this.status = status; this.reason = reason; } }
const b64u = (b) => Buffer.from(b).toString('base64url');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const parse = (s) => { try { const v = JSON.parse(String(s || '')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };

export function peerThumbprint(req) {
  const s = req.socket; if (!s || !s.encrypted || !s.authorized) return null;
  const cert = s.getPeerCertificate(true); return cert && cert.raw ? b64u(crypto.createHash('sha256').update(cert.raw).digest()) : null;
}

export function createGatewayAuth({ db, env = process.env, now = Date.now, log = console }) {
  const keys = parse(env.PHONE_GATEWAY_KEYS_JSON), subjects = parse(env.PHONE_GATEWAY_SUBJECTS_JSON);
  const problems = [];
  if (!keys || !Object.keys(keys).length) problems.push('PHONE_GATEWAY_KEYS_JSON');
  if (!subjects || !Object.keys(subjects).length) problems.push('PHONE_GATEWAY_SUBJECTS_JSON');
  for (const [sub, scopes] of Object.entries(subjects || {})) if (!Array.isArray(scopes) || !scopes.length || scopes.some((s) => !SCOPES.includes(s))) problems.push('scopes of ' + sub);
  const audience = String(env.PHONE_GATEWAY_AUDIENCE || GATEWAY_AUDIENCE), requireMtls = env.PHONE_GATEWAY_REQUIRE_MTLS !== 'false';
  const limitPerMin = Math.max(1, Number(env.PHONE_GATEWAY_RATE_LIMIT || 600)), maxTtl = Math.min(300, Math.max(30, Number(env.PHONE_GATEWAY_MAX_TTL_S || 300))), skew = Math.min(60, Math.max(0, Number(env.PHONE_GATEWAY_SKEW_S || 30)));
  const configured = problems.length === 0;
  if (!requireMtls && configured) log.warn?.('[phone-gateway] PHONE_GATEWAY_REQUIRE_MTLS=false: tokens are not bound to a client certificate');

  async function authenticate(req, scope, rawBody) {
    if (!configured) throw new GatewayError(503, 'gateway_auth_not_configured');
    if (!SCOPES.includes(scope)) throw new GatewayError(500, 'unknown_scope');
    const h = String(req.get('authorization') || ''); const token = /^Bearer /.test(h) ? h.slice(7).trim() : '';
    const parts = token.split('.'); if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new GatewayError(401, 'malformed');
    let head, claims; try { head = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw new GatewayError(401, 'malformed'); }
    if (head?.alg !== 'ES256' || head?.typ !== 'JWT') throw new GatewayError(401, 'alg');
    if (typeof claims?.iss !== 'string' || typeof head.kid !== 'string' || !Object.prototype.hasOwnProperty.call(keys, claims.iss)) throw new GatewayError(401, 'unknown_issuer');
    const pem = keys[claims.iss] && Object.prototype.hasOwnProperty.call(keys[claims.iss], head.kid) ? keys[claims.iss][head.kid] : null; if (typeof pem !== 'string') throw new GatewayError(401, 'unknown_kid');
    let ok = false; try { ok = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), { key: pem, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')); } catch { /* bad key or signature */ }
    if (!ok) throw new GatewayError(401, 'signature');
    const t = Math.floor(now() / 1000);
    if (claims.aud !== audience) throw new GatewayError(401, 'audience');
    if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) throw new GatewayError(401, 'malformed');
    if (claims.iat > t + skew) throw new GatewayError(401, 'issued_in_future'); if (claims.exp <= t) throw new GatewayError(401, 'expired'); if (claims.exp - claims.iat > maxTtl) throw new GatewayError(401, 'ttl_too_long');
    if (typeof claims.jti !== 'string' || claims.jti.length < 16 || claims.jti.length > 200) throw new GatewayError(401, 'jti');
    if (typeof claims.sub !== 'string' || !Object.prototype.hasOwnProperty.call(subjects, claims.sub)) throw new GatewayError(401, 'subject');
    if (!subjects[claims.sub].includes(scope)) throw new GatewayError(403, 'scope');                     // a valid gateway token for another operation does not authorise this one
    if (requireMtls) { const bound = claims.cnf?.['x5t#S256'], peer = peerThumbprint(req); if (typeof bound !== 'string' || !peer || !eq(bound, peer)) throw new GatewayError(401, 'certificate_binding'); }
    if (rawBody != null) { const sha = b64u(crypto.createHash('sha256').update(rawBody).digest()); if (typeof claims.bsh !== 'string' || !eq(claims.bsh, sha)) throw new GatewayError(401, 'body_binding'); }
    else if (claims.bsh !== undefined) throw new GatewayError(401, 'body_binding');
    // single use, then the request budget; both live in PostgreSQL so every replica sees them
    let first = false;
    try { first = (await db.query("INSERT INTO phone_gateway_replay(jti, issuer, expires_at) VALUES($1,$2,to_timestamp($3)) ON CONFLICT (jti) DO NOTHING RETURNING jti", [claims.jti, claims.iss, claims.exp])).rowCount === 1; } catch { throw new GatewayError(503, 'replay_store_unavailable'); }
    if (!first) throw new GatewayError(401, 'replayed');
    try {
      const n = (await db.query("INSERT INTO phone_gateway_rate(bucket, window_start, n) VALUES($1, date_trunc('minute', now()), 1) ON CONFLICT (bucket, window_start) DO UPDATE SET n = phone_gateway_rate.n + 1 RETURNING n", [claims.sub + '|' + scope])).rows[0].n;
      if (Math.random() < 0.02) db.query("DELETE FROM phone_gateway_rate WHERE window_start < now() - interval '10 minutes'; DELETE FROM phone_gateway_replay WHERE expires_at < now() - interval '1 minute'").catch(() => {});
      if (n > limitPerMin) throw new GatewayError(429, 'rate_limited');
    } catch (e) { if (e instanceof GatewayError) throw e; throw new GatewayError(503, 'rate_limiter_unavailable'); }
    return { issuer: claims.iss, subject: claims.sub, scope, jti: claims.jti };
  }
  return { configured, problems, audience, requireMtls, authenticate };
}
