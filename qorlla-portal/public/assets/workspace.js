// Notes, QorllaMate and the productivity suite (Docs / Sheets / Slides). All text is escaped; AI output is shown as plain text only.
import { $, esc, api, notice, describe, panel } from './core.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '-');
const pill = (s) => `<span class="pill ${esc(s)}">${esc(s)}</span>`;
const KIND = { doc: ['📄', 'Document'], sheet: ['📊', 'Sheet'], slides: ['🎞️', 'Slides'] };

// ------------------------------------------------------------------ notes (ids kept: #note-form, #note-quota, #notes)
export async function renderNotes() {
  const root = $('#notes-root');
  const state = { q: '', notebook: '' };
  const draw = async () => {
    const qs = new URLSearchParams(); if (state.q) qs.set('q', state.q); if (state.notebook) qs.set('notebook_id', state.notebook);
    const [items, books, usage, count] = await Promise.all([api('/notes' + (qs.size ? '?' + qs : '')), api('/notebooks'), api('/entitlements').catch(() => null), api('/notes/usage').catch(() => ({ used: null }))]);
    const nq = usage?.features?.['notes.max'];
    root.innerHTML = panel('New note', `<p id="note-quota" class="muted">${nq ? (nq.unlimited ? 'Unlimited notes on your plan.' : `${esc(count.used ?? items.length)} of ${esc(nq.quota)} notes used on your plan.`) : ''}</p>
      <form id="note-form"><label>Title<input name="title" required maxlength="160"></label><label>Content<textarea name="body"></textarea></label>
      <div class="row"><label>Visible to<select name="visibility"><option value="private">Only me</option><option value="workspace">Everyone in this workspace</option></select></label><label>Notebook<select name="notebook_id"><option value="">None</option>${books.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select></label></div><button>Save Note</button></form>`) +
      panel('Find notes', `<div class="row"><label>Search<input id="note-search" type="search" value="${esc(state.q)}" placeholder="Search your notes"></label><label>Notebook<select id="note-filter"><option value="">All</option>${books.map((b) => `<option value="${esc(b.id)}" ${state.notebook === b.id ? 'selected' : ''}>${esc(b.name)} (${esc(b.notes)})</option>`).join('')}</select></label></div>
      <form id="nb-form" class="row"><label>New notebook<input name="name" maxlength="120" required></label><button class="secondary">Create notebook</button></form>`) +
      `<div id="notes" class="cards">${items.length ? items.map((x) => `<article class="card" data-note="${esc(x.id)}"><h3>${x.pinned ? '📌 ' : ''}${esc(x.title)}</h3><p>${esc(x.body)}</p><span class="muted">${esc(when(x.updated_at))} · ${x.visibility === 'private' ? 'only you' : 'workspace'}${x.source === 'assistant' ? ' · by QorllaMate' : ''}</span>
        <div class="row"><button class="secondary" data-act="pin">${x.pinned ? 'Unpin' : 'Pin'}</button><button class="secondary" data-act="del">Delete</button></div></article>`).join('') : '<div class="empty">No notes yet.</div>'}</div>`;
    $('#note-form').onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { await api('/notes', { method: 'POST', body: JSON.stringify({ title: f.title, body: f.body, visibility: f.visibility, notebook_id: f.notebook_id || null }) }); notice('Note saved.'); await draw(); } catch (err) { notice(describe(err)); } };
    $('#nb-form').onsubmit = async (e) => { e.preventDefault(); try { await api('/notebooks', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); await draw(); } catch (err) { notice(err.body?.code === 'name_taken' ? 'You already have a notebook with that name.' : describe(err)); } };
    $('#note-search').addEventListener('change', (e) => { state.q = e.target.value.trim(); draw(); });
    $('#note-filter').addEventListener('change', (e) => { state.notebook = e.target.value; draw(); });
    root.querySelectorAll('[data-note] [data-act]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('[data-note]').dataset.note;
      try { if (b.dataset.act === 'del') { if (!confirm('Delete this note?')) return; await api(`/notes/${id}`, { method: 'DELETE' }); } else { const cur = items.find((n) => n.id === id); await api(`/notes/${id}`, { method: 'PATCH', body: JSON.stringify({ pinned: !cur.pinned }) }); } await draw(); } catch (err) { notice(describe(err)); }
    }));
  };
  await draw();
}

