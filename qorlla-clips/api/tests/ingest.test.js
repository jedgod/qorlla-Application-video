import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { signIngest } from '../src/ingest.js';
import { configFor, call, world, uniq, prisma } from './helpers.js';

const SECRET = 'test-secret-'.padEnd(40, 'x');
const HOST = 'media.qorlla.test';
let srv, base, off;

async function boot(over) {
  const app = createApp({ prisma, config: configFor(over) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
before(async () => {
  const a = await boot({ webhookSecret: SECRET, mediaHosts: [HOST] }); srv = a.server; base = a.base;
  const b = await boot({ webhookSecret: '', mediaHosts: [HOST] }); off = b;
});
after(async () => { await new Promise((r) => srv.close(r)); await new Promise((r) => off.server.close(r)); await prisma.$disconnect(); });

/** sends a webhook the way Qorlla would: the signature covers the exact bytes sent */
async function hook(payload, { secret = SECRET, ts = Math.floor(Date.now() / 1000), at = base, raw, sig, omitSig } = {}) {
  const text = raw ?? JSON.stringify(payload);
  const headers = { 'content-type': 'application/json', 'x-qorlla-timestamp': String(ts) };
  if (!omitSig) headers['x-qorlla-signature'] = sig ?? signIngest(secret, ts, Buffer.from(text));
  const r = await fetch(at + '/api/webhooks/qorlla-ingest', { method: 'POST', headers, body: text });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const payload = (email, over = {}) => ({ meetingId: uniq('meet'), meetingTitle: 'Sprint retro', ownerEmail: email, videoUrl: `https://${HOST}/rec/1.mp4`, durationSeconds: 1800, ...over });

describe('Qorlla Meeting ingestion webhook', () => {
  test('a signed payload for a paid organization creates a READY clip owned by that user; a repeat delivery returns the same clip', async () => {
    const w = await world(base, { plan: 'pro' });
    const p = payload(w.m1.email);
    const r = await hook(p); assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.duplicate, false);
    const clip = await prisma.clip.findUnique({ where: { id: r.body.clipId } });
    assert.equal(clip.source, 'QORLLA_MEETING'); assert.equal(clip.status, 'READY'); assert.equal(clip.durationMs, 1800000); assert.equal(clip.externalId, p.meetingId);
    assert.equal(clip.videoUrl, p.videoUrl);
    const again = await hook(p); assert.equal(again.status, 200); assert.deepEqual(again.body, { clipId: r.body.clipId, duplicate: true });
    const parallel = await Promise.all([1, 2, 3].map(() => hook(payload(w.m1.email, { meetingId: 'same-' + w.org })))); assert.ok(parallel.every((x) => [200, 201].includes(x.status)));
    assert.equal(await prisma.clip.count({ where: { externalId: 'same-' + w.org } }), 1, 'concurrent deliveries create one clip');
    const listed = await call(base, w.m1, 'GET', '/api/clips?view=mine&source=QORLLA_MEETING');
    assert.equal(listed.body.clips.length >= 2, true); assert.equal(listed.body.clips[0].playable, true);
  });

  test('a free organization is refused with PREMIUM_ENTITLEMENT_REQUIRED and nothing is created', async () => {
    const w = await world(base);
    const p = payload(w.m1.email); const r = await hook(p);
    assert.equal(r.status, 403); assert.equal(r.body.code, 'PREMIUM_ENTITLEMENT_REQUIRED');
    assert.equal(await prisma.clip.count({ where: { externalId: p.meetingId } }), 0);
    await prisma.organization.update({ where: { slug: w.org }, data: { plan: 'pro' } });          // the upgrade takes effect on the next delivery
    assert.equal((await hook(p)).status, 201);
  });

  test('an unknown e-mail address creates nothing', async () => {
    const r = await hook(payload('nobody-' + uniq() + '@t.test')); assert.equal(r.status, 404);
  });

  test('no signature, a wrong signature, another secret, a changed body and a stale or future timestamp are all refused before anything is read', async () => {
    const w = await world(base, { plan: 'pro' }); const p = payload(w.m1.email); const text = JSON.stringify(p); const now = Math.floor(Date.now() / 1000);
    assert.equal((await hook(p, { omitSig: true })).status, 401);
    assert.equal((await hook(p, { sig: 'sha256=' + '0'.repeat(64) })).status, 403);
    assert.equal((await hook(p, { sig: 'garbage' })).status, 403, 'a short signature does not crash the comparison');
    assert.equal((await hook(p, { secret: 'y'.repeat(40) })).status, 403);
    const good = signIngest(SECRET, now, Buffer.from(text));
    assert.equal((await hook(null, { raw: text.replace('Sprint', 'Sprunt'), sig: good, ts: now })).status, 403, 'tampered body');
    assert.equal((await hook(p, { ts: now - 3600 })).status, 403, 'a captured request cannot be replayed an hour later');
    assert.equal((await hook(p, { ts: now + 3600 })).status, 403);
    assert.equal((await hook(p, { ts: 'abc', sig: good })).status, 403);
    assert.equal(await prisma.clip.count({ where: { externalId: p.meetingId } }), 0);
  });

  test('the link must be https on an allowed media host: http, other hosts, internal addresses and credentials in the URL are refused even when correctly signed', async () => {
    const w = await world(base, { plan: 'pro' });
    for (const url of ['http://' + HOST + '/a.mp4', 'https://evil.test/a.mp4', 'https://169.254.169.254/latest/meta-data', 'https://localhost/a', 'https://127.0.0.1/a', `https://user:pw@${HOST}/a`, 'ftp://' + HOST + '/a', 'not a url']) {
      const r = await hook(payload(w.m1.email, { videoUrl: url })); assert.equal(r.status, 400, url);
    }
  });

  test('invalid payloads: extra fields, bad meeting id, bad e-mail, bad duration', async () => {
    const w = await world(base, { plan: 'pro' });
    for (const over of [{ extra: 1 }, { meetingId: '../etc' }, { meetingId: '' }, { ownerEmail: 'nope' }, { durationSeconds: -1 }, { durationSeconds: 'x' }]) assert.equal((await hook(payload(w.m1.email, over))).status, 400, JSON.stringify(over));
    assert.equal((await hook(null, { raw: '{not json' })).status, 400);
  });

  test('the same meeting id in two organizations makes two clips; the title is cleaned', async () => {
    const a = await world(base, { plan: 'pro' }), b = await world(base, { plan: 'pro' });
    const id = uniq('shared-meet');
    const r1 = await hook(payload(a.m1.email, { meetingId: id, meetingTitle: 'a\r\nb' })), r2 = await hook(payload(b.m1.email, { meetingId: id }));
    assert.notEqual(r1.body.clipId, r2.body.clipId);
    assert.equal((await prisma.clip.findUnique({ where: { id: r1.body.clipId } })).title, 'a b');
  });

  test('the endpoint does not exist when no secret is configured, and a short secret stops the server from starting', async () => {
    assert.equal((await hook(payload('x@t.test'), { at: off.base })).status, 404);
    const env = { NODE_ENV: 'test', DATABASE_URL: 'file:./x.db', AUTH_MODE: 'dev', MEDIA_HOSTS: HOST };
    assert.throws(() => loadConfig({ ...env, QORLLA_WEBHOOK_SECRET: 'short' }), /at least 32/);
    assert.throws(() => loadConfig({ ...env, QORLLA_WEBHOOK_SECRET: SECRET, MEDIA_HOSTS: '' }), /MEDIA_HOSTS/);
    assert.equal(loadConfig({ ...env, QORLLA_WEBHOOK_SECRET: SECRET }).webhookSecret, SECRET);
  });
});
