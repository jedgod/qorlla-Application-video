// Shared helpers for the portal pages (DOM helpers, API client with silent token renewal, escaping).
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, cur = 'usd') => new Intl.NumberFormat(undefined, { style: 'currency', currency: cur.toUpperCase() }).format(cents / 100);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '-');
const cookie = (n) => decodeURIComponent((document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]+)')) || [])[1] || '');
const notice = (t) => { $('#notice').textContent = t || ''; };

class ApiError extends Error { constructor(status, body) { super(body?.error || 'Request failed'); this.status = status; this.body = body || {}; } }

// Renews the 15-minute portal token from MAIN (same origin) when it has lapsed, then retries once.
let renewing = null;
async function renewToken() {
  renewing ??= fetch('/api/auth/portal-token', { method: 'POST', credentials: 'same-origin' }).then((r) => r.ok).finally(() => { renewing = null; });
  return renewing;
}
async function api(path, options = {}, retried = false) {
  const method = options.method || 'GET';
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRF-Token': cookie('qorlla_csrf') } : {}) };
  const r = await fetch('/api/v1' + path, { ...options, headers, credentials: 'same-origin' });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 && !retried && (await renewToken())) return api(path, options, true);
  if (!r.ok) throw new ApiError(r.status, body);
  return body;
}
const heading = (title, sub, icon = '✦') => `<div class="hero"><div><div class="eyebrow">Qorlla Workplace</div><h1>${esc(title)}</h1><p>${esc(sub)}</p></div><div class="symbol" aria-hidden="true">${icon}</div></div>`;
const panel = (title, body) => `<section class="panel"><h2>${esc(title)}</h2>${body}</section>`;
function describe(e) {
  if (e.status === 402) return `Your ${e.body.plan} plan allows ${e.body.limit} for this. Upgrade on the pricing page to add more.`;
  if (e.status === 403) return 'You do not have permission to do that in this workspace.';
  return e.message;
}
export { $, esc, money, day, cookie, notice, ApiError, api, heading, panel, describe };
