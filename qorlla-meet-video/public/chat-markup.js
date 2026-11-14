/* Qorlla Meet chat: rich-text markup, shared by the server (sanitize + plain text) and the page (render).
 *
 * Design: rich text is NEVER stored or shown as free HTML. The server turns whatever the page sends into a CANONICAL string that can only contain these tags:
 *   <b> <i> <u> <s> <br> <ul> <li> <h2> <blockquote> and <a href="https://..."> (no other attribute). Everything else is escaped text. The page renders the canonical string by
 *   building DOM nodes (createElement/createTextNode), so there is no innerHTML and no way for markup to become script, an image, a form, or an attribute.
 *
 * Exports: sanitize(input) -> canonical string | null (too long / empty), toPlain(canonical) -> text, hasMarkup(canonical), isSafeUrl(url) -> normalized https URL | null,
 *          render(canonical, parentElement), fromEditor(rootElement) -> raw markup string (the server sanitizes again).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.QorllaChatMarkup = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MAX_OUT = 8000, MAX_DEPTH = 8, MAX_TAGS = 200, MAX_URL = 500;
  const KEEP = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', strike: 's', del: 's', ul: 'ul', li: 'li', h1: 'h2', h2: 'h2', h3: 'h2', blockquote: 'blockquote', a: 'a' };
  const BLOCKS = new Set(['p', 'div', 'ol', 'tr', 'pre']);                                   // become a line break when they close
  const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'textarea', 'svg', 'math', 'title', 'head']);
  const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;   // control, zero-width and bidi-override characters

  const CTRL_TEST = new RegExp(CTRL.source);
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (t) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decode(t) {
    return t.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (m, g) => {
      if (g[0] === '#') {
        const n = g[1].toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        if (!Number.isFinite(n) || n < 32 && n !== 10 && n !== 9 || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return '';
        return String.fromCodePoint(n);
      }
      const v = NAMED[g.toLowerCase()]; return v === undefined ? m : v;
    });
  }

  function isSafeUrl(raw) {
    if (typeof raw !== 'string') return null;
    const s = decode(raw).trim();
    if (!s || s.length > MAX_URL || /[\s"'<>`\\]/.test(s) || CTRL_TEST.test(s)) return null;
    let u; try { u = new URL(s); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
    const out = u.href; return out.length <= MAX_URL ? out : null;
  }

  function attr(tagSrc, name) {                                                               // href="..." | href='...' | href=bare
    const m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i').exec(tagSrc);
    return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
  }

  function sanitize(input) {
    if (typeof input !== 'string') return null;
    const src = input.length > 40000 ? input.slice(0, 40000) : input;
    let out = '', i = 0, tags = 0, skipUntil = null;
    const stack = [];                                                                          // { name, emitted }
    const lastIsBreak = () => out === '' || /<br>$/.test(out);
    const text = (t) => { out += esc(decode(t).replace(CTRL, '').replace(/ /g, ' ')); };
    const open = (name, extra = '') => { if (tags >= MAX_TAGS) return false; tags++; out += '<' + name + extra + '>'; return true; };
    while (i < src.length) {
      const lt = src.indexOf('<', i);
      if (lt === -1) { if (!skipUntil) text(src.slice(i)); break; }
      if (lt > i && !skipUntil) text(src.slice(i, lt));
      i = lt;
      if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i + 4); i = e === -1 ? src.length : e + 3; continue; }
      const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[\s\/][^<>]*)?)>/.exec(src.slice(i, i + 2000));
      if (!m) { if (!skipUntil) out += '&lt;'; i += 1; continue; }                              // a lone "<" is just text
      i += m[0].length;
      const closing = m[1] === '/', raw = m[2].toLowerCase(), rest = m[3] || '';
      if (skipUntil) { if (closing && raw === skipUntil) skipUntil = null; continue; }
      if (!closing && DROP_WITH_CONTENT.has(raw)) { if (!/\/\s*$/.test(rest)) skipUntil = raw; continue; }
      if (raw === 'br') { if (!closing && tags < MAX_TAGS) { tags++; out += '<br>'; } continue; }
      const name = KEEP[raw];
      if (!name) { if (closing && BLOCKS.has(raw) && !lastIsBreak()) { if (tags < MAX_TAGS) { tags++; out += '<br>'; } } continue; }
      if (!closing) {
        if (stack.length >= MAX_DEPTH) continue;
        if (name === 'a') {
          const href = isSafeUrl(attr(rest, 'href') || '');
          if (!href) { stack.push({ name, emitted: false }); continue; }                         // keep the text, drop the link (and its closing tag)
          stack.push({ name, emitted: open('a', ' href="' + escAttr(href) + '"') });
        } else stack.push({ name, emitted: open(name) });
      } else {
        const at = (() => { for (let k = stack.length - 1; k >= 0; k--) if (stack[k].name === name) return k; return -1; })();
        if (at === -1) continue;                                                                // a closing tag with no opener is ignored
        while (stack.length > at) { const t = stack.pop(); if (t.emitted) out += '</' + t.name + '>'; }
      }
    }
    while (stack.length) { const t = stack.pop(); if (t.emitted) out += '</' + t.name + '>'; }
    out = out.replace(/^(?:<br>)+/, '').replace(/(?:<br>)+$/, '').replace(/(?:<br>){3,}/g, '<br><br>');
    return out.length > MAX_OUT ? null : out;
  }

  // canonical -> events (the canonical string is produced by sanitize(), so a simple scan is enough)
  function* events(canon) {
    const re = /<(\/?)(b|i|u|s|br|ul|li|h2|blockquote|a)((?: href="[^"<>]*")?)>/g; let last = 0, m;
    while ((m = re.exec(canon))) {
      if (m.index > last) yield { type: 'text', text: decode(canon.slice(last, m.index)) };
      if (m[2] === 'br') yield { type: 'br' };
      else if (m[1]) yield { type: 'close', name: m[2] };
      else yield { type: 'open', name: m[2], href: m[3] ? decode(/href="([^"]*)"/.exec(m[3])[1]) : null };
      last = re.lastIndex;
    }
    if (last < canon.length) yield { type: 'text', text: decode(canon.slice(last)) };
  }

  function toPlain(canon) {
    if (typeof canon !== 'string') return '';
    let t = '';
    for (const e of events(canon)) {
      if (e.type === 'text') t += e.text;
      else if (e.type === 'br') t += '\n';
      else if (e.type === 'open' && e.name === 'li') t += (t && !t.endsWith('\n') ? '\n' : '') + '\u2022 ';
      else if (e.type === 'close' && (e.name === 'li' || e.name === 'h2' || e.name === 'blockquote') && !t.endsWith('\n')) t += '\n';
    }
    return t.replace(/\n{3,}/g, '\n\n').trim();
  }
  const hasMarkup = (canon) => typeof canon === 'string' && /<(?:b|i|u|s|ul|li|h2|blockquote|a|br)[ >]/.test(canon);

  function render(canon, parent) {
    const doc = parent.ownerDocument, stack = [parent];
    for (const e of events(String(canon || ''))) {
      const top = stack[stack.length - 1];
      if (e.type === 'text') top.appendChild(doc.createTextNode(e.text));
      else if (e.type === 'br') top.appendChild(doc.createElement('br'));
      else if (e.type === 'open') {
        const el = doc.createElement(e.name);
        if (e.name === 'a') { const h = isSafeUrl(e.href || ''); if (h) { el.setAttribute('href', h); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer nofollow'); } }
        top.appendChild(el); stack.push(el);
      } else if (e.type === 'close' && stack.length > 1 && stack[stack.length - 1].localName === e.name) stack.pop();
    }
    return parent;
  }

  // the page's contentEditable -> raw markup (walks the DOM; the server sanitizes the result again)
  function fromEditor(rootEl) {
    const MAP = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', S: 's', STRIKE: 's', DEL: 's', UL: 'ul', LI: 'li', H1: 'h2', H2: 'h2', H3: 'h2', BLOCKQUOTE: 'blockquote' };
    const walk = (node) => {
      let s = '';
      node.childNodes.forEach((c, idx, all) => {
        if (c.nodeType === 3) s += esc(c.nodeValue || '');
        else if (c.nodeType === 1) {
          const tag = c.tagName;
          if (tag === 'BR') s += '<br>';
          else if (tag === 'A') { const h = isSafeUrl(c.getAttribute('href') || ''); s += h ? '<a href="' + escAttr(h) + '">' + walk(c) + '</a>' : walk(c); }
          else if (MAP[tag]) s += '<' + MAP[tag] + '>' + walk(c) + '</' + MAP[tag] + '>';
          else if (tag === 'DIV' || tag === 'P') { s += walk(c); if (idx < all.length - 1) s += '<br>'; }
          else if (!DROP_WITH_CONTENT.has(tag.toLowerCase())) s += walk(c);
        }
      });
      return s;
    };
    return walk(rootEl);
  }

  return { sanitize, toPlain, hasMarkup, isSafeUrl, render, fromEditor, esc };
}));
