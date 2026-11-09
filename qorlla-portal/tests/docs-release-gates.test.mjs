// Release gates for Qorlla Docs: pagination beyond 200 documents, and abuse controls (per-person rate limits, per-document comment cap, folder cap).
// Real PostgreSQL, real permission checks. Bulk data is inserted with SQL (the API would be slow and would trip the very limits under test).
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, addMember } from './helpers.mjs';

const ids = (r) => r.body.map((d) => d.id);

describe('pagination: every document is reachable, in a stable order, with the caller\'s own rights', () => {
  let db, main, app, H, M, W;
  const host = () => app.client(H); const member = () => app.client(M);
  const q = async (sql, args = []) => (await db.pool.query(sql, args)).rows;
  const seed = (ws, owner, n, { title = (g) => 'Seed ' + g, updated = "now() - (g * interval '1 second')", deleted = false, kind = 'doc' } = {}) =>
    db.pool.query(`INSERT INTO portal.documents(workspace_id,owner_id,kind,title,current_version,search_text,updated_at,deleted_at) SELECT $1,$2,$4,${title('g').startsWith('$') ? title('g') : `'${title('g')}'`},1,'',${updated},${deleted ? 'now()' : 'NULL'} FROM generate_series(1,$3) g`, [ws, owner, n, kind]);
  /** Follow X-Next-Cursor until it runs out; returns every row and how many pages it took. */
  async function walk(cl, qs, { max = 100 } = {}) {
    const rows = []; let cursor = null; let pages = 0;
    do {
      const r = await cl.get(`/api/v1/documents?${qs}${cursor ? '&cursor=' + cursor : ''}`); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 120)); pages++;
      rows.push(...r.body); cursor = r.headers.get('x-next-cursor'); assert.ok(pages <= max, 'cursor never ends');
    } while (cursor);
    return { rows, pages };
  }
  const newBusiness = async () => { const u = await main.mint(); const w = await seedWorkspace(db.pool, u.sub, 'Pg ' + crypto.randomBytes(3).toString('hex')); await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='business',status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [w]); return { u, w, cl: app.client(u) }; };

  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn(); app = await startApp({ pool: db.pool, cfg: testConfig({}, main), jwks: main.jwks });
    H = await main.mint(); M = await main.mint(); W = await seedWorkspace(db.pool, H.sub, 'Paging Co'); await addMember(db.pool, W, M.sub, 'member');
    await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='business',status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [W]);
  });
  after(async () => { await app?.close(); await main?.close(); await db?.drop(); });

  test('450 documents (more than the old 200-row ceiling) are all reachable, once each, newest first; the old unparameterised list keeps its 200 cap', async () => {
    const b = await newBusiness(); await seed(b.w, b.u.sub, 450);
    const { rows, pages } = await walk(b.cl, 'view=recent&limit=200'); assert.equal(rows.length, 450); assert.equal(new Set(rows.map((r) => r.id)).size, 450, 'no duplicates'); assert.equal(pages, 3);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].updated_at >= rows[i].updated_at, 'newest first');
    const dflt = await walk(b.cl, 'view=recent'); assert.equal(dflt.rows.length, 450); assert.equal(dflt.pages, 9, 'the default page is 50');
    assert.equal((await b.cl.get('/api/v1/documents')).body.length, 200, 'the legacy list (no parameters) is unchanged: 200 rows');
  });
  test('documents with the SAME update time are neither skipped nor repeated (the id breaks the tie)', async () => {
    const b = await newBusiness(); await seed(b.w, b.u.sub, 120, { updated: "timestamptz '2026-01-01 12:00:00+00'" });
    const { rows } = await walk(b.cl, 'view=recent&limit=25'); assert.equal(rows.length, 120); assert.equal(new Set(rows.map((r) => r.id)).size, 120);
  });
  test('a document edited while someone pages is never shown twice and nothing else goes missing', async () => {
    const b = await newBusiness(); await seed(b.w, b.u.sub, 60); const p1 = await b.cl.get('/api/v1/documents?view=recent&limit=20'); const cursor = p1.headers.get('x-next-cursor');
    await db.pool.query(`UPDATE portal.documents SET updated_at=now(), title='Touched' WHERE id=$1`, [p1.body[19].id]);                       // an already-seen document is edited and jumps to the top
    const rest = []; let c = cursor; while (c) { const r = await b.cl.get(`/api/v1/documents?view=recent&limit=20&cursor=${c}`); rest.push(...r.body); c = r.headers.get('x-next-cursor'); }
    const all = [...p1.body, ...rest].map((d) => d.id); assert.equal(new Set(all).size, all.length, 'no duplicates'); assert.equal(all.length, 60);
  });
  test('search is paged the same way', async () => {
    const b = await newBusiness(); await seed(b.w, b.u.sub, 130, { title: () => 'Quarterly report ' }); await seed(b.w, b.u.sub, 20, { title: () => 'Unrelated memo ' });
    const { rows, pages } = await walk(b.cl, 'view=recent&limit=50&q=quarterly'); assert.equal(rows.length, 130); assert.equal(pages, 3); assert.ok(rows.every((r) => /Quarterly/.test(r.title)));
  });
  test('views and filters page correctly: mine, trash, kind', async () => {
    const b = await newBusiness(); await seed(b.w, b.u.sub, 70); await seed(b.w, b.u.sub, 45, { deleted: true }); await seed(b.w, b.u.sub, 30, { kind: 'sheet' });
    assert.equal((await walk(b.cl, 'view=mine&limit=40')).rows.length, 100); assert.equal((await walk(b.cl, 'view=trash&limit=40')).rows.length, 45); assert.equal((await walk(b.cl, 'view=recent&kind=sheet&limit=10')).rows.length, 30);
  });
  test('a cursor carries a position and nothing else: another person following it sees only what they may read', async () => {
    await seed(W, H.sub, 60, { title: () => 'Host private ' }); const p1 = await host().get('/api/v1/documents?view=recent&limit=10'); const cursor = p1.headers.get('x-next-cursor'); assert.ok(cursor);
    const mine = await walk(member(), `view=recent&limit=10&cursor=${cursor}`); assert.equal(mine.rows.length, 0, 'the host\'s private documents are not revealed by their cursor');
    assert.equal((await member().get('/api/v1/documents?view=recent&limit=10')).body.length, 0);
  });
  test('bad paging input is a 400, never a silent default or a crash', async () => {
    for (const qs of ['limit=0', 'limit=201', 'limit=abc', 'limit=-5', 'limit=1.5', 'cursor=!!!', 'cursor=' + 'a'.repeat(201), 'cursor=' + Buffer.from('["not a date","x"]').toString('base64url'), 'cursor=' + Buffer.from('["2026-01-01T00:00:00.000000Z","not-a-uuid"]').toString('base64url'), 'cursor=' + Buffer.from('{"a":1}').toString('base64url')])
      assert.equal((await host().get('/api/v1/documents?view=recent&' + qs)).status, 400, qs);
    assert.equal((await host().get('/api/v1/documents?limit=1')).status, 200, 'limit alone selects the paged API');
    assert.equal((await host().get('/api/v1/documents?limit=1')).body.length, 1);
  });
  test('the last page has no cursor; an exact multiple of the page size does not invent an empty extra page', async () => {
    const b = await newBusiness(); await seed(b.w, b.u.sub, 40); const p = await walk(b.cl, 'view=recent&limit=20'); assert.equal(p.rows.length, 40); assert.equal(p.pages, 2);
    assert.equal((await b.cl.get('/api/v1/documents?view=recent&limit=40')).headers.get('x-next-cursor'), null);
  });
});

