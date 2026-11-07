import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { cleanText } from '../src/insights.js';
import { configFor, call, world, uniq, prisma } from './helpers.js';
import { FakeStorage } from './fake-storage.js';

let srv, base;
before(async () => {
  const app = createApp({ prisma, config: configFor({ storageEnabled: true, playbackSeconds: 600 }), storage: new FakeStorage() });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  srv = server; base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => srv.close(r)); await prisma.$disconnect(); });

/** a READY recording owned by `u`, inserted directly (the upload path has its own tests) */
async function readyClip(w, u, over = {}) {
  const me = (await call(base, u, 'GET', '/api/me')).body;
  const org = await prisma.organization.findUnique({ where: { slug: w.org } });
  return prisma.clip.create({ data: { title: 'Clip ' + uniq(), status: 'READY', source: 'RECORDING', ownerId: me.id, organizationId: org.id, storageKey: `k/${uniq('o')}`, mimeType: 'video/webm', sizeBytes: 1000n, ...over } });
}
const share = (u, id, email) => call(base, u, 'POST', `/api/clips/${id}/share`, { email });

describe('analytics', () => {
  test('numbers come from real rows: clips, storage and one view per playback link issued', async () => {
    const w = await world(base);
    const c1 = await readyClip(w, w.m1), c2 = await readyClip(w, w.m1);
    await share(w.m1, c1.id, w.m2.email);
    for (let i = 0; i < 3; i++) assert.equal((await call(base, w.m2, 'GET', `/api/clips/${c1.id}/playback`)).status, 200);
    assert.equal((await call(base, w.m1, 'GET', `/api/clips/${c2.id}/playback`)).status, 200);
    const r = await call(base, w.a, 'GET', '/api/analytics/overview?days=7');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.scope, 'organization');
    assert.equal(r.body.totals.clips, 2); assert.equal(r.body.totals.ready, 2); assert.equal(r.body.totals.storageBytes, 2000);
    assert.equal(r.body.totals.viewsInPeriod, 4);
    assert.equal(r.body.viewsPerDay.length, 7); assert.equal(r.body.viewsPerDay.reduce((n, d) => n + d.count, 0), 4);
    assert.equal(r.body.clipsPerDay.reduce((n, d) => n + d.count, 0), 2);
    assert.deepEqual(r.body.topClips[0], { id: c1.id, title: c1.title, views: 3 });
    assert.equal(r.body.bySource.RECORDING, 2);
  });

  test('a member sees only their own clips; another organization never leaks in', async () => {
    const w = await world(base), other = await world(base);
    await readyClip(w, w.m1); await readyClip(w, w.m2); await readyClip(other, other.m1);
    assert.equal((await call(base, w.m1, 'GET', '/api/analytics/overview')).body.totals.clips, 1);
    assert.equal((await call(base, w.a, 'GET', '/api/analytics/overview')).body.totals.clips, 2);
    assert.equal((await call(base, other.a, 'GET', '/api/analytics/overview')).body.totals.clips, 1);
  });

  test('days is validated', async () => {
    const w = await world(base);
    for (const d of ['0', '91', 'abc']) assert.equal((await call(base, w.a, 'GET', `/api/analytics/overview?days=${d}`)).status, 400, d);
  });

  test('the PDF is a real PDF, streamed with a fixed file name, and the title cannot inject headers or control characters', async () => {
    const w = await world(base); await readyClip(w, w.m1);
    const r = await fetch(`${base}/api/analytics/report.pdf?days=30&title=${encodeURIComponent('Q3\r\nX-Evil: 1')}`, { headers: { 'x-dev-user': w.a.email, 'x-dev-org': w.a.org, 'x-dev-role': 'admin' } });
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="clips-report.pdf"');
    assert.equal(r.headers.get('x-evil'), null);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-'); assert.ok(buf.length > 800);
    assert.ok(buf.subarray(-1024).toString('latin1').includes('%%EOF'));
  });

  test('the report needs a signed-in user', async () => {
    assert.equal((await call(base, null, 'GET', '/api/analytics/report.pdf')).status, 401);
  });

  test('cleanText strips control characters and caps length', () => {
    assert.equal(cleanText('a\r\nb\u0000c'), 'a b c');
    assert.equal(cleanText('x'.repeat(500), 10).length, 10);
    assert.equal(cleanText(undefined), '');
  });
});

