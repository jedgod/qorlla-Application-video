/**
 * Pre-built avatars and avatar drafts. Mounted on the authenticated /api router by app.js.
 *
 *   GET    /avatars/templates            the avatars this person's plan may use (+ the locked ones, without their media key)
 *   GET    /avatars/drafts               this person's drafts: the Avatars workspace
 *   POST   /avatars/drafts               { avatarId, title? }  make a draft with an allowed avatar (403 feature_locked above the plan's tier)
 *   DELETE /avatars/drafts/:id           discard a draft that has not been promoted
 *   POST   /avatars/drafts/:id/promote   the ONLY way an avatar result becomes a Clip (and so appears in My Clips)
 *
 * Separation: a draft is an AvatarDraft row, not a Clip. Nothing in the clip queries (My Clips, Recent, Shared, quotas, analytics,
 * storage) can see it. Promotion creates a Clip in one transaction that also claims the draft, so a double click or two tabs yield
 * exactly one clip.
 *
 * Tiers come from the ORGANIZATION'S PLAN, not from the role: an admin of a free organization does not get paid avatars.
 *   free / basic -> BASIC     pro -> PRO     business -> BUSINESS     enterprise -> ENTERPRISE     an unknown plan name -> BASIC (fail closed)
 * A plan unlocks its own tier and every tier below it. Role never unlocks anything: an admin of a Basic organization still sees Basic only.
 * The catalog (InbuiltAvatar) has no write route; scripts/seed-avatars.mjs only inserts rows that do not exist yet.
 */
import { z } from 'zod';

export const TIER_RANK = { BASIC: 0, PRO: 1, BUSINESS: 2, ENTERPRISE: 3 };
const TIER_PLAN = { PRO: 'Pro', BUSINESS: 'Business', ENTERPRISE: 'Enterprise' };
export const MAX_OPEN_DRAFTS = 50;

/** The highest avatar tier an organization plan unlocks. */
export function tierForPlan(plan) {
  const p = String(plan || 'free').trim().toLowerCase();
  if (p === 'enterprise') return 'ENTERPRISE';
  if (p === 'business') return 'BUSINESS';
  if (p === 'pro') return 'PRO';
  return 'BASIC';                                                                   // free, basic, empty, or any plan name we do not know: fail closed
}

const uuid = z.string().uuid();
const createBody = z.object({ avatarId: uuid, title: z.string().trim().min(1).max(200).optional() }).strict();

