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
import { PlanLimitError, quotaFor, withWorkspaceLock } from './entitlements.mjs';

const err = (status, error, code, extra = {}) => Object.assign(new Error(error), { http: { status, body: { error, code, ...extra } } });
const uuid = z.string().regex(UUID_RE);
export const VIEWS = ['recent', 'mine', 'shared', 'starred', 'templates', 'trash'];
const MAX_FOLDERS = 200;
const slug = (t) => String(t || 'document').normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'document';

export function registerDocsExtension(app, { pool, auth, h, docRightSql, loadDoc, docMeta, audit, createDocument, plainText, tsTerms }) {
  const { member } = auth;

  // ---- list with views (the old list route delegates here when ?view= or ?folder= is present) ----
  /** One row per document the caller may see, with the caller's own star and the template/folder flags. */
  async function listDocuments(req, { kind = null, q = null, view = 'recent', folder = null }) {
    const terms = tsTerms(q);
    const trash = view === 'trash';
    const rows = (await pool.query(
      `SELECT * FROM (
         SELECT d.*, ${docRightSql} AS my_role, COALESCE(s.starred, false) AS starred, COALESCE(m.template, false) AS template, m.folder_id
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
       ) d WHERE my_role IS NOT NULL ORDER BY updated_at DESC LIMIT 200`,
      [req.workspace, req.actor, kind, q ? (terms.replace(/ \| /g, ' & ') || 'zzzznomatch') : null, view, folder])).rows;
    return rows.map((r) => ({ ...docMeta(r), starred: r.starred, template: r.template, folder_id: r.folder_id, deleted_at: r.deleted_at }));
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
  app.patch('/api/v1/documents/:id', member, h(async (req, res) => {
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
  app.post('/api/v1/documents/:id/duplicate', member, h(async (req, res) => {
    const out = await withWorkspaceLock(pool, req.workspace, async (c) => {
      const d = await loadDoc(c, req, req.params.id); if (!d) throw err(404, 'Document not found');
      const v = (await c.query('SELECT content FROM portal.document_versions WHERE document_id=$1 AND version_no=$2', [d.id, d.current_version])).rows[0]; if (!v) throw err(409, 'The document has no readable version', 'missing_version');
      const copy = await createDocument(c, { ws: req.workspace, actor: req.actor, kind: d.kind, title: ('Copy of ' + d.title).slice(0, 200), content: v.content, note: `Copy of version ${d.current_version}` });
      await audit(c, req.workspace, req.actor, 'document.duplicated', copy.id); return copy;
    });
    res.status(201).json(docMeta(out));
  }));

  // ---- trash: the existing DELETE is a soft delete; this brings a document back. Owner only, and the plan's document limit is re-checked. ----
  app.post('/api/v1/documents/:id/undelete', member, h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Document not found' });
    await withWorkspaceLock(pool, req.workspace, async (c) => {
      const d = (await c.query('SELECT id, owner_id FROM portal.documents WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NOT NULL FOR UPDATE', [req.params.id, req.workspace])).rows[0];
      if (!d || d.owner_id !== req.actor) throw err(404, 'Document not found');
      const q = await quotaFor(c, req.workspace, 'documents.max'); const n = Number((await c.query('SELECT count(*) FROM portal.documents WHERE workspace_id=$1 AND deleted_at IS NULL', [req.workspace])).rows[0].count);
      if (q.quota !== null && n >= q.quota) throw new PlanLimitError('documents.max', q.quota, q.plan);
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
  app.post('/api/v1/document-folders', member, h(async (req, res) => {
    const p = z.object({ name: folderName }).strict().parse(req.body);
    const f = await withWorkspaceLock(pool, req.workspace, async (c) => {
      const n = Number((await c.query('SELECT count(*) FROM portal.doc_folders WHERE workspace_id=$1 AND owner_id=$2 AND deleted_at IS NULL', [req.workspace, req.actor])).rows[0].count);
      if (n >= MAX_FOLDERS) throw err(409, `You can have up to ${MAX_FOLDERS} folders`, 'folder_limit');
      try { const row = (await c.query('INSERT INTO portal.doc_folders(workspace_id,owner_id,name) VALUES($1,$2,$3) RETURNING id,name,created_at', [req.workspace, req.actor, p.name])).rows[0]; await audit(c, req.workspace, req.actor, 'document_folder.created', row.id); return row; }
      catch (e) { if (e.code === '23505') throw err(409, 'You already have a folder with that name', 'name_taken'); throw e; }
    });
    res.status(201).json({ ...f, documents: 0 });
  }));
  app.patch('/api/v1/document-folders/:id', member, h(async (req, res) => {
    const p = z.object({ name: folderName }).strict().parse(req.body);
    await withWorkspaceLock(pool, req.workspace, async (c) => {
      if (!(await ownFolder(c, req, req.params.id))) throw err(404, 'Folder not found');
      try { await c.query('UPDATE portal.doc_folders SET name=$2 WHERE id=$1', [req.params.id, p.name]); } catch (e) { if (e.code === '23505') throw err(409, 'You already have a folder with that name', 'name_taken'); throw e; }
      await audit(c, req.workspace, req.actor, 'document_folder.renamed', req.params.id);
    });
    res.json({ updated: true });
  }));
  app.delete('/api/v1/document-folders/:id', member, h(async (req, res) => {          // soft delete; the documents in it are kept and become unfiled
    await withWorkspaceLock(pool, req.workspace, async (c) => {
      if (!(await ownFolder(c, req, req.params.id))) throw err(404, 'Folder not found');
      await c.query('UPDATE portal.doc_metadata SET folder_id=NULL WHERE folder_id=$1', [req.params.id]);
      await c.query('UPDATE portal.doc_folders SET deleted_at=now() WHERE id=$1', [req.params.id]); await audit(c, req.workspace, req.actor, 'document_folder.deleted', req.params.id);
    });
    res.status(204).end();
  }));
  app.post('/api/v1/documents/:id/move', member, h(async (req, res) => {
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
  app.post('/api/v1/documents/:id/comments', member, h(async (req, res) => {
    const p = z.object({ body: z.string().trim().min(1).max(4000) }).strict().parse(req.body);
    const row = await withWorkspaceLock(pool, req.workspace, async (c) => {
      const d = await loadDoc(c, req, req.params.id); if (!d) throw err(404, 'Document not found');
      if (!['owner', 'editor'].includes(d.my_role)) throw err(403, 'You can view but not comment on this document', 'read_only');
      const r = (await c.query('INSERT INTO portal.doc_comments(document_id,workspace_id,author_id,body) VALUES($1,$2,$3,$4) RETURNING id, author_id, body, created_at, resolved_at', [d.id, req.workspace, req.actor, p.body])).rows[0];
      await audit(c, req.workspace, req.actor, 'document.commented', d.id); return r;
    });
    res.status(201).json(row);
  }));
  app.post('/api/v1/documents/:id/comments/:cid/resolve', member, h(async (req, res) => {
    await withWorkspaceLock(pool, req.workspace, async (c) => {
      const d = await loadDoc(c, req, req.params.id); if (!d) throw err(404, 'Document not found');
      if (!['owner', 'editor'].includes(d.my_role)) throw err(403, 'You can view but not edit this document', 'read_only');
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
