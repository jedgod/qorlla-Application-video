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
  const N = { doc: { template: '', agenda: [], notes: '', decisions: [], tasks: [] }, version: 0, canEdit: false, isHost: false, ended: false, editors: [], dirty: new Set(), pending: new Set(), saving: false, again: false, timer: 0, retry: 0, offline: false, loaded: false };
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
    const role = $('notesRole'); if (!role) return; role.textContent = N.ended ? 'Meeting ended · read-only' : N.isHost ? 'Host editor' : N.canEdit ? 'You can edit' : 'Read-only';
    $('notesTemplate').disabled = ro(); $('notesSnap').disabled = ro(); $('notesShare').classList.toggle('hidden', !N.isHost || N.ended);
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
    try { const r = await call('/notes'); Object.assign(N, { version: r.version, canEdit: r.canEdit, isHost: r.isHost, ended: r.ended, editors: r.editors, loaded: true }); N.doc = r.doc; if (!$('nAgenda')) buildNotes(); else renderAll(); }
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
    draft.append(el('span', 'plc-ic', '💾'), document.createTextNode('Save draft')); go.append(el('span', 'plc-ic', '▶'), document.createTextNode('Launch poll')); br.append(draft, go); f.append(err, br);
    const sync = () => { const k = kindVal; os.hidden = !['single', 'multiple', 'ranking'].includes(k); ss.hidden = k !== 'rating'; quiz.parentElement.hidden = !['single', 'multiple', 'yesno'].includes(k); if (quiz.parentElement.hidden) quiz.checked = false; es.hidden = !quiz.checked; renum(); }; quiz.onchange = sync; sync();
    const correct = () => (kindVal === 'yesno' ? [] : rows.filter((o) => o.inp.value.trim()).map((o, i) => (o.ok.checked ? i : -1)).filter((i) => i >= 0));
    const body = (launch) => ({ question: q.value, kind: kindVal, options: rows.map((o) => o.inp.value), scale: Number(scale.value), anonymous: anon.checked, liveResults: live.checked, quiz: quiz.checked, correct: correct(), explanation: expl.value, durationSec: Number(dur.value) || 0, launch });
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
    const meta = [KIND[p.kind]]; if (p.anonymous) meta.push('anonymous'); if (p.quiz) meta.push('quiz'); c.append(el('p', 'muted', meta.join(' · ')));
    if (p.status === 'open') { c.append(el('p', 'muted pl-count', p.responses + ' of ' + Math.max(1, state.roster.size) + ' responded' + (p.closesAt ? ' · closes in ' : ''), { 'data-closes': p.closesAt || '' })); }
    if (p.status === 'open' && !p.hasVoted) c.append(voteForm(p));
    else if (p.status === 'open' && p.hasVoted) { c.append(el('p', '', P.answered.has(p.id) ? (P.answered.get(p.id) ? '✔ Vote recorded — correct!' : '✘ Vote recorded — not the correct answer.') : '✔ Your vote is recorded.')); }
    if (p.status === 'closed' && !p.results) c.append(el('p', 'muted', 'This poll is closed. The host has not published the results.'));
    if (p.results) c.append(resultsView(p));
    if (state.role === 'host') {
      const row = el('div', 'rc-row'); const add = (label, fn, cls = 'rc-secondary') => { const b = el('button', cls, label, { type: 'button' }); b.onclick = async () => { b.disabled = true; try { await fn(); await loadPolls(); } catch (e) { notify(e.message); b.disabled = false; } }; row.append(b); };
      if (p.status === 'draft') { add('Launch', () => call('/polls/' + p.id + '/open', 'POST'), 'rc-primary'); add('Delete draft', async () => { if (await askConfirm('Delete this draft?', p.question, 'Delete', true)) await call('/polls/' + p.id, 'DELETE', undefined); }); }
      if (p.status === 'open') add('Close poll', () => call('/polls/' + p.id + '/close', 'POST'), 'rc-primary');
      if (p.status !== 'draft') add(p.published ? 'Hide results from participants' : 'Publish results to everyone', () => call('/polls/' + p.id + '/publish', 'POST', { published: !p.published }));
      if (p.status !== 'draft') add('Export CSV', async () => { const r = await call('/polls/' + p.id + '/export.csv', 'GET', undefined, true); download('poll-results.csv', await r.text(), 'text/csv'); });
      c.append(row);
    }
    return c;
  }
  function renderPolls() {
    if (!$('pollList')) return; const host = state.role === 'host'; $('pollNew').classList.toggle('hidden', !host); $('pollNew').setAttribute('aria-expanded', String(P.form));
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
  const openGroups = new Set(['collab']);                // which groups of the More tab are open: kept when the tab is rebuilt (a host switching a tool must not see the group fold up)
  function buildMore() {
    const t = $('tab-more'); t.textContent = ''; t.classList.add('more-v41-compact', 'more-v41-grids');
    const local = state.moreLocalTools || (state.moreLocalTools = { focus: false, remaining: 300000, deadline: 0, alarm: null });
    const host = state.role === 'host';
    const paths = {
      document: ['M7 3h7l4 4v14H7z', 'M14 3v5h5M10 12h5m-5 4h5'],
      captions: ['M3 5h18v14H3z', 'M10 10H7v4h3m7-4h-3v4h3'],
      list: ['M8 6h13M8 12h13M8 18h13M3 6h1m-1 6h1m-1 6h1'],
      bot: ['M5 8h14v12H5z', 'M12 3v5M9 3h6M2 12v4m20-4v4M8 12h1m6 0h1m-7 4h6'],
      invite: ['M15 21v-2a5 5 0 0 0-10 0v2', 'M10 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8M19 7v6m-3-3h6'],
      info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 11v6m0-10v1'],
      settings: ['M4 3v8m0 4v6m8-18v3m0 4v11m8-18v11m0 4v3M1 11h6m2-5h6m2 8h6'],
      shield: ['m12 2 8 3v6c0 6-8 11-8 11S4 17 4 11V5z'],
      people: ['M3 21v-3a6 6 0 0 1 12 0v3', 'M9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8M17 5a3 3 0 0 1 0 6m4 10v-3a5 5 0 0 0-4-5'],
      record: ['M3 5h13v14H3z', 'm16 10 6-3v10l-6-3'],
      lock: ['M5 11h14v11H5z', 'M8 11V7a4 4 0 0 1 8 0v4m-4 5v2'],
      timer: ['M12 6a8 8 0 1 0 0 16 8 8 0 0 0 0-16', 'M9 2h6m-3 0v4m0 4v5l3 2m3-13 2 2'],
      focus: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10M12 11v2m-1-1h2'],
      layout: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
      background: ['M3 4h18v16H3z', 'm3 17 5-5 4 4 3-3 6 6M16 8h1'],
      more: ['M4 12h1m6 0h1m6 0h1']
    };
    function icon(name) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) svg.setAttribute(key,value);
      for (const d of paths[name] || paths.settings) { const path = document.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('d',d); svg.append(path); }
      return svg;
    }
    function modal(title, build) { rcModal(title, build); }
    function meetingInfo() {
      modal('Meeting info', box => {
        box.append(el('p','rc-note',state.meetingInfo || $('roomTitle')?.textContent || 'Current meeting'));
        box.append(el('p','rc-note','Meeting ID: ' + ($('roomId')?.textContent || state.meetingId)));
      });
    }
    function hostSettings(title) {
      if (!host) return notify('Only the host can change meeting permissions.');
      modal(title, box => hostPanel(box));
    }
    function attendance() {
      modal('Attendance — connected now', box => {
        box.append(el('p','rc-note','Current participants only. This is not a historical attendance report.'));
        const ids = new Set(state.roster || []); if (state.participantId) ids.add(state.participantId);
        const list = el('ul','rc-list');
        for (const id of ids) list.append(el('li','',(state.names?.get(id) || (id === state.participantId ? state.name : 'Participant ' + String(id).slice(0,8))) + (id === state.participantId ? ' (You)' : '')));
        box.append(list);
      });
    }
    function securitySettings() {
      modal('Security settings', box => {
        box.append(el('p','rc-note','Meeting access and recording follow this meeting’s existing authorization and consent controls.'));
        if (host) {
          const permissions = el('button','rc-secondary','Risk & permissions'); permissions.onclick = () => hostSettings('Risk & permissions');
          const recordings = el('button','rc-secondary','Recording library'); recordings.onclick = openRecordings;
          box.append(permissions, recordings);
        } else box.append(el('p','rc-note','Ask the host to change access permissions. Recording consent can be withdrawn through the existing recording controls.'));
      });
    }
    function timerTool() {
      modal('Personal timer', box => {
        box.append(el('p','rc-note','Only you see this timer.'));
        const minutes = el('input','','',{type:'number'}); minutes.type='number'; minutes.min='1'; minutes.max='180'; minutes.value=String(Math.max(1,Math.ceil((local.deadline ? local.deadline-Date.now() : local.remaining)/60000)));
        minutes.setAttribute('aria-label','Timer minutes');
        const output = el('output','more-timer-output'); output.setAttribute('aria-live','off');
        const start = el('button','rc-primary',local.deadline ? 'Pause' : 'Start'), reset = el('button','rc-secondary','Reset');
        const show = () => { const seconds=Math.max(0,Math.ceil((local.deadline ? local.deadline-Date.now() : local.remaining)/1000)); output.textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0'); };
        const stop = () => { if(local.deadline)local.remaining=Math.max(0,local.deadline-Date.now());local.deadline=0;clearTimeout(local.alarm);local.alarm=null;start.textContent='Start';show(); };
        minutes.onchange=()=>{const n=Number(minutes.value);if(!Number.isInteger(n)||n<1||n>180)return;stop();local.remaining=n*60000;show();};
        start.onclick=()=>{
          if(local.deadline){stop();return;}
          const n=Number(minutes.value);if(!Number.isInteger(n)||n<1||n>180)return notify('Choose 1–180 minutes.');
          if(local.remaining<=0)local.remaining=n*60000;
          local.deadline=Date.now()+local.remaining;start.textContent='Pause';show();clearTimeout(local.alarm);
          local.alarm=setTimeout(()=>{local.remaining=0;local.deadline=0;local.alarm=null;start.textContent='Start';show();notify('Your personal timer is complete.');},local.remaining);
        };
        reset.onclick=()=>{stop();local.remaining=300000;minutes.value='5';show();};
        const row=el('div','rc-row');row.append(start,reset);box.append(minutes,output,row);show();
        const tick=setInterval(()=>{if(!output.isConnected){clearInterval(tick);return;}show();},250);
      });
    }
    function layoutTool() {
      modal('Meeting layout', box => {
        const row = el('div','rc-row');
        for (const existing of document.querySelectorAll('[data-layout]')) {
          const button = el('button','rc-secondary',existing.textContent); button.onclick=()=>{existing.click();rcClose();};row.append(button);
        }
        box.append(row);
      });
    }
    const unavailable = (label, key, reason) => ({label,key,disabled:true,note:'Unavailable',reason:reason || 'This meeting service is not available.'});
    const groups = [
      {id:'collab',title:'Collaboration',key:'people',items:['Whiteboard','Breakout rooms','Shared files','Q&A']},
      {id:'intel',title:'Meeting intelligence',key:'bot',columns:4,tiles:[
        unavailable('AI Summary','document','Requires verified private AI access and explicit consent.'),
        unavailable('Live Transcript','captions','Requires a verified transcription service and consent.'),
        unavailable('Key Takeaways','list','Requires verified private AI access and explicit consent.'),
        unavailable('Ask QorllaMate','bot','Requires the private gateway, consent and verified entitlement.')
      ]},
      {id:'manage',title:'Meeting management',key:'invite',columns:5,tiles:[
        {label:'Invite People',key:'invite',run:()=>$('copyLink').click()},
        {label:'Meeting Info',key:'info',run:meetingInfo},
        {label:'Meeting Settings',key:'settings',disabled:!host,reason:'Host controls only.',run:()=>hostSettings('Meeting settings')},
        {label:'Risk & Permissions',key:'shield',disabled:!host,reason:'Host controls only.',run:()=>hostSettings('Risk & permissions')},
        {label:'Attendance',key:'people',run:attendance}
      ]},
      {id:'sec',title:'Security and recordings',key:'shield',columns:3,tiles:[
        {label:'Recording',key:'record',run:()=>host ? $('recordBtn').click() : notify('Recording follows the existing consent controls. You can withdraw consent at any time.')},
        {label:'Lock Meeting',key:'lock',lock:true},
        {label:'Security Settings',key:'settings',run:securitySettings}
      ]},
      {id:'tools',title:'Tools and settings',key:'settings',columns:6,tiles:[
        {label:'Timer',key:'timer',run:timerTool},
        {label:'Focus Mode',key:'focus',focus:true,run:()=>{local.focus=!local.focus;document.body.classList.toggle('more-focus-mode',local.focus);buildMore();}},
        {label:'Layout',key:'layout',run:layoutTool},
        unavailable('Background & Effects','background','Background processing is not available in this meeting.'),
        {label:'Audio & Video',key:'settings',run:()=>$('settingsBtn').click()},
        {label:'More Settings',key:'more',run:()=>$('settingsBtn').click()}
      ]}
    ];
    const banner=el('div','more-v41-heading');banner.append(el('strong','','Meeting tools'),el('span','more-v41-badge','V4.1'));t.append(banner);
    for(const group of groups){
      const section=el('section','mg'), heading=el('button','mg-h','',{type:'button',id:'mgh-'+group.id,'aria-expanded':String(openGroups.has(group.id)),'aria-controls':'mg-'+group.id});
      const mark=el('span','more-v41-icon');mark.append(icon(group.key));
      heading.append(mark,el('span','',group.title),el('span','mg-chev',openGroups.has(group.id)?'▴':'▾',{'aria-hidden':'true'}));
      const body=el('div',group.tiles?'mg-b more-tile-grid more-count-'+group.columns:'mg-b','',{id:'mg-'+group.id,role:'region','aria-labelledby':'mgh-'+group.id});body.hidden=!openGroups.has(group.id);
      if(group.items){
        body.append(el('p','','Reactions'));const row=el('div','emoji');
        for(const emoji of ['👍','👏','❤️','🎉','😂']){const button=el('button','',emoji,{type:'button','aria-label':'React with '+emoji});button.onclick=()=>state.socket?.emit('reaction',emoji);row.append(button);}body.append(row);
        for(const label of group.items){const button=el('button','mg-i','',{disabled:'','aria-disabled':'true'});button.append(el('span','',label),el('small','muted','Unavailable'));body.append(button);}
      }
      for(const definition of group.tiles || []){
        if(definition.lock){
          const label=el('label','more-square more-lock-square');label.append(icon('lock'),el('span','more-square-label',definition.label));
          const check=el('input','','',{type:'checkbox',role:'switch','aria-label':'Lock Meeting'});check.checked=!!state.settings?.locked;check.disabled=!host||!state.settings;
          check.onchange=async()=>{if(!host)return;check.disabled=true;try{const response=await fetch(BASE+'api/meetings/'+state.meetingId+'/settings',{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:'Bearer '+state.token},body:JSON.stringify({locked:check.checked})});const result=await response.json();if(!response.ok)throw Error(result.error||'Cannot update meeting lock');Object.assign(state.settings,result);announce(check.checked?'Meeting locked':'Meeting unlocked');}catch(error){check.checked=!check.checked;notify(error.message);}check.disabled=false;};
          label.append(check);body.append(label);continue;
        }
        const button=el('button','more-square','',{type:'button','data-more-tile':definition.label});button.append(icon(definition.key),el('span','more-square-label',definition.label));
        if(definition.disabled){button.disabled=true;button.setAttribute('aria-disabled','true');button.title=definition.reason || 'Unavailable';button.append(el('small','more-square-note',definition.note || 'Host only'));}
        if(definition.focus)button.setAttribute('aria-pressed',String(local.focus));
        button.onclick=async()=>{if(definition.disabled)return;try{await definition.run();}catch(error){notify(error.message || 'This tool could not open.');}};
        body.append(button);
      }
      heading.onclick=()=>{const open=heading.getAttribute('aria-expanded')!=='true';if(open)openGroups.add(group.id);else openGroups.delete(group.id);heading.setAttribute('aria-expanded',String(open));body.hidden=!open;heading.querySelector('.mg-chev').textContent=open?'▴':'▾';};
      section.append(heading,body);t.append(section);
    }
    t.append(el('p','muted','Unavailable tools stay off until their meeting services and privacy requirements are verified.'));
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
    attach(s) { s.on('notes-updated', remoteNotes); s.on('notes-editors', (m) => { N.editors = m.editors; const can = state.role === 'host' || m.editors.includes(state.participantId); if (can !== N.canEdit && !N.ended) { N.canEdit = can; renderAll(); announce(can ? 'You can now edit the notes' : 'Your edit access to the notes was removed'); } }); s.on('polls-changed', polls$); },
    load() { buildMore(); loadNotes(); loadPolls(); },
    refreshMore() { buildMore(); },
  };
}
