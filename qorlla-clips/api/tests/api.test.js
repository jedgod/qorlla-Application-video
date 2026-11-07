import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, call, world, who, uniq, prisma, configFor } from './helpers.js';
import { loadConfig } from '../src/config.js';

let srv, base;
before(async () => { srv = await start(); base = srv.base; });
after(async () => { await srv.close(); await prisma.$disconnect(); });

const clip = async (u, body = {}) => (await call(base, u, 'POST', '/api/clips', { source: 'RECORDING', ...body })).body;
const list = async (u, q = '') => (await call(base, u, 'GET', '/api/clips' + q)).body;
const ids = (l) => l.clips.map((c) => c.id);

describe('configuration refuses unsafe settings', () => {
  const ok = { DATABASE_URL: 'postgresql://u:p@h:5432/d' };
  test('production cannot use dev authentication or SQLite, and qorlla mode needs the main app URL', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'dev', ...ok }), /not allowed/);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'file:./x.db', AUTH_MODE: 'qorlla', QORLLA_MAIN_URL: 'http://m' }), /SQLite/);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'qorlla', ...ok }), /QORLLA_MAIN_URL/);
    assert.throws(() => loadConfig({ DATABASE_URL: 'mysql://x' }), /DATABASE_URL/);
    assert.equal(loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'qorlla', QORLLA_MAIN_URL: 'http://m/', ...ok }).mainUrl, 'http://m');
    assert.equal(loadConfig({ NODE_ENV: 'production', QORLLA_MAIN_URL: 'http://m', ...ok }).authMode, 'qorlla', 'qorlla is the production default');
  });
});

