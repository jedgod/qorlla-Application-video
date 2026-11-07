/**
 * Who is calling?
 *
 *  qorlla  (production): the browser's Qorlla session cookie is forwarded to the main app's /api/auth/me. A logout, suspension or
 *          expiry in the main app therefore takes effect on the very next request (identity is not cached unless IDENTITY_CACHE_MS
 *          is set). If the main app cannot be reached the request FAILS (503); it is never allowed through.
 *  dev     (local only, refused when NODE_ENV=production): the x-dev-user header names an email. This replaces the "mock user" of a
 *          prototype and exists so tests and local work need no main app.
 *
 * In both modes the caller is mapped to a row in User inside exactly one Organization; every later query is scoped by it.
 */
import { createHash } from 'node:crypto';

export function createAuth({ prisma, config, fetchImpl = globalThis.fetch }) {
  const cache = new Map();

  async function org(slug, name) {
    return prisma.organization.upsert({ where: { slug }, update: {}, create: { slug, name } });
  }

  async function identify(req) {
    if (config.authMode === 'dev') {
      const email = String(req.headers['x-dev-user'] || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) return null;
      return { externalId: null, email, name: email.split('@')[0], orgSlug: String(req.headers['x-dev-org'] || config.orgSlug), orgName: config.orgName, role: String(req.headers['x-dev-role'] || '').toLowerCase() === 'admin' ? 'ADMIN' : 'MEMBER' };
    }
    const cookie = req.headers.cookie;
    if (!cookie) return null;
    const key = config.identityCacheMs ? createHash('sha256').update(cookie).digest('hex') : null;
    if (key) { const hit = cache.get(key); if (hit && hit.until > Date.now()) return hit.value; }
    let res;
    try { res = await fetchImpl(config.mainUrl + '/api/auth/me', { headers: { cookie, accept: 'application/json' }, signal: AbortSignal.timeout(5000) }); }
    catch (e) { const err = new Error('identity_unavailable'); err.code = 'identity_unavailable'; throw err; }
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) { const err = new Error('identity_unavailable'); err.code = 'identity_unavailable'; throw err; }
    const body = await res.json().catch(() => null);
    const u = body && body.user;
    if (!u || typeof u.id !== 'string' || !u.id) return null;
    const username = String(u.username || '').toLowerCase();
    const value = {
      externalId: u.id,
      email: String(u.email || (username ? `${username}@users.qorlla.invalid` : `${u.id}@users.qorlla.invalid`)).toLowerCase(),
      name: u.displayName || u.username || null,
      orgSlug: config.orgSlug, orgName: config.orgName,
      role: username && config.adminUsernames.includes(username) ? 'ADMIN' : 'MEMBER',
    };
    if (key) cache.set(key, { value, until: Date.now() + config.identityCacheMs });
    return value;
  }

  const raced = (e) => e && e.code === 'P2002';     // another request created the same row a moment ago

  async function resolve(id) {
    // A new user's first page load fires several API calls at once; each tries to create the same organization and user.
    // The loser of the race gets a unique-key error and simply reads the row the winner made.
    let o;
    try { o = await org(id.orgSlug, id.orgName); } catch (e) { if (!raced(e)) throw e; o = await prisma.organization.findUnique({ where: { slug: id.orgSlug } }); }
    const find = () => (id.externalId ? prisma.user.findUnique({ where: { externalId: id.externalId } }) : prisma.user.findUnique({ where: { email: id.email } }));
    let user = await find();
    if (!user) {
      try { user = await prisma.user.create({ data: { externalId: id.externalId, email: id.email, name: id.name, role: id.role, organizationId: o.id } }); }
      catch (e) { if (!raced(e)) throw e; user = await find(); if (!user) throw e; }
    } else {
      const patch = {};
      if (id.name && id.name !== user.name) patch.name = id.name;
      // in production the admin list is authoritative on every request; in dev the role is only set when the user is created
      if (config.authMode === 'qorlla' && id.role !== user.role) patch.role = id.role;
      if (Object.keys(patch).length) user = await prisma.user.update({ where: { id: user.id }, data: patch });
    }
    return { id: user.id, orgId: user.organizationId, role: user.role, email: user.email, name: user.name };
  }

  /** Express middleware: sets req.user or answers 401 / 503. */
  return async function authenticate(req, res, next) {
    try {
      const id = await identify(req);
      if (!id) return res.status(401).json({ error: 'unauthenticated', message: 'Sign in to Qorlla to use Clips.' });
      req.user = await resolve(id);
      return next();
    } catch (e) {
      if (e && e.code === 'identity_unavailable') return res.status(503).json({ error: 'identity_unavailable', message: 'Sign-in could not be verified. Try again shortly.' });
      return next(e);
    }
  };
}
