// Platform admin console (only reachable by PLATFORM_ADMIN_USER_IDS; everyone else gets 404 from the API and no menu entry).
import { $, esc, api, notice, day, money, describe, panel } from './core.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '-');
const pill = (s) => `<span class="pill ${esc(s)}">${esc(String(s).replace('_', ' '))}</span>`;
const SECTIONS = { overview: 'Overview', health: 'Health', subscriptions: 'Subscriptions', invoices: 'Invoices & refunds', events: 'Provider events', sales: 'Sales leads', prices: 'Usage prices', switches: 'Kill switches' };

export async function renderAdmin(root) {
  const tab = new URLSearchParams(location.search).get('tab') || 'overview';
  root.innerHTML = `<nav aria-label="Admin sections" class="row">${Object.entries(SECTIONS).map(([k, v]) => `<a class="button ${k === tab ? '' : 'secondary'}" href="/app/admin?tab=${k}" ${k === tab ? 'aria-current="page"' : ''}>${esc(v)}</a>`).join('')}</nav><div id="admin-body" aria-live="polite"><div class="empty">Loading…</div></div>`;
  const body = $('#admin-body'); const again = () => renderAdmin(root);
  try { await (VIEWS[tab] || VIEWS.overview)(body, again); } catch (e) { body.innerHTML = `<div class="empty">${esc(describe(e))}</div>`; }
}

