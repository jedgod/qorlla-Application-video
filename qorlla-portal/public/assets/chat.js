// Portal Chat page (/app/chat): Everyone + conversations, "+ New chat" with a To: selector, messages with hover Reply and a More menu, a format toolbar (fixed colour and size set),
// a GIF picker, a File menu, "Who can see your messages?", pinned messages, search, tasks, QorllaMate, Save chat and live updates (SSE).
// Every piece of content is built with createElement/createTextNode: there is no innerHTML for user text, and rich text is rendered from the server's canonical markup:
//   <b> <i> <u> <s> <br> <ul> <li> <h2> <h3> <blockquote> <a href="https://..."> and a FIXED set of <fc-COLOUR> / <fs-SIZE> tags (no arbitrary CSS is ever produced or shown).
// What a person may do is decided by the server; this page only presents it.
import { api, notice, describe } from './core.js';

const el = (tag, cls, text, attrs) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const unesc = (t) => t.replace(/&(amp|lt|gt|quot);/g, (m, g) => ({ amp: '&', lt: '<', gt: '>', quot: '"' }[g]));
const uuid4 = () => (crypto.randomUUID ? crypto.randomUUID() : 'k' + Date.now() + Math.random().toString(16).slice(2));
const safeHref = (h) => { try { const u = new URL(h); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; } };
export const COLORS = { red: '#d93025', orange: '#e8710a', green: '#188038', blue: '#1a73e8', purple: '#8e24aa', gray: '#5f6368' };
export const SIZES = { sm: 2, lg: 5, xl: 6 };
const COLOR_NAMES = { red: 'Red', orange: 'Orange', green: 'Green', blue: 'Blue', purple: 'Purple', gray: 'Gray' }, SIZE_NAMES = { sm: 'Small', normal: 'Normal', lg: 'Large', xl: 'Extra large' };
const NOT_CONNECTED = 'Not connected: needs provider setup by an administrator';
const NO_FILES = 'Attachments are not available: they need private file storage and a malware scan, which this server does not have.';

