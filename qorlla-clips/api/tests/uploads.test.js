import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { sweepUploads } from '../src/uploads.js';
import { configFor, call, world, who, uniq, prisma } from './helpers.js';
import { FakeStorage } from './fake-storage.js';

const MiB = 1048576;
const cfg = { storageEnabled: true, uploadPartBytes: 5 * MiB, maxUploadBytes: 64 * MiB, playbackSeconds: 600 };
const fake = new FakeStorage();
let srv, base, noStorage;

async function boot(storage, over = {}) {
  const app = createApp({ prisma, config: configFor({ ...cfg, ...over }), storage });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
before(async () => { srv = await boot(fake); base = srv.base; noStorage = await boot(null); });
after(async () => { await srv.close(); await noStorage.close(); await prisma.$disconnect(); });

const start = (u, b = {}) => call(base, u, 'POST', '/api/recordings', { mimeType: 'video/webm', sizeBytes: 12 * MiB, ...b });
const sign = (u, id, nums) => call(base, u, 'POST', `/api/clips/${id}/upload/parts`, { partNumbers: nums });
const complete = (u, id) => call(base, u, 'POST', `/api/clips/${id}/upload/complete`, {});
/** upload part `n` of a clip like the browser does: sign, then PUT exactly the signed number of bytes */
async function sendPart(u, id, n, bytes) {
  const s = await sign(u, id, [n]); assert.equal(s.status, 200, s.text);
  const url = s.body.urls[n]; const len = bytes ?? Number(new URL(url).searchParams.get('len'));
  return fake.put(url, len);
}
async function recorded(u, size = 12 * MiB) {
  const r = await start(u, { sizeBytes: size }); assert.equal(r.status, 201, r.text);
  const total = r.body.upload.totalParts;
  for (let n = 1; n <= total; n++) assert.equal((await sendPart(u, r.body.clip.id, n)).status, 200);
  return r.body.clip.id;
}

describe('starting a recording', () => {
  test('creates an UPLOADING clip; the object key is built by the server; the response never reveals storage internals', async () => {
    const { m1 } = await world(base);
    const r = await start(m1, { title: '  My take  ', mimeType: 'video/webm;codecs=vp9,opus' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.clip.status, 'UPLOADING'); assert.equal(r.body.clip.title, 'My take'); assert.equal(r.body.clip.source, 'RECORDING');
    assert.equal(r.body.clip.mimeType, 'video/webm', 'codec parameters are stripped'); assert.equal(r.body.clip.playable, false);
    assert.deepEqual(r.body.upload, { partSize: 5 * MiB, totalParts: 3 }, '12 MiB in 5 MiB parts');
    assert.doesNotMatch(r.text, /storageKey|uploadId|fake\.test/);
    const row = await prisma.clip.findUnique({ where: { id: r.body.clip.id }, include: { owner: true } });
    assert.equal(row.storageKey, `${row.organizationId}/${row.ownerId}/${row.id}.webm`, 'key = org/user/clip.ext, from ids only');
    assert.equal(typeof r.body.clip.sizeBytes, 'number');
  });

  test('input is validated: type, size, unknown fields; nothing the caller sends can name an object', async () => {
    const { m1 } = await world(base);
    for (const bad of [{ mimeType: 'video/x-msvideo' }, { mimeType: 'text/html' }, { sizeBytes: 0 }, { sizeBytes: -5 }, { sizeBytes: 1.5 }, { sizeBytes: '12' }, { sizeBytes: 65 * MiB },
      { title: '' }, { durationMs: -1 }, { storageKey: '../../etc/passwd' }, { uploadId: 'x' }, { key: 'x' }, { ownerId: 'x' }]) {
      const r = await start(m1, bad); assert.equal(r.status, 400, JSON.stringify(bad) + ' -> ' + r.status);
    }
    assert.equal(await prisma.clip.count({ where: { owner: { email: m1.email } } }), 0, 'no clip rows were left behind');
  });

  test('uploading a file from disk (source UPLOAD) is locked on the free plan and open on paid plans; other sources are refused', async () => {
    const free = await world(base), paid = await world(base, { plan: 'pro' });
    const locked = await start(free.m1, { source: 'UPLOAD' });
    assert.equal(locked.status, 403); assert.equal(locked.body.error, 'feature_locked'); assert.equal(locked.body.feature, 'upload');
    assert.equal(await prisma.clip.count({ where: { owner: { email: free.m1.email } } }), 0, 'nothing was created');
    assert.equal((await start(free.m1)).status, 201, 'recording stays free');
    const ok = await start(paid.m1, { source: 'UPLOAD', mimeType: 'video/mp4', title: 'holiday' });
    assert.equal(ok.status, 201, ok.text); assert.equal(ok.body.clip.source, 'UPLOAD'); assert.equal(ok.body.clip.mimeType, 'video/mp4');
    const row = await prisma.clip.findUnique({ where: { id: ok.body.clip.id } }); assert.match(row.storageKey, /\.mp4$/);
    for (const bad of [{ source: 'AVATAR_GENERATION' }, { source: 'nope' }, { source: 5 }]) assert.equal((await start(paid.m1, bad)).status, 400, JSON.stringify(bad));
  });

  test('a user can have at most 5 uploads open; storage outages leave no half-made clip; storage not configured is a clear 503', async () => {
    const { m1, m2 } = await world(base);
    for (let i = 0; i < 5; i++) assert.equal((await start(m1)).status, 201);
    assert.equal((await start(m1)).status, 429);
    assert.equal((await start(m2)).status, 201, 'the limit is per user');
    fake.fail.start = true;
    const out = await start(m2); fake.fail.start = false;
    assert.equal(out.status, 502); assert.equal(out.body.error, 'storage_error'); assert.doesNotMatch(out.text, /simulated|ServiceUnavailable/);
    assert.equal(await prisma.clip.count({ where: { owner: { email: m2.email }, status: 'UPLOADING' } }), 1, 'the failed start left nothing behind');
    const n = await call(noStorage.base, m1, 'POST', '/api/recordings', { mimeType: 'video/webm', sizeBytes: 100 });
    assert.equal(n.status, 503); assert.equal(n.body.error, 'storage_unavailable');
  });
});

describe('uploading parts', () => {
  test('signed URLs are bound to the upload, one per part, with the exact length the server expects (the last part is the remainder)', async () => {
    const { m1 } = await world(base);
    const r = await start(m1); const id = r.body.clip.id;
    const s = await sign(m1, id, [1, 2, 3, 3]);
    assert.equal(s.status, 200); assert.deepEqual(Object.keys(s.body.urls).sort(), ['1', '2', '3'], 'duplicates collapse');
    const len = (n) => Number(new URL(s.body.urls[n]).searchParams.get('len'));
    assert.deepEqual([len(1), len(2), len(3)], [5 * MiB, 5 * MiB, 2 * MiB]);
    assert.equal(s.body.expiresInSeconds, 1800);
    assert.equal((await fake.put(s.body.urls[1], 5 * MiB + 1)).status, 403, 'the store refuses any other length');
    assert.equal((await fake.put(s.body.urls[3], 5 * MiB)).status, 403);
    for (const bad of [[0], [4], [10001], [], [1.5], ['1'], Array.from({ length: 51 }, (_, i) => i + 1)]) assert.equal((await sign(m1, id, bad)).status, 400, JSON.stringify(bad).slice(0, 30));
    assert.equal((await call(base, m1, 'POST', `/api/clips/${id}/upload/parts`, { partNumbers: [1], key: 'x' })).status, 400, 'unknown fields refused');
  });

  test('only the owner can touch an upload: other members, admins and other organizations get 404', async () => {
    const A = await world(base), B = await world(base);
    const r = await start(A.m1); const id = r.body.clip.id;
    for (const who_ of [A.m2, A.a, B.a, B.m1]) {
      assert.equal((await sign(who_, id, [1])).status, 404);
      assert.equal((await complete(who_, id)).status, 404);
      assert.equal((await call(base, who_, 'GET', `/api/clips/${id}/upload`)).status, 404);
      assert.equal((await call(base, who_, 'POST', `/api/clips/${id}/upload/abort`, {})).status, 404);
    }
    assert.equal((await sign(A.m1, id, [1])).status, 200);
    assert.equal((await sign(A.m1, '00000000-0000-4000-8000-000000000000', [1])).status, 404);
    const plain = (await call(base, A.m1, 'POST', '/api/clips', { source: 'RECORDING' })).body;
    assert.equal((await sign(A.m1, plain.id, [1])).status, 404, 'a clip that has no upload is not an upload');
  });

  test('completion trusts only what storage holds: missing and wrong-sized parts are refused with the list; then it succeeds', async () => {
    const { m1 } = await world(base);
    const id = (await start(m1)).body.clip.id;
    assert.equal((await complete(m1, id)).status, 409);
    await sendPart(m1, id, 1);
    const r1 = await complete(m1, id);
    assert.equal(r1.status, 409); assert.equal(r1.body.error, 'incomplete_upload'); assert.deepEqual(r1.body.missing, [2, 3]);
    await sendPart(m1, id, 2); await sendPart(m1, id, 3);
    const up = await call(base, m1, 'GET', `/api/clips/${id}/upload`);
    assert.deepEqual(up.body.uploadedParts.map((p) => p.partNumber), [1, 2, 3], 'resume: the server can say what it already has');
    const ok = await complete(m1, id);
    assert.equal(ok.status, 200, ok.text); assert.equal(ok.body.clip.status, 'READY'); assert.equal(ok.body.clip.playable, true);
    assert.equal(ok.body.clip.sizeBytes, 12 * MiB);
    const row = await prisma.clip.findUnique({ where: { id } }); assert.equal(row.uploadId, null, 'the upload id is cleared');
    assert.equal(fake.objects.get(row.storageKey).size, 12 * MiB);
  });

  test('a part the store holds with the wrong size is refused at completion (defence in depth beyond the signed length)', async () => {
    const { m1 } = await world(base);
    const id = (await start(m1)).body.clip.id;
    const row = await prisma.clip.findUnique({ where: { id } });
    for (const n of [1, 2, 3]) await sendPart(m1, id, n);
    const held = [...fake.uploads.get(row.uploadId).parts.values()]; held[0].size = 4 * MiB;            // as if storage held something else
    const r = await complete(m1, id);
    assert.equal(r.status, 409); assert.deepEqual(r.body.wrong, [1]);
  });

  test('the announced size is verified against the finished object; a mismatch deletes it and fails the clip', async () => {
    const { m1 } = await world(base);
    const id = await recorded(m1);
    // recorded() only uploaded parts; completing now with a storage that reports a different final size
    const row = await prisma.clip.findUnique({ where: { id } });
    fake.sizeLie = 13 * MiB;
    const r = await complete(m1, id); fake.sizeLie = null;
    assert.equal(r.status, 409); assert.equal(r.body.error, 'size_mismatch');
    assert.equal((await prisma.clip.findUnique({ where: { id } })).status, 'FAILED');
    assert.ok(fake.removed.includes(row.storageKey), 'the bad object was removed');
  });

  test('completing twice, even at the same moment, is harmless: one READY clip', async () => {
    const { m1 } = await world(base);
    const id = await recorded(m1);
    const rs = await Promise.all([complete(m1, id), complete(m1, id), complete(m1, id)]);
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200], rs.map((r) => r.text).join(' | '));
    assert.equal((await prisma.clip.findUnique({ where: { id } })).status, 'READY');
    assert.equal((await call(base, m1, 'POST', `/api/clips/${id}/upload/parts`, { partNumbers: [1] })).status, 409, 'a finished upload takes no more parts');
  });

  test('abort cancels in storage and removes the clip; a finished recording cannot be aborted; storage outages answer 502', async () => {
    const { m1 } = await world(base);
    const id = (await start(m1)).body.clip.id; const row = await prisma.clip.findUnique({ where: { id } });
    assert.equal((await call(base, m1, 'POST', `/api/clips/${id}/upload/abort`, {})).status, 200);
    assert.ok(fake.aborted.includes(row.uploadId)); assert.equal(await prisma.clip.count({ where: { id } }), 0);
    const done = await recorded(m1); await complete(m1, done);
    assert.equal((await call(base, m1, 'POST', `/api/clips/${done}/upload/abort`, {})).status, 409);
    const id2 = (await start(m1)).body.clip.id;
    fake.fail.list = true; const out = await call(base, m1, 'GET', `/api/clips/${id2}/upload`); fake.fail.list = false;
    assert.equal(out.status, 502); assert.doesNotMatch(out.text, /simulated/);
  });
});

