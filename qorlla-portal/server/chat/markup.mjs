// Portal Chat rich text. Rich text is NEVER stored or shown as free HTML: the server turns whatever the page sends into a CANONICAL string that can only contain
//   <b> <i> <u> <s> <br> <ul> <li> <h2> <h3> <blockquote>, <a href="https://...">  (no other attribute)
//   and a FIXED set of colour and size tags with no attributes at all: <fc-red|orange|green|blue|purple|gray> and <fs-sm|lg|xl>.
// A colour or a size can therefore never be arbitrary CSS: `style=`, `color=`, `size=`, `class=` and every other attribute are dropped, and any tag outside this list becomes text.
// and everything else becomes escaped text. The page renders the canonical string by building DOM nodes (public/assets/chat.js), so there is no innerHTML anywhere.
// The plain-text `body` kept next to it is what search, export and QorllaMate read.
// (The design follows the Meet chat's sanitizer; this is the Portal's own copy, kept in step by tests/chat-markup.test.mjs.)
const MAX_OUT = 8000, MAX_DEPTH = 8, MAX_TAGS = 200, MAX_URL = 500;
export const COLORS = Object.freeze({ red: '#d93025', orange: '#e8710a', green: '#188038', blue: '#1a73e8', purple: '#8e24aa', gray: '#5f6368' });
export const SIZES = Object.freeze({ sm: 2, lg: 5, xl: 6 });                         // the <font size> values the editor uses; normal text is size 3 and carries no tag
const KEEP = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', strike: 's', del: 's', ul: 'ul', li: 'li', h1: 'h2', h2: 'h2', h3: 'h3', blockquote: 'blockquote', a: 'a',
  ...Object.fromEntries(Object.keys(COLORS).map((c) => ['fc-' + c, 'fc-' + c])), ...Object.fromEntries(Object.keys(SIZES).map((z) => ['fs-' + z, 'fs-' + z])) };
const BLOCKS = new Set(['p', 'div', 'ol', 'tr', 'pre']);                                   // a line break when they close
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'textarea', 'svg', 'math', 'title', 'head']);
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;       // control, zero-width and bidi-override characters
const CTRL_TEST = new RegExp(CTRL.source);

export const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (t) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(t) {
  return t.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (m, g) => {
    if (g[0] === '#') {
      const n = g[1].toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      if (!Number.isFinite(n) || (n < 32 && n !== 10 && n !== 9) || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return '';
      return String.fromCodePoint(n);
    }
    const v = NAMED[g.toLowerCase()]; return v === undefined ? m : v;
  });
}

