// Qorlla pricing page. Every price, every limit and every "can I buy this?" decision comes from the server-side plan catalogue
// (GET /api/v1/plans, backed by PostgreSQL). There are NO built-in prices: if the catalogue cannot be loaded the page says so and
// purchasing is disabled, rather than showing numbers that might not match what checkout will charge.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { catalog: null, interval: 'month', loading: true };
  const money = (cents, cur = 'usd') => new Intl.NumberFormat(undefined, { style: 'currency', currency: String(cur).toUpperCase() }).format(cents / 100);
  const cookie = (n) => decodeURIComponent((document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]+)')) || [])[1] || '');
  const statusEl = $('pricingStatus');
  function setStatus(msg, isError = false, retry = false) {
    statusEl.className = isError ? 'err' : '';
    statusEl.textContent = msg || '';
    if (retry) { const b = document.createElement('button'); b.className = 'btn outline'; b.style.cssText = 'width:auto;margin:0 0 0 10px;padding:4px 12px'; b.textContent = 'Retry'; b.addEventListener('click', loadCatalog); statusEl.append(b); }
  }
  const seats = () => { const n = parseInt($('seats').value, 10); return Number.isInteger(n) ? Math.min(1000, Math.max(1, n)) : 1; };

  // ---------- API (same origin; renews the 15 minute portal token from MAIN when needed) ----------
  let renewing = null;
  const renew = () => (renewing ??= fetch('/api/auth/portal-token', { method: 'POST', credentials: 'same-origin' }).then((r) => r.ok).catch(() => false).finally(() => { renewing = null; }));
  async function api(path, { method = 'GET', body, workspace } = {}, retried = false) {
    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-CSRF-Token'] = cookie('qorlla_csrf');
    if (workspace) headers['X-Workspace-Id'] = workspace;
    const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin', cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && !retried && (await renew())) return api(path, { method, body, workspace }, true);
    if (!r.ok) { const e = new Error(j.error || 'Request failed'); e.status = r.status; e.body = j; throw e; }
    return j;
  }

  // ---------- catalogue ----------
  async function loadCatalog() {
    state.loading = true; setStatus('Loading current prices…'); render();
    try {
      if (!location.protocol.startsWith('http')) throw new Error('not served over http');
      const c = await api('/api/v1/plans');
      if (!c || !Array.isArray(c.plans)) throw new Error('bad catalogue');
      state.catalog = c; setStatus('');
    } catch (e) {
      state.catalog = null; setStatus('Current prices are unavailable right now, so purchasing is paused. Nothing on this page should be treated as a price.', true, true);
    }
    state.loading = false; render();
  }
  const explain = (reasons) => (reasons || []).includes('billing_disabled') || !(reasons || []).length
    ? 'Online checkout is not enabled yet. Contact sales to purchase.'
    : 'Online checkout is being set up. Contact sales to purchase.';

  function render() {
    const cat = state.catalog;
    const sw = $('annualToggle');
    const hasYear = !!cat && cat.plans.some((p) => p.prices && p.prices.year);
    if (!hasYear && state.interval === 'year') state.interval = 'month';
    sw.classList.toggle('on', state.interval === 'year'); sw.setAttribute('aria-checked', String(state.interval === 'year'));
    sw.style.opacity = hasYear ? '' : '.4'; sw.setAttribute('aria-disabled', String(!hasYear));
    $('annualLabel').firstChild.textContent = 'Annually ';
    let best = 0;
    if (cat) for (const p of cat.plans) if (p.prices?.month && p.prices?.year) best = Math.max(best, Math.floor(100 * (1 - p.prices.year.amount_cents / (12 * p.prices.month.amount_cents))));
    $('saveText').textContent = best > 0 ? `(Save up to ${best}%)` : '';
    for (const slug of ['pro', 'business']) {
      const priceEl = $('price-' + slug), subEl = $('sub-' + slug), btn = $('btn-' + slug), note = $('note-' + slug);
      priceEl.textContent = ''; subEl.textContent = ''; note.textContent = '';
      if (state.loading) { priceEl.textContent = 'Loading price…'; btn.disabled = true; continue; }
      if (!cat) { priceEl.textContent = 'Price unavailable'; btn.disabled = true; note.textContent = 'Purchasing is paused until prices can be loaded.'; continue; }
      const plan = cat.plans.find((p) => p.slug === slug); const price = plan?.prices?.[state.interval];
      if (!price) { priceEl.textContent = 'Not available'; subEl.textContent = `No ${state.interval === 'year' ? 'annual' : 'monthly'} price is set for this plan.`; btn.disabled = true; continue; }
      const n = seats();
      priceEl.append(document.createTextNode(money(price.per_seat_per_month_cents, cat.currency) + ' '));
      const unit = document.createElement('span'); unit.textContent = '/user/month · billed ' + (state.interval === 'year' ? 'annually' : 'monthly'); priceEl.append(unit);
      subEl.textContent = state.interval === 'year'
        ? `${money(price.amount_cents, cat.currency)} per user per year · ${money(price.amount_cents * n, cat.currency)} total for ${n} seat${n > 1 ? 's' : ''}`
        : `${money(price.amount_cents * n, cat.currency)} per month in total for ${n} seat${n > 1 ? 's' : ''}`;
      const can = !!cat.billing?.checkout_available;
      btn.disabled = !can; if (!can) note.textContent = explain(cat.billing?.unavailable_reasons);
    }
  }

  // ---------- actions ----------
  async function startCheckout(plan) {
    const btn = $('btn-' + plan); if (!state.catalog?.billing?.checkout_available) return;
    btn.disabled = true; setStatus('Preparing secure checkout…');
    try {
      let me;
      try { me = await api('/api/v1/me'); } catch (e) { if (e.status === 401) { location.href = '/login.html?next=' + encodeURIComponent('/pricing/'); return; } throw e; }
      let ws = me.workspaces.find((w) => ['owner', 'admin', 'billing'].includes(w.role));
      if (!ws) {
        if (me.workspaces.length) { setStatus('Only a workspace owner, admin or billing contact can buy a plan. Please ask one of them.', true); return; }
        const created = await api('/api/v1/workspaces', { method: 'POST', body: { name: 'My workspace' } }); ws = { workspace_id: created.workspace_id };
      }
      const r = await api('/api/v1/billing/checkout', { method: 'POST', workspace: ws.workspace_id, body: { plan, interval: state.interval, seats: seats() } });
      if (!/^https:\/\//.test(r.url)) throw new Error('Unexpected checkout address');
      setStatus(`Taking you to the payment page: ${money(r.total_cents, r.currency)} per ${r.interval === 'year' ? 'year' : 'month'} for ${r.seats} seat${r.seats > 1 ? 's' : ''}…`);
      location.assign(r.url);
    } catch (e) {
      setStatus(e.body?.code === 'already_subscribed' ? 'This workspace already has a paid plan. Manage it under Plans & Billing.'
        : e.status === 503 ? 'Online checkout is not available right now.' : (e.message || 'Could not start checkout.'), true);
    } finally { render(); }
  }

  const dlg = $('salesDialog');
  function openSales() { $('salesMsg').textContent = ''; $('salesSend').disabled = false; if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', ''); dlg.querySelector('input[name=name]').focus(); }
  $('salesCancel').addEventListener('click', () => dlg.close());
  $('salesForm').addEventListener('submit', async (ev) => {
    ev.preventDefault(); const f = new FormData(ev.target); const msg = $('salesMsg'); $('salesSend').disabled = true; msg.textContent = 'Sending…';
    try {
      const r = await api('/api/v1/sales-inquiries', { method: 'POST', body: { name: f.get('name'), email: f.get('email'), company: f.get('company') || '', message: f.get('message'), website: f.get('website') || '', plan_interest: 'enterprise' } });
      msg.textContent = `Thank you. Your request was received (reference ${String(r.id).slice(0, 8)}). A Qorlla representative will contact you by email.`; ev.target.reset();
    } catch (e) { msg.textContent = e.status === 429 ? 'Too many requests from your network. Please try again later.' : e.status === 400 ? 'Please check your details and try again.' : 'Could not send your request. Please try again.'; $('salesSend').disabled = false; }
  });

  // ---------- wiring ----------
  const toggleAnnual = () => { if ($('annualToggle').getAttribute('aria-disabled') === 'true') return; state.interval = state.interval === 'year' ? 'month' : 'year'; render(); };
  $('annualToggle').addEventListener('click', toggleAnnual);
  $('annualToggle').addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleAnnual(); } });
  $('seats').addEventListener('input', render);
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action],[data-toggle],[data-route]'); if (!t) return;
    if (t.dataset.action === 'buy') startCheckout(t.dataset.plan);
    else if (t.dataset.action === 'signup') location.href = '/login.html?next=' + encodeURIComponent('/app/');
    else if (t.dataset.action === 'sales') { e.preventDefault(); openSales(); }
    else if (t.dataset.toggle) { const box = $(t.dataset.toggle); const hidden = box.classList.toggle('hidden'); t.textContent = hidden ? (t.dataset.more || '▸ See more highlights') : (t.dataset.less || '▾ See less highlights'); }
    else if (t.dataset.route && t.tagName !== 'A') location.href = t.dataset.route;
  });
  document.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-toggle],[data-route][role=link]')) { e.preventDefault(); e.target.click(); } });

  // ---------- apps menu ----------
  const APP_SECTIONS = [
  { title: 'Qorlla AI', items: [
    ['QorllaMate', 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z'],
    ['My Notes', 'M4 20l1-4L16 5l3 3L8 19zM14 7l3 3'],
    ['Virtual Agent', 'M5 12a7 7 0 0 1 14 0v3a4 4 0 0 1-4 4H9l-4 2zM9.500 13.500c1.500 1.500 3.500 1.500 5 0'],
    ['AI Services', 'M5 4h10v4H5zM7 8v8h5M16 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
    ['AI On-Prem', 'M5 4h14v6H5zM5 14h14v6H5zM8 7h.01M8 17h.01'],
    ['AI Productivity Suite', 'M4 4h16v16H4zM12 8l1 3 3 1-3 1-1 3-1-3-3-1 3-1z'],
    ['Canvas', 'M7 3h7l4 4v14H7zM10 12h5M10 16h5', '#1a63f5'],
    ['Slides', 'M5 4h14v12H5zM12 16v4M8 20h8M9 8h6', '#ff4081'],
    ['Sheets', 'M5 4h14v16H5zM5 10h14M5 15h14M11 4v16', '#2da44e']
  ] },
  { title: 'Qorlla CX', items: [
    ['Contact Center', 'M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v4H4zM17 14h3v4h-3zM17 18c0 2-2 3-5 3'],
    ['AI Expert Assist', 'M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v4H4zM17 14h3v4h-3zM12 8l1 2 2 1-2 1-1 2-1-2-2-1 2-1z'],
    ['Workforce Management', 'M6 3h9l4 4v14H6zM9 11h6M9 15h4'],
    ['Quality Management', 'M3 5h18v13H3zM7 11l2 2 3-4M14 10h4M14 14h4'],
    ['CX Insights', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v6M12 15v6M4 7.500l5 3M15 13.500l5 3M4 16.500l5-3M15 10.500l5-3']
  ] },
  { title: 'Business Services', items: [
    ['Revenue Accelerator', 'M4 18a8 8 0 1 1 16 0M12 18l4-6M7 18h.01M17 18h.01'],
    ['Webinars & Events', 'M3 7h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4zM12 9l1 2 2 .3-1.500 1.500.4 2.200-1.900-1-1.900 1 .4-2.200L9 11.300 11 11z'],
    ['Contracts', 'M6 3h9l4 4v14H6zM9 12h6M9 16h6M9 8h3'],
    ['Hiring', 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3 3-5 6-5s6 2 6 5M17 8h4M19 6v4']
  ] }
];
  const APP_ROUTES = { 'QorllaMate': '/app/mate', 'My Notes': '/app/notes', 'AI Productivity Suite': '/app/suite', 'Virtual Agent': '/app/receptionist', 'Contact Center': '/app/solutions' };
  (function renderApps() {
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    $('appsMore').innerHTML = APP_SECTIONS.map((sec) =>
      '<div class="apps-sec"><div class="apps-sec-head"><h4>' + esc(sec.title) + '</h4></div><div class="apps-grid">' +
      sec.items.map(([name, path, bg]) => {
        const svg = '<svg viewBox="0 0 24 24"><path d="' + esc(path) + '"/></svg>';
        const icon = bg ? '<span class="apps-ico" style="background:' + esc(bg) + '">' + svg + '</span>' : svg;
        return '<a href="' + (APP_ROUTES[name] || '#') + '" role="menuitem">' + icon + esc(name) + '</a>';
      }).join('') + '</div></div>').join('');
  })();
  const appsBtn = $('appsBtn'), appsMenu = $('appsMenu');
  const setApps = (open) => { appsMenu.classList.toggle('open', open); appsBtn.setAttribute('aria-expanded', String(open)); };
  appsBtn.addEventListener('click', (e) => { e.stopPropagation(); setApps(!appsMenu.classList.contains('open')); });
  document.addEventListener('click', (e) => { if (!appsMenu.contains(e.target)) setApps(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setApps(false); appsBtn.focus(); } });

  render();
  loadCatalog();
})();
