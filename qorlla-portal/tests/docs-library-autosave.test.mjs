// Docs library sorting and server-side autosave. Real PostgreSQL, real permission checks.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, addMember } from './helpers.mjs';

describe('library sorting: server-side, stable, paged, and tied to its own cursor', () => {
  let db, main, app, H, W;
  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn(); app = await startApp({ pool: db.pool, cfg: testConfig({}, main), jwks: main.jwks });
    H = await main.mint(); W = await seedWorkspace(db.pool, H.sub, 'Sort Co'); await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='business',status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [W]);
    const titles = ['banana', 'Apple', 'cherry', 'apple pie', 'Date', 'elder', 'fig', 'Grape', 'honey', 'iris', 'Jam', 'kiwi'];
    for (const [i, t] of titles.entries()) await db.pool.query(`INSERT INTO portal.documents(workspace_id,owner_id,kind,title,current_version,search_text,created_at,updated_at) VALUES($1,$2,'doc',$3,1,'',now() - ($4 * interval '1 hour'), now() - ($5 * interval '1 hour'))`, [W, H.sub, t, i, titles.length - i]);
  });
  after(async () => { await app?.close(); await main?.close(); await db?.drop(); });
  const walk = async (qs) => { const rows = []; let cursor = null; let pages = 0; do { const r = await app.client(H).get(`/api/v1/documents?${qs}${cursor ? '&cursor=' + cursor : ''}`); assert.equal(r.status, 200, JSON.stringify(r.body)); pages++; rows.push(...r.body); cursor = r.headers.get('x-next-cursor'); assert.ok(pages < 20); } while (cursor); return { rows, pages }; };

  test('title A to Z, case-insensitive, across pages: every document once', async () => {
    const { rows, pages } = await walk('view=recent&sort=title&dir=asc&limit=5'); assert.equal(rows.length, 12); assert.ok(pages >= 3);
    assert.deepEqual(rows.map((r) => r.title.toLowerCase()), rows.map((r) => r.title.toLowerCase()).slice().sort());
    assert.equal(new Set(rows.map((r) => r.id)).size, 12);
  });
  test('title Z to A, and created oldest/newest first', async () => {
    const z = await walk('view=recent&sort=title&dir=desc&limit=5'); assert.deepEqual(z.rows.map((r) => r.title.toLowerCase()), z.rows.map((r) => r.title.toLowerCase()).slice().sort().reverse());
    const c = await walk('view=recent&sort=created&dir=asc&limit=4'); for (let i = 1; i < c.rows.length; i++) assert.ok(c.rows[i - 1].created_at <= c.rows[i].created_at);
    const n = await walk('view=recent&sort=created&dir=desc&limit=4'); for (let i = 1; i < n.rows.length; i++) assert.ok(n.rows[i - 1].created_at >= n.rows[i].created_at); assert.equal(n.rows.length, 12);
  });
  test('titles that are equal are neither skipped nor repeated (the id breaks the tie)', async () => {
    for (let i = 0; i < 30; i++) await db.pool.query(`INSERT INTO portal.documents(workspace_id,owner_id,kind,title,current_version,search_text) VALUES($1,$2,'doc','Same name',1,'')`, [W, H.sub]);
    const { rows } = await walk('view=recent&sort=title&dir=asc&limit=7'); assert.equal(rows.length, 42); assert.equal(new Set(rows.map((r) => r.id)).size, 42);
  });
  test('a cursor from one ordering is refused under another (400), and a bad sort or direction is a 400', async () => {
    const r = await app.client(H).get('/api/v1/documents?view=recent&sort=title&dir=asc&limit=3'); const cur = r.headers.get('x-next-cursor'); assert.ok(cur);
    assert.equal((await app.client(H).get(`/api/v1/documents?view=recent&sort=title&dir=desc&limit=3&cursor=${cur}`)).status, 400);
    assert.equal((await app.client(H).get(`/api/v1/documents?view=recent&sort=created&limit=3&cursor=${cur}`)).status, 400);
    assert.equal((await app.client(H).get('/api/v1/documents?view=recent&sort=password')).status, 400);
    assert.equal((await app.client(H).get('/api/v1/documents?view=recent&dir=sideways')).status, 400);
  });
  test('each row says how many people it is shared with, so the list can show real sharing status', async () => {
    const M = await main.mint(); await addMember(db.pool, W, M.sub, 'member');
    const d = (await app.client(H).post('/api/v1/documents', { kind: 'doc', title: 'Shared one' })).body;
    assert.equal((await app.client(H).put(`/api/v1/documents/${d.id}/permissions`, { general_access: 'restricted', users: [{ user_id: M.sub, role: 'viewer' }] })).status, 200);
    const rows = (await app.client(H).get('/api/v1/documents?view=mine&limit=200')).body; assert.equal(rows.find((r) => r.id === d.id).shared_count, 1); assert.equal(rows.find((r) => r.title === 'Banana'.toLowerCase())?.shared_count ?? 0, 0);
  });
});

