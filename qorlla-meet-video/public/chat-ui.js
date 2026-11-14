// Qorlla Meet chat (v4.25 - v4.27): Everyone and private conversations, the host's chat policy, replies, quotes, editing, delete, rich text (fixed palette of colours and sizes),
// bookmarks, pins (with a pinned-messages panel), tasks, search, Save chat, pop-out, GIFs and attachments (both only when the server has them switched on).
// The server decides everything that matters (who may chat with whom, pin, edit, delete, what rich text is allowed, who can read a conversation); this file only presents it.
// All content is built with createElement/createTextNode: there is no innerHTML anywhere, and rich text goes through QorllaChatMarkup.render (canonical, server-sanitized markup).
import './chat-markup.js';
const MK = window.QorllaChatMarkup;
const GIF_URL = /^https:\/\/(?:media\d*|i)\.giphy\.com\/[A-Za-z0-9_\-./]{1,200}$/;
const MAX_FILE = 10 * 1024 * 1024;
const POLICY_LABELS = [['none', 'No one'], ['hosts', 'Host only'], ['group', 'Everyone in the meeting (group chat)'], ['all', 'Everyone, and privately with anyone']];
const COLOURS = [['Red', 1], ['Orange', 2], ['Yellow', 3], ['Green', 4], ['Blue', 5], ['Purple', 6]], SIZES = [['Small', 1], ['Normal', 0], ['Large', 2], ['Huge', 3]];
const CLOUD = ['Dropbox', 'Microsoft OneDrive', 'Google Drive', 'Box', 'Microsoft SharePoint'];
const CLOUD_TIP = 'Not connected: needs provider setup by an administrator';
const ICONS = {
  reply: ['M9 14L4 9l5-5', 'M4 9h10a6 6 0 0 1 6 6v3'], task: ['M9 11l2 2 4-4', 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z'],
  people: ['M17 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1', 'M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M21 20v-1a4 4 0 0 0-3-3.9', 'M16 4.1a3.5 3.5 0 0 1 0 6.8'],
  plus: ['M12 5v14', 'M5 12h14'], lock: ['M6 11h12v9H6z', 'M8 11V8a4 4 0 0 1 8 0v3'], pc: ['M3 5h18v11H3z', 'M8 20h8', 'M12 16v4'], cloud: ['M7 18a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17 8.5a4.5 4.5 0 0 1 0 9z'],
};

export function initChat(h) {
  const { state, BASE, notify } = h;
  const section = document.getElementById('tab-chat');
  const $ = (id) => section.querySelector('#' + id);                      // looked up INSIDE the chat panel, so it keeps working after the panel has moved to the pop-out window
  const el = (tag, cls, text, attrs) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const NS = 'http://www.w3.org/2000/svg';
  const icon = (name, size = 18) => { const s = document.createElementNS(NS, 'svg'); for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v); for (const d of ICONS[name]) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); } return s; };
  const list = $('messages'), form = $('chatForm'), editor = $('chatEditor'), nav = $('chatNav'), notice = $('chatNotice'), settings = $('chatSettings'), newPanel = $('chatNewChat'), bar = $('chatFormat');
  const msgs = new Map();                                              // id -> { data, el, bodyEl, tasks }   (the CURRENT conversation only)
  const convs = new Map([['everyone', { id: 'everyone', kind: 'everyone', members: [] }]]);
  const unread = new Set();
  let current = 'everyone', policy = 'group', canManage = false, features = { gif: false, attachments: false };
  let replyTo = null, editing = null, openMenu = null, filter = { q: '', saved: false }, popup = null, stub = null;
  const api = async (path, method = 'GET', body, raw) => {
    const r = await fetch(BASE + 'api/meetings/' + state.meetingId + '/chat' + path, { method, headers: { ...(raw ? raw.headers : { 'Content-Type': 'application/json' }), Authorization: 'Bearer ' + state.token }, body: raw ? raw.body : (body === undefined ? undefined : JSON.stringify(body)) });
    const data = r.headers.get('content-type')?.includes('json') ? await r.json().catch(() => ({})) : {};
    if (!r.ok) throw new Error(data.error || 'Request failed'); return { data, response: r };
  };
  const fail = (e) => notify(e?.message || 'Chat failed');
  const isMine = (m) => m.participantId === state.participantId;
  const isHost = () => state.role === 'host';
  const plainOf = (m) => m.body || '';
  const convId = () => (current === 'everyone' ? null : current);
  const doc = () => editor.ownerDocument;                                // the main page, or the pop-out window once the chat has been moved there
  const timeOf = (m) => { try { return new Date(m.createdAt || m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
  const sizeOf = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const convName = (c) => { if (c.kind === 'everyone') return 'Everyone'; const others = (c.members || []).filter((x) => x.id !== state.participantId).map((x) => x.name); return others.length > 2 ? others.slice(0, 2).join(', ') + ' +' + (others.length - 2) : others.join(', ') || 'Private chat'; };

  /** the hint "Message everyone..." shows whenever the editor holds no text (kept in step by JS: :empty never matches a contentEditable after text was typed and deleted) */
  const syncEmpty = () => { editor.dataset.empty = String(!editor.textContent.trim()); };
  const hintFor = () => (current === 'everyone' ? 'Message everyone\u2026' : 'Message ' + convName(convs.get(current) || { kind: 'direct', members: [] }) + '\u2026');

  // ---------- popovers: one open at a time, closed by a click elsewhere or Escape
  const POPS = ['chatGifPanel', 'chatFileMenu', 'chatFmtPop', 'chatWho', 'chatPinPanel', 'chatOverflow', 'chatLinkPop'];
  function closePops(except) { for (const id of POPS) { const p = $(id); if (p && id !== except) p.classList.add('hidden'); } section.querySelectorAll('[data-pop]').forEach((b) => { if (b.dataset.pop !== except) b.setAttribute('aria-expanded', 'false'); }); }
  function togglePop(id, btn, onOpen) { const p = $(id), open = p.classList.contains('hidden'); closePops(open ? id : null); closeMenu(); closeSettings(); p.classList.toggle('hidden', !open); btn.setAttribute('aria-expanded', String(open)); if (open && onOpen) onOpen(p); }

  // ---------- who may post here (a mirror of the server's rule, so the composer can explain itself; the server still decides)
  function mayPost() {
    if (isHost()) return true;
    if (policy === 'none') return false; if (policy === 'all') return true; if (policy === 'group') return current === 'everyone';
    if (policy === 'hosts') return current !== 'everyone' && (convs.get(current)?.members || []).some((m) => m.role === 'host');
    return false;
  }
  const policyNotice = () => ({ none: 'The host has turned chat off for participants.', hosts: 'The host allows participants to chat privately with the host only.', group: 'The host allows participants to chat in Everyone only.' }[policy] || '');
  function applyPolicy() {
    const ok = mayPost();
    editor.setAttribute('data-placeholder', hintFor()); syncEmpty();
    editor.setAttribute('contenteditable', ok ? 'true' : 'false'); editor.setAttribute('aria-disabled', String(!ok)); editor.classList.toggle('chat-editor-off', !ok);
    $('chatSend').disabled = !ok; $('chatFmtBtn').disabled = !ok; bar.querySelectorAll('button').forEach((b) => { b.disabled = !ok; });
    if (!ok) { bar.classList.add('hidden'); $('chatFmtBtn').setAttribute('aria-pressed', 'false'); closePops(); }
    notice.textContent = ok ? '' : policyNotice(); notice.classList.toggle('hidden', ok);
    applyFeatures(); applyPolicy_newBtn(); buildSettings();
  }
  // GIF and File stay visible; without the server's switch GIF is disabled (and File's "Your computer" entry is), and the tooltip says why
  function applyFeatures() {
    const ok = mayPost(), gif = $('chatGifBtn'), att = $('chatAttachBtn');
    gif.disabled = !ok || !features.gif; gif.title = features.gif ? 'Search GIFs' : 'GIF search is not enabled for this meeting server (no GIPHY key is configured)'; gif.setAttribute('aria-label', gif.title);
    att.disabled = !ok; att.title = 'Add a file'; att.setAttribute('aria-label', 'Add a file');
    const pc = $('chatFilePc'); if (pc) { pc.disabled = !ok || !features.attachments; const tip = features.attachments ? '' : 'File attachments are not enabled on this server (no malware scanning is available)'; pc.title = tip; pc.parentElement.title = tip; }
    if (!features.gif) $('chatGifPanel').classList.add('hidden');
  }
  const subtitle = () => { $('chatSubtitle').textContent = document.getElementById('roomTitle')?.textContent.trim() || 'Meeting conversation'; };

  // ---------- conversation chips (a square with an icon, the name under it; the selected one has a blue ring)
  function renderNav() {
    nav.textContent = '';
    for (const c of convs.values()) {
      const b = el('button', 'chat-conv', undefined, { type: 'button', role: 'tab', 'aria-selected': String(c.id === current), 'data-id': c.id, title: c.kind === 'everyone' ? 'The whole meeting' : 'Private: only the people listed can read this' });
      const box = el('span', 'chat-chipbox'); box.append(icon(c.kind === 'everyone' ? 'people' : 'lock', 22)); b.append(box, el('span', 'chat-convname', convName(c)));
      if (unread.has(c.id)) b.append(el('span', 'chat-unread', '●', { 'aria-label': 'New messages', role: 'img' }));
      b.onclick = () => void select(c.id); nav.append(b);
    }
    const nb = el('button', 'chat-conv chat-new', undefined, { type: 'button', id: 'chatNewBtn' }); const nbox = el('span', 'chat-chipbox'); nbox.append(icon('plus', 22)); nb.append(nbox, el('span', 'chat-convname', 'New chat'));
    nb.onclick = () => { newPanel.classList.contains('hidden') ? openNew() : newPanel.classList.add('hidden'); }; nav.append(nb);
    applyPolicy_newBtn();
  }
  function applyPolicy_newBtn() { const canNew = isHost() || policy === 'all' || policy === 'hosts'; const nb = $('chatNewBtn'); if (nb) { nb.disabled = !canNew; nb.title = canNew ? 'Start a private chat' : policyNotice(); } }
  async function select(id) {
    if (!convs.has(id)) return; current = id; unread.delete(id); resetComposer(); renderNav(); applyPolicy(); newPanel.classList.add('hidden'); closeSettings(); closePops();
    await loadMessages();
  }
  function openNew() {
    newPanel.textContent = ''; closeSettings(); closePops();
    newPanel.append(el('strong', '', 'To:'));
    const people = [...state.names.entries()].filter(([pid]) => pid !== state.participantId);
    const box = el('div', 'chat-people'); const picks = new Map();
    for (const [pid, name] of people) { const lab = el('label'); const cb = el('input', '', undefined, { type: 'checkbox' }); lab.append(cb, document.createTextNode(' ' + name)); box.append(lab); picks.set(pid, cb); }
    if (!people.length) box.append(el('small', '', 'Nobody else is here yet.'));
    const hint = policy === 'hosts' && !isHost() ? 'The host allows participants to chat privately with the host only.' : 'Only the people you choose can read this chat.';
    const go = el('button', 'primary', 'Start chat', { type: 'button' }), no = el('button', '', 'Cancel', { type: 'button' }); no.onclick = () => newPanel.classList.add('hidden');
    go.onclick = async () => {
      const recipients = [...picks].filter(([, cb]) => cb.checked).map(([pid]) => pid); if (!recipients.length) return notify('Choose at least one person');
      try { const { data } = await api('/conversations', 'POST', { recipients }); convs.set(data.id, data); await select(data.id); } catch (e) { fail(e); }
    };
    newPanel.append(box, el('small', 'chat-hint', hint), go, no); newPanel.classList.remove('hidden');
  }

  // ---------- settings menu: Save chat and (for the host) who can chat with whom
  function closeSettings() { settings.classList.add('hidden'); $('chatSettingsBtn').setAttribute('aria-expanded', 'false'); }
  function buildSettings() {
    settings.textContent = '';
    const save = el('button', '', 'Save chat', { type: 'button', role: 'menuitem' }); save.onclick = () => { closeSettings(); exportChat().catch(fail); }; settings.append(save, el('hr'));
    settings.append(el('div', 'chat-setlabel', 'Participants can chat with:', { id: 'chatPolicyLabel' }));
    for (const [v, label] of POLICY_LABELS) {
      const b = el('button', '', (policy === v ? '✓ ' : ' ') + label, { type: 'button', role: 'menuitemradio', 'aria-checked': String(policy === v) }); b.disabled = !canManage;
      b.onclick = async () => { try { await api('/policy', 'PUT', { policy: v }); policy = v; applyPolicy(); } catch (e) { fail(e); } closeSettings(); }; settings.append(b);
    }
    if (!canManage) settings.append(el('small', 'chat-hint', 'Only the host can change this.'));
  }
  $('chatSettingsBtn').onclick = (e) => { e.stopPropagation(); const open = settings.classList.contains('hidden'); closePops(); closeMenu(); settings.classList.toggle('hidden', !open); $('chatSettingsBtn').setAttribute('aria-expanded', String(open)); if (open) settings.querySelector('button')?.focus(); };
  async function exportChat() {
    const { response } = await api('/export' + (current === 'everyone' ? '' : '?conversation=' + encodeURIComponent(current))); const blob = await response.blob();
    const url = URL.createObjectURL(blob), a = el('a', '', undefined, { download: 'qorlla-chat-' + new Date().toISOString().slice(0, 10) + '.txt' }); a.href = url; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---------- rendering one message
  function renderBody(m, target) {
    target.textContent = '';
    if (m.deleted) { target.classList.add('chat-deleted'); target.append(el('i', '', 'Message deleted')); return; }
    target.classList.remove('chat-deleted');
    if (m.kind === 'gif') {
      if (GIF_URL.test(m.body || '')) { const img = el('img', 'chat-gif', undefined, { alt: 'GIF', loading: 'lazy', referrerpolicy: 'no-referrer' }); img.src = m.body; target.append(img); } else target.textContent = '[GIF]';
    } else if (m.kind === 'file' && m.attachment) {
      const b = el('button', 'chat-file', '\u{1F4CE} ' + m.attachment.name + ' (' + sizeOf(m.attachment.size) + ')', { type: 'button', 'aria-label': 'Download ' + m.attachment.name });
      b.onclick = () => download(m.attachment).catch(fail); target.append(b);
    } else if (m.rich) MK.render(m.rich, target);
    else target.textContent = m.body || '';
  }
  async function download(a) {
    const { response } = await api('/attachments/' + a.id); const blob = await response.blob();
    const url = URL.createObjectURL(blob), link = el('a', '', undefined, { download: a.name }); link.href = url; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function build(m) {
    const row = el('div', 'message chat-msg', undefined, { 'data-id': m.id });
    const meta = el('div', 'chat-meta'); const who = el('strong', '', m.name); meta.append(who, el('time', 'chat-time', timeOf(m)));
    const edited = el('small', 'chat-edited' + (m.editedAt && !m.deleted ? '' : ' hidden'), 'edited'); const pin = el('span', 'chat-pin' + (m.pinned ? '' : ' hidden'), '\u{1F4CC}', { title: 'Pinned for everyone', role: 'img', 'aria-label': 'Pinned' });
    const star = el('span', 'chat-saved' + (m.bookmarked ? '' : ' hidden'), '\u{1F516}', { title: 'Bookmarked by you', role: 'img', 'aria-label': 'Bookmarked' });
    meta.append(edited, pin, star); row.append(meta);
    if (m.replyTo && !m.deleted) {
      const ref = el('button', 'chat-replyref', '↳ ' + (m.replyTo.name || 'message') + ': ' + (m.replyTo.text || '').slice(0, 80), { type: 'button', title: 'Go to the original message' });
      ref.onclick = () => jumpTo(m.replyTo.id); row.append(ref);
    }
    // the bubble, with Reply and More beside it: they appear on hover or keyboard focus, and are always shown on touch screens
    const line = el('div', 'chat-line'); const body = el('div', 'chat-body chat-bubble'); renderBody(m, body); line.append(body);
    if (!m.deleted) {
      const hover = el('div', 'chat-hover');
      const reply = el('button', 'chat-act', undefined, { type: 'button', 'aria-label': 'Reply', title: 'Reply' }); reply.append(icon('reply')); reply.onclick = () => startReply(m.id);
      const more = el('button', 'chat-act', '•••', { type: 'button', 'aria-label': 'More', title: 'More', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }); more.onclick = (e) => { e.stopPropagation(); toggleMenu(m.id, more, line); };
      hover.append(reply, more); line.append(hover);
    }
    row.append(line);
    const tasks = el('div', 'chat-tasks'); row.append(tasks);
    return { data: m, el: row, bodyEl: body, edited, pin, star, tasks };
  }
  function jumpTo(id) { const t = msgs.get(id); if (!t) return notify('That message is older than the history shown here'); t.el.classList.remove('hidden'); t.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); t.el.classList.add('chat-flash'); setTimeout(() => t.el.classList.remove('chat-flash'), 1400); }
  function applyFilter(rec) {
    const m = rec.data; let show = true;
    if (filter.saved && !m.bookmarked) show = false;
    if (filter.q && (m.deleted || !(plainOf(m).toLowerCase().includes(filter.q) || (m.name || '').toLowerCase().includes(filter.q)))) show = false;
    rec.el.classList.toggle('hidden', !show);
  }
  function add(m) {
    if (!m || !m.id) return;
    const cid = m.conversationId || 'everyone';
    if (cid !== current) {                                                    // a message for a conversation that is not on screen: mark it, tell the person
      if (!isMine(m)) { unread.add(cid); if (!convs.has(cid)) void loadConversations().then(renderNav); else renderNav(); notify((cid === 'everyone' ? 'New message from ' : 'New private message from ') + (m.name || 'someone')); }
      return;
    }
    if (msgs.has(m.id)) return;
    if (m.name === undefined && m.participantId) m.name = state.names.get(m.participantId) || 'Participant';
    const rec = build(m); msgs.set(m.id, rec); list.append(rec.el); applyFilter(rec);
    const near = list.scrollHeight - list.scrollTop - list.clientHeight < 140; if (near || isMine(m)) list.scrollTop = list.scrollHeight;
  }
  function rebuild(id) { const rec = msgs.get(id); if (!rec) return; const next = build(rec.data); rec.el.replaceWith(next.el); msgs.set(id, next); applyFilter(next); }
  function refresh(id) { const rec = msgs.get(id); if (!rec) return; const m = rec.data; renderBody(m, rec.bodyEl); rec.edited.classList.toggle('hidden', !m.editedAt || m.deleted); rec.pin.classList.toggle('hidden', !m.pinned); rec.star.classList.toggle('hidden', !m.bookmarked); applyFilter(rec); }

  // ---------- the More menu: Copy, Quote, Edit | Bookmark | Pin | Create task | Delete
  function closeMenu() { if (openMenu) { openMenu.menu.remove(); openMenu.btn.setAttribute('aria-expanded', 'false'); openMenu = null; } }
  const outside = (e) => { const t = e.target; closeMenu(); if (!t.closest?.('.chat-popover') && !t.closest?.('[data-pop]')) closePops(); if (!settings.contains(t) && t.closest?.('#chatSettingsBtn') == null) closeSettings(); };
  const onKey = (e) => { if (e.key === 'Escape') { const b = openMenu?.btn; closeMenu(); closeSettings(); closePops(); b?.focus(); } };
  document.addEventListener('click', outside); document.addEventListener('keydown', onKey);
  function toggleMenu(id, btn, line) {
    const same = openMenu && openMenu.btn === btn; closeMenu(); closePops(); if (same) return;
    const m = msgs.get(id).data, menu = el('div', 'chat-menu', undefined, { role: 'menu' });
    const item = (label, fn, o = {}) => { const b = el('button', '', undefined, { type: 'button', role: 'menuitem' }); if (o.icon) b.append(icon(o.icon, 16)); b.append(document.createTextNode(label)); b.onclick = (e) => { e.stopPropagation(); if (!o.keepOpen) closeMenu(); Promise.resolve(fn(b)).catch(fail); }; return b; };
    const groups = [];
    groups.push([item('Copy', async () => { await (doc().defaultView || window).navigator.clipboard.writeText(plainOf(m)); notify('Copied'); }), item('Quote', () => startQuote(id)), ...(isMine(m) && m.kind === 'text' ? [item('Edit', () => startEdit(id))] : [])]);
    groups.push([item(m.bookmarked ? 'Remove bookmark' : 'Bookmark', async () => { await api('/' + id + '/bookmark', m.bookmarked ? 'DELETE' : 'PUT'); m.bookmarked = !m.bookmarked; refresh(id); })]);
    if (isHost() && current === 'everyone') groups.push([item(m.pinned ? 'Unpin' : 'Pin for everyone', async () => { await api('/' + id + '/pin', m.pinned ? 'DELETE' : 'PUT'); })]);
    groups.push([item('Create task', () => taskForm(id), { icon: 'task' })]);
    if (isMine(m) || isHost()) {                                         // a second click confirms: deleting removes the text for good
      let armed = false, timer = null;
      groups.push([item('Delete', async (b) => {
        if (!armed) { armed = true; b.textContent = 'Click again to delete'; b.classList.add('chat-danger'); timer = setTimeout(() => { armed = false; b.textContent = 'Delete'; b.classList.remove('chat-danger'); }, 3500); return; }
        clearTimeout(timer); closeMenu(); await api('/' + id, 'DELETE');
      }, { keepOpen: true })]);
    }
    groups.forEach((g, i) => { if (i) menu.append(el('div', 'chat-menusep', undefined, { role: 'separator' })); g.forEach((b) => menu.append(b)); });
    line.append(menu); btn.setAttribute('aria-expanded', 'true'); openMenu = { menu, btn };
    const lr = list.getBoundingClientRect(); const mr = menu.getBoundingClientRect();
    if (mr.bottom > lr.bottom) { const above = btn.getBoundingClientRect().top - lr.top; if (above > mr.height) { menu.style.top = 'auto'; menu.style.bottom = '100%'; } else list.scrollTop += mr.bottom - lr.bottom + 8; }
    menu.querySelector('button')?.focus();
  }

  // ---------- tasks
  function taskChip(t) {
    const rec = msgs.get(t.messageId); if (!rec || rec.tasks.querySelector('[data-task="' + t.id + '"]')) return;
    const who = t.assigneeId ? (state.names.get(t.assigneeId) || '') : '';
    rec.tasks.append(el('div', 'chat-task', '☑ ' + t.title + (who ? ' · ' + who : '') + (t.dueDate ? ' · due ' + t.dueDate : ''), { 'data-task': t.id }));
  }
  function taskForm(id) {
    const rec = msgs.get(id); if (rec.tasks.querySelector('.chat-taskform')) return;
    const f = el('form', 'chat-taskform'); const title = el('input', '', undefined, { type: 'text', maxlength: '250', 'aria-label': 'Task title', placeholder: 'Task title' }); title.value = plainOf(rec.data).slice(0, 120);
    const due = el('input', '', undefined, { type: 'date', 'aria-label': 'Due date' });
    const who = el('select', '', undefined, { 'aria-label': 'Assign to' }); who.append(el('option', '', 'Unassigned', { value: '' }));
    const mine = current === 'everyone' ? [...state.names] : (convs.get(current)?.members || []).map((x) => [x.id, x.name]); for (const [pid, name] of mine) who.append(el('option', '', name, { value: pid }));
    const ok = el('button', 'primary', 'Create', { type: 'submit' }), no = el('button', '', 'Cancel', { type: 'button' }); no.onclick = () => f.remove();
    f.onsubmit = async (e) => { e.preventDefault(); try { await api('/' + id + '/tasks', 'POST', { title: title.value, dueDate: due.value || undefined, assigneeId: who.value || undefined }); f.remove(); } catch (err) { fail(err); } };
    f.append(title, due, who, ok, no); rec.tasks.append(f); title.focus();
  }

  // ---------- composer: reply / quote / edit
  const ctx = $('chatContext');
  const preview = (t) => { const x = (t || '').replace(/\s+/g, ' ').trim(); return x.length > 56 ? x.slice(0, 56) + '\u2026' : x; };
  function showContext(text, actions) {
    ctx.textContent = ''; ctx.classList.toggle('hidden', !text); if (!text) return;
    const x = el('button', 'chat-ctxclose', '\u2715', { type: 'button', 'aria-label': 'Cancel', title: 'Cancel (Esc)' }); x.onclick = () => { resetComposer(); editor.focus(); };
    ctx.append(el('span', 'chat-ctxtext', text)); for (const [label, fn] of actions || []) { const b = el('button', 'chat-ctxaction', label, { type: 'button' }); b.onclick = fn; ctx.append(b); } ctx.append(x);
  }
  function startReply(id) { if (!mayPost()) return notify(policyNotice() || 'You cannot chat here'); const m = msgs.get(id).data; replyTo = id; editing = null; showContext('Replying to ' + m.name + ': ' + preview(plainOf(m))); editor.focus(); }
  function caretAt(node, start) { const d = doc(), r = d.createRange(); if (start) { r.setStart(node, 0); r.collapse(true); } else { r.selectNodeContents(editor); r.collapse(false); } const s = d.defaultView.getSelection(); s.removeAllRanges(); s.addRange(r); }
  function startQuote(id) {
    if (!mayPost()) return notify(policyNotice() || 'You cannot chat here');
    const m = msgs.get(id).data; replyTo = id; editing = null; showContext('Quoting ' + m.name + ': ' + preview(plainOf(m))); editor.textContent = '';
    const q = el('blockquote'); q.textContent = plainOf(m).slice(0, 300); const tail = el('div'); tail.append(document.createElement('br')); editor.append(q, tail);
    editor.focus(); caretAt(tail, true); syncEmpty();                          // the caret goes BELOW the quotation
  }
  function startEdit(id) {
    const m = msgs.get(id).data; editing = id; replyTo = null; showContext('Editing: ' + preview(plainOf(m))); editor.textContent = '';
    if (m.rich) MK.render(m.rich, editor); else editor.textContent = m.body; editor.focus(); caretAt(editor, false); syncEmpty();
  }
  function resetComposer() { replyTo = null; editing = null; editor.textContent = ''; showContext(''); syncEmpty(); }

  async function submit() {
    if (!mayPost()) return notify(policyNotice() || 'You cannot chat here');
    const plain = editor.textContent.trim();
    if (!plain && editing) {                                              // the person emptied the message they were editing: ask, never silently do nothing
      const id = editing, rec = msgs.get(id);
      showContext('This message is now empty. Delete it instead?', [['Delete message', async () => { try { await api('/' + id, 'DELETE'); resetComposer(); } catch (e) { fail(e); } }], ['Keep editing', () => { showContext('Editing: ' + preview(plainOf(rec?.data || {}))); editor.focus(); }]]);
      return;
    }
    if (!plain) return;
    // the composer is cleared AT ONCE (what was typed is captured first), so whatever is typed while the server answers is the NEXT message and is never lost;
    // if the send fails the text comes back
    const rich = MK.fromEditor(editor), sentReply = replyTo, sentEdit = editing; resetComposer();
    try {
      if (sentEdit) { const { data } = await api('/' + sentEdit, 'PATCH', { rich }); Object.assign(msgs.get(sentEdit).data, data); refresh(sentEdit); }
      else await emit({ rich, replyTo: sentReply });
    } catch (e) {
      fail(e);
      if (!editor.textContent.trim()) { const canon = MK.sanitize ? MK.sanitize(rich) : null; if (canon) MK.render(canon, editor); else editor.textContent = plain; replyTo = sentReply; editing = sentEdit; if (sentEdit) showContext('Editing: ' + preview(plainOf(msgs.get(sentEdit)?.data || {}))); else if (sentReply && msgs.get(sentReply)) showContext('Replying to ' + msgs.get(sentReply).data.name + ': ' + preview(plainOf(msgs.get(sentReply).data))); syncEmpty(); }
    }
  }
  const emit = (payload) => new Promise((resolve, reject) => state.socket.emit('chat', { ...payload, conversationId: convId(), idempotencyKey: crypto.randomUUID() }, (r) => (r?.ok ? resolve(r) : reject(new Error(r?.error || 'Chat failed')))));
  form.onsubmit = (e) => { e.preventDefault(); void submit(); };
  editor.addEventListener('input', syncEmpty); editor.addEventListener('focus', syncEmpty);
  const listItem = () => { const n = doc().defaultView.getSelection().anchorNode; const el_ = n && (n.nodeType === 1 ? n : n.parentElement); const li = el_?.closest?.('li'); return li && editor.contains(li) ? li : null; };
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (editing || replyTo)) { e.preventDefault(); e.stopPropagation(); resetComposer(); return; }
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const li = listItem();
    if (li && !e.ctrlKey && !e.metaKey) { if (li.textContent.trim()) return; e.preventDefault(); doc().execCommand(li.parentElement.localName === 'ol' ? 'insertOrderedList' : 'insertUnorderedList'); return; }     // in a list Enter makes the next item; on an empty item it leaves the list; Ctrl+Enter always sends
    e.preventDefault(); void submit();
  });
  editor.addEventListener('paste', (e) => { e.preventDefault(); const t = (e.clipboardData || window.clipboardData).getData('text/plain').slice(0, 8000); doc().execCommand('insertText', false, t); });   // formatting is applied with the buttons, never pasted in
  editor.addEventListener('dragover', (e) => e.preventDefault()); editor.addEventListener('drop', (e) => { e.preventDefault(); const t = e.dataTransfer?.getData('text/plain'); if (t) doc().execCommand('insertText', false, t.slice(0, 8000)); });

  // ---------- the format toolbar (the T button shows it): B I U S | colour, size, link, heading | more
  const fmtBtn = $('chatFmtBtn');
  fmtBtn.onclick = () => { const on = bar.classList.toggle('hidden') === false; fmtBtn.setAttribute('aria-pressed', String(on)); closePops(); if (on) editor.focus(); };
  const keepSelection = (b) => { b.onmousedown = (e) => e.preventDefault(); };                   // clicking a toolbar button must not take the selection away from the editor
  bar.querySelectorAll('[data-cmd]').forEach((b) => { keepSelection(b); b.onclick = () => { editor.focus(); doc().execCommand(b.dataset.cmd, false, undefined); }; });
  const selRange = () => { const sel = doc().defaultView.getSelection(); if (!sel.rangeCount) return null; const r = sel.getRangeAt(0); return editor.contains(r.commonAncestorContainer) && !r.collapsed ? { sel, r } : null; };
  /** colour / size: wraps the selected text in <span data-c="n"> or <span data-z="n">. Only the fixed numbers exist; the server's allowlist is the authority (c1-c6, z1-z3). */
  function styleSelection(attr, n) {
    const got = selRange(); if (!got) return notify('Select some text first');
    const { sel, r } = got; const frag = r.extractContents();
    frag.querySelectorAll('[' + attr + ']').forEach((sp) => sp.replaceWith(...sp.childNodes));          // one colour (or size) at a time on the same text
    if (n) { const sp = doc().createElement('span'); sp.setAttribute(attr, String(n)); sp.append(frag); r.insertNode(sp); r.selectNodeContents(sp); } else { const last = frag.lastChild; r.insertNode(frag); if (last) r.setEndAfter(last); }
    sel.removeAllRanges(); sel.addRange(r); editor.focus();
  }
  const swatches = (kind) => {
    const pop = $('chatFmtPop'); pop.textContent = ''; pop.dataset.kind = kind;
    if (kind === 'colour') {
      for (const [name, n] of COLOURS) { const b = el('button', 'chat-swatch', undefined, { type: 'button', 'data-c': String(n), 'aria-label': name, title: name }); keepSelection(b); b.onclick = () => { styleSelection('data-c', n); closePops(); }; pop.append(b); }
      const d = el('button', 'chat-popitem', 'Default colour', { type: 'button' }); keepSelection(d); d.onclick = () => { styleSelection('data-c', 0); closePops(); }; pop.append(d);
    } else for (const [name, n] of SIZES) { const b = el('button', 'chat-popitem chat-sizeitem', name, { type: 'button', 'data-z': String(n) }); keepSelection(b); b.onclick = () => { styleSelection('data-z', n); closePops(); }; pop.append(b); }
  };
  const colourBtn = $('chatColorBtn'), sizeBtn = $('chatSizeBtn');
  for (const [btn, kind] of [[colourBtn, 'colour'], [sizeBtn, 'size']]) { keepSelection(btn); btn.setAttribute('data-pop', 'chatFmtPop'); btn.onclick = () => { const same = !$('chatFmtPop').classList.contains('hidden') && $('chatFmtPop').dataset.kind === kind; closePops(); if (same) return; swatches(kind); $('chatFmtPop').classList.remove('hidden'); btn.setAttribute('aria-expanded', 'true'); }; }
  const headBtn = $('chatHeadBtn'); keepSelection(headBtn);
  headBtn.onclick = () => { editor.focus(); const a = doc().defaultView.getSelection().anchorNode; const inH = a && (a.nodeType === 1 ? a : a.parentElement)?.closest?.('h2'); doc().execCommand('formatBlock', false, inH ? 'div' : 'h2'); };
  const moreBtn = $('chatMoreFmtBtn'); keepSelection(moreBtn);
  moreBtn.onclick = () => togglePop('chatOverflow', moreBtn, (p) => {
    p.textContent = '';
    for (const [label, run] of [['Bulleted list', () => doc().execCommand('insertUnorderedList')], ['Numbered list', () => doc().execCommand('insertOrderedList')], ['Quote', () => doc().execCommand('formatBlock', false, 'blockquote')],
      ['Clear formatting', () => { doc().execCommand('removeFormat'); const got = selRange(); if (got) { const frag = got.r.extractContents(); frag.querySelectorAll('[data-c],[data-z]').forEach((sp) => sp.replaceWith(...sp.childNodes)); got.r.insertNode(frag); } }]]) {
      const b = el('button', 'chat-popitem', label, { type: 'button', role: 'menuitem' }); keepSelection(b); b.onclick = () => { editor.focus(); run(); closePops(); }; p.append(b);
    }
  });
  moreBtn.setAttribute('data-pop', 'chatOverflow');
  const linkPop = $('chatLinkPop'), linkIn = $('chatLink'), linkOk = $('chatLinkOk'), linkBtn = $('chatLinkBtn'); let linkRange = null;
  keepSelection(linkBtn); linkBtn.setAttribute('data-pop', 'chatLinkPop');
  linkBtn.onclick = () => togglePop('chatLinkPop', linkBtn, () => {
    const got = selRange(); linkRange = got ? got.r.cloneRange() : null;                       // the selection is remembered: the text box takes the focus
    linkPop.style.left = Math.max(0, Math.min(linkBtn.offsetLeft, linkPop.parentElement.clientWidth - 300)) + 'px'; linkIn.value = ''; linkIn.focus();
  });
  const addLink = () => {
    const url = MK.isSafeUrl(linkIn.value.trim()); if (!url) return notify('Enter a full https:// link');
    editor.focus(); const sel = doc().defaultView.getSelection(); sel.removeAllRanges();
    if (linkRange) sel.addRange(linkRange); else caretAt(editor, false);
    if (linkRange && !linkRange.collapsed) doc().execCommand('createLink', false, url);
    else { const a = doc().createElement('a'); a.setAttribute('href', url); a.textContent = url; const r = sel.rangeCount ? sel.getRangeAt(0) : null; if (r) { r.insertNode(a); r.setStartAfter(a); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); } else editor.append(a); }
    closePops(); syncEmpty(); editor.focus();
  };
  linkOk.onmousedown = (e) => e.preventDefault(); linkOk.onclick = addLink;
  linkIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePops(); editor.focus(); } });

  // ---------- "Who can see your messages?": answered by the server for the conversation on screen
  const whoBtn = $('chatWhoBtn'); whoBtn.setAttribute('data-pop', 'chatWho');
  whoBtn.onclick = () => togglePop('chatWho', whoBtn, async (p) => {
    p.textContent = ''; p.append(el('small', '', 'Checking…'));
    try {
      const { data } = await api('/audience' + (current === 'everyone' ? '' : '?conversation=' + encodeURIComponent(current))); p.textContent = '';
      if (data.kind === 'everyone') p.append(el('strong', '', 'Everyone in this meeting (' + data.count + (data.count === 1 ? ' person)' : ' people)')), el('p', '', 'Everybody who has been admitted to this meeting can read this chat.'));
      else { const others = data.members.filter((x) => x.id !== data.you).map((x) => x.name); p.append(el('strong', '', 'Only you' + (others.length ? ' and ' + (others.length > 1 ? others.slice(0, -1).join(', ') + ' and ' + others[others.length - 1] : others[0]) : '')), el('p', '', 'Nobody else in the meeting can read this chat.')); }
      p.append(el('p', 'chat-hint', 'The host cannot read private chats they are not part of. Private chats are never included in meeting summaries or exports.'));
    } catch (e) { p.textContent = ''; p.append(el('small', '', e.message || 'Could not check')); }
  });

  // ---------- GIFs (needs the server's GIPHY key) and files
  $('chatGifBtn').setAttribute('data-pop', 'chatGifPanel');
  $('chatGifBtn').onclick = () => togglePop('chatGifPanel', $('chatGifBtn'), () => $('chatGifQuery').focus());
  let gifTimer = null;
  async function gifSearch() {
    const q = $('chatGifQuery').value.trim(); const grid = $('chatGifGrid'); grid.textContent = ''; if (!q) return;
    try {
      const { data } = await api('/gifs/search?q=' + encodeURIComponent(q));
      for (const g of data.gifs || []) { const b = el('button', '', undefined, { type: 'button', 'aria-label': g.title || 'GIF' }); const i = el('img', '', undefined, { alt: g.title || 'GIF', referrerpolicy: 'no-referrer' }); i.src = g.preview; b.append(i); b.onclick = () => emit({ kind: 'gif', body: g.url, replyTo }).then(() => { closePops(); resetComposer(); }).catch(fail); grid.append(b); }
      if (!(data.gifs || []).length) grid.append(el('small', '', 'No GIFs found'));
    } catch (e) { fail(e); }
  }
  $('chatGifQuery').addEventListener('input', () => { clearTimeout(gifTimer); gifTimer = setTimeout(() => void gifSearch(), 600); });
  $('chatGifQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(gifTimer); void gifSearch(); } });

  const fileMenu = $('chatFileMenu'); $('chatAttachBtn').setAttribute('data-pop', 'chatFileMenu');
  (() => {                                                                                    // "Your computer" works when the server allows attachments; the cloud sources are NOT connected (there is no connector code), so they are shown disabled
    const row = (label, ic, id) => { const wrap = el('span', 'chat-fileitem'); const b = el('button', 'chat-popitem', undefined, { type: 'button', role: 'menuitem' }); if (id) b.id = id; b.append(icon(ic, 16), document.createTextNode(label)); wrap.append(b); return { wrap, b }; };
    for (const name of CLOUD) { const { wrap, b } = row(name, 'cloud'); b.disabled = true; b.setAttribute('aria-disabled', 'true'); wrap.title = CLOUD_TIP; b.title = CLOUD_TIP; b.dataset.cloud = name; fileMenu.append(wrap); }
    const pc = row('Your computer', 'pc', 'chatFilePc'); pc.b.onclick = () => { closePops(); $('chatFile').click(); }; fileMenu.append(pc.wrap);
  })();
  $('chatAttachBtn').onclick = () => togglePop('chatFileMenu', $('chatAttachBtn'));
  $('chatFile').onchange = async (e) => {
    const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; if (f.size > MAX_FILE) return notify('File is too large (10 MB maximum)');
    try {
      const { data } = await api('/attachments', 'POST', undefined, { headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(f.name) }, body: f });
      await emit({ kind: 'file', attachmentId: data.attachmentId, replyTo }); resetComposer();
    } catch (err) { fail(err); }
  };

  // ---------- search, bookmarks filter, and the pinned-messages panel
  $('chatSearch').addEventListener('input', (e) => { filter.q = e.target.value.trim().toLowerCase(); msgs.forEach(applyFilter); });
  $('chatSaved').onclick = () => { filter.saved = !filter.saved; $('chatSaved').setAttribute('aria-pressed', String(filter.saved)); msgs.forEach(applyFilter); };
  const pinBtn = $('chatPinned'); pinBtn.setAttribute('data-pop', 'chatPinPanel');
  pinBtn.onclick = () => togglePop('chatPinPanel', pinBtn, async (p) => {
    p.textContent = ''; p.append(el('strong', '', 'Pinned messages'));
    if (current !== 'everyone') { p.append(el('p', 'chat-hint', 'Messages are pinned in Everyone only.')); return; }
    try {
      const { data } = await api('?pinned=1&limit=100'); const items = data.messages.filter((m) => !m.deleted);
      if (!items.length) p.append(el('p', 'chat-hint', 'Nothing is pinned yet. The host can pin a message from its ••• menu.'));
      for (const m of items) { const row = el('div', 'chat-pinrow'); row.append(el('div', 'chat-pinmeta', m.name + ' · ' + timeOf(m)), el('div', 'chat-pintext', (m.kind === 'gif' ? '[GIF]' : m.body).slice(0, 140))); const go = el('button', '', 'Go to message', { type: 'button' }); go.onclick = () => { closePops(); jumpTo(m.id); }; row.append(go); p.append(row); }
    } catch (e) { p.append(el('small', '', e.message || 'Could not load')); }
  });

  // ---------- pop-out: the chat panel itself moves to its own window (same page, same sign-in, same call connection: nothing is rejoined)
  function popBack() {
    if (!stub) return; const w = popup; popup = null;
    stub.replaceWith(section); stub = null; $('chatPopBtn').title = 'Pop out chat'; $('chatPopBtn').setAttribute('aria-label', 'Pop out chat');
    try { if (w && !w.closed) w.close(); } catch { /* already closed */ }
  }
  function popOut() {
    if (popup && !popup.closed) { popup.focus(); return; }
    const w = window.open('', 'qorlla-meet-chat', 'popup=yes,width=520,height=820'); if (!w) return notify('Allow pop-ups to open the chat in its own window');
    w.document.title = 'Chat - ' + (document.title || 'Qorlla Meet'); w.document.documentElement.className = document.documentElement.className;
    for (const l of document.querySelectorAll('link[rel=stylesheet]')) { const c = w.document.createElement('link'); c.rel = 'stylesheet'; c.href = l.href; w.document.head.append(c); }
    const shell = w.document.createElement('div'); shell.className = 'chat-popout-shell'; w.document.body.className = document.body.className; w.document.body.append(shell);
    stub = el('section', 'tab-view chat-away', undefined, { id: 'tab-chat' });                    // the app still finds a #tab-chat; it just says where the chat went
    const back = el('button', 'primary', 'Bring chat back', { type: 'button' }); back.onclick = popBack; stub.append(el('p', '', 'The chat is open in its own window.'), back);
    section.replaceWith(stub); shell.append(w.document.adoptNode(section)); popup = w;
    $('chatPopBtn').title = 'Bring chat back'; $('chatPopBtn').setAttribute('aria-label', 'Bring chat back');
    w.document.addEventListener('click', outside); w.document.addEventListener('keydown', onKey);
    w.addEventListener('pagehide', () => { if (popup === w) popBack(); }); window.addEventListener('pagehide', () => { try { w.close(); } catch { /* gone */ } }, { once: true });
  }
  $('chatPopBtn').onclick = () => (stub ? popBack() : popOut());
  $('chatCloseBtn').onclick = () => { if (stub) popBack(); else document.getElementById('panelClose')?.click(); };

  // ---------- loading and live events
  async function loadConversations() {
    const { data } = await api('/conversations'); policy = data.policy || policy;
    const keep = new Set(data.conversations.map((c) => c.id)); for (const id of [...convs.keys()]) if (!keep.has(id)) convs.delete(id);
    for (const c of data.conversations) convs.set(c.id, c);
  }
  async function loadMessages() {
    const { data } = await api('?limit=100' + (current === 'everyone' ? '' : '&conversation=' + encodeURIComponent(current)));
    features = data.features || features; policy = data.policy || policy; canManage = !!data.canManage; msgs.clear(); list.textContent = ''; data.messages.forEach(add);
    const t = await api('/tasks/list'); (t.data.tasks || []).filter((x) => (x.conversationId || 'everyone') === current).forEach(taskChip);
    list.scrollTop = list.scrollHeight; list.dataset.empty = current === 'everyone' ? 'Meeting messages appear here' : 'Private messages appear here'; subtitle(); applyPolicy();
  }
  async function load() {
    try { await loadConversations(); if (!convs.has(current)) current = 'everyone'; renderNav(); await loadMessages(); } catch (e) { fail(e); }
  }
  return {
    add, load, resync: load,
    onEdit: (e) => { if ((e.conversationId || 'everyone') !== current) return; const rec = msgs.get(e.id); if (rec) { Object.assign(rec.data, { body: e.body, rich: e.rich, editedAt: e.editedAt }); refresh(e.id); } },
    onPin: (e) => { const rec = msgs.get(e.id); if (rec) { rec.data.pinned = !!e.pinned; refresh(e.id); } },
    onTask: (t) => { if ((t.conversationId || 'everyone') === current) taskChip(t); },
    onDelete: (e) => { const rec = msgs.get(e.id); if (rec) { Object.assign(rec.data, { deleted: true, body: '', rich: null, attachment: null, pinned: false, bookmarked: false }); rebuild(e.id); } },
    onPolicy: (e) => { policy = e.policy; if (replyTo && !mayPost()) resetComposer(); applyPolicy(); notify('The host changed who can chat'); },
    onConversation: (c) => { convs.set(c.id, c); unread.add(c.id); renderNav(); notify('New private chat from ' + convName(c)); },
  };
}