describe('playback and deletion', () => {
  test('playback is a short-lived signed link issued only to people who may see the clip', async () => {
    const A = await world(base), B = await world(base);
    const id = await recorded(A.m1); await complete(A.m1, id);
    const own = await call(base, A.m1, 'GET', `/api/clips/${id}/playback`);
    assert.equal(own.status, 200); assert.match(own.body.url, /^https:\/\/fake\.test\/get\?key=/); assert.equal(own.body.expiresInSeconds, 600); assert.equal(own.body.mimeType, 'video/webm');
    assert.equal((await call(base, A.m2, 'GET', `/api/clips/${id}/playback`)).status, 404, 'not shared: not visible');
    assert.equal((await call(base, B.m1, 'GET', `/api/clips/${id}/playback`)).status, 404, 'another organization');
    await call(base, A.m1, 'POST', `/api/clips/${id}/share`, { email: A.m2.email });
    assert.equal((await call(base, A.m2, 'GET', `/api/clips/${id}/playback`)).status, 200, 'shared: allowed');
    await call(base, A.m1, 'POST', `/api/clips/${id}/trash`);
    assert.equal((await call(base, A.m2, 'GET', `/api/clips/${id}/playback`)).status, 404, 'trashed: gone for recipients');
    assert.equal((await call(base, A.m1, 'GET', `/api/clips/${id}/playback`)).status, 200, 'the owner can still play it');
    const open = (await start(A.m1)).body.clip.id;
    assert.equal((await call(base, A.m1, 'GET', `/api/clips/${open}/playback`)).status, 409, 'not ready');
    assert.equal((await call(noStorage.base, A.m1, 'GET', `/api/clips/${id}/playback`)).status, 503);
  });

  test('deleting a clip forever also removes its video (and any open upload) from storage', async () => {
    const { m1 } = await world(base);
    const id = await recorded(m1); await complete(m1, id);
    const key = (await prisma.clip.findUnique({ where: { id } })).storageKey;
    await call(base, m1, 'POST', `/api/clips/${id}/trash`);
    assert.equal((await call(base, m1, 'DELETE', `/api/clips/${id}`)).status, 200);
    assert.ok(fake.removed.includes(key)); assert.equal(fake.objects.has(key), false);
    const open = (await start(m1)).body.clip.id; const orow = await prisma.clip.findUnique({ where: { id: open } });
    await call(base, m1, 'POST', `/api/clips/${open}/trash`);
    assert.equal((await call(base, m1, 'DELETE', `/api/clips/${open}`)).status, 200);
    assert.ok(fake.aborted.includes(orow.uploadId), 'the open multipart upload was aborted');
  });
});

