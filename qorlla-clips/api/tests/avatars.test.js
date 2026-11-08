import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { tierForPlan } from '../src/avatars.js';
import { seedAvatars, CATALOG } from '../scripts/seed-avatars.mjs';
import { configFor, call, world, uniq, prisma } from './helpers.js';

let srv, base;
before(async () => {
  await seedAvatars(prisma);
  const app = createApp({ prisma, config: configFor({ serviceKey: 'k'.repeat(40), mediaHosts: ['media.example.test'] }) });
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => { await new Promise((r) => srv.close(r)); await prisma.$disconnect(); });

const templates = (u) => call(base, u, 'GET', '/api/avatars/templates');
const slugId = async (slug) => (await prisma.inbuiltAvatar.findUnique({ where: { slug } })).id;
const mkDraft = (u, slug, title) => slugId(slug).then((avatarId) => call(base, u, 'POST', '/api/avatars/drafts', { avatarId, ...(title ? { title } : {}) }));
const render = (id, body = { status: 'READY', videoUrl: 'https://media.example.test/v/' + uniq() + '.mp4' }) =>
  call(base, null, 'POST', `/api/internal/avatar-drafts/${id}/complete`, body, { 'x-service-key': 'k'.repeat(40) });
const myClips = async (u) => (await call(base, u, 'GET', '/api/clips?view=mine')).body.clips;

describe('avatar tiers', () => {
  test('the tier comes from the organization plan: basic/free -> BASIC, pro -> MODERATE, business/enterprise -> ELITE; unknown plans fail closed', () => {
    assert.equal(tierForPlan('free'), 'BASIC'); assert.equal(tierForPlan(undefined), 'BASIC');
    assert.equal(tierForPlan('basic'), 'BASIC'); assert.equal(tierForPlan('Basic'), 'BASIC'); assert.equal(tierForPlan('mystery-plan'), 'BASIC');
    assert.equal(tierForPlan('pro'), 'MODERATE'); assert.equal(tierForPlan('Business'), 'ELITE'); assert.equal(tierForPlan('enterprise'), 'ELITE');
  });

  test('seeding is idempotent and never changes an existing avatar', async () => {
    const before = await prisma.inbuiltAvatar.findUnique({ where: { slug: CATALOG[0].slug } });
    await prisma.inbuiltAvatar.update({ where: { id: before.id }, data: { name: 'Edited by hand' } });
    const r = await seedAvatars(prisma);
    assert.equal(r.added, 0);
    assert.equal((await prisma.inbuiltAvatar.findUnique({ where: { id: before.id } })).name, 'Edited by hand', 'an existing row is left alone');
    await prisma.inbuiltAvatar.update({ where: { id: before.id }, data: { name: before.name } });
    assert.equal(await prisma.inbuiltAvatar.count({ where: { slug: { in: CATALOG.map((a) => a.slug) } } }), CATALOG.length);
  });

  test('templates: a free organization sees only BASIC; locked ones are listed without their media key; role does not unlock anything', async () => {
    const { a, m1 } = await world(base);                               // a is an ADMIN of a free organization
    for (const u of [a, m1]) {
      const r = await templates(u); assert.equal(r.status, 200);
      assert.equal(r.body.tier, 'BASIC');
      assert.ok(r.body.templates.length >= 2 && r.body.templates.every((t) => t.tier === 'BASIC'));
      assert.ok(r.body.locked.length >= 4 && r.body.locked.every((t) => t.tier !== 'BASIC'));
      assert.ok(!/modelKey|avatars\/models/.test(r.text), 'the media key never leaves the server');
    }
  });

  test('templates: moderate plan sees BASIC+MODERATE; elite plan sees all', async () => {
    const pro = await world(base, { plan: 'pro' });
    const t = (await templates(pro.m1)).body;
    assert.deepEqual([...new Set(t.templates.map((x) => x.tier))].sort(), ['BASIC', 'MODERATE']); assert.ok(t.locked.every((x) => x.tier === 'ELITE'));
    const biz = await world(base, { plan: 'business' });
    const e = (await templates(biz.m1)).body; assert.equal(e.locked.length, 0); assert.ok(e.templates.some((x) => x.tier === 'ELITE'));
  });

  test('a draft with an avatar above the plan tier is refused (403) and nothing is created; an unknown avatar is 404', async () => {
    const free = await world(base);
    const r = await mkDraft(free.a, 'zephyr-premium-anchor'); assert.equal(r.status, 403); assert.equal(r.body.error, 'feature_locked'); assert.equal(r.body.requiredTier, 'ELITE');
    assert.equal((await mkDraft(free.m1, 'marcus-studio-cinematic')).status, 403);
    assert.equal((await call(base, free.m1, 'GET', '/api/avatars/drafts')).body.drafts.length, 0);
    assert.equal((await call(base, free.m1, 'POST', '/api/avatars/drafts', { avatarId: '00000000-0000-4000-8000-000000000000' })).status, 404);
    assert.equal((await call(base, free.m1, 'POST', '/api/avatars/drafts', { avatarId: 'nope' })).status, 400);
    assert.equal((await call(base, free.m1, 'POST', '/api/avatars/drafts', { avatarId: await slugId('alex-corporate-presenter'), extra: 1 })).status, 400, 'strict input');
    const pro = await world(base, { plan: 'pro' });
    assert.equal((await mkDraft(pro.m1, 'marcus-studio-cinematic')).status, 201);
    assert.equal((await mkDraft(pro.m1, 'zephyr-premium-anchor')).status, 403, 'moderate cannot reach elite');
  });
});

describe('avatar drafts stay out of My Clips until promoted', () => {
  test('creating and rendering a draft adds NOTHING to My Clips, Recent, counts or the avatar filter', async () => {
    const w = await world(base);
    const made = await mkDraft(w.m1, 'alex-corporate-presenter', 'Intro'); assert.equal(made.status, 201); assert.equal(made.body.status, 'PROCESSING'); assert.equal(made.body.isPromoted, false);
    assert.equal((await render(made.body.id)).status, 200);
    assert.equal((await myClips(w.m1)).length, 0);
    assert.equal((await call(base, w.m1, 'GET', '/api/clips?view=recent')).body.clips.length, 0);
    assert.equal((await call(base, w.m1, 'GET', '/api/clips?view=mine&source=AVATAR_GENERATION')).body.clips.length, 0);
    assert.equal((await call(base, w.m1, 'GET', '/api/navigation/summary')).body.myClipsCount, 0);
    const d = (await call(base, w.m1, 'GET', '/api/avatars/drafts')).body.drafts; assert.equal(d.length, 1); assert.equal(d[0].status, 'READY'); assert.equal(d[0].playable, true);
  });

  test('an avatar clip can no longer be created through POST /clips', async () => {
    const { m1 } = await world(base);
    assert.equal((await call(base, m1, 'POST', '/api/clips', { source: 'AVATAR_GENERATION' })).status, 400);
    assert.equal((await myClips(m1)).length, 0);
  });

  test('promote: not ready -> 409; ready -> 201 and it now appears in My Clips; again -> 409 and still exactly one clip', async () => {
    const w = await world(base);
    const d = (await mkDraft(w.m1, 'elena-casual-instructor', 'Lesson')).body;
    const early = await call(base, w.m1, 'POST', `/api/avatars/drafts/${d.id}/promote`, {}); assert.equal(early.status, 409); assert.equal(early.body.error, 'not_ready');
    assert.equal((await myClips(w.m1)).length, 0);
    await render(d.id);
    const ok = await call(base, w.m1, 'POST', `/api/avatars/drafts/${d.id}/promote`, {}); assert.equal(ok.status, 201);
    assert.equal(ok.body.clip.source, 'AVATAR_GENERATION'); assert.equal(ok.body.clip.status, 'READY'); assert.equal(ok.body.clip.title, 'Lesson'); assert.equal(ok.body.clip.playable, true);
    assert.deepEqual((await myClips(w.m1)).map((c) => c.id), [ok.body.clip.id]);
    const again = await call(base, w.m1, 'POST', `/api/avatars/drafts/${d.id}/promote`, {}); assert.equal(again.status, 409); assert.equal(again.body.error, 'already_promoted');
    assert.equal((await myClips(w.m1)).length, 1);
    const after = (await call(base, w.m1, 'GET', '/api/avatars/drafts')).body.drafts[0]; assert.equal(after.isPromoted, true); assert.equal(after.promotedClipId, ok.body.clip.id);
  });

  test('two simultaneous promotes make exactly one clip', async () => {
    const w = await world(base);
    const d = (await mkDraft(w.m1, 'alex-corporate-presenter')).body; await render(d.id);
    const rs = await Promise.all([1, 2, 3, 4].map(() => call(base, w.m1, 'POST', `/api/avatars/drafts/${d.id}/promote`, {})));
    assert.equal(rs.filter((r) => r.status === 201).length, 1, rs.map((r) => r.status).join(','));
    assert.ok(rs.every((r) => r.status === 201 || r.status === 409));
    assert.equal((await myClips(w.m1)).length, 1);
  });

  test("nobody else can see, promote, delete or complete someone's draft; promoted media is frozen; a bad media host is refused", async () => {
    const w = await world(base);
    const d = (await mkDraft(w.m1, 'alex-corporate-presenter')).body; await render(d.id);
    for (const [m, p, body] of [['POST', `/api/avatars/drafts/${d.id}/promote`, {}], ['DELETE', `/api/avatars/drafts/${d.id}`, undefined]]) assert.equal((await call(base, w.m2, m, p, body)).status, 404, `${m} ${p}`);
    assert.equal((await call(base, w.m2, 'GET', '/api/avatars/drafts')).body.drafts.length, 0);
    const other = await world(base); assert.equal((await call(base, other.a, 'POST', `/api/avatars/drafts/${d.id}/promote`, {})).status, 404, 'another organization');
    assert.equal((await myClips(w.m2)).length, 0);
    assert.equal((await render(d.id, { status: 'READY', videoUrl: 'https://evil.example.test/x.mp4' })).status, 400);
    assert.equal((await render(d.id, { status: 'READY', videoUrl: 'http://media.example.test/x.mp4' })).status, 400);
    assert.equal((await call(base, null, 'POST', `/api/internal/avatar-drafts/${d.id}/complete`, { status: 'FAILED' }, { 'x-service-key': 'wrong'.repeat(8) })).status, 401);
    assert.equal((await call(base, w.m1, 'POST', `/api/avatars/drafts/${d.id}/promote`, {})).status, 201);
    assert.equal((await render(d.id, { status: 'FAILED' })).status, 404, 'a promoted draft is no longer changed by the worker');
    assert.equal((await call(base, w.m1, 'DELETE', `/api/avatars/drafts/${d.id}`)).status, 404, 'a promoted draft cannot be deleted; the clip is its own');
    assert.equal((await myClips(w.m1)).length, 1);
  });

  test('discarding an unpromoted draft removes it and leaves My Clips alone; a failed render cannot be promoted', async () => {
    const w = await world(base);
    const d = (await mkDraft(w.m1, 'alex-corporate-presenter')).body;
    assert.equal((await render(d.id, { status: 'FAILED' })).status, 200);
    assert.equal((await call(base, w.m1, 'POST', `/api/avatars/drafts/${d.id}/promote`, {})).status, 409);
    assert.equal((await call(base, w.m1, 'DELETE', `/api/avatars/drafts/${d.id}`)).status, 200);
    assert.equal((await call(base, w.m1, 'GET', '/api/avatars/drafts')).body.drafts.length, 0);
    assert.equal((await myClips(w.m1)).length, 0);
  });

  test('writes need the same-site header (CSRF) like every other write', async () => {
    const { m1 } = await world(base);
    const r = await fetch(base + '/api/avatars/drafts', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user': m1.email, 'x-dev-org': m1.org }, body: JSON.stringify({ avatarId: await slugId('alex-corporate-presenter') }) });
    assert.equal(r.status, 403);
  });

  test('a free organization is held to its clip allowance when it promotes', async () => {
    const w = await world(base);
    const d = (await mkDraft(w.m1, 'alex-corporate-presenter')).body; await render(d.id);
    const app2 = createApp({ prisma, config: configFor({ freeMaxClips: 1 }) });
    const s2 = await new Promise((r) => { const s = app2.listen(0, '127.0.0.1', () => r(s)); }); const b2 = `http://127.0.0.1:${s2.address().port}`;
    try {
      const me = (await call(b2, w.m1, 'GET', '/api/me')).body; const org = await prisma.organization.findUnique({ where: { slug: w.org } });
      await prisma.clip.create({ data: { title: 'existing', status: 'READY', source: 'RECORDING', ownerId: me.id, organizationId: org.id, videoUrl: 'https://media.example.test/e.mp4' } });
      const r = await call(b2, w.m1, 'POST', `/api/avatars/drafts/${d.id}/promote`, {}); assert.equal(r.status, 403); assert.equal(r.body.error, 'quota_exceeded');
      assert.equal((await prisma.avatarDraft.findUnique({ where: { id: d.id } })).isPromoted, false, 'a refused promote leaves the draft untouched');
    } finally { await new Promise((r) => s2.close(r)); }
  });
});
