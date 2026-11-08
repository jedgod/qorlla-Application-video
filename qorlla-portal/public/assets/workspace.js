// Notes and QorllaMate. The Docs page (documents, sheets, slides) lives in docs-page.js and is re-exported here for app.js. All text is escaped; AI output is shown as plain text only.
import { $, esc, api, notice, describe, panel } from './core.js';
import { mountAiPanel } from './ai-panel.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '-');
const pill = (s) => `<span class="pill ${esc(s)}">${esc(s)}</span>`;

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
  let host = document.getElementById('mate-ai-host'); if (!host) { host = document.createElement('div'); host.id = 'mate-ai-host'; root.after(host); }
  await mountAiPanel(host, { id: 'mate-ai', mode: 'chat', current: () => '' });
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

export { renderSuite } from './docs-page.js';
