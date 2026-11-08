import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { draftObjectKey } from '../src/avatars.js';
import { seedAvatars } from '../scripts/seed-avatars.mjs';
import { FakeStorage } from './fake-storage.js';
import { configFor, call, world, prisma } from './helpers.js';

const KEY = 'k'.repeat(40);
const jobs = []; let failQueue = false;
const queue = { add: async (name, data, opts) => { if (failQueue) throw new Error('redis down'); jobs.push({ name, data, opts }); } };
const storage = new FakeStorage();
let on, off, onBase, offBase;

const boot = async (over, extra) => {
  const app = createApp({ prisma, config: configFor({ serviceKey: KEY, mediaHosts: ['media.example.test'], ...over }), ...extra });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};
before(async () => {
  await seedAvatars(prisma);
  ({ server: on, base: onBase } = await boot({ avatarRenderer: 'placeholder', redisUrl: 'redis://queue.test:6379' }, { storage, renderQueue: queue }));
  ({ server: off, base: offBase } = await boot({}, { storage }));
});
after(async () => { await new Promise((r) => on.close(r)); await new Promise((r) => off.close(r)); await prisma.$disconnect(); });

const alexId = async () => (await prisma.inbuiltAvatar.findUnique({ where: { slug: 'alex-corporate-presenter' } })).id;
const mk = async (base, u, extra = {}) => call(base, u, 'POST', '/api/avatars/drafts', { avatarId: await alexId(), ...extra });
const complete = (base, id, body, key = KEY) => call(base, null, 'POST', `/api/internal/avatar-drafts/${id}/complete`, body, key ? { 'x-service-key': key } : {});
const draftsOf = async (base, u) => (await call(base, u, 'GET', '/api/avatars/drafts')).body.drafts;
/** what the worker does: put the video where the API said, then report it */
const workerFinishes = async (base, d, org, durationMs) => { storage.objects.set(draftObjectKey(org, d.id), { size: 4096, contentType: 'video/mp4' }); return complete(base, d.id, { status: 'READY', stored: true, ...(durationMs ? { durationMs } : {}) }); };

describe('Basic avatars and the 90-second limit', () => {
  test('the catalog holds 8 distinct Basic avatars, and a Basic organization can use every one of them', async () => {
    const basic = await prisma.inbuiltAvatar.findMany({ where: { tier: 'BASIC' } });
    assert.equal(basic.length, 8); assert.equal(new Set(basic.map((a) => a.slug)).size, 8); assert.equal(new Set(basic.map((a) => a.name)).size, 8);
    const w = await world(offBase); const t = (await call(offBase, w.m1, 'GET', '/api/avatars/templates')).body;
    assert.equal(t.templates.length, 8); assert.ok(t.templates.every((a) => a.tier === 'BASIC'));
    assert.ok(!/modelKey|avatars\/models/.test(JSON.stringify(t)), 'media keys stay on the server');
  });

  test('a Basic avatar job is capped at 90 seconds; other tiers get the shared ceiling', async () => {
    const basic = await world(onBase); const n = jobs.length; await mk(onBase, basic.m1);
    assert.equal(jobs[n].data.maxSeconds, 90);
    const pro = await world(onBase, { plan: 'pro' }); const m = jobs.length;
    const marcus = (await prisma.inbuiltAvatar.findUnique({ where: { slug: 'marcus-studio-cinematic' } })).id;
    assert.equal((await call(onBase, pro.m1, 'POST', '/api/avatars/drafts', { avatarId: marcus })).status, 201);
    assert.equal(jobs[m].data.maxSeconds, 300);
  });

  test('the API refuses a Basic render reported as longer than 90 s, records an allowed length, and the saved clip carries it', async () => {
    const w = await world(onBase); const d = (await mk(onBase, w.m1)).body; const org = await prisma.organization.findUnique({ where: { slug: w.org } });
    storage.objects.set(draftObjectKey(org.id, d.id), { size: 4096, contentType: 'video/mp4' });
    const tooLong = await complete(onBase, d.id, { status: 'READY', stored: true, durationMs: 90001 }); assert.equal(tooLong.status, 400); assert.equal(tooLong.body.error, 'too_long');
    assert.equal((await prisma.avatarDraft.findUnique({ where: { id: d.id } })).status, 'PROCESSING', 'a refused report changes nothing');
    assert.equal((await complete(onBase, d.id, { status: 'READY', stored: true, durationMs: 0 })).status, 400);
    assert.equal((await complete(onBase, d.id, { status: 'READY', stored: true, durationMs: 90000 })).status, 200);
    assert.equal((await draftsOf(onBase, w.m1))[0].durationMs, 90000);
    const r = await call(onBase, w.m1, 'POST', `/api/avatars/drafts/${d.id}/promote`, {}); assert.equal(r.status, 201);
    assert.equal(r.body.clip.durationMs, 90000);
  });
});