describe('authentication', () => {
  test('no identity -> 401 on every API route; the health check is open', async () => {
    for (const [m, p] of [['GET', '/api/me'], ['GET', '/api/clips'], ['POST', '/api/clips'], ['GET', '/api/navigation/summary'], ['GET', '/api/playlists'], ['GET', '/api/notifications']]) {
      assert.equal((await call(base, null, m, p, m === 'POST' ? { source: 'RECORDING' } : undefined)).status, 401, `${m} ${p}`);
    }
    assert.equal((await call(base, who('not-an-email'), 'GET', '/api/me')).status, 401);
    assert.equal((await call(base, null, 'GET', '/healthz')).body.ok, true);
  });

  test('qorlla mode: the session is verified with the main app on EVERY request, so a logout or suspension takes effect at once; an unreachable main app fails closed', async () => {
    let mode = 'ok', calls = 0, seenCookie = null;
    const fake = async (url, init) => {
      calls++; seenCookie = init.headers.cookie;
      assert.equal(url, 'http://main.test/api/auth/me');
      if (mode === 'down') throw new Error('ECONNREFUSED');
      if (mode === 'error') return new Response('{}', { status: 500 });
      if (mode === 'out') return new Response('{"error":"Sign in required."}', { status: 401 });
      return new Response(JSON.stringify({ user: { id: 'main-user-1', username: 'Casey', displayName: 'Casey Rowe' } }), { status: 200 });
    };
    const q = await start({ authMode: 'qorlla', mainUrl: 'http://main.test', adminUsernames: ['casey'], orgSlug: uniq('q') }, fake);
    try {
      const get = (cookie) => fetch(q.base + '/api/me', { headers: cookie ? { cookie } : {} }).then(async (r) => ({ status: r.status, body: await r.json() }));
      assert.equal((await get(null)).status, 401); assert.equal(calls, 0, 'no cookie: main is not even asked');
      const me = await get('qs=abc');
      assert.equal(me.status, 200); assert.equal(me.body.name, 'Casey Rowe'); assert.equal(me.body.role, 'ADMIN', 'ADMIN_USERNAMES is honoured');
      assert.equal(seenCookie, 'qs=abc', 'the browser cookie is forwarded as-is');
      mode = 'out'; assert.equal((await get('qs=abc')).status, 401, 'logged out in main -> refused immediately');
      mode = 'down'; assert.equal((await get('qs=abc')).status, 503, 'main unreachable -> fail closed');
      mode = 'error'; assert.equal((await get('qs=abc')).status, 503, 'main erroring -> fail closed');
      mode = 'ok'; assert.equal((await get('qs=abc')).status, 200);
      assert.equal(await prisma.user.count({ where: { externalId: 'main-user-1' } }), 1, 'one local user per main account');
    } finally { await q.close(); }
  });

  test('a brand-new user whose page fires many requests at once is created exactly once, and every request succeeds', async () => {
    const u = who(uniq('first') + '@t.test', uniq('o'));
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => call(base, u, 'GET', ['/api/me', '/api/navigation/summary', '/api/clips', '/api/notifications'][i % 4])));
    assert.deepEqual([...new Set(rs.map((r) => r.status))], [200], rs.filter((r) => r.status !== 200).map((r) => r.text).join(' | '));
    assert.equal(await prisma.user.count({ where: { email: u.email } }), 1, 'one user row');
    assert.equal(await prisma.organization.count({ where: { slug: u.org } }), 1, 'one organization row');
  });

  test('state-changing requests need the app header and a same-site Origin', async () => {
    const u = who(uniq('c') + '@t.test', uniq('o'));
    const raw = (headers) => fetch(base + '/api/clips', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user': u.email, 'x-dev-org': u.org, ...headers }, body: JSON.stringify({ source: 'RECORDING' }) });
    assert.equal((await raw({})).status, 403, 'no x-requested-with');
    assert.equal((await raw({ 'x-requested-with': 'qorlla-clips', origin: 'https://evil.example' })).status, 403, 'foreign Origin');
    assert.equal((await raw({ 'x-requested-with': 'qorlla-clips' })).status, 201, 'no Origin (non-browser) is fine');
    assert.equal((await raw({ 'x-requested-with': 'qorlla-clips', origin: base })).status, 201, 'same origin is fine');
  });

  test('behind a proxy the browser origin is checked against X-Forwarded-Host, but only when the proxy is trusted; CORS_ORIGINS is the explicit alternative', async () => {
    const u = who(uniq('p') + '@t.test', uniq('o'));
    const post = (b, headers) => fetch(b + '/api/clips', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'qorlla-clips', 'x-dev-user': u.email, 'x-dev-org': u.org, ...headers }, body: JSON.stringify({ source: 'RECORDING' }) }).then((r) => r.status);
    const proxied = { origin: 'https://clips.example.com', 'x-forwarded-host': 'clips.example.com' };
    assert.equal(await post(base, proxied), 403, 'default: forwarded headers are NOT trusted, so a spoofed one cannot open the door');
    const t = await start({ trustProxy: true });
    const l = await start({ corsOrigins: ['https://clips.example.com'] });
    try {
      assert.equal(await post(t.base, proxied), 201, 'trusted proxy: origin matches the forwarded host');
      assert.equal(await post(t.base, { origin: 'https://evil.example', 'x-forwarded-host': 'clips.example.com' }), 403, 'a different origin is still refused');
      assert.equal(await post(l.base, { origin: 'https://clips.example.com' }), 201, 'listed in CORS_ORIGINS');
      assert.equal(await post(l.base, { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' }), 403, 'forwarded host is ignored without TRUST_PROXY');
    } finally { await t.close(); await l.close(); }
  });
});