describe('abuse controls: per-person rate limits, a per-document comment cap and a folder cap', () => {
  let db, main, app, lowApp, W;
  const q = async (sql, args = []) => (await db.pool.query(sql, args)).rows;
  const person = async (appx, plan = 'pro') => { const u = await main.mint(); const w = await seedWorkspace(db.pool, u.sub, 'Abuse ' + crypto.randomBytes(3).toString('hex')); await db.pool.query(`UPDATE portal.subscriptions SET plan_slug=$2,status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [w, plan]); const d = (await db.pool.query(`INSERT INTO portal.documents(workspace_id,owner_id,kind,title,current_version,search_text) VALUES($1,$2,'doc','Seed',1,'') RETURNING id`, [w, u.sub])).rows[0].id; await db.pool.query(`INSERT INTO portal.document_versions(document_id,version_no,content,created_by) VALUES($1,1,$2,$3)`, [d, JSON.stringify({ format: 'markdown', text: 'x' }), u.sub]); return { u, w, d, cl: appx.client(u) }; };

  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn();
    app = await startApp({ pool: db.pool, cfg: testConfig({}, main), jwks: main.jwks });                                                          // normal (very high) limits: caps are tested here
    lowApp = await startApp({ pool: db.pool, cfg: testConfig({ cfg: { rateLimits: { docsWrite: 5, docsComment: 3 } } }, main), jwks: main.jwks });   // tiny limits: the limiters are tested here
  });
  after(async () => { await app?.close(); await lowApp?.close(); await main?.close(); await db?.drop(); });

  test('comments: the 4th comment in a minute is refused with 429 for that person only, and nothing is stored for the refused call', async () => {
    const a = await person(lowApp); const b = await person(lowApp);
    for (let i = 0; i < 3; i++) assert.equal((await a.cl.post(`/api/v1/documents/${a.d}/comments`, { body: 'c' + i })).status, 201);
    const r = await a.cl.post(`/api/v1/documents/${a.d}/comments`, { body: 'too many' }); assert.equal(r.status, 429); assert.equal(r.body.code, 'rate_limited');
    assert.equal(Number((await q('SELECT count(*) FROM portal.doc_comments WHERE document_id=$1', [a.d]))[0].count), 3, 'the refused comment was not stored');
    assert.equal((await b.cl.post(`/api/v1/documents/${b.d}/comments`, { body: 'unaffected' })).status, 201, 'another person is not affected');
    assert.equal((await a.cl.get(`/api/v1/documents/${a.d}/comments`)).status, 200, 'reading is never rate limited');
  });
  test('resolving counts with commenting (one budget), so a script cannot spin on either', async () => {
    const a = await person(lowApp); const c = (await a.cl.post(`/api/v1/documents/${a.d}/comments`, { body: 'one' })).body; await a.cl.post(`/api/v1/documents/${a.d}/comments/${c.id}/resolve`, {}); await a.cl.post(`/api/v1/documents/${a.d}/comments`, { body: 'two' });
    assert.equal((await a.cl.post(`/api/v1/documents/${a.d}/comments`, { body: 'three' })).status, 429);
  });
  test('document and folder changes: the 6th write in a minute is 429; reads, search and export keep working; the refused change did not happen', async () => {
    const a = await person(lowApp);
    for (let i = 0; i < 5; i++) assert.equal((await a.cl.post('/api/v1/document-folders', { name: 'F' + i })).status, 201);
    assert.equal((await a.cl.post('/api/v1/document-folders', { name: 'F5' })).status, 429);
    assert.equal(Number((await q('SELECT count(*) FROM portal.doc_folders WHERE workspace_id=$1', [a.w]))[0].count), 5);
    for (const [m, p, b] of [['patch', `/api/v1/documents/${a.d}`, { title: 'x' }], ['post', `/api/v1/documents/${a.d}/duplicate`, {}], ['post', `/api/v1/documents/${a.d}/move`, { folder_id: null }], ['put', `/api/v1/documents/${a.d}`, { base_version: 1, content: { format: 'markdown', text: 'y' } }], ['post', '/api/v1/documents', { kind: 'doc', title: 'n' }]])
      assert.equal((await a.cl[m](p, b)).status, 429, m + ' ' + p);
    assert.equal((await a.cl.get('/api/v1/documents?view=recent')).status, 200); assert.equal((await a.cl.get(`/api/v1/documents/${a.d}`)).status, 200); assert.equal((await a.cl.get(`/api/v1/documents/${a.d}/export.txt`)).status, 200); assert.equal((await a.cl.get('/api/v1/search?q=seed')).status, 200);
    assert.equal((await q('SELECT title FROM portal.documents WHERE id=$1', [a.d]))[0].title, 'Seed', 'the refused rename did not happen');
  });
  test('the limits are per person, not per workspace or per IP: a colleague in the same workspace keeps their own budget', async () => {
    const a = await person(lowApp); const mate = await main.mint(); await addMember(db.pool, a.w, mate.sub, 'member'); const mc = lowApp.client(mate);
    for (let i = 0; i < 5; i++) await a.cl.post('/api/v1/document-folders', { name: 'G' + i }); assert.equal((await a.cl.post('/api/v1/document-folders', { name: 'G5' })).status, 429);
    assert.equal((await mc.post('/api/v1/document-folders', { name: 'Mine' })).status, 201);
  });
  test('a document holds at most 500 comments (open and resolved together); the 501st is a clear 409 and other documents are unaffected', async () => {
    const a = await person(app); await db.pool.query(`INSERT INTO portal.doc_comments(document_id,workspace_id,author_id,body) SELECT $1,$2,$3,'seed '||g FROM generate_series(1,500) g`, [a.d, a.w, a.u.sub]);
    const r = await a.cl.post(`/api/v1/documents/${a.d}/comments`, { body: 'one too many' }); assert.equal(r.status, 409); assert.equal(r.body.code, 'comment_limit');
    const other = (await a.cl.post('/api/v1/documents', { kind: 'doc', title: 'Other' })).body; assert.equal((await a.cl.post(`/api/v1/documents/${other.id}/comments`, { body: 'fine' })).status, 201);
    assert.equal(Number((await q('SELECT count(*) FROM portal.doc_comments WHERE document_id=$1', [a.d]))[0].count), 500);
  });
  test('a person has at most 200 folders; the 201st is a 409 and deleting one makes room', async () => {
    const a = await person(app); await db.pool.query(`INSERT INTO portal.doc_folders(workspace_id,owner_id,name) SELECT $1,$2,'Folder '||g FROM generate_series(1,200) g`, [a.w, a.u.sub]);
    const r = await a.cl.post('/api/v1/document-folders', { name: 'one more' }); assert.equal(r.status, 409); assert.equal(r.body.code, 'folder_limit');
    const first = (await a.cl.get('/api/v1/document-folders')).body[0]; assert.equal((await a.cl.del(`/api/v1/document-folders/${first.id}`)).status, 204); assert.equal((await a.cl.post('/api/v1/document-folders', { name: 'one more' })).status, 201);
  });
});

describe('subscription status: Docs follows the portal\'s effective plan on every route, and recovers the moment a subscription is healthy again', () => {
  let db, main, app;
  const q = async (sql, args = []) => (await db.pool.query(sql, args)).rows;
  /** A workspace on `plan` with `n` live documents, whose subscription is then put into `state` (SQL fragment for status and period end). */
  async function ws(plan, n, state) {
    const u = await main.mint(); const w = await seedWorkspace(db.pool, u.sub, 'Status ' + crypto.randomBytes(3).toString('hex'));
    await db.pool.query(`UPDATE portal.subscriptions SET plan_slug=$2 WHERE workspace_id=$1`, [w, plan]); const set = async (s) => db.pool.query(`UPDATE portal.subscriptions SET ${s} WHERE workspace_id=$1`, [w]);
    await db.pool.query(`INSERT INTO portal.documents(workspace_id,owner_id,kind,title,current_version,search_text) SELECT $1,$2,'doc','D'||g,1,'' FROM generate_series(1,$3) g`, [w, u.sub, n]);
    const first = (await q('SELECT id FROM portal.documents WHERE workspace_id=$1 ORDER BY title LIMIT 1', [w]))[0].id; await db.pool.query(`INSERT INTO portal.document_versions(document_id,version_no,content,created_by) VALUES($1,1,$2,$3)`, [first, JSON.stringify({ format: 'markdown', text: 'kept' }), u.sub]);
    await set(state); return { u, w, first, cl: app.client(u), set };
  }
  const ACTIVE = "status='active', current_period_end=now()+interval '20 days'";
  before(async () => { db = await freshDatabase(); main = await startMainStandIn(); app = await startApp({ pool: db.pool, cfg: testConfig({}, main), jwks: main.jwks }); });
  after(async () => { await app?.close(); await main?.close(); await db?.drop(); });

  for (const [label, state, expectPro] of [
    ['active and in period', ACTIVE, true],
    ['trialing', "status='trialing', current_period_end=now()+interval '5 days'", true],
    ['past due, still inside the 7-day grace', "status='past_due', current_period_end=now()-interval '3 days'", true],
    ['active but the period ended more than 2 days ago', "status='active', current_period_end=now()-interval '3 days'", false],
    ['past due beyond the 7-day grace', "status='past_due', current_period_end=now()-interval '9 days'", false],
    ['canceled', "status='canceled', current_period_end=now()+interval '20 days'", false],
    ['expired', "status='expired', current_period_end=now()+interval '20 days'", false],
    ['incomplete (never paid)', "status='incomplete', current_period_end=now()+interval '20 days'", false]]) {
    test(`Pro workspace, ${label}: ${expectPro ? 'keeps Pro limits' : 'is limited as Basic (5 documents) on create, duplicate and restore, but nothing existing is lost or locked'}`, async () => {
      const a = await ws('pro', 8, state);                                   // 8 live documents: over Basic's 5, far under Pro's 500
      const gone = (await a.cl.post('/api/v1/documents', { kind: 'doc', title: 'to trash' })); if (expectPro) { assert.equal(gone.status, 201); await a.cl.del(`/api/v1/documents/${gone.body.id}`); }
      const attempts = [await a.cl.post('/api/v1/documents', { kind: 'doc', title: 'new' }), await a.cl.post(`/api/v1/documents/${a.first}/duplicate`, {})];
      if (expectPro) assert.ok(attempts.every((r) => r.status === 201), attempts.map((r) => r.status).join());
      else { assert.ok(attempts.every((r) => r.status === 402 && r.body.code === 'plan_limit' && r.body.plan === 'basic'), JSON.stringify(attempts.map((r) => [r.status, r.body.plan]))); const t = (await a.cl.post(`/api/v1/documents/${a.first}/duplicate`, {})); assert.equal(t.status, 402); }
      // existing documents are never locked or removed by a plan change
      assert.equal((await a.cl.get(`/api/v1/documents/${a.first}`)).body.content.text, 'kept'); assert.equal((await a.cl.put(`/api/v1/documents/${a.first}`, { base_version: 1, content: { format: 'markdown', text: 'still editable' } })).status, 200);
      assert.equal((await a.cl.get(`/api/v1/documents/${a.first}/export.md`)).status, 200); assert.ok(Number((await q('SELECT count(*) FROM portal.documents WHERE workspace_id=$1 AND deleted_at IS NULL', [a.w]))[0].count) >= 8);
    });
  }
  test('restore from the trash and a healthy subscription: the limit lifts at once when the subscription is active again (no cached plan)', async () => {
    const a = await ws('pro', 8, "status='canceled'"); const d = (await q('SELECT id FROM portal.documents WHERE workspace_id=$1 ORDER BY title DESC LIMIT 1', [a.w]))[0].id;
    assert.equal((await a.cl.del(`/api/v1/documents/${d}`)).status, 204); assert.equal((await a.cl.post(`/api/v1/documents/${d}/undelete`, {})).status, 402, 'canceled: 7 live >= 5, restore refused');
    await a.set(ACTIVE); assert.equal((await a.cl.post(`/api/v1/documents/${d}/undelete`, {})).status, 200, 'active again: restore works on the very next request'); assert.equal((await a.cl.post('/api/v1/documents', { kind: 'doc', title: 'back to Pro' })).status, 201);
    await a.set("status='canceled'"); assert.equal((await a.cl.post('/api/v1/documents', { kind: 'doc', title: 'and down again' })).status, 402, 'and the next request after a cancellation is limited again');
  });
  test('Enterprise and Business follow the same rule: a cancelled Business workspace over 5 documents cannot add more; a healthy Enterprise one is unlimited', async () => {
    const b = await ws('business', 6, "status='canceled'"); assert.equal((await b.cl.post('/api/v1/documents', { kind: 'doc', title: 'x' })).status, 402);
    const e = await ws('enterprise', 30, ACTIVE); const rows = await Promise.all(Array.from({ length: 10 }, (_, i) => e.cl.post('/api/v1/documents', { kind: 'doc', title: 'E' + i }))); assert.ok(rows.every((r) => r.status === 201));
  });
  test('comments are a Basic-and-up feature row: a cancelled paid workspace still gets the Basic entitlement, and removing the Basic row refuses everyone on it (fails closed)', async () => {
    const a = await ws('pro', 2, "status='canceled'"); assert.equal((await a.cl.post(`/api/v1/documents/${a.first}/comments`, { body: 'basic still comments' })).status, 201);
    await q(`DELETE FROM portal.entitlements WHERE plan_slug='basic' AND feature='documents.comments'`);
    try { const r = await a.cl.post(`/api/v1/documents/${a.first}/comments`, { body: 'refused' }); assert.equal(r.status, 403); assert.equal(r.body.code, 'entitlement_required'); }
    finally { await q(`INSERT INTO portal.entitlements(plan_slug,feature,quota,description) VALUES('basic','documents.comments',NULL,'Document comments') ON CONFLICT DO NOTHING`); }
  });
});