describe('avatar render pipeline (API side)', () => {
  test('with the renderer off (default) nothing is queued and the page is told rendering is unavailable', async () => {
    const w = await world(offBase); const before = jobs.length;
    assert.deepEqual((await call(offBase, w.m1, 'GET', '/api/avatars/templates')).body.rendering, { enabled: false, kind: 'none' });
    assert.equal((await mk(offBase, w.m1)).status, 201);
    assert.equal(jobs.length, before);
  });

  test('with the renderer on, creating a draft queues exactly one job for it, with the script, and nothing secret', async () => {
    const w = await world(onBase); const n = jobs.length;
    assert.deepEqual((await call(onBase, w.m1, 'GET', '/api/avatars/templates')).body.rendering, { enabled: true, kind: 'placeholder' });
    const r = await mk(onBase, w.m1, { title: 'Welcome', script: 'Hello and welcome.' }); assert.equal(r.status, 201);
    assert.equal(jobs.length, n + 1); const j = jobs[n];
    const org = await prisma.organization.findUnique({ where: { slug: w.org } });
    assert.equal(j.name, 'render'); assert.equal(j.opts.jobId, r.body.id); assert.equal(j.opts.attempts, 2);
    assert.deepEqual(j.data, { draftId: r.body.id, organizationId: org.id, objectKey: draftObjectKey(org.id, r.body.id), avatarSlug: 'alex-corporate-presenter', avatarName: 'Alex (Corporate Presenter)', title: 'Welcome', script: 'Hello and welcome.', maxSeconds: 90 });
    assert.ok(!/modelKey|avatars\/models/.test(JSON.stringify(j.data)));
    assert.equal(r.body.script, 'Hello and welcome.');
  });

  test('a script longer than 1000 characters is refused; an unknown field is refused', async () => {
    const w = await world(onBase);
    assert.equal((await mk(onBase, w.m1, { script: 'x'.repeat(1001) })).status, 400);
    assert.equal((await mk(onBase, w.m1, { surprise: 1 })).status, 400);
    assert.equal((await mk(onBase, w.m1, { script: 'x'.repeat(1000) })).status, 201);
  });

  test('a queue outage does not lose the draft: it is saved (PROCESSING) and the worker sweep finds it', async () => {
    const w = await world(onBase); failQueue = true;
    let r; try { r = await mk(onBase, w.m1); } finally { failQueue = false; }
    assert.equal(r.status, 201); assert.equal(r.body.status, 'PROCESSING');
    // not offered at once (it may be about to be queued normally) ...
    const asked = () => call(onBase, null, 'GET', '/api/internal/avatar-drafts/pending', undefined, { 'x-service-key': KEY });
    assert.ok(!(await asked()).body.drafts.some((d) => d.draftId === r.body.id));
    // ... but once it is 30 s old it is
    await prisma.avatarDraft.update({ where: { id: r.body.id }, data: { createdAt: new Date(Date.now() - 60000) } });
    const p = (await asked()).body.drafts.find((d) => d.draftId === r.body.id);
    assert.ok(p && p.objectKey.startsWith('avatars/') && p.avatarName && !('modelKey' in p));
  });

  test('the pending list and completion need the service key (a browser session is not enough)', async () => {
    const w = await world(onBase); const d = (await mk(onBase, w.m1)).body;
    assert.equal((await call(onBase, w.m1, 'GET', '/api/internal/avatar-drafts/pending')).status, 401);
    assert.equal((await call(onBase, null, 'GET', '/api/internal/avatar-drafts/pending', undefined, { 'x-service-key': 'wrong'.repeat(8) })).status, 401);
    assert.equal((await complete(onBase, d.id, { status: 'FAILED' }, null)).status, 401);
    assert.equal((await call(offBase, null, 'GET', '/api/internal/avatar-drafts/pending', undefined, { 'x-service-key': KEY })).body.drafts.length, 0, 'renderer off: nothing pending');
  });

  test('stored completion: refused while no file exists; then READY with the size taken from storage, previewable by its owner only', async () => {
    const w = await world(onBase); const d = (await mk(onBase, w.m1)).body; const org = await prisma.organization.findUnique({ where: { slug: w.org } });
    assert.equal((await complete(onBase, d.id, { status: 'READY', stored: true })).status, 409, 'the API does not take the worker\'s word for it');
    assert.equal((await call(onBase, w.m1, 'GET', `/api/avatars/drafts/${d.id}/playback`)).status, 409, 'not ready yet');
    assert.equal((await complete(onBase, d.id, { status: 'READY', stored: true, storageKey: 'avatars/x/y/render.mp4' })).status, 400, 'the key is never taken from the caller');
    assert.equal((await workerFinishes(onBase, d, org.id)).status, 200);
    const row = await prisma.avatarDraft.findUnique({ where: { id: d.id } });
    assert.equal(row.status, 'READY'); assert.equal(row.storageKey, draftObjectKey(org.id, d.id)); assert.equal(Number(row.sizeBytes), 4096); assert.equal(row.mimeType, 'video/mp4'); assert.equal(row.videoUrl, null);
    assert.equal((await draftsOf(onBase, w.m1))[0].playable, true);
    const p = await call(onBase, w.m1, 'GET', `/api/avatars/drafts/${d.id}/playback`); assert.equal(p.status, 200); assert.match(p.body.url, /^https:\/\/fake\.test\/get\?key=/);
    assert.equal((await call(onBase, w.m2, 'GET', `/api/avatars/drafts/${d.id}/playback`)).status, 404, 'someone else gets nothing');
    assert.equal((await myClips(onBase, w.m1)).length, 0, 'a ready draft is still not in My clips');
  });

  test('saving a rendered draft hands the same stored object to one Clip that plays through the normal signed link; the draft preview then points to the clip', async () => {
    const w = await world(onBase); const d = (await mk(onBase, w.m1)).body; const org = await prisma.organization.findUnique({ where: { slug: w.org } });
    await workerFinishes(onBase, d, org.id);
    const r = await call(onBase, w.m1, 'POST', `/api/avatars/drafts/${d.id}/promote`, {}); assert.equal(r.status, 201, JSON.stringify(r.body));
    const clip = await prisma.clip.findUnique({ where: { id: r.body.clip.id } });
    assert.equal(clip.storageKey, draftObjectKey(org.id, d.id)); assert.equal(clip.source, 'AVATAR_GENERATION'); assert.equal(clip.status, 'READY'); assert.equal(Number(clip.sizeBytes), 4096);
    const mine = await myClips(onBase, w.m1); assert.equal(mine.length, 1); assert.equal(mine[0].playable, true);
    assert.equal((await call(onBase, w.m1, 'GET', `/api/clips/${clip.id}/playback`)).status, 200);
    assert.equal((await call(onBase, w.m1, 'GET', `/api/avatars/drafts/${d.id}/playback`)).status, 409);
    assert.equal((await complete(onBase, d.id, { status: 'FAILED' })).status, 404, 'a saved draft is frozen: a late worker report changes nothing');
  });

  test('a failed render shows FAILED and cannot be saved', async () => {
    const w = await world(onBase); const d = (await mk(onBase, w.m1)).body;
    assert.equal((await complete(onBase, d.id, { status: 'FAILED' })).status, 200);
    assert.equal((await draftsOf(onBase, w.m1))[0].status, 'FAILED');
    assert.equal((await call(onBase, w.m1, 'POST', `/api/avatars/drafts/${d.id}/promote`, {})).status, 409);
  });

  test('discarding an unsaved draft also deletes its rendered file', async () => {
    const w = await world(onBase); const d = (await mk(onBase, w.m1)).body; const org = await prisma.organization.findUnique({ where: { slug: w.org } });
    await workerFinishes(onBase, d, org.id);
    assert.equal((await call(onBase, w.m1, 'DELETE', `/api/avatars/drafts/${d.id}`)).status, 200);
    assert.ok(storage.removed.includes(draftObjectKey(org.id, d.id)));
  });
});

const myClips = async (base, u) => (await call(base, u, 'GET', '/api/clips?view=mine')).body.clips;