describe('moderation', () => {
  test('a member reports a clip they can see; reporting twice is the same as once; own and invisible clips are refused', async () => {
    const w = await world(base);
    const c = await readyClip(w, w.m1); await share(w.m1, c.id, w.m2.email);
    assert.equal((await call(base, w.m2, 'POST', `/api/clips/${c.id}/report`, { reason: 'spam content' })).status, 201);
    assert.equal((await call(base, w.m2, 'POST', `/api/clips/${c.id}/report`, { reason: 'spam content' })).status, 201);
    assert.equal(await prisma.clipReport.count({ where: { clipId: c.id } }), 1);
    assert.equal((await call(base, w.m1, 'POST', `/api/clips/${c.id}/report`, { reason: 'my own' })).status, 400);
    const hidden = await readyClip(w, w.m1);
    assert.equal((await call(base, w.m2, 'POST', `/api/clips/${hidden.id}/report`, { reason: 'cannot see it' })).status, 404);
    assert.equal((await call(base, w.m2, 'POST', `/api/clips/${c.id}/report`, { reason: '' })).status, 400);
  });

  test('only admins of the same organization can list or resolve reports', async () => {
    const w = await world(base), other = await world(base);
    const c = await readyClip(w, w.m1); await share(w.m1, c.id, w.m2.email);
    await call(base, w.m2, 'POST', `/api/clips/${c.id}/report`, { reason: 'bad clip' });
    assert.equal((await call(base, w.m2, 'GET', '/api/admin/reports')).status, 403);
    assert.equal((await call(base, other.a, 'GET', '/api/admin/reports')).body.reports.length, 0, 'other organization sees nothing');
    const list = await call(base, w.a, 'GET', '/api/admin/reports'); assert.equal(list.body.reports.length, 1);
    const id = list.body.reports[0].id;
    assert.equal((await call(base, w.m2, 'POST', `/api/admin/reports/${id}/resolve`, { action: 'trash' })).status, 403);
    assert.equal((await call(base, other.a, 'POST', `/api/admin/reports/${id}/resolve`, { action: 'trash' })).status, 404);
    assert.equal((await prisma.clip.findUnique({ where: { id: c.id } })).isTrashed, false, 'nothing happened yet');
  });

  test('trashing moves the clip, notifies the owner, is audited, and cannot be done twice; dismissing leaves the clip alone', async () => {
    const w = await world(base);
    const c = await readyClip(w, w.m1), d = await readyClip(w, w.m1);
    for (const x of [c, d]) { await share(w.m1, x.id, w.m2.email); await call(base, w.m2, 'POST', `/api/clips/${x.id}/report`, { reason: 'please review' }); }
    const reports = (await call(base, w.a, 'GET', '/api/admin/reports')).body.reports;
    const rc = reports.find((r) => r.clip.id === c.id), rd = reports.find((r) => r.clip.id === d.id);
    assert.deepEqual((await call(base, w.a, 'POST', `/api/admin/reports/${rc.id}/resolve`, { action: 'trash' })).body, { id: rc.id, status: 'ACTIONED' });
    assert.equal((await call(base, w.a, 'POST', `/api/admin/reports/${rc.id}/resolve`, { action: 'trash' })).status, 409);
    assert.equal((await call(base, w.a, 'POST', `/api/admin/reports/${rd.id}/resolve`, { action: 'dismiss' })).body.status, 'DISMISSED');
    assert.equal((await prisma.clip.findUnique({ where: { id: c.id } })).isTrashed, true);
    assert.equal((await prisma.clip.findUnique({ where: { id: d.id } })).isTrashed, false);
    const notes = (await call(base, w.m1, 'GET', '/api/notifications')).body.notifications;
    assert.ok(notes.some((n) => n.type === 'moderation' && n.clipId === c.id));
    const audit = (await call(base, w.a, 'GET', '/api/admin/audit')).body.entries;
    assert.deepEqual(audit.map((e) => e.action).sort(), ['report.dismiss', 'report.trash_clip']);
    assert.equal((await call(base, w.m2, 'GET', '/api/admin/audit')).status, 403);
    assert.equal((await call(base, w.a, 'GET', '/api/admin/reports')).body.reports.length, 0, 'the open queue is empty');
  });

  test('two admins resolving the same report at once: exactly one wins', async () => {
    const w = await world(base);
    const c = await readyClip(w, w.m1); await share(w.m1, c.id, w.m2.email);
    await call(base, w.m2, 'POST', `/api/clips/${c.id}/report`, { reason: 'race this' });
    const id = (await call(base, w.a, 'GET', '/api/admin/reports')).body.reports[0].id;
    const rs = await Promise.all([1, 2, 3].map(() => call(base, w.a, 'POST', `/api/admin/reports/${id}/resolve`, { action: 'trash' })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
    assert.equal(await prisma.auditLog.count({ where: { clipId: c.id } }), 1);
  });
});