describe('clips', () => {
  test('create: every source; a clip starts PROCESSING with NO media URL (nothing is invented); title defaults; input is validated strictly', async () => {
    const { a } = await world(base, { plan: 'pro' });
    for (const source of ['RECORDING', 'AVATAR_GENERATION', 'SLIDE_CONVERSION', 'UPLOAD']) {
      const r = await call(base, a, 'POST', '/api/clips', { source, title: ' ' + source + ' ' });
      assert.equal(r.status, 201, source); assert.equal(r.body.source, source); assert.equal(r.body.status, 'PROCESSING'); assert.equal(r.body.videoUrl, null);
      assert.equal(r.body.title, source, 'trimmed');
    }
    assert.match((await clip(a)).title, /^Untitled clip - /);
    for (const bad of [{ source: 'NOPE' }, {}, { source: 'RECORDING', title: '' }, { source: 'RECORDING', title: 'x'.repeat(201) }, { source: 'RECORDING', extra: 1 }, { source: 'RECORDING', playlistId: 'nope' }, { source: 'RECORDING', videoUrl: 'https://x' }]) {
      assert.equal((await call(base, a, 'POST', '/api/clips', bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await call(base, a, 'POST', '/api/clips', '{bad json')).status, 400);
  });

  test('Upload video is locked on the free plan (matches the lock in the menu) and open on paid plans', async () => {
    const free = await world(base), paid = await world(base, { plan: 'business' });
    const r = await call(base, free.m1, 'POST', '/api/clips', { source: 'UPLOAD' });
    assert.equal(r.status, 403); assert.equal(r.body.error, 'feature_locked'); assert.equal(r.body.feature, 'upload');
    assert.equal((await call(base, free.m1, 'GET', '/api/navigation/summary')).body.features.upload, false);
    assert.equal((await call(base, paid.m1, 'POST', '/api/clips', { source: 'UPLOAD' })).status, 201);
    assert.equal((await call(base, paid.m1, 'GET', '/api/navigation/summary')).body.features.upload, true);
    assert.equal((await call(base, free.m1, 'POST', '/api/clips', { source: 'RECORDING' })).status, 201, 'other sources are unaffected');
  });

  test('lifecycle: star, rename, trash, restore, delete only from Trash; counters follow every step', async () => {
    const { m1 } = await world(base);
    const sum = async () => (await call(base, m1, 'GET', '/api/navigation/summary')).body;
    const c1 = await clip(m1, { title: 'one' }), c2 = await clip(m1, { title: 'two' });
    assert.deepEqual([(await sum()).myClipsCount, (await sum()).starredCount, (await sum()).trashCount], [2, 0, 0]);
    assert.equal((await call(base, m1, 'PATCH', `/api/clips/${c1.id}`, { isStarred: true, title: 'uno' })).body.title, 'uno');
    assert.deepEqual([(await sum()).myClipsCount, (await sum()).starredCount], [2, 1]);
    assert.deepEqual(ids(await list(m1, '?view=starred')), [c1.id]);
    assert.equal((await call(base, m1, 'DELETE', `/api/clips/${c2.id}`)).status, 409, 'not in trash yet');
    assert.equal((await call(base, m1, 'POST', `/api/clips/${c1.id}/trash`)).body.isTrashed, true);
    assert.deepEqual([(await sum()).myClipsCount, (await sum()).starredCount, (await sum()).trashCount], [1, 0, 1], 'a trashed clip leaves Starred and My clips');
    assert.deepEqual(ids(await list(m1, '?view=trash')), [c1.id]); assert.deepEqual(ids(await list(m1, '?view=mine')), [c2.id]);
    assert.equal((await call(base, m1, 'PATCH', `/api/clips/${c1.id}`, { title: 'x' })).status, 409, 'cannot edit a trashed clip');
    assert.equal((await call(base, m1, 'POST', `/api/clips/${c1.id}/restore`)).body.isTrashed, false);
    assert.equal((await sum()).trashCount, 0);
    await call(base, m1, 'POST', `/api/clips/${c2.id}/trash`);
    assert.equal((await call(base, m1, 'DELETE', `/api/clips/${c2.id}`)).status, 200);
    assert.equal((await call(base, m1, 'GET', '/api/clips?view=trash')).body.clips.length, 0);
    assert.equal(await prisma.clip.count({ where: { id: c2.id } }), 0, 'really deleted');
  });

  test('pagination is stable and complete; search filters by title', async () => {
    const { m1 } = await world(base);
    const made = []; for (let i = 0; i < 7; i++) made.push((await clip(m1, { title: (i % 2 ? 'Alpha ' : 'Beta ') + i })).id);
    const seen = []; let cursor = null, pages = 0;
    do { const r = await list(m1, `?view=mine&limit=3${cursor ? '&cursor=' + cursor : ''}`); seen.push(...ids(r)); cursor = r.nextCursor; pages++; } while (cursor && pages < 10);
    assert.equal(pages, 3); assert.deepEqual([...seen].sort(), [...made].sort(), 'every clip exactly once'); assert.equal(new Set(seen).size, 7);
    assert.equal((await list(m1, '?view=mine&q=alpha')).clips.length, 3);
    await clip(m1, { title: 'avatar one', source: 'AVATAR_GENERATION' });
    assert.deepEqual((await list(m1, '?view=mine&source=AVATAR_GENERATION')).clips.map((c) => c.title), ['avatar one'], 'filter by how a clip was made');
    assert.equal((await call(base, m1, 'GET', '/api/clips?source=NOPE')).status, 400);
    assert.equal((await call(base, m1, 'GET', '/api/clips?limit=0')).status, 400); assert.equal((await call(base, m1, 'GET', '/api/clips?limit=101')).status, 400);
    assert.equal((await call(base, m1, 'GET', '/api/clips?view=everything')).status, 400); assert.equal((await call(base, m1, 'GET', '/api/clips?cursor=zzz')).status, 400);
  });
});

describe('tenant isolation and ownership', () => {
  test('another organization can neither see nor touch your clips and playlists: guessed ids are 404, never 403 (existence is not confirmed)', async () => {
    const A = await world(base, { plan: 'pro' }), B = await world(base, { plan: 'pro' });
    const c = await clip(A.m1, { title: 'secret' });
    const pl = (await call(base, A.m1, 'POST', '/api/playlists', { title: 'mine' })).body;
    const orgPl = (await call(base, A.a, 'POST', '/api/playlists', { title: 'A-wide', isOrganization: true })).body;
    for (const [m, p, body] of [['PATCH', `/api/clips/${c.id}`, { title: 'x' }], ['POST', `/api/clips/${c.id}/trash`], ['POST', `/api/clips/${c.id}/restore`], ['DELETE', `/api/clips/${c.id}`], ['POST', `/api/clips/${c.id}/share`, { email: B.m2.email }],
      ['PATCH', `/api/playlists/${pl.id}`, { title: 'x' }], ['DELETE', `/api/playlists/${pl.id}`], ['PATCH', `/api/playlists/${orgPl.id}`, { title: 'x' }], ['DELETE', `/api/playlists/${orgPl.id}`],
      ['POST', `/api/playlists/${orgPl.id}/clips`, { clipId: c.id }]]) {
      assert.equal((await call(base, B.a, m, p, body)).status, 404, `${m} ${p} as another org's ADMIN`);
    }
    const mine = await clip(B.m1, { title: 'b-clip' });
    assert.equal((await call(base, B.m1, 'POST', `/api/playlists/${orgPl.id}/clips`, { clipId: mine.id })).status, 404, "cannot use another org's playlist");
    assert.equal((await call(base, B.m1, 'POST', '/api/clips', { source: 'RECORDING', playlistId: pl.id })).status, 404, "cannot create into another org's playlist");
    assert.equal((await call(base, B.m1, 'GET', `/api/clips?view=playlist&playlistId=${orgPl.id}`)).status, 404);
    for (const view of ['recent', 'mine', 'shared', 'starred', 'trash']) assert.ok(!ids(await list(B.a, `?view=${view}`)).includes(c.id), view);
    const sb = (await call(base, B.a, 'GET', '/api/navigation/summary')).body;
    assert.ok(!JSON.stringify(sb).includes(orgPl.id) && !JSON.stringify(sb).includes(pl.id), "B's summary never lists A's playlists");
    assert.equal((await call(base, A.m1, 'POST', `/api/clips/${c.id}/share`, { email: B.m2.email })).status, 404, "an email in another org does not exist for the sharer");
    assert.equal(await prisma.clipShare.count({ where: { clipId: c.id } }), 0);
    assert.equal((await call(base, A.m1, 'GET', `/api/clips?q=secret`)).body.clips.length, 1, 'while the owner still sees it');
  });

  test('inside one organization: other members cannot edit, trash, delete or share your clip; a recipient can see it but not change it', async () => {
    const { m1, m2, a } = await world(base);
    const c = await clip(m1, { title: 'mine' });
    for (const [m, p, body] of [['PATCH', `/api/clips/${c.id}`, { title: 'x' }], ['POST', `/api/clips/${c.id}/trash`], ['DELETE', `/api/clips/${c.id}`], ['POST', `/api/clips/${c.id}/share`, { email: a.email }]]) {
      assert.equal((await call(base, m2, m, p, body)).status, 404, `${m} by another member`);
      assert.equal((await call(base, a, m, p, body)).status, 404, `${m} by an admin: admins manage playlists, not other people's clips`);
    }
    assert.ok(!ids(await list(m2, '?view=recent')).includes(c.id), 'not visible before it is shared');
    assert.equal((await call(base, m1, 'POST', `/api/clips/${c.id}/share`, { email: m2.email })).status, 201);
    assert.equal((await call(base, m1, 'POST', `/api/clips/${c.id}/share`, { email: m2.email })).status, 201, 'sharing twice is harmless');
    const race = await Promise.all([1, 2, 3, 4].map(() => call(base, m1, 'POST', `/api/clips/${c.id}/share`, { email: m2.email })));
    assert.ok(race.every((r) => r.status === 201), 'simultaneous duplicate shares all succeed');
    assert.equal(await prisma.clipShare.count({ where: { clipId: c.id } }), 1, 'one share row');
    assert.equal((await call(base, m1, 'POST', `/api/clips/${c.id}/share`, { email: m1.email })).status, 400, 'not with yourself');
    assert.equal((await call(base, m1, 'POST', `/api/clips/${c.id}/share`, { email: 'nobody@t.test' })).status, 404);
    assert.deepEqual(ids(await list(m2, '?view=shared')), [c.id]); assert.ok(ids(await list(m2, '?view=recent')).includes(c.id));
    const seen = (await list(m2, '?view=shared')).clips[0]; assert.equal(seen.ownedByMe, false); assert.equal(seen.ownerName, m1.email.split('@')[0]);
    assert.equal((await call(base, m2, 'PATCH', `/api/clips/${c.id}`, { title: 'x' })).status, 404);
    const sb = (await call(base, m2, 'GET', '/api/navigation/summary')).body; assert.equal(sb.sharedCount, 1); assert.equal(sb.unreadNotifications, 1); assert.equal(sb.myClipsCount, 0);
    const n = (await call(base, m2, 'GET', '/api/notifications')).body.notifications; assert.equal(n.length, 1); assert.match(n[0].message, /shared "mine" with you/); assert.equal(n[0].read, false);
    assert.equal((await call(base, m1, 'GET', '/api/notifications')).body.notifications.length, 0, 'notifications are private');
    assert.equal((await call(base, m1, 'POST', '/api/notifications/read', {})).body.updated, 0, "cannot mark someone else's");
    assert.equal((await call(base, m2, 'POST', '/api/notifications/read', {})).body.updated, 1);
    assert.equal((await call(base, m2, 'GET', '/api/navigation/summary')).body.unreadNotifications, 0);
    await call(base, m1, 'DELETE', `/api/clips/${c.id}/share/${(await call(base, m2, 'GET', '/api/me')).body.id}`);
    assert.ok(!ids(await list(m2, '?view=recent')).includes(c.id), 'unsharing removes access');
    await call(base, m1, 'POST', `/api/clips/${c.id}/share`, { email: m2.email }); await call(base, m1, 'POST', `/api/clips/${c.id}/trash`);
    assert.equal((await list(m2, '?view=shared')).clips.length, 0, 'a trashed clip disappears from recipients');
  });
});

describe('playlists', () => {
  test('personal playlists: create, rename, add and remove clips, delete keeps the clips; they are private to their owner', async () => {
    const { m1, m2 } = await world(base);
    const pl = (await call(base, m1, 'POST', '/api/playlists', { title: 'Demos' })).body;
    assert.equal((await call(base, m1, 'POST', '/api/playlists', { title: '' })).status, 400);
    const c = await clip(m1), other = await clip(m2);
    assert.equal((await call(base, m1, 'POST', `/api/playlists/${pl.id}/clips`, { clipId: c.id })).status, 201);
    assert.equal((await call(base, m1, 'POST', `/api/playlists/${pl.id}/clips`, { clipId: other.id })).status, 404, "another member's unshared clip is not even visible");
    assert.deepEqual(ids(await list(m1, `?view=playlist&playlistId=${pl.id}`)), [c.id]);
    assert.equal((await call(base, m1, 'GET', '/api/playlists')).body.playlists[0].clipCount, 1);
    assert.equal((await call(base, m1, 'GET', '/api/navigation/summary')).body.playlists[0].clipCount, 1);
    assert.equal((await call(base, m2, 'GET', `/api/clips?view=playlist&playlistId=${pl.id}`)).status, 404, "someone else's personal playlist");
    assert.equal((await call(base, m2, 'POST', `/api/playlists/${pl.id}/clips`, { clipId: other.id })).status, 404);
    assert.equal((await call(base, m1, 'PATCH', `/api/playlists/${pl.id}`, { title: 'Demos 2' })).body.title, 'Demos 2');
    assert.equal((await call(base, m2, 'POST', `/api/clips/${other.id}/share`, { email: m1.email })).status, 201);
    assert.equal((await call(base, m1, 'POST', `/api/playlists/${pl.id}/clips`, { clipId: other.id })).status, 403, 'a shared clip can be seen but not collected into your playlist');
    assert.equal((await call(base, m1, 'DELETE', `/api/playlists/${pl.id}/clips/${c.id}`)).status, 200);
    assert.equal((await list(m1, `?view=playlist&playlistId=${pl.id}`)).clips.length, 0);
    await call(base, m1, 'POST', `/api/playlists/${pl.id}/clips`, { clipId: c.id });
    assert.equal((await call(base, m1, 'DELETE', `/api/playlists/${pl.id}`)).status, 200);
    assert.equal(await prisma.clip.count({ where: { id: c.id } }), 1, 'deleting a playlist keeps its clips');
    assert.equal((await call(base, m1, 'GET', `/api/clips?view=playlist&playlistId=${pl.id}`)).status, 404);
  });

  test('organization playlists: admins manage them, members add their OWN clips, and a clip placed there becomes visible to the whole organization (only)', async () => {
    const { a, m1, m2 } = await world(base), other = await world(base);
    assert.equal((await call(base, m1, 'POST', '/api/playlists', { title: 'Team', isOrganization: true })).status, 403, 'members cannot create organization playlists');
    const org = (await call(base, a, 'POST', '/api/playlists', { title: 'Team', isOrganization: true })).body;
    assert.equal(org.isOrganization, true);
    assert.deepEqual((await call(base, m2, 'GET', '/api/navigation/summary')).body.organizationPlaylists.map((p) => p.title), ['Team']);
    assert.equal((await call(base, m1, 'PATCH', `/api/playlists/${org.id}`, { title: 'x' })).status, 403); assert.equal((await call(base, m1, 'DELETE', `/api/playlists/${org.id}`)).status, 403);
    const c = await clip(m1, { title: 'company update' });
    assert.ok(!ids(await list(m2, '?view=recent')).includes(c.id));
    assert.equal((await call(base, m2, 'POST', `/api/playlists/${org.id}/clips`, { clipId: c.id })).status, 404, 'cannot add what you cannot see');
    assert.equal((await call(base, m1, 'POST', `/api/playlists/${org.id}/clips`, { clipId: c.id })).status, 201);
    assert.deepEqual(ids(await list(m2, `?view=playlist&playlistId=${org.id}`)), [c.id], 'visible to other members through the playlist');
    assert.ok(ids(await list(m2, '?view=recent')).includes(c.id));
    assert.equal((await call(base, m2, 'PATCH', `/api/clips/${c.id}`, { title: 'x' })).status, 404, 'visible, not editable');
    assert.equal((await call(base, m2, 'DELETE', `/api/playlists/${org.id}/clips/${c.id}`)).status, 403, 'a non-owner member cannot remove it');
    assert.ok(!ids(await list(other.a, '?view=recent')).includes(c.id), 'and never to another organization');
    assert.equal((await call(base, a, 'DELETE', `/api/playlists/${org.id}/clips/${c.id}`)).status, 200, 'an admin can');
    assert.ok(!ids(await list(m2, '?view=recent')).includes(c.id));
    assert.equal((await call(base, a, 'DELETE', `/api/playlists/${org.id}`)).status, 200);
  });
});

describe('media completion (service-to-service)', () => {
  test('disabled without SERVICE_KEY; with it: key required, https and an allow-listed host required, READY/FAILED recorded', async () => {
    const { m1 } = await world(base); const c = await clip(m1);
    assert.equal((await call(base, null, 'POST', `/api/internal/clips/${c.id}/complete`, { status: 'READY', videoUrl: 'https://cdn.test/a.mp4' })).status, 404, 'route does not exist without a key');
    const s = await start({ serviceKey: 'k'.repeat(40), mediaHosts: ['cdn.test'] });
    try {
      const post = (key, body, id = c.id) => fetch(`${s.base}/api/internal/clips/${id}/complete`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-service-key': key } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
      assert.equal((await post(null, { status: 'READY', videoUrl: 'https://cdn.test/a.mp4' })).status, 401);
      assert.equal((await post('x'.repeat(40), { status: 'READY', videoUrl: 'https://cdn.test/a.mp4' })).status, 401);
      const key = 'k'.repeat(40);
      assert.equal((await post(key, { status: 'READY', videoUrl: 'http://cdn.test/a.mp4' })).status, 400, 'http refused');
      assert.equal((await post(key, { status: 'READY', videoUrl: 'https://evil.test/a.mp4' })).status, 400, 'host not allow-listed');
      assert.equal((await post(key, { status: 'READY' })).status, 400);
      assert.equal((await post(key, { status: 'READY', videoUrl: 'https://cdn.test/a.mp4' })).body.status, 'READY');
      assert.equal((await list(m1, '?view=mine')).clips[0].videoUrl, 'https://cdn.test/a.mp4');
      assert.equal((await post(key, { status: 'FAILED' })).body.status, 'FAILED');
      assert.equal((await list(m1, '?view=mine')).clips[0].videoUrl, null);
      assert.equal((await post(key, { status: 'FAILED' }, '00000000-0000-4000-8000-000000000000')).status, 404);
    } finally { await s.close(); }
  });
});

describe('hardening', () => {
  test('a per-user request budget answers 429, and errors never leak internals', async () => {
    const s = await start({ rateLimitPerMinute: 5 });
    try {
      const u = who(uniq('r') + '@t.test', uniq('o')); let last = 0;
      for (let i = 0; i < 8; i++) last = (await call(s.base, u, 'GET', '/api/me')).status;
      assert.equal(last, 429);
      assert.equal((await call(s.base, who(uniq('r2') + '@t.test', uniq('o')), 'GET', '/api/me')).status, 200, 'other users are unaffected');
    } finally { await s.close(); }
    const r = await call(base, null, 'GET', '/api/nope'); assert.equal(r.status, 401);
    const { m1 } = await world(base); const nf = await call(base, m1, 'GET', '/api/nope'); assert.equal(nf.status, 404); assert.doesNotMatch(nf.text, /prisma|stack|at /i);
    assert.equal(nf.headers.get('x-powered-by'), null); assert.equal(nf.headers.get('cache-control'), 'no-store');
  });
});