// ------------------------------------------------------------------ QorllaMate
export async function renderMate(root) {
  let current = null;
  const draw = async () => {
    const [status, threads] = await Promise.all([api('/assistant/status'), api('/assistant/threads')]);
    const t = current ? await api(`/assistant/threads/${current}`).catch(() => null) : null; if (!t) current = null;
    root.innerHTML = (status.ai_provider_configured ? '' : '<p class="warn" role="alert">No AI provider is configured on this server, so QorllaMate cannot answer. Nothing is simulated.</p>') +
      `<p class="muted" id="mate-note">${esc(status.note)} ${status.messages_limit == null ? '' : `<span id="mate-quota">${esc(status.messages_used)} of ${esc(status.messages_limit)}</span> messages used this month.`}</p>` +
      panel('Conversations', `<div class="row">${threads.map((x) => `<button class="${x.id === current ? '' : 'secondary'}" data-thread="${esc(x.id)}">${esc(x.title)}</button>`).join('')}<button id="new-thread" class="secondary">+ New conversation</button></div>`) +
      (t ? panel(t.title, `<div id="mate-log">${t.messages.map((m) => `<p class="msg ${esc(m.role)}"><strong>${m.role === 'user' ? 'You' : 'QorllaMate'}:</strong> ${esc(m.content)}</p>`).join('') || '<div class="empty">Ask something.</div>'}</div>
        ${t.tasks.length ? `<h3>Proposed actions</h3><p class="muted">QorllaMate can only propose. Nothing happens until you approve it.</p>${t.tasks.map((k) => `<div class="card" data-task="${esc(k.id)}"><strong>${esc(k.title)}</strong> ${pill(k.status)} <span class="muted">${esc(k.kind.replace('_', ' '))}${k.external ? ' · external' : ''}</span>
          <p>${esc(k.kind === 'send_email' ? `To ${k.payload.to}: ${k.payload.subject}` : (k.payload.body ?? k.payload.text ?? '').slice(0, 300))}</p>
          ${k.status === 'proposed' ? '<div class="row"><button data-act="approve">Approve</button><button class="secondary" data-act="reject">Reject</button></div>' : k.status === 'blocked' ? '<p class="warn">Blocked: no mail provider is configured. Nothing was sent.</p>' : ''}</div>`).join('')}` : ''}
        <form id="mate-form" class="row"><label>Message<textarea name="content" required maxlength="4000" rows="3"></textarea></label><button ${status.ai_provider_configured ? '' : 'disabled'}>Send</button></form>`) : '');
    root.querySelectorAll('[data-thread]').forEach((b) => b.addEventListener('click', () => { current = b.dataset.thread; draw(); }));
    $('#new-thread').onclick = async () => { try { current = (await api('/assistant/threads', { method: 'POST', body: '{}' })).id; await draw(); } catch (e) { notice(describe(e)); } };
    $('#mate-form')?.addEventListener('submit', async (e) => {
      e.preventDefault(); const btn = e.target.querySelector('button'); btn.disabled = true; const content = e.target.elements.content.value;
      try { await api(`/assistant/threads/${current}/messages`, { method: 'POST', body: JSON.stringify({ content, idempotency_key: uid() }) }); await draw(); }
      catch (err) { notice(err.body?.code === 'no_ai_provider' ? 'No AI provider is configured.' : err.status === 503 || err.status === 502 ? 'The AI service is unavailable right now. Nothing was saved or charged - please try again.' : describe(err)); btn.disabled = false; }
    });
    root.querySelectorAll('[data-task] [data-act]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('[data-task]').dataset.task;
      try { const r = await api(`/assistant/tasks/${id}/${b.dataset.act}`, { method: 'POST', body: '{}' }); notice(r.status === 'executed' ? 'Done.' : 'Rejected.'); }
      catch (err) { notice(err.body?.code === 'no_email_provider' ? 'Sending email is not available: no mail provider is configured. Nothing was sent.' : err.body?.code === 'expired' ? 'That proposal is too old. Ask again.' : describe(err)); }
      await draw();
    }));
  };
  await draw();
}

