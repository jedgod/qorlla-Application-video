/**
 * CSRF protection for the web tier's admin proxy routes, independent of the host application's own CSRF support.
 *
 *  - The token is HMAC-SHA256(key = the session hash, message = a fixed label): bound to ONE session, needs no extra storage, and
 *    cannot be computed without the session cookie. It must be sent in the X-CSRF-Token header.
 *  - A browser's Origin (when present) must be this site. A cross-site request is refused before the token is even looked at.
 *  - Comparison is constant time. Everything fails closed.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { sessionHashOf } from './adminClient.js';

const LABEL = 'qorlla-admin-csrf-v1';

export const csrfTokenFor = (sessionHash) => (sessionHash ? createHmac('sha256', sessionHash).update(LABEL).digest('hex') : null);

export function createCsrf({ cookieName = 'qs', allowedOrigins = [] } = {}) {
  const sameSite = (req) => {
    const origin = req.headers.origin;
    if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';              // non-browser clients still need the token
    try { const o = new URL(origin); return o.host === req.headers.host || allowedOrigins.includes(o.origin); } catch { return false; }
  };
  return {
    /** GET handler body: the token for the current session (the route itself must already require a signed-in user). */
    tokenFor: (req) => csrfTokenFor(sessionHashOf(req, cookieName)),
    require(req, res, next) {
      if (!sameSite(req)) return res.status(403).json({ error: 'csrf', detail: 'cross-site request blocked' });
      const want = csrfTokenFor(sessionHashOf(req, cookieName)), got = String(req.headers['x-csrf-token'] || '');
      const a = Buffer.from(got), b = Buffer.from(want || '');
      if (!want || a.length !== b.length || !timingSafeEqual(a, b)) return res.status(403).json({ error: 'csrf', detail: 'missing or invalid token' });
      return next();
    },
  };
}
