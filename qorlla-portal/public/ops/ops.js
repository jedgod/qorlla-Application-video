// Shared helpers for the Admin, Staff and Support pages. No inline script (the portal CSP is script-src 'self'), no HTML string building: every value from the server or a customer is inserted with textContent.
// Authentication is the portal's own: the MAIN session cookie is sent automatically and writes carry the double-submit CSRF token from the qorlla_csrf cookie. These pages never handle a password or token.
export const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v === true) n.setAttribute(k, ''); else if (v !== false && v != null) n.setAttribute(k, v); }
  for (const c of [].concat(kids)) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};
const csrf = () => (document.cookie.split('; ').find((c) => c.startsWith('qorlla_csrf=')) || '').slice('qorlla_csrf='.length);
export async function api(method, path, body) {
  const headers = {}; if (body !== undefined) headers['content-type'] = 'application/json'; if (method !== 'GET') headers['x-csrf-token'] = csrf();
  const r = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = r.headers.get('content-type') || '', data = ct.includes('json') ? await r.json().catch(() => ({})) : await r.text();
  return { status: r.status, ok: r.ok, data };
}
export const uuid = () => crypto.randomUUID();
export const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '');
/** A one-line explanation for the error a person actually needs to understand; never shows raw server text from another system. */
export function why(r) {
  if (r.status === 401) return 'Please sign in to Qorlla first.';
  if (r.status === 403) return r.data?.code === 'mfa_required' ? 'This area needs multi-factor authentication. Sign in again with MFA.' : 'You do not have access to this.';
  if (r.status === 503) return 'A required service is unavailable, so access was refused. Nothing was changed.';
  if (r.status === 404) return 'Not found, or not available to you.';
  return r.data?.error ? String(r.data.error).slice(0, 200) : 'Request failed (' + r.status + ').';
}
export function shell(title, nav, gate) {
  document.title = title + ' · Qorlla'; document.body.textContent = '';
  const main = el('main', { id: 'main', 'aria-live': 'polite' }), msg = el('p', { id: 'msg', role: 'status', class: 'msg' });
  const tabs = el('nav', { 'aria-label': 'Sections' }, Object.keys(nav).map((name) => el('button', { type: 'button', class: 'tab', onclick: () => open(name), text: name })));
  document.body.append(el('header', {}, [el('strong', { text: 'Qorlla ' + title }), el('span', { class: 'pill', text: gate })]), tabs, msg, main);
  const say = (t, bad) => { msg.textContent = t || ''; msg.className = 'msg' + (bad ? ' bad' : ''); };
  async function open(name) { [...tabs.children].forEach((b) => b.classList.toggle('active', b.textContent === name)); main.textContent = ''; say(''); try { await nav[name](main, say); } catch { say('Something went wrong. Nothing was changed.', true); } }
  open(Object.keys(nav)[0]); return { open, say };
}
export const table = (cols, rows, onRow) => el('table', {}, [el('thead', {}, el('tr', {}, cols.map((c) => el('th', { text: c[0] })))),
  el('tbody', {}, rows.map((r) => el('tr', {}, cols.map((c, i) => el('td', {}, i === 0 && onRow ? el('button', { type: 'button', class: 'link', onclick: () => onRow(r), text: String(c[1](r) ?? '') }) : String(c[1](r) ?? ''))))))]);