// ------------------------------------------------------------------ suite: documents, sheets, slides
const sheetEditor = (c) => `<div class="sheet-wrap"><table class="sheet"><thead><tr>${c.columns.map((h, i) => `<th><input data-col="${i}" value="${esc(h)}" aria-label="Column ${i + 1} name"></th>`).join('')}</tr></thead><tbody>${c.rows.map((r, ri) => `<tr>${c.columns.map((_, ci) => `<td><input data-cell="${ri}:${ci}" value="${esc(r[ci] ?? '')}" aria-label="Row ${ri + 1} column ${ci + 1}"></td>`).join('')}</tr>`).join('')}</tbody></table></div>
  <div class="row"><button type="button" class="secondary" id="add-row">Add row</button><button type="button" class="secondary" id="add-col" ${c.columns.length >= 50 ? 'disabled' : ''}>Add column</button></div><p class="muted">Values only: formulas are not supported.</p>`;
const readSheet = (area, c) => {
  const columns = [...area.querySelectorAll('[data-col]')].map((i) => i.value.slice(0, 80));
  const rows = c.rows.map((_, ri) => columns.map((__, ci) => { const raw = area.querySelector(`[data-cell="${ri}:${ci}"]`)?.value ?? ''; return raw === '' ? null : (raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw.slice(0, 1000)); }));
  return { columns, rows };
};
const slidesEditor = (c) => c.slides.map((s, i) => `<fieldset data-slide="${i}"><legend>Slide ${i + 1}</legend><label>Title<input data-f="title" value="${esc(s.title)}" maxlength="200"></label><label>Bullets (one per line)<textarea data-f="bullets" rows="4">${esc(s.bullets.join('\n'))}</textarea></label><label>Speaker notes<textarea data-f="notes" rows="2">${esc(s.notes)}</textarea></label></fieldset>`).join('') + '<button type="button" class="secondary" id="add-slide">Add slide</button>';
const readSlides = (area) => ({ slides: [...area.querySelectorAll('[data-slide]')].map((f) => ({ title: f.querySelector('[data-f=title]').value.slice(0, 200), bullets: f.querySelector('[data-f=bullets]').value.split('\n').map((x) => x.trim().slice(0, 500)).filter(Boolean).slice(0, 20), notes: f.querySelector('[data-f=notes]').value.slice(0, 2000) })) });

