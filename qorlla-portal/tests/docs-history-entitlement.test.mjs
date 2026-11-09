// Docs version-history window (migration 016, documents.history_versions; server/docs-extension.mjs historyWindow/assertHistoryAccess).
// Real PostgreSQL, real routes. Policy under test: the N most recent versions, counted back from the LATEST version and including it, N = 10 / 100 / 500 / unlimited (NULL).
// Older versions stay stored and are LISTED as locked metadata, but cannot be opened or restored. The window is recomputed from the workspace's CURRENT plan on every request.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, addMember } from './helpers.mjs';

const rid = () => crypto.randomUUID();
const TEST_CONTRACT = { QORLLA_AI_ENABLED: 'true', QORLLA_AI_PROVIDER: 'test', QORLLA_AI_TEST_ADAPTER_ENABLED: 'true', QORLLA_ENVIRONMENT: 'test', QORLLA_AI_ALLOW_PAID_FALLBACK: 'false', QORLLA_AI_RATE_PER_MINUTE: '100000' };
const SECRET = (n) => `HISTORY-SECRET-v${n}-${'x'.repeat(3)}`;
const md = (text) => ({ format: 'markdown', text });

describe('Docs version-history window (documents.history_versions)', () => {
  let db, main, app;
  const q = async (sql, args = []) => (await db.pool.query(sql, args)).rows;
  const setPlan = (w, plan) => db.pool.query(`UPDATE portal.subscriptions SET plan_slug=$2,status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [w, plan]);
  const newWorkspace = async (plan = 'basic') => { const u = await main.mint(); const w = await seedWorkspace(db.pool, u.sub, 'Hist ' + rid().slice(0, 6)); if (plan !== 'basic') await setPlan(w, plan); return { u, w, cl: app.client(u), hdr: { 'x-workspace-id': w } }; };
  /** A document with exactly `n` versions made the normal way (manual saves), each carrying its own marker text. */
  const build = async ({ cl, hdr }, n, title = 'History doc') => {
    const d = (await cl.post('/api/v1/documents', { kind: 'doc', title, content: md(SECRET(1)) }, hdr)).body; assert.ok(d.id, JSON.stringify(d));
    for (let v = 2; v <= n; v++) { const r = await cl.put('/api/v1/documents/' + d.id, { base_version: v - 1, content: md(SECRET(v)) }, hdr); assert.equal(r.status, 200, JSON.stringify(r.body)); }
    return d;
  };
  /** Scale cases: extend a document to `n` versions straight in SQL (the same rows the app would write). */
  const bulk = async (docId, owner, n) => {
    await q(`INSERT INTO portal.document_versions(document_id,version_no,content,source,created_by) SELECT $1, g, jsonb_build_object('format','markdown','text','HISTORY-SECRET-v'||g||'-xxx'), 'user', $2 FROM generate_series((SELECT current_version+1 FROM portal.documents WHERE id=$1), $3::int) g`, [docId, owner, n]);
    await q('UPDATE portal.documents SET current_version=$2 WHERE id=$1', [docId, n]);
  };
  const dbDoc = async (id) => (await q('SELECT current_version FROM portal.documents WHERE id=$1', [id]))[0];
  const versionCount = async (id) => Number((await q('SELECT count(*) FROM portal.document_versions WHERE document_id=$1', [id]))[0].count);
  const list = async (c, d) => (await c.cl.get(`/api/v1/documents/${d.id}/versions`, c.hdr)).body;
  const open = (c, d, n) => c.cl.get(`/api/v1/documents/${d.id}/versions/${n}`, c.hdr);
  const restore = (c, d, version_no, base_version) => c.cl.post(`/api/v1/documents/${d.id}/restore`, { version_no, base_version }, c.hdr);
  const lockedNumbers = (rows) => rows.filter((r) => r.locked).map((r) => r.version_no).sort((a, b) => a - b);

  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn();
    app = await startApp({ pool: db.pool, cfg: testConfig({ env: TEST_CONTRACT }, main), jwks: main.jwks });
  });
  after(async () => { await app?.close(); await main?.close(); await db?.drop(); });

  describe('the entitlement contract', () => {
    test('migration 016 seeds exactly the approved values, one row per plan, NULL = unlimited', async () => {
      const rows = await q(`SELECT plan_slug, quota FROM portal.entitlements WHERE feature='documents.history_versions' ORDER BY plan_slug`);
      assert.deepEqual(rows.map((r) => [r.plan_slug, r.quota]), [['basic', 10], ['business', 500], ['enterprise', null], ['pro', 100]]);
    });
    test('the plan limit is visible through the normal entitlements endpoint (the page mirrors it; the server decides)', async () => {
      const c = await newWorkspace('basic'); const e = await c.cl.get('/api/v1/entitlements', c.hdr);
      assert.equal(e.body.features['documents.history_versions'].quota, 10); assert.equal(e.body.features['documents.history_versions'].unlimited, false);
      const p = await newWorkspace('enterprise'); assert.equal((await p.cl.get('/api/v1/entitlements', p.hdr)).body.features['documents.history_versions'].unlimited, true);
    });
  });

  describe('Basic: the 10 most recent versions, counted back from the latest and including it', () => {
    test('30 versions: 21-30 open, 1-20 listed as locked, and a locked version reveals nothing', async () => {
      const c = await newWorkspace('basic'); const d = await build(c, 30);
      const rows = await list(c, d); assert.equal(rows.length, 30, 'every stored version is still listed');
      assert.deepEqual(lockedNumbers(rows), Array.from({ length: 20 }, (_, i) => i + 1)); assert.ok(rows.filter((r) => !r.locked).every((r) => r.version_no >= 21));
      for (const r of rows.filter((x) => x.locked)) { assert.deepEqual(Object.keys(r).sort(), ['created_at', 'created_by', 'locked', 'note', 'source', 'version_no']); assert.equal(r.note, null); assert.equal(r.created_by, null); }
      assert.doesNotMatch(JSON.stringify(rows), /HISTORY-SECRET/, 'a list never carries content');
      assert.equal((await open(c, d, 21)).status, 200); assert.match((await open(c, d, 21)).body.content.text, /v21-/); assert.equal((await open(c, d, 30)).status, 200);
      const locked = await open(c, d, 20); assert.equal(locked.status, 403); assert.equal(locked.body.code, 'entitlement_required');
      assert.deepEqual([locked.body.feature, locked.body.plan, locked.body.limit, locked.body.oldest_available, locked.body.current_version], ['documents.history_versions', 'basic', 10, 21, 30]);
      for (const n of [1, 2, 19, 20]) { const r = await open(c, d, n); assert.equal(r.status, 403, 'v' + n); assert.doesNotMatch(JSON.stringify(r.body), /HISTORY-SECRET/); }
      assert.equal(await versionCount(d.id), 30, 'locked versions are preserved in storage');
    });
    test('boundaries: 10 versions are all open, 11 locks only v1; a version that does not exist is 404 (not 403)', async () => {
      const c = await newWorkspace('basic'); const d = await build(c, 10);
      assert.deepEqual(lockedNumbers(await list(c, d)), []); assert.equal((await open(c, d, 1)).status, 200);
      await c.cl.put('/api/v1/documents/' + d.id, { base_version: 10, content: md(SECRET(11)) }, c.hdr);
      assert.deepEqual(lockedNumbers(await list(c, d)), [1]); assert.equal((await open(c, d, 1)).status, 403); assert.equal((await open(c, d, 2)).status, 200);
      for (const n of [12, 999, 0]) assert.equal((await open(c, d, n)).status, 404, 'v' + n);
    });
    test('restore uses the same window: v21 restores as a new version, v20 is refused and nothing is written', async () => {
      const c = await newWorkspace('basic'); const d = await build(c, 30);
      const audit = async () => Number((await q(`SELECT count(*) FROM portal.audit_events WHERE object_id=$1 AND action='document.restored'`, [d.id]))[0].count);
      const no = await restore(c, d, 20, 30); assert.equal(no.status, 403); assert.equal(no.body.code, 'entitlement_required'); assert.equal(no.body.oldest_available, 21);
      assert.equal((await dbDoc(d.id)).current_version, 30, 'a refused restore creates no version'); assert.equal(await versionCount(d.id), 30); assert.equal(await audit(), 0, 'and is not audited as a restore');
      const ok = await restore(c, d, 21, 30); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.current_version, 31);
      assert.match((await c.cl.get('/api/v1/documents/' + d.id, c.hdr)).body.content.text, /v21-/, 'the restored content is now current'); assert.equal(await audit(), 1);
      assert.equal((await restore(c, d, 21, 31)).status, 403, 'the window moved with the new latest version: v21 is now outside it (22-31)');
      assert.equal((await restore(c, d, 22, 31)).status, 200);
    });
    test('the current version is always open, and is restorable onto itself, whatever the window', async () => {
      const c = await newWorkspace('basic'); const d = await build(c, 3);
      assert.equal((await open(c, d, 3)).status, 200); assert.equal((await restore(c, d, 3, 3)).status, 200);
    });
  });

  describe('Pro, Business and Enterprise', () => {
    test('Pro keeps 100: with 101 versions v1 is locked and v2 is open', async () => {
      const c = await newWorkspace('pro'); const d = await build(c, 2); await bulk(d.id, c.u.sub, 101);
      assert.deepEqual(lockedNumbers(await list(c, d)), [1]); assert.equal((await open(c, d, 1)).status, 403); assert.equal((await open(c, d, 2)).status, 200); assert.equal((await restore(c, d, 1, 101)).status, 403); assert.equal((await restore(c, d, 2, 101)).status, 200);
    });
    test('Business keeps 500: with 501 versions v1 is locked and v2 is open (the list is capped at 200 rows, newest first, as before)', async () => {
      const c = await newWorkspace('business'); const d = await build(c, 2); await bulk(d.id, c.u.sub, 501);
      assert.equal((await open(c, d, 1)).status, 403); assert.equal((await open(c, d, 2)).status, 200); const rows = await list(c, d); assert.equal(rows.length, 200); assert.ok(rows.every((r) => !r.locked), 'the 200 newest are all inside a 500 window');
    });
    test('Enterprise (NULL) is unlimited: every one of 600 versions opens and restores', async () => {
      const c = await newWorkspace('enterprise'); const d = await build(c, 2); await bulk(d.id, c.u.sub, 600);
      assert.equal((await open(c, d, 1)).status, 200); assert.deepEqual(lockedNumbers(await list(c, d)), []); assert.equal((await restore(c, d, 1, 600)).status, 200);
    });
  });

  describe('the plan is read on every request: upgrades unlock, downgrades lock, nothing is deleted', () => {
    test('Basic -> Pro unlocks old versions at once; Pro -> Basic locks them again with every version and its content intact', async () => {
      const c = await newWorkspace('basic'); const d = await build(c, 30); const before = await q('SELECT version_no, content, created_at FROM portal.document_versions WHERE document_id=$1 ORDER BY version_no', [d.id]);
      assert.equal((await open(c, d, 5)).status, 403);
      await setPlan(c.w, 'pro'); assert.equal((await open(c, d, 5)).status, 200); assert.deepEqual(lockedNumbers(await list(c, d)), []); assert.equal((await restore(c, d, 5, 30)).status, 200);
      await setPlan(c.w, 'basic'); assert.equal((await open(c, d, 5)).status, 403, 'the restore made v31; the window is 22-31 again');
      assert.equal((await open(c, d, 21)).status, 403); assert.equal((await open(c, d, 22)).status, 200);
      const after = await q('SELECT version_no, content, created_at FROM portal.document_versions WHERE document_id=$1 AND version_no<=30 ORDER BY version_no', [d.id]); assert.deepEqual(after, before, 'no stored version was changed or removed');
    });
    test('a lapsed paid subscription falls back to Basic, exactly like every other entitlement', async () => {
      const c = await newWorkspace('pro'); const d = await build(c, 15); assert.equal((await open(c, d, 1)).status, 200);
      await db.pool.query(`UPDATE portal.subscriptions SET status='canceled', current_period_end=now()-interval '40 days' WHERE workspace_id=$1`, [c.w]);
      assert.equal((await open(c, d, 1)).status, 403); assert.equal((await open(c, d, 6)).status, 200);
    });
  });

  describe('fail closed: an environment where the entitlement was never seeded', () => {
    test('with no row the plan is NOT treated as unlimited: only the current version opens; reading and editing the document itself keep working', async () => {
      const c = await newWorkspace('pro'); const d = await build(c, 5);
      const saved = await q(`SELECT plan_slug, feature, quota, description FROM portal.entitlements WHERE feature='documents.history_versions'`);
      await q(`DELETE FROM portal.entitlements WHERE feature='documents.history_versions'`);
      try {
        assert.equal((await open(c, d, 4)).status, 403); assert.equal((await open(c, d, 1)).status, 403); assert.equal((await restore(c, d, 4, 5)).status, 403);
        assert.equal((await open(c, d, 5)).status, 200, 'the current version is always readable'); assert.deepEqual(lockedNumbers(await list(c, d)), [1, 2, 3, 4]);
        const cur = await c.cl.get('/api/v1/documents/' + d.id, c.hdr); assert.equal(cur.status, 200); assert.match(cur.body.content.text, /v5-/);
        assert.equal((await c.cl.put('/api/v1/documents/' + d.id, { base_version: 5, content: md('edited while unseeded') }, c.hdr)).status, 200, 'editing is not affected');
      } finally { for (const r of saved) await q('INSERT INTO portal.entitlements(plan_slug,feature,quota,description) VALUES($1,$2,$3,$4)', [r.plan_slug, r.feature, r.quota, r.description]); }
      assert.equal((await open(c, d, 4)).status, 200, 'seeded again: the Pro window applies');
    });
  });

  describe('authorisation and tenant isolation come first', () => {
    test('another workspace, a non-member and a person without access to a restricted document learn nothing (and are never given content)', async () => {
      const a = await newWorkspace('enterprise'); const d = await build(a, 4); const stranger = await newWorkspace('enterprise');
      for (const r of [await stranger.cl.get(`/api/v1/documents/${d.id}/versions`, stranger.hdr), await stranger.cl.get(`/api/v1/documents/${d.id}/versions/2`, stranger.hdr), await stranger.cl.post(`/api/v1/documents/${d.id}/restore`, { version_no: 2, base_version: 4 }, stranger.hdr)]) { assert.equal(r.status, 404); assert.doesNotMatch(JSON.stringify(r.body), /HISTORY-SECRET/); }
      for (const r of [await stranger.cl.get(`/api/v1/documents/${d.id}/versions/2`, a.hdr), await stranger.cl.post(`/api/v1/documents/${d.id}/restore`, { version_no: 2, base_version: 4 }, a.hdr)]) { assert.ok([401, 403, 404].includes(r.status), String(r.status)); assert.doesNotMatch(JSON.stringify(r.body), /HISTORY-SECRET/); }
      const m = await main.mint(); await addMember(db.pool, a.w, m.sub, 'member'); const mc = { cl: app.client(m), hdr: a.hdr };
      assert.equal((await open(mc, d, 2)).status, 404, 'a restricted document is invisible to a member who was not given it'); assert.equal((await restore(mc, d, 2, 4)).status, 404);
      assert.equal((await mc.cl.get(`/api/v1/documents/${d.id}/versions`, a.hdr)).status, 404);
    });
    test('the window is the DOCUMENT\'s workspace plan: a person in a Pro and a Basic workspace cannot use the Pro window on the Basic workspace\'s document', async () => {
      const basic = await newWorkspace('basic'); const d = await build(basic, 14); const pro = await seedWorkspace(db.pool, basic.u.sub, 'Pro side'); await setPlan(pro, 'pro');
      assert.equal((await open(basic, d, 1)).status, 403);
      const viaPro = await basic.cl.get(`/api/v1/documents/${d.id}/versions/1`, { 'x-workspace-id': pro }); assert.equal(viaPro.status, 404, 'the document does not exist in the Pro workspace');
      assert.equal((await basic.cl.post(`/api/v1/documents/${d.id}/restore`, { version_no: 1, base_version: 14 }, { 'x-workspace-id': pro })).status, 404);
      assert.equal(await versionCount(d.id), 14);
    });
    test('a viewer can open versions inside the window and sees locked rows, but cannot restore (read_only comes first); an editor is held to the same window', async () => {
      const c = await newWorkspace('basic'); const d = await build(c, 14); const v = await main.mint(); const e = await main.mint(); await addMember(db.pool, c.w, v.sub, 'member'); await addMember(db.pool, c.w, e.sub, 'member');
      await c.cl.put(`/api/v1/documents/${d.id}/permissions`, { general_access: 'restricted', users: [{ user_id: v.sub, role: 'viewer' }, { user_id: e.sub, role: 'editor' }] }, c.hdr);
      const vc = { cl: app.client(v), hdr: c.hdr }; const ec = { cl: app.client(e), hdr: c.hdr };
      assert.equal((await open(vc, d, 6)).status, 200); assert.equal((await open(vc, d, 2)).status, 403); assert.deepEqual(lockedNumbers(await list(vc, d)), [1, 2, 3, 4]);
      const vr = await restore(vc, d, 6, 14); assert.equal(vr.status, 403); assert.equal(vr.body.code, 'read_only');
      assert.equal((await restore(ec, d, 2, 14)).status, 403); assert.equal((await restore(ec, d, 6, 14)).status, 200);
    });
    test('a signed-out caller and a missing CSRF token get nothing', async () => {
      const c = await newWorkspace('basic'); const d = await build(c, 12); const anon = app.client(null);
      assert.equal((await anon.get(`/api/v1/documents/${d.id}/versions/12`)).status, 401);
      const noCsrf = await c.cl.post(`/api/v1/documents/${d.id}/restore`, { version_no: 12, base_version: 12 }, { ...c.hdr, 'x-csrf-token': 'wrong' }); assert.ok([400, 403].includes(noCsrf.status), String(noCsrf.status));
      assert.equal(await versionCount(d.id), 12);
    });
  });

  describe('no alternative route returns older content', () => {
    test('version numbers cannot be spelled around the check, and malformed ones are rejected', async () => {
      const c = await newWorkspace('basic'); const d = await build(c, 20);
      for (const n of ['01', '001', '%31', '1', '5']) { const r = await c.cl.get(`/api/v1/documents/${d.id}/versions/${n}`, c.hdr); assert.equal(r.status, 403, 'spelling: ' + n); assert.doesNotMatch(JSON.stringify(r.body), /HISTORY-SECRET/); }
      for (const n of ['1e0', '+1', '1.0', '-1', '0x1', 'abc', '99999999999999999999']) assert.equal((await c.cl.get(`/api/v1/documents/${d.id}/versions/${n}`, c.hdr)).status, 404, 'spelling: ' + n);
      for (const body of [{ version_no: '1', base_version: 20 }, { version_no: 1.5, base_version: 20 }, { version_no: -3, base_version: 20 }, { version_no: 0, base_version: 20 }, { base_version: 20 }]) assert.equal((await c.cl.post(`/api/v1/documents/${d.id}/restore`, body, c.hdr)).status, 400, JSON.stringify(body));
      assert.equal((await restore(c, d, 1, 20)).status, 403); assert.equal((await restore(c, d, 1, 1)).status, 403, 'a stale base_version cannot be used to get a different error path');
      assert.equal(await versionCount(d.id), 20);
    });
    test('the document, its list, search, duplicate, export and the meta view only ever carry the CURRENT content', async () => {
      const c = await newWorkspace('basic'); const d = await build(c, 20);
      const get = await c.cl.get(`/api/v1/documents/${d.id}?version=1&v=1&version_no=1`, c.hdr); assert.equal(get.status, 200); assert.match(get.body.content.text, /v20-/); assert.doesNotMatch(JSON.stringify(get.body), /v1-|v2-/);
      for (const p of [`/api/v1/documents?view=recent&q=HISTORY`, `/api/v1/documents/${d.id}/meta`, `/api/v1/search?q=HISTORY-SECRET`]) { const r = await c.cl.get(p, c.hdr); assert.equal(r.status, 200, p); assert.doesNotMatch(JSON.stringify(r.body), /v1-xxx|v2-xxx|v10-xxx|v19-xxx/, p); }
      for (const ext of ['txt', 'md']) { const r = await c.cl.get(`/api/v1/documents/${d.id}/export.${ext}`, c.hdr); assert.equal(r.status, 200); const t = typeof r.body === 'string' ? r.body : JSON.stringify(r.body); assert.match(t, /v20-/); assert.doesNotMatch(t, /v19-|v1-|v10-/); }
      const dup = await c.cl.post(`/api/v1/documents/${d.id}/duplicate`, {}, c.hdr); assert.equal(dup.status, 201); assert.equal(dup.body.current_version, 1, 'a copy starts its own history from the current content only'); assert.equal(await versionCount(dup.body.id), 1);
    });
    test('an AI citation to an older version obeys the window: locked on Basic, open again after an upgrade, and the current version is always citable', async () => {
      const c = await newWorkspace('pro'); const d = await build({ cl: c.cl, hdr: c.hdr }, 1); await c.cl.put('/api/v1/documents/' + d.id, { base_version: 1, content: md('Original wording of the plan.') }, c.hdr);
      const g = await c.cl.post('/api/v1/ai/run', { task: 'docs_rewrite', document_id: d.id, idempotency_key: 'idem-' + rid().slice(0, 12) }, c.hdr); assert.equal(g.status, 200, JSON.stringify(g.body)); const ref = g.body.citations[0].ref;
      const cited = (await q('SELECT current_version FROM portal.documents WHERE id=$1', [d.id]))[0].current_version;
      assert.equal((await c.cl.get('/api/v1/ai/citations/' + ref, c.hdr)).status, 200, 'the current version is open');
      let base = cited; for (let i = 0; i < 12; i++) { assert.equal((await c.cl.put('/api/v1/documents/' + d.id, { base_version: base, content: md('later edit ' + i) }, c.hdr)).status, 200); base++; }
      assert.equal((await c.cl.get('/api/v1/ai/citations/' + ref, c.hdr)).status, 200, 'Pro window (100) still covers it');
      await setPlan(c.w, 'basic'); const locked = await c.cl.get('/api/v1/ai/citations/' + ref, c.hdr); assert.equal(locked.status, 403); assert.equal(locked.body.code, 'entitlement_required'); assert.doesNotMatch(JSON.stringify(locked.body), /Original wording/);
      await setPlan(c.w, 'pro'); assert.equal((await c.cl.get('/api/v1/ai/citations/' + ref, c.hdr)).status, 200);
    });
  });

  describe('existing behaviour is untouched', () => {
    test('autosave still folds into one version (no extra versions to satisfy a quota), and the autosaved version is inside the window', async () => {
      const c = await newWorkspace('basic'); const d = await build(c, 3);
      for (let i = 0; i < 6; i++) { const cur = (await dbDoc(d.id)).current_version; const r = await c.cl.put('/api/v1/documents/' + d.id, { base_version: cur, content: md('typing ' + i), autosave: true }, c.hdr); assert.equal(r.status, 200, JSON.stringify(r.body)); }
      assert.equal((await dbDoc(d.id)).current_version, 4, 'six autosaves became ONE new version'); assert.equal(await versionCount(d.id), 4);
      const rows = await list(c, d); assert.equal(rows.length, 4); assert.ok(rows.every((r) => r.locked === false)); assert.equal(rows[0].source, 'user');
    });
    test('a document created before this change reads and lists exactly as before (legacy rows, no history entitlement involved)', async () => {
      const c = await newWorkspace('basic'); const id = rid();
      await q(`INSERT INTO portal.documents(id,workspace_id,owner_id,kind,title,current_version,search_text,created_at,updated_at) VALUES($1,$2,$3,'doc','Legacy',2,'legacy text',now()-interval '90 days',now()-interval '80 days')`, [id, c.w, c.u.sub]);
      await q(`INSERT INTO portal.document_versions(document_id,version_no,content,source,created_by,created_at) VALUES($1,1,'{"format":"markdown","text":"old"}','user',$2,now()-interval '90 days'),($1,2,'{"format":"markdown","text":"legacy text"}','user',$2,now()-interval '80 days')`, [id, c.u.sub]);
      const get = await c.cl.get('/api/v1/documents/' + id, c.hdr); assert.equal(get.status, 200); assert.equal(get.body.content.text, 'legacy text'); assert.equal(get.body.current_version, 2);
      const rows = await list(c, { id }); assert.deepEqual(rows.map((r) => [r.version_no, r.locked]), [[2, false], [1, false]]); assert.equal((await open(c, { id }, 1)).body.content.text, 'old');
      assert.equal((await c.cl.put('/api/v1/documents/' + id, { base_version: 2, content: md('edited') }, c.hdr)).status, 200);
    });
    test('folders, stars, comments and the list views keep working alongside the history window', async () => {
      const c = await newWorkspace('basic'); const d = await build(c, 13);
      const f = await c.cl.post('/api/v1/document-folders', { name: 'F ' + rid().slice(0, 4) }, c.hdr); assert.equal(f.status, 201);
      assert.equal((await c.cl.post(`/api/v1/documents/${d.id}/move`, { folder_id: f.body.id }, c.hdr)).status, 200);
      assert.equal((await c.cl.patch(`/api/v1/documents/${d.id}`, { starred: true }, c.hdr)).status, 200);
      assert.equal((await c.cl.post(`/api/v1/documents/${d.id}/comments`, { body: 'still works' }, c.hdr)).status, 201);
      const v = await c.cl.get('/api/v1/documents?view=starred', c.hdr); assert.ok(v.body.some((x) => x.id === d.id && x.starred === true));
    });
  });
});
