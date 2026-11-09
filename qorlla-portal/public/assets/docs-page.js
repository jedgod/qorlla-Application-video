// Qorlla Docs: the documents home (views, folders, search, stars, templates, trash), the document editor (markdown toolbar, preview, versions,
// sharing, comments, export) and the existing sheet / slides editors. Mounted by app.js at /app/suite through workspace.js.
// Wired to the portal API (/api/v1/documents, /api/v1/document-folders). All text is escaped before it reaches the page; the markdown preview
// escapes first and only then adds a fixed set of tags, so nothing a person types can run as script. AI output is shown as plain text only.
import { esc, api, apiPaged, notice, describe, panel } from './core.js';
import { mountAiPanel } from './ai-panel.js';

// Where the page is mounted decides how it is addressed and where it looks things up: the standalone portal page (/app/suite) or the Workspace's Docs view (#docs).
// Every lookup is bound to ITS OWN mounted root (a local $ in renderHome/renderEditor), never to shared state: the Workspace can render the Docs view twice in quick succession
// while it starts up, and two mounts must not see each other's elements.
let ctx = { embedded: false, urls: { home: () => '/app/suite', doc: (id) => '/app/suite?doc=' + id } };
const offs = [];                                                         // document-level listeners, removed when the Workspace leaves Docs
const listen = (target, type, fn) => { target.addEventListener(type, fn); offs.push(() => target.removeEventListener(type, fn)); };
const DOC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const say = (e) => (e.body?.code === 'entitlement_required' ? 'That is not included in your plan.' : describe(e));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '-');
const ago = (iso) => { const s = (Date.now() - new Date(iso).getTime()) / 1000; if (!(s >= 0)) return when(iso); if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago'; if (s < 172800) return 'yesterday'; return new Date(iso).toLocaleDateString(); };
const KIND = { doc: ['📄', 'Document'], sheet: ['📊', 'Sheet'], slides: ['🎞️', 'Slides'] };
const VIEWS = [['home', '🏠', 'Home'], ['recent', '🕘', 'Recent'], ['mine', '📄', 'My documents'], ['shared', '🤝', 'Shared'], ['starred', '⭐', 'Starred'], ['templates', '📑', 'Templates'], ['trash', '🗑️', 'Trash']];
const TITLES = { home: 'Recent documents', recent: 'Recent', mine: 'My documents', shared: 'Shared with me', starred: 'Starred', templates: 'Templates', trash: 'Trash' };
const EMPTY = { home: 'No documents yet. Choose + New to create one.', recent: 'No documents yet. Choose + New to create one.', mine: 'You have not created any documents yet.', shared: 'Nothing has been shared with you yet.', starred: 'Star a document to find it here quickly.', templates: 'Mark one of your documents as a template to list it here.', trash: 'The trash is empty.' };

// ------------------------------------------------------------------ safe markdown preview
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
export function renderMarkdown(src) {
  const out = []; let list = null; let para = []; let fence = null;
  const flushP = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const flushL = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const item = (kind, text) => { flushP(); if (list !== kind) { flushL(); out.push(`<${kind}>`); list = kind; } out.push('<li>' + inline(text) + '</li>'); };
  for (const line of String(src || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (fence !== null) { if (/^```/.test(line)) { out.push('<pre><code>' + esc(fence.join('\n')) + '</code></pre>'); fence = null; } else fence.push(line); continue; }
    if (/^```/.test(line)) { flushP(); flushL(); fence = []; continue; }
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { flushP(); flushL(); const n = m[1].length + 1; out.push(`<h${n}>` + inline(m[2]) + `</h${n}>`); }
    else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) item('ul', m[1]);
    else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) item('ol', m[1]);
    else if ((m = /^>\s?(.*)$/.exec(line))) { flushP(); flushL(); out.push('<blockquote>' + inline(m[1]) + '</blockquote>'); }
    else if (!line.trim()) { flushP(); flushL(); }
    else { flushL(); para.push(line.trim()); }
  }
  if (fence !== null) out.push('<pre><code>' + esc(fence.join('\n')) + '</code></pre>');
  flushP(); flushL(); return out.join('');
}

// ------------------------------------------------------------------ sheet and slides editors (unchanged behaviour)
const sheetEditor = (c) => `<div class="sheet-wrap"><table class="sheet"><thead><tr>${c.columns.map((h, i) => `<th><input data-col="${i}" value="${esc(h)}" aria-label="Column ${i + 1} name"></th>`).join('')}</tr></thead><tbody>${c.rows.map((r, ri) => `<tr>${c.columns.map((_, ci) => `<td><input data-cell="${ri}:${ci}" value="${esc(r[ci] ?? '')}" aria-label="Row ${ri + 1} column ${ci + 1}"></td>`).join('')}</tr>`).join('')}</tbody></table></div>
  <div class="row"><button type="button" class="secondary" id="add-row">Add row</button><button type="button" class="secondary" id="add-col" ${c.columns.length >= 50 ? 'disabled' : ''}>Add column</button></div><p class="muted">Values only: formulas are not supported.</p>`;
const readSheet = (area, c) => {
  const columns = [...area.querySelectorAll('[data-col]')].map((i) => i.value.slice(0, 80));
  const rows = c.rows.map((_, ri) => columns.map((__, ci) => { const raw = area.querySelector(`[data-cell="${ri}:${ci}"]`)?.value ?? ''; return raw === '' ? null : (raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw.slice(0, 1000)); }));
  return { columns, rows };
};
const slidesEditor = (c) => c.slides.map((s, i) => `<fieldset data-slide="${i}"><legend>Slide ${i + 1}</legend><label>Title<input data-f="title" value="${esc(s.title)}" maxlength="200"></label><label>Bullets (one per line)<textarea data-f="bullets" rows="4">${esc(s.bullets.join('\n'))}</textarea></label><label>Speaker notes<textarea data-f="notes" rows="2">${esc(s.notes)}</textarea></label></fieldset>`).join('') + '<button type="button" class="secondary" id="add-slide">Add slide</button>';
const readSlides = (area) => ({ slides: [...area.querySelectorAll('[data-slide]')].map((f) => ({ title: f.querySelector('[data-f=title]').value.slice(0, 200), bullets: f.querySelector('[data-f=bullets]').value.split('\n').map((x) => x.trim().slice(0, 500)).filter(Boolean).slice(0, 20), notes: f.querySelector('[data-f=notes]').value.slice(0, 2000) })) });

// ------------------------------------------------------------------ the page
/** JSON with object keys in a fixed order. PostgreSQL returns jsonb keys in ITS order (shorter first), the page builds them in another, and "has this document changed?" must not depend on that. */
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const store = { get(k, d) { try { return sessionStorage.getItem('qdocs.' + k) ?? d; } catch { return d; } }, set(k, v) { try { sessionStorage.setItem('qdocs.' + k, v); } catch { /* private mode: the page works without it */ } } };

export async function renderSuite(root) {
  ctx = { embedded: false, urls: { home: () => '/app/suite', doc: (id) => '/app/suite?doc=' + id } };
  root.closest('main')?.classList.add('docs-page');       // lets the page's wide tables scroll inside themselves on phones; scoped here so no other portal page's layout changes
  const params = new URLSearchParams(location.search);
  if (params.get('doc')) return renderEditor(root, params.get('doc'));
  return renderHome(root);
}

/** The Workspace's Docs view: this same page, inside the Workspace shell (its sidebar, header, address and breadcrumb trail), in its own shadow root so the portal's stylesheet and
 *  the Workspace's cannot affect each other. It talks to the portal API on this same origin with the person's own session. Returns { open(id), destroy() }: open('') shows the
 *  home, open(id) a document; the Workspace calls open on every #docs/<id> change and destroy() when you leave Docs. */
let generation = 0;                                                      // a newer mount supersedes an older one that is still loading
export async function mountDocsWorkspace(host, { docId = '' } = {}) {
  const gen = ++generation; const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<link rel="stylesheet" href="/app/assets/styles.css"><style>:host{display:block;font:14px/1.5 Inter,ui-sans-serif,system-ui,Arial,sans-serif;color:#16253d}.docs-embed{min-width:0}</style><div class="docs-embed"></div>';
  await new Promise((done) => { const l = shadow.querySelector('link'); const t = setTimeout(done, 4000); const fin = () => { clearTimeout(t); done(); }; if (l.sheet) fin(); else { l.addEventListener('load', fin, { once: true }); l.addEventListener('error', fin, { once: true }); } });
  if (gen !== generation) return { open() {}, destroy() {} };
  const root = shadow.querySelector('.docs-embed'); offs.splice(0).forEach((f) => f());
  ctx = { embedded: true, urls: { home: () => '#docs', doc: (id) => '#docs/' + id } };
  // The Workspace closes the current page on Escape. Inside Docs, Escape belongs to the field or menu you are in, so it must never throw away an open document.
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (root.querySelector('.doc-menu[open]') || /^(INPUT|TEXTAREA|SELECT)$/.test(((e.composedPath && e.composedPath()[0]) || e.target).tagName || ''))) e.stopPropagation(); });
  // Every navigation renders into its OWN container and takes over the screen at once. A page that is still loading its secondary parts (comments, history, the AI panel) when you
  // move on simply finishes in a container nobody can see, so it can neither delay the next page nor write into it.
  let closed = false;
  const open = (id) => {
    if (closed) return Promise.resolve();
    const view = document.createElement('div'); view.className = 'docs-view'; root.replaceChildren(view);
    return (DOC_ID.test(id || '') ? renderEditor(view, id) : renderHome(view))
      .catch((e) => { view.innerHTML = `<div class="empty">Could not load Docs: ${esc(describe(e))}</div>`; });          // an unexpected failure is shown in place and never escapes
  };
  open(docId);                                                         // the first page is STARTED, not waited for: the Workspace can follow route changes from the first moment
  return { open, destroy() { closed = true; offs.splice(0).forEach((f) => f()); root.innerHTML = ''; } };
}