export async function renderSuite(root) {
  const params = new URLSearchParams(location.search);
  if (params.get('doc')) return renderEditor(root, params.get('doc'));
  const [docs, status] = await Promise.all([api('/documents'), api('/assistant/status').catch(() => ({ ai_provider_configured: false }))]);
  root.innerHTML = panel('Create', `<form id="doc-form" class="row"><label>Type<select name="kind">${Object.entries(KIND).map(([k, v]) => `<option value="${k}">${v[0]} ${v[1]}</option>`).join('')}</select></label><label>Title<input name="title" required maxlength="200"></label><button>Create</button></form>`) +
    panel('Draft with AI', `${status.ai_provider_configured ? '' : '<p class="warn">No AI provider is configured on this server; drafting is unavailable.</p>'}<form id="ai-form" class="row"><label>Type<select name="kind">${Object.entries(KIND).map(([k, v]) => `<option value="${k}">${v[0]} ${v[1]}</option>`).join('')}</select></label><label>What should it contain?<textarea name="prompt" required minlength="3" maxlength="4000" rows="2"></textarea></label><button ${status.ai_provider_configured ? '' : 'disabled'}>Draft</button></form><p class="muted">AI drafts are starting points. Review them before relying on them.</p>`) +
    panel('Search', '<form id="doc-search" class="row"><label>Search documents<input name="q" type="search"></label><button class="secondary">Search</button></form>') +
    `<div id="docs" class="cards">${docs.length ? docs.map((d) => `<article class="card"><div class="emoji" aria-hidden="true">${KIND[d.kind][0]}</div><h3>${esc(d.title)}</h3><span class="muted">${KIND[d.kind][1]} · ${esc(d.my_role)} · v${esc(d.current_version)} · ${esc(when(d.updated_at))}</span><a class="link" href="/app/suite?doc=${esc(d.id)}">Open →</a></article>`).join('') : '<div class="empty">No documents yet.</div>'}</div>`;
  $('#doc-form').onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { const d = await api('/documents', { method: 'POST', body: JSON.stringify({ kind: f.kind, title: f.title, idempotency_key: uid() }) }); location.href = `/app/suite?doc=${d.id}`; } catch (err) { notice(describe(err)); } };
  $('#ai-form').onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); const btn = e.target.querySelector('button'); btn.disabled = true; notice('Drafting…');
    try { const d = await api('/documents/ai-draft', { method: 'POST', body: JSON.stringify({ kind: f.kind, prompt: f.prompt, idempotency_key: uid() }) }); location.href = `/app/suite?doc=${d.id}`; } catch (err) { notice(err.body?.code === 'no_ai_provider' ? 'No AI provider is configured.' : [502, 503].includes(err.status) ? 'The AI service is unavailable right now. Nothing was saved or charged.' : describe(err)); btn.disabled = false; } };
  $('#doc-search').onsubmit = async (e) => { e.preventDefault(); const q = new FormData(e.target).get('q').trim(); if (q.length < 2) return; try { const r = await api('/search?q=' + encodeURIComponent(q)); $('#docs').innerHTML = r.length ? r.map((x) => `<article class="card"><h3>${esc(x.title)}</h3><p>${esc(x.excerpt || '')}</p><span class="muted">${esc(x.type)}</span> ${x.type === 'note' ? '<a class="link" href="/app/notes">Notes →</a>' : `<a class="link" href="/app/suite?doc=${esc(x.id)}">Open →</a>`}</article>`).join('') : '<div class="empty">No matches.</div>'; } catch (err) { notice(describe(err)); } };
}

