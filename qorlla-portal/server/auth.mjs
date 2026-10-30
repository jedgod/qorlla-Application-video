// Portal authentication / authorization. Identity comes ONLY from the MAIN-signed JWT cookie (verified against MAIN's JWKS)
// and, when configured, a live check that the MAIN session behind it is still active. Nothing from headers/body is trusted.
import crypto from 'node:crypto';
import { jwtVerify } from 'jose';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_COOKIE = 'qorlla_portal_session';
const CSRF_COOKIE = 'qorlla_csrf';
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeMethod = (m) => m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
export const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((x) => x.trim()).filter((x) => x.includes('=')).map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));
const sameValue = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function createAuth({ cfg, pool, jwks, fetchImpl = fetch, log, now = () => Date.now() }) {
  // ---- live session check against MAIN (revocation on logout / password change) ----
  const cache = new Map(); // sid -> { active, until }
  async function sessionActive(sid) {
    if (!cfg.requireIntrospection && !cfg.introspectionUrl) return true;
    const hit = cache.get(sid);
    if (hit && hit.until > now()) return hit.active;
    let r;
    try {
      r = await fetchImpl(`${cfg.introspectionUrl}/${encodeURIComponent(sid)}`, { headers: { authorization: `Bearer ${cfg.introspectionSecret}` }, signal: AbortSignal.timeout(3000) });
    } catch (e) { const err = new Error('introspection unreachable'); err.status = 503; throw err; }
    if (!r.ok) { const err = new Error('introspection failed ' + r.status); err.status = 503; throw err; }
    const active = (await r.json()).active === true;
    cache.set(sid, { active, until: now() + 5000 });
    if (cache.size > 5000) for (const [k, v] of cache) if (v.until < now()) cache.delete(k);
    return active;
  }

  /** Verifies the cookie JWT (+ session liveness, + CSRF for unsafe methods). Sets req.actor / req.sid. No membership needed. */
  async function identity(req, res, next) {
    if (!cfg.authConfigured) return res.status(503).json({ error: 'Authentication is not configured' });
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return res.status(401).json({ error: 'Sign in required' });
    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer: cfg.issuer, audience: cfg.audience, algorithms: ['RS256', 'ES256'], clockTolerance: 5, maxTokenAge: '15m' }));
    } catch (e) {
      if (String(e.code || '').startsWith('ERR_J')) return res.status(401).json({ error: 'Session invalid or expired' });
      log?.error('jwt verification infrastructure error', { err: e.message });
      return res.status(503).json({ error: 'Authentication service unavailable' });
    }
    if (!UUID_RE.test(payload.sub || '') || typeof payload.sid !== 'string' || !/^[0-9a-f]{64}$/.test(payload.sid)) return res.status(401).json({ error: 'Invalid identity' });
    try { if (!(await sessionActive(payload.sid))) return res.status(401).json({ error: 'Session ended' }); }
    catch (e) { log?.error('session introspection failed', { err: e.message }); return res.status(503).json({ error: 'Authentication service unavailable' }); }

    if (!safeMethod(req.method)) {
      // browser writes must be same-origin AND carry the double-submit token whose hash MAIN bound into the signed JWT
      if (req.get('origin') !== cfg.origin || req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Origin rejected' });
      const cookie = parseCookies(req)[CSRF_COOKIE], header = req.get('x-csrf-token');
      if (!cookie || !header) return res.status(403).json({ error: 'CSRF token required' });
      if (!sameValue(cookie, header) || !payload.csrf || !sameValue(sha256hex(header), payload.csrf)) return res.status(403).json({ error: 'CSRF token invalid' });
    }
    req.actor = payload.sub.toLowerCase(); req.sid = payload.sid; req.claims = payload;   // the verified JWT payload (amr / auth_time are read for MFA decisions)
    next();
  }

  /** identity + workspace membership. The workspace is chosen from DATABASE membership only (X-Workspace-Id is just a selector). */
  async function member(req, res, next) {
    return identity(req, res, async (err) => {
      if (err) return next(err);
      try {
        const requested = req.get('x-workspace-id');
        if (requested && !UUID_RE.test(requested)) return res.status(400).json({ error: 'Invalid workspace' });
        const rows = (await pool.query('SELECT workspace_id, role FROM portal.members WHERE user_id=$1 ORDER BY workspace_id', [req.actor])).rows;
        if (!rows.length) return res.status(403).json({ error: 'No workspace membership' });
        const m = requested ? rows.find((r) => r.workspace_id === requested.toLowerCase()) : rows[0];
        if (!m) return res.status(403).json({ error: 'Not a workspace member' });
        req.workspace = m.workspace_id; req.role = m.role;
        next();
      } catch (e) { next(e); }
    });
  }
  const roles = (...allowed) => (req, res, next) => (allowed.includes(req.role) ? next() : res.status(403).json({ error: 'Insufficient role', required: allowed }));
  return { identity, member, roles, sessionActive };
}
export { SESSION_COOKIE, CSRF_COOKIE, sha256hex };
