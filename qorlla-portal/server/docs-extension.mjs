// Qorlla Docs extension: list views, stars, templates, folders, duplicate, trash/restore, comments and plain-text/markdown export.
// Adapted from the qorlla-docs-integration handoff. It is wired into the LIVE document model rather than replacing it:
//  * content stays {format:'markdown', text} (doc), so QorllaMate, search, AI tasks and existing documents keep working;
//  * rights come from the same SQL as the rest of the documents API (owner / editor / viewer / workspace access), a document you may not see is a 404;
//  * the workspace and the person come from DATABASE membership (`member`), never from a header or a body field;
//  * the document quota is checked under the same per-workspace lock the create route uses, so concurrent creates cannot exceed the plan;
//  * audit goes to portal.audit_events like every other portal action.
// Needs sql/015_docs_extension.sql. Routes that existed before this file are unchanged apart from the optional `view`/`folder` list filters.
import { z } from 'zod';
import { UUID_RE } from './auth.mjs';
import { quotaFor, withWorkspaceLock } from './entitlements.mjs';

const err = (status, error, code, extra = {}) => Object.assign(new Error(error), { http: { status, body: { error, code, ...extra } } });
const uuid = z.string().regex(UUID_RE);
export const VIEWS = ['recent', 'mine', 'shared', 'starred', 'templates', 'trash'];
export const SORTS = ['updated', 'created', 'title'];
const MAX_FOLDERS = 200;
const MAX_COMMENTS = 500;                      // per document, open and resolved together
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;
export const COMMENTS_FEATURE = 'documents.comments';
/** Comments are a plan feature. The plan row in portal.entitlements is the authority (no row = not granted = refused, so a missing or unreadable entitlement fails closed);
 *  the page only mirrors it. Reading existing comments stays allowed after a downgrade; adding and resolving them does not. */
const requireComments = async (c, ws) => { const q = await quotaFor(c, ws, COMMENTS_FEATURE); if (!q.granted) throw err(403, 'Comments are not included in your plan', 'entitlement_required', { feature: COMMENTS_FEATURE, plan: q.plan }); };

export const HISTORY_FEATURE = 'documents.history_versions';
/** The version-history window of ONE document under the workspace's CURRENT plan (recomputed on every request, so an upgrade unlocks old versions at once and a downgrade
 *  locks them again; nothing is ever deleted). The quota is "the N most recent versions, counted back from the latest and including it"; NULL = unlimited.
 *  A plan with NO row is not granted (quotaFor's contract) and is NOT treated as unlimited: only the current version stays open, which is always readable anyway.
 *  `oldest` is the lowest version number the caller may open or restore; the current version is always inside the window. */
export async function historyWindow(db, ws, currentVersion) {
  const q = await quotaFor(db, ws, HISTORY_FEATURE);
  const limit = q.granted ? q.quota : 0;                                            // null = unlimited, 0 = nothing beyond the current version
  const oldest = limit === null ? 1 : Math.min(currentVersion, Math.max(1, currentVersion - limit + 1));
  return { plan: q.plan, granted: q.granted, limit, oldest, current: currentVersion, allows: (n) => Number.isInteger(n) && n >= oldest && n <= currentVersion };
}
/** Server-side gate: throws 403 entitlement_required (the same shape as comments) before any historical content is read. */
export function assertHistoryAccess(win, n) {
  if (win.allows(n)) return;
  throw err(403, 'This version is outside the version history your plan includes. Upgrade to open or restore older versions.', 'entitlement_required', { feature: HISTORY_FEATURE, plan: win.plan, limit: win.limit, oldest_available: win.oldest, current_version: win.current });
}
const slug = (t) => String(t || 'document').normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'document';

