// Qorlla Meet sidebar: structured notes (autosave, history, edit access), polls (server-authoritative), and the More tool groups.
// Everything is validated again on the server; this file only presents it. Nothing here is mock data.
export function initCollab(h) {
  const { state, BASE, notify, announce, rcModal, rcClose, rcEl, askConfirm, hostPanel } = h;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text, attrs) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, 'x');
  const stamp = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  const elapsed = () => Math.max(0, Math.round((Date.now() - (state.start || Date.now())) / 1000));
  const call = async (path, method = 'GET', body, raw) => {
    const r = await fetch(BASE + 'api/v1/meetings/' + state.meetingId + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (raw) { if (!r.ok) throw Object.assign(Error('Request failed'), { status: r.status }); return r; }
    const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(Error(d.error || 'Request failed'), { status: r.status, data: d }); return d;
  };
  const download = (name, text, type) => { const u = URL.createObjectURL(new Blob([text], { type })), a = el('a'); a.href = u; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 20000); };
  const code = () => ($('roomId')?.textContent || 'meeting').replace(/\W+/g, '');

  // =================================================================================================================================== NOTES
  const N = { doc: { template: '', agenda: [], notes: '', decisions: [], tasks: [] }, version: 0, canEdit: false, isHost: false, ended: false, editors: [], room: null, dirty: new Set(), pending: new Set(), saving: false, again: false, timer: 0, retry: 0, offline: false, loaded: false };
  const TEMPLATES = {
    blank: { label: 'Blank', agenda: [], notes: '' },
    agenda: { label: 'Agenda', agenda: ['Welcome and introductions', 'Main topics', 'Questions', 'Next steps'], notes: '' },
    minutes: { label: 'Meeting minutes', agenda: ['Call to order', 'Attendance', 'Previous minutes', 'Business', 'Adjournment'], notes: 'Attendees:\n\nDiscussion:\n' },
    brainstorm: { label: 'Brainstorming', agenda: ['Define the problem', 'Share ideas', 'Group and vote', 'Pick next steps'], notes: 'Ideas:\n- \n' },
    lecture: { label: 'Lecture', agenda: ['Learning goals', 'Lecture', 'Discussion', 'Questions', 'Summary'], notes: 'Key concepts:\n- \n\nFollow-up questions:\n- ' },
    project: { label: 'Project review', agenda: ['Project status review', 'Risks and blockers', 'Discuss next milestone', 'Assign responsibilities'], notes: 'Status:\n\nRisks:\n' },
  };
  function docToMarkdown(d) {
    const out = ['# Meeting notes — ' + ($('roomTitle')?.textContent || 'Meeting'), ''];
    out.push('## Agenda', ...(d.agenda.length ? d.agenda.map((a) => '- [' + (a.done ? 'x' : ' ') + '] ' + a.text) : ['_none_']), '', '## Notes', d.notes || '_none_', '');
    out.push('## Key decisions', ...(d.decisions.length ? d.decisions.map((x) => '- ' + x.text + (x.owner ? ' (owner: ' + x.owner + ')' : '') + (x.at ? ' [' + stamp(x.at) + ']' : '')) : ['_none_']), '');
    out.push('## Action items', ...(d.tasks.length ? d.tasks.map((t) => '- [' + (t.status === 'done' ? 'x' : ' ') + '] ' + t.text + (t.owner ? ' — ' + t.owner : '') + (t.due ? ', due ' + t.due : '') + (t.at ? ' [' + stamp(t.at) + ']' : '')) : ['_none_']), '');
    return out.join('\n');
  }
  const stripMd = (m) => m.replace(/^#+\s*/gm, '').replace(/_none_/g, '(none)');

  function buildNotes() {
    const t = $('tab-notes'); t.textContent = '';
    const head = el('div', 'nt-head'); head.append(el('h3', '', 'Meeting notes'), el('span', 'chip', '', { id: 'notesRole' }), el('span', 'nt-status', '', { id: 'notesStatus' })); t.append(head);
    const bar = el('div', 'nt-bar');
    const tpl = el('select', '', '', { id: 'notesTemplate', 'aria-label': 'Apply a template' }); tpl.append(new Option('Template…', '')); for (const [k, v] of Object.entries(TEMPLATES)) tpl.append(new Option(v.label, k));
    const hist = el('button', '', 'Version history', { id: 'notesHistory' }), snap = el('button', '', 'Save version', { id: 'notesSnap' }), share = el('button', '', 'Edit access', { id: 'notesShare' });
    const exp = el('select', '', '', { id: 'notesExport', 'aria-label': 'Export notes' }); exp.append(new Option('Export…', ''), new Option('Markdown (.md)', 'md'), new Option('Plain text (.txt)', 'txt'), new Option('Copy as Markdown', 'copy'), Object.assign(new Option('PDF — not available yet', 'x'), { disabled: true }), Object.assign(new Option('DOCX — not available yet', 'x'), { disabled: true }));
    bar.append(tpl, hist, snap, share, exp); t.append(bar);
    const sec = (id, title) => { const s = el('section', 'nt-sec', '', { 'aria-labelledby': id + 'H' }); s.id = id; s.append(el('h4', '', title, { id: id + 'H' })); t.append(s); return s; };
    sec('nAgenda', 'Agenda'); sec('nNotes', 'Notes'); sec('nDecisions', 'Key decisions'); sec('nTasks', 'Action items');
    t.append(el('p', 'muted', 'Saved to the meeting automatically. The host can give selected people edit access. Everyone who was in the meeting can read these notes afterwards.'));
    tpl.onchange = () => { const k = tpl.value; tpl.value = ''; if (k) applyTemplate(k); };
    hist.onclick = openHistory; snap.onclick = saveVersion; share.onclick = openAccess;
    exp.onchange = () => { const v = exp.value; exp.value = ''; if (v) exportNotes(v); };
    for (const id of ['nAgenda', 'nNotes', 'nDecisions', 'nTasks']) $(id).addEventListener('focusout', () => setTimeout(() => { if (N.pending.has(id) && !$(id).contains(document.activeElement)) { N.pending.delete(id); renderSection(id); } }, 0));
    renderAll();
  }
  const SECMAP = { nAgenda: 'agenda', nNotes: 'notes', nDecisions: 'decisions', nTasks: 'tasks' };
  const ro = () => !N.canEdit;
  function touch(...names) { for (const n of names) N.dirty.add(n); scheduleSave(); }
  function setStatus(text, cls) { const s = $('notesStatus'); if (!s) return; s.textContent = text; s.dataset.state = cls || ''; }
  function renderAll() {
    const role = $('notesRole'); if (!role) return; role.textContent = N.room ? 'Room notes · ' + N.room.name + (N.canEdit ? '' : ' · read-only') : N.ended ? 'Meeting ended · read-only' : N.isHost ? 'Host editor' : N.canEdit ? 'You can edit' : 'Read-only';
    $('notesTemplate').disabled = ro(); $('notesSnap').disabled = ro() || !!N.room; $('notesHistory').disabled = !!N.room; $('notesSnap').title = $('notesHistory').title = N.room ? 'Version history is only kept for the main-room notes' : ''; $('notesShare').classList.toggle('hidden', !N.isHost || N.ended || !!N.room);
    for (const id of Object.keys(SECMAP)) renderSection(id);
    if (!N.dirty.size && !N.saving && N.loaded) setStatus(N.canEdit ? 'Saved' : '', 'saved');
  }
  function renderSection(id) {
    const s = $(id); if (!s) return; s.querySelectorAll(':scope > :not(h4)').forEach((x) => x.remove()); const d = N.doc;
    if (id === 'nNotes') {
      const ta = el('textarea', 'nt-text', '', { rows: '8', maxlength: '20000', 'aria-label': 'Meeting notes text', placeholder: ro() ? '' : 'Discussion, context, links…' }); ta.value = d.notes; ta.readOnly = ro();
      ta.addEventListener('input', () => { N.doc.notes = ta.value; touch('notes'); }); s.append(ta); return;
    }
    const list = el('ul', 'nt-list'); s.append(list);
    const rows = id === 'nAgenda' ? d.agenda : id === 'nDecisions' ? d.decisions : d.tasks, key = SECMAP[id];
    const del = (i) => { const b = el('button', 'nt-x', '✕', { 'aria-label': 'Remove this item' }); b.onclick = () => { rows.splice(i, 1); touch(key); renderSection(id); }; return b; };
    rows.forEach((r, i) => {
      const li = el('li', 'nt-item');
      if (id === 'nAgenda' || id === 'nTasks') { const cb = el('input', '', '', { type: 'checkbox', 'aria-label': (id === 'nAgenda' ? 'Agenda item done: ' : 'Task done: ') + r.text }); cb.checked = id === 'nAgenda' ? r.done : r.status === 'done'; cb.disabled = ro(); cb.onchange = () => { if (id === 'nAgenda') r.done = cb.checked; else r.status = cb.checked ? 'done' : 'open'; touch(key); }; li.append(cb); }
      const tx = el('input', 'nt-in', '', { type: 'text', maxlength: '400', 'aria-label': id === 'nAgenda' ? 'Agenda item' : id === 'nDecisions' ? 'Decision' : 'Task' }); tx.value = r.text; tx.readOnly = ro(); tx.oninput = () => { r.text = tx.value; touch(key); }; li.append(tx);
      if (id !== 'nAgenda') {
        const ow = el('input', 'nt-owner', '', { type: 'text', maxlength: '80', list: 'nOwners', 'aria-label': id === 'nTasks' ? 'Task owner' : 'Decision owner', placeholder: 'Owner' }); ow.value = r.owner || ''; ow.readOnly = ro(); ow.oninput = () => { r.owner = ow.value; touch(key); }; li.append(ow);
        if (id === 'nTasks') { const du = el('input', 'nt-due', '', { type: 'date', 'aria-label': 'Due date' }); du.value = r.due || ''; du.disabled = ro(); du.onchange = () => { r.due = du.value; touch(key); }; li.append(du); }
        if (r.at) li.append(el('span', 'nt-at', '@' + stamp(r.at), { title: 'Time in the meeting when this was added' }));
      }
      if (!ro()) li.append(del(i)); list.append(li);
    });
    if (!rows.length) list.append(el('li', 'muted', ro() ? 'Nothing here yet.' : id === 'nAgenda' ? 'No agenda items yet.' : id === 'nDecisions' ? 'No decisions recorded yet.' : 'No action items yet.'));
    if (ro()) return;
    const f = el('form', 'nt-add'); const inp = el('input', 'nt-in', '', { type: 'text', maxlength: '400', 'aria-label': id === 'nAgenda' ? 'New agenda item' : id === 'nDecisions' ? 'New decision' : 'New action item', placeholder: id === 'nAgenda' ? 'Add an agenda item…' : id === 'nDecisions' ? 'Add a decision from the meeting…' : 'Add an action item…' });
    f.append(inp, el('button', '', 'Add'));
    f.onsubmit = (e) => { e.preventDefault(); const v = inp.value.trim(); if (!v) return; const me = state.names.get(state.participantId) || '';
      rows.push(id === 'nAgenda' ? { id: newId(), text: v, done: false } : id === 'nDecisions' ? { id: newId(), text: v, owner: '', at: elapsed(), by: me } : { id: newId(), text: v, owner: '', due: '', status: 'open', at: elapsed() });
      touch(key); renderSection(id); $(id).querySelector('.nt-add input')?.focus(); };
    s.append(f);
    if (id === 'nTasks' || id === 'nDecisions') { let dl = $('nOwners'); if (!dl) { dl = el('datalist'); dl.id = 'nOwners'; document.body.append(dl); } dl.textContent = ''; for (const n of new Set([...state.names.values()])) dl.append(new Option(n)); }
  }
  function scheduleSave() { clearTimeout(N.timer); setStatus('Unsaved changes…', 'dirty'); N.timer = setTimeout(flush, 1200); }
  async function flush() {
    clearTimeout(N.timer); if (!N.dirty.size || !N.canEdit) return; if (N.saving) { N.again = true; return; }
    const sections = [...N.dirty]; N.dirty.clear(); N.saving = true; setStatus('Saving…', 'saving');
    try {
      const r = await call('/notes', 'PATCH', { baseVersion: N.version, doc: N.doc, sections }); N.version = r.version; N.saving = false;
      if (N.offline) { N.offline = false; announce('Notes saved again'); }
      if (N.dirty.size || N.again) { N.again = false; flush(); } else setStatus('Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 'saved');
    } catch (e) {
      N.saving = false; sections.forEach((s) => N.dirty.add(s));
      if (e.status === 403) { N.canEdit = false; N.dirty.clear(); renderAll(); setStatus('Read-only', ''); notify(e.message); return; }
      if (!N.offline) { N.offline = true; announce('Notes are offline. Changes are kept and will be saved when the connection returns.'); }
      setStatus('Offline — changes kept, retrying…', 'offline'); clearTimeout(N.retry); N.retry = setTimeout(flush, 5000);
    }
  }
  async function loadNotes() {
    if (N.dirty.size) await flush();
    try { const r = await call('/notes'); Object.assign(N, { version: r.version, canEdit: r.canEdit, isHost: r.isHost, ended: r.ended, editors: r.editors, room: r.room || null, loaded: true }); N.doc = r.doc; if (!$('nAgenda')) buildNotes(); else renderAll(); }
    catch (e) { if (!$('nAgenda')) buildNotes(); setStatus('Notes unavailable: ' + e.message, 'offline'); }
  }
  function remoteNotes(m) {
    if (m.byId === state.participantId && !m.restored) { N.version = Math.max(N.version, m.version); return; }
    N.version = m.version;
    for (const [id, key] of Object.entries(SECMAP)) {
      if (!m.sections.includes(key) || N.dirty.has(key) || JSON.stringify(N.doc[key]) === JSON.stringify(m.doc[key])) continue;
      N.doc[key] = m.doc[key]; if ($(id).contains(document.activeElement)) N.pending.add(id); else renderSection(id);
    }
    if (m.restored) announce('Notes were restored to an earlier version by ' + m.by); 
  }
  async function applyTemplate(k) {
    if (!N.canEdit) return; const tp = TEMPLATES[k], has = N.doc.agenda.length || N.doc.notes.trim();
    if (has && !(await askConfirm('Apply the “' + tp.label + '” template?', 'This replaces the current agenda and notes text. Decisions and action items are kept, and the earlier version stays in Version history.', 'Apply template', true))) return;
    N.doc.template = k; N.doc.agenda = tp.agenda.map((text) => ({ id: newId(), text, done: false })); N.doc.notes = tp.notes; touch('template', 'agenda', 'notes'); renderAll();
  }
  function exportNotes(kind) {
    const md = docToMarkdown(N.doc);
    if (kind === 'md') download('qorlla-notes-' + code() + '.md', md, 'text/markdown'); else if (kind === 'txt') download('qorlla-notes-' + code() + '.txt', stripMd(md), 'text/plain');
    else navigator.clipboard.writeText(md).then(() => notify('Notes copied as Markdown')).catch(() => notify('Copy failed'));
  }
  async function saveVersion() { try { await flush(); await call('/notes/snapshot', 'POST'); notify('Version saved'); } catch (e) { notify(e.message); } }
  async function openHistory() {
    let list; try { list = (await call('/notes/revisions')).revisions; } catch (e) { return notify(e.message); }
    rcModal('Notes version history', (box) => {
      box.append(el('p', 'rc-note', 'Snapshots are taken while people edit (at most every 30 seconds per person) and when someone presses Save version. The current notes are always the latest text.'));
      const ul = el('ul', 'rc-list'); if (!list.length) ul.append(el('li', '', 'No saved versions yet.'));
      const pre = el('pre', 'nt-preview', '', { tabindex: '0', 'aria-label': 'Preview of the selected version' }); pre.hidden = true;
      for (const r of list) { const li = el('li'); li.append(el('span', '', 'Version ' + r.version + ' · ' + r.savedBy + ' · ' + r.reason + ' · ' + new Date(r.at).toLocaleString()));
        const act = el('span'), pv = el('button', 'rc-secondary', 'Preview'); pv.onclick = async () => { try { const v = await call('/notes/revisions/' + r.version); pre.textContent = docToMarkdown(v.doc); pre.hidden = false; } catch (e) { notify(e.message); } };
        act.append(pv);
        if (N.isHost && !N.ended) { const rs = el('button', 'rc-secondary', 'Restore'); rs.onclick = async () => { if (!(await askConfirm('Restore version ' + r.version + '?', 'The notes return to that version for everyone. Nothing is lost: the current text stays in the history.', 'Restore', true))) return; try { const out = await call('/notes/restore', 'POST', { version: r.version }); N.version = out.version; N.doc = out.doc; N.dirty.clear(); renderAll(); notify('Notes restored'); } catch (e) { notify(e.message); } }; act.append(rs); }
        li.append(act); ul.append(li); }
      box.append(ul, pre); const row = el('div', 'rc-row'), c = el('button', 'rc-primary', 'Close'); c.onclick = () => rcClose(); row.append(c); box.append(row);
    });
  }
  function openAccess() {
    const others = [...state.roster].filter((p) => p !== state.participantId);
    rcModal('Who can edit the notes', (box) => {
      box.append(el('p', 'rc-note', 'You (the host) can always edit. Everyone else can read. Turn on edit access for the people you choose.'));
      const ul = el('ul', 'rc-list'); if (!others.length) ul.append(el('li', '', 'Nobody else is in the meeting.'));
      for (const p of others) { const li = el('li'), l = el('label', 'rc-check'), cb = el('input', '', '', { type: 'checkbox' }); cb.checked = N.editors.includes(p); l.append(cb, document.createTextNode(' ' + (state.names.get(p) || 'Participant')));
        cb.onchange = async () => { cb.disabled = true; try { N.editors = (await call('/notes/editors', 'POST', { participantId: p, allow: cb.checked })).editors; } catch (e) { cb.checked = !cb.checked; notify(e.message); } cb.disabled = false; }; li.append(l); ul.append(li); }
      box.append(ul); const row = el('div', 'rc-row'), c = el('button', 'rc-primary', 'Done'); c.onclick = () => rcClose(); row.append(c); box.append(row);
    });
  }

  // =================================================================================================================================== POLLS
  const P = { polls: [], view: 'active', form: false, answered: new Map(), local: new Map(), timer: 0, loading: 0 };
  const KIND = { single: 'Single choice', multiple: 'Multiple choice', yesno: 'Yes / No', rating: 'Rating scale', ranking: 'Ranking' };
  function buildPolls() {
    const t = $('tab-polls'); t.textContent = '';
    const svg = (d, cls) => { const x = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); x.setAttribute('viewBox', '0 0 24 24'); x.setAttribute('aria-hidden', 'true'); x.setAttribute('class', cls || ''); x.innerHTML = d; return x; };   // static icon markup only
    const head = el('div', 'plh'); const ttl = el('div', 'plh-title'); ttl.append(svg('<rect x="3" y="12" width="4" height="8" rx="1"/><rect x="10" y="5" width="4" height="15" rx="1"/><rect x="17" y="9" width="4" height="11" rx="1"/>', 'plh-ic'), el('h3', '', 'Polls'));
    const nb = el('button', 'plh-new hidden', '', { id: 'pollNew', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'pollForm2' }); nb.append(svg('<path d="M12 5v14M5 12h14"/>', 'plh-plus'), document.createTextNode('New poll')); head.append(ttl, nb);
    P.svg = svg;
    const views = el('div', 'pl-views plh-seg', '', { role: 'group', 'aria-label': 'Poll lists' });
    for (const [k, l] of [['active', 'Active'], ['drafts', 'Drafts'], ['results', 'Results']]) { const b = el('button', '', l, { 'data-pv': k, 'aria-pressed': String(k === P.view) }); b.onclick = () => { P.view = k; renderPolls(); }; views.append(b); }
    const card = el('div', 'plh-card'); card.append(head, views, el('div', '', '', { id: 'pollForm2' }), el('div', '', '', { id: 'pollList', 'aria-live': 'off' })); t.append(card);
    nb.onclick = () => { P.form = !P.form; renderPolls(); if (P.form) $('pq')?.focus(); };
  }
  function pollForm() {
    const f = el('form', 'pl-form pl-create'); f.id = 'pollFormEl';
    const top = el('div', 'plc-top'); top.append(el('h4', 'plc-title', 'Create New Poll'), el('span', 'plc-badge', 'Host editor')); f.append(top);
    const sect = (label, id) => { const s = el('div', 'plc-sec'); const l = el('label', 'plc-label', label); if (id) l.htmlFor = id; s.append(l); f.append(s); return s; };
    const qs = sect('Question *', 'pq'); const q = el('textarea', 'plc-q', '', { id: 'pq', rows: '2', maxlength: '300', required: '', placeholder: 'Enter your poll question...' }); qs.append(q);
    const ts = sect('Question type'); ts.setAttribute('role', 'radiogroup'); ts.setAttribute('aria-label', 'Question type');
    let kindVal = 'single'; const radios = [];
    const kindRadio = (k, l) => { const lab = el('label', 'plc-radio'), i = el('input', '', '', { type: 'radio', name: 'pk', value: k }); i.checked = k === kindVal; i.onchange = () => { kindVal = k; more.value = ''; sync(); }; lab.append(i, el('span', 'plc-dot'), el('span', '', l)); ts.append(lab); radios.push(i); };
    kindRadio('single', 'Single choice'); kindRadio('multiple', 'Multiple choice');
    const more = el('select', 'plc-more', '', { id: 'pk', 'aria-label': 'Other question type' }); more.append(new Option('Other question type…', '')); for (const k of ['yesno', 'rating', 'ranking']) more.append(new Option(KIND[k], k));
    more.onchange = () => { if (more.value) { kindVal = more.value; radios.forEach((r) => { r.checked = false; }); } else { kindVal = 'single'; radios[0].checked = true; } sync(); }; ts.append(more);
    const os = sect('Answer options (2–10)'); const cnt = el('span', 'plc-count', '2/10'); os.firstChild.append(cnt); os.firstChild.classList.add('plc-labelrow');
    const list = el('div', 'plc-opts'); const add = el('button', 'plc-add', '+ Add option', { type: 'button' }); os.append(list, add);
    const rows = []; let quiz = null;
    const renum = () => { rows.forEach((o, i) => { o.inp.placeholder = 'Option ' + (i + 1); o.inp.setAttribute('aria-label', 'Option ' + (i + 1)); o.x.setAttribute('aria-label', 'Remove option ' + (i + 1)); o.ok.hidden = !(quiz && quiz.checked) || !['single', 'multiple', 'yesno'].includes(kindVal); }); cnt.textContent = rows.length + '/10'; add.disabled = rows.length >= 10; };
    const addRow = () => {
      if (rows.length >= 10) return; const r = el('div', 'plc-orow');
      const ok = el('input', 'plc-correct', '', { type: 'checkbox', 'aria-label': 'Correct answer' }); const inp = el('input', 'plc-opt', '', { type: 'text', maxlength: '120' });
      const x = el('button', 'plc-x', '✕', { type: 'button' }); const rec = { r, ok, inp, x };
      x.onclick = () => { if (rows.length <= 2) return; rows.splice(rows.indexOf(rec), 1); r.remove(); renum(); };
      rows.push(rec); r.append(ok, inp, x); list.append(r); renum();
    };
    add.onclick = () => { addRow(); rows[rows.length - 1].inp.focus(); }; addRow(); addRow();
    const ss = sect('Scale', 'ps'); const scale = el('select', 'plc-select', '', { id: 'ps' }); for (const n of [5, 10, 3]) scale.append(new Option('1 to ' + n, String(n))); ss.append(scale);
    f.append(el('hr', 'plc-hr'));
    const checks = el('div', 'plc-checks'); const ck = (id, l) => { const lab = el('label', 'plc-radio'), i = el('input', '', '', { type: 'checkbox', id }); lab.append(i, el('span', 'plc-dot'), el('span', '', l)); checks.append(lab); return i; };
    const anon = ck('pa', 'Anonymous responses'), live = ck('pl', 'Show live results to everyone'); quiz = ck('pz', 'Quiz mode — mark correct answer'); f.append(checks);
    const es = sect('Explanation shown with the results', 'pe'); const expl = el('input', 'plc-input', '', { id: 'pe', maxlength: '400' }); es.append(expl);
    const ds = sect('Time limit', 'pd'); const dur = el('select', 'plc-select', '', { id: 'pd' }); for (const [v, l] of [['0', 'No limit'], ['60', '1 minute'], ['120', '2 minutes'], ['300', '5 minutes'], ['600', '10 minutes']]) dur.append(new Option(l, v)); ds.append(dur);
    const err = el('p', 'rc-err', '', { role: 'alert' }); const br = el('div', 'plc-foot');
    const draft = el('button', 'plc-btn', '', { type: 'button' }), go = el('button', 'plc-btn plc-go', '', { type: 'submit' });
    let roomPick = null;          // while rooms are open the host chooses where the poll goes (default: the room they are in)
    if (state.role === 'host' && BK.info.active && BK.st?.rooms?.length) { const rs = sect('Send this poll to', 'pRoom'); roomPick = el('select', '', '', { id: 'pRoom' }); roomPick.append(new Option(BK.info.roomId ? 'The room I am in (' + BK.info.roomName + ')' : 'The main room (default)', '')); if (BK.info.roomId) roomPick.append(new Option('The main room', 'main')); for (const r of BK.st.rooms) if (r.id !== BK.info.roomId) roomPick.append(new Option(r.name, r.id)); rs.append(roomPick); }
    draft.append(el('span', 'plc-ic', '💾'), document.createTextNode('Save draft')); go.append(el('span', 'plc-ic', '▶'), document.createTextNode('Launch poll')); br.append(draft, go); f.append(err, br);
    const sync = () => { const k = kindVal; os.hidden = !['single', 'multiple', 'ranking'].includes(k); ss.hidden = k !== 'rating'; quiz.parentElement.hidden = !['single', 'multiple', 'yesno'].includes(k); if (quiz.parentElement.hidden) quiz.checked = false; es.hidden = !quiz.checked; renum(); }; quiz.onchange = sync; sync();
    const correct = () => (kindVal === 'yesno' ? [] : rows.filter((o) => o.inp.value.trim()).map((o, i) => (o.ok.checked ? i : -1)).filter((i) => i >= 0));
    const body = (launch) => ({ question: q.value, kind: kindVal, options: rows.map((o) => o.inp.value), scale: Number(scale.value), anonymous: anon.checked, liveResults: live.checked, quiz: quiz.checked, correct: correct(), explanation: expl.value, durationSec: Number(dur.value) || 0, launch, ...(roomPick && roomPick.value ? { roomId: roomPick.value } : {}) });
    const send = async (launch) => { err.textContent = ''; try { await call('/polls', 'POST', body(launch)); P.form = false; P.view = launch ? 'active' : 'drafts'; announce(launch ? 'Poll launched' : 'Draft saved'); await loadPolls(); } catch (e) { err.textContent = e.message; } };
    f.onsubmit = (e) => { e.preventDefault(); send(true); }; draft.onclick = () => { if (f.reportValidity()) send(false); };
    return f;
  }
  const pct = (n, tot) => (tot ? Math.round((n / tot) * 100) : 0);
  function bar(label, n, tot, extra) { const r = el('div', 'pl-row'); r.append(el('span', 'pl-lab', label + (extra ? ' ' + extra : ''))); const b = el('div', 'pl-bar', '', { 'aria-hidden': 'true' }), fill = el('div', 'pl-fill'); fill.style.width = pct(n, tot) + '%'; b.append(fill); r.append(b, el('span', 'pl-n', n + ' (' + pct(n, tot) + '%)')); return r; }
  function resultsView(p) {
    const r = p.results, box = el('div', 'pl-results'); box.append(el('p', 'muted', r.total + ' response' + (r.total === 1 ? '' : 's')));
    if (p.kind === 'rating') { r.counts.forEach((n, i) => box.append(bar(String(i + 1), n, r.total))); box.append(el('p', '', 'Average: ' + (r.average ?? '—'))); }
    else if (p.kind === 'ranking') { const max = Math.max(1, ...r.score); p.options.forEach((o, i) => box.append(bar(o, r.score[i], max, '· first choice ' + r.first[i]))); box.append(el('p', 'muted', 'Score: first place earns the most points.')); }
    else p.options.forEach((o, i) => box.append(bar(o, r.counts[i], r.total, p.correct && p.correct.includes(i) ? '✔ correct' : '')));
    if (p.quiz && r.correctCount !== undefined) box.append(el('p', '', r.correctCount + ' of ' + r.total + ' answered correctly'));
    if (p.explanation) box.append(el('p', 'muted', 'Explanation: ' + p.explanation)); return box;
  }
  function voteForm(p) {
    const f = el('form', 'pl-vote'); const fs = el('fieldset'); fs.append(el('legend', 'sr-only', p.question)); f.append(fs);
    const err = el('p', 'rc-err', '', { role: 'alert' }); let get;
    if (p.kind === 'single' || p.kind === 'yesno' || p.kind === 'multiple') { const type = p.kind === 'multiple' ? 'checkbox' : 'radio'; const ins = p.options.map((o, i) => { const l = el('label', 'rc-check'), c = el('input', '', '', { type, name: 'v' + p.id, value: String(i) }); l.append(c, document.createTextNode(' ' + o)); fs.append(l); return c; }); get = () => ins.filter((c) => c.checked).map((c) => Number(c.value)); }
    else if (p.kind === 'rating') { const row = el('div', 'pl-scale'); const ins = []; for (let n = 1; n <= p.scale; n++) { const l = el('label', 'rc-check'), c = el('input', '', '', { type: 'radio', name: 'v' + p.id, value: String(n) }); l.append(c, document.createTextNode(' ' + n)); row.append(l); ins.push(c); } fs.append(row); get = () => ins.filter((c) => c.checked).map((c) => Number(c.value)); }
    else { let order = p.options.map((_, i) => i); const ol = el('ol', 'pl-rank'); const draw = (focusIdx) => { ol.textContent = ''; order.forEach((opt, pos) => { const li = el('li'); li.append(el('span', '', p.options[opt])); const up = el('button', '', '↑', { type: 'button', 'aria-label': 'Move ' + p.options[opt] + ' up' }), dn = el('button', '', '↓', { type: 'button', 'aria-label': 'Move ' + p.options[opt] + ' down' }); up.disabled = pos === 0; dn.disabled = pos === order.length - 1;
        const mv = (d) => () => { [order[pos], order[pos + d]] = [order[pos + d], order[pos]]; draw(pos + d + ':' + (d < 0 ? 'u' : 'd')); announce(p.options[opt] + ' is now number ' + (pos + d + 1)); }; up.onclick = mv(-1); dn.onclick = mv(1); li.append(up, dn); ol.append(li);
        if (focusIdx === pos + ':u') up.focus(); else if (focusIdx === pos + ':d') dn.focus(); }); }; draw(); fs.append(el('p', 'muted', 'Put your first choice at the top.'), ol); get = () => order.slice(); }
    const sub = el('button', 'rc-primary', 'Submit vote', { type: 'submit' }); f.append(err, sub);
    f.onsubmit = async (e) => { e.preventDefault(); err.textContent = ''; sub.disabled = true; try { const r = await call('/polls/' + p.id + '/votes', 'POST', { choices: get() }); if (r.correct !== undefined) P.answered.set(p.id, r.correct); P.local.set(p.id, true); announce('Your vote was recorded'); await loadPolls(); } catch (x) { err.textContent = x.message; sub.disabled = false; if (x.status === 409) loadPolls(); } };
    return f;
  }
  function pollCard(p) {
    const c = el('article', 'pl-card'); c.setAttribute('aria-label', p.question); const h = el('div', 'pl-h'); h.append(el('strong', '', p.question), el('span', 'chip', p.status === 'open' ? 'Open' : p.status === 'draft' ? 'Draft' : 'Closed')); c.append(h);
    const meta = [KIND[p.kind]]; if (p.anonymous) meta.push('anonymous'); if (p.quiz) meta.push('quiz'); if (p.roomId) meta.push(state.role === 'host' ? 'Room: ' + p.roomName : 'This room only'); else if (state.role === 'host' && BK.info.active) meta.push('Main room'); c.append(el('p', 'muted', meta.join(' · ')));
    if (p.status === 'open') { c.append(el('p', 'muted pl-count', p.responses + ' of ' + Math.max(1, state.roster.size) + ' responded' + (p.closesAt ? ' · closes in ' : ''), { 'data-closes': p.closesAt || '' })); }
    if (p.status === 'open' && !p.hasVoted) c.append(voteForm(p));
    else if (p.status === 'open' && p.hasVoted) { c.append(el('p', '', P.answered.has(p.id) ? (P.answered.get(p.id) ? '✔ Vote recorded — correct!' : '✘ Vote recorded — not the correct answer.') : '✔ Your vote is recorded.')); }
    if (p.status === 'closed' && !p.results) c.append(el('p', 'muted', 'This poll is closed. The host has not published the results.'));
    if (p.results) c.append(resultsView(p));
    if (pollMgr()) {
      const row = el('div', 'rc-row'); const add = (label, fn, cls = 'rc-secondary') => { const b = el('button', cls, label, { type: 'button' }); b.onclick = async () => { b.disabled = true; try { await fn(); await loadPolls(); } catch (e) { notify(e.message); b.disabled = false; } }; row.append(b); };
      if (p.status === 'draft') { add('Launch', () => call('/polls/' + p.id + '/open', 'POST'), 'rc-primary'); add('Delete draft', async () => { if (await askConfirm('Delete this draft?', p.question, 'Delete', true)) await call('/polls/' + p.id, 'DELETE', undefined); }); }
      if (p.status === 'open') add('Close poll', () => call('/polls/' + p.id + '/close', 'POST'), 'rc-primary');
      if (p.status !== 'draft') add(p.published ? 'Hide results from participants' : 'Publish results to everyone', () => call('/polls/' + p.id + '/publish', 'POST', { published: !p.published }));
      if (p.status !== 'draft') add('Export CSV', async () => { const r = await call('/polls/' + p.id + '/export.csv', 'GET', undefined, true); download('poll-results.csv', await r.text(), 'text/csv'); });
      c.append(row);
    }
    return c;
  }
  const pollMgr = () => state.role === 'host' || BK.caps.includes('room_polls');          // a room lead with room_polls runs the polls of their own room
  function renderPolls() {
    if (!$('pollList')) return; const host = pollMgr(); $('pollNew').classList.toggle('hidden', !host); $('pollNew').setAttribute('aria-expanded', String(P.form));
    const drafts = P.polls.filter((p) => p.status === 'draft'), active = P.polls.filter((p) => p.status === 'open'), done = P.polls.filter((p) => p.status === 'closed');
    document.querySelectorAll('[data-pv]').forEach((b) => { const k = b.dataset.pv; b.hidden = k === 'drafts' && !host; b.setAttribute('aria-pressed', String(k === P.view)); b.textContent = { active: 'Active (' + active.length + ')', drafts: 'Drafts (' + drafts.length + ')', results: 'Results (' + done.length + ')' }[k]; });
    $('pollForm2').textContent = ''; if (host && P.form) $('pollForm2').append(pollForm());
    const list = $('pollList'); const focusId = document.activeElement?.closest?.('.pl-vote') ? null : undefined;
    if (document.activeElement?.closest?.('.pl-vote')) return;                                        // never rebuild a ballot someone is filling in
    list.textContent = ''; const show = P.view === 'drafts' ? drafts : P.view === 'results' ? done : active;
    if (!show.length) { const e = el('div', 'plh-empty'); e.append(P.svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h.01M9 14h.01M12 10h4M12 14h4"/>', 'plh-eic'), el('p', 'plh-et', P.view === 'active' ? 'No poll is open right now' : P.view === 'drafts' ? 'No drafts' : 'No finished polls yet'), el('p', 'plh-eh', host ? 'Create a poll to gather participant feedback during your meeting.' : 'Polls the host opens will appear here.')); list.append(e); } for (const p of show) list.append(pollCard(p));
    clearInterval(P.timer); if (document.querySelector('[data-closes]:not([data-closes=""])')) P.timer = setInterval(tick, 1000); tick();
  }
  function tick() { document.querySelectorAll('.pl-count[data-closes]').forEach((e) => { const c = e.dataset.closes; if (!c) return; const s = Math.max(0, Math.round((new Date(c) - Date.now()) / 1000)); e.textContent = e.textContent.replace(/ · closes in.*$/, '') + ' · closes in ' + stamp(s); if (s === 0 && !tick.asked) { tick.asked = true; setTimeout(() => { tick.asked = false; loadPolls(); }, 1500); } }); }
  let pollLoadTimer = 0;
  async function loadPolls() { try { P.polls = (await call('/polls')).polls; } catch { return; } if (!$('pollList')) buildPolls(); renderPolls(); }
  const polls$ = () => { clearTimeout(pollLoadTimer); pollLoadTimer = setTimeout(loadPolls, 250); };

  // =================================================================================================================================== MORE
  const openGroups = new Set(['collab', 'intel', 'manage', 'sec', 'tools']);                // which groups of the More tab are open: kept when the tab is rebuilt (a host switching a tool must not see the group fold up)

  // =================================================================================================================================== MORE (v4.27): real Q&A, timer, preferences, attendance
  const M = { features: null, timer: { running: false, endsAt: null }, offset: 0, qaBox: null, qaList: null, pref: null, applied: false, chip: null, tick: 0, done: false };
  const more = (path, method, body) => call('/more' + path, method, body);
  const isOn = (k) => !!(M.features && M.features[k]);
  const fmt = (sec) => { const s = Math.max(0, Math.ceil(sec)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const remaining = () => (M.timer.running && M.timer.endsAt ? (Date.parse(M.timer.endsAt) - (Date.now() + M.offset)) / 1000 : 0);
  function paintTimer() {
    const left = remaining(), on = M.timer.running && left > 0;
    document.querySelectorAll('[data-more-timer]').forEach((n) => { n.textContent = on ? fmt(left) : '0:00'; });
    if (!M.chip) { const top = document.querySelector('.stage-top'); if (top) { M.chip = el('span', 'more-timer-chip hidden', '', { role: 'timer', 'aria-label': 'Meeting timer' }); top.prepend(M.chip); } }
    if (M.chip) { M.chip.classList.toggle('hidden', !on); M.chip.textContent = on ? '\u23F1 ' + fmt(left) : ''; }
    if (M.timer.running && left <= 0 && !M.done) { M.done = true; M.timer.running = false; announce('Timer finished'); notify('Timer finished'); }
    if (!on && M.tick) { clearInterval(M.tick); M.tick = 0; }
  }
  function setTimer(t) { M.timer = t; M.offset = Date.parse(t.serverNow) - Date.now(); M.done = false; clearInterval(M.tick); M.tick = 0; if (t.running) M.tick = setInterval(paintTimer, 1000); paintTimer(); }
  let qaBusy = false, qaAgain = false;
  async function renderQa() { if (qaBusy) { qaAgain = true; return; } qaBusy = true; try { await renderQaOnce(); } finally { qaBusy = false; if (qaAgain) { qaAgain = false; renderQa(); } } }
  async function renderQaOnce() {
    if (!M.qaList) return; if (M.qaList.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;          // never wipe an answer someone is typing
    let list; try { list = (await more('/questions')).questions; } catch (e) { M.qaList.textContent = e.message; return; }
    const host = state.role === 'host'; M.qaList.textContent = '';
    if (!list.length) M.qaList.append(el('p', 'mg-note', 'No questions yet. Ask the first one.'));
    for (const q of list) {
      const c = el('div', 'mg-q' + (q.state === 'hidden' ? ' mg-q-hidden' : ''));
      const v = el('button', 'mg-vote', '\u25B2 ' + q.votes, { type: 'button', 'aria-pressed': String(q.voted), 'aria-label': 'Upvote, ' + q.votes + (q.votes === 1 ? ' vote' : ' votes') });
      v.onclick = async () => { try { await more('/questions/' + q.id + '/vote', 'POST', {}); await renderQa(); } catch (e) { notify(e.message); } };
      const t = el('div', 'mg-q-t'); t.append(el('strong', '', q.question), el('small', '', q.author + (q.state === 'hidden' ? ' \u00B7 hidden' : '') + (q.state === 'answered' ? ' \u00B7 answered' : '')));
      c.append(v, t); if (q.answer) c.append(el('p', 'mg-ans', 'Answer: ' + q.answer));
      if (host) {
        const row = el('div', 'mg-trow'); const a = el('input', '', '', { type: 'text', maxlength: '4000', placeholder: q.answer ? 'Edit the answer' : 'Type an answer', 'aria-label': 'Answer to: ' + q.question.slice(0, 60) });
        const ab = el('button', 'mg-act', q.answer ? 'Update' : 'Answer', { type: 'button' }); ab.onclick = async () => { if (!a.value.trim()) return; ab.disabled = true; try { await more('/questions/' + q.id + '/answer', 'POST', { answer: a.value }); await renderQa(); } catch (e) { notify(e.message); ab.disabled = false; } };
        const hb = el('button', 'mg-act', q.state === 'hidden' ? 'Unhide' : 'Hide', { type: 'button' }); hb.onclick = async () => { try { await more('/questions/' + q.id + '/hide', 'POST', { hidden: q.state !== 'hidden' }); await renderQa(); } catch (e) { notify(e.message); } };
        row.append(a, ab, hb); c.append(row);
      }
      M.qaList.append(c);
    }
  }
  function qaPanel() {
    const box = el('div', 'mg-qa'); box.hidden = true; M.qaBox = box; M.qaList = el('div', 'mg-qlist');
    const form = el('form', 'mg-qform'); const inp = el('input', '', '', { type: 'text', maxlength: '2000', placeholder: 'Ask a question\u2026', 'aria-label': 'Your question', required: '' }); const go = el('button', 'mg-act', 'Ask', { type: 'submit' });
    const anon = el('input', '', '', { type: 'checkbox', id: 'qaAnon' }); const anonL = el('label', 'mg-anon', '', { title: 'Others will not see your name. The host still can.' }); anonL.append(anon, document.createTextNode(' Anonymous'));
    form.onsubmit = async (e) => { e.preventDefault(); go.disabled = true; try { await more('/questions', 'POST', { question: inp.value, anonymous: anon.checked }); inp.value = ''; await renderQa(); } catch (err) { notify(err.message); } go.disabled = false; };
    form.append(inp, go); box.append(form, anonL, M.qaList); return box;
  }
  function timerPanel() {
    const d = el('div', 'mg-info'); d.append(el('strong', '', 'Meeting timer'), el('div', 'mg-timer-big', '0:00', { 'data-more-timer': '' }));
    if (state.role === 'host') {
      const sel = el('select', '', '', { 'aria-label': 'Timer length' }); for (const [sec, l] of [[60, '1 minute'], [120, '2 minutes'], [300, '5 minutes'], [600, '10 minutes'], [900, '15 minutes'], [1800, '30 minutes']]) sel.append(new Option(l, String(sec)));
      const start = el('button', 'mg-act', 'Start', { type: 'button' }), stop = el('button', 'mg-act', 'Stop', { type: 'button' });
      start.onclick = async () => { try { setTimer(await more('/timer', 'POST', { action: 'start', seconds: Number(sel.value) })); } catch (e) { notify(e.message); } };
      stop.onclick = async () => { try { setTimer(await more('/timer', 'POST', { action: 'stop' })); } catch (e) { notify(e.message); } };
      const row = el('div', 'mg-trow'); row.append(sel, start, stop); d.append(row);
    } else d.append(el('p', 'muted', 'The host starts the timer; it counts down at the same moment for everyone.'));
    paintTimer(); return d;
  }
  async function attendancePanel() {
    const d = el('div', 'mg-info'); d.append(el('strong', '', 'Attendance'));
    try { const { attendance } = await more('/attendance');
      if (!attendance.length) d.append(el('p', 'muted', 'Nobody has joined yet.'));
      for (const a of attendance) { const r = el('div', 'mg-att'); r.append(el('span', '', a.name + (a.role === 'host' ? ' (host)' : '')), el('small', '', (a.online ? 'In the meeting' : 'Left') + ' \u00B7 ' + Math.max(1, Math.round(a.seconds / 60)) + ' min \u00B7 ' + a.joins + (a.joins === 1 ? ' join' : ' joins'))); d.append(r); }
    } catch (e) { d.append(el('p', 'muted', e.message)); }
    return d;
  }
  async function savePref(patch) { try { M.pref = await more('/preferences', 'PUT', patch); } catch (e) { notify(e.message); } }
  function setFocus(on) { document.body.classList.toggle('more-focus', on); const b = $('panelToggle'); if (b && (b.getAttribute('aria-expanded') === 'true') === on) b.click(); }     // focus mode = the side panel steps aside so the video has the room
  function applyPrefs() {
    if (M.applied || !M.pref) return; M.applied = true;
    if (M.pref.layout) { const b = document.querySelector('[data-layout="' + M.pref.layout + '"]'); if (b && !b.classList.contains('selected')) b.click(); }
    if (M.pref.focusMode) setFocus(true);
  }

  // ---- Meeting intelligence: real consent status from Meet, hand-off to the Workplace AI (which holds the AI provider, quota and report storage)
  const I = { st: null, mine: {}, requested: false, portal: '', boxes: [] };
  function intelPaint(box, label) {
    box.textContent = ''; const host = state.role === 'host'; const sum = (I.st && I.st.ai && I.st.ai.summary) || {}; const agree = sum.agree || 0, decline = sum.decline || 0;
    box.append(el('small', 'mg-stat', I.st ? agree + ' agreed' + (decline ? ' \u00B7 ' + decline + ' declined' : '') : 'Status unavailable'));
    if (host) {
      let b;
      if (!I.requested) { b = el('button', 'mg-act', 'Ask everyone', { type: 'button', title: 'Ask everyone present whether Qorlla AI may use their messages' }); b.onclick = async () => { b.disabled = true; try { await call('/ai-consent/request', 'POST', {}); await loadIntel(); } catch (e) { notify(e.message); b.disabled = false; } }; }
      else if (agree > 0 && I.portal) { b = el('button', 'mg-act', label, { type: 'button', title: 'Opens the Workplace AI Meeting Intelligence page, where the report is generated from the messages of people who agreed' }); b.onclick = () => window.open(I.portal + '/app/ai', '_blank', 'noopener'); }
      else b = el('button', 'mg-act', agree > 0 ? 'Not available' : 'Waiting for consent', { type: 'button', disabled: '', 'aria-disabled': 'true', title: agree > 0 ? 'The Workplace address is not configured' : 'Nobody has agreed yet' });
      box.append(b);
    } else box.append(el('small', 'mg-stat', 'You: ' + ({ agree: 'agreed', decline: 'declined', withdraw: 'withdrawn' }[I.mine.summary] || (I.requested ? 'not answered yet' : 'not asked yet'))));
  }
  async function loadIntel() {
    try {
      const [cs, ac] = await Promise.all([call('/consent-status'), call('/ai-consent')]); I.st = cs; I.requested = !!ac.requested; I.mine = ac.mine || {};
      if (!I.portal) { try { const c = await (await fetch(BASE + 'api/config')).json(); I.portal = /^https?:\/\/[^/]+$/.test(c.mainOrigin || '') ? c.mainOrigin : ''; } catch { /* no hand-off link */ } }
    } catch { I.st = null; }
    for (const [box, label] of I.boxes) if (box.isConnected) intelPaint(box, label);
  }
  async function loadMore() { try { const st = await more('/state'); const changed = JSON.stringify(M.features) !== JSON.stringify(st.features); M.features = st.features; M.pref = st.preferences; setTimer(st.timer); if (changed) buildMore(); else if (M.qaBox && !M.qaBox.hidden) renderQa(); applyPrefs(); } catch { /* the tools stay disabled */ } }
  function onMore(e) { if (!e) return; if (String(e.kind).startsWith('whiteboard.')) wbOnEvent(e); else if (e.kind === 'timer') setTimer(e.payload); else if (String(e.kind).startsWith('question.') && M.qaBox && !M.qaBox.hidden) renderQa(); }

  // ---- whiteboard (v4.28): one shared board per meeting; every drawing is an operation the server validates and logs, so people who join later or reconnect replay the same board
  const WB = { shown: false, ov: null, cv: null, ctx: null, objs: new Map(), last: 0, board: null, tool: 'pen', color: '#111827', width: 4, busy: false, again: false, draft: null, ui: {} };
  const opId = () => 'o' + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
  const WB_W = 1000, WB_H = 625;
  function wbApply(o) {
    const op = o.op; if (op.t === 'clear') WB.objs.clear(); else if (op.t === 'erase') WB.objs.delete(op.target); else WB.objs.set(op.id, { ...op, mine: o.mine, by: o.by });
  }
  async function wbSync() {
    if (WB.busy) { WB.again = true; return; } WB.busy = true;
    try {
      for (let i = 0; i < 30; i++) { const d = await more('/whiteboard?after=' + WB.last); WB.board = d.board; for (const o of d.ops) wbApply(o); WB.last = d.last; if (d.ops.length < 1000) break; }
    } catch (e) { notify(e.message); }
    finally { WB.busy = false; wbPaintUi(); wbDraw(); if (WB.again) { WB.again = false; wbSync(); } }
  }
  function wbLines(ctx, text, maxW) { const out = []; let line = ''; for (const w of text.split(/\s+/)) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; } if (line) out.push(line); return out; }
  function wbDrawObj(ctx, o) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (o.t === 'stroke') { ctx.strokeStyle = o.c; ctx.lineWidth = o.w; ctx.beginPath(); ctx.moveTo(o.p[0][0], o.p[0][1]); if (o.p.length === 1) ctx.lineTo(o.p[0][0] + .01, o.p[0][1]); for (const pt of o.p.slice(1)) ctx.lineTo(pt[0], pt[1]); ctx.stroke(); const xs = o.p.map((q) => q[0]), ys = o.p.map((q) => q[1]); o.b = [Math.min(...xs) - o.w - 6, Math.min(...ys) - o.w - 6, Math.max(...xs) + o.w + 6, Math.max(...ys) + o.w + 6]; }
    else if (o.t === 'shape') { ctx.strokeStyle = o.c; ctx.lineWidth = o.w; const x = Math.min(o.x1, o.x2), y = Math.min(o.y1, o.y2), w = Math.abs(o.x2 - o.x1), h = Math.abs(o.y2 - o.y1); ctx.beginPath(); if (o.k === 'rect') ctx.rect(x, y, w, h); else if (o.k === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, Math.max(w / 2, .5), Math.max(h / 2, .5), 0, 0, Math.PI * 2); else { ctx.moveTo(o.x1, o.y1); ctx.lineTo(o.x2, o.y2); } ctx.stroke(); o.b = [x - o.w - 6, y - o.w - 6, x + w + o.w + 6, y + h + o.w + 6]; }
    else if (o.t === 'text' || o.t === 'sticky') {
      ctx.font = o.z + 'px system-ui, sans-serif'; ctx.textBaseline = 'top'; const lines = wbLines(ctx, o.s, o.t === 'sticky' ? 200 : 360), lh = o.z * 1.25, w = Math.max(...lines.map((l) => ctx.measureText(l).width));
      if (o.t === 'sticky') { ctx.fillStyle = '#fde68a'; ctx.fillRect(o.x, o.y, 220, lines.length * lh + 16); ctx.fillStyle = '#1f2937'; lines.forEach((l, i) => ctx.fillText(l, o.x + 10, o.y + 8 + i * lh)); o.b = [o.x, o.y, o.x + 220, o.y + lines.length * lh + 16]; }
      else { ctx.fillStyle = o.c; lines.forEach((l, i) => ctx.fillText(l, o.x, o.y + i * lh)); o.b = [o.x - 4, o.y - 4, o.x + w + 4, o.y + lines.length * lh + 4]; }
    }
  }
  function wbDraw() { const c = WB.ctx; if (!c) return; c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#ffffff'; c.fillRect(0, 0, WB_W, WB_H); for (const o of WB.objs.values()) wbDrawObj(c, o); if (WB.draft) wbDrawObj(c, WB.draft); }
  const wbCan = () => WB.board && WB.board.state === 'open' && (state.role === 'host' || WB.board.allowDraw);
  function wbPaintUi() {
    const u = WB.ui; if (!u.status) return; const b = WB.board, can = wbCan();
    u.status.textContent = !b ? 'No whiteboard yet.' : b.state === 'closed' ? 'The host closed the whiteboard. You can still look at it.' : !b.allowDraw && state.role !== 'host' ? 'The host has switched drawing off. You are watching.' : '';
    u.tools.forEach((t) => { t.disabled = !can; }); u.undo.disabled = !can; u.clear.hidden = state.role !== 'host'; u.clear.disabled = !(b && b.state === 'open'); u.hostBar.hidden = state.role !== 'host';
    if (b) { u.allow.checked = !!b.allowDraw; u.closeBtn.textContent = b.state === 'open' ? 'Close board' : 'Reopen board'; }
  }
  async function wbSend(op) { try { await more('/whiteboard/ops', 'POST', { op }); } catch (e) { notify(e.message); } }
  function wbPoint(e) { const r = WB.cv.getBoundingClientRect(); return [Math.max(0, Math.min(WB_W, (e.clientX - r.left) * WB_W / r.width)), Math.max(0, Math.min(WB_H, (e.clientY - r.top) * WB_H / r.height))]; }
  function wbBuild() {
    const ov = el('div', 'wb-ov', '', { role: 'dialog', 'aria-label': 'Whiteboard', 'aria-modal': 'false' }); const u = WB.ui = { tools: [] };
    const bar = el('div', 'wb-bar'); const mk = (label, fn, cls, extra) => { const b = el('button', cls || 'wb-btn', label, { type: 'button', ...(extra || {}) }); b.onclick = fn; return b; };
    const group = el('div', 'wb-group', '', { role: 'group', 'aria-label': 'Tools' });
    for (const [k, l] of [['pen', 'Pen'], ['line', 'Line'], ['rect', 'Box'], ['ellipse', 'Oval'], ['text', 'Text'], ['sticky', 'Note'], ['erase', 'Eraser']]) { const b = mk(l, () => { WB.tool = k; u.tools.forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.tool === k))); if (k === 'text' || k === 'sticky') u.text.focus(); }, 'wb-btn', { 'data-tool': k, 'aria-pressed': String(k === WB.tool) }); u.tools.push(b); group.append(b); }
    const colors = el('div', 'wb-group', '', { role: 'group', 'aria-label': 'Colour' }); for (const [c, n] of [['#111827', 'Black'], ['#dc2626', 'Red'], ['#2563eb', 'Blue'], ['#16a34a', 'Green'], ['#ea580c', 'Orange'], ['#9333ea', 'Purple']]) { const b = mk('', () => { WB.color = c; colors.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); }, 'wb-sw', { 'aria-label': n, 'aria-pressed': String(c === WB.color) }); b.style.background = c; colors.append(b); }
    const sizes = el('div', 'wb-group', '', { role: 'group', 'aria-label': 'Line width' }); for (const [w, n] of [[2, 'Thin'], [4, 'Medium'], [10, 'Thick']]) { const b = mk(n, () => { WB.width = w; sizes.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); }, 'wb-btn', { 'aria-pressed': String(w === WB.width) }); sizes.append(b); }
    u.undo = mk('Undo mine', () => { const mine = [...WB.objs.values()].filter((o) => o.mine); const last = mine[mine.length - 1]; if (last) wbSend({ t: 'erase', id: opId(), target: last.id }); }); u.clear = mk('Clear all', async () => { if (await askConfirm('Clear the whiteboard?', 'Everyone loses the drawing.', 'Clear', true)) wbSend({ t: 'clear' }); });
    const png = mk('Save PNG', () => { const a = el('a'); a.href = WB.cv.toDataURL('image/png'); a.download = 'whiteboard.png'; document.body.append(a); a.click(); a.remove(); }); const close = mk('Close', () => wbHide(), 'wb-btn wb-x', { 'aria-label': 'Close whiteboard' });
    bar.append(group, colors, sizes, u.undo, u.clear, png, close);
    u.text = el('input', 'wb-text', '', { type: 'text', maxlength: '200', placeholder: 'Type text for the Text or Note tool, then click the board', 'aria-label': 'Text to place' });
    u.hostBar = el('div', 'wb-host'); const allow = el('input', '', '', { type: 'checkbox', id: 'wbAllow' }); u.allow = allow; allow.onchange = async () => { try { await more('/whiteboard', 'POST', { action: 'draw', allow: allow.checked }); } catch (e) { notify(e.message); allow.checked = !allow.checked; } };
    const al = el('label', 'wb-allow'); al.append(allow, document.createTextNode(' Participants can draw')); u.closeBtn = mk('Close board', async () => { try { await more('/whiteboard', 'POST', { action: WB.board && WB.board.state === 'open' ? 'close' : 'open' }); } catch (e) { notify(e.message); } }); u.hostBar.append(al, u.closeBtn);
    u.status = el('p', 'wb-status', '', { role: 'status' });
    const cv = el('canvas', 'wb-cv', '', { width: String(WB_W), height: String(WB_H), role: 'img', 'aria-label': 'Shared whiteboard. Drawing needs a pointer; changes from everyone appear live.' }); WB.cv = cv; WB.ctx = cv.getContext('2d');
    cv.addEventListener('pointerdown', (e) => {
      if (!wbCan()) return; const pt = wbPoint(e);
      if (WB.tool === 'erase') { const objs = [...WB.objs.values()].reverse(); const hit = objs.find((o) => o.b && pt[0] >= o.b[0] && pt[0] <= o.b[2] && pt[1] >= o.b[1] && pt[1] <= o.b[3]); if (hit) wbSend({ t: 'erase', id: opId(), target: hit.id }); return; }
      if (WB.tool === 'text' || WB.tool === 'sticky') { const text = u.text.value.trim(); if (!text) { notify('Type the text first, then click where it goes.'); u.text.focus(); return; } wbSend({ t: WB.tool, id: opId(), s: text, c: WB.color, x: pt[0], y: pt[1], z: 24 }); u.text.value = ''; return; }
      cv.setPointerCapture(e.pointerId); WB.draft = WB.tool === 'pen' ? { t: 'stroke', c: WB.color, w: WB.width, p: [pt] } : { t: 'shape', k: WB.tool, c: WB.color, w: WB.width, x1: pt[0], y1: pt[1], x2: pt[0], y2: pt[1] };
    });
    cv.addEventListener('pointermove', (e) => { const d = WB.draft; if (!d) return; const pt = wbPoint(e); if (d.t === 'stroke') { const l = d.p[d.p.length - 1]; if (Math.hypot(pt[0] - l[0], pt[1] - l[1]) >= 2 && d.p.length < 400) d.p.push(pt); } else { d.x2 = pt[0]; d.y2 = pt[1]; } wbDraw(); });
    const finish = () => { const d = WB.draft; WB.draft = null; wbDraw(); if (!d) return; if (d.t === 'shape' && Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 4) return; wbSend({ ...d, id: opId() }); };
    cv.addEventListener('pointerup', finish); cv.addEventListener('pointercancel', () => { WB.draft = null; wbDraw(); });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); wbHide(); } });
    ov.append(bar, u.text, u.hostBar, u.status, cv); document.body.append(ov); WB.ov = ov;
  }
  function wbHide() { if (WB.ov) WB.ov.hidden = true; WB.shown = false; document.querySelector('#tab-more .wb-open')?.focus(); }
  async function wbOpen() {
    if (!WB.ov) wbBuild(); await wbSync();
    if (!WB.board) { notify('The host has not opened a whiteboard yet.'); return; }
    WB.ov.hidden = false; WB.shown = true; wbPaintUi(); wbDraw(); WB.ui.tools.find((t) => t.dataset.tool === WB.tool)?.focus();
  }
  function wbOnEvent(e) {
    if (e.kind === 'whiteboard.state') { if (WB.shown) wbSync(); else if (state.role !== 'host' && e.payload && e.payload.state === 'open') notify('The host opened the whiteboard. Open it from More, Collaboration.'); }
    else if (e.kind === 'whiteboard.op' && WB.shown) wbSync();
  }

  // ---- breakout rooms (v4.29): the host splits people into rooms; the server moves them (new roster, new peer connections) and keeps chat, signaling and events inside the room
  const BK = { info: { active: false, roomId: null, roomName: null, deadline: null }, st: null, box: null, chip: null, acts: null, helpId: null, caps: [], dash: null, ready: 0, tick: 0, warned: false, open: false };
  const inMain = () => !BK.info.roomId;
  const bk = (path, method, body) => call('/breakouts' + path, method, body);
  const leftSec = () => (BK.info.deadline ? (Date.parse(BK.info.deadline) - Date.now()) / 1000 : 0);
  function bkPaintChip() {
    const top = document.querySelector('.stage-top'); if (!BK.chip && top) { BK.chip = el('span', 'bk-chip hidden', '', { role: 'timer', 'aria-label': 'Breakout rooms' }); top.prepend(BK.chip); }
    const on = BK.info.active && (BK.info.roomId || state.role === 'host'), left = leftSec();
    const asking = state.role === 'host' && BK.st?.help?.length ? ' \u00B7 ' + BK.st.help.length + ' asking for help' : '';
    if (BK.chip) { BK.chip.classList.toggle('hidden', !on); BK.chip.textContent = on ? (BK.info.roomId ? BK.info.roomName : 'Rooms open') + ' \u00B7 ' + fmt(left) + asking : ''; }
    if (!BK.acts && BK.chip && state.role !== 'host') { BK.acts = bkGuestActs(); BK.chip.after(BK.acts); }
    if (BK.acts) { BK.acts.classList.toggle('hidden', !(BK.info.active && BK.info.roomId)); BK.acts.querySelector('[data-bk-announce]')?.classList.toggle('hidden', !BK.caps.includes('room_announcement')); }
    document.querySelectorAll('[data-bk-help]').forEach((b) => { b.textContent = BK.helpId ? 'Cancel help request' : 'Ask for help'; b.setAttribute('aria-pressed', String(!!BK.helpId)); });
    document.querySelectorAll('[data-bk-left]').forEach((n) => { n.textContent = BK.info.active ? fmt(left) : ''; });
    if (BK.info.active && left > 0 && left <= 60 && !BK.warned) { BK.warned = true; announce('One minute left in the breakout rooms'); notify('One minute left in the breakout rooms'); }
    if (!BK.info.active && BK.tick) { clearInterval(BK.tick); BK.tick = 0; }
  }
  // V1.1: a person in a room can go back to the main room by themselves, and ask the host to come
  function bkGuestActs() {
    const wrap = el('span', 'bk-acts'); const help = el('button', 'bk-act', 'Ask for help', { type: 'button', 'data-bk-help': '', 'aria-pressed': 'false', title: 'Tell the host this room needs them' });
    const back = el('button', 'bk-act', 'Back to main room', { type: 'button', title: 'Leave this room and rejoin everyone in the main room' });
    help.onclick = async () => { help.disabled = true; try { if (BK.helpId) { await bk('/help', 'DELETE'); BK.helpId = null; notify('Help request cancelled'); } else { BK.helpId = (await bk('/help', 'POST', {})).id; notify('The host has been asked to come to your room'); announce('The host has been asked to come to your room'); } } catch (e) { notify(e.message); } help.disabled = false; bkPaintChip(); };
    back.onclick = async () => { if (!(await askConfirm('Go back to the main room?', 'You leave ' + (BK.info.roomName || 'this room') + ' and rejoin everyone in the main room. The host can still move you again.', 'Go back'))) return; back.disabled = true; try { await bk('/return', 'POST', {}); } catch (e) { notify(e.message); } back.disabled = false; };
    const board = el('button', 'bk-act', 'Room board', { type: 'button', title: 'Missions, exercises, whiteboard and reports of this room' }); board.onclick = () => { document.querySelector('[data-tab=more]')?.click(); if (CL.box) CL.box.hidden = false; clShow(); };
    const ann = el('button', 'bk-act hidden', 'Announce', { type: 'button', 'data-bk-announce': '', title: 'Send a short message to this room' }); ann.onclick = bkAnnounce;
    wrap.append(board, ann, help, back); return wrap;
  }
  // tells the server when this page has its new peer connections up (or gave up waiting), so the host's list stops saying 'connecting'
  function bkReady() {
    clearTimeout(BK.ready); const t0 = Date.now();
    const epoch = BK.info.epoch; const check = () => { if (BK.info.epoch !== epoch) return; const need = [...state.roster].filter((id) => id !== state.participantId); const up = need.every((id) => state.peers?.get(id)?.connectionState === 'connected'); if (up || Date.now() - t0 > 15000) { state.socket?.emit('breakout-ready', { epoch, ok: up }); return; } BK.ready = setTimeout(check, 400); };          // what the PAGE reports: the server records it as a client report, never as proof
    BK.ready = setTimeout(check, 600);
  }
  async function bkViewNotes(r) {
    try { const v = await call('/notes?room=' + r.id); rcModal('Notes \u00B7 ' + r.name, (box) => { box.append(el('pre', 'nt-preview', docToMarkdown(v.doc), { tabindex: '0', 'aria-label': 'Notes of ' + r.name })); const row = el('div', 'rc-row'), c = el('button', 'rc-primary', 'Close'); c.onclick = () => rcClose(); row.append(c); box.append(row); }); } catch (e) { notify(e.message); }
  }
  function breakoutScope(info) {
    const wasRoom = BK.info.roomId; BK.info = info; BK.warned = false; clearInterval(BK.tick); BK.tick = 0; if (info.active && info.deadline) BK.tick = setInterval(bkPaintChip, 1000); bkPaintChip();
    if (info.roomId) { if (WB.shown) wbHide(); WB.objs.clear(); WB.last = 0; WB.board = null; if (M.qaBox) M.qaBox.hidden = true; M.qaOpen = false; }          // the main-room tools close for people inside a room
    if (wasRoom !== info.roomId) {
      if (BK.st?.me) BK.st.me = { ...BK.st.me, ...info, help: null };          // the list on screen must not keep showing the old room's buttons while the new state loads
      if (document.activeElement?.closest?.('.pl-vote')) document.activeElement.blur();          // a ballot being filled in must not keep the old room's polls on screen
      buildMore(); BK.helpId = null;
      if (N.dirty.size) { N.dirty.clear(); clearTimeout(N.timer); notify('Notes you had just typed could not be saved because you changed rooms.'); }          // the server already moved you: they would land in the new room
      N.loaded = false; loadNotes(); loadPolls(); bkReady(); CL.wb.ops = []; CL.wb.cursor = 0; CL.d = null; if (CL.open) clLoad();
    }
    if (BK.open) bkLoad();
  }
  async function bkLoad() {
    const seq = (BK.seq = (BK.seq || 0) + 1);          // answers can arrive out of order: an answer older than one already shown is ignored (but a slow newest one never starves the others)
    try { const got = await bk(''); if (seq < (BK.shown || 0)) return; if (got.me.epoch < (BK.info.epoch || 0)) { bkLoad(); return; }          // this answer predates my last move (the socket already told me): ask again
      BK.shown = seq; BK.st = got; const me = BK.st.me; BK.helpId = me.help || null; const capsBefore = BK.caps.join(); BK.caps = me.caps || []; if (capsBefore !== BK.caps.join()) { renderPolls(); bkPaintChip(); }
      if (me.active !== BK.info.active || me.deadline !== BK.info.deadline || me.roomId !== BK.info.roomId) breakoutScope(me); } catch (e) { BK.st = null; if (BK.open) notify(e.message); }
    bkRender(); bkPaintChip();
    if (state.role === 'host' && BK.st?.me.active) { let d = null; try { d = await bk('/classroom/dashboard'); } catch { /* the counts are optional */ } if (seq < BK.shown) return; BK.dash = d; bkRender(); } else BK.dash = null;          // the room counts arrive after the list, never delaying it
  }
  function breakoutsChanged() { bkLoad(); if (CL.open) clLoad(); }
  function bkRender() {
    const box = BK.box; if (!box) return;
    const keep = [...box.querySelectorAll('input[aria-label="Room name"], select[aria-label="Minutes"], select[aria-label="Number of rooms"]')].map((x) => [x.getAttribute('aria-label'), x.value, x === document.activeElement]);          // a refresh must not wipe what the host is typing
    box.textContent = ''; const st = BK.st, host = state.role === 'host'; if (!st) { box.append(el('p', 'mg-note', 'Breakout rooms are unavailable right now.')); return; }
    const running = st.session.active;
    if (!host) { box.append(el('p', 'mg-note', st.me.roomId ? 'You are in ' + st.me.roomName + '. The host can bring everyone back at any time.' : running ? 'Breakout rooms are open. You were not assigned to a room.' : 'No breakout rooms are open. The host sets them up.')); if (st.me.roomId) box.append(bkGuestActs());
      if (st.me.caps?.length) box.append(el('p', 'mg-note', 'You are a room lead: ' + st.me.caps.map((k) => (CAPS.find((c) => c[0] === k) || [k, k])[1].toLowerCase()).join('; ') + '.'));
      for (const h of st.me.roomHelp || []) { const li = el('div', 'bk-p bk-help'); li.append(el('span', 'bk-on', '\u25CF', { 'aria-hidden': 'true' }), el('span', '', h.name + ' is asking for help')); const d = el('button', 'mg-act', 'Resolve', { type: 'button' }); d.onclick = async () => { try { await bk('/help/' + h.id + '/resolve', 'POST', {}); } catch (e) { notify(e.message); } bkLoad(); }; li.append(d); box.append(li); }
      return; }
    const run = (fn) => async () => { try { await fn(); } catch (e) { notify(e.message); } await bkLoad(); };
    if (running) {
      const head = el('div', 'bk-head'); head.append(el('strong', '', 'Rooms are open'), el('span', 'bk-left', '', { 'data-bk-left': '' })); const rec = el('button', 'mg-act', 'Bring everyone back', { type: 'button' });
      rec.onclick = run(async () => { if (await askConfirm('Bring everyone back?', 'Everyone returns to the main room now.', 'Bring back', true)) await bk('/recall', 'POST', {}); }); const an = el('button', 'mg-act', 'Announce', { type: 'button', title: 'Send a short message to the rooms' }); an.onclick = bkAnnounce; head.append(an, rec); box.append(head);
    } else {
      const row = el('div', 'mg-trow'); const n = el('select', '', '', { 'aria-label': 'Number of rooms' }); for (let i = 2; i <= 10; i++) n.append(new Option(i + ' rooms', String(i)));
      const split = el('button', 'mg-act', 'Split people', { type: 'button', title: 'Create the rooms and spread everyone who is here evenly' }); split.onclick = run(() => bk('/autosplit', 'POST', { rooms: Number(n.value) })); const bal = el('button', 'mg-act', 'Balance\u2026', { type: 'button', title: 'Deal everyone into the existing rooms evenly, in name order' }); bal.onclick = bkBalance; row.append(n, split, bal); box.append(row);
      const add = el('form', 'mg-trow'); const nm = el('input', '', '', { type: 'text', maxlength: '60', placeholder: 'Add a room (name)', 'aria-label': 'Room name', required: '' }); const ab = el('button', 'mg-act', 'Add', { type: 'submit' });
      add.onsubmit = (e) => { e.preventDefault(); run(() => bk('/rooms', 'POST', { name: nm.value }))(); }; add.append(nm, ab); box.append(add);
    }
    if (st.help?.length) {
      const hq = el('div', 'bk-room bk-help'); hq.append(el('div', 'bk-room-h', '', {}).appendChild(el('strong', '', 'Asking for help (' + st.help.length + ')')).parentElement);
      for (const h of st.help) { const li = el('div', 'bk-p'); li.append(el('span', 'bk-on', '\u25CF', { 'aria-hidden': 'true' }), el('span', '', h.name + ' \u00B7 ' + (h.roomName || 'a room')));
        const v = el('button', 'mg-act', st.hostRoom === h.roomId ? 'Here' : 'Visit', { type: 'button' }); v.disabled = st.hostRoom === h.roomId; v.onclick = run(() => bk('/visit', 'POST', { roomId: h.roomId }));
        const d = el('button', 'mg-act', 'Resolve', { type: 'button' }); d.onclick = run(() => bk('/help/' + h.id + '/resolve', 'POST', {})); li.append(v, d); hq.append(li); }
      box.append(hq);
    }
    const options = st.rooms.map((r) => [r.id, r.name]);
    const mover = (p, cur) => { const sel = el('select', 'bk-sel', '', { 'aria-label': 'Room for ' + p.name }); sel.append(new Option('Main room', '')); for (const [id, name] of options) sel.append(new Option(name, id)); sel.value = cur || ''; sel.onchange = run(() => bk('/assign', 'POST', { participantId: p.id, roomId: sel.value || null })); return sel; };
    for (const r of st.rooms) {
      const sec = el('div', 'bk-room'); const h = el('div', 'bk-room-h'); h.append(el('strong', '', r.name), el('small', '', r.members.length + (r.members.length === 1 ? ' person' : ' people')));
      { const nb = el('button', 'mg-act', 'Notes', { type: 'button', title: 'Read the notes of this room' }); nb.onclick = () => bkViewNotes(r); const bb = el('button', 'mg-act', 'Board', { type: 'button', title: 'Mission Board, exercises, whiteboard and reports of this room' }); bb.onclick = () => { CL.tab = 'missions'; if (CL.box) CL.box.hidden = false; clShow(r.id); }; h.append(nb, bb); }
      if (running) { const v = el('button', 'mg-act', st.hostRoom === r.id ? 'Leave room' : 'Visit', { type: 'button', title: 'Walk into this room to listen and help' }); v.onclick = run(() => bk('/visit', 'POST', { roomId: st.hostRoom === r.id ? null : r.id })); h.append(v); }
      else if (!r.members.length) { const d = el('button', 'mg-act', 'Delete', { type: 'button' }); d.onclick = run(() => bk('/rooms/' + r.id, 'DELETE')); h.append(d); }
      sec.append(h); const ds = BK.dash?.rooms.find((x) => x.id === r.id); if (ds && running) sec.append(el('small', 'mg-note bk-stats', (ds.openHelp ? ds.openHelp + ' asking for help \u00B7 ' : '') + (ds.runningExercises ? ds.runningExercises + ' exercise running \u00B7 ' : '') + 'tasks ' + ds.tasksDone + '/' + ds.tasks + ' \u00B7 missions reported ' + ds.submittedMissions + '/' + ds.missions + ' \u00B7 reports ' + ds.reports));
      for (const p of r.members) { const li = el('div', 'bk-p'); const st2 = p.online ? (p.connecting ? ' (connecting\u2026)' : p.media === 'failed' ? ' (connection failed)' : '') : ' (not here)'; li.append(el('span', p.online ? 'bk-on' : 'bk-off', '\u25CF', { 'aria-hidden': 'true', title: p.media === 'client_reported' ? 'The page of this person reports it is connected (not verified by the server)' : '' }), el('span', '', (p.caps?.length ? '\u2605 ' : '') + p.name + st2));
        if (running) { const lb = el('button', 'mg-act', 'Lead', { type: 'button', title: 'Give this person room-only powers' }); lb.onclick = () => bkLead(r, p); li.append(lb); } li.append(mover(p, r.id)); sec.append(li); } box.append(sec);
    }
    const un = el('div', 'bk-room'); un.append(el('div', 'bk-room-h', '', {}).appendChild(el('strong', '', 'Main room')).parentElement); for (const p of st.unassigned) { const li = el('div', 'bk-p'); li.append(el('span', p.online ? 'bk-on' : 'bk-off', '\u25CF', { 'aria-hidden': 'true' }), el('span', '', p.name + (p.online ? (p.connecting ? ' (connecting\u2026)' : '') : ' (not here)')), mover(p, null)); un.append(li); }
    if (!st.unassigned.length) un.append(el('p', 'mg-note', 'Everyone has a room.')); box.append(un);
    if (!running) { const row = el('div', 'mg-trow'); const mins = el('select', '', '', { 'aria-label': 'Minutes' }); for (const mn of [5, 10, 15, 20, 30, 45, 60]) mins.append(new Option(mn + ' minutes', String(mn))); mins.value = '15';
      const go = el('button', 'mg-act', 'Open rooms', { type: 'button' }); go.onclick = run(() => bk('/start', 'POST', { minutes: Number(mins.value) })); row.append(mins, go); box.append(row); }
    for (const [label, value, focused] of keep) { const x = box.querySelector('[aria-label="' + label + '"]'); if (x && value) { x.value = value; if (focused) x.focus(); } }
    bkPaintChip();
  }
  // ---- Room board (v4.31): Mission Board, timed exercises, room whiteboard and reports for ONE room. A person in a room sees their own room; the host picks any room.
  const CL = { box: null, open: false, rid: null, d: null, err: '', at: 0, tab: 'missions', tick: 0, wb: { ops: [], undone: new Set(), cursor: 0, cv: null, pts: [], down: false, color: '#222222', text: false, last: 0 } };
  const clApi = (path, method, body) => bk('/rooms/' + CL.rid + path, method, body);
  const clMgr = () => !!CL.d?.canManage;
  const clLeft = (x) => Math.max(0, x.leftS - (Date.now() - CL.at) / 1000);
  async function clLoad(force) {
    if (!CL.open) return; const rid = state.role === 'host' ? CL.rid : BK.info.roomId; CL.rid = rid;
    if (!rid) { CL.d = null; CL.err = state.role === 'host' ? 'Choose a room.' : 'The board is available while you are in a breakout room.'; clRender(); return; }
    try { CL.d = await clApi('/board'); CL.err = ''; CL.at = Date.now(); } catch (e) { CL.d = null; CL.err = e.status === 404 ? 'This room is not available to you right now.' : e.message; }
    clRender(force); if (CL.d && CL.tab === 'whiteboard') clWbSync();
  }
  function clShow(rid) { if (rid) CL.rid = rid; CL.open = true; if (CL.box) { CL.box.hidden = false; } clLoad(); }
  const clBusy = () => CL.box?.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  function clRender(force) {
    const box = CL.box; if (!box || box.hidden) return; if (!force && (clBusy() || CL.wb.down || (CL.tab === 'whiteboard' && CL.wb.cv && box.contains(CL.wb.cv) && CL.wb.rid === CL.rid))) return;          // never rebuild a form somebody is typing in, nor a board somebody is drawing on
    box.textContent = ''; const d = CL.d, host = state.role === 'host';
    if (host && BK.st?.rooms?.length) { const sel = el('select', 'bk-sel', '', { 'aria-label': 'Room board for' }); sel.append(new Option('Choose a room', '')); for (const r of BK.st.rooms) sel.append(new Option(r.name, r.id)); sel.value = CL.rid || ''; sel.onchange = () => { CL.rid = sel.value || null; clLoad(); }; box.append(sel); }
    if (!d) { box.append(el('p', 'mg-note', CL.err || 'Loading…')); return; }
    const tabs = el('div', 'cl-tabs'); for (const [k, label] of [['missions', 'Missions'], ['exercises', 'Exercises'], ['whiteboard', 'Whiteboard'], ['reports', 'Reports']]) { const b = el('button', 'mg-act', label, { type: 'button', 'aria-pressed': String(CL.tab === k) }); b.onclick = () => { CL.tab = k; clRender(true); if (k === 'whiteboard') clWbSync(true); }; tabs.append(b); }
    box.append(el('strong', 'cl-h', d.room.name + (d.rooms.open ? '' : ' (rooms closed: read only)')), tabs);
    // after an action the control that started it is released (and a submitted form emptied), so the refresh can rebuild the board without wiping something the person is typing elsewhere
    const act = (fn, msg) => async () => { const was = document.activeElement; try { await fn(); if (msg) notify(msg); } catch (e) { notify(e.message); } if (was && was !== document.body && document.activeElement === was && CL.box?.contains(was)) was.blur(); await clLoad(); };
    const form = (fields, label, fn) => { const f = el('form', 'cl-form'); const els = fields.map(([name, kind, ph, max]) => { const x = el(kind === 'area' ? 'textarea' : 'input', '', '', { 'aria-label': ph, placeholder: ph, maxlength: String(max || 180) }); if (kind === 'num') { x.type = 'number'; x.min = '1'; x.max = '240'; x.value = '10'; } else if (kind !== 'area') x.type = 'text'; x.name = name; return x; });
      f.append(...els, el('button', 'mg-act', label, { type: 'submit' })); f.onsubmit = (e) => { e.preventDefault(); const v = Object.fromEntries(els.map((x) => [x.name, x.value])); act(async () => { await fn(v); for (const x of els) if (x.type !== 'number') x.value = ''; })(); }; return f; };
    if (CL.tab === 'missions') {
      if (!d.missions.length) box.append(el('p', 'mg-note', 'No missions yet.' + (clMgr() ? '' : ' The host or the room lead adds them.')));
      for (const mi of d.missions) {
        const c = el('div', 'bk-room'); const h = el('div', 'bk-room-h'); h.append(el('strong', '', mi.title), el('small', '', mi.state === 'open' ? mi.done + '/' + mi.tasks.length + ' tasks done' : 'Report submitted')); c.append(h);
        if (mi.instructions) c.append(el('p', 'mg-note', mi.instructions));
        for (const t of mi.tasks) { const li = el('div', 'bk-p'); const can = mi.state === 'open' && (clMgr() || t.assigneeId === d.me); const sel = el('select', 'bk-sel', '', { 'aria-label': 'State of ' + t.title }); for (const [v, l] of [['todo', 'To do'], ['doing', 'Doing'], ['done', 'Done']]) sel.append(new Option(l, v)); sel.value = t.state; sel.disabled = !can;
          sel.onchange = act(() => bk('/tasks/' + t.id, 'PATCH', { state: sel.value, expectedVersion: t.version })); li.append(el('span', '', '▣', { 'aria-hidden': 'true' }), el('span', '', t.title + (t.assignee ? ' · ' + t.assignee : '')), sel); c.append(li); }
        if (mi.state === 'open' && clMgr()) { c.append(form([['title', 'text', 'Add a task']], 'Add', (v) => bk('/missions/' + mi.id + '/tasks', 'POST', { title: v.title })));
          const asg = c.lastChild; const who = el('select', 'bk-sel', '', { 'aria-label': 'Give the task to' }); who.append(new Option('Anyone', '')); for (const p of d.members) who.append(new Option(p.name, p.id)); asg.insertBefore(who, asg.lastChild); asg.onsubmit = (e) => { e.preventDefault(); const t = asg.querySelector('input').value; act(() => bk('/missions/' + mi.id + '/tasks', 'POST', { title: t, assigneeId: who.value || null }))(); };
          c.append(form([['report', 'area', 'Write the group report', 12000]], 'Submit report', (v) => bk('/missions/' + mi.id + '/report', 'POST', { report: v.report }))); }
        if (mi.report) { c.append(el('p', 'mg-note', 'Report by ' + (mi.report.by || 'someone') + ':'), el('pre', 'nt-preview', mi.report.text, { tabindex: '0' })); }
        box.append(c);
      }
      if (clMgr() && d.rooms.open) box.append(form([['title', 'text', 'New mission title'], ['instructions', 'area', 'Instructions (optional)', 12000]], 'Add mission', (v) => clApi('/missions', 'POST', { title: v.title, instructions: v.instructions })));
    } else if (CL.tab === 'exercises') {
      if (!d.exercises.length) box.append(el('p', 'mg-note', 'No exercises yet.'));
      for (const x of d.exercises) {
        const c = el('div', 'bk-room'); const h = el('div', 'bk-room-h'); h.append(el('strong', '', x.title), el('small', '', x.state === 'running' ? fmt(clLeft(x)) + ' left' : x.state === 'draft' ? 'Not started' : 'Closed', { 'data-cl-left': x.state === 'running' ? String(x.id) : '' })); c.append(h);
        if (x.prompt) c.append(el('p', 'mg-note', x.prompt));
        if (x.state === 'draft' && clMgr()) { const b = el('button', 'mg-act', 'Start (' + Math.round(x.durationS / 60 * 10) / 10 + ' min)', { type: 'button' }); b.onclick = act(() => bk('/exercises/' + x.id + '/start', 'POST', {})); c.append(b); }
        if (x.state === 'running' && clMgr()) { const b = el('button', 'mg-act', 'End now', { type: 'button' }); b.onclick = act(() => bk('/exercises/' + x.id + '/close', 'POST', {})); c.append(b); }
        if (x.mine) c.append(el('p', 'mg-note', 'Your answer: ' + x.mine.answer)); else if (x.state === 'running') c.append(form([['answer', 'area', 'Your answer', 12000]], 'Submit answer', (v) => bk('/exercises/' + x.id + '/submit', 'POST', { answer: v.answer })));
        if (clMgr()) { c.append(el('small', 'mg-note', x.submissions + ' answer' + (x.submissions === 1 ? '' : 's'))); for (const a of x.answers || []) c.append(el('p', 'mg-note', a.name + ': ' + a.answer)); }
        box.append(c);
      }
      if (clMgr() && d.rooms.open) { const f = form([['title', 'text', 'New exercise title'], ['prompt', 'area', 'What should they do?', 12000], ['minutes', 'num', 'Minutes']], 'Create exercise', (v) => clApi('/exercises', 'POST', { title: v.title, prompt: v.prompt, durationSeconds: Math.round(Number(v.minutes) * 60) })); box.append(f); }
    } else if (CL.tab === 'whiteboard') {
      const W = CL.wb; const tools = el('div', 'cl-tools'); for (const col of ['#222222', '#d62828', '#1d6fd6', '#1a9e4a']) { const b = el('button', 'wb-sw', '', { type: 'button', 'aria-label': 'Pen ' + col, 'aria-pressed': String(W.color === col && !W.text) }); b.style.background = col; b.onclick = () => { W.color = col; W.text = false; clRender(true); clWbSync(true); }; tools.append(b); }
      const tb = el('button', 'mg-act', 'Text', { type: 'button', 'aria-pressed': String(W.text), title: 'Click the board to place text' }); tb.onclick = () => { W.text = !W.text; clRender(true); clWbSync(true); }; tools.append(tb);
      const un = el('button', 'mg-act', 'Undo mine', { type: 'button' }); un.onclick = act(async () => { const mine = [...W.ops].reverse().find((o) => o.by === d.me && o.kind !== 'undo' && o.kind !== 'clear' && !W.undone.has(o.opId)); if (!mine) throw new Error('Nothing of yours to undo'); await clApi('/whiteboard', 'POST', { opId: crypto.randomUUID(), kind: 'undo', target: mine.opId }); }); tools.append(un);
      if (clMgr()) { const cl2 = el('button', 'mg-act', 'Clear', { type: 'button' }); cl2.onclick = act(async () => { if (await askConfirm('Clear the board?', 'Everything drawn in this room is hidden for everyone.', 'Clear', true)) await clApi('/whiteboard', 'POST', { opId: crypto.randomUUID(), kind: 'clear' }); }); tools.append(cl2); }
      const cv = el('canvas', 'wb-cv', '', { width: '800', height: '500', 'aria-label': 'Room whiteboard drawing surface' }); W.cv = cv; box.append(tools, cv); clWbBind(cv); clWbPaint();
    } else {
      if (!d.reports.length) box.append(el('p', 'mg-note', 'No reports yet.'));
      for (const r of d.reports) { const c = el('div', 'bk-room'); c.append(el('strong', '', r.title), el('pre', 'nt-preview', r.content, { tabindex: '0' })); box.append(c); }
      if (clMgr() && d.rooms.open) box.append(form([['title', 'text', 'Report title'], ['content', 'area', 'What did the group find?', 20000]], 'Save report', (v) => clApi('/reports', 'POST', { title: v.title, content: v.content })));
    }
  }
  // the whiteboard is an operation log: fetch what is new, then paint everything from the log (so late joiners, reconnects and undo all agree)
  async function clWbSync(full) {
    if (!CL.open || !CL.rid || CL.tab !== 'whiteboard') return; const W = CL.wb; if (full || W.rid !== CL.rid) { if (W.rid !== CL.rid) { W.ops = []; W.cursor = 0; } W.rid = CL.rid; }
    try { for (let i = 0; i < 20; i++) { const r = await clApi('/whiteboard?after=' + W.cursor, 'GET'); for (const o of r.ops) W.ops.push(o); const more = r.ops.length === 500; W.cursor = r.cursor; if (!more) break; } } catch { return; }
    clWbPaint();
  }
  function clWbPaint() {
    const W = CL.wb, cv = W.cv; if (!cv || !cv.isConnected) return; W.undone = new Set(); let live = [];
    for (const o of W.ops) { if (o.kind === 'clear') live = []; else if (o.kind === 'undo') W.undone.add(o.target); else live.push(o); }
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.lineCap = 'round'; g.lineJoin = 'round';
    for (const o of live) { if (W.undone.has(o.opId)) continue; if (o.kind === 'stroke') { g.strokeStyle = o.color; g.lineWidth = o.width; g.beginPath(); o.points.forEach((p, i) => (i ? g.lineTo(p.x * cv.width, p.y * cv.height) : g.moveTo(p.x * cv.width, p.y * cv.height))); if (o.points.length === 1) g.lineTo(o.points[0].x * cv.width + .1, o.points[0].y * cv.height); g.stroke(); }
      else if (o.kind === 'text') { g.fillStyle = o.color; g.font = '20px sans-serif'; g.fillText(o.text, o.points[0].x * cv.width, o.points[0].y * cv.height); } }
  }
  function clWbBind(cv) {
    const W = CL.wb; const pt = (e) => { const r = cv.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
    const send = async (op) => { try { await clApi('/whiteboard', 'POST', { opId: crypto.randomUUID(), ...op }); await clWbSync(); } catch (e) { notify(e.message); await clWbSync(); } };
    cv.onpointerdown = async (e) => { if (!CL.d?.rooms.open) return; if (W.text) { const t = window.prompt('Text to place (up to 500 characters)'); if (t && t.trim()) await send({ kind: 'text', points: [pt(e)], text: t.slice(0, 500), color: W.color }); return; } W.down = true; W.pts = [pt(e)]; cv.setPointerCapture?.(e.pointerId); };
    cv.onpointermove = (e) => { if (!W.down) return; const p = pt(e), q = W.pts.at(-1), g = cv.getContext('2d'); if (W.pts.length < 1000) { g.strokeStyle = W.color; g.lineWidth = 3; g.lineCap = 'round'; g.beginPath(); g.moveTo(q.x * cv.width, q.y * cv.height); g.lineTo(p.x * cv.width, p.y * cv.height); g.stroke(); W.pts.push(p); } };
    const end = async () => { if (!W.down) return; W.down = false; const pts = W.pts; W.pts = []; if (pts.length) await send({ kind: 'stroke', points: pts, color: W.color, width: 3 }); };
    cv.onpointerup = end; cv.onpointercancel = end;
  }
  function clPanel() { const box = el('div', 'mg-qa cl-box'); box.hidden = true; CL.box = box; return box; }
  function clTick() { if (!CL.open || !CL.d) return; let hit = false; document.querySelectorAll('[data-cl-left]').forEach((n) => { const id = n.dataset.clLeft; if (!id) return; const x = CL.d.exercises.find((e) => e.id === id); if (!x) return; const s = clLeft(x); n.textContent = s > 0 ? fmt(s) + ' left' : 'Time is up'; if (s <= 0) hit = true; }); if (hit && !CL.hit) { CL.hit = true; setTimeout(() => { CL.hit = false; clLoad(); }, 1500); } }
  setInterval(clTick, 1000);
  // announcements (host, or a lead with room_announcement)
  function bkAnnounce() {
    const host = state.role === 'host'; rcModal('Message the room' + (host ? 's' : ''), (box) => {
      const ta = el('textarea', '', '', { maxlength: '300', rows: '3', 'aria-label': 'Message', placeholder: 'A short message (up to 300 characters)' }); let sel = null;
      if (host) { sel = el('select', '', '', { 'aria-label': 'Send to' }); sel.append(new Option('Every room', '')); for (const r of BK.st?.rooms || []) sel.append(new Option(r.name, r.id)); box.append(sel); }
      box.append(ta); const row = el('div', 'rc-row'), ok = el('button', 'rc-primary', 'Send', { type: 'button' }), no = el('button', 'rc-secondary', 'Cancel', { type: 'button' });
      ok.onclick = async () => { ok.disabled = true; try { await bk('/announce', 'POST', { text: ta.value, roomId: sel?.value || null }); rcClose(); notify('Message sent'); } catch (e) { notify(e.message); ok.disabled = false; } }; no.onclick = () => rcClose(); row.append(ok, no); box.append(row);
    });
  }
  // the host gives a person inside a room a few room-only powers
  const CAPS = [['help_triage', 'See and resolve help requests of this room'], ['room_announcement', 'Send short messages to this room'], ['room_notes', 'Edit the Mission Board, exercises, reports, clear the whiteboard'], ['room_polls', 'Run polls in this room']];
  function bkLead(r, p) {
    rcModal('Room lead · ' + p.name, (box) => {
      box.append(el('p', '', 'Powers that exist only inside ' + r.name + '. They end when ' + p.name + ' leaves the room or the rooms close.')); const boxes = [];
      for (const [k, label] of CAPS) { const l = el('label', 'cl-cap'); const c = el('input', '', '', { type: 'checkbox' }); c.checked = (p.caps || []).includes(k); boxes.push([k, c]); l.append(c, document.createTextNode(' ' + label)); box.append(l); }
      const row = el('div', 'rc-row'), ok = el('button', 'rc-primary', 'Save', { type: 'button' }), no = el('button', 'rc-secondary', 'Cancel', { type: 'button' });
      ok.onclick = async () => { ok.disabled = true; try { await bk('/rooms/' + r.id + '/leads/' + p.id, 'PUT', { capabilities: boxes.filter(([, c]) => c.checked).map(([k]) => k) }); rcClose(); notify('Saved'); bkLoad(); } catch (e) { notify(e.message); ok.disabled = false; } }; no.onclick = () => rcClose(); row.append(ok, no); box.append(row);
    });
  }
  async function bkBalance() {
    try { const { plan } = await bk('/classroom/plan', 'POST', { maxPerRoom: 30 }); if (!plan.length) { notify('Nobody to place'); return; }
      const per = {}; for (const x of plan) per[x.roomName] = (per[x.roomName] || 0) + 1;
      if (!(await askConfirm('Balance people across rooms?', Object.entries(per).map(([n, c]) => n + ': ' + c).join(', ') + '. People are dealt in name order. You can still move anyone afterwards.', 'Balance'))) return;
      const r = await bk('/classroom/apply', 'POST', { plan: plan.map((x) => ({ participantId: x.participantId, roomId: x.roomId })) }); const bad = r.results.filter((x) => !x.ok).length; notify(bad ? 'Placed with ' + bad + ' problem(s)' : 'People placed'); bkLoad();
    } catch (e) { notify(e.message); }
  }
  function bkPanel() { const box = el('div', 'mg-qa bk-box'); box.hidden = true; BK.box = box; return box; }
  function buildMore() {
    const t = $('tab-more'); t.textContent = ''; t.classList.add('more-v41-compact');
    const host = state.role === 'host';
    const ICO = {
      people: '<circle cx="9" cy="8" r="3"/><path d="M3 20c.6-3.4 3-5 6-5s5.4 1.6 6 5"/><circle cx="17" cy="9" r="2.3"/><path d="M16.5 14.2c2.6.1 4.1 1.5 4.5 4.3"/>',
      smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14c.9 1.4 2.1 2.1 3.5 2.1s2.6-.7 3.5-2.1M9 9.5h.01M15 9.5h.01"/>',
      pen: '<path d="M4 20l4-1 11-11a2.1 2.1 0 0 0-3-3L5 16l-1 4Z"/><path d="M14 7l3 3"/>',
      folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
      qa: '<path d="M4 5h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><path d="M8 9a1.6 1.6 0 1 1 2.2 1.5c-.5.2-.7.5-.7 1M9.5 13h.01"/>',
      spark: '<path d="M12 3l2.2 6.3L21 12l-6.8 2.7L12 21l-2.2-6.3L3 12l6.8-2.7Z"/>',
      doc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>',
      cc: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3"/>',
      list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
      bot: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 8V5M9 13h.01M15 13h.01M9.5 16.5h5"/><circle cx="12" cy="4" r="1"/>',
      cal: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
      userplus: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.6-3.4 3-5 6-5s5.4 1.6 6 5M18 8v6M15 11h6"/>',
      info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
      gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>',
      shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6Z"/>',
      users: '<circle cx="12" cy="8" r="3"/><circle cx="5.5" cy="10" r="2"/><circle cx="18.5" cy="10" r="2"/><path d="M6.5 19c.5-3 2.6-4.5 5.5-4.5s5 1.5 5.5 4.5"/>',
      lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
      video: '<rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10.5 5-3v9l-5-3"/>',
      layers: '<path d="M12 3l9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5M3 17.5l9 5 9-5"/>',
      timer: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 1.5M9.5 3h5"/>',
      target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
      layout: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
      image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
      sliders: '<path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12M20 17h0"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="17" r="2"/>',
      dots: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
      open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
      chev: '<path d="m6 9 6 6 6-6"/>',
    };
    const svg = (k, cls) => { const x = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); x.setAttribute('viewBox', '0 0 24 24'); x.setAttribute('aria-hidden', 'true'); x.setAttribute('class', 'mi ' + (cls || '')); x.innerHTML = ICO[k]; return x; };   // static icon markup only
    const NA = 'Unavailable: needs its meeting service and privacy checks first';
    const swtch = (label, on, disabled, change) => { const b = el('button', 'mg-sw', '', { type: 'button', role: 'switch', 'aria-checked': String(!!on), 'aria-label': label }); b.append(el('span', 'mg-knob')); if (disabled) { b.disabled = true; b.title = NA; } else b.onclick = change; return b; };
    const tile = (k, label, run, opts = {}) => { const b = el('button', 'mg-tile', '', { type: 'button' }); b.append(svg(k), el('span', '', label)); if (opts.off) { b.disabled = true; b.title = opts.title || NA; b.setAttribute('aria-disabled', 'true'); } else b.onclick = run; return b; };
    const groups = [
      { id: 'collab', icon: 'people', title: 'Collaboration', sub: 'Work together during the meeting' },
      { id: 'intel', icon: 'spark', title: 'Meeting intelligence', sub: 'AI-powered meeting assistance' },
      { id: 'manage', icon: 'cal', title: 'Meeting management', sub: 'Host and co-host controls' },
      { id: 'sec', icon: 'lock', title: 'Security and recording', sub: 'Control access, recording and privacy' },
      { id: 'tools', icon: 'layers', title: 'Tools and settings', sub: 'Productivity tools and personal preferences' },
    ];
    const fill = {
      collab(body) {
        const row = (k, title, desc, action) => { const r = el('div', 'mg-row'); const tt = el('div', 'mg-row-t'); tt.append(el('strong', '', title), el('small', '', desc)); r.append(el('span', 'mg-ic', ''), tt); r.firstChild.append(svg(k)); if (action) r.append(action); return r; };
        const emoji = el('div', 'mg-emoji'); for (const e of ['👍', '👏', '❤️', '🎉', '😂']) { const b = el('button', '', e, { type: 'button', 'aria-label': 'React with ' + e }); b.onclick = () => state.socket?.emit('reaction', e); emoji.append(b); }
        const extra = el('div', 'mg-emoji'); extra.hidden = true; for (const e of ['🙌', '🤔', '👎', '✋', '✅']) { const b = el('button', '', e, { type: 'button', 'aria-label': 'React with ' + e }); b.onclick = () => state.socket?.emit('reaction', e); extra.append(b); }
        const moreB = el('button', '', '\u22EF', { type: 'button', 'aria-label': 'More reactions', 'aria-expanded': 'false' }); moreB.onclick = () => { extra.hidden = !extra.hidden; moreB.setAttribute('aria-expanded', String(!extra.hidden)); }; emoji.append(moreB);
        body.append(row('smile', 'Reactions', 'Send quick reactions to the meeting.', emoji), extra);
        const off = (label, icon) => { const b = el('button', 'mg-act', '', { type: 'button', disabled: '', title: NA, 'aria-disabled': 'true' }); b.append(svg(icon), document.createTextNode(label)); return b; };
        const bkBtn = el('button', 'mg-act', '', { type: 'button' }); bkBtn.append(svg('userplus'), document.createTextNode(host ? 'Create' : 'Status'));
        if (!isOn('breakouts')) { bkBtn.disabled = true; bkBtn.title = NA; bkBtn.setAttribute('aria-disabled', 'true'); }
        else bkBtn.onclick = () => { const bx = BK.box; bx.hidden = !bx.hidden; BK.open = !bx.hidden; bkBtn.setAttribute('aria-expanded', String(!bx.hidden)); if (!bx.hidden) bkLoad(); };
        const clBtn = el('button', 'mg-act', '', { type: 'button' }); clBtn.append(svg('open'), document.createTextNode('Open'));
        if (!isOn('breakouts') || (!host && !BK.info.roomId)) { clBtn.disabled = true; clBtn.title = isOn('breakouts') ? 'Available while you are in a breakout room' : NA; clBtn.setAttribute('aria-disabled', 'true'); }
        else clBtn.onclick = () => { const bx = CL.box; bx.hidden = !bx.hidden; CL.open = !bx.hidden; clBtn.setAttribute('aria-expanded', String(!bx.hidden)); if (!bx.hidden) { if (host && !BK.st) bkLoad(); clLoad(true); } };
        const qaBtn = el('button', 'mg-act', '', { type: 'button' }); qaBtn.append(svg('open'), document.createTextNode('Open'));
        if (!isOn('qa') || !inMain()) { qaBtn.disabled = true; qaBtn.title = inMain() ? NA : 'Only in the main room'; qaBtn.setAttribute('aria-disabled', 'true'); }
        else qaBtn.onclick = () => { const bx = M.qaBox; bx.hidden = !bx.hidden; qaBtn.lastChild.textContent = bx.hidden ? 'Open' : 'Close'; qaBtn.setAttribute('aria-expanded', String(!bx.hidden)); M.qaOpen = !bx.hidden; clearInterval(M.qaPoll); M.qaPoll = 0; if (!bx.hidden) { renderQa(); M.qaPoll = setInterval(() => { if (M.qaBox && !M.qaBox.hidden && !document.hidden) renderQa(); }, 6000); } };       // the push is the fast path; the refresh catches anything missed
        const wbBtn = el('button', 'mg-act wb-open', '', { type: 'button' }); wbBtn.append(svg('open'), document.createTextNode('Open'));
        if (!isOn('whiteboard') || !inMain()) { wbBtn.disabled = true; wbBtn.title = inMain() ? NA : 'Only in the main room'; wbBtn.setAttribute('aria-disabled', 'true'); }
        else wbBtn.onclick = async () => { wbBtn.disabled = true; try { if (host) await more('/whiteboard', 'POST', { action: 'open' }); await wbOpen(); } catch (e) { notify(e.message); } wbBtn.disabled = false; };
        body.append(row('pen', 'Whiteboard', 'Collaborative board for visual brainstorming.', wbBtn), row('people', 'Breakout rooms', 'Split participants into smaller discussion groups.', bkBtn), bkPanel(), row('pen', 'Room board', 'Missions, timed exercises, a drawing board and reports for your room.', clBtn), clPanel(),
          row('folder', 'Shared files', 'Share and access meeting files (host controlled).', off('Open', 'open')), row('qa', 'Q&A', 'Collect, review and answer participant questions.', qaBtn), qaPanel());
        if (CL.open && isOn('breakouts') && (host || BK.info.roomId)) { CL.box.hidden = false; clBtn.setAttribute('aria-expanded', 'true'); clLoad(true); }
        if (BK.open && isOn('breakouts')) { BK.box.hidden = false; bkBtn.setAttribute('aria-expanded', 'true'); bkRender(); bkLoad(); }
        if (M.qaOpen && isOn('qa')) { M.qaBox.hidden = false; qaBtn.lastChild.textContent = 'Close'; qaBtn.setAttribute('aria-expanded', 'true'); renderQa(); clearInterval(M.qaPoll); M.qaPoll = setInterval(() => { if (M.qaBox && !M.qaBox.hidden && !document.hidden) renderQa(); }, 6000); }       // the tab was rebuilt (a setting changed): keep the panel open
      },
      intel(body) {
        const grid = el('div', 'mg-grid4'); I.boxes = [];
        const card = (k, title, desc, ctl) => { const c = el('div', 'mg-card'); const h = el('div', 'mg-card-h'); h.append(svg(k), el('strong', '', title)); c.append(h, el('small', '', desc), ctl); grid.append(c); };
        const live = (label) => { const box = el('div', 'mg-intel-ctl'); I.boxes.push([box, label]); intelPaint(box, label); return box; };
        const btn = (label, why) => el('button', 'mg-act', label, { type: 'button', disabled: '', title: why, 'aria-disabled': 'true' });
        card('doc', 'AI Summary', 'Generate key notes, decisions and action items', live('Generate'));
        card('cc', 'Live Transcript', 'Real-time captions and transcript', swtch('Live transcript', false, true));
        card('list', 'Key Takeaways', 'Auto-extract topics and action items', live('View takeaways'));
        card('bot', 'Ask QorllaMate', 'Get answers from the meeting content', btn('Ask AI', 'Needs the private AI gateway question service, which is not connected yet'));
        body.append(grid, el('p', 'mg-note', 'Summaries and takeaways use only the chat messages of people who agreed, and are produced in the Workplace AI. Live captions need a speech-to-text service that is not connected yet.'));
      },
      manage(body) {
        const grid = el('div', 'mg-grid5'); const detail = el('div', 'mg-detail'); detail.hidden = true;
        const show = (node) => { detail.textContent = ''; if (node) { detail.append(node); detail.hidden = false; } else detail.hidden = true; };
        const info = () => { const d = el('div', 'mg-info'); d.append(el('strong', '', 'Meeting information'), el('p', 'muted', state.meetingInfo || 'Share the invitation link to bring people in.')); return d; };
        grid.append(tile('userplus', 'Invite people', () => $('copyLink').click()),
          tile('info', 'Meeting info', () => show(detail.hidden || detail.dataset.k !== 'info' ? (detail.dataset.k = 'info', info()) : (detail.dataset.k = '', null))),
          tile('gear', 'Meeting settings', () => $('settingsBtn').click()),
          tile('shield', 'Role & permissions', () => { if (detail.dataset.k === 'roles') { detail.dataset.k = ''; show(null); return; } detail.dataset.k = 'roles'; const d = el('div'); hostPanel(d); show(d); }, host && state.settings ? {} : { off: true, title: 'Only the host manages roles and permissions' }),
          tile('users', 'Attendance', async () => { if (detail.dataset.k === 'att') { detail.dataset.k = ''; show(null); return; } detail.dataset.k = 'att'; show(await attendancePanel()); }, host && isOn('attendance') ? {} : { off: true, title: host ? NA : 'Only the host sees the attendance report; everyone sees who is here in the People tab' }));
        body.append(grid, detail);
        if (host) { const exp = el('button', 'mg-link', 'Export notes (Markdown)', { type: 'button' }); exp.onclick = () => exportNotes('md'); body.append(exp); }
      },
      sec(body) {
        const wrap = el('div', 'mg-sec3');
        const rec = el('div', 'mg-opt'); const rt = el('div', 'mg-opt-t'); rt.append(el('strong', '', 'Recording'), el('small', '', host ? 'Record and save this meeting' : 'Only the host can record')); rec.append(svg('video', 'mg-blue'), rt, swtch('Recording', !!state.recording, !host, () => $('recordBtn').click()));
        const lock = el('div', 'mg-opt'); const lt = el('div', 'mg-opt-t'); lt.append(el('strong', '', 'Lock meeting'), el('small', '', 'Prevent new participants from joining'));
        const lockOn = !!(state.settings && state.settings.locked); const lsw = swtch('Lock meeting', lockOn, !(host && state.settings), async () => {
          lsw.disabled = true; const want = lsw.getAttribute('aria-checked') !== 'true';
          try { const r = await fetch(BASE + 'api/meetings/' + state.meetingId + '/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token }, body: JSON.stringify({ locked: want }) }); const j = await r.json(); if (!r.ok) throw Error(j.error); Object.assign(state.settings, j); lsw.setAttribute('aria-checked', String(want)); announce('Lock meeting ' + (want ? 'on' : 'off')); } catch (e) { notify(e.message); }
          lsw.disabled = false; });
        lock.append(svg('lock', 'mg-blue'), lt, lsw);
        const detail = el('div', 'mg-detail'); detail.hidden = true;
        const sb = el('button', 'mg-act mg-wide', '', { type: 'button' }); sb.append(svg('gear'), document.createTextNode('Security settings'));
        sb.onclick = () => { if (!detail.hidden) { detail.hidden = true; return; } detail.textContent = ''; const d = el('div', 'mg-info'); d.append(el('strong', '', 'Calls and chat are encrypted in transit'), el('p', 'muted', 'Audio and video use WebRTC (DTLS-SRTP); the page uses HTTPS in production. Recording only happens if everyone present agrees, and anyone can withdraw at any time.')); detail.append(d);
          if (host) { const rb = el('button', 'mg-link', 'Recordings (download or delete)…', { type: 'button' }); rb.onclick = openRecordings; detail.append(rb); } detail.hidden = false; };
        wrap.append(rec, lock, sb); body.append(wrap, detail);
      },
      tools(body) {
        const grid = el('div', 'mg-grid6');
        const detail = el('div', 'mg-detail'); detail.hidden = true;
        const layoutNext = () => { const order = ['gallery', 'speaker', 'stage']; const cur = order.findIndex((k) => document.querySelector('[data-layout="' + k + '"].selected')); const nk = order[(cur + 1) % 3]; document.querySelector('[data-layout="' + nk + '"]')?.click(); if (isOn('preferences')) savePref({ layout: nk }); };
        const timerTile = tile('timer', 'Timer', () => { if (detail.dataset.k === 'timer') { detail.dataset.k = ''; detail.hidden = true; return; } detail.dataset.k = 'timer'; detail.textContent = ''; detail.append(timerPanel()); detail.hidden = false; }, isOn('timer') && inMain() ? {} : { off: true, title: inMain() ? NA : 'Only in the main room' });
        const focusOn = document.body.classList.contains('more-focus');
        const focusTile = tile('target', 'Focus mode', () => { const on = !document.body.classList.contains('more-focus'); setFocus(on); focusTile.setAttribute('aria-pressed', String(on)); if (isOn('preferences')) savePref({ focusMode: on }); }, isOn('preferences') ? {} : { off: true });
        focusTile.setAttribute('aria-pressed', String(focusOn));
        grid.append(timerTile, focusTile, tile('layout', 'Layout', layoutNext),
          tile('image', 'Background & effects', () => {}, { off: true }), tile('sliders', 'Audio & video', () => $('settingsBtn').click()), tile('dots', 'More settings', () => $('settingsBtn').click()));
        body.append(grid, detail);
      },
    };
    for (const g of groups) {
      const sec = el('section', 'mg'); const hb = el('button', 'mg-h', '', { type: 'button', 'aria-expanded': String(openGroups.has(g.id)), 'aria-controls': 'mg-' + g.id, id: 'mgh-' + g.id });
      const tt = el('span', 'mg-h-t'); tt.append(el('strong', '', g.title), el('small', '', g.sub)); hb.append(svg(g.icon, 'mg-h-ic'), tt, svg('chev', 'mg-chev'));
      const body = el('div', 'mg-b', '', { id: 'mg-' + g.id, role: 'region', 'aria-labelledby': 'mgh-' + g.id }); body.hidden = !openGroups.has(g.id);
      fill[g.id](body);
      hb.onclick = () => { const open = hb.getAttribute('aria-expanded') !== 'true'; if (open) openGroups.add(g.id); else openGroups.delete(g.id); hb.setAttribute('aria-expanded', String(open)); body.hidden = !open; };
      sec.append(hb, body); t.append(sec);
    }
  }

  async function openRecordings() {
    let d; try { d = await call('/recordings'); } catch (e) { return notify(e.message); }
    const fmt = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
    rcModal('Recordings', (box) => {
      if (!d.storage.ready) box.append(el('p', 'rc-err', 'Recording storage is not configured: ' + d.storage.reason));
      box.append(el('p', 'rc-note', 'Recordings are encrypted on the server. Download links work once and expire in minutes; every download and deletion is logged.'));
      const ul = el('ul', 'rc-list'); if (!d.recordings.length) ul.append(el('li', '', 'No recordings yet.'));
      for (const r of d.recordings) {
        const li = el('li'), t = el('span', '', new Date(r.startedAt).toLocaleString() + ' · ' + r.status + (r.status === 'available' ? ' · ' + fmt(r.bytes) : '') + (r.partial ? ' · partial' : '') + (r.legalHold ? ' · legal hold' : '') + (r.retentionUntil && r.status !== 'deleted' ? ' · kept until ' + new Date(r.retentionUntil).toLocaleDateString() : ''));
        const act = el('span'); li.append(t, act);
        if (r.status === 'available') { const b = el('button', 'rc-secondary', 'Download'); b.onclick = async () => { b.disabled = true; try { const x = await fetch(BASE + 'api/v1/recordings/' + r.id + '/access', { headers: { Authorization: 'Bearer ' + state.token } }); const j = await x.json(); if (!x.ok) throw Error(j.error); const a = el('a'); a.href = BASE + j.url.replace(/^\//, ''); a.rel = 'noopener'; document.body.append(a); a.click(); a.remove(); notify('Download started'); } catch (e) { notify(e.message); } b.disabled = false; }; act.append(b); }
        if (['available', 'failed'].includes(r.status)) { const x = el('button', 'rc-secondary', 'Delete'); x.onclick = async () => { if (!(await askConfirm('Delete this recording?', 'The encrypted media is erased and cannot be recovered.', 'Delete', true))) return; try { const z = await fetch(BASE + 'api/v1/recordings/' + r.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + state.token } }); const j = await z.json(); if (!z.ok) throw Error(j.error); notify('Recording deleted'); } catch (e) { notify(e.message); } openRecordings(); }; act.append(x); }
        ul.append(li);
      }
      box.append(ul); const row = el('div', 'rc-row'), c = el('button', 'rc-primary', 'Close'); c.onclick = () => rcClose(); row.append(c); box.append(row);
    });
  }
  buildNotes(); buildPolls(); buildMore();
  return {
    attach(s) { s.on('notes-updated', remoteNotes); s.on('notes-editors', (m) => { N.editors = m.editors; const can = state.role === 'host' || m.editors.includes(state.participantId); if (can !== N.canEdit && !N.ended) { N.canEdit = can; renderAll(); announce(can ? 'You can now edit the notes' : 'Your edit access to the notes was removed'); } }); s.on('polls-changed', polls$); s.on('breakout-help', (h) => { notify(h.name + ' in ' + (h.roomName || 'a room') + ' is asking for help'); announce(h.name + ' in ' + (h.roomName || 'a room') + ' is asking for help'); breakoutsChanged(); }); s.on('breakout-help-resolved', () => { BK.helpId = null; bkPaintChip(); notify('Your request was answered'); }); s.on('breakout-announcement', (m) => { notify(m.from + ': ' + m.text); announce(m.from + ' says: ' + m.text); }); s.on('classroom-changed', () => { if (CL.open) clLoad(); if (state.role === 'host' && BK.info.active && BK.open) { clearTimeout(BK.dashT); BK.dashT = setTimeout(bkLoad, 700); } }); s.on('room-board', () => { if (CL.open && CL.tab === 'whiteboard') clWbSync(); }); s.on('more', onMore); s.on('ai-consent-request', loadIntel); s.on('ai-consent-closed', loadIntel); s.on('connect', () => { if (M.features) loadMore(); }); },
    breakoutScope, breakoutsChanged,
    load() { buildMore(); loadNotes(); loadPolls(); loadMore(); loadIntel(); document.querySelector('[data-tab=more]')?.addEventListener('click', loadIntel); clearInterval(I.poll); I.poll = setInterval(() => { const t = $('tab-more'); if (!document.hidden && t && !t.classList.contains('hidden')) loadIntel(); }, 8000); },       // answers are not pushed: refresh while the tab is on screen
    refreshMore() { buildMore(); },
  };
}
