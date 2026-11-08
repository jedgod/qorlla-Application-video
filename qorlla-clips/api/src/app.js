import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { createAuth } from './auth.js';
import { registerUploads } from './uploads.js';
import { registerInsights } from './insights.js';
import { registerIngest } from './ingest.js';
import { registerAvatars, draftObjectKey, jobPayload, maxSecondsFor } from './avatars.js';

const SOURCES = ['RECORDING', 'AVATAR_GENERATION', 'SLIDE_CONVERSION', 'UPLOAD'];
const uuid = z.string().uuid();
const title = z.string().trim().min(1).max(200);

const schemas = {
  list: z.object({
    view: z.enum(['recent', 'mine', 'starred', 'trash', 'shared', 'playlist']).default('recent'),
    playlistId: uuid.optional(),
    source: z.enum([...SOURCES, 'QORLLA_MEETING']).optional(),
    q: z.string().trim().max(100).optional(),
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  }),
  // avatar results are NOT created here: they are drafts (POST /avatars/drafts) and become clips only by an explicit promote
  create: z.object({ title: title.optional(), source: z.enum(SOURCES.filter((s) => s !== 'AVATAR_GENERATION')), playlistId: uuid.optional() }).strict(),
  patch: z.object({ title: title.optional(), isStarred: z.boolean().optional() }).strict().refine((v) => Object.keys(v).length > 0, 'nothing to change'),
  share: z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict(),
  playlist: z.object({ title, isOrganization: z.boolean().optional() }).strict(),
  playlistPatch: z.object({ title }).strict(),
  addToPlaylist: z.object({ clipId: uuid }).strict(),
  read: z.object({ ids: z.array(uuid).max(200).optional() }).strict(),
  complete: z.object({ status: z.enum(['READY', 'FAILED']), videoUrl: z.string().url().max(2000).optional() }).strict(),
  avatarComplete: z.object({ status: z.enum(['READY', 'FAILED']), videoUrl: z.string().url().max(2000).optional(), stored: z.boolean().optional(), durationMs: z.number().int().min(1).optional() }).strict(),
};

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Not found.' });
const forbidden = (res, message = 'You do not have permission to do that.') => res.status(403).json({ error: 'forbidden', message });

/**
 * @param {{prisma: import('@prisma/client').PrismaClient, config: ReturnType<import('./config.js').loadConfig>, fetchImpl?: typeof fetch, storage?: ReturnType<import('./storage.js').createStorage> | null}} deps
 */