// ================================================================== home
// Layout: view tabs, search + filters, folder chips, THEN the document list, then New document, then one AI assistance area.
// The list is cursor-paged (50 at a time; the Home tab shows the 8 most recent). Rights are applied by the server on every page.
async function renderHome(root) {
  const $ = (s) => root.querySelector(s);
  const stored = store.get('view');
  const st = { view: VIEWS.some((v) => v[0] === stored) ? stored : 'home', folder: store.get('folder', ''), q: '', kind: '' };
  const status = await api('/assistant/status').catch(() => ({ ai_provider_configured: false }));
  const aiOn = !!status.ai_provider_configured;
  const kindOptions = Object.entries(KIND).map(([k, v]) => `<option value="${k}">${v[0]} ${v[1]}</option>`).join('');
  root.innerHTML = `<div class="docs-home">
    <nav class="docs-tabs" aria-label="Document views"><ul id="docs-views"></ul></nav>
    <form id="doc-search" class="docs-search" role="search">
      <label>Search documents<input name="q" type="search" maxlength="200" placeholder="Search by title or content"></label>
      <label>Type<select name="kind" id="doc-kind"><option value="">All types</option>${kindOptions}</select></label>
      <button class="secondary">Search</button><button type="button" id="new-doc">+ New</button></form>
    <div class="docs-folderbar"><ul id="docs-folders" class="chips" aria-label="Folders"></ul>
      <details class="docs-manage"><summary>Manage folders</summary>
        <form id="folder-form"><label>New folder<input name="name" maxlength="120" required></label><button class="secondary">Add folder</button></form>
        <ul id="docs-folder-manage" class="docs-folder-manage"></ul></details></div>
    <h2 id="docs-title" class="docs-h" aria-live="polite"></h2>
    <div id="docs-state" role="status"></div>
    <div id="docs" class="cards docs-list"></div>
    <div class="docs-more"><button type="button" class="secondary" id="docs-more" hidden>Load more documents</button><button type="button" class="secondary" id="docs-viewall" hidden>View all recent documents →</button><span id="docs-count" class="muted"></span></div>
    <div id="docs-new">${panel('New document', `<form id="doc-form" class="row"><label>Type<select name="kind">${kindOptions}</select></label><label>Title<input name="title" required maxlength="200"></label><button>Create</button></form>`)}</div>
    <section class="panel docs-ai" id="docs-ai" aria-labelledby="docs-ai-h"><h2 id="docs-ai-h">AI assistance</h2>
      <p class="muted">Create, summarize, rewrite and translate documents when private AI is available.</p>
      ${aiOn ? '' : '<p class="warn" role="note">AI assistance is turned off until an approved private model is connected. Nothing is simulated.</p>'}
      <form id="ai-form" class="row"><label>Type<select name="kind">${kindOptions}</select></label><label>What should it contain?<textarea name="prompt" required minlength="3" maxlength="4000" rows="2"></textarea></label><button ${aiOn ? '' : 'disabled'}>Draft</button></form>
      <div id="draft-ai-host"></div>
      <p class="muted">AI drafts are starting points. Review them before relying on them.</p></section></div>`;
  const host = $('#draft-ai-host');
  await mountAiPanel(host, { id: 'draft-ai', embedded: true, mode: 'task', tasks: [{ task: 'docs_draft', label: 'Draft a new document', needs: ['text'] }], input: () => ({}), current: () => '',
    newTitle: () => (host.querySelector('[data-ai-text]').value.trim().slice(0, 60) || 'AI draft'), confirmText: () => 'It will be created as a new private document, labelled as AI-assisted.',
    onApplied: (out) => { location.href = ctx.urls.doc(out.id); } });

  let folders = []; let docs = []; let cursor = null; let seq = 0;
  const folderName = (id) => folders.find((f) => f.id === id)?.name;
  const homeMode = () => st.view === 'home' && !st.folder && !st.q && !st.kind;
  const place = (d) => (d.my_role === 'owner' ? 'My Documents' : 'Shared with you') + (d.folder_id && folderName(d.folder_id) ? ' · ' + esc(folderName(d.folder_id)) : '');
  const drawNav = () => {
    $('#docs-views').innerHTML = VIEWS.map(([k, icon, label]) => `<li><button type="button" class="docs-tab" data-view="${k}" ${!st.folder && st.view === k ? 'aria-current="true"' : ''}><span aria-hidden="true">${icon}</span> ${label}</button></li>`).join('');
    $('#docs-folders').innerHTML = `<li><button type="button" class="chip" data-folder-all aria-pressed="${!st.folder}">All folders</button></li><li><button type="button" class="chip" data-folder="none" aria-pressed="${st.folder === 'none'}"><span aria-hidden="true">📂</span> Not in a folder</button></li>` +
      folders.map((f) => `<li><button type="button" class="chip" data-folder="${esc(f.id)}" aria-pressed="${st.folder === f.id}"><span aria-hidden="true">📁</span> ${esc(f.name)} <span class="muted">${esc(f.documents)}</span></button></li>`).join('');
    $('#docs-folder-manage').innerHTML = folders.map((f) => `<li><span>${esc(f.name)}</span> <button type="button" class="linkbtn" data-act="rename-folder" data-id="${esc(f.id)}" aria-label="Rename folder ${esc(f.name)}">Rename</button><button type="button" class="linkbtn" data-act="delete-folder" data-id="${esc(f.id)}" aria-label="Delete folder ${esc(f.name)}">Delete</button></li>`).join('') || '<li class="muted">No folders yet.</li>';
    $('#docs-title').textContent = st.q ? `Results for “${st.q}”` : st.folder ? (st.folder === 'none' ? 'Not in a folder' : folderName(st.folder) || 'Folder') : TITLES[st.view];
  };
  const row = (d) => {
    const trash = st.view === 'trash' && !st.folder; const owner = d.my_role === 'owner';
    const title = trash ? esc(d.title) : `<a class="doc-link" href="${esc(ctx.urls.doc(d.id))}">${esc(d.title)}</a>`;
    return `<article class="card doc-card doc-row" data-doc="${esc(d.id)}"><span class="doc-ico" aria-hidden="true">${KIND[d.kind][0]}</span>
      <div class="doc-main"><h3>${title}${d.template ? ' <span class="pill">template</span>' : ''}</h3><span class="muted">${KIND[d.kind][1]} · ${place(d)} · ${trash ? 'Deleted ' : 'Edited '}${esc(ago(trash ? d.deleted_at : d.updated_at))} · v${esc(d.current_version)}</span></div>
      ${trash ? (owner ? '<button class="secondary" data-act="restore">Restore</button>' : '') : `<button type="button" class="icon-btn" data-act="star" aria-pressed="${d.starred}" aria-label="${d.starred ? 'Remove star from' : 'Star'} ${esc(d.title)}">${d.starred ? '★' : '☆'}</button>
        <details class="doc-menu"><summary aria-label="More actions for ${esc(d.title)}">⋯</summary><div class="doc-menu-items">
          <button type="button" data-act="dup">Duplicate</button>
          ${owner ? `<label class="docs-move">Folder<select data-act="move" aria-label="Folder for ${esc(d.title)}"><option value="">None</option>${folders.map((f) => `<option value="${esc(f.id)}" ${d.folder_id === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
          <button type="button" data-act="template" aria-pressed="${d.template}">${d.template ? 'Not a template' : 'Make template'}</button><button type="button" data-act="trash">Move to trash</button>` : ''}</div></details>`}</article>`;
  };
  const drawList = () => {
    $('#docs').innerHTML = docs.map(row).join('');
    $('#docs-state').innerHTML = docs.length ? '' : `<div class="empty">${esc(st.q || st.kind ? 'No documents match your search.' : st.folder ? 'This folder is empty.' : EMPTY[st.view])}</div>`;
    $('#docs-more').hidden = !cursor || homeMode(); $('#docs-more').disabled = false; $('#docs-viewall').hidden = !(cursor && homeMode());
    $('#docs-count').textContent = docs.length && !homeMode() ? `Showing ${docs.length} document${docs.length === 1 ? '' : 's'}${cursor ? ' (more available)' : ''}` : '';
  };
  const load = async (append = false) => {
    const mine = ++seq;
    if (!append) { $('#docs-state').innerHTML = '<p class="muted">Loading documents…</p>'; $('#docs').innerHTML = ''; $('#docs-more').hidden = true; $('#docs-viewall').hidden = true; }
    const qs = new URLSearchParams({ view: st.folder || st.view === 'home' ? 'recent' : st.view, limit: homeMode() ? '8' : '50' });
    if (st.q) qs.set('q', st.q); if (st.kind) qs.set('kind', st.kind); if (st.folder) qs.set('folder', st.folder); if (append && cursor) qs.set('cursor', cursor);
    try {
      const [page, f] = await Promise.all([apiPaged('/documents?' + qs), append ? folders : api('/document-folders')]);
      if (mine !== seq) return;                                    // a newer request has been made: drop this answer
      docs = append ? docs.concat(page.rows) : page.rows; cursor = page.next; folders = f; drawNav(); drawList();
    } catch (e) {
      if (mine !== seq) return;
      if (append) { notice(describe(e)); $('#docs-more').disabled = false; return; }
      $('#docs-state').innerHTML = `<div class="empty">Could not load documents: ${esc(describe(e))} <button type="button" class="secondary" id="docs-retry">Try again</button></div>`; $('#docs-retry').onclick = () => load();
    }
  };
  const go = (patch) => { Object.assign(st, patch); store.set('view', st.view); store.set('folder', st.folder); return load(); };

  $('#docs-views').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) go({ view: b.dataset.view, folder: '' }); });
  $('.docs-folderbar').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-folder-all')) return go({ folder: '' });
    if (b.dataset.folder) return go({ folder: b.dataset.folder });
    const id = b.dataset.id; const f = folders.find((x) => x.id === id);
    try {
      if (b.dataset.act === 'rename-folder') { const name = prompt('Folder name', f?.name || ''); if (name && name.trim()) { await api('/document-folders/' + id, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) }); await load(); } }
      if (b.dataset.act === 'delete-folder' && confirm(`Delete the folder "${f?.name}"? Its documents are kept.`)) { await api('/document-folders/' + id, { method: 'DELETE' }); if (st.folder === id) st.folder = ''; await go({}); }
    } catch (err) { notice(err.body?.code === 'name_taken' ? 'You already have a folder with that name.' : say(err)); }
  });
  $('#folder-form').onsubmit = async (e) => { e.preventDefault(); const name = new FormData(e.target).get('name').trim(); if (!name) return;
    try { await api('/document-folders', { method: 'POST', body: JSON.stringify({ name }) }); e.target.reset(); notice('Folder added.'); await load(); } catch (err) { notice(err.body?.code === 'name_taken' ? 'You already have a folder with that name.' : err.body?.code === 'folder_limit' ? err.message : err.status === 429 ? 'You are adding folders too quickly. Try again in a minute.' : say(err)); } };
  $('#doc-search').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); const q = f.get('q').trim(); if (q && q.length < 2) { notice('Type at least two characters to search.'); return; } notice(''); go({ q, kind: f.get('kind') }); };
  $('#doc-search [name=q]').addEventListener('input', (e) => { if (e.target.value === '' && st.q) go({ q: '' }); });
  $('#doc-kind').addEventListener('change', () => $('#doc-search').requestSubmit());
  $('#new-doc').addEventListener('click', () => { $('#docs-new').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }); $('#doc-form [name=title]').focus({ preventScroll: true }); });
  $('#docs-more').addEventListener('click', (e) => { e.currentTarget.disabled = true; load(true); });
  $('#docs-viewall').addEventListener('click', () => go({ view: 'recent' }));
  $('#doc-form').onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); const btn = e.target.querySelector('button'); btn.disabled = true;
    try { const d = await api('/documents', { method: 'POST', body: JSON.stringify({ kind: f.kind, title: f.title, idempotency_key: uid() }) }); location.href = ctx.urls.doc(d.id); } catch (err) { notice(err.status === 429 ? 'You are creating documents too quickly. Try again in a minute.' : say(err)); btn.disabled = false; } };
  $('#ai-form').onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); const btn = e.target.querySelector('button'); btn.disabled = true; notice('Drafting…');
    try { const d = await api('/documents/ai-draft', { method: 'POST', body: JSON.stringify({ kind: f.kind, prompt: f.prompt, idempotency_key: uid() }) }); location.href = ctx.urls.doc(d.id); } catch (err) { notice(err.body?.code === 'no_ai_provider' ? 'AI assistance is not available until an approved private model is connected.' : [502, 503].includes(err.status) ? 'The AI service is unavailable right now. Nothing was saved or charged.' : describe(err)); btn.disabled = false; } };
  $('#docs').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return; const id = b.closest('[data-doc]').dataset.doc; const d = docs.find((x) => x.id === id); b.disabled = true; b.closest('details')?.removeAttribute('open');
    try {
      if (b.dataset.act === 'star') { await api('/documents/' + id, { method: 'PATCH', body: JSON.stringify({ starred: !d.starred }) }); await load(); }
      else if (b.dataset.act === 'template') { await api('/documents/' + id, { method: 'PATCH', body: JSON.stringify({ template: !d.template }) }); await load(); }
      else if (b.dataset.act === 'dup') { await api(`/documents/${id}/duplicate`, { method: 'POST', body: '{}' }); notice('A private copy was added to your documents.'); await load(); }
      else if (b.dataset.act === 'trash') { if (confirm('Move this document to the trash? You can restore it from the Trash view.')) { await api('/documents/' + id, { method: 'DELETE' }); notice('Moved to the trash.'); await load(); } else b.disabled = false; }
      else if (b.dataset.act === 'restore') { await api(`/documents/${id}/undelete`, { method: 'POST', body: '{}' }); notice('Document restored.'); await load(); }
    } catch (err) { notice(err.status === 429 ? 'You are making changes too quickly. Try again in a minute.' : say(err)); b.disabled = false; }
  });
  $('#docs').addEventListener('change', async (e) => {
    const s = e.target.closest('select[data-act=move]'); if (!s) return; const id = s.closest('[data-doc]').dataset.doc;
    try { await api(`/documents/${id}/move`, { method: 'POST', body: JSON.stringify({ folder_id: s.value || null }) }); notice('Moved.'); await load(); } catch (err) { notice(say(err)); await load(); }
  });
  listen(document, 'click', (e) => { const from = (e.composedPath && e.composedPath()[0]) || e.target; root.querySelectorAll('.doc-menu[open]').forEach((m) => { if (!m.contains(from)) m.removeAttribute('open'); }); });        // a row menu closes when you click elsewhere
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const m = root.querySelector('.doc-menu[open]'); if (m) { m.removeAttribute('open'); m.querySelector('summary').focus(); e.stopPropagation(); } } });      // Escape that closed a menu is used up: the Workspace must not also close the page
  await load();
}

// ================================================================== editor
const wrapSel = (ta, before, after = before, placeholder = 'text') => {
  const { selectionStart: a, selectionEnd: b, value } = ta; const sel = value.slice(a, b) || placeholder; const text = before + sel + after;
  ta.focus(); ta.setSelectionRange(a, b);
  if (!(document.execCommand && document.execCommand('insertText', false, text))) ta.setRangeText(text, a, b, 'end');   // insertText keeps the browser's undo history
  ta.setSelectionRange(a + before.length, a + before.length + sel.length); ta.dispatchEvent(new Event('input', { bubbles: true }));
};
const prefixLines = (ta, prefix) => {
  const { selectionStart: a, selectionEnd: b, value } = ta; const start = value.lastIndexOf('\n', a - 1) + 1; const endIdx = value.indexOf('\n', b); const end = endIdx === -1 ? value.length : endIdx;
  let n = 0; const text = value.slice(start, end).split('\n').map((l) => (prefix === '1. ' ? `${++n}. ` : prefix) + l).join('\n');
  ta.focus(); ta.setSelectionRange(start, end);
  if (!(document.execCommand && document.execCommand('insertText', false, text))) ta.setRangeText(text, start, end, 'end');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
};
const TOOLS = [['bold', 'B', 'Bold', (t) => wrapSel(t, '**')], ['italic', 'I', 'Italic', (t) => wrapSel(t, '*')], ['heading', 'H', 'Heading', (t) => prefixLines(t, '## ')], ['bullets', '• List', 'Bulleted list', (t) => prefixLines(t, '- ')],
  ['numbers', '1. List', 'Numbered list', (t) => prefixLines(t, '1. ')], ['quote', '❝', 'Quote', (t) => prefixLines(t, '> ')], ['code', '</>', 'Code', (t) => wrapSel(t, '`')]];

async function renderEditor(root, id) {
  const $ = (s) => root.querySelector(s);
  let d; try { d = await api(`/documents/${id}`); } catch (e) { root.innerHTML = `<div class="empty">${e.status === 404 ? 'Document not found, or you do not have access. If you deleted it, you can restore it from the Trash view.' : esc(describe(e))}</div><p><a class="link" href="${esc(ctx.urls.home())}">← Back to documents</a></p>`; return; }
  const [meta, me, folders] = await Promise.all([api(`/documents/${id}/meta`).catch(() => ({ starred: false, template: false, folder_id: null, open_comments: 0 })), api('/me').catch(() => ({})), api('/document-folders').catch(() => [])]);
  const canEdit = ['owner', 'editor'].includes(d.my_role); const owner = d.my_role === 'owner'; let content = d.content; let version = d.current_version; let saved = canon(d.content); let starred = meta.starred;
  const isDoc = d.kind === 'doc';
  root.innerHTML = `<p><a class="link" id="docs-back" href="${esc(ctx.urls.home())}">← All documents</a></p>` + (d.version_source === 'ai' ? '<p class="warn" role="note">This version was drafted by AI. Review it before relying on it.</p>' : '') +
    panel(`${KIND[d.kind][0]} ${esc(d.title)}`, `<p class="muted">${KIND[d.kind][1]} · you are ${esc(d.my_role)} · <span id="doc-version">version ${esc(version)}</span> · <span id="doc-status" role="status">${canEdit ? 'Saved' : 'Read only'}</span></p>
      <div class="row doc-actions"><button type="button" class="secondary" id="doc-star" aria-pressed="${starred}">${starred ? '★ Starred' : '☆ Star'}</button><button type="button" class="secondary" id="doc-dup">Duplicate</button>
        <button type="button" class="secondary" data-export="txt">Export .txt</button>${isDoc ? '<button type="button" class="secondary" data-export="md">Export .md</button>' : ''}
        ${owner ? `<label class="docs-move">Folder<select id="doc-folder"><option value="">None</option>${folders.map((f) => `<option value="${esc(f.id)}" ${meta.folder_id === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label><button type="button" class="secondary" id="del-doc">Move to trash</button>` : ''}</div>
      <label>Title<input id="doc-title" value="${esc(d.title)}" maxlength="200" ${canEdit ? '' : 'disabled'}></label>
      ${isDoc ? `<div class="docs-tools" role="toolbar" aria-label="Formatting">${TOOLS.map(([k, label, name]) => `<button type="button" class="secondary" data-tool="${k}" aria-label="${name}" title="${name}" ${canEdit ? '' : 'disabled'}>${esc(label)}</button>`).join('')}<button type="button" class="secondary" id="toggle-preview" aria-pressed="false">Preview</button><span class="muted" id="doc-count"></span></div>` : ''}
      <div id="editor-area">${isDoc ? `<label>Content<textarea id="doc-text" rows="20" ${canEdit ? '' : 'disabled'}>${esc(content.text)}</textarea></label><div id="doc-preview" class="docs-preview" hidden></div>` : d.kind === 'sheet' ? sheetEditor(content) : slidesEditor(content)}</div>
      ${canEdit ? '<div class="row"><button id="save-doc">Save</button><span class="muted">Ctrl+S saves. Every save is kept as a version.</span></div>' : ''}`) +
    '<div id="ai-host"></div><div id="doc-side"></div>';
  const area = $('#editor-area');
  const collect = () => (isDoc ? { format: 'markdown', text: $('#doc-text').value } : d.kind === 'sheet' ? readSheet(area, content) : readSlides(area));
  const dirty = () => { try { return canon(collect()) !== saved; } catch { return false; } };
  const setStatus = (t) => { $('#doc-status').textContent = t; };
  const mark = () => { if (canEdit) setStatus(dirty() ? 'Unsaved changes' : 'Saved'); };
  const rerender = (c) => { content = c; area.innerHTML = d.kind === 'sheet' ? sheetEditor(c) : slidesEditor(c); wire(); };
  const wire = () => {
    $('#add-row')?.addEventListener('click', () => rerender({ ...readSheet(area, content), rows: [...readSheet(area, content).rows, content.columns.map(() => null)] }));
    $('#add-col')?.addEventListener('click', () => { const c = readSheet(area, content); rerender({ columns: [...c.columns, 'Column ' + (c.columns.length + 1)], rows: c.rows.map((r) => [...r, null]) }); });
    $('#add-slide')?.addEventListener('click', () => { const c = readSlides(area); rerender({ slides: [...c.slides, { title: 'New slide', bullets: [], notes: '' }].slice(0, 100) }); });
  };
  wire(); area.addEventListener('input', mark);

  // Export: the file is fetched with the person's own session (so sign-in, document rights and plan limits are enforced by the server), then either handed to the desktop
  // app's native Save As dialog or downloaded by the browser. There is no shareable download URL and nothing is sent anywhere else.
  const exportDoc = async (ext) => {
    try {
      const r = await fetch(`/api/v1/documents/${encodeURIComponent(id)}/export.${ext}`, { credentials: 'same-origin' });
      if (!r.ok) { notice(r.status === 404 ? 'You no longer have access to this document.' : r.status === 429 ? 'Too many requests. Try again in a minute.' : 'The export could not be created.'); return; }
      const text = await r.text(); const name = (/filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '') || [])[1] || `document.${ext}`;
      const desk = window.qorllaDesktop;
      if (desk && typeof desk.saveDocsExport === 'function') { const out = await desk.saveDocsExport({ filename: name, text }); notice(out?.saved ? 'Export saved.' : out?.canceled ? 'Export canceled.' : 'The file could not be saved.'); return; }
      if (/QorllaMobile/.test(navigator.userAgent)) { notice('Saving exports inside the Android app is not available yet.'); return; }
      const url = URL.createObjectURL(new Blob([text], { type: ext === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch { notice('The export could not be created.'); }
  };
  root.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => exportDoc(b.dataset.export)));

  // Draft recovery (documents only): while you type, the unsaved text is kept in THIS browser, so a refresh, crash or lost connection does not lose it. It is not a server
  // autosave and creates no versions. A draft is only offered back if the document has not changed since it was written; otherwise it is shown for copying, never applied,
  // so it can never silently overwrite someone else's newer version. It is removed when you save or discard it, and after 14 days.
  let dropDraft = () => {};
  if (isDoc && canEdit) {
    const key = 'qdocs.draft.' + id; const TTL = 14 * 24 * 3600 * 1000; const ta = $('#doc-text');
    const get = () => { try { const v = JSON.parse(localStorage.getItem(key) || 'null'); if (v && typeof v.text === 'string' && Date.now() - v.at < TTL) return v; if (v) localStorage.removeItem(key); } catch { /* storage unavailable */ } return null; };
    const put = (text) => { try { localStorage.setItem(key, JSON.stringify({ base: version, text, at: Date.now() })); } catch { /* private mode or full: the page works without it */ } };
    dropDraft = () => { try { localStorage.removeItem(key); } catch { /* nothing to remove */ } };
    const dr = get();
    if (dr && dr.text !== content.text) {
      const same = dr.base === version;
      area.insertAdjacentHTML('beforebegin', `<div class="warn" id="draft-banner" role="alert"><p>We kept unsaved changes from ${esc(when(dr.at))}${same ? '.' : `, but this document has changed since (version ${esc(dr.base)} → ${esc(version)}), so they cannot be put back automatically.`}</p>
        ${same ? '<button type="button" id="draft-restore">Restore my changes</button> ' : `<details><summary>Show my unsaved text so I can copy it</summary><textarea readonly rows="6" aria-label="Your unsaved text">${esc(dr.text)}</textarea></details>`}<button type="button" class="secondary" id="draft-discard">Discard them</button></div>`);
      $('#draft-restore')?.addEventListener('click', () => { ta.value = dr.text; ta.dispatchEvent(new Event('input', { bubbles: true })); $('#draft-banner').remove(); ta.focus(); });
      $('#draft-discard').addEventListener('click', () => { dropDraft(); $('#draft-banner').remove(); });
    }
    let t = null; ta.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { if (ta.value !== JSON.parse(saved).text) put(ta.value); else dropDraft(); }, 600); });
  }
  if (isDoc) {
    const ta = $('#doc-text'); const count = () => { const w = (ta.value.trim().match(/\S+/g) || []).length; $('#doc-count').textContent = `${w} word${w === 1 ? '' : 's'}`; }; count(); ta.addEventListener('input', count);
    root.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => TOOLS.find((t) => t[0] === b.dataset.tool)[3](ta)));
    $('#toggle-preview').addEventListener('click', (e) => { const on = e.currentTarget.getAttribute('aria-pressed') !== 'true'; e.currentTarget.setAttribute('aria-pressed', String(on)); e.currentTarget.textContent = on ? 'Edit' : 'Preview';
      $('#doc-preview').innerHTML = on ? (renderMarkdown(ta.value) || '<p class="muted">Nothing to preview yet.</p>') : ''; $('#doc-preview').hidden = !on; ta.closest('label').hidden = on;
      root.querySelectorAll('[data-tool]').forEach((b) => { b.disabled = on || !canEdit; }); });
  }
  const save = async () => {
    if (!canEdit) return; const btn = $('#save-doc'); btn.disabled = true; setStatus('Saving…');
    try { const next = collect(); const r = await api(`/documents/${id}`, { method: 'PUT', body: JSON.stringify({ base_version: version, content: next }) }); version = r.current_version; saved = canon(next); $('#doc-version').textContent = `version ${version}`; setStatus('Saved'); notice('Saved.'); dropDraft(); await side(); }
    catch (err) { setStatus('Not saved'); notice(err.body?.code === 'version_conflict' ? 'Someone else saved a newer version. Reload to see it - your unsaved edits are still in the page, so copy them first.' : err.body?.code === 'read_only' ? 'You can view but not edit this document.' : describe(err)); }
    finally { btn.disabled = false; }
  };
  $('#save-doc')?.addEventListener('click', save);
  root.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && canEdit) { e.preventDefault(); if (!$('#save-doc').disabled) save(); } });
  $('#docs-back').addEventListener('click', (e) => { if (canEdit && dirty() && !confirm('You have unsaved changes. Leave without saving?')) e.preventDefault(); });
  $('#doc-title').addEventListener('change', async (e) => {
    const title = e.target.value.trim(); if (!title) { e.target.value = d.title; return; }
    try { await api('/documents/' + id, { method: 'PATCH', body: JSON.stringify({ title }) }); d.title = title; notice('Renamed.'); } catch (err) { e.target.value = d.title; notice(say(err)); }
  });
  $('#doc-star').addEventListener('click', async (e) => { const btn = e.currentTarget; /* captured before the await: the browser clears currentTarget once the handler yields */ try { starred = !starred; await api('/documents/' + id, { method: 'PATCH', body: JSON.stringify({ starred }) }); btn.setAttribute('aria-pressed', String(starred)); btn.textContent = starred ? '★ Starred' : '☆ Star'; } catch (err) { starred = !starred; notice(say(err)); } });
  $('#doc-dup').addEventListener('click', async (e) => { const btn = e.currentTarget; /* captured before the await: the browser clears currentTarget once the handler yields */ btn.disabled = true; try { const c = await api(`/documents/${id}/duplicate`, { method: 'POST', body: '{}' }); location.href = ctx.urls.doc(c.id); } catch (err) { notice(say(err)); btn.disabled = false; } });
  $('#doc-folder')?.addEventListener('change', async (e) => { try { await api(`/documents/${id}/move`, { method: 'POST', body: JSON.stringify({ folder_id: e.target.value || null }) }); notice('Moved.'); } catch (err) { notice(say(err)); } });
  $('#del-doc')?.addEventListener('click', async () => { if (!confirm('Move this document to the trash? You can restore it from the Trash view.')) return; try { await api(`/documents/${id}`, { method: 'DELETE' }); location.href = ctx.urls.home(); } catch (err) { notice(say(err)); } });

  const side = async () => {
    const box = $('#doc-side'); const [versions, comments, members, ent] = await Promise.all([api(`/documents/${id}/versions`), api(`/documents/${id}/comments`).catch(() => []), api('/members').catch(() => []), api('/entitlements').catch(() => null)]);
    const commentsOn = !ent?.features || 'documents.comments' in ent.features;      // the page mirrors the plan; the server decides (403 entitlement_required)
    const name = (u) => (u === me.user_id ? 'You' : members.find((m) => m.user_id === u)?.display_name || 'A workspace member');
    let share = '';
    if (owner) {
      const perm = await api(`/documents/${id}/permissions`); const roleOf = (u) => perm.users.find((x) => x.user_id === u)?.role || '';
      share = panel('Sharing', `<form id="share-form"><label>Workspace access<select name="general"><option value="restricted" ${perm.general_access === 'restricted' ? 'selected' : ''}>Restricted (only people below)</option><option value="workspace_view" ${perm.general_access === 'workspace_view' ? 'selected' : ''}>Everyone in the workspace can view</option><option value="workspace_edit" ${perm.general_access === 'workspace_edit' ? 'selected' : ''}>Everyone in the workspace can edit</option></select></label>
        <div class="docs-table"><table><thead><tr><th>Member</th><th>Access</th></tr></thead><tbody>${members.filter((m) => m.user_id !== d.owner_id).map((m) => `<tr><td>${esc(m.display_name || 'Workspace member')} <code>${esc(m.user_id)}</code></td><td><select data-user="${esc(m.user_id)}" aria-label="Access for ${esc(m.display_name || m.user_id)}"><option value="">No access</option><option value="viewer" ${roleOf(m.user_id) === 'viewer' ? 'selected' : ''}>Viewer</option><option value="editor" ${roleOf(m.user_id) === 'editor' ? 'selected' : ''}>Editor</option></select></td></tr>`).join('')}</tbody></table></div><button>Save sharing</button></form>`);
    }
    const open = comments.filter((c) => !c.resolved_at); const done = comments.filter((c) => c.resolved_at);
    const cm = (c) => `<li data-comment="${esc(c.id)}"><strong>${esc(name(c.author_id))}</strong> <span class="muted">${esc(when(c.created_at))}</span><p class="docs-comment">${esc(c.body)}</p>${!c.resolved_at && canEdit ? '<button type="button" class="secondary" data-act="resolve-comment">Resolve</button>' : c.resolved_at ? '<span class="muted">Resolved</span>' : ''}</li>`;
    const comm = panel(`Comments${open.length ? ` (${open.length})` : ''}`, `${canEdit && commentsOn ? '<form id="comment-form"><label>Add a comment<textarea name="body" rows="2" maxlength="4000" required></textarea></label><button class="secondary">Add comment</button></form>' : `<p class="muted">${canEdit ? 'Comments are not included in your plan.' : 'You can read comments but not add them.'}</p>`}
      <ul class="docs-comments" id="doc-comments">${open.length ? open.map(cm).join('') : '<li class="muted">No open comments.</li>'}</ul>${done.length ? `<details><summary>${done.length} resolved</summary><ul class="docs-comments">${done.map(cm).join('')}</ul></details>` : ''}`);
    box.innerHTML = share + comm + panel('Version history', `<div class="docs-table"><table><thead><tr><th>Version</th><th>When</th><th>Source</th><th></th></tr></thead><tbody>${versions.map((v) => `<tr data-v="${esc(v.version_no)}"><td>v${esc(v.version_no)}</td><td>${esc(when(v.created_at))}</td><td>${esc(v.source)}${v.note ? ' · ' + esc(v.note) : ''}</td><td>${canEdit && v.version_no !== version ? '<button class="secondary" data-act="restore">Restore as new version</button>' : ''}</td></tr>`).join('')}</tbody></table></div>`);
    $('#share-form')?.addEventListener('submit', async (e) => {
      e.preventDefault(); const users = [...e.target.querySelectorAll('[data-user]')].filter((s) => s.value).map((s) => ({ user_id: s.dataset.user, role: s.value }));
      try { await api(`/documents/${id}/permissions`, { method: 'PUT', body: JSON.stringify({ general_access: e.target.elements.general.value, users }) }); notice('Sharing updated.'); } catch (err) { notice(say(err)); }
    });
    $('#comment-form')?.addEventListener('submit', async (e) => { e.preventDefault(); const body = new FormData(e.target).get('body').trim(); if (!body) return;
      try { await api(`/documents/${id}/comments`, { method: 'POST', body: JSON.stringify({ body }) }); notice('Comment added.'); await side(); } catch (err) { notice(say(err)); } });
    box.querySelectorAll('[data-act=resolve-comment]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/documents/${id}/comments/${b.closest('[data-comment]').dataset.comment}/resolve`, { method: 'POST', body: '{}' }); await side(); } catch (err) { notice(say(err)); } }));
    box.querySelectorAll('[data-act=restore]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/documents/${id}/restore`, { method: 'POST', body: JSON.stringify({ version_no: Number(b.closest('tr').dataset.v), base_version: version }) }); await renderEditor(root, id); } catch (err) { notice(err.body?.code === 'version_conflict' ? 'The document changed meanwhile. Reload and try again.' : describe(err)); } }));
  };
  await side();
  // Qorlla AI works from the last SAVED version, previews first, and applies only after confirmation (the server re-checks permission and version).
  const TASKS = { doc: [{ task: 'docs_rewrite', label: 'Rewrite' }, { task: 'docs_improve', label: 'Improve' }, { task: 'docs_proofread', label: 'Proofread' }, { task: 'docs_summarize', label: 'Summarize (add to the end)' }, { task: 'docs_translate', label: 'Translate', needs: ['language'] }],
    sheet: [{ task: 'sheets_insights', label: 'Analyze the data' }, { task: 'sheets_formula', label: 'Suggest a formula' }, { task: 'sheets_chart', label: 'Recommend a chart' }], slides: [{ task: 'slides_outline', label: 'Outline (add slides)' }, { task: 'slides_notes', label: 'Speaker notes' }] };
  const savedText = () => { const c = JSON.parse(saved); return d.kind === 'doc' ? c.text : d.kind === 'slides' ? c.slides.map((s) => s.title).join('\n') : ''; };
  await mountAiPanel($('#ai-host'), { id: 'doc-ai', mode: 'task', tasks: TASKS[d.kind], input: () => ({ document_id: id }), current: savedText,
    after: (r) => (r.apply?.mode === 'append' ? savedText() + (savedText() ? '\n\n' : '') + '## Summary (Qorlla AI)\n\n' + r.suggestion : r.apply?.mode === 'append_slides' ? savedText() + '\n' + r.suggestion.split('\n').map((l) => l.replace(/^\s*(?:[-*#]+|\d+[.)])\s*/, '').trim()).filter(Boolean).join('\n') : r.suggestion),
    confirmText: () => `It will be saved as version ${version + 1} of this ${KIND[d.kind][1].toLowerCase()}, labelled as AI-assisted; version ${version} stays in the history.${dirty() ? ' You have unsaved edits on this page; they will be replaced.' : ''}`,
    onApplied: async () => { await renderEditor(root, id); notice('Applied. The previous version is kept in the version history.'); } });
}
