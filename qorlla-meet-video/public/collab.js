// Qorlla Meet sidebar: structured notes (autosave, history, edit access), polls (server-authoritative), and the More tool groups.
// Everything is validated again on the server; this file only presents it. Nothing here is mock data.
export function initCollab(h) {
  const { state, BASE, notify, announce, rcModal, rcClose, rcEl, askConfirm } = h;
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
    const head = el('div', 'nt-head'); head.append(el('h3', '', 'Polls')); const nb = el('button', 'rc-primary hidden', 'New poll', { id: 'pollNew', 'aria-expanded': 'false', 'aria-controls': 'pollForm2' }); head.append(nb); t.append(head);
    const views = el('div', 'pl-views', '', { role: 'group', 'aria-label': 'Poll lists' });
    for (const [k, l] of [['active', 'Active'], ['drafts', 'Drafts'], ['results', 'Results']]) { const b = el('button', '', l, { 'data-pv': k, 'aria-pressed': String(k === P.view) }); b.onclick = () => { P.view = k; renderPolls(); }; views.append(b); }
    t.append(views, el('div', '', '', { id: 'pollForm2' }), el('div', '', '', { id: 'pollList', 'aria-live': 'off' }));
    nb.onclick = () => { P.form = !P.form; renderPolls(); if (P.form) $('pq')?.focus(); };
  }
  function pollForm() {
    const f = el('form', 'pl-form'); f.id = 'pollFormEl';
    const row = (label, ctl) => { const l = el('label', 'rc-field'); l.append(el('span', '', label), ctl); f.append(l); return ctl; };
    const q = row('Question', el('input', '', '', { id: 'pq', maxlength: '300', required: '' }));
    const kind = row('Type', el('select', '', '', { id: 'pk' })); for (const [k, l] of Object.entries(KIND)) kind.append(new Option(l, k));
    const opts = row('Options (one per line, 2–10)', el('textarea', '', '', { id: 'po', rows: '4', maxlength: '1200' }));
    const scale = row('Scale', el('select', '', '', { id: 'ps' })); for (const n of [5, 10, 3]) scale.append(new Option('1 to ' + n, String(n)));
    const checks = el('div', 'pl-checks'); const ck = (id, l) => { const lab = el('label', 'rc-check'), i = el('input', '', '', { type: 'checkbox', id }); lab.append(i, document.createTextNode(' ' + l)); checks.append(lab); return i; };
    const anon = ck('pa', 'Anonymous (answers are never stored against names)'), live = ck('pl', 'Show live results to everyone'), quiz = ck('pz', 'Quiz mode (mark the correct answer)'); f.append(checks);
    const corr = row('Correct option number(s), e.g. 2 or 1,3', el('input', '', '', { id: 'pc', maxlength: '40' })), expl = row('Explanation shown with the results', el('input', '', '', { id: 'pe', maxlength: '400' }));
    const dur = row('Time limit', el('select', '', '', { id: 'pd' })); for (const [v, l] of [['0', 'No limit'], ['60', '1 minute'], ['120', '2 minutes'], ['300', '5 minutes'], ['600', '10 minutes']]) dur.append(new Option(l, v));
    const err = el('p', 'rc-err', '', { role: 'alert' }); const br = el('div', 'rc-row'), draft = el('button', 'rc-secondary', 'Save draft', { type: 'button' }), go = el('button', 'rc-primary', 'Launch now', { type: 'submit' }), cancel = el('button', 'rc-secondary', 'Cancel', { type: 'button' }); br.append(go, draft, cancel); f.append(err, br);
    const sync = () => { const k = kind.value; opts.parentElement.hidden = !['single', 'multiple', 'ranking'].includes(k); scale.parentElement.hidden = k !== 'rating'; quiz.parentElement.hidden = !['single', 'multiple', 'yesno'].includes(k); if (quiz.parentElement.hidden) quiz.checked = false; corr.parentElement.hidden = expl.parentElement.hidden = !quiz.checked; }; kind.onchange = quiz.onchange = sync; sync();
    const body = (launch) => ({ question: q.value, kind: kind.value, options: opts.value.split('\n'), scale: Number(scale.value), anonymous: anon.checked, liveResults: live.checked, quiz: quiz.checked, correct: corr.value.split(/[ ,]+/).filter(Boolean).map((n) => Number(n) - 1), explanation: expl.value, durationSec: Number(dur.value) || 0, launch });
    const send = async (launch) => { err.textContent = ''; try { await call('/polls', 'POST', body(launch)); P.form = false; P.view = launch ? 'active' : 'drafts'; announce(launch ? 'Poll launched' : 'Draft saved'); await loadPolls(); } catch (e) { err.textContent = e.message; } };
    f.onsubmit = (e) => { e.preventDefault(); send(true); }; draft.onclick = () => { if (f.reportValidity()) send(false); }; cancel.onclick = () => { P.form = false; renderPolls(); $('pollNew')?.focus(); };
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
    if (!show.length) list.append(el('p', 'muted', P.view === 'active' ? 'No poll is open right now.' : P.view === 'drafts' ? 'No drafts.' : 'No finished polls yet.')); for (const p of show) list.append(pollCard(p));
    clearInterval(P.timer); if (document.querySelector('[data-closes]:not([data-closes=""])')) P.timer = setInterval(tick, 1000); tick();
  }
  function tick() { document.querySelectorAll('.pl-count[data-closes]').forEach((e) => { const c = e.dataset.closes; if (!c) return; const s = Math.max(0, Math.round((new Date(c) - Date.now()) / 1000)); e.textContent = e.textContent.replace(/ · closes in.*$/, '') + ' · closes in ' + stamp(s); if (s === 0 && !tick.asked) { tick.asked = true; setTimeout(() => { tick.asked = false; loadPolls(); }, 1500); } }); }
  let pollLoadTimer = 0;
  async function loadPolls() { try { P.polls = (await call('/polls')).polls; } catch { return; } if (!$('pollList')) buildPolls(); renderPolls(); }
  const polls$ = () => { clearTimeout(pollLoadTimer); pollLoadTimer = setTimeout(loadPolls, 250); };

  // =================================================================================================================================== MORE
  function buildMore() {
    const t = $('tab-more'); t.textContent = '';
    const soon = (label, note) => ({ label, note: note || 'Planned for v4.1', soon: true });
    const groups = [
      { id: 'collab', title: 'Collaboration', items: [{ label: 'Reactions', reactions: true }, soon('Whiteboard'), soon('Breakout rooms'), soon('Shared files'), soon('Q&A')] },
      { id: 'intel', title: 'Meeting intelligence', items: [soon('AI meeting summary', 'Planned v4.2 — needs its own consent'), soon('Live transcription', 'Planned v4.2 — needs its own consent'), soon('Translated captions', 'Planned v4.2')] },
      { id: 'manage', title: 'Meeting management', items: [{ label: 'Copy invitation link', run: () => $('copyLink').click() }, { label: 'Export notes (Markdown)', run: () => exportNotes('md') }, { label: 'Meeting information', info: () => state.meetingInfo || '' }, soon('Attendance report'), soon('Lock meeting / remove people')] },
      { id: 'sec', title: 'Security and recording', items: [{ label: state.role === 'host' ? 'Recording and consent…' : 'About recording', run: () => (state.role === 'host' ? $('recordBtn').click() : notify('Recording only happens if everyone present agrees. You will be asked, and you can withdraw at any time.')) }, ...(state.role === 'host' ? [{ label: 'Recordings (download or delete)…', run: openRecordings }] : []), { label: 'Calls and chat are encrypted in transit', info: () => 'Audio and video use WebRTC (DTLS-SRTP); the page uses HTTPS in production. Recordings are not stored by Qorlla.' }] },
      { id: 'tools', title: 'Tools and settings', items: [{ label: 'Settings and keyboard shortcuts', run: () => $('settingsBtn').click() }, { label: 'Panel position and lock', info: () => 'On wide screens use the arrow buttons at the top of this panel to dock it left, right, top or bottom, and the lock to keep it stable.' }] },
    ];
    for (const [gi, g] of groups.entries()) {
      const sec = el('section', 'mg'); const hb = el('button', 'mg-h', '', { 'aria-expanded': String(gi === 0), 'aria-controls': 'mg-' + g.id, id: 'mgh-' + g.id }); hb.append(el('span', '', g.title), el('span', 'mg-chev', gi === 0 ? '▴' : '▾', { 'aria-hidden': 'true' }));
      const body = el('div', 'mg-b', '', { id: 'mg-' + g.id, role: 'region', 'aria-labelledby': 'mgh-' + g.id }); body.hidden = gi !== 0;
      for (const it of g.items) {
        if (it.reactions) { const row = el('div', 'emoji'); for (const e of ['👍', '👏', '❤️', '🎉', '😂']) { const b = el('button', '', e, { 'aria-label': 'React with ' + e }); b.onclick = () => state.socket?.emit('reaction', e); row.append(b); } body.append(el('p', '', 'Reactions'), row); }
        else if (it.soon) { const b = el('button', 'mg-i', '', { disabled: '', 'aria-disabled': 'true' }); b.append(el('span', '', it.label), el('small', 'muted', it.note)); body.append(b); }
        else if (it.info) { const d = el('div', 'mg-info'); d.append(el('strong', '', it.label), el('p', 'muted', it.info())); body.append(d); }
        else { const b = el('button', 'mg-i', it.label); b.onclick = it.run; body.append(b); }
      }
      hb.onclick = () => { const open = hb.getAttribute('aria-expanded') !== 'true'; hb.setAttribute('aria-expanded', String(open)); body.hidden = !open; hb.querySelector('.mg-chev').textContent = open ? '▴' : '▾'; };
      sec.append(hb, body); t.append(sec);
    }
    t.append(el('p', 'muted', 'Items marked “Planned” are not available yet.'));
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
  };
}
