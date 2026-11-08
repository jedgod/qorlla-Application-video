// Qorlla Docs extension (server/docs-extension.mjs + sql/015): views, stars, templates, folders, duplicate, trash, comments, export.
// Real PostgreSQL, real permission checks. The point of these tests is what must NOT happen: another person's documents, folders, stars and trash
// staying invisible, the plan's document limit holding under concurrency, and the old documents API keeping its shape.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, addMember } from './helpers.mjs';

const rid = () => crypto.randomUUID();

describe('Docs extension (API against PostgreSQL)', () => {
  let db, main, app, W, H, A, M, N, O, W2;
  const host = () => app.client(H); const admin = () => app.client(A); const member = () => app.client(M); const other = () => app.client(N); const outsider = () => app.client(O);
  const q = async (sql, args = []) => (await db.pool.query(sql, args)).rows;
  const mk = async (cl, title = 'Doc ' + rid().slice(0, 6), kind = 'doc') => (await cl.post('/api/v1/documents', { kind, title })).body;
  const ids = (r) => r.body.map((d) => d.id);
  const share = (cl, id, general_access, users = []) => cl.put(`/api/v1/documents/${id}/permissions`, { general_access, users });
  const newWorkspace = async (plan = 'basic') => { const u = await main.mint(); const w = await seedWorkspace(db.pool, u.sub, 'Docs ' + rid().slice(0, 6)); if (plan !== 'basic') await db.pool.query(`UPDATE portal.subscriptions SET plan_slug=$2,status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [w, plan]); return { u, w, cl: app.client(u) }; };

  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn();
    app = await startApp({ pool: db.pool, cfg: testConfig({}, main), jwks: main.jwks });
    H = await main.mint(); A = await main.mint(); M = await main.mint(); N = await main.mint(); O = await main.mint();
    W = await seedWorkspace(db.pool, H.sub, 'Docs Co');
    await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='pro',status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [W]);
    await addMember(db.pool, W, A.sub, 'admin'); await addMember(db.pool, W, M.sub, 'member'); await addMember(db.pool, W, N.sub, 'member');
    W2 = await seedWorkspace(db.pool, O.sub, 'Elsewhere');
  });
  after(async () => { await app?.close(); await main?.close(); await db?.drop(); });

  describe('the old list route keeps its shape; views are opt-in', () => {
    test('GET /documents without a view is still a plain array with the old fields; with ?view= it adds the new fields', async () => {
      const d = await mk(host(), 'Shape check');
      const old = await host().get('/api/v1/documents'); assert.equal(old.status, 200); assert.ok(Array.isArray(old.body));
      const row = old.body.find((x) => x.id === d.id); assert.deepEqual(Object.keys(row).sort(), ['created_at', 'current_version', 'general_access', 'id', 'kind', 'my_role', 'owner_id', 'title', 'updated_at']);
      const v = await host().get('/api/v1/documents?view=recent'); const r2 = v.body.find((x) => x.id === d.id);
      assert.equal(r2.starred, false); assert.equal(r2.template, false); assert.equal(r2.folder_id, null); assert.equal(r2.my_role, 'owner');
    });
    test('an unknown view, a bad folder id and a bad kind are 400, not a silent empty list', async () => {
      for (const qs of ['view=everything', 'folder=not-a-uuid', 'view=recent&kind=pdf']) assert.equal((await host().get('/api/v1/documents?' + qs)).status, 400, qs);
    });
    test('signed out is 401 on every new route', async () => {
      const anon = app.client(null); const id = rid();
      for (const [m, p] of [['get', '/api/v1/documents?view=trash'], ['get', `/api/v1/documents/${id}/meta`], ['get', `/api/v1/documents/${id}/comments`], ['get', `/api/v1/documents/${id}/export.txt`], ['get', '/api/v1/document-folders']]) assert.equal((await anon[m](p)).status, 401, p);
    });
  });

  describe('views, stars and templates', () => {
    test('mine / shared / starred / templates / recent contain exactly the right documents', async () => {
      const mine = await mk(member(), 'M mine'); const sharedToM = await mk(host(), 'H shared with workspace'); await share(host(), sharedToM.id, 'workspace_view');
      const hidden = await mk(host(), 'H private');
      assert.ok(ids(await member().get('/api/v1/documents?view=mine')).includes(mine.id)); assert.ok(!ids(await member().get('/api/v1/documents?view=mine')).includes(sharedToM.id));
      const shared = ids(await member().get('/api/v1/documents?view=shared')); assert.ok(shared.includes(sharedToM.id)); assert.ok(!shared.includes(mine.id)); assert.ok(!shared.includes(hidden.id));
      const recent = ids(await member().get('/api/v1/documents?view=recent')); assert.ok(recent.includes(mine.id) && recent.includes(sharedToM.id)); assert.ok(!recent.includes(hidden.id), 'an unshared document of someone else never appears, not even to the person next to the owner');
      assert.equal((await member().patch(`/api/v1/documents/${sharedToM.id}`, { starred: true })).status, 200);
      assert.deepEqual(ids(await member().get('/api/v1/documents?view=starred')), [sharedToM.id]);
      assert.deepEqual(ids(await host().get('/api/v1/documents?view=starred')).filter((x) => x === sharedToM.id), [], 'a star is personal: the owner does not see M\'s star');
      assert.equal((await member().patch(`/api/v1/documents/${sharedToM.id}`, { starred: false })).status, 200); assert.deepEqual(ids(await member().get('/api/v1/documents?view=starred')), []);
      assert.equal((await host().patch(`/api/v1/documents/${hidden.id}`, { template: true })).status, 200); assert.deepEqual(ids(await host().get('/api/v1/documents?view=templates')), [hidden.id]);
      assert.deepEqual(ids(await member().get('/api/v1/documents?view=templates')), [], 'a private template is not listed for others');
    });
    test('search narrows a view; the kind filter works with views', async () => {
      const a = await mk(host(), 'Quarterly pelican plan'); await mk(host(), 'Unrelated giraffe', 'sheet');
      assert.deepEqual(ids(await host().get('/api/v1/documents?view=recent&q=pelican')), [a.id]);
      assert.ok((await host().get('/api/v1/documents?view=recent&kind=sheet')).body.every((d) => d.kind === 'sheet'));
    });
    test('GET /documents/:id/meta reports my star, the template flag, my folder and open comments, and is a 404 for someone who cannot read it', async () => {
      const d = await mk(host(), 'Meta'); await host().patch(`/api/v1/documents/${d.id}`, { starred: true, template: true });
      const m = await host().get(`/api/v1/documents/${d.id}/meta`); assert.deepEqual(m.body, { starred: true, template: true, folder_id: null, open_comments: 0 });
      assert.equal((await other().get(`/api/v1/documents/${d.id}/meta`)).status, 404); assert.equal((await outsider().get(`/api/v1/documents/${d.id}/meta`)).status, 404);
    });
  });

  describe('rename, star and template: who may do what', () => {
    test('an editor can rename, a viewer cannot, a stranger gets 404, and the title change keeps the content and stays searchable', async () => {
      const d = await mk(host(), 'Before rename'); await host().put(`/api/v1/documents/${d.id}`, { base_version: 1, content: { format: 'markdown', text: 'body about walruses' } });
      await share(host(), d.id, 'restricted', [{ user_id: A.sub, role: 'editor' }, { user_id: N.sub, role: 'viewer' }]);
      assert.equal((await other().patch(`/api/v1/documents/${d.id}`, { title: 'viewer rename' })).body.code, 'read_only');
      assert.equal((await member().patch(`/api/v1/documents/${d.id}`, { title: 'stranger rename' })).status, 404);
      assert.equal((await admin().patch(`/api/v1/documents/${d.id}`, { title: 'Zebra crossing notes' })).status, 200);
      const now = (await host().get(`/api/v1/documents/${d.id}`)).body; assert.equal(now.title, 'Zebra crossing notes'); assert.equal(now.content.text, 'body about walruses'); assert.equal(now.current_version, 2, 'renaming is not a new version');
      assert.ok((await host().get('/api/v1/search?q=zebra')).body.some((x) => x.id === d.id), 'search follows the new title');
      assert.equal((await other().patch(`/api/v1/documents/${d.id}`, { starred: true })).status, 200, 'a viewer may star what they can read');
      assert.equal((await admin().patch(`/api/v1/documents/${d.id}`, { template: true })).body.code, 'owner_only');
    });
    test('bad bodies are 400: empty, unknown field, blank title, wrong type', async () => {
      const d = await mk(host());
      for (const b of [{}, { owner_id: rid() }, { title: '   ' }, { starred: 'yes' }, { title: 'x'.repeat(201) }]) assert.equal((await host().patch(`/api/v1/documents/${d.id}`, b)).status, 400, JSON.stringify(b).slice(0, 40));
    });
    test('a request without the CSRF token is refused', async () => {
      const d = await mk(host()); assert.equal((await host().patch(`/api/v1/documents/${d.id}`, { starred: true }, { 'x-csrf-token': 'wrong' })).status, 403);
    });
  });

  describe('duplicate', () => {
    test('a reader can copy; the copy is private, owned by the copier, and carries the content', async () => {
      const d = await mk(host(), 'Original'); await host().put(`/api/v1/documents/${d.id}`, { base_version: 1, content: { format: 'markdown', text: 'copy me' } }); await share(host(), d.id, 'workspace_view');
      const r = await member().post(`/api/v1/documents/${d.id}/duplicate`, {}); assert.equal(r.status, 201); assert.equal(r.body.title, 'Copy of Original'); assert.equal(r.body.owner_id, M.sub); assert.equal(r.body.general_access, 'restricted');
      assert.equal((await member().get(`/api/v1/documents/${r.body.id}`)).body.content.text, 'copy me'); assert.equal((await other().get(`/api/v1/documents/${r.body.id}`)).status, 404, 'the copy is not shared');
      assert.equal((await other().post(`/api/v1/documents/${rid()}/duplicate`, {})).status, 404);
    });
    test('someone who cannot read a document cannot copy it (404), including from another workspace', async () => {
      const d = await mk(host(), 'Secret'); assert.equal((await member().post(`/api/v1/documents/${d.id}/duplicate`, {})).status, 404); assert.equal((await outsider().post(`/api/v1/documents/${d.id}/duplicate`, {})).status, 404);
    });
    test('the plan limit holds when many copies race: 5 allowed, 4 in use, ten at once => exactly one succeeds', async () => {
      const b = await newWorkspace('basic'); const first = await mk(b.cl, 'Base'); for (let i = 0; i < 3; i++) await mk(b.cl);
      const rows = await Promise.all(Array.from({ length: 10 }, () => b.cl.post(`/api/v1/documents/${first.id}/duplicate`, {})));
      assert.equal(rows.filter((r) => r.status === 201).length, 1); assert.ok(rows.filter((r) => r.status !== 201).every((r) => r.status === 402 && r.body.code === 'plan_limit'));
      assert.equal(Number((await q('SELECT count(*) FROM portal.documents WHERE workspace_id=$1 AND deleted_at IS NULL', [b.w]))[0].count), 5);
    });
  });

  describe('trash and restore', () => {
    test('a deleted document leaves every list, shows in the owner\'s trash only, and comes back with its versions', async () => {
      const d = await mk(member(), 'Short lived'); await member().put(`/api/v1/documents/${d.id}`, { base_version: 1, content: { format: 'markdown', text: 'v2' } }); await share(member(), d.id, 'workspace_view');
      assert.equal((await member().del(`/api/v1/documents/${d.id}`)).status, 204);
      assert.ok(!ids(await member().get('/api/v1/documents?view=recent')).includes(d.id)); assert.equal((await member().get(`/api/v1/documents/${d.id}`)).status, 404);
      assert.ok(ids(await member().get('/api/v1/documents?view=trash')).includes(d.id)); assert.ok(!ids(await other().get('/api/v1/documents?view=trash')).includes(d.id), 'others never see your trash');
      assert.ok(!ids(await host().get('/api/v1/documents?view=trash')).includes(d.id), 'not even the workspace owner');
      assert.equal((await other().post(`/api/v1/documents/${d.id}/undelete`, {})).status, 404); assert.equal((await admin().post(`/api/v1/documents/${d.id}/undelete`, {})).status, 404, 'a workspace admin may delete but not restore other people\'s documents');
      assert.equal((await member().post(`/api/v1/documents/${d.id}/undelete`, {})).status, 200);
      const back = (await member().get(`/api/v1/documents/${d.id}`)).body; assert.equal(back.content.text, 'v2'); assert.equal(back.current_version, 2);
      assert.equal((await member().post(`/api/v1/documents/${d.id}/undelete`, {})).status, 404, 'restoring something that is not in the trash is a 404');
    });
    test('restoring is blocked at the plan limit and the document stays in the trash; a document from another workspace is a 404', async () => {
      const b = await newWorkspace('basic'); const gone = await mk(b.cl, 'Trashed'); await b.cl.del(`/api/v1/documents/${gone.id}`); for (let i = 0; i < 5; i++) await mk(b.cl);
      const r = await b.cl.post(`/api/v1/documents/${gone.id}/undelete`, {}); assert.equal(r.status, 402); assert.equal(r.body.code, 'plan_limit');
      assert.ok(ids(await b.cl.get('/api/v1/documents?view=trash')).includes(gone.id));
      assert.equal((await outsider().post(`/api/v1/documents/${gone.id}/undelete`, {})).status, 404);
    });
    test('restores racing at the limit cannot exceed it', async () => {
      const b = await newWorkspace('basic'); const trashed = []; for (let i = 0; i < 3; i++) { const d = await mk(b.cl); await b.cl.del(`/api/v1/documents/${d.id}`); trashed.push(d.id); }
      for (let i = 0; i < 3; i++) await mk(b.cl);
      const rows = await Promise.all(trashed.map((id) => b.cl.post(`/api/v1/documents/${id}/undelete`, {})));
      assert.equal(rows.filter((r) => r.status === 200).length, 2, 'room for exactly two more'); assert.equal(Number((await q('SELECT count(*) FROM portal.documents WHERE workspace_id=$1 AND deleted_at IS NULL', [b.w]))[0].count), 5);
    });
  });

  describe('folders', () => {
    test('create, rename, name clash, list with counts, delete unfiles the documents', async () => {
      const f = await member().post('/api/v1/document-folders', { name: 'Projects' }); assert.equal(f.status, 201);
      assert.equal((await member().post('/api/v1/document-folders', { name: '  projects ' })).body.code, 'name_taken', 'names clash regardless of case and spacing');
      assert.equal((await host().post('/api/v1/document-folders', { name: 'Projects' })).status, 201, 'another person may use the same name');
      const d = await mk(member(), 'Filed'); assert.equal((await member().post(`/api/v1/documents/${d.id}/move`, { folder_id: f.body.id })).status, 200);
      assert.deepEqual(ids(await member().get('/api/v1/documents?view=recent&folder=' + f.body.id)), [d.id]);
      assert.equal((await member().get('/api/v1/document-folders')).body.find((x) => x.id === f.body.id).documents, 1);
      assert.ok(!ids(await member().get('/api/v1/documents?view=recent&folder=none')).includes(d.id));
      assert.equal((await member().patch(`/api/v1/document-folders/${f.body.id}`, { name: 'Client work' })).status, 200);
      assert.equal((await member().del(`/api/v1/document-folders/${f.body.id}`)).status, 204);
      assert.ok(ids(await member().get('/api/v1/documents?view=recent&folder=none')).includes(d.id), 'the document is kept and unfiled'); assert.equal((await member().get(`/api/v1/documents/${d.id}`)).status, 200);
      assert.equal((await member().post('/api/v1/document-folders', { name: 'Projects' })).status, 201, 'a deleted folder\'s name can be reused');
    });
    test('folders are private: nobody else can list, rename, delete, file into or filter by them', async () => {
      const f = (await member().post('/api/v1/document-folders', { name: 'Private ' + rid().slice(0, 5) })).body; const theirs = await mk(host(), 'Host doc'); const mine = await mk(member(), 'My doc');
      assert.ok(!(await other().get('/api/v1/document-folders')).body.some((x) => x.id === f.id));
      assert.equal((await other().patch(`/api/v1/document-folders/${f.id}`, { name: 'x' })).status, 404); assert.equal((await other().del(`/api/v1/document-folders/${f.id}`)).status, 404); assert.equal((await outsider().del(`/api/v1/document-folders/${f.id}`)).status, 404);
      assert.equal((await host().post(`/api/v1/documents/${theirs.id}/move`, { folder_id: f.id })).status, 404, 'cannot file into someone else\'s folder');
      await share(member(), mine.id, 'workspace_edit'); assert.equal((await other().post(`/api/v1/documents/${mine.id}/move`, { folder_id: null })).body.code, 'owner_only', 'only the owner files a document');
      await member().post(`/api/v1/documents/${mine.id}/move`, { folder_id: f.id }); assert.deepEqual(ids(await other().get('/api/v1/documents?view=recent&folder=' + f.id)), [], 'the folder filter only ever shows the caller\'s own documents');
    });
    test('validation: blank and over-long names, unknown fields, bad ids', async () => {
      for (const b of [{ name: '   ' }, { name: 'x'.repeat(121) }, { name: 'ok', owner_id: rid() }, {}]) assert.equal((await member().post('/api/v1/document-folders', b)).status, 400);
      const d = await mk(member()); assert.equal((await member().post(`/api/v1/documents/${d.id}/move`, { folder_id: 'nope' })).status, 400); assert.equal((await member().post(`/api/v1/documents/${d.id}/move`, { folder_id: rid() })).status, 404);
      assert.equal((await member().del('/api/v1/document-folders/not-a-uuid')).status, 404);
    });
  });

  describe('comments', () => {
    test('editors comment and resolve; readers can read; viewers cannot write; strangers get 404', async () => {
      const d = await mk(host(), 'Reviewed'); await share(host(), d.id, 'restricted', [{ user_id: A.sub, role: 'editor' }, { user_id: N.sub, role: 'viewer' }]);
      const c = await admin().post(`/api/v1/documents/${d.id}/comments`, { body: '  Please check the numbers  ' }); assert.equal(c.status, 201); assert.equal(c.body.body, 'Please check the numbers'); assert.equal(c.body.author_id, A.sub);
      assert.equal((await other().post(`/api/v1/documents/${d.id}/comments`, { body: 'x' })).body.code, 'read_only'); assert.equal((await member().post(`/api/v1/documents/${d.id}/comments`, { body: 'x' })).status, 404);
      assert.equal((await other().get(`/api/v1/documents/${d.id}/comments`)).body.length, 1); assert.equal((await member().get(`/api/v1/documents/${d.id}/comments`)).status, 404);
      assert.equal((await host().get(`/api/v1/documents/${d.id}/meta`)).body.open_comments, 1);
      assert.equal((await other().post(`/api/v1/documents/${d.id}/comments/${c.body.id}/resolve`, {})).body.code, 'read_only');
      assert.equal((await host().post(`/api/v1/documents/${d.id}/comments/${c.body.id}/resolve`, {})).status, 200); assert.equal((await host().post(`/api/v1/documents/${d.id}/comments/${c.body.id}/resolve`, {})).status, 404, 'already resolved');
      assert.equal((await host().get(`/api/v1/documents/${d.id}/meta`)).body.open_comments, 0); assert.ok((await host().get(`/api/v1/documents/${d.id}/comments`)).body[0].resolved_at);
    });
    test('a comment id from another document cannot be resolved through this one; bad bodies are 400; a trashed document has no comments', async () => {
      const a = await mk(host(), 'A'); const b = await mk(host(), 'B'); const c = (await host().post(`/api/v1/documents/${a.id}/comments`, { body: 'on A' })).body;
      assert.equal((await host().post(`/api/v1/documents/${b.id}/comments/${c.id}/resolve`, {})).status, 404); assert.equal((await host().post(`/api/v1/documents/${b.id}/comments/zzz/resolve`, {})).status, 404);
      for (const body of [{ body: '' }, { body: ' ' }, { body: 'x'.repeat(4001) }, { body: 'ok', author_id: rid() }, {}]) assert.equal((await host().post(`/api/v1/documents/${a.id}/comments`, body)).status, 400);
      await host().del(`/api/v1/documents/${a.id}`); assert.equal((await host().get(`/api/v1/documents/${a.id}/comments`)).status, 404); assert.equal((await host().post(`/api/v1/documents/${a.id}/comments`, { body: 'late' })).status, 404);
    });
    test('comment text is stored and returned as plain data (no HTML is interpreted by the API)', async () => {
      const d = await mk(host()); const c = await host().post(`/api/v1/documents/${d.id}/comments`, { body: '<img src=x onerror=alert(1)>' }); assert.equal(c.body.body, '<img src=x onerror=alert(1)>');
      assert.match((await host().get(`/api/v1/documents/${d.id}/comments`)).headers.get('content-type'), /application\/json/);
    });
  });

  describe('export', () => {
    test('txt and md download with safe headers, from anyone who can read; strangers get 404', async () => {
      const d = await mk(host(), 'Plan "Q3"\r\nSet-Cookie: x=1'); await host().put(`/api/v1/documents/${d.id}`, { base_version: 1, content: { format: 'markdown', text: '# Heading\n\nSome **bold** text' } }); await share(host(), d.id, 'workspace_view');
      for (const [ext, type] of [['txt', 'text/plain'], ['md', 'text/markdown']]) {
        const r = await member().get(`/api/v1/documents/${d.id}/export.${ext}`); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), new RegExp(type)); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(r.body, '# Heading\n\nSome **bold** text'); const cd = r.headers.get('content-disposition'); assert.match(cd, new RegExp(`^attachment; filename="[A-Za-z0-9._-]+\\.${ext}"$`)); assert.ok(!/[\r\n]/.test(cd));
      }
      await share(host(), d.id, 'restricted'); assert.equal((await member().get(`/api/v1/documents/${d.id}/export.txt`)).status, 404); assert.equal((await outsider().get(`/api/v1/documents/${d.id}/export.txt`)).status, 404);
    });
    test('sheets and slides export as plain text; markdown export is for documents only', async () => {
      const s = await mk(host(), 'Stock', 'sheet'); await host().put(`/api/v1/documents/${s.id}`, { base_version: 1, content: { columns: ['Item', 'Qty'], rows: [['Giraffes', 12]] } });
      assert.match((await host().get(`/api/v1/documents/${s.id}/export.txt`)).body, /Giraffes 12/); assert.equal((await host().get(`/api/v1/documents/${s.id}/export.md`)).status, 400);
    });
  });

  describe('audit and tenant isolation', () => {
    test('every consequential action is audited with the actor and the document, and no document text is written to the audit log', async () => {
      const d = await mk(host(), 'Audited'); await host().put(`/api/v1/documents/${d.id}`, { base_version: 1, content: { format: 'markdown', text: 'SECRET-BODY-TEXT' } });
      await host().patch(`/api/v1/documents/${d.id}`, { title: 'Audited 2' }); await host().post(`/api/v1/documents/${d.id}/comments`, { body: 'SECRET-COMMENT-TEXT' });
      const dup = (await host().post(`/api/v1/documents/${d.id}/duplicate`, {})).body; await host().get(`/api/v1/documents/${d.id}/export.txt`); await host().del(`/api/v1/documents/${d.id}`); await host().post(`/api/v1/documents/${d.id}/undelete`, {});
      const rows = await q('SELECT action, actor_id, object_id FROM portal.audit_events WHERE workspace_id=$1 AND (object_id=$2 OR object_id=$3)', [W, d.id, dup.id]); const actions = rows.map((r) => r.action);
      for (const a of ['document.created', 'document.renamed', 'document.commented', 'document.duplicated', 'document.exported', 'document.deleted', 'document.undeleted']) assert.ok(actions.includes(a), a);
      assert.ok(rows.every((r) => r.actor_id === H.sub)); assert.ok(!JSON.stringify(await q('SELECT * FROM portal.audit_events WHERE workspace_id=$1', [W])).includes('SECRET'));
    });
    test('a person in another workspace cannot reach any of these routes for this workspace\'s ids', async () => {
      const d = await mk(host(), 'Tenant A'); const f = (await host().post('/api/v1/document-folders', { name: 'TenantFolder' })).body; const c = (await host().post(`/api/v1/documents/${d.id}/comments`, { body: 'hi' })).body;
      for (const [m, p, b] of [['get', `/api/v1/documents/${d.id}/meta`], ['patch', `/api/v1/documents/${d.id}`, { title: 'hijack' }], ['get', `/api/v1/documents/${d.id}/comments`], ['post', `/api/v1/documents/${d.id}/comments`, { body: 'x' }],
        ['post', `/api/v1/documents/${d.id}/comments/${c.id}/resolve`, {}], ['post', `/api/v1/documents/${d.id}/duplicate`, {}], ['post', `/api/v1/documents/${d.id}/move`, { folder_id: null }], ['get', `/api/v1/documents/${d.id}/export.txt`], ['get', `/api/v1/documents/${d.id}/export.md`], ['patch', `/api/v1/document-folders/${f.id}`, { name: 'x' }], ['del', `/api/v1/document-folders/${f.id}`]]) {
        const r = await outsider()[m](p, b); assert.equal(r.status, 404, m + ' ' + p);
      }
      assert.equal((await host().get(`/api/v1/documents/${d.id}`)).body.title, 'Tenant A');
      assert.ok(!ids(await outsider().get('/api/v1/documents?view=recent')).includes(d.id)); assert.equal((await q('SELECT count(*)::int n FROM portal.documents WHERE workspace_id=$1', [W2]))[0].n, 0);
    });
  });
  describe('plan limits: every way of adding a live document shares one workspace-locked check', () => {
    const seedDocs = (ws, owner, n, deleted = false) => n > 0 ? db.pool.query(`INSERT INTO portal.documents(workspace_id,owner_id,kind,title,current_version,search_text,deleted_at) SELECT $1,$2,'doc','Seed '||g,1,'',${deleted ? 'now()' : 'NULL'} FROM generate_series(1,$3) g`, [ws, owner, n]) : null;
    const live = async (ws) => Number((await q('SELECT count(*) FROM portal.documents WHERE workspace_id=$1 AND deleted_at IS NULL', [ws]))[0].count);
    for (const [plan, limit] of [['basic', 5], ['pro', 500], ['business', 5000], ['enterprise', null]]) {
      test(`${plan} (${limit ?? 'unlimited'}): twelve simultaneous creates, duplicates, template copies and restores ${limit === null ? 'all succeed' : 'fill exactly the three free places'}`, async () => {
        const { u, w, cl } = await newWorkspace(plan); const base = limit ?? 25;
        const src = await mk(cl, 'Template source'); await cl.patch(`/api/v1/documents/${src.id}`, { template: true });
        await seedDocs(w, u.sub, base - 1 - 3); await seedDocs(w, u.sub, 6, true);
        const trashed = (await q('SELECT id FROM portal.documents WHERE workspace_id=$1 AND deleted_at IS NOT NULL', [w])).map((r) => r.id);
        assert.equal(await live(w), base - 3);
        const ops = [...Array.from({ length: 4 }, (_, i) => cl.post('/api/v1/documents', { kind: 'doc', title: 'Race ' + i })), ...Array.from({ length: 4 }, () => cl.post(`/api/v1/documents/${src.id}/duplicate`, {})), ...trashed.slice(0, 4).map((id) => cl.post(`/api/v1/documents/${id}/undelete`, {}))];
        const rows = await Promise.all(ops); const ok = rows.filter((r) => [200, 201].includes(r.status)).length;
        assert.equal(ok, limit === null ? 12 : 3, rows.map((r) => r.status).join());
        assert.ok(rows.filter((r) => ![200, 201].includes(r.status)).every((r) => r.status === 402 && r.body.code === 'plan_limit'));
        if (limit !== null) assert.equal(await live(w), limit, 'never above the limit');
      });
    }
    test('a downgrade below current usage blocks every way of adding a document but never touches existing ones', async () => {
      const { w, cl } = await newWorkspace('pro'); const docs = []; for (let i = 0; i < 7; i++) docs.push(await mk(cl, 'Keep ' + i)); const gone = docs.pop(); await cl.del(`/api/v1/documents/${gone.id}`);
      await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='basic' WHERE workspace_id=$1`, [w]);                       // 6 live documents on a 5-document plan
      assert.equal((await cl.post('/api/v1/documents', { kind: 'doc', title: 'new' })).status, 402); assert.equal((await cl.post(`/api/v1/documents/${docs[0].id}/duplicate`, {})).status, 402); assert.equal((await cl.post(`/api/v1/documents/${gone.id}/undelete`, {})).status, 402);
      assert.equal((await cl.put(`/api/v1/documents/${docs[0].id}`, { base_version: 1, content: { format: 'markdown', text: 'still editable' } })).status, 200); assert.equal((await cl.get(`/api/v1/documents/${docs[1].id}`)).status, 200);
      assert.equal((await cl.del(`/api/v1/documents/${docs[1].id}`)).status, 204); assert.equal((await cl.del(`/api/v1/documents/${docs[2].id}`)).status, 204); await cl.del(`/api/v1/documents/${docs[3].id}`);   // 3 live now
      assert.equal((await cl.post(`/api/v1/documents/${gone.id}/undelete`, {})).status, 200, 'below the limit again, restoring works');
    });
  });

  describe('permission revocation takes effect on the very next request', () => {
    const edited = async (cl, id) => (await cl.put(`/api/v1/documents/${id}`, { base_version: (await cl.get(`/api/v1/documents/${id}`)).body.current_version, content: { format: 'markdown', text: 'x' + rid() } })).status;
    test('an editor who is removed from the document loses save, comment, export, restore, sharing and read at once', async () => {
      const d = await mk(host(), 'Revocable'); await share(host(), d.id, 'restricted', [{ user_id: N.sub, role: 'editor' }]);
      const c = (await other().post(`/api/v1/documents/${d.id}/comments`, { body: 'mine' })); assert.equal(c.status, 201); assert.equal(await edited(other(), d.id), 200); assert.equal((await other().get(`/api/v1/documents/${d.id}/export.txt`)).status, 200);
      await share(host(), d.id, 'restricted', []);
      const after = [await other().put(`/api/v1/documents/${d.id}`, { base_version: 2, content: { format: 'markdown', text: 'late' } }), await other().post(`/api/v1/documents/${d.id}/comments`, { body: 'late' }), await other().post(`/api/v1/documents/${d.id}/comments/${c.body.id}/resolve`, {}),
        await other().get(`/api/v1/documents/${d.id}/export.txt`), await other().get(`/api/v1/documents/${d.id}/export.md`), await other().post(`/api/v1/documents/${d.id}/restore`, { version_no: 1, base_version: 2 }), await other().get(`/api/v1/documents/${d.id}/versions`),
        await other().get(`/api/v1/documents/${d.id}/permissions`), await other().post(`/api/v1/documents/${d.id}/duplicate`, {}), await other().patch(`/api/v1/documents/${d.id}`, { title: 'late' }), await other().get(`/api/v1/documents/${d.id}`)];
      assert.ok(after.every((r) => r.status === 404), after.map((r) => r.status).join());
      assert.equal((await host().get(`/api/v1/documents/${d.id}`)).body.content.text.startsWith('x'), true, 'the owner\'s document is intact');
    });
    test('editor -> viewer is enforced at once on save, comment, resolve and restore, while reading and exporting continue', async () => {
      const d = await mk(host(), 'Demoted'); await share(host(), d.id, 'restricted', [{ user_id: A.sub, role: 'editor' }]); const c = (await admin().post(`/api/v1/documents/${d.id}/comments`, { body: 'c' })).body;
      await share(host(), d.id, 'restricted', [{ user_id: A.sub, role: 'viewer' }]);
      const after = [await admin().put(`/api/v1/documents/${d.id}`, { base_version: 1, content: { format: 'markdown', text: 'x' } }), await admin().post(`/api/v1/documents/${d.id}/comments`, { body: 'x' }), await admin().post(`/api/v1/documents/${d.id}/comments/${c.id}/resolve`, {}), await admin().post(`/api/v1/documents/${d.id}/restore`, { version_no: 1, base_version: 1 }), await admin().patch(`/api/v1/documents/${d.id}`, { title: 'x' })];
      assert.ok(after.every((r) => r.status === 403 && r.body.code === 'read_only'), after.map((r) => r.status + ':' + r.body.code).join());
      assert.equal((await admin().get(`/api/v1/documents/${d.id}`)).status, 200); assert.equal((await admin().get(`/api/v1/documents/${d.id}/export.txt`)).status, 200);
    });
    test('workspace-wide edit access is withdrawn the moment the owner restricts it', async () => {
      const d = await mk(host(), 'Wide'); await share(host(), d.id, 'workspace_edit'); assert.equal(await edited(member(), d.id), 200);
      await share(host(), d.id, 'workspace_view'); assert.equal(await edited(member(), d.id), 403); assert.equal((await member().get(`/api/v1/documents/${d.id}`)).status, 200);
      await share(host(), d.id, 'restricted'); assert.equal((await member().get(`/api/v1/documents/${d.id}`)).status, 404); assert.equal((await member().post(`/api/v1/documents/${d.id}/comments`, { body: 'x' })).status, 404);
    });
    test('workspace-wide access never reaches anyone who is not a current member: removed members and other workspaces lose everything at once', async () => {
      const gone = await main.mint(); await addMember(db.pool, W, gone.sub, 'member'); const gc = app.client(gone);
      const d = await mk(host(), 'For members only'); await share(host(), d.id, 'workspace_edit'); assert.equal((await gc.get(`/api/v1/documents/${d.id}`)).status, 200); assert.equal(await edited(gc, d.id), 200);
      await db.pool.query('DELETE FROM portal.members WHERE workspace_id=$1 AND user_id=$2', [W, gone.sub]);
      for (const [m, p, b] of [['get', `/api/v1/documents/${d.id}`], ['get', '/api/v1/documents?view=recent'], ['put', `/api/v1/documents/${d.id}`, { base_version: 1, content: { format: 'markdown', text: 'x' } }], ['post', `/api/v1/documents/${d.id}/comments`, { body: 'x' }], ['get', `/api/v1/documents/${d.id}/export.txt`], ['post', `/api/v1/documents/${d.id}/duplicate`, {}]]) {
        const r = await gc[m](p, b); assert.ok([403, 404].includes(r.status), `${m} ${p} -> ${r.status}`);
      }
      assert.equal((await outsider().get(`/api/v1/documents/${d.id}`)).status, 404);
    });
    test('a deleted document cannot be saved, commented on, exported or duplicated by anyone, the owner included, until it is restored from the trash', async () => {
      const d = await mk(host(), 'Binned'); await share(host(), d.id, 'workspace_edit'); await host().del(`/api/v1/documents/${d.id}`);
      for (const [m, p, b] of [['put', `/api/v1/documents/${d.id}`, { base_version: 1, content: { format: 'markdown', text: 'x' } }], ['post', `/api/v1/documents/${d.id}/comments`, { body: 'x' }], ['get', `/api/v1/documents/${d.id}/export.txt`], ['post', `/api/v1/documents/${d.id}/restore`, { version_no: 1, base_version: 1 }], ['post', `/api/v1/documents/${d.id}/duplicate`, {}]]) {
        assert.equal((await member()[m](p, b)).status, 404, 'member ' + p); assert.equal((await host()[m](p, b)).status, 404, 'even the owner, until restored: ' + p);
      }
    });
  });

  describe('comments are a plan feature enforced by the server', () => {
    const drop = () => q(`DELETE FROM portal.entitlements WHERE plan_slug='pro' AND feature='documents.comments'`);
    const put = () => q(`INSERT INTO portal.entitlements(plan_slug,feature,quota,description) VALUES('pro','documents.comments',NULL,'Document comments') ON CONFLICT DO NOTHING`);
    test('with no entitlement row the plan cannot add or resolve comments (403 entitlement_required) but existing comments stay readable; restoring the row restores the feature', async () => {
      const d = await mk(host(), 'Plan gated'); const c = (await host().post(`/api/v1/documents/${d.id}/comments`, { body: 'before' })).body;
      await drop();
      try {
        const add = await host().post(`/api/v1/documents/${d.id}/comments`, { body: 'after' }); assert.equal(add.status, 403); assert.equal(add.body.code, 'entitlement_required'); assert.equal(add.body.plan, 'pro');
        assert.equal((await host().post(`/api/v1/documents/${d.id}/comments/${c.id}/resolve`, {})).body.code, 'entitlement_required');
        assert.equal((await host().get(`/api/v1/documents/${d.id}/comments`)).body.length, 1, 'reading stays allowed'); assert.equal((await q('SELECT count(*)::int n FROM portal.doc_comments WHERE document_id=$1', [d.id]))[0].n, 1, 'nothing was written');
        const b = await newWorkspace('basic'); const bd = await mk(b.cl, 'Basic doc'); assert.equal((await b.cl.post(`/api/v1/documents/${bd.id}/comments`, { body: 'basic still has it' })).status, 201, 'other plans are unaffected');
      } finally { await put(); }
      assert.equal((await host().post(`/api/v1/documents/${d.id}/comments`, { body: 'back' })).status, 201);
    });
    test('the permission check still comes first: a viewer on a plan without comments is told it is read-only, a stranger still gets 404', async () => {
      const d = await mk(host(), 'Order'); await share(host(), d.id, 'restricted', [{ user_id: N.sub, role: 'viewer' }]);
      await drop();
      try { assert.equal((await other().post(`/api/v1/documents/${d.id}/comments`, { body: 'x' })).body.code, 'read_only'); assert.equal((await member().post(`/api/v1/documents/${d.id}/comments`, { body: 'x' })).status, 404); }
      finally { await put(); }
    });
  });
});