export function createApp({ prisma, config, fetchImpl, storage = null, renderQueue = null }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); next(); });
  const allowed = new Set(config.corsOrigins);
  app.use(cors({ origin: (origin, cb) => cb(null, !origin || allowed.has(origin)), credentials: true, allowedHeaders: ['content-type', 'x-requested-with', 'x-dev-user', 'x-dev-org', 'x-dev-role', 'x-service-key'] }));
  app.use(express.json({ limit: '32kb', verify: (req, res, buf) => { req.rawBody = buf; } }));   // the webhook signs the exact bytes

  const ci = config.provider === 'postgresql' ? { mode: 'insensitive' } : {};

  app.get('/healthz', wrap(async (req, res) => {
    try { await prisma.$queryRaw`SELECT 1`; res.json({ ok: true }); } catch (e) { res.status(503).json({ ok: false }); }
  }));

  // ---- service-to-service: a media worker attaches the finished video to a clip ------------------------------------------------
  // Disabled unless SERVICE_KEY is set. The media host must be on the MEDIA_HOSTS allow-list, over https.
  app.post('/api/internal/clips/:id/complete', wrap(async (req, res) => {
    if (!config.serviceKey) return notFound(res);
    const given = String(req.headers['x-service-key'] || '');
    if (given.length !== config.serviceKey.length || !timingSafe(given, config.serviceKey)) return res.status(401).json({ error: 'unauthenticated' });
    const id = uuid.safeParse(req.params.id); if (!id.success) return notFound(res);
    const body = schemas.complete.parse(req.body);
    if (body.status === 'READY') {
      let u; try { u = new URL(body.videoUrl || ''); } catch (e) { u = null; }
      if (!u || u.protocol !== 'https:' || !config.mediaHosts.includes(u.hostname.toLowerCase())) return res.status(400).json({ error: 'invalid_media_host', message: 'videoUrl must be an https URL on an allowed media host.' });
    }
    const clip = await prisma.clip.findUnique({ where: { id: id.data } });
    if (!clip) return notFound(res);
    const updated = await prisma.clip.update({ where: { id: clip.id }, data: { status: body.status, videoUrl: body.status === 'READY' ? body.videoUrl : null } });
    res.json({ id: updated.id, status: updated.status });
  }));

  // ---- avatar drafts: the media worker's two calls. Both need SERVICE_KEY; neither is reachable by a browser session ----------------
  const serviceCaller = (req, res) => {
    if (!config.serviceKey) { notFound(res); return false; }
    const given = String(req.headers['x-service-key'] || '');
    if (given.length !== config.serviceKey.length || !timingSafe(given, config.serviceKey)) { res.status(401).json({ error: 'unauthenticated' }); return false; }
    return true;
  };

  // Drafts still waiting for a render (and older than 30 s, so a draft that was only just queued is not queued twice). The worker asks for
  // these every minute, which is what makes a Redis outage or a lost job harmless: the draft is in the database, so it is found again.
  app.get('/api/internal/avatar-drafts/pending', wrap(async (req, res) => {
    if (!serviceCaller(req, res)) return;
    if (config.avatarRenderer === 'none') return res.json({ drafts: [] });
    const rows = await prisma.avatarDraft.findMany({
      where: { status: 'PROCESSING', isPromoted: false, createdAt: { lt: new Date(Date.now() - 30000) } },
      orderBy: { createdAt: 'asc' }, take: 50, include: { avatar: true },
    });
    res.json({ drafts: rows.map(jobPayload) });
  }));

  // The worker reports a finished render: { status: 'READY', stored: true } (the video is in our storage under the key the SERVER chose; the
  // API checks that the object really exists and takes its size from storage), { status: 'FAILED' }, or a link { status: 'READY', videoUrl }
  // on an allowed https media host. The draft stays in the Avatars workspace; it is not a clip.
  app.post('/api/internal/avatar-drafts/:id/complete', wrap(async (req, res) => {
    if (!serviceCaller(req, res)) return;
    const id = uuid.safeParse(req.params.id); if (!id.success) return notFound(res);
    const body = schemas.avatarComplete.parse(req.body);
    const draft = await prisma.avatarDraft.findFirst({ where: { id: id.data, isPromoted: false }, include: { avatar: { select: { tier: true } } } });     // a promoted draft is already a clip; its media is frozen
    if (!draft) return notFound(res);
    let data;
    if (body.status === 'FAILED') data = { status: 'FAILED', videoUrl: null };
    else if (body.stored) {
      if (!storage) return res.status(503).json({ error: 'storage_unavailable', message: 'Object storage is not configured.' });
      const key = draftObjectKey(draft.organizationId, draft.id);
      let head = null; try { head = await storage.head(key); } catch (e) { return res.status(503).json({ error: 'storage_unavailable', message: 'Object storage is not reachable.' }); }
      if (!head || !(head.size > 0)) return res.status(409).json({ error: 'media_missing', message: 'No rendered video is stored for this draft.' });
      // the render may not be longer than its avatar's tier allows; a longer report is refused, not trimmed
      if (body.durationMs !== undefined && body.durationMs > maxSecondsFor(draft.avatar.tier) * 1000) return res.status(400).json({ error: 'too_long', message: `A ${draft.avatar.tier.toLowerCase()} avatar render may not be longer than ${maxSecondsFor(draft.avatar.tier)} seconds.` });
      data = { status: 'READY', videoUrl: null, storageKey: key, sizeBytes: BigInt(head.size), mimeType: 'video/mp4', durationMs: body.durationMs ?? null };
    } else {
      let u; try { u = new URL(body.videoUrl || ''); } catch (e) { u = null; }
      if (!u || u.protocol !== 'https:' || u.username || u.password || !config.mediaHosts.includes(u.hostname.toLowerCase())) return res.status(400).json({ error: 'invalid_media_host', message: 'videoUrl must be an https URL on an allowed media host.' });
      data = { status: 'READY', videoUrl: body.videoUrl };
    }
    const r = await prisma.avatarDraft.updateMany({ where: { id: draft.id, isPromoted: false }, data });
    if (r.count === 0) return notFound(res);
    res.json({ id: draft.id, status: data.status });
  }));

  registerIngest({ app, prisma, config });

  // ---- everything below needs a signed-in user ---------------------------------------------------------------------------------
  const rate = new Map();
  const authenticate = createAuth({ prisma, config, fetchImpl });
  const api = express.Router();
  api.use(authenticate);
  api.use((req, res, next) => {                                                      // per-user request budget
    const now = Date.now(); let r = rate.get(req.user.id);
    if (!r || r.reset < now) { r = { n: 0, reset: now + 60000 }; rate.set(req.user.id, r); }
    if (++r.n > config.rateLimitPerMinute) return res.status(429).json({ error: 'rate_limited', message: 'Too many requests. Slow down.' });
    next();
  });
  api.use((req, res, next) => {                                                      // cookie-authenticated writes must come from our own pages
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.headers['x-requested-with'] !== 'qorlla-clips') return res.status(403).json({ error: 'csrf', message: 'Missing request header.' });
    const origin = req.headers.origin;
    if (origin) {
      // Behind the Next.js / nginx proxy the Host header is the proxy's target, not what the browser used. When (and only when) this API
      // is reachable only through a trusted proxy (TRUST_PROXY=1) the browser's host is the first X-Forwarded-Host; otherwise the
      // public web origin must be listed in CORS_ORIGINS.
      const fwd = config.trustProxy ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
      const expected = fwd || req.headers.host;
      let host = ''; try { host = new URL(origin).host; } catch (e) { /* bad origin */ }
      if (!allowed.has(origin) && host !== expected) return res.status(403).json({ error: 'csrf', message: 'Cross-site request blocked.' });
    }
    next();
  });

  const clipDto = (c, me) => ({
    id: c.id, title: c.title, videoUrl: c.videoUrl, source: c.source, status: c.status,
    isStarred: c.isStarred, isTrashed: c.isTrashed, trashedAt: c.trashedAt, createdAt: c.createdAt, updatedAt: c.updatedAt,
    ownedByMe: c.ownerId === me.id, ownerName: c.owner ? c.owner.name : undefined,
    // storage keys and upload ids are internal and never leave the server
    playable: c.status === 'READY' && !!(c.storageKey || c.videoUrl),
    sizeBytes: c.sizeBytes == null ? null : Number(c.sizeBytes), mimeType: c.mimeType ?? null, durationMs: c.durationMs ?? null,
  });
  // A clip is visible to its owner, to people it was shared with, and to the organization once it sits in an organization playlist.
  const visible = (me) => ({ organizationId: me.orgId, OR: [{ ownerId: me.id }, { shares: { some: { userId: me.id } } }, { playlists: { some: { isOrganization: true, organizationId: me.orgId } } }] });
  const myClip = (me, id) => prisma.clip.findFirst({ where: { id, ownerId: me.id, organizationId: me.orgId } });
  const viewable = (me, id) => prisma.clip.findFirst({ where: { id, ...visible(me) } });
  // A playlist the caller may use: their own, or an organization playlist of their organization.
  const playlistFor = (me, id) => prisma.playlist.findFirst({ where: { id, organizationId: me.orgId, OR: [{ ownerId: me.id, isOrganization: false }, { isOrganization: true }] } });

  api.get('/me', (req, res) => res.json({ id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role }));

  api.get('/navigation/summary', wrap(async (req, res) => {
    const me = req.user;
    const [mine, starred, trash, shared, unread, playlists, organizationPlaylists, org] = await prisma.$transaction([
      prisma.clip.count({ where: { ownerId: me.id, organizationId: me.orgId, isTrashed: false } }),
      prisma.clip.count({ where: { ownerId: me.id, organizationId: me.orgId, isStarred: true, isTrashed: false } }),
      prisma.clip.count({ where: { ownerId: me.id, organizationId: me.orgId, isTrashed: true } }),
      prisma.clipShare.count({ where: { userId: me.id, clip: { isTrashed: false, organizationId: me.orgId } } }),
      prisma.notification.count({ where: { userId: me.id, readAt: null } }),
      prisma.playlist.findMany({ where: { ownerId: me.id, organizationId: me.orgId, isOrganization: false }, orderBy: { updatedAt: 'desc' }, take: 200, select: { id: true, title: true, _count: { select: { clips: true } } } }),
      prisma.playlist.findMany({ where: { organizationId: me.orgId, isOrganization: true }, orderBy: { updatedAt: 'desc' }, take: 200, select: { id: true, title: true, _count: { select: { clips: true } } } }),
      prisma.organization.findUnique({ where: { id: me.orgId }, select: { name: true, plan: true } }),
    ]);
    const dto = (p) => ({ id: p.id, title: p.title, clipCount: p._count.clips });
    res.json({ myClipsCount: mine, starredCount: starred, trashCount: trash, sharedCount: shared, unreadNotifications: unread,
      playlists: playlists.map(dto), organizationPlaylists: organizationPlaylists.map(dto),
      organization: org.name, features: { upload: org.plan !== 'free' }, role: me.role });
  }));

  api.get('/clips', wrap(async (req, res) => {
    const me = req.user; const p = schemas.list.parse(req.query);
    let where;
    if (p.view === 'recent') where = { ...visible(me), isTrashed: false };
    else if (p.view === 'mine') where = { ownerId: me.id, organizationId: me.orgId, isTrashed: false };
    else if (p.view === 'starred') where = { ownerId: me.id, organizationId: me.orgId, isStarred: true, isTrashed: false };
    else if (p.view === 'trash') where = { ownerId: me.id, organizationId: me.orgId, isTrashed: true };
    else if (p.view === 'shared') where = { organizationId: me.orgId, isTrashed: false, shares: { some: { userId: me.id } } };
    else {
      if (!p.playlistId) return res.status(400).json({ error: 'invalid_request', message: 'playlistId is required for view=playlist.' });
      if (!(await playlistFor(me, p.playlistId))) return notFound(res);
      // the visibility rule and the playlist filter both constrain `playlists`, so they are combined with AND
      where = { AND: [{ ...visible(me), isTrashed: false }, { playlists: { some: { id: p.playlistId } } }] };
    }
    if (p.source) where = { AND: [where, { source: p.source }] };
    if (p.q) where = { AND: [where, { title: { contains: p.q, ...ci } }] };
    const rows = await prisma.clip.findMany({
      where, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: p.limit + 1,
      ...(p.cursor ? { cursor: { id: p.cursor }, skip: 1 } : {}), include: { owner: { select: { name: true } } },
    });
    const page = rows.slice(0, p.limit);
    res.json({ clips: page.map((c) => clipDto(c, me)), nextCursor: rows.length > p.limit ? page[page.length - 1].id : null });
  }));

  api.post('/clips', wrap(async (req, res) => {
    const me = req.user; const b = schemas.create.parse(req.body);
    if (b.source === 'UPLOAD') {
      const org = await prisma.organization.findUnique({ where: { id: me.orgId }, select: { plan: true } });
      if (org.plan === 'free') return res.status(403).json({ error: 'feature_locked', feature: 'upload', message: 'Uploading video is available on paid plans.' });
    }
    let playlist = null;
    if (b.playlistId) { playlist = await playlistFor(me, b.playlistId); if (!playlist) return notFound(res); }
    const clip = await prisma.clip.create({
      data: { title: b.title || `Untitled clip - ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, source: b.source, status: 'PROCESSING', ownerId: me.id, organizationId: me.orgId, ...(playlist ? { playlists: { connect: { id: playlist.id } } } : {}) },
      include: { owner: { select: { name: true } } },
    });
    res.status(201).json(clipDto(clip, me));
  }));

  api.patch('/clips/:id', wrap(async (req, res) => {
    const me = req.user; const id = uuid.safeParse(req.params.id); if (!id.success) return notFound(res);
    const b = schemas.patch.parse(req.body);
    const clip = await myClip(me, id.data); if (!clip) return notFound(res);
    if (clip.isTrashed) return res.status(409).json({ error: 'in_trash', message: 'Restore the clip first.' });
    const u = await prisma.clip.update({ where: { id: clip.id }, data: b, include: { owner: { select: { name: true } } } });
    res.json(clipDto(u, me));
  }));

  api.post('/clips/:id/trash', wrap(async (req, res) => {
    const me = req.user; const id = uuid.safeParse(req.params.id); if (!id.success) return notFound(res);
    const clip = await myClip(me, id.data); if (!clip) return notFound(res);
    const u = await prisma.clip.update({ where: { id: clip.id }, data: { isTrashed: true, trashedAt: new Date() }, include: { owner: { select: { name: true } } } });
    res.json(clipDto(u, me));
  }));

  api.post('/clips/:id/restore', wrap(async (req, res) => {
    const me = req.user; const id = uuid.safeParse(req.params.id); if (!id.success) return notFound(res);
    const clip = await myClip(me, id.data); if (!clip) return notFound(res);
    const u = await prisma.clip.update({ where: { id: clip.id }, data: { isTrashed: false, trashedAt: null }, include: { owner: { select: { name: true } } } });
    res.json(clipDto(u, me));
  }));

  api.delete('/clips/:id', wrap(async (req, res) => {                              // permanent: only from the Trash, only by the owner
    const me = req.user; const id = uuid.safeParse(req.params.id); if (!id.success) return notFound(res);
    const clip = await myClip(me, id.data); if (!clip) return notFound(res);
    if (!clip.isTrashed) return res.status(409).json({ error: 'not_in_trash', message: 'Move the clip to Trash before deleting it forever.' });
    await prisma.clip.delete({ where: { id: clip.id } });
    // the video goes too (and any upload still open). A storage hiccup must not make the delete fail: it is logged for clean-up.
    if (storage && clip.storageKey) {
      try { if (clip.uploadId) await storage.abort(clip.storageKey, clip.uploadId); await storage.remove(clip.storageKey); }
      catch (e) { console.error('[clips-api] could not remove media for deleted clip', clip.id, e && e.message); }
    }
    res.json({ ok: true });
  }));

  api.post('/clips/:id/share', wrap(async (req, res) => {
    const me = req.user; const id = uuid.safeParse(req.params.id); if (!id.success) return notFound(res);
    const b = schemas.share.parse(req.body);
    const clip = await myClip(me, id.data); if (!clip) return notFound(res);
    if (clip.isTrashed) return res.status(409).json({ error: 'in_trash', message: 'Restore the clip first.' });
    // recipients are looked up INSIDE the caller's organization only: another organization's users do not exist here
    const target = await prisma.user.findFirst({ where: { email: b.email, organizationId: me.orgId } });
    if (!target) return res.status(404).json({ error: 'no_such_user', message: 'No one in your organization has that email address.' });
    if (target.id === me.id) return res.status(400).json({ error: 'invalid_request', message: 'You already own this clip.' });
    // Sharing again is harmless and silent: only a NEW share notifies. Two simultaneous requests race on the unique (clip, user) key.
    let created = true;
    try { await prisma.clipShare.create({ data: { clipId: clip.id, userId: target.id } }); }
    catch (e) { if (e && e.code === 'P2002') created = false; else throw e; }
    if (created) await prisma.notification.create({ data: { userId: target.id, type: 'clip_shared', clipId: clip.id, message: `${me.name || me.email} shared "${clip.title}" with you` } });
    res.status(201).json({ ok: true });
  }));

  api.delete('/clips/:id/share/:userId', wrap(async (req, res) => {
    const me = req.user; const id = uuid.safeParse(req.params.id), uid = uuid.safeParse(req.params.userId);
    if (!id.success || !uid.success) return notFound(res);
    const clip = await myClip(me, id.data); if (!clip) return notFound(res);
    await prisma.clipShare.deleteMany({ where: { clipId: clip.id, userId: uid.data } });
    res.json({ ok: true });
  }));

  // ---- playlists ----------------------------------------------------------------------------------------------------------------
  const mayManage = (me, pl) => (pl.isOrganization ? me.role === 'ADMIN' : pl.ownerId === me.id);

  api.get('/playlists', wrap(async (req, res) => {
    const me = req.user; const scope = req.query.scope === 'organization' ? 'organization' : 'mine';
    const where = scope === 'organization' ? { organizationId: me.orgId, isOrganization: true } : { organizationId: me.orgId, ownerId: me.id, isOrganization: false };
    const rows = await prisma.playlist.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200, select: { id: true, title: true, isOrganization: true, createdAt: true, _count: { select: { clips: true } } } });
    res.json({ playlists: rows.map((p) => ({ id: p.id, title: p.title, isOrganization: p.isOrganization, createdAt: p.createdAt, clipCount: p._count.clips })) });
  }));

  api.post('/playlists', wrap(async (req, res) => {
    const me = req.user; const b = schemas.playlist.parse(req.body);
    if (b.isOrganization && me.role !== 'ADMIN') return forbidden(res, 'Only organization admins can create organization playlists.');
    const p = await prisma.playlist.create({ data: { title: b.title, isOrganization: !!b.isOrganization, ownerId: me.id, organizationId: me.orgId } });
    res.status(201).json({ id: p.id, title: p.title, isOrganization: p.isOrganization, clipCount: 0 });
  }));

  api.patch('/playlists/:id', wrap(async (req, res) => {
    const me = req.user; const id = uuid.safeParse(req.params.id); if (!id.success) return notFound(res);
    const b = schemas.playlistPatch.parse(req.body);
    const pl = await playlistFor(me, id.data); if (!pl) return notFound(res);
    if (!mayManage(me, pl)) return forbidden(res);
    const u = await prisma.playlist.update({ where: { id: pl.id }, data: { title: b.title } });
    res.json({ id: u.id, title: u.title, isOrganization: u.isOrganization });
  }));

  api.delete('/playlists/:id', wrap(async (req, res) => {                          // removes the playlist only; its clips are kept
    const me = req.user; const id = uuid.safeParse(req.params.id); if (!id.success) return notFound(res);
    const pl = await playlistFor(me, id.data); if (!pl) return notFound(res);
    if (!mayManage(me, pl)) return forbidden(res);
    await prisma.playlist.delete({ where: { id: pl.id } });
    res.json({ ok: true });
  }));

  api.post('/playlists/:id/clips', wrap(async (req, res) => {
    const me = req.user; const id = uuid.safeParse(req.params.id); if (!id.success) return notFound(res);
    const b = schemas.addToPlaylist.parse(req.body);
    const pl = await playlistFor(me, id.data); if (!pl) return notFound(res);
    const clip = await viewable(me, b.clipId); if (!clip) return notFound(res);
    // putting a clip into an organization playlist shows it to the whole organization: only its owner (or an admin) may do that
    if (pl.isOrganization && clip.ownerId !== me.id && me.role !== 'ADMIN') return forbidden(res, 'Only the owner of a clip can add it to an organization playlist.');
    if (!pl.isOrganization && clip.ownerId !== me.id) return forbidden(res, 'You can only add your own clips to your playlists.');
    if (clip.isTrashed) return res.status(409).json({ error: 'in_trash', message: 'Restore the clip first.' });
    await prisma.playlist.update({ where: { id: pl.id }, data: { clips: { connect: { id: clip.id } } } });
    res.status(201).json({ ok: true });
  }));

  api.delete('/playlists/:id/clips/:clipId', wrap(async (req, res) => {
    const me = req.user; const id = uuid.safeParse(req.params.id), cid = uuid.safeParse(req.params.clipId);
    if (!id.success || !cid.success) return notFound(res);
    const pl = await playlistFor(me, id.data); if (!pl) return notFound(res);
    const clip = await prisma.clip.findFirst({ where: { id: cid.data, organizationId: me.orgId } }); if (!clip) return notFound(res);
    const may = pl.isOrganization ? (me.role === 'ADMIN' || clip.ownerId === me.id) : pl.ownerId === me.id;
    if (!may) return forbidden(res);
    await prisma.playlist.update({ where: { id: pl.id }, data: { clips: { disconnect: { id: clip.id } } } });
    res.json({ ok: true });
  }));

  // ---- notifications ------------------------------------------------------------------------------------------------------------
  api.get('/notifications', wrap(async (req, res) => {
    const rows = await prisma.notification.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    res.json({ notifications: rows.map((n) => ({ id: n.id, type: n.type, message: n.message, clipId: n.clipId, read: !!n.readAt, createdAt: n.createdAt })) });
  }));
  api.post('/notifications/read', wrap(async (req, res) => {
    const b = schemas.read.parse(req.body || {});
    const r = await prisma.notification.updateMany({ where: { userId: req.user.id, readAt: null, ...(b.ids ? { id: { in: b.ids } } : {}) }, data: { readAt: new Date() } });
    res.json({ updated: r.count });
  }));

  registerUploads({ api, prisma, config, storage, wrap, notFound, clipDto, myClip, viewable, uuid });

  registerInsights({ api, prisma, wrap, notFound, uuid, viewable });

  registerAvatars({ api, prisma, config, wrap, notFound, clipDto, storage, renderQueue });

  app.use('/api', api);
  app.use('/api', (req, res) => notFound(res));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'invalid_request', message: 'The request is not valid.', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
    if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'invalid_json' });
    console.error('[clips-api]', err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err);
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong.' });
  });
  return app;
}

import { timingSafeEqual } from 'node:crypto';
function timingSafe(a, b) { try { return timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch (e) { return false; } }