export function registerAvatars({ api, prisma, config, wrap, notFound, clipDto, uuid: _uuid }) {
  // modelKey is internal: it never leaves the server
  const avatarDto = (a) => ({ id: a.id, slug: a.slug, name: a.name, thumbnailUrl: a.thumbnailUrl, tier: a.tier });
  const draftDto = (d) => ({
    id: d.id, title: d.title, status: d.status, isPromoted: d.isPromoted, promotedClipId: d.promotedClipId,
    playable: d.status === 'READY' && !!d.videoUrl, createdAt: d.createdAt, updatedAt: d.updatedAt,
    avatar: d.avatar ? avatarDto(d.avatar) : undefined,
  });
  const myTier = async (me) => {
    const org = await prisma.organization.findUnique({ where: { id: me.orgId }, select: { plan: true } });
    return { plan: org.plan, tier: tierForPlan(org.plan) };
  };

  api.get('/avatars/templates', wrap(async (req, res) => {
    const { tier } = await myTier(req.user);
    const all = (await prisma.inbuiltAvatar.findMany({ orderBy: { name: 'asc' } })).sort((x, y) => TIER_RANK[x.tier] - TIER_RANK[y.tier]);   // by rank, not by database enum order
    const allowed = all.filter((a) => TIER_RANK[a.tier] <= TIER_RANK[tier]);
    const locked = all.filter((a) => TIER_RANK[a.tier] > TIER_RANK[tier]);
    res.json({ tier, templates: allowed.map(avatarDto), locked: locked.map(avatarDto) });
  }));

  api.get('/avatars/drafts', wrap(async (req, res) => {
    const me = req.user;
    const rows = await prisma.avatarDraft.findMany({
      where: { ownerId: me.id, organizationId: me.orgId }, orderBy: { createdAt: 'desc' }, take: 100, include: { avatar: true },
    });
    res.json({ drafts: rows.map(draftDto) });
  }));

  api.post('/avatars/drafts', wrap(async (req, res) => {
    const me = req.user; const b = createBody.parse(req.body);
    const avatar = await prisma.inbuiltAvatar.findUnique({ where: { id: b.avatarId } });
    if (!avatar) return notFound(res);
    const { tier } = await myTier(me);
    if (TIER_RANK[avatar.tier] > TIER_RANK[tier]) {
      return res.status(403).json({ error: 'feature_locked', feature: 'avatar_tier', requiredTier: avatar.tier, message: `This avatar is included in the ${TIER_PLAN[avatar.tier] || avatar.tier} plan and above. Upgrade your plan to use it.` });
    }
    const open = await prisma.avatarDraft.count({ where: { ownerId: me.id, organizationId: me.orgId, isPromoted: false } });
    if (open >= MAX_OPEN_DRAFTS) return res.status(403).json({ error: 'quota_exceeded', feature: 'avatar_drafts', message: `You can keep up to ${MAX_OPEN_DRAFTS} unsaved avatar drafts. Save or delete some first.` });
    const d = await prisma.avatarDraft.create({
      data: { title: b.title || `${avatar.name} - ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, avatarId: avatar.id, ownerId: me.id, organizationId: me.orgId },
      include: { avatar: true },
    });
    res.status(201).json(draftDto(d));
  }));

  api.delete('/avatars/drafts/:id', wrap(async (req, res) => {
    const me = req.user; const id = uuid.safeParse(req.params.id); if (!id.success) return notFound(res);
    const r = await prisma.avatarDraft.deleteMany({ where: { id: id.data, ownerId: me.id, organizationId: me.orgId, isPromoted: false } });
    if (r.count === 0) return notFound(res);                                         // not yours, not there, or already saved to Clips (that clip is its own)
    res.json({ ok: true });
  }));

  api.post('/avatars/drafts/:id/promote', wrap(async (req, res) => {
    const me = req.user; const id = uuid.safeParse(req.params.id); if (!id.success) return notFound(res);
    const draft = await prisma.avatarDraft.findFirst({ where: { id: id.data, ownerId: me.id, organizationId: me.orgId } });
    if (!draft) return notFound(res);                                                // someone else's draft looks exactly like a missing one
    if (draft.isPromoted) return res.status(409).json({ error: 'already_promoted', message: 'This avatar clip is already saved to My Clips.' });
    if (draft.status !== 'READY' || !draft.videoUrl) return res.status(409).json({ error: 'not_ready', message: 'This avatar clip is not ready yet.' });

    const org = await prisma.organization.findUnique({ where: { id: me.orgId }, select: { plan: true } });
    if (org.plan === 'free') {                                                       // the free-plan clip allowance applies once it becomes a clip
      const have = await prisma.clip.count({ where: { ownerId: me.id, organizationId: me.orgId } });
      if (have >= config.freeMaxClips) return res.status(403).json({ error: 'quota_exceeded', feature: 'storage', message: `The free plan holds up to ${config.freeMaxClips} clips. Delete some clips (and empty the trash) or upgrade.` });
    }

    let clip;
    try {
      clip = await prisma.$transaction(async (tx) => {
        // claim the draft first: of two simultaneous requests only one can flip isPromoted from false
        const claimed = await tx.avatarDraft.updateMany({ where: { id: draft.id, ownerId: me.id, isPromoted: false, status: 'READY' }, data: { isPromoted: true } });
        if (claimed.count !== 1) throw Object.assign(new Error('claimed'), { code: 'CLAIMED' });
        const c = await tx.clip.create({
          data: { title: draft.title, videoUrl: draft.videoUrl, source: 'AVATAR_GENERATION', status: 'READY', ownerId: me.id, organizationId: me.orgId },
          include: { owner: { select: { name: true } } },
        });
        await tx.avatarDraft.update({ where: { id: draft.id }, data: { promotedClipId: c.id } });
        return c;
      });
    } catch (e) {
      if (e && e.code === 'CLAIMED') return res.status(409).json({ error: 'already_promoted', message: 'This avatar clip is already saved to My Clips.' });
      throw e;
    }
    res.status(201).json({ clip: clipDto(clip, me) });
  }));
}