async function renderEditor(root, id) {
  let d; try { d = await api(`/documents/${id}`); } catch (e) { root.innerHTML = `<div class="empty">${e.status === 404 ? 'Document not found, or you do not have access.' : esc(describe(e))}</div><p><a class="link" href="/app/suite">← Back to documents</a></p>`; return; }
  const canEdit = ['owner', 'editor'].includes(d.my_role); let content = d.content; let version = d.current_version;
  root.innerHTML = `<p><a class="link" href="/app/suite">← All documents</a></p>` + (d.version_source === 'ai' ? '<p class="warn" role="note">This version was drafted by AI. Review it before relying on it.</p>' : '') +
    panel(`${KIND[d.kind][0]} ${esc(d.title)}`, `<p class="muted">${KIND[d.kind][1]} · you are ${esc(d.my_role)} · <span id="doc-version">version ${esc(version)}</span></p>${canEdit ? '' : '<p class="muted">Read only.</p>'}
      <label>Title<input id="doc-title" value="${esc(d.title)}" maxlength="200" ${canEdit ? '' : 'disabled'}></label>
      <div id="editor-area">${d.kind === 'doc' ? `<label>Content<textarea id="doc-text" rows="18" ${canEdit ? '' : 'disabled'}>${esc(content.text)}</textarea></label>` : d.kind === 'sheet' ? sheetEditor(content) : slidesEditor(content)}</div>
      ${canEdit ? '<div class="row"><button id="save-doc">Save</button></div>' : ''}`) +
    '<div id="doc-side"></div>';
  const area = $('#editor-area');
  const collect = () => (d.kind === 'doc' ? { format: 'markdown', text: $('#doc-text').value } : d.kind === 'sheet' ? readSheet(area, content) : readSlides(area));
  const rerender = (c) => { content = c; area.innerHTML = d.kind === 'sheet' ? sheetEditor(c) : slidesEditor(c); wire(); };
  const wire = () => {
    $('#add-row')?.addEventListener('click', () => rerender({ ...readSheet(area, content), rows: [...readSheet(area, content).rows, content.columns.map(() => null)] }));
    $('#add-col')?.addEventListener('click', () => { const c = readSheet(area, content); rerender({ columns: [...c.columns, 'Column ' + (c.columns.length + 1)], rows: c.rows.map((r) => [...r, null]) }); });
    $('#add-slide')?.addEventListener('click', () => { const c = readSlides(area); rerender({ slides: [...c.slides, { title: 'New slide', bullets: [], notes: '' }].slice(0, 100) }); });
  };
  wire();
  $('#save-doc')?.addEventListener('click', async () => {
    try { const r = await api(`/documents/${id}`, { method: 'PUT', body: JSON.stringify({ base_version: version, content: collect(), title: $('#doc-title').value.trim() || d.title }) }); version = r.current_version; $('#doc-version').textContent = `version ${version}`; notice('Saved.'); await side(); }
    catch (err) { notice(err.body?.code === 'version_conflict' ? 'Someone else saved a newer version. Reload to see it - your unsaved edits are still in the page, so copy them first.' : err.body?.code === 'read_only' ? 'You can view but not edit this document.' : describe(err)); }
  });
  const side = async () => {
    const box = $('#doc-side'); const versions = await api(`/documents/${id}/versions`);
    let share = '';
    if (d.my_role === 'owner') {
      const [perm, members] = await Promise.all([api(`/documents/${id}/permissions`), api('/members')]);
      const roleOf = (uid_) => perm.users.find((u) => u.user_id === uid_)?.role || '';
      share = panel('Sharing', `<form id="share-form"><label>Workspace access<select name="general"><option value="restricted" ${perm.general_access === 'restricted' ? 'selected' : ''}>Restricted (only people below)</option><option value="workspace_view" ${perm.general_access === 'workspace_view' ? 'selected' : ''}>Everyone in the workspace can view</option><option value="workspace_edit" ${perm.general_access === 'workspace_edit' ? 'selected' : ''}>Everyone in the workspace can edit</option></select></label>
        <table><thead><tr><th>Member</th><th>Access</th></tr></thead><tbody>${members.filter((m) => m.user_id !== d.owner_id).map((m) => `<tr><td><code>${esc(m.user_id)}</code></td><td><select data-user="${esc(m.user_id)}" aria-label="Access for ${esc(m.user_id)}"><option value="">No access</option><option value="viewer" ${roleOf(m.user_id) === 'viewer' ? 'selected' : ''}>Viewer</option><option value="editor" ${roleOf(m.user_id) === 'editor' ? 'selected' : ''}>Editor</option></select></td></tr>`).join('')}</tbody></table><button>Save sharing</button></form>`);
    }
    box.innerHTML = share + panel('Version history', `<table><thead><tr><th>Version</th><th>When</th><th>Source</th><th></th></tr></thead><tbody>${versions.map((v) => `<tr data-v="${esc(v.version_no)}"><td>v${esc(v.version_no)}</td><td>${esc(when(v.created_at))}</td><td>${esc(v.source)}${v.note ? ' · ' + esc(v.note) : ''}</td><td>${canEdit && v.version_no !== version ? '<button class="secondary" data-act="restore">Restore as new version</button>' : ''}</td></tr>`).join('')}</tbody></table>`) +
      (d.my_role === 'owner' ? '<p><button id="del-doc" class="secondary">Delete this document</button></p>' : '');
    $('#share-form')?.addEventListener('submit', async (e) => {
      e.preventDefault(); const users = [...e.target.querySelectorAll('[data-user]')].filter((s) => s.value).map((s) => ({ user_id: s.dataset.user, role: s.value }));
      try { await api(`/documents/${id}/permissions`, { method: 'PUT', body: JSON.stringify({ general_access: e.target.elements.general.value, users }) }); notice('Sharing updated.'); } catch (err) { notice(describe(err)); }
    });
    box.querySelectorAll('[data-act=restore]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/documents/${id}/restore`, { method: 'POST', body: JSON.stringify({ version_no: Number(b.closest('tr').dataset.v), base_version: version }) }); location.reload(); } catch (err) { notice(err.body?.code === 'version_conflict' ? 'The document changed meanwhile. Reload and try again.' : describe(err)); } }));
    $('#del-doc')?.addEventListener('click', async () => { if (!confirm('Delete this document?')) return; try { await api(`/documents/${id}`, { method: 'DELETE' }); location.href = '/app/suite'; } catch (err) { notice(describe(err)); } });
  };
  await side();
}
