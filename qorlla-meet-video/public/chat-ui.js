// Qorlla Meet chat (v4.25 + v4.26): Everyone and private conversations, the host's chat policy, replies, quotes, editing, delete, rich text, bookmarks, pins, tasks, search,
// Save chat, pop-out, and optional GIFs and attachments.
// The server decides everything that matters (who may chat with whom, pin, edit, delete, what rich text is allowed); this file only presents it. All content is built with
// createElement/createTextNode: there is no innerHTML anywhere, and rich text goes through QorllaChatMarkup.render (canonical, server-sanitized markup).
import './chat-markup.js';
const MK = window.QorllaChatMarkup;
const GIF_URL = /^https:\/\/(?:media\d*|i)\.giphy\.com\/[A-Za-z0-9_\-./]{1,200}$/;
const MAX_FILE = 10 * 1024 * 1024;
const POLICY_LABELS = [['none', 'No one'], ['hosts', 'Host only'], ['group', 'Everyone in the meeting (group chat)'], ['all', 'Everyone, and privately with anyone']];

export function initChat(h) {
  const { state, BASE, notify } = h;
  const section = document.getElementById('tab-chat');
  const $ = (id) => section.querySelector('#' + id);                      // looked up INSIDE the chat panel, so it keeps working after the panel has moved to the pop-out window
  const el = (tag, cls, text, attrs) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const list = $('messages'), form = $('chatForm'), editor = $('chatEditor'), nav = $('chatNav'), notice = $('chatNotice'), settings = $('chatSettings'), newPanel = $('chatNewChat');
  const msgs = new Map();                                              // id -> { data, el, bodyEl, tasks }   (the CURRENT conversation only)
  const convs = new Map([['everyone', { id: 'everyone', kind: 'everyone', members: [] }]]);
  const unread = new Set();
  let current = 'everyone', policy = 'group', canManage = false, features = { gif: false, attachments: false };
  let replyTo = null, editing = null, openMenu = null, filter = { q: '', pinned: false, saved: false }, popup = null, stub = null;
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
    editor.setAttribute('contenteditable', ok ? 'true' : 'false'); editor.setAttribute('aria-disabled', String(!ok)); editor.classList.toggle('chat-editor-off', !ok);
    $('chatSend').disabled = !ok; bar.querySelectorAll('button').forEach((b) => { b.disabled = !ok; });
    applyFeatures();
    notice.textContent = ok ? '' : policyNotice(); notice.classList.toggle('hidden', ok);
    applyPolicy_newBtn();
    buildSettings();
  }

  // attach and GIF stay visible; without the server's switch they are disabled and the tooltip says why
  function applyFeatures() {
    const ok = mayPost(), gif = $('chatGifBtn'), att = $('chatAttachBtn');
    gif.disabled = !ok || !features.gif; gif.title = features.gif ? 'Search GIFs' : 'GIF search is not enabled for this meeting server (no GIPHY key is configured)';
    att.disabled = !ok || !features.attachments; att.title = features.attachments ? 'Attach a file' : 'File attachments are not enabled on this server (no malware scanning is available)';
    gif.setAttribute('aria-label', gif.title); att.setAttribute('aria-label', att.title); if (!features.gif) gifPanel.classList.add('hidden');
  }
  const subtitle = () => { $('chatSubtitle').textContent = document.getElementById('roomTitle')?.textContent.trim() || 'Meeting conversation'; };

  // ---------- conversation tabs (an icon above the label: Everyone = people, New chat = plus)
  const NS = 'http://www.w3.org/2000/svg';
  const icon = (paths) => { const s = document.createElementNS(NS, 'svg'); for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '20', height: '20', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v); for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); } return s; };
  const PEOPLE = ['M17 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1', 'M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M21 20v-1a4 4 0 0 0-3-3.9', 'M16 4.1a3.5 3.5 0 0 1 0 6.8'], PLUS = ['M12 5v14', 'M5 12h14'], LOCK = ['M6 11h12v9H6z', 'M8 11V8a4 4 0 0 1 8 0v3'];
  function renderNav() {
    nav.textContent = '';
    for (const c of convs.values()) {
      const b = el('button', 'chat-conv', undefined, { type: 'button', role: 'tab', 'aria-selected': String(c.id === current), 'data-id': c.id, title: c.kind === 'everyone' ? 'The whole meeting' : 'Private: only the people listed can read this' });
      b.append(icon(c.kind === 'everyone' ? PEOPLE : LOCK), el('span', 'chat-convname', convName(c)));
      if (unread.has(c.id)) b.append(el('span', 'chat-unread', '●', { 'aria-label': 'New messages', role: 'img' }));
      b.onclick = () => void select(c.id); nav.append(b);
    }
    const nb = el('button', 'chat-conv chat-new', undefined, { type: 'button', id: 'chatNewBtn' }); nb.append(icon(PLUS), el('span', 'chat-convname', 'New chat'));
    nb.onclick = () => { newPanel.classList.contains('hidden') ? openNew() : newPanel.classList.add('hidden'); }; nav.append(nb);
    applyPolicy_newBtn();
  }
  function applyPolicy_newBtn() { const canNew = isHost() || policy === 'all' || policy === 'hosts'; const nb = $('chatNewBtn'); if (nb) { nb.disabled = !canNew; nb.title = canNew ? 'Start a private chat' : policyNotice(); } }
  async function select(id) {
    if (!convs.has(id)) return; current = id; unread.delete(id); resetComposer(); renderNav(); applyPolicy(); newPanel.classList.add('hidden'); closeSettings();
    await loadMessages();
  }
  function openNew() {
    newPanel.textContent = ''; closeSettings();
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
    newPanel.append(box, el('small', 'chat-hint', hint), el('div', 'chat-newactions', undefined), go, no); newPanel.classList.remove('hidden');
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
  $('chatSettingsBtn').onclick = (e) => { e.stopPropagation(); const open = settings.classList.contains('hidden'); settings.classList.toggle('hidden', !open); $('chatSettingsBtn').setAttribute('aria-expanded', String(open)); if (open) settings.querySelector('button')?.focus(); };
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
      ref.onclick = () => { const t = msgs.get(m.replyTo.id); if (t) { t.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); t.el.classList.add('chat-flash'); setTimeout(() => t.el.classList.remove('chat-flash'), 1400); } };
      row.append(ref);
    }
    const body = el('div', 'chat-body'); renderBody(m, body); row.append(body);
    const tasks = el('div', 'chat-tasks'); row.append(tasks);
    if (!m.deleted) {
      const actions = el('div', 'chat-actions-row');
      const reply = el('button', 'chat-act', 'Reply', { type: 'button' }); reply.onclick = () => startReply(m.id);
      const more = el('button', 'chat-act', 'More', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }); more.onclick = (e) => { e.stopPropagation(); toggleMenu(m.id, more, row); };
      actions.append(reply, more); row.append(actions);
    }
    return { data: m, el: row, bodyEl: body, edited, pin, star, tasks };
  }
  function applyFilter(rec) {
    const m = rec.data; let show = true;
    if (filter.pinned && !m.pinned) show = false; if (filter.saved && !m.bookmarked) show = false;
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

  // ---------- the More menu
  function closeMenu() { if (openMenu) { openMenu.menu.remove(); openMenu.btn.setAttribute('aria-expanded', 'false'); openMenu = null; } }
  const outside = (e) => { closeMenu(); if (!settings.contains(e.target) && e.target !== $('chatSettingsBtn')) closeSettings(); };
  const onKey = (e) => { if (e.key === 'Escape') { const b = openMenu?.btn; closeMenu(); closeSettings(); b?.focus(); } };
  document.addEventListener('click', outside); document.addEventListener('keydown', onKey);
  function toggleMenu(id, btn, row) {
    const same = openMenu && openMenu.btn === btn; closeMenu(); if (same) return;
    const m = msgs.get(id).data, menu = el('div', 'chat-menu', undefined, { role: 'menu' });
    const item = (label, fn, keepOpen) => { const b = el('button', '', label, { type: 'button', role: 'menuitem' }); b.onclick = (e) => { e.stopPropagation(); if (!keepOpen) closeMenu(); Promise.resolve(fn(b)).catch(fail); }; menu.append(b); return b; };
    item('Copy', async () => { await (doc().defaultView || window).navigator.clipboard.writeText(plainOf(m)); notify('Copied'); });
    item('Quote', () => startQuote(id));
    if (isMine(m) && m.kind === 'text') item('Edit', () => startEdit(id));
    item(m.bookmarked ? 'Remove bookmark' : 'Bookmark', async () => { await api('/' + id + '/bookmark', m.bookmarked ? 'DELETE' : 'PUT'); m.bookmarked = !m.bookmarked; refresh(id); });
    if (isHost() && current === 'everyone') item(m.pinned ? 'Unpin' : 'Pin for everyone', async () => { await api('/' + id + '/pin', m.pinned ? 'DELETE' : 'PUT'); });
    item('Create task', () => taskForm(id));
    if (isMine(m) || isHost()) {                                         // a second click confirms: deleting removes the text for good
      let armed = false, timer = null;
      item('Delete', async (b) => {
        if (!armed) { armed = true; b.textContent = 'Click again to delete'; b.classList.add('chat-danger'); timer = setTimeout(() => { armed = false; b.textContent = 'Delete'; b.classList.remove('chat-danger'); }, 3500); return; }
        clearTimeout(timer); closeMenu(); await api('/' + id, 'DELETE');
      }, true);
    }
    row.append(menu); btn.setAttribute('aria-expanded', 'true'); openMenu = { menu, btn };
    const lr = list.getBoundingClientRect(); let mr = menu.getBoundingClientRect();
    if (mr.top < lr.top) { menu.style.bottom = 'auto'; menu.style.top = 'calc(100% - 6px)'; mr = menu.getBoundingClientRect(); }        // no room above (a message near the top of the list): open below it
    if (mr.bottom > lr.bottom) list.scrollTop += mr.bottom - lr.bottom + 8;
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
  function showContext(text) { ctx.textContent = ''; ctx.classList.toggle('hidden', !text); if (!text) return; const x = el('button', '', '✕', { type: 'button', 'aria-label': 'Cancel' }); x.onclick = resetComposer; ctx.append(el('span', '', text), x); }
  function startReply(id) { if (!mayPost()) return notify(policyNotice() || 'You cannot chat here'); const m = msgs.get(id).data; replyTo = id; editing = null; showContext('Replying to ' + m.name); editor.focus(); }
  function caretAt(node, start) { const d = doc(), r = d.createRange(); if (start) { r.setStart(node, 0); r.collapse(true); } else { r.selectNodeContents(editor); r.collapse(false); } const s = d.defaultView.getSelection(); s.removeAllRanges(); s.addRange(r); }
  function startQuote(id) {
    if (!mayPost()) return notify(policyNotice() || 'You cannot chat here');
    const m = msgs.get(id).data; replyTo = id; editing = null; showContext('Quoting ' + m.name); editor.textContent = '';
    const q = el('blockquote'); q.textContent = plainOf(m).slice(0, 300); const tail = el('div'); tail.append(document.createElement('br')); editor.append(q, tail);
    editor.focus(); caretAt(tail, true);                                  // the caret goes BELOW the quotation
  }
  function startEdit(id) {
    const m = msgs.get(id).data; editing = id; replyTo = null; showContext('Editing your message'); editor.textContent = '';
    if (m.rich) MK.render(m.rich, editor); else editor.textContent = m.body; editor.focus(); caretAt(editor, false);
  }
  function resetComposer() { replyTo = null; editing = null; editor.textContent = ''; showContext(''); }

  async function submit() {
    if (!mayPost()) return notify(policyNotice() || 'You cannot chat here');
    const plain = editor.textContent.trim(); if (!plain) return;
    // the composer is cleared AT ONCE (what was typed is captured first), so whatever is typed while the server answers is the NEXT message and is never lost;
    // if the send fails the text comes back
    const rich = MK.fromEditor(editor), sentReply = replyTo, sentEdit = editing; resetComposer();
    try {
      if (sentEdit) { const { data } = await api('/' + sentEdit, 'PATCH', { rich }); Object.assign(msgs.get(sentEdit).data, data); refresh(sentEdit); }
      else await emit({ rich, replyTo: sentReply });
    } catch (e) {
      fail(e);
      if (!editor.textContent.trim()) { const canon = MK.sanitize ? MK.sanitize(rich) : null; if (canon) MK.render(canon, editor); else editor.textContent = plain; replyTo = sentReply; editing = sentEdit; if (sentEdit) showContext('Editing your message'); else if (sentReply && msgs.get(sentReply)) showContext('Replying to ' + msgs.get(sentReply).data.name); }
    }
  }
  const emit = (payload) => new Promise((resolve, reject) => state.socket.emit('chat', { ...payload, conversationId: convId(), idempotencyKey: crypto.randomUUID() }, (r) => (r?.ok ? resolve(r) : reject(new Error(r?.error || 'Chat failed')))));
  form.onsubmit = (e) => { e.preventDefault(); void submit(); };
  editor.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); } });
  editor.addEventListener('paste', (e) => { e.preventDefault(); const t = (e.clipboardData || window.clipboardData).getData('text/plain').slice(0, 8000); doc().execCommand('insertText', false, t); });   // formatting is applied with the buttons, never pasted in
  editor.addEventListener('dragover', (e) => e.preventDefault()); editor.addEventListener('drop', (e) => { e.preventDefault(); const t = e.dataTransfer?.getData('text/plain'); if (t) doc().execCommand('insertText', false, t.slice(0, 8000)); });

  // ---------- formatting bar
  const bar = $('chatFormat');
  const linkRow = $('chatLinkRow');
  $('chatLinkBtn').onclick = () => { const open = linkRow.classList.toggle('hidden') === false; $('chatLinkBtn').setAttribute('aria-expanded', String(open)); if (open) $('chatLink').focus(); };
  bar.querySelectorAll('[data-cmd]').forEach((b) => { b.onmousedown = (e) => e.preventDefault(); b.onclick = () => { editor.focus(); doc().execCommand(b.dataset.cmd, false, undefined); }; });
  const linkIn = $('chatLink'), linkOk = $('chatLinkOk');
  linkOk.onmousedown = (e) => e.preventDefault();
  linkOk.onclick = () => { const url = MK.isSafeUrl(linkIn.value.trim()); if (!url) return notify('Enter a full https:// link'); editor.focus(); doc().execCommand('createLink', false, url); linkIn.value = ''; linkRow.classList.add('hidden'); $('chatLinkBtn').setAttribute('aria-expanded', 'false'); };

  // ---------- GIFs and attachments (shown only when the server has them enabled)
  const gifPanel = $('chatGifPanel');
  $('chatGifBtn').onclick = () => { gifPanel.classList.toggle('hidden'); if (!gifPanel.classList.contains('hidden')) $('chatGifQuery').focus(); };
  async function gifSearch() {
    const q = $('chatGifQuery').value.trim(); if (!q) return; const grid = $('chatGifGrid'); grid.textContent = '';
    try {
      const { data } = await api('/gifs/search?q=' + encodeURIComponent(q));
      for (const g of data.gifs || []) { const b = el('button', '', undefined, { type: 'button', 'aria-label': g.title || 'GIF' }); const i = el('img', '', undefined, { alt: g.title || 'GIF', referrerpolicy: 'no-referrer' }); i.src = g.preview; b.append(i); b.onclick = () => emit({ kind: 'gif', body: g.url, replyTo }).then(() => { gifPanel.classList.add('hidden'); resetComposer(); }).catch(fail); grid.append(b); }
      if (!(data.gifs || []).length) grid.append(el('small', '', 'No GIFs found'));
    } catch (e) { fail(e); }
  }
  $('chatGifGo').onclick = () => void gifSearch(); $('chatGifQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void gifSearch(); } });
  $('chatAttachBtn').onclick = () => $('chatFile').click();
  $('chatFile').onchange = async (e) => {
    const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; if (f.size > MAX_FILE) return notify('File is too large (10 MB maximum)');
    try {
      const { data } = await api('/attachments', 'POST', undefined, { headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(f.name) }, body: f });
      await emit({ kind: 'file', attachmentId: data.attachmentId, replyTo }); resetComposer();
    } catch (err) { fail(err); }
  };

  // ---------- search and filters
  $('chatSearch').addEventListener('input', (e) => { filter.q = e.target.value.trim().toLowerCase(); msgs.forEach(applyFilter); });
  for (const [id, key] of [['chatPinned', 'pinned'], ['chatSaved', 'saved']]) $(id).onclick = () => { filter[key] = !filter[key]; $(id).setAttribute('aria-pressed', String(filter[key])); msgs.forEach(applyFilter); };

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
    const t = await api('/tasks/list'); (t.data.tasks || []).filter((x) => (x.conversationId || 'everyone') === current).forEach(taskChip); list.scrollTop = list.scrollHeight; list.dataset.empty = current === 'everyone' ? 'Meeting messages appear here' : 'Private messages appear here'; subtitle(); applyPolicy();
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