describe('autosave: debounced saves fold into one "Autosave" version and never rewrite anyone else\'s version', () => {
  let db, main, app, H, M, W, doc;
  const host = () => app.client(H); const ed = () => app.client(M);
  const versions = async () => (await db.pool.query('SELECT version_no, source, note, content FROM portal.document_versions WHERE document_id=$1 ORDER BY version_no', [doc])).rows;
  const put = (cl, base, text, extra = {}) => cl.put(`/api/v1/documents/${doc}`, { base_version: base, content: { format: 'markdown', text }, ...extra });
  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn(); app = await startApp({ pool: db.pool, cfg: testConfig({}, main), jwks: main.jwks });
    H = await main.mint(); M = await main.mint(); W = await seedWorkspace(db.pool, H.sub, 'Auto Co'); await addMember(db.pool, W, M.sub, 'member');
    doc = (await host().post('/api/v1/documents', { kind: 'doc', title: 'Autosaved' })).body.id;
    await host().put(`/api/v1/documents/${doc}/permissions`, { general_access: 'restricted', users: [{ user_id: M.sub, role: 'editor' }] });
  });
  after(async () => { await app?.close(); await main?.close(); await db?.drop(); });

  test('the first autosave starts an "Autosave" version (the original is never rewritten); the next ones fold into it', async () => {
    let r = await put(host(), 1, 'one', { autosave: true }); assert.equal(r.status, 200); assert.equal(r.body.current_version, 2);
    r = await put(host(), 2, 'one two', { autosave: true }); assert.equal(r.body.current_version, 2, 'folded into the same version');
    r = await put(host(), 2, 'one two three', { autosave: true }); assert.equal(r.body.current_version, 2);
    const v = await versions(); assert.equal(v.length, 2); assert.equal(v[0].content.text, ''); assert.equal(v[1].note, 'Autosave'); assert.equal(v[1].content.text, 'one two three');
    const got = (await host().get(`/api/v1/documents/${doc}`)).body; assert.equal(got.content.text, 'one two three'); assert.equal(got.current_version, 2);
  });
  test('a manual Save is always a new, unlabelled version, and the autosave after it starts its own entry', async () => {
    let r = await put(host(), 2, 'manual save'); assert.equal(r.body.current_version, 3);
    r = await put(host(), 3, 'manual save + more', { autosave: true }); assert.equal(r.body.current_version, 4);
    const v = await versions(); assert.equal(v[2].note, null); assert.equal(v[2].content.text, 'manual save', 'the manual version is untouched'); assert.equal(v[3].note, 'Autosave');
  });
  test('an autosave never rewrites ANOTHER person\'s autosave: a colleague\'s autosave starts a new version', async () => {
    const r = await put(ed(), 4, 'colleague text', { autosave: true }); assert.equal(r.status, 200); assert.equal(r.body.current_version, 5);
    const v = await versions(); assert.equal(v[3].content.text, 'manual save + more', 'the first person\'s autosave is intact'); assert.equal(v[4].content.text, 'colleague text');
  });
  test('an autosave older than ten minutes is not rewritten either', async () => {
    await db.pool.query(`UPDATE portal.document_versions SET created_at = now() - interval '11 minutes' WHERE document_id=$1 AND version_no=5`, [doc]);
    const r = await put(ed(), 5, 'later', { autosave: true }); assert.equal(r.body.current_version, 6);
  });
  test('conflicts are detected for autosave exactly like a manual save (409, nothing written), and a viewer cannot autosave (403)', async () => {
    const before = await versions();
    const r = await put(host(), 2, 'stale text', { autosave: true }); assert.equal(r.status, 409); assert.equal(r.body.code, 'version_conflict'); assert.equal(r.body.current_version, 6);
    assert.deepEqual(await versions(), before);
    await host().put(`/api/v1/documents/${doc}/permissions`, { general_access: 'restricted', users: [{ user_id: M.sub, role: 'viewer' }] });
    const v = await put(ed(), 6, 'sneaky', { autosave: true }); assert.equal(v.status, 403); assert.deepEqual(await versions(), before);
  });
  test('autosave keeps the search text and the title current, and the version history lists it as an autosave', async () => {
    const r = await put(host(), 6, 'findable pelican words', { autosave: true, title: 'Renamed by autosave' }); assert.equal(r.status, 200);
    const list = (await host().get('/api/v1/documents?view=mine&q=pelican')).body; assert.ok(list.some((d) => d.id === doc && d.title === 'Renamed by autosave'));
    const hist = (await host().get(`/api/v1/documents/${doc}/versions`)).body; assert.ok(JSON.stringify(hist).includes('Autosave'));
  });
});
