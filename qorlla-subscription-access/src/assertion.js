/**
 * Signed service-to-service assertions: how the web tier tells the internal administration service WHO is asking, from WHICH
 * session, to do EXACTLY what. The web tier has already verified the live session; the assertion carries that fact for at most
 * a minute and cannot be reused:
 *
 *   claims = { sub: user id, sid: session hash, act: action id, cid?: customer id, iat, exp, jti }
 *   token  = base64url(json) "." base64url(HMAC-SHA256(key, base64url(json)))
 *
 * Verification: signature against any configured key (rotation), `exp` in the future, lifetime <= maxTtl, `iat` not from the future,
 * all fields well formed. Replay protection (jti used once) and route binding (`act` must equal the route's action) are enforced
 * by the server using these results.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const b64 = (b) => Buffer.from(b).toString('base64url');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_RE = /^[A-Za-z0-9_.:@-]{1,100}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{16,200}$/;
export const MAX_ASSERTION_TTL_MS = 60_000;

export class AssertionError extends Error {
  constructor(reason) { super('invalid assertion'); this.reason = reason; this.name = 'AssertionError'; }
}

const mac = (key, payload) => createHmac('sha256', key).update(payload).digest();

export function signAssertion({ sub, sid, act, cid, ttlMs = 30_000, now = Date.now(), jti = randomBytes(16).toString('base64url') }, key) {
  if (typeof key !== 'string' || key.length < 32) throw new Error('signing key must be at least 32 characters');
  if (ttlMs > MAX_ASSERTION_TTL_MS) throw new Error('assertion lifetime too long');
  const claims = { sub, sid, act, ...(cid ? { cid } : {}), iat: now, exp: now + ttlMs, jti };
  const payload = b64(JSON.stringify(claims));
  return `${payload}.${b64(mac(key, payload))}`;
}

/** @returns the verified claims, or throws AssertionError with a machine-readable (never user-facing) reason. */
export function verifyAssertion(token, keys, { now = Date.now(), skewMs = 5000, maxTtlMs = MAX_ASSERTION_TTL_MS } = {}) {
  if (typeof token !== 'string' || token.length > 2048) throw new AssertionError('malformed');
  const parts = token.split('.');
  if (parts.length !== 2) throw new AssertionError('malformed');
  const [payload, sig] = parts;
  let given;
  try { given = Buffer.from(sig, 'base64url'); } catch { throw new AssertionError('malformed'); }
  let ok = false;
  for (const key of keys) {                                                         // every key is tried; no early exit
    const want = mac(key, payload);
    if (given.length === want.length && timingSafeEqual(given, want)) ok = true;
  }
  if (!ok) throw new AssertionError('bad_signature');
  let c;
  try { c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new AssertionError('malformed'); }
  if (!c || typeof c !== 'object') throw new AssertionError('malformed');
  if (typeof c.sub !== 'string' || !USER_RE.test(c.sub)) throw new AssertionError('bad_subject');
  if (typeof c.sid !== 'string' || !SESSION_RE.test(c.sid)) throw new AssertionError('bad_session');
  if (typeof c.act !== 'string' || c.act.length < 1 || c.act.length > 60) throw new AssertionError('bad_action');
  if (c.cid !== undefined && (typeof c.cid !== 'string' || !UUID_RE.test(c.cid))) throw new AssertionError('bad_customer');
  if (typeof c.jti !== 'string' || c.jti.length < 8 || c.jti.length > 100) throw new AssertionError('bad_jti');
  if (!Number.isFinite(c.iat) || !Number.isFinite(c.exp)) throw new AssertionError('bad_time');
  if (c.exp <= now) throw new AssertionError('expired');
  if (c.iat > now + skewMs) throw new AssertionError('from_the_future');
  if (c.exp - c.iat > maxTtlMs) throw new AssertionError('lifetime_too_long');
  return c;
}