/** A normalized https URL, or null: no other scheme, no credentials, a dotted host, no quotes/whitespace/backslash/control characters, bounded length. */
export function isSafeUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = decode(raw).trim();
  if (!s || s.length > MAX_URL || /[\s"'<>`\\]/.test(s) || CTRL_TEST.test(s)) return null;
  let u; try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
  return u.href.length <= MAX_URL ? u.href : null;
}
const attr = (tagSrc, name) => {
  const m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i').exec(tagSrc);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};

/** Anything -> canonical markup, or null when it is not a string or the result is too long. */
export function sanitize(input) {
  if (typeof input !== 'string') return null;
  const src = input.length > 40000 ? input.slice(0, 40000) : input;
  let out = '', i = 0, tags = 0, skipUntil = null;
  const stack = [];                                                                          // { name, emitted }
  const lastIsBreak = () => out === '' || /<br>$/.test(out);
  const text = (t) => { out += esc(decode(t).replace(CTRL, '').replace(/\u00A0/g, ' ')); };
  const open = (name, extra = '') => { if (tags >= MAX_TAGS) return false; tags++; out += '<' + name + extra + '>'; return true; };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { if (!skipUntil) text(src.slice(i)); break; }
    if (lt > i && !skipUntil) text(src.slice(i, lt));
    i = lt;
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i + 4); i = e === -1 ? src.length : e + 3; continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[\s/][^<>]*)?)>/.exec(src.slice(i, i + 2000));
    if (!m) { if (!skipUntil) out += '&lt;'; i += 1; continue; }                              // a lone "<" is just text
    i += m[0].length;
    const closing = m[1] === '/', raw = m[2].toLowerCase(), rest = m[3] || '';
    if (skipUntil) { if (closing && raw === skipUntil) skipUntil = null; continue; }
    if (!closing && DROP_WITH_CONTENT.has(raw)) { if (!/\/\s*$/.test(rest)) skipUntil = raw; continue; }
    if (raw === 'br') { if (!closing && tags < MAX_TAGS) { tags++; out += '<br>'; } continue; }
    const name = KEEP[raw];
    if (!name) { if (closing && BLOCKS.has(raw) && !lastIsBreak() && tags < MAX_TAGS) { tags++; out += '<br>'; } continue; }
    if (!closing) {
      if (stack.length >= MAX_DEPTH) continue;
      if (name === 'a') {
        const href = isSafeUrl(attr(rest, 'href') || '');
        if (!href) { stack.push({ name, emitted: false }); continue; }                         // keep the text, drop the link (and its closing tag)
        stack.push({ name, emitted: open('a', ' href="' + escAttr(href) + '"') });
      } else stack.push({ name, emitted: open(name) });
    } else {
      let at = -1; for (let k = stack.length - 1; k >= 0; k--) if (stack[k].name === name) { at = k; break; }
      if (at === -1) continue;                                                                // a closing tag with no opener is ignored
      while (stack.length > at) { const t = stack.pop(); if (t.emitted) out += '</' + t.name + '>'; }
    }
  }
  while (stack.length) { const t = stack.pop(); if (t.emitted) out += '</' + t.name + '>'; }
  out = out.replace(/^(?:<br>)+/, '').replace(/(?:<br>)+$/, '').replace(/(?:<br>){3,}/g, '<br><br>');
  return out.length > MAX_OUT ? null : out;
}

function* events(canon) {
  const re = /<(\/?)(b|i|u|s|br|ul|li|h2|h3|blockquote|a|fc-(?:red|orange|green|blue|purple|gray)|fs-(?:sm|lg|xl))((?: href="[^"<>]*")?)>/g; let last = 0, m;
  while ((m = re.exec(canon))) {
    if (m.index > last) yield { type: 'text', text: decode(canon.slice(last, m.index)) };
    if (m[2] === 'br') yield { type: 'br' };
    else if (m[1]) yield { type: 'close', name: m[2] };
    else yield { type: 'open', name: m[2] };
    last = re.lastIndex;
  }
  if (last < canon.length) yield { type: 'text', text: decode(canon.slice(last)) };
}

/** Canonical markup -> plain text (what search, export and the AI context read). */
export function toPlain(canon) {
  if (typeof canon !== 'string') return '';
  let t = '';
  for (const e of events(canon)) {
    if (e.type === 'text') t += e.text;
    else if (e.type === 'br') t += '\n';
    else if (e.type === 'open' && e.name === 'li') t += (t && !t.endsWith('\n') ? '\n' : '') + '\u2022 ';
    else if (e.type === 'close' && (e.name === 'li' || e.name === 'h2' || e.name === 'h3' || e.name === 'blockquote') && !t.endsWith('\n')) t += '\n';
  }
  return t.replace(/\n{3,}/g, '\n\n').trim();
}
export const hasMarkup = (canon) => typeof canon === 'string' && /<(?:b|i|u|s|ul|li|h2|h3|blockquote|a|br|fc-[a-z]+|fs-[a-z]+)[ >]/.test(canon);

/** The one entry point the routes use: { body (plain, <=4000), rich (canonical or null) } or null when invalid/empty/too long. */
export function prepareBody({ body, rich }) {
  let plain, canon = null;
  if (rich != null) {
    canon = sanitize(String(rich)); if (canon === null) return null;
    plain = toPlain(canon); if (!hasMarkup(canon)) canon = null;
  } else {
    plain = typeof body === 'string' ? body.replace(CTRL, '').replace(/\u00A0/g, ' ').trim() : '';
  }
  plain = plain.slice(0, 4000);
  return plain ? { body: plain, rich: canon } : null;
}