/** canonical markup -> DOM nodes (no innerHTML; a colour/size tag becomes a span with a fixed class) */
export function renderRich(canon, parent) {
  const re = /<(\/?)(b|i|u|s|br|ul|li|h2|h3|blockquote|a|fc-(?:red|orange|green|blue|purple|gray)|fs-(?:sm|lg|xl))((?: href="[^"<>]*")?)>/g; const stack = [parent]; let last = 0, m;
  const text = (t) => { if (t) stack[stack.length - 1].appendChild(document.createTextNode(unesc(t))); };
  while ((m = re.exec(canon))) {
    text(canon.slice(last, m.index)); last = re.lastIndex;
    if (m[2] === 'br') { stack[stack.length - 1].appendChild(document.createElement('br')); continue; }
    const fixed = /^f[cs]-/.test(m[2]);
    if (m[1]) { const top = stack[stack.length - 1]; if (stack.length > 1 && (fixed ? top.dataset.tag === m[2] : top.localName === m[2])) stack.pop(); continue; }
    const node = fixed ? el('span', 'chat-' + m[2], undefined, { 'data-tag': m[2] }) : document.createElement(m[2]);
    if (m[2] === 'a') { const h = safeHref(unesc((/href="([^"]*)"/.exec(m[3]) || [])[1] || '')); if (h) { node.setAttribute('href', h); node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer nofollow'); } }
    stack[stack.length - 1].appendChild(node); stack.push(node);
  }
  text(canon.slice(last)); return parent;
}
const hexOf = (v) => { v = String(v || '').trim().toLowerCase(); const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(v); return m ? '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('') : v; };
/** the composer's contentEditable -> raw markup. Only palette colours and the three sizes survive; the server sanitizes the result again, authoritatively. */
function fromEditor(root) {
  const MAP = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', S: 's', STRIKE: 's', DEL: 's', UL: 'ul', LI: 'li', H1: 'h2', H2: 'h2', H3: 'h3', BLOCKQUOTE: 'blockquote' };
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const colorOf = (v) => Object.keys(COLORS).find((k) => COLORS[k] === hexOf(v)), sizeOf = (v) => Object.keys(SIZES).find((k) => String(SIZES[k]) === String(v));
  const walk = (node) => { let s = ''; node.childNodes.forEach((c, i, all) => {
    if (c.nodeType === 3) s += esc(c.nodeValue || '');
    else if (c.nodeType === 1) {
      if (c.tagName === 'BR') s += '<br>';
      else if (c.tagName === 'A') { const h = safeHref(c.getAttribute('href') || ''); s += h ? `<a href="${h.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${walk(c)}</a>` : walk(c); }
      else if (c.tagName === 'FONT') { let inner = walk(c); const z = sizeOf(c.getAttribute('size')), k = colorOf(c.getAttribute('color')); if (z) inner = `<fs-${z}>${inner}</fs-${z}>`; if (k) inner = `<fc-${k}>${inner}</fc-${k}>`; s += inner; }
      else if (MAP[c.tagName]) s += `<${MAP[c.tagName]}>${walk(c)}</${MAP[c.tagName]}>`;
      else if (c.tagName === 'DIV' || c.tagName === 'P') { s += walk(c); if (i < all.length - 1) s += '<br>'; }
      else s += walk(c);                                                          // any other element, and every attribute (style, class, onclick ...), is dropped
    } }); return s; };
  return walk(root);
}

export async function renderChat(root, { role } = {}) {
  root.textContent = '';
  const cfg = await api('/chat/config');                                    // a 402 (plan without chat) or 403 lands in the caller's catch and is explained there
  const people = new Map();
  try { for (const m of await api('/members')) people.set(m.user_id, m.display_name || 'Member ' + m.user_id.slice(0, 4)); } catch { /* names are a convenience */ }
  const sess = await api('/session'), me = sess.user_id, workspace = sess.workspace_id;
  const nameOf = (id) => (id === me ? 'You' : people.get(id) || 'Member ' + String(id).slice(0, 4));
  const isAdmin = ['owner', 'admin'].includes(role || cfg.role);
  try { document.execCommand('styleWithCSS', false, false); } catch { /* the editor then uses <font> elements, which is what fromEditor reads */ }

  const st = { convs: [], cur: null, msgs: new Map(), replyTo: null, editing: null, filter: { q: '', saved: false }, lastEventId: null, es: null, closed: false, pins: false };
  const ui = el('div', 'chat-app'), side = el('div', 'chat-side', undefined, { role: 'navigation', 'aria-label': 'Conversations' }), main = el('section', 'chat-main', undefined, { 'aria-label': 'Messages' });
  ui.append(side, main); root.append(ui);

  // ---------- popovers (one at a time) and menus
  let openPop = null;
  const closePop = () => { if (openPop) { openPop.node.remove(); openPop.anchor?.setAttribute('aria-expanded', 'false'); const f = openPop.returnFocus; openPop = null; f?.focus?.(); } };
  document.addEventListener('click', (e) => { if (openPop && !openPop.node.contains(e.target) && !openPop.anchor?.contains(e.target)) closePop(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openPop) { e.stopPropagation(); closePop(); } });
  /** Shows `node` as a popover inside `host`, above/below `anchor`. */
  function pop(anchor, host, node, { up = true, focus = true } = {}) {
    closePop(); node.classList.add('chat-pop'); if (up) node.classList.add('up'); host.append(node); anchor?.setAttribute('aria-expanded', 'true');
    openPop = { node, anchor, returnFocus: anchor }; if (focus) (node.querySelector('[role=menuitem]:not([aria-disabled=true]), input, button') || node).focus?.(); return node;
  }
  const arrowNav = (menu) => menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('[role=menuitem]:not([aria-disabled=true])')], i = items.indexOf(document.activeElement); if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); } else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); } else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
  });
  const menuItem = (label, fn, { disabled = false, title = '' } = {}) => {
    const b = el('button', 'chat-mi', label, { type: 'button', role: 'menuitem', ...(title ? { title } : {}) });
    if (disabled) { b.setAttribute('aria-disabled', 'true'); b.classList.add('chat-off'); b.onclick = (e) => e.preventDefault(); }
    else b.onclick = () => { closePop(); Promise.resolve(fn()).catch((e) => notice(describe(e))); };
    return b;
  };

  // ---------- conversation list
  const label = (c) => (c.is_default ? 'Everyone' : c.kind === 'direct' ? (c.members || []).filter((m) => m.user_id !== me).map((m) => nameOf(m.user_id)).join(', ') || 'Direct message' : (c.kind === 'channel' ? '# ' : '') + (c.name || 'Group'));
  function drawSide() {
    side.textContent = '';
    const head = el('div', 'chat-side-head'); head.append(el('strong', '', 'Chat'));
    const nb = el('button', 'small primary', '+ New chat', { type: 'button' }); nb.onclick = newChat; head.append(nb); side.append(head);
    const row = (c) => {
      const b = el('button', 'chat-conv' + (st.cur?.id === c.id ? ' active' : ''), undefined, { type: 'button', ...(st.cur?.id === c.id ? { 'aria-current': 'true' } : {}) });
      b.append(el('span', 'chat-conv-name', (c.is_default ? '\u{1F465} ' : '') + label(c) + (c.archived ? ' (archived)' : ''))); if (c.unread) b.append(el('span', 'chat-badge', String(c.unread > 99 ? '99+' : c.unread), { 'aria-label': c.unread + ' unread' }));
      b.onclick = () => open(c.id); return b;
    };
    const dflt = st.convs.find((c) => c.is_default); if (dflt) side.append(row(dflt));
    for (const [title, test] of [['Channels', (c) => c.kind === 'channel' && !c.is_default], ['Groups', (c) => c.kind === 'group'], ['Direct messages', (c) => c.kind === 'direct']]) {
      const items = st.convs.filter((c) => test(c) && (!c.archived || c.id === st.cur?.id)); if (!items.length) continue;
      side.append(el('div', 'chat-side-label', title)); items.forEach((c) => side.append(row(c)));
    }
    const tb = el('button', 'chat-conv', '☑ My tasks', { type: 'button' }); tb.onclick = tasksDialog; side.append(el('div', 'chat-side-label', 'Tasks'), tb);
  }
  async function loadConvs() { st.convs = (await api('/chat/conversations')).conversations; drawSide(); }

  // ---------- main pane
  const feed = el('div', 'chat-feed', undefined, { role: 'log', 'aria-live': 'polite', 'aria-label': 'Chat messages' });
  const bar = el('div', 'chat-bar'), titleEl = el('h2', 'chat-title', 'Select a conversation'), sub = el('div', 'chat-sub');
  const search = el('input', 'chat-search', undefined, { type: 'search', placeholder: 'Search messages', 'aria-label': 'Search messages', maxlength: '100' });
  const pinBtn = el('button', 'small', '\u{1F4CC} Pinned', { type: 'button', 'aria-expanded': 'false', title: 'Show pinned messages' });
  const savedBtn = el('button', 'small', '\u{1F516}', { type: 'button', 'aria-pressed': 'false', title: 'Show my bookmarks', 'aria-label': 'Show my bookmarks' });
  const saveBtn = el('button', 'small', 'Save chat', { type: 'button', title: 'Download this conversation as a text file' });
  const aiBtn = el('button', 'small', '✨ Ask QorllaMate', { type: 'button' });
  const titleBox = el('div', 'chat-titlebox'); titleBox.append(titleEl, sub); bar.append(titleBox, search, pinBtn, savedBtn, saveBtn, aiBtn);
  const pinsPanel = el('div', 'chat-pins hidden', undefined, { role: 'region', 'aria-label': 'Pinned messages' });
  const ctxBar = el('div', 'chat-context hidden');

  // ---- composer: audience bar, format toolbar, editor, buttons
  const audienceBtn = el('button', 'chat-audience', '\u{1F464} Who can see your messages?', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' });
  const fmt = el('div', 'chat-format hidden', undefined, { role: 'toolbar', 'aria-label': 'Text formatting' });
  const editor = el('div', 'chat-editor', undefined, { contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Message', 'data-placeholder': 'Message everyone…' });
  const cmd = (name, arg) => { editor.focus(); document.execCommand(name, false, arg); };
  const composer = el('div', 'chat-composer');
  const fbtn = (text, aria, fn, cls) => { const b = el('button', 'chat-fb' + (cls ? ' ' + cls : ''), text, { type: 'button', 'aria-label': aria, title: aria }); b.onmousedown = (e) => e.preventDefault(); b.onclick = fn; fmt.append(b); return b; };
  fbtn('B', 'Bold', () => cmd('bold'), 'b'); fbtn('I', 'Italic', () => cmd('italic'), 'i'); fbtn('U', 'Underline', () => cmd('underline'), 'u'); fbtn('S', 'Strikethrough', () => cmd('strikeThrough'), 's');
  const colorBtn = fbtn('A', 'Text colour', () => {
    if (openPop?.anchor === colorBtn) return closePop();
    const m = el('div', 'chat-menu-box chat-swatches', undefined, { role: 'menu', 'aria-label': 'Text colour' });
    for (const [k, hex] of Object.entries(COLORS)) { const b = el('button', 'chat-swatch', '', { type: 'button', role: 'menuitem', 'aria-label': COLOR_NAMES[k], title: COLOR_NAMES[k] }); b.style.background = hex; b.onmousedown = (e) => e.preventDefault(); b.onclick = () => { closePop(); cmd('foreColor', hex); }; m.append(b); }
    arrowNav(m); pop(colorBtn, composer, m);
  }, 'c');
  const sizeBtn = fbtn('Aa', 'Text size', () => {
    if (openPop?.anchor === sizeBtn) return closePop();
    const m = el('div', 'chat-menu-box', undefined, { role: 'menu', 'aria-label': 'Text size' });
    for (const [k, label_] of Object.entries(SIZE_NAMES)) m.append(menuItem(label_, () => cmd('fontSize', k === 'normal' ? 3 : SIZES[k])));
    arrowNav(m); pop(sizeBtn, composer, m);
  });
  const linkBtn = fbtn('\u{1F517}', 'Link', () => {
    if (openPop?.anchor === linkBtn) return closePop();
    const box = el('form', 'chat-menu-box chat-linkbox'); const inp = el('input', '', undefined, { type: 'url', placeholder: 'https://…', 'aria-label': 'Link address', maxlength: '500' }); const ok = el('button', 'small primary', 'Add link', { type: 'submit' });
    const saved = getSelection().rangeCount ? getSelection().getRangeAt(0).cloneRange() : null;
    box.onsubmit = (e) => { e.preventDefault(); const h = safeHref(inp.value.trim()); if (!h) return notice('Enter a full https:// link'); closePop(); editor.focus(); if (saved) { const s = getSelection(); s.removeAllRanges(); s.addRange(saved); } document.execCommand('createLink', false, h); };
    box.append(inp, ok); pop(linkBtn, composer, box);
  });
  const headBtn = fbtn('Hn', 'Headings', () => {
    if (openPop?.anchor === headBtn) return closePop();
    const m = el('div', 'chat-menu-box', undefined, { role: 'menu', 'aria-label': 'Headings' });
    m.append(menuItem('Heading', () => cmd('formatBlock', 'h2')), menuItem('Subheading', () => cmd('formatBlock', 'h3')), menuItem('Normal text', () => cmd('formatBlock', 'div'))); arrowNav(m); pop(headBtn, composer, m);
  });
  const moreFmt = fbtn('…', 'More formatting', () => {
    if (openPop?.anchor === moreFmt) return closePop();
    const m = el('div', 'chat-menu-box', undefined, { role: 'menu', 'aria-label': 'More formatting' });
    m.append(menuItem('Bulleted list', () => cmd('insertUnorderedList')), menuItem('Quote block', () => cmd('formatBlock', 'blockquote')), menuItem('Clear formatting', () => cmd('removeFormat'))); arrowNav(m); pop(moreFmt, composer, m);
  });
  const tBtn = el('button', 'chat-tool', 'T', { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Format', title: 'Format' });
  const gifBtn = el('button', 'chat-tool', 'GIF', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': 'GIF' }), fileBtn = el('button', 'chat-tool', '\u{1F4C4}', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'File', title: 'File' });
  const sendBtn = el('button', 'primary', 'Send', { type: 'button' });
  tBtn.onclick = () => { const on = fmt.classList.toggle('hidden') === false; tBtn.setAttribute('aria-pressed', String(on)); if (on) editor.focus(); };
  const lock = (b, why) => { b.setAttribute('aria-disabled', 'true'); b.title = why; b.classList.add('chat-off'); b.onclick = (e) => { e.preventDefault(); notice(why); }; };
  if (cfg.features.gif) gifBtn.onclick = gifPicker; else lock(gifBtn, 'GIFs are switched off on this server.');
  fileBtn.onclick = () => {
    if (openPop?.anchor === fileBtn) return closePop();
    const m = el('div', 'chat-menu-box', undefined, { role: 'menu', 'aria-label': 'Add a file' });
    for (const n of ['Dropbox', 'Microsoft OneDrive', 'Google Drive', 'Box', 'Microsoft SharePoint']) m.append(menuItem(n, () => {}, { disabled: true, title: NOT_CONNECTED }));       // no connectors exist: shown, never faked
    m.append(menuItem('Your computer', async () => { await api(`/chat/conversations/${st.cur.id}/attachments`, { method: 'POST', body: JSON.stringify({}) }); }, cfg.features.attachments_flag ? {} : { disabled: true, title: NO_FILES }));
    arrowNav(m); pop(fileBtn, composer, m);
  };
  const compose = el('div', 'chat-compose'); compose.append(tBtn, gifBtn, fileBtn, el('span', 'chat-spacer'), sendBtn);
  composer.append(ctxBar, audienceBtn, fmt, editor, compose);
  main.append(bar, pinsPanel, feed, composer);

  audienceBtn.onclick = async () => {
    if (!st.cur) return; if (openPop?.anchor === audienceBtn) return closePop();
    const box = el('div', 'chat-menu-box chat-audience-pop', undefined, { role: 'dialog', 'aria-label': 'Who can see your messages' }); box.append(el('strong', '', 'Who can see your messages?'), el('p', '', 'Loading…'));
    pop(audienceBtn, composer, box, { focus: false });
    try {
      const c = await api('/chat/conversations/' + st.cur.id); box.textContent = ''; box.append(el('strong', '', 'Who can see your messages?'));
      if (c.audience.scope === 'workspace') box.append(el('p', '', `Everyone in this workspace (${c.audience.count} ${c.audience.count === 1 ? 'person' : 'people'}) can read and post in ${c.is_default ? 'Everyone' : '#' + c.name}.`));
      else { box.append(el('p', '', `Only these ${c.audience.count} ${c.audience.count === 1 ? 'person' : 'people'} can see this conversation:`)); const ul = el('ul'); for (const m of c.members || []) ul.append(el('li', '', nameOf(m.user_id))); box.append(ul, el('p', 'chat-note', 'Workspace admins who are not in it cannot read it.')); }
      if (c.post_policy === 'admins') box.append(el('p', 'chat-note', 'Only workspace admins can post here.')); if (c.archived) box.append(el('p', 'chat-note', 'This conversation is archived: nobody can post.'));
      box.append(el('p', 'chat-note', 'QorllaMate reads this conversation only when someone asks it, on the private Qorlla AI model. Nothing is sent to third-party AI.'));
    } catch (e) { box.textContent = describe(e); }
  };

  // ---------- messages
  const plainOf = (m) => m.body || '';
  const timeOf = (m) => { try { return new Date(m.created_at).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }); } catch { return ''; } };
  function body(m, target) {
    target.textContent = '';
    if (m.deleted) { target.append(el('em', 'chat-deleted', 'This message was deleted')); return; }
    if (m.kind === 'gif') { const u = safeHref(m.body); if (u && /^https:\/\/(?:media\d*|i)\.giphy\.com\//.test(u)) { const i = el('img', 'chat-gif', undefined, { alt: 'GIF', loading: 'lazy', referrerpolicy: 'no-referrer' }); i.src = u; target.append(i); } return; }
    if (m.rich) renderRich(m.rich, target); else target.textContent = m.body;
  }
  function moreMenu(m, btn, host) {
    const menu = el('div', 'chat-menu-box chat-more', undefined, { role: 'menu', 'aria-label': 'Message actions' }), sep = () => menu.append(el('div', 'chat-sep', undefined, { role: 'separator' }));
    menu.append(menuItem('Copy', async () => { await navigator.clipboard.writeText(plainOf(m)); notice('Copied'); }), menuItem('Quote', () => quote(m)));
    if (m.author_id === me && m.kind === 'text') menu.append(menuItem('Edit', () => edit(m)));
    sep(); menu.append(menuItem(m.bookmarked ? 'Remove bookmark' : 'Bookmark', async () => { await api(`/chat/conversations/${st.cur.id}/messages/${m.id}/bookmark`, { method: m.bookmarked ? 'DELETE' : 'PUT' }); m.bookmarked = !m.bookmarked; redraw(m.id); }));
    if (isAdmin) { sep(); menu.append(menuItem(m.pinned ? 'Unpin' : 'Pin for everyone', async () => { await api(`/chat/conversations/${st.cur.id}/messages/${m.id}/pin`, { method: m.pinned ? 'DELETE' : 'PUT' }); })); }
    sep(); menu.append(menuItem('Create task', () => taskForm(m, host)));
    if (m.author_id === me || isAdmin) { sep(); menu.append(menuItem('Delete', async () => { if (confirm('Delete this message for everyone?')) await api(`/chat/conversations/${st.cur.id}/messages/${m.id}`, { method: 'DELETE' }); })); }
    arrowNav(menu); pop(btn, host, menu, { up: false });
    const mr = menu.getBoundingClientRect(), fr = feed.getBoundingClientRect(); if (mr.bottom > fr.bottom) feed.scrollTop += mr.bottom - fr.bottom + 8;
  }
  function row(m) {
    const r = el('article', 'chat-msg' + (m.kind === 'ai' ? ' ai' : ''), undefined, { 'data-id': m.id });
    r.append(el('div', 'chat-avatar', (m.kind === 'ai' ? 'Q' : nameOf(m.author_id)[0] || '?').toUpperCase(), { 'aria-hidden': 'true' }));
    const col = el('div', 'chat-col'); r.append(col);
    const meta = el('div', 'chat-meta'); meta.append(el('strong', '', m.kind === 'ai' ? 'QorllaMate' : nameOf(m.author_id)), el('time', '', timeOf(m)));
    if (m.edited_at && !m.deleted) meta.append(el('small', 'chat-edited', 'edited')); if (m.pinned) meta.append(el('span', '', '\u{1F4CC}', { role: 'img', 'aria-label': 'Pinned' })); if (m.bookmarked) meta.append(el('span', '', '\u{1F516}', { role: 'img', 'aria-label': 'Bookmarked' }));
    col.append(meta);
    if (m.reply) col.append(el('div', 'chat-replyref', '↳ ' + nameOf(m.reply.author_id) + ': ' + (m.reply.deleted ? 'deleted message' : m.reply.body)));
    const line = el('div', 'chat-line'), bubble = el('div', 'chat-body'); body(m, bubble); line.append(bubble);
    if (!m.deleted) {
      const hov = el('div', 'chat-hover');                                          // beside the message on hover/focus; below it on touch (see the CSS)
      const reply = el('button', 'chat-ic', '↩', { type: 'button', 'aria-label': 'Reply', title: 'Reply' }); reply.onclick = () => { st.replyTo = m; st.editing = null; showCtx('Replying to ' + nameOf(m.author_id)); editor.focus(); };
      const more = el('button', 'chat-ic', '⋯', { type: 'button', 'aria-label': 'More actions', title: 'More', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }); more.onclick = (e) => { e.stopPropagation(); if (openPop?.anchor === more) return closePop(); moreMenu(m, more, r); };
      hov.append(reply, more); line.append(hov);
    }
    col.append(line); return r;
  }
  const visible = (m) => (!st.filter.saved || m.bookmarked) && (!st.filter.q || plainOf(m).toLowerCase().includes(st.filter.q));
  function redraw(id) { const m = st.msgs.get(id); const old = feed.querySelector(`[data-id="${id}"]`); if (!m || !old) return; const n = row(m); n.classList.toggle('hidden', !visible(m)); old.replaceWith(n); if (st.pins) void drawPins(); }
  function put(m) {                                                                  // idempotent: a replayed or repeated event just updates the message
    const had = st.msgs.get(m.id); const merged = { ...(had || {}), ...m, bookmarked: m.bookmarked ?? had?.bookmarked ?? false }; st.msgs.set(m.id, merged);
    if (had) return redraw(m.id);
    const near = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 160; const r = row(merged); r.classList.toggle('hidden', !visible(merged)); feed.append(r);
    if (near || merged.author_id === me) feed.scrollTop = feed.scrollHeight;
  }
  function quote(m) {
    st.replyTo = m; st.editing = null; showCtx('Quoting ' + nameOf(m.author_id)); editor.textContent = '';
    const q = el('blockquote'); q.textContent = plainOf(m).slice(0, 300); const tail = el('div'); tail.append(document.createElement('br')); editor.append(q, tail);
    editor.focus(); const r = document.createRange(); r.setStart(tail, 0); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function edit(m) { st.editing = m; st.replyTo = null; showCtx('Editing your message'); editor.textContent = ''; if (m.rich) renderRich(m.rich, editor); else editor.textContent = m.body; editor.focus(); }
  function taskForm(m, host) {
    if (host.querySelector('.chat-taskform')) return;
    const f = el('form', 'chat-taskform'); const t = el('input', '', undefined, { type: 'text', maxlength: '250', 'aria-label': 'Task title' }); t.value = plainOf(m).slice(0, 120);
    const who = el('select', '', undefined, { 'aria-label': 'Assignee' }); who.append(el('option', '', 'Unassigned', { value: '' }));
    const conv = st.convs.find((c) => c.id === st.cur.id); const ids = conv?.is_private ? (conv.members || []).map((x) => x.user_id) : [...people.keys()]; for (const id of ids) who.append(el('option', '', nameOf(id), { value: id }));
    const d = el('input', '', undefined, { type: 'date', 'aria-label': 'Due date' }), status = el('select', '', undefined, { 'aria-label': 'Status' }); status.append(el('option', '', 'Open', { value: 'open' }), el('option', '', 'Done', { value: 'done' }));
    const ok = el('button', 'primary small', 'Create task', { type: 'submit' }), no = el('button', 'small', 'Cancel', { type: 'button' }); no.onclick = () => f.remove();
    f.onsubmit = async (e) => { e.preventDefault(); try { await api(`/chat/conversations/${st.cur.id}/messages/${m.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: t.value, due_date: d.value || null, assignee_id: who.value || null, status: status.value }) }); f.remove(); notice('Task created'); } catch (err) { notice(describe(err)); } };
    f.append(t, who, d, status, ok, no); host.querySelector('.chat-col').append(f); t.focus();
  }
  function showCtx(text) { ctxBar.textContent = ''; ctxBar.classList.toggle('hidden', !text); if (!text) return; const x = el('button', 'linkbtn', '✕', { type: 'button', 'aria-label': 'Cancel' }); x.onclick = reset; ctxBar.append(el('span', '', text), x); }
  function reset() { st.replyTo = null; st.editing = null; editor.textContent = ''; showCtx(''); }
  function composerOn(on, why) { editor.contentEditable = on ? 'true' : 'false'; sendBtn.disabled = !on; editor.dataset.placeholder = on ? 'Message ' + (st.cur?.is_default ? 'everyone' : 'this conversation') + '…' : why; }

  // ---------- pinned panel
  async function drawPins() {
    pinsPanel.textContent = ''; if (!st.cur) return;
    const head = el('div', 'chat-pins-head'); head.append(el('strong', '', 'Pinned messages')); const x = el('button', 'linkbtn', '✕', { type: 'button', 'aria-label': 'Close pinned messages' }); x.onclick = () => togglePins(false); head.append(x); pinsPanel.append(head);
    try {
      const { messages } = await api(`/chat/conversations/${st.cur.id}/messages?pinned=1&limit=100`);
      if (!messages.length) pinsPanel.append(el('div', 'empty', 'Nothing is pinned yet.'));
      for (const m of messages) { const b = el('button', 'chat-pinrow', undefined, { type: 'button' }); b.append(el('strong', '', nameOf(m.author_id)), el('span', '', ' ' + plainOf(m).slice(0, 120))); b.onclick = () => { const n = feed.querySelector(`[data-id="${m.id}"]`); if (n) { n.scrollIntoView({ block: 'center', behavior: 'smooth' }); n.classList.add('chat-flash'); setTimeout(() => n.classList.remove('chat-flash'), 1400); } }; pinsPanel.append(b); }
    } catch (e) { pinsPanel.append(el('div', 'empty', describe(e))); }
  }
  function togglePins(on) { st.pins = on ?? !st.pins; pinsPanel.classList.toggle('hidden', !st.pins); pinBtn.setAttribute('aria-expanded', String(st.pins)); if (st.pins) void drawPins(); }
  pinBtn.onclick = () => togglePins();

  async function open(id) {
    st.cur = st.convs.find((c) => c.id === id) || null; st.msgs.clear(); feed.textContent = ''; reset(); closePop(); drawSide(); if (!st.cur) return;
    titleEl.textContent = label(st.cur); sub.textContent = [st.cur.is_default ? 'All-on-Board · everyone in the workspace' : st.cur.is_private ? 'Private' : 'Everyone in the workspace', st.cur.topic && !st.cur.is_default ? st.cur.topic : ''].filter(Boolean).join(' · ');
    const canPost = !st.cur.archived && !(st.cur.post_policy === 'admins' && !isAdmin); composerOn(canPost, st.cur.archived ? 'This conversation is archived' : 'Only workspace admins can post here'); if (st.pins) void drawPins();
    try {
      const r = await api(`/chat/conversations/${id}/messages?limit=100`); r.messages.forEach(put); feed.scrollTop = feed.scrollHeight;
      if (r.last_seq) { await api(`/chat/conversations/${id}/read`, { method: 'POST', body: JSON.stringify({ seq: r.last_seq }) }); const c = st.convs.find((x) => x.id === id); if (c) c.unread = 0; drawSide(); }
    } catch (e) { feed.append(el('div', 'empty', describe(e))); }
  }

  // ---------- sending
  async function send() {
    const plain = editor.textContent.trim(); if (!plain || !st.cur) return; sendBtn.disabled = true;
    try {
      const rich = fromEditor(editor);
      if (st.editing) { const m = await api(`/chat/conversations/${st.cur.id}/messages/${st.editing.id}`, { method: 'PATCH', body: JSON.stringify({ rich }) }); put(m); }
      else { const m = await api(`/chat/conversations/${st.cur.id}/messages`, { method: 'POST', body: JSON.stringify({ rich, reply_to: st.replyTo?.id, client_key: uuid4() }) }); put(m); }
      reset();
    } catch (e) { notice(describe(e)); } finally { sendBtn.disabled = false; }
  }
  sendBtn.onclick = () => void send();
  editor.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); } });
  editor.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').slice(0, 8000)); });         // formatting is applied with the toolbar, never pasted in
  search.addEventListener('input', () => { st.filter.q = search.value.trim().toLowerCase(); st.msgs.forEach((m) => feed.querySelector(`[data-id="${m.id}"]`)?.classList.toggle('hidden', !visible(m))); });
  savedBtn.onclick = () => { st.filter.saved = !st.filter.saved; savedBtn.setAttribute('aria-pressed', String(st.filter.saved)); st.msgs.forEach((m) => feed.querySelector(`[data-id="${m.id}"]`)?.classList.toggle('hidden', !visible(m))); };
  saveBtn.onclick = async () => {
    if (!st.cur) return; try {
      const r = await fetch(`/api/v1/chat/conversations/${st.cur.id}/export`, { credentials: 'same-origin', headers: { 'X-Workspace-Id': workspace } }); if (!r.ok) throw new Error('Could not save the chat');
      const u = URL.createObjectURL(await r.blob()), a = el('a', '', undefined, { download: (st.cur.is_default ? 'everyone' : st.cur.name || st.cur.kind) + '.txt' }); a.href = u; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 8000);
    } catch (e) { notice(e.message); }
  };

  // ---------- dialogs: new chat (To:), channel, tasks, QorllaMate; the GIF picker is a popover
  function dialog(title, build) {
    const back = el('div', 'chat-modal'), box = el('div', 'chat-dialog', undefined, { role: 'dialog', 'aria-modal': 'true', 'aria-label': title }); const close = () => { back.remove(); document.removeEventListener('keydown', esc); };
    const esc = (e) => { if (e.key === 'Escape' && !openPop) close(); }; document.addEventListener('keydown', esc);
    const h = el('div', 'chat-dialog-head'); h.append(el('h3', '', title)); const x = el('button', 'linkbtn', '✕', { type: 'button', 'aria-label': 'Close' }); x.onclick = close; h.append(x);
    box.append(h); build(box, close); back.append(box); back.onclick = (e) => { if (e.target === back) close(); }; document.body.append(back); return close;
  }
  function newChat() {
    dialog('New chat', (box, close) => {
      const to = el('div', 'chat-to'); const chips = el('div', 'chat-chips', undefined, { 'aria-live': 'polite' }); const find = el('input', '', undefined, { type: 'search', placeholder: 'To: type a name', 'aria-label': 'To', autocomplete: 'off' });
      const list = el('div', 'chat-people', undefined, { role: 'listbox', 'aria-label': 'People', 'aria-multiselectable': 'true' }); const chosen = new Set(); const name = el('input', 'hidden', undefined, { type: 'text', maxlength: '80', placeholder: 'Group name (optional)', 'aria-label': 'Group name' });
      const go = el('button', 'primary', 'Start chat', { type: 'button' });
      const draw = () => {
        chips.textContent = ''; for (const id of chosen) { const c = el('button', 'chat-chip', nameOf(id) + ' ✕', { type: 'button', 'aria-label': 'Remove ' + nameOf(id) }); c.onclick = () => { chosen.delete(id); draw(); }; chips.append(c); }
        list.textContent = ''; const q = find.value.trim().toLowerCase();
        for (const [id, n] of people) if (id !== me && n.toLowerCase().includes(q)) { const o = el('button', 'chat-person' + (chosen.has(id) ? ' on' : ''), (chosen.has(id) ? '✓ ' : '') + n, { type: 'button', role: 'option', 'aria-selected': String(chosen.has(id)) }); o.onclick = () => { chosen.has(id) ? chosen.delete(id) : chosen.add(id); draw(); }; list.append(o); }
        name.classList.toggle('hidden', chosen.size < 2); go.disabled = !chosen.size; go.textContent = chosen.size > 1 ? 'Start group chat' : 'Start chat';
      };
      find.oninput = draw;
      go.onclick = async () => { try { const kind = chosen.size > 1 ? 'group' : 'direct'; const c = await api('/chat/conversations', { method: 'POST', body: JSON.stringify({ kind, name: kind === 'group' ? name.value.trim() || undefined : undefined, member_ids: [...chosen] }) }); close(); await loadConvs(); await open(c.id); } catch (e) { notice(describe(e)); } };
      to.append(chips, find); box.append(to, list, name, go);
      if (isAdmin) { const ch = el('button', 'linkbtn', 'Create a channel instead', { type: 'button' }); ch.onclick = () => { close(); newChannel(); }; box.append(ch); }
      draw(); find.focus();
    });
  }
  function newChannel() {
    dialog('New channel', (box, close) => {
      const name = el('input', '', undefined, { type: 'text', maxlength: '80', placeholder: 'Channel name', 'aria-label': 'Channel name' }), topic = el('input', '', undefined, { type: 'text', maxlength: '250', placeholder: 'Topic (optional)', 'aria-label': 'Topic' });
      const priv = el('label', 'chat-check'), pc = el('input', '', undefined, { type: 'checkbox' }); priv.append(pc, ' Private channel (members only)'); const go = el('button', 'primary', 'Create channel', { type: 'button' });
      go.onclick = async () => { try { const c = await api('/chat/conversations', { method: 'POST', body: JSON.stringify({ kind: 'channel', name: name.value.trim(), topic: topic.value.trim() || undefined, is_private: pc.checked }) }); close(); await loadConvs(); await open(c.id); } catch (e) { notice(describe(e)); } };
      box.append(name, topic, priv, go); name.focus();
    });
  }
  async function tasksDialog() {
    dialog('My tasks', async (box) => {
      const list = box.appendChild(el('div', 'chat-tasklist'));
      try {
        const { tasks } = await api('/chat/tasks?status=all'); if (!tasks.length) list.append(el('div', 'empty', 'No tasks yet. Use "Create task" in a message\'s More menu.'));
        for (const t of tasks) { const r = el('label', 'chat-check'); const c = el('input', '', undefined, { type: 'checkbox' }); c.checked = t.status === 'done'; c.onchange = async () => { try { await api('/chat/tasks/' + t.id, { method: 'PATCH', body: JSON.stringify({ status: c.checked ? 'done' : 'open' }) }); } catch (e) { notice(describe(e)); c.checked = !c.checked; } };
          r.append(c, ' ' + t.title + (t.due_date ? ' · due ' + t.due_date : '') + (t.assignee_id ? ' · ' + nameOf(t.assignee_id) : '') + ' · ' + t.status); list.append(r); }
      } catch (e) { list.append(el('div', 'empty', describe(e))); }
    });
  }
  aiBtn.onclick = () => {
    if (!st.cur) return notice('Open a conversation first'); if (!cfg.features.ai) return notice('QorllaMate is not available on this server.');
    dialog('Ask QorllaMate about this conversation', (box) => {
      box.append(el('p', 'chat-note', 'QorllaMate reads the recent messages of this conversation (names are replaced by labels) only when you ask, and runs on the private Qorlla AI model. Nothing is sent to third-party AI. Your question and its answer are not stored unless you share the answer.'));
      const q = el('textarea', '', undefined, { maxlength: '1000', rows: '3', 'aria-label': 'Your question', placeholder: 'e.g. Summarise the decisions so far' }); const share = el('label', 'chat-check'), sc = el('input', '', undefined, { type: 'checkbox' }); share.append(sc, ' Post the answer in this conversation');
      const go = el('button', 'primary', 'Ask', { type: 'button' }), out = el('div', 'chat-answer', undefined, { 'aria-live': 'polite' }); const key = uuid4();
      go.onclick = async () => { if (q.value.trim().length < 3) return notice('Ask a longer question'); go.disabled = true; out.textContent = 'Thinking…';
        try { const r = await api(`/chat/conversations/${st.cur.id}/ai`, { method: 'POST', body: JSON.stringify({ question: q.value.trim(), client_key: key + ':' + Date.now(), share: sc.checked }) }); out.textContent = r.answer; }
        catch (e) { out.textContent = describe(e); } finally { go.disabled = false; } };
      box.append(q, share, go, out);
    });
  };
  function gifPicker() {
    if (openPop?.anchor === gifBtn) return closePop();
    const box = el('div', 'chat-menu-box chat-gifpop', undefined, { role: 'dialog', 'aria-label': 'GIF picker' }); const q = el('input', '', undefined, { type: 'search', placeholder: 'Search GIPHY', maxlength: '60', 'aria-label': 'Search GIPHY' }), grid = el('div', 'chat-gifgrid');
    const run = async () => { if (!q.value.trim()) return; try { const { gifs } = await api('/chat/gifs?q=' + encodeURIComponent(q.value)); grid.textContent = ''; if (!gifs.length) grid.append(el('small', '', 'No GIFs found'));
      for (const g of gifs) { const b = el('button', 'linkbtn', undefined, { type: 'button', 'aria-label': g.title || 'GIF' }); const i = el('img', '', undefined, { alt: g.title || 'GIF', referrerpolicy: 'no-referrer' }); i.src = g.preview; b.append(i);
        b.onclick = async () => { try { put(await api(`/chat/conversations/${st.cur.id}/messages`, { method: 'POST', body: JSON.stringify({ kind: 'gif', gif_url: g.url, client_key: uuid4() }) })); closePop(); } catch (e) { notice(describe(e)); } }; grid.append(b); } } catch (e) { notice(describe(e)); } };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void run(); } });
    box.append(q, grid, el('div', 'chat-powered', 'POWERED BY GIPHY'), el('small', 'chat-note', 'Your search words are sent to GIPHY through this server; the key never reaches your browser.')); pop(gifBtn, composer, box);
  }

  // ---------- live updates (SSE). The browser reconnects by itself and sends Last-Event-ID; when the 15-minute token has lapsed the stream is refused, so renew and reopen by hand.
  function connect() {
    if (st.closed) return;
    const es = new EventSource('/api/v1/chat/stream?workspace=' + encodeURIComponent(workspace) + (st.lastEventId ? '&last_event_id=' + st.lastEventId : '')); st.es = es;
    es.addEventListener('chat', (e) => {
      if (e.lastEventId) st.lastEventId = e.lastEventId; const ev = JSON.parse(e.data), m = ev.message;
      if (st.cur && ev.conversation_id === st.cur.id) { put(m); if ((ev.type === 'pin' || ev.type === 'unpin') && st.pins) void drawPins(); if (m.author_id !== me) api(`/chat/conversations/${st.cur.id}/read`, { method: 'POST', body: JSON.stringify({ seq: ev.seq }) }).catch(() => {}); }
      else loadConvs().catch(() => {});                                                 // a message elsewhere: refresh unread counts (and pick up a conversation we did not know)
    });
    es.addEventListener('resync', () => { loadConvs().then(() => st.cur && open(st.cur.id)).catch(() => {}); });
    es.addEventListener('bye', () => { es.close(); notice('Chat was disconnected: sign in again or ask an admin about your access.'); });
    es.onerror = () => { if (es.readyState !== 2 || st.closed) return; setTimeout(async () => { try { await api('/chat/config'); connect(); } catch (e) { if (e.status !== 401 && e.status !== 402 && e.status !== 403) setTimeout(connect, 5000); } }, 1500); };
  }
  const stop = () => { st.closed = true; st.es?.close(); };
  addEventListener('pagehide', stop, { once: true });

  await loadConvs(); connect();
  const first = st.convs.find((c) => c.is_default) || st.convs[0]; if (first) await open(first.id); else { titleEl.textContent = 'Welcome to Chat'; sub.textContent = 'Start a conversation with + New chat'; composerOn(false, 'Start a conversation first'); }
  return { stop };
}