describe('abandoned uploads', () => {
  test('uploads older than the limit are aborted and marked FAILED; recent and finished ones are untouched', async () => {
    const { m1 } = await world(base);
    const oldId = (await start(m1)).body.clip.id, freshId = (await start(m1)).body.clip.id, doneId = await recorded(m1); await complete(m1, doneId);
    const oldRow = await prisma.clip.findUnique({ where: { id: oldId } });
    await prisma.clip.update({ where: { id: oldId }, data: { createdAt: new Date(Date.now() - 48 * 3600 * 1000) } });
    const r = await sweepUploads({ prisma, storage: fake, ttlMs: 24 * 3600 * 1000 });
    assert.ok(r.aborted >= 1);
    assert.equal((await prisma.clip.findUnique({ where: { id: oldId } })).status, 'FAILED'); assert.ok(fake.aborted.includes(oldRow.uploadId));
    assert.equal((await prisma.clip.findUnique({ where: { id: freshId } })).status, 'UPLOADING');
    assert.equal((await prisma.clip.findUnique({ where: { id: doneId } })).status, 'READY');
    assert.deepEqual(await sweepUploads({ prisma, storage: null, ttlMs: 1 }), { aborted: 0 }, 'no storage configured: nothing to do');
  });
});

describe('privacy edges found by mutation testing', () => {
  test('someone a clip was shared with cannot republish it to the whole organization (or add it anywhere)', async () => {
    const { a, m1, m2 } = await world(base);
    const org = (await call(base, a, 'POST', '/api/playlists', { title: 'Everyone', isOrganization: true })).body;
    const c = (await call(base, m1, 'POST', '/api/clips', { source: 'RECORDING', title: 'private' })).body;
    await call(base, m1, 'POST', `/api/clips/${c.id}/share`, { email: m2.email });
    const r = await call(base, m2, 'POST', `/api/playlists/${org.id}/clips`, { clipId: c.id });
    assert.equal(r.status, 403, 'visible to m2 through the share, but not theirs to publish');
    const orgView = await call(base, a, 'GET', `/api/clips?view=playlist&playlistId=${org.id}`);
    assert.equal(orgView.body.clips.length, 0, 'and the organization playlist stayed empty');
  });

  test('a user who is moved to another organization sees and can change NOTHING from the old one', async () => {
    const A = await world(base), B = await world(base);
    const c = (await call(base, A.m1, 'POST', '/api/clips', { source: 'RECORDING', title: 'old org clip' })).body;
    const pl = (await call(base, A.m1, 'POST', '/api/playlists', { title: 'old org list' })).body;
    await prisma.user.update({ where: { email: A.m1.email }, data: { organizationId: (await prisma.organization.findUnique({ where: { slug: B.org } })).id } });
    const ids = async (v) => (await call(base, A.m1, 'GET', `/api/clips?view=${v}`)).body.clips.map((x) => x.id);
    for (const v of ['recent', 'mine', 'starred', 'shared']) assert.ok(!(await ids(v)).includes(c.id), v);
    assert.equal((await call(base, A.m1, 'PATCH', `/api/clips/${c.id}`, { title: 'x' })).status, 404);
    assert.equal((await call(base, A.m1, 'POST', `/api/clips/${c.id}/trash`)).status, 404);
    assert.equal((await call(base, A.m1, 'GET', `/api/clips/${c.id}/playback`)).status, 404);
    assert.equal((await call(base, A.m1, 'PATCH', `/api/playlists/${pl.id}`, { title: 'x' })).status, 404);
    assert.equal(JSON.stringify((await call(base, A.m1, 'GET', '/api/navigation/summary')).body).includes(pl.id), false);
  });
});
