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
  async function renderQa() {
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
    form.onsubmit = async (e) => { e.preventDefault(); go.disabled = true; try { await more('/questions', 'POST', { question: inp.value }); inp.value = ''; await renderQa(); } catch (err) { notify(err.message); } go.disabled = false; };
    form.append(inp, go); box.append(form, M.qaList); return box;
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
  async function loadMore() { try { const st = await more('/state'); M.features = st.features; M.pref = st.preferences; setTimer(st.timer); buildMore(); applyPrefs(); } catch { /* the tools stay disabled */ } }
  function onMore(e) { if (!e) return; if (e.kind === 'timer') setTimer(e.payload); else if (String(e.kind).startsWith('question.') && M.qaBox && !M.qaBox.hidden) renderQa(); }
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
        body.append(row('smile', 'Reactions', 'Send quick reactions to the meeting.', emoji));
        const off = (label, icon) => { const b = el('button', 'mg-act', '', { type: 'button', disabled: '', title: NA, 'aria-disabled': 'true' }); b.append(svg(icon), document.createTextNode(label)); return b; };
        const qaBtn = el('button', 'mg-act', '', { type: 'button' }); qaBtn.append(svg('open'), document.createTextNode('Open'));
        if (!isOn('qa')) { qaBtn.disabled = true; qaBtn.title = NA; qaBtn.setAttribute('aria-disabled', 'true'); }
        else qaBtn.onclick = () => { const bx = M.qaBox; bx.hidden = !bx.hidden; qaBtn.lastChild.textContent = bx.hidden ? 'Open' : 'Close'; qaBtn.setAttribute('aria-expanded', String(!bx.hidden)); if (!bx.hidden) renderQa(); };
        body.append(row('pen', 'Whiteboard', 'Collaborative board for visual brainstorming.', off('Open', 'open')), row('people', 'Breakout rooms', 'Split participants into smaller discussion groups.', off('Create', 'userplus')),
          row('folder', 'Shared files', 'Share and access meeting files (host controlled).', off('Open', 'open')), row('qa', 'Q&A', 'Collect, review and answer participant questions.', qaBtn), qaPanel());
      },
      intel(body) {
        const grid = el('div', 'mg-grid4');
        const card = (k, title, desc, ctl) => { const c = el('div', 'mg-card'); const h = el('div', 'mg-card-h'); h.append(svg(k), el('strong', '', title)); c.append(h, el('small', '', desc), ctl); grid.append(c); };
        const btn = (label) => el('button', 'mg-act', label, { type: 'button', disabled: '', title: NA, 'aria-disabled': 'true' });
        card('doc', 'AI Summary', 'Generate key notes, decisions and action items', btn('Generate'));
        card('cc', 'Live Transcript', 'Real-time captions and transcript', swtch('Live transcript', false, true));
        card('list', 'Key Takeaways', 'Auto-extract topics and action items', swtch('Key takeaways', false, true));
        card('bot', 'Ask QorllaMate', 'Get answers from the meeting content', btn('Ask AI'));
        body.append(grid, el('p', 'mg-note', 'These stay disabled until their meeting services, consent and verified access are in place.'));
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
        const timerTile = tile('timer', 'Timer', () => { if (detail.dataset.k === 'timer') { detail.dataset.k = ''; detail.hidden = true; return; } detail.dataset.k = 'timer'; detail.textContent = ''; detail.append(timerPanel()); detail.hidden = false; }, isOn('timer') ? {} : { off: true });
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
    attach(s) { s.on('notes-updated', remoteNotes); s.on('notes-editors', (m) => { N.editors = m.editors; const can = state.role === 'host' || m.editors.includes(state.participantId); if (can !== N.canEdit && !N.ended) { N.canEdit = can; renderAll(); announce(can ? 'You can now edit the notes' : 'Your edit access to the notes was removed'); } }); s.on('polls-changed', polls$); s.on('more', onMore); s.on('connect', () => { if (M.features) loadMore(); }); },
    load() { buildMore(); loadNotes(); loadPolls(); loadMore(); },
    refreshMore() { buildMore(); },
  };
}