const VIEWS = {
  async overview(b) {
    const o = await api('/admin/billing/overview');
    b.innerHTML = (o.billing_available ? '' : `<p class="warn" role="alert">Online billing is NOT available: ${o.billing_unavailable_reasons.map((r) => `<code>${esc(r)}</code>`).join(', ') || 'disabled'}. Nobody can be charged.</p>`) +
      panel('Revenue (estimates)', `<p>Estimated MRR <strong id="adm-mrr">${esc(money(o.mrr_estimate_cents))}</strong> <span class="muted">${esc(o.mrr_note)}</span></p><p>Last 30 days: paid ${esc(money(o.last_30_days.paid_cents))} · failed invoices ${esc(o.last_30_days.failed_invoices)} · refunded ${esc(money(o.last_30_days.refunded_cents))} (${esc(o.last_30_days.refunds)})</p>`) +
      panel('Subscriptions', o.subscriptions.length ? `<table><thead><tr><th>Plan</th><th>Status</th><th>Workspaces</th><th>Seats</th></tr></thead><tbody>${o.subscriptions.map((s) => `<tr><td>${esc(s.plan_slug)}</td><td>${pill(s.status)}</td><td>${esc(s.n)}</td><td>${esc(s.seats)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No paid subscriptions.</div>') +
      panel('Provider events, last 24 h', o.events_24h.length ? `<ul>${o.events_24h.map((e) => `<li>${esc(e.outcome)}: ${esc(e.n)}</li>`).join('')}</ul>` : '<div class="empty">None.</div>') +
      panel('Sales leads', `<ul>${o.sales_inquiries.map((s) => `<li>${esc(s.status)}: ${esc(s.n)}</li>`).join('') || '<li>None</li>'}</ul>`);
  },
  async health(b) {
    const h = await api('/admin/health');
    b.innerHTML = panel(`Status: ${esc(h.status)}`, h.alerts.length ? `<table><thead><tr><th>Severity</th><th>Alert</th><th>Count</th></tr></thead><tbody>${h.alerts.map((a) => `<tr data-alert="${esc(a.code)}"><td>${pill(a.severity === 'critical' ? 'failed' : a.severity === 'warning' ? 'queued' : 'active')} ${esc(a.severity)}</td><td>${esc(a.message)}</td><td>${esc(a.count)}</td></tr>`).join('')}</tbody></table>` : '<p class="ok">No alerts.</p>') + `<p class="muted">Checked ${esc(when(h.checked_at))}. Scrapers can use the token-protected <code>/internal/metrics</code> endpoint inside the private network.</p>`;
  },
  async subscriptions(b) {
    const rows = await api('/admin/billing/subscriptions');
    b.innerHTML = panel('Paid subscriptions', rows.length ? `<table><thead><tr><th>Workspace</th><th>Plan</th><th>Status</th><th>Billing</th><th>Seats</th><th>Period ends</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.plan_slug)}</td><td>${pill(r.status)}</td><td>${esc(r.billing_interval)}${r.cancel_at_period_end ? ' · cancelling' : ''}</td><td>${esc(r.seats)}</td><td>${esc(day(r.current_period_end))}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">None.</div>');
  },
  async invoices(b, again) {
    const [rows, reqs] = await Promise.all([api('/admin/billing/invoices'), api('/admin/billing/refunds')]);
    b.innerHTML = panel('Invoices', rows.length ? `<table><thead><tr><th>Date</th><th>Workspace</th><th>Number</th><th>Status</th><th>Paid</th><th>Refunded</th><th></th></tr></thead><tbody>${rows.map((i) => `<tr data-invoice="${esc(i.id)}"><td>${esc(day(i.created_at))}</td><td>${esc(i.workspace_name)}</td><td>${esc(i.number || '-')}</td><td>${pill(i.status)}</td><td>${esc(money(i.amount_paid_cents))}</td><td>${esc(money(i.amount_refunded_cents))}</td><td>${i.refundable && i.amount_paid_cents > i.amount_refunded_cents ? '<button class="secondary" data-act="refund">Refund…</button>' : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No invoices.</div>') +
      '<dialog id="refund-dialog"><form method="dialog" id="refund-form"><h2>Issue a refund</h2><p class="muted">The provider is asked to refund the card payment. Access to the plan is not changed.</p><label>Amount in cents (empty = everything left)<input name="amount" type="number" min="1"></label><label>Reason (kept in the audit trail)<input name="reason" required minlength="3" maxlength="300"></label><div class="row"><button value="ok">Refund</button><button value="cancel" class="secondary" formnovalidate>Cancel</button></div></form></dialog>' +
      panel('Refund requests', reqs.length ? `<table><thead><tr><th>When</th><th>Amount</th><th>Reason</th><th>Status</th></tr></thead><tbody>${reqs.map((r) => `<tr><td>${esc(when(r.created_at))}</td><td>${esc(money(r.amount_cents))}</td><td>${esc(r.reason)}</td><td>${pill(r.status)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">None.</div>');
    let target = null; const dlg = $('#refund-dialog');
    b.querySelectorAll('[data-act=refund]').forEach((btn) => btn.addEventListener('click', () => { target = btn.closest('tr').dataset.invoice; dlg.showModal(); }));
    $('#refund-form').addEventListener('submit', async (e) => {
      if (e.submitter?.value !== 'ok') return; const f = Object.fromEntries(new FormData(e.target));
      try { await api('/admin/billing/refunds', { method: 'POST', body: JSON.stringify({ invoice_id: target, amount_cents: f.amount ? Number(f.amount) : undefined, reason: f.reason, idempotency_key: uid() }) }); notice('Refund issued.'); await again(); }
      catch (err) { notice(err.body?.code === 'exceeds_refundable' ? `At most ${money(err.body.refundable)} can be refunded.` : err.status === 502 ? 'The provider rejected the refund.' : describe(err)); }
    });
  },
  async events(b) {
    const rows = await api('/admin/billing/events');
    b.innerHTML = panel('Latest provider events', rows.length ? `<table><thead><tr><th>Received</th><th>Type</th><th>Outcome</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(when(r.received_at))}</td><td>${esc(r.type)}</td><td>${esc(r.outcome)}${r.processed_at ? '' : ' <span class="pill failed">unprocessed</span>'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">None.</div>');
  },
  async sales(b, again) {
    const rows = await api('/admin/sales-inquiries');
    b.innerHTML = panel('Sales leads', rows.length ? `<table><thead><tr><th>Received</th><th>Who</th><th>Message</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr data-lead="${esc(r.id)}"><td>${esc(when(r.created_at))}${r.overdue ? ' <span class="pill failed">overdue</span>' : ''}</td><td>${esc(r.name)}<br><span class="muted">${esc(r.email)}${r.company ? ' · ' + esc(r.company) : ''}</span></td><td>${esc(r.excerpt)}</td><td>${pill(r.status)}</td><td><a class="link" href="/app/admin?tab=sales&lead=${esc(r.id)}">Open →</a></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No inquiries.</div>') + '<div id="lead-detail"></div>';
    const id = new URLSearchParams(location.search).get('lead'); if (!id) return;
    const d = await api(`/admin/sales-inquiries/${id}`);
    $('#lead-detail').innerHTML = panel(`${esc(d.name)} — ${esc(d.company || d.email)}`, `<p>${esc(d.message)}</p><p class="muted">${esc(d.email)} · interested in ${esc(d.plan_interest || 'unspecified')}</p>
      <div class="row">${pill(d.status)}${d.allowed_next.map((s) => `<button class="secondary" data-next="${esc(s)}">Mark ${esc(s)}</button>`).join('')}</div>
      <h3>Notes</h3>${d.notes.map((n) => `<p><span class="muted">${esc(when(n.created_at))}</span> ${esc(n.note)}</p>`).join('') || '<p class="muted">No notes.</p>'}<form id="note-add" class="row"><label>Add note<input name="note" required maxlength="2000"></label><button>Add</button></form>`);
    document.querySelectorAll('[data-next]').forEach((btn) => btn.addEventListener('click', async () => { try { await api(`/admin/sales-inquiries/${id}`, { method: 'PATCH', body: JSON.stringify({ status: btn.dataset.next }) }); await again(); } catch (e) { notice(describe(e)); } }));
    $('#note-add').addEventListener('submit', async (e) => { e.preventDefault(); try { await api(`/admin/sales-inquiries/${id}/notes`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); await again(); } catch (err) { notice(describe(err)); } });
  },
  async prices(b, again) {
    const rows = await api('/admin/billing/usage-prices'); const by = Object.fromEntries(rows.map((r) => [r.usage_feature, r]));
    b.innerHTML = panel('Pay-as-you-go prices', `<p class="muted">No price is published by default. A workspace is only ever billed beyond its plan when it opted in AND the price for that feature is active. Changing a price affects future usage only.</p>
      <table><thead><tr><th>Feature</th><th>Price per unit (cents)</th><th>Active</th><th></th></tr></thead><tbody>${['meeting_report', 'assistant_message', 'doc_generation'].map((f) => `<tr data-feature="${f}"><td>${esc(f.replace('_', ' '))}</td><td><input type="number" min="1" max="100000" value="${esc(by[f]?.unit_amount_cents ?? '')}" aria-label="Price in cents for ${esc(f)}"></td><td><input type="checkbox" ${by[f]?.active ? 'checked' : ''} aria-label="Active for ${esc(f)}"></td><td><button class="secondary">Save</button></td></tr>`).join('')}</tbody></table><p><button id="run-report" class="secondary">Invoice finished months now</button></p>`);
    b.querySelectorAll('tr[data-feature] button').forEach((btn) => btn.addEventListener('click', async () => { const tr = btn.closest('tr'); const cents = Number(tr.querySelector('input[type=number]').value); try { await api(`/admin/billing/usage-prices/${tr.dataset.feature}`, { method: 'PUT', body: JSON.stringify({ unit_amount_cents: cents, active: tr.querySelector('input[type=checkbox]').checked }) }); notice('Saved.'); await again(); } catch (e) { notice(describe(e)); } }));
    $('#run-report').addEventListener('click', async () => { try { const r = await api('/admin/billing/overage/report', { method: 'POST', body: '{}' }); notice(`${r.invoice_items_created} invoice item(s) created.`); } catch (e) { notice(describe(e)); } });
  },
  async switches(b, again) {
    const rows = await api('/admin/flags');
    b.innerHTML = panel('Kill switches', `<p class="muted">Turning a switch off takes effect within seconds on every replica. Background jobs pause (nothing is lost) and resume when it is turned back on.</p><table><thead><tr><th>Switch</th><th>State</th><th>Reason</th><th></th></tr></thead><tbody>${rows.map((f) => `<tr data-flag="${esc(f.key)}"><td><code>${esc(f.key)}</code></td><td>${f.enabled ? pill('active') + ' on' : pill('failed') + ' OFF'}</td><td>${esc(f.reason || '')}</td><td><button class="secondary">${f.enabled ? 'Turn off…' : 'Turn on'}</button></td></tr>`).join('')}</tbody></table>`);
    b.querySelectorAll('tr[data-flag] button').forEach((btn) => btn.addEventListener('click', async () => {
      const tr = btn.closest('tr'); const key = tr.dataset.flag; const turningOff = btn.textContent.startsWith('Turn off');
      const reason = turningOff ? prompt(`Why are you turning "${key}" off? (kept in the audit trail)`) : undefined; if (turningOff && !reason) return;
      try { await api(`/admin/flags/${key}`, { method: 'PUT', body: JSON.stringify({ enabled: !turningOff, reason: reason || undefined }) }); await again(); } catch (e) { notice(describe(e)); }
    }));
  }
};