export function registerDocsExtension(app, { pool, auth, h, docRightSql, loadDoc, docMeta, audit, createDocument, assertDocumentRoom, plainText, tsTerms, limiters = {} }) {
  const { member } = auth;
  const lim = (k) => limiters[k] || ((req, res, next) => next());      // per-person request limits (see app.mjs); absent in unit setups

  // ---- list with views (the old list route delegates here when ?view= or ?folder= is present) ----
  /** One row per document the caller may see, with the caller's own star and the template/folder flags. */
  // Keyset pagination on (updated_at, id): stable while documents change, no OFFSET scans, and no 200-row ceiling. The cursor is only a POSITION: it carries no rights,
  // and every page is filtered by the caller's rights again, so a cursor taken from someone else's page reveals nothing.
  const TS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
  // The cursor also names the sort it belongs to: a cursor from one ordering is refused under another instead of silently skipping or repeating rows.
  const encodeCursor = (key, id, sort = 'updated', dir = 'desc') => Buffer.from(JSON.stringify([key, id, sort, dir])).toString('base64url');
  const decodeCursor = (c, sort = 'updated', dir = 'desc') => { try { const [key, id, s, d] = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')); if (s === sort && d === dir && typeof key === 'string' && key.length <= 400 && (sort === 'title' || TS_RE.test(key)) && typeof id === 'string' && UUID_RE.test(id)) return [key, id.toLowerCase()]; } catch { /* malformed: falls through */ } return null; };
  /** One page of documents the caller may see, with the caller's own star and the template/folder flags. Returns { rows, next } (next = cursor or null). */
  async function listDocuments(req, { kind = null, q = null, view = 'recent', folder = null, limit = DEFAULT_PAGE, cursor = null, sort = 'updated', dir = 'desc' }) {
    const terms = tsTerms(q);
    const trash = view === 'trash';
    const tsKey = (col) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const keyExpr = sort === 'title' ? `(lower(d.title) COLLATE "C")` : sort === 'created' ? tsKey('d.created_at') : tsKey('d.updated_at');      // only these three constants ever reach the SQL text
    const cmp = dir === 'asc' ? '>' : '<'; const ord = dir === 'asc' ? 'ASC' : 'DESC';
    const pos = cursor ? decodeCursor(cursor, sort, dir) : null; if (cursor && !pos) throw err(400, 'Invalid cursor', 'invalid_cursor');
    const rows = (await pool.query(
      `SELECT * FROM (
         SELECT d.*, ${docRightSql} AS my_role, COALESCE(s.starred, false) AS starred, COALESCE(m.template, false) AS template, m.folder_id,
                ${keyExpr} AS cursor_ts, (SELECT count(*)::int FROM portal.document_permissions p WHERE p.document_id = d.id) AS shared_count
         FROM portal.documents d
         LEFT JOIN portal.doc_metadata m ON m.document_id = d.id
         LEFT JOIN portal.doc_stars s ON s.document_id = d.id AND s.user_id = $2
         WHERE d.workspace_id = $1
           AND ${trash ? 'd.deleted_at IS NOT NULL AND d.owner_id = $2' : 'd.deleted_at IS NULL'}
           AND ($3::text IS NULL OR d.kind = $3)
           AND ($4::text IS NULL OR d.search @@ to_tsquery('simple', $4))
           AND ($5 <> 'mine' OR d.owner_id = $2)
           AND ($5 <> 'shared' OR d.owner_id <> $2)
           AND ($5 <> 'starred' OR COALESCE(s.starred, false))
           AND ($5 <> 'templates' OR COALESCE(m.template, false))
           AND ($6::text IS NULL OR (d.owner_id = $2 AND ($6 = 'none' AND m.folder_id IS NULL OR $6 <> 'none' AND m.folder_id::text = $6)))
           AND ($7::text IS NULL OR (${keyExpr}, d.id) ${cmp} ($7::text, $8::uuid))
       ) d WHERE my_role IS NOT NULL ORDER BY cursor_ts ${ord}, id ${ord} LIMIT $9`,
      [req.workspace, req.actor, kind, q ? (terms.replace(/ \| /g, ' & ') || 'zzzznomatch') : null, view, folder, pos ? pos[0] : null, pos ? pos[1] : null, limit + 1])).rows;
    const page = rows.slice(0, limit); const last = page[page.length - 1];
    return { rows: page.map((r) => ({ ...docMeta(r), starred: r.starred, template: r.template, folder_id: r.folder_id, deleted_at: r.deleted_at, shared_count: r.shared_count })), next: rows.length > limit && last ? encodeCursor(last.cursor_ts, last.id, sort, dir) : null };
  }
  /** What the editor needs beyond the document itself: my star, the template flag, the folder, open comments. */
  app.get('/api/v1/documents/:id/meta', member, h(async (req, res) => {
    const d = await loadDoc(pool, req, req.params.id); if (!d) return res.status(404).json({ error: 'Document not found' });
    const r = (await pool.query(`SELECT COALESCE((SELECT starred FROM portal.doc_stars WHERE document_id=$1 AND user_id=$2), false) AS starred,
        COALESCE((SELECT template FROM portal.doc_metadata WHERE document_id=$1), false) AS template,
        (SELECT folder_id FROM portal.doc_metadata WHERE document_id=$1) AS folder_id,
        (SELECT count(*)::int FROM portal.doc_comments WHERE document_id=$1 AND resolved_at IS NULL) AS open_comments`, [d.id, req.actor])).rows[0];
    res.set('Cache-Control', 'no-store').json({ ...r, folder_id: d.owner_id === req.actor ? r.folder_id : null });
  }));

  // ---- rename / star / template ----
  app.patch('/api/v1/documents/:id', member, lim('docsWrite'), h(async (req, res) => {
    const p = z.object({ title: z.string().trim().min(1).max(200).optional(), starred: z.boolean().optional(), template: z.boolean().optional() }).strict()
      .refine((o) => Object.keys(o).length > 0, 'nothing to change').parse(req.body);
    await withWorkspaceLock(pool, req.workspace, async (c) => {
      const d = await loadDoc(c, req, req.params.id, { forUpdate: true }); if (!d) throw err(404, 'Document not found');
      if (p.title !== undefined) {
        if (!['owner', 'editor'].includes(d.my_role)) throw err(403, 'You can view but not edit this document', 'read_only');
        await c.query('UPDATE portal.documents SET title=$2, updated_at=now() WHERE id=$1', [d.id, p.title]); await audit(c, req.workspace, req.actor, 'document.renamed', d.id);
      }
      if (p.template !== undefined) {
        if (d.my_role !== 'owner') throw err(403, 'Only the owner can mark a template', 'owner_only');
        await c.query(`INSERT INTO portal.doc_metadata(document_id,workspace_id,template) VALUES($1,$2,$3) ON CONFLICT (document_id) DO UPDATE SET template=EXCLUDED.template`, [d.id, req.workspace, p.template]);
        await audit(c, req.workspace, req.actor, p.template ? 'document.template_set' : 'document.template_cleared', d.id);
      }
      if (p.starred !== undefined) await c.query(`INSERT INTO portal.doc_stars(document_id,user_id,starred) VALUES($1,$2,$3) ON CONFLICT (document_id,user_id) DO UPDATE SET starred=EXCLUDED.starred`, [d.id, req.actor, p.starred]);
    });
    res.json({ updated: true });
  }));

  // ---- duplicate: a new PRIVATE document owned by the caller, copied from the version the caller can read. Counts against the document quota. ----
  app.post('/api/v1/documents/:id/duplicate', member, lim('docsWrite'), h(async (req, res) => {
    const out = await withWorkspaceLock(pool, req.workspace, async (c) => {
      const d = await loadDoc(c, req, req.params.id); if (!d) throw err(404, 'Document not found');
      const v = (await c.query('SELECT content FROM portal.document_versions WHERE document_id=$1 AND version_no=$2', [d.id, d.current_version])).rows[0]; if (!v) throw err(409, 'The document has no readable version', 'missing_version');
      const copy = await createDocument(c, { ws: req.workspace, actor: req.actor, kind: d.kind, title: ('Copy of ' + d.title).slice(0, 200), content: v.content, note: `Copy of version ${d.current_version}` });
      await audit(c, req.workspace, req.actor, 'document.duplicated', copy.id); return copy;
    });
    res.status(201).json(docMeta(out));
  }));

  // ---- trash: the existing DELETE is a soft delete; this brings a document back. Owner only, and the plan's document limit is re-checked. ----
  app.post('/api/v1/documents/:id/undelete', member, lim('docsWrite'), h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Document not found' });
    await withWorkspaceLock(pool, req.workspace, async (c) => {
      const d = (await c.query('SELECT id, owner_id FROM portal.documents WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NOT NULL FOR UPDATE', [req.params.id, req.workspace])).rows[0];
      if (!d || d.owner_id !== req.actor) throw err(404, 'Document not found');
      await assertDocumentRoom(c, req.workspace);                       // the same check, under the same workspace lock, as every other route that adds a live document
      await c.query('UPDATE portal.documents SET deleted_at=NULL, updated_at=now() WHERE id=$1', [d.id]); await audit(c, req.workspace, req.actor, 'document.undeleted', d.id);
    });
    res.json({ restored: true });
  }));

  // ---- folders (private to their owner) ----
  const folderName = z.string().trim().min(1).max(120);
  const ownFolder = async (db, req, id) => (UUID_RE.test(id) ? (await db.query('SELECT id,name FROM portal.doc_folders WHERE id=$1 AND workspace_id=$2 AND owner_id=$3 AND deleted_at IS NULL', [id, req.workspace, req.actor])).rows[0] : null);
  app.get('/api/v1/document-folders', member, h(async (req, res) => {
    res.set('Cache-Control', 'no-store').json((await pool.query(
      `SELECT f.id, f.name, f.created_at, (SELECT count(*)::int FROM portal.doc_metadata m JOIN portal.documents d ON d.id=m.document_id WHERE m.folder_id=f.id AND d.deleted_at IS NULL) AS documents
       FROM portal.doc_folders f WHERE f.workspace_id=$1 AND f.owner_id=$2 AND f.deleted_at IS NULL ORDER BY lower(f.name) LIMIT ${MAX_FOLDERS}`, [req.workspace, req.actor])).rows);
  }));
  app.post('/api/v1/document-folders', member, lim('docsWrite'), h(async (req, res) => {
    const p = z.object({ name: folderName }).strict().parse(req.body);
    const f = await withWorkspaceLock(pool, req.workspace, async (c) => {
      const n = Number((await c.query('SELECT count(*) FROM portal.doc_folders WHERE workspace_id=$1 AND owner_id=$2 AND deleted_at IS NULL', [req.workspace, req.actor])).rows[0].count);
      if (n >= MAX_FOLDERS) throw err(409, `You can have up to ${MAX_FOLDERS} folders`, 'folder_limit');
      try { const row = (await c.query('INSERT INTO portal.doc_folders(workspace_id,owner_id,name) VALUES($1,$2,$3) RETURNING id,name,created_at', [req.workspace, req.actor, p.name])).rows[0]; await audit(c, req.workspace, req.actor, 'document_folder.created', row.id); return row; }
      catch (e) { if (e.code === '23505') throw err(409, 'You already have a folder with that name', 'name_taken'); throw e; }
    });
    res.status(201).json({ ...f, documents: 0 });
  }));
  app.patch('/api/v1/document-folders/:id', member, lim('docsWrite'), h(async (req, res) => {
    const p = z.object({ name: folderName }).strict().parse(req.body);
    await withWorkspaceLock(pool, req.workspace, async (c) => {
      if (!(await ownFolder(c, req, req.params.id))) throw err(404, 'Folder not found');
      try { await c.query('UPDATE portal.doc_folders SET name=$2 WHERE id=$1', [req.params.id, p.name]); } catch (e) { if (e.code === '23505') throw err(409, 'You already have a folder with that name', 'name_taken'); throw e; }
      await audit(c, req.workspace, req.actor, 'document_folder.renamed', req.params.id);
    });
    res.json({ updated: true });
  }));
  app.delete('/api/v1/document-folders/:id', member, lim('docsWrite'), h(async (req, res) => {          // soft delete; the documents in it are kept and become unfiled
    await withWorkspaceLock(pool, req.workspace, async (c) => {
      if (!(await ownFolder(c, req, req.params.id))) throw err(404, 'Folder not found');
      await c.query('UPDATE portal.doc_metadata SET folder_id=NULL WHERE folder_id=$1', [req.params.id]);
      await c.query('UPDATE portal.doc_folders SET deleted_at=now() WHERE id=$1', [req.params.id]); await audit(c, req.workspace, req.actor, 'document_folder.deleted', req.params.id);
    });
    res.status(204).end();
  }));
  app.post('/api/v1/documents/:id/move', member, lim('docsWrite'), h(async (req, res) => {
    const p = z.object({ folder_id: uuid.nullable() }).strict().parse(req.body);
    await withWorkspaceLock(pool, req.workspace, async (c) => {
      const d = await loadDoc(c, req, req.params.id, { forUpdate: true }); if (!d) throw err(404, 'Document not found');
      if (d.my_role !== 'owner') throw err(403, 'Only the owner can move a document', 'owner_only');
      if (p.folder_id && !(await ownFolder(c, req, p.folder_id))) throw err(404, 'Folder not found');
      await c.query(`INSERT INTO portal.doc_metadata(document_id,workspace_id,folder_id) VALUES($1,$2,$3) ON CONFLICT (document_id) DO UPDATE SET folder_id=EXCLUDED.folder_id`, [d.id, req.workspace, p.folder_id]);
      await audit(c, req.workspace, req.actor, 'document.moved', d.id);
    });
    res.json({ updated: true });
  }));

  // ---- comments: anyone who can EDIT may comment and resolve; anyone who can read may read them ----
  app.get('/api/v1/documents/:id/comments', member, h(async (req, res) => {
    const d = await loadDoc(pool, req, req.params.id); if (!d) return res.status(404).json({ error: 'Document not found' });
    res.set('Cache-Control', 'no-store').json((await pool.query('SELECT id, author_id, body, created_at, resolved_at FROM portal.doc_comments WHERE document_id=$1 ORDER BY created_at DESC LIMIT 200', [d.id])).rows);
  }));
  app.post('/api/v1/documents/:id/comments', member, lim('docsComment'), h(async (req, res) => {
    const p = z.object({ body: z.string().trim().min(1).max(4000) }).strict().parse(req.body);
    const row = await withWorkspaceLock(pool, req.workspace, async (c) => {
      const d = await loadDoc(c, req, req.params.id); if (!d) throw err(404, 'Document not found');
      if (!['owner', 'editor'].includes(d.my_role)) throw err(403, 'You can view but not comment on this document', 'read_only');
      await requireComments(c, req.workspace);
      if (Number((await c.query('SELECT count(*) FROM portal.doc_comments WHERE document_id=$1', [d.id])).rows[0].count) >= MAX_COMMENTS) throw err(409, `A document can hold up to ${MAX_COMMENTS} comments`, 'comment_limit');
      const r = (await c.query('INSERT INTO portal.doc_comments(document_id,workspace_id,author_id,body) VALUES($1,$2,$3,$4) RETURNING id, author_id, body, created_at, resolved_at', [d.id, req.workspace, req.actor, p.body])).rows[0];
      await audit(c, req.workspace, req.actor, 'document.commented', d.id); return r;
    });
    res.status(201).json(row);
  }));
  app.post('/api/v1/documents/:id/comments/:cid/resolve', member, lim('docsComment'), h(async (req, res) => {
    await withWorkspaceLock(pool, req.workspace, async (c) => {
      const d = await loadDoc(c, req, req.params.id); if (!d) throw err(404, 'Document not found');
      if (!['owner', 'editor'].includes(d.my_role)) throw err(403, 'You can view but not edit this document', 'read_only');
      await requireComments(c, req.workspace);
      const r = UUID_RE.test(req.params.cid) ? await c.query('UPDATE portal.doc_comments SET resolved_at=now(), resolved_by=$3 WHERE id=$1 AND document_id=$2 AND resolved_at IS NULL', [req.params.cid, d.id, req.actor]) : { rowCount: 0 };
      if (!r.rowCount) throw err(404, 'Comment not found');
      await audit(c, req.workspace, req.actor, 'document.comment_resolved', d.id);
    });
    res.json({ resolved: true });
  }));

  // ---- export: plain text for any kind, markdown for documents. A real DOCX/PDF export needs an isolated converter and is not part of this. ----
  const exportBody = async (req, res, ext) => {
    const d = await loadDoc(pool, req, req.params.id); if (!d) return res.status(404).json({ error: 'Document not found' });
    if (ext === 'md' && d.kind !== 'doc') return res.status(400).json({ error: 'Markdown export is for documents', code: 'unsupported_export' });
    const v = (await pool.query('SELECT content FROM portal.document_versions WHERE document_id=$1 AND version_no=$2', [d.id, d.current_version])).rows[0]; if (!v) return res.status(409).json({ error: 'No readable version', code: 'missing_version' });
    const text = d.kind === 'doc' ? v.content.text : plainText(d.kind, v.content);
    await audit(pool, req.workspace, req.actor, 'document.exported', d.id);
    res.set({ 'Content-Type': ext === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${slug(d.title)}.${ext}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }).send(text);
  };
  app.get('/api/v1/documents/:id/export.txt', member, h((req, res) => exportBody(req, res, 'txt')));
  app.get('/api/v1/documents/:id/export.md', member, h((req, res) => exportBody(req, res, 'md')));

  return { listDocuments };
}
