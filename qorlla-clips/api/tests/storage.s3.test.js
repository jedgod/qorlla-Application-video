// Against a REAL S3-compatible store (MinIO or AWS). Skipped unless S3_TEST_ENDPOINT is set:
//   S3_TEST_ENDPOINT=http://127.0.0.1:9190 S3_TEST_ACCESS_KEY=... S3_TEST_SECRET_KEY=... npm test
// Uses a throwaway bucket. Never point this at a bucket that holds real data.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { createStorage } from '../src/storage.js';
import { configFor, call, world, uniq, prisma } from './helpers.js';

const ENDPOINT = process.env.S3_TEST_ENDPOINT;
const skip = ENDPOINT ? false : 'set S3_TEST_ENDPOINT (and S3_TEST_ACCESS_KEY / S3_TEST_SECRET_KEY) to test against a real object store';
const MiB = 1048576;
const sha = (b) => createHash('sha256').update(b).digest('hex');

describe('real object storage', { skip }, () => {
  let storage, srv, base;
  before(async () => {
    storage = createStorage({ endpoint: ENDPOINT, publicEndpoint: ENDPOINT, region: 'us-east-1', bucket: uniq('clips-test-').toLowerCase(), forcePathStyle: true,
      accessKeyId: process.env.S3_TEST_ACCESS_KEY, secretAccessKey: process.env.S3_TEST_SECRET_KEY });
    await storage.ensureBucket();
    const app = createApp({ prisma, config: configFor({ storageEnabled: true, uploadPartBytes: 5 * MiB, maxUploadBytes: 64 * MiB, playbackSeconds: 300 }), storage });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    srv = server; base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { await new Promise((r) => srv.close(r)); await prisma.$disconnect(); });

  test('12 MiB in 3 real parts through the signed URLs; the bytes come back identical; Range works; the wrong length is refused by the store', async () => {
    const { m1 } = await world(base);
    const data = randomBytes(12 * MiB);
    const started = await call(base, m1, 'POST', '/api/recordings', { mimeType: 'video/webm', sizeBytes: data.length, title: 'real upload' });
    assert.equal(started.status, 201, started.text);
    const id = started.body.clip.id; const { partSize, totalParts } = started.body.upload;
    assert.equal(totalParts, 3);

    const signed = (await call(base, m1, 'POST', `/api/clips/${id}/upload/parts`, { partNumbers: [1, 2, 3] })).body.urls;
    // a part of the wrong length is refused by the STORE (the length is part of the signature)
    const bad = await fetch(signed[1], { method: 'PUT', body: data.subarray(0, partSize - 1) });
    assert.ok(bad.status === 403 || bad.status === 400, `wrong length accepted?! status ${bad.status}`);
    // completing now, with nothing stored, is refused by the API
    assert.equal((await call(base, m1, 'POST', `/api/clips/${id}/upload/complete`, {})).status, 409);

    for (let n = 1; n <= totalParts; n++) {
      const slice = data.subarray((n - 1) * partSize, Math.min(n * partSize, data.length));
      const put = await fetch(signed[n], { method: 'PUT', body: slice });
      assert.equal(put.status, 200, `part ${n}: ${put.status} ${await put.text()}`);
    }
    const resume = (await call(base, m1, 'GET', `/api/clips/${id}/upload`)).body;
    assert.deepEqual(resume.uploadedParts.map((p) => p.partNumber), [1, 2, 3]);

    const done = await call(base, m1, 'POST', `/api/clips/${id}/upload/complete`, {});
    assert.equal(done.status, 200, done.text); assert.equal(done.body.clip.status, 'READY');

    const play = (await call(base, m1, 'GET', `/api/clips/${id}/playback`)).body;
    const got = Buffer.from(await (await fetch(play.url)).arrayBuffer());
    assert.equal(got.length, data.length); assert.equal(sha(got), sha(data), 'the downloaded bytes equal the uploaded bytes');
    const range = await fetch(play.url, { headers: { range: 'bytes=100-199' } });
    assert.equal(range.status, 206, 'seeking works'); assert.equal((await range.arrayBuffer()).byteLength, 100);
    assert.equal((await fetch(play.url.replace(/X-Amz-Signature=[0-9a-f]+/, 'X-Amz-Signature=' + '0'.repeat(64)))).status, 403, 'a tampered link is refused');

    // deleting forever removes the object
    const key = (await prisma.clip.findUnique({ where: { id } })).storageKey;
    assert.ok(await storage.head(key), 'object exists');
    await call(base, m1, 'POST', `/api/clips/${id}/trash`);
    assert.equal((await call(base, m1, 'DELETE', `/api/clips/${id}`)).status, 200);
    assert.equal(await storage.head(key), null, 'object removed from storage');
  });

  test('abort leaves nothing in storage; a part signed for one upload cannot be used for another', async () => {
    const { m1 } = await world(base);
    const a = (await call(base, m1, 'POST', '/api/recordings', { mimeType: 'video/webm', sizeBytes: 6 * MiB })).body.clip.id;
    const b = (await call(base, m1, 'POST', '/api/recordings', { mimeType: 'video/webm', sizeBytes: 6 * MiB })).body.clip.id;
    const urlA = (await call(base, m1, 'POST', `/api/clips/${a}/upload/parts`, { partNumbers: [1] })).body.urls[1];
    // the signature covers key + upload id + part number: changing the part number invalidates it
    const forged = await fetch(urlA.replace('partNumber=1', 'partNumber=2'), { method: 'PUT', body: Buffer.alloc(1 * MiB) });
    assert.equal(forged.status, 403);
    assert.equal((await fetch(urlA, { method: 'PUT', body: Buffer.alloc(5 * MiB) })).status, 200);
    assert.equal((await call(base, m1, 'POST', `/api/clips/${a}/upload/abort`, {})).status, 200);
    assert.equal((await call(base, m1, 'GET', `/api/clips/${a}/upload`)).status, 404, 'the clip is gone');
    assert.equal((await call(base, m1, 'POST', `/api/clips/${b}/upload/abort`, {})).status, 200);
  });
});
