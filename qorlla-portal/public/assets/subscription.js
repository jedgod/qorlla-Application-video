// Settings -> Subscription & Billing: what the workspace's plan includes, what it does not, what is not offered at all, usage, renewal, and (only when live
// billing is on) the actions that change the subscription. Every value comes from the server (/api/v1/subscriptions/*); this file decides nothing about access.
import { esc, api, day, notice, describe, panel } from './core.js';

const GROUPS = [
  ['Meetings & calling', /^(meet|voice|phone)\./], ['Documents, Sheets & Slides', /^(docs|sheets|slides)\./], ['Clips & storage', /^(clips|storage)\./],
  ['Qorlla AI', /^ai\./], ['Organisation & analytics', /^(org|analytics)\./]
];
const PURCHASABLE = ['pro', 'business'];

// state -> [label, css class]. "restricted" = this plan does not include it; "unavailable" = no plan offers it (turned off for everyone), so it never gets an upgrade button.
// operator-facing notes in feature descriptions ("(allowance: AI Gateway ledger)") are not for customers
const plain = (d, k) => String(d || k).replace(/\s*\((allowance|policy)[^)]*\)/i, '');
const CHIP = { enabled: ['Included', 'ok'], restricted: ['Not in your plan', 'warn'], unavailable: ['Not available', 'off'], suspended: ['Suspended', 'off'] };

function featureRow(key, f, { live, canManage }) {
  const [label, cls] = CHIP[f.state] || CHIP.restricted;
  let action = '';
  if (f.state === 'restricted' && f.upgrade) {
    action = live && canManage ? '<button type="button" class="secondary small" data-upgrade>Upgrade</button>' : '<span class="muted">Available on a higher plan</span>';
  } else if (f.state === 'unavailable') action = '<span class="muted">Not offered on any plan</span>';
  else if (f.state === 'suspended') action = '<span class="muted">Workspace suspended</span>';
  const limit = f.state === 'enabled' && f.quota !== null && f.quota !== undefined ? `<span class="muted"> · limit ${esc(f.quota)}${f.used !== undefined ? ` (used ${esc(f.used)})` : ''}</span>` : '';
  return `<li data-feature="${esc(key)}" data-state="${esc(f.state)}"><span class="fname">${esc(plain(f.description, key))}${limit}</span><span class="chip ${cls}">${esc(label)}</span>${action}</li>`;
}

export async function renderSubscription(root, { b, redraw }) {
  const [cur, ent, plans, usage] = await Promise.all([api('/subscriptions/current'), api('/subscriptions/entitlements'), api('/subscriptions/plans'), api('/subscriptions/usage').catch(() => ({ usage: [] }))]);
  const live = !!cur.billing?.live, canManage = !!cur.billing?.canManage, sub = cur.subscription;
  const ctx = { live, canManage };
  const checkout = async (plan) => {
    if (!confirm(`Continue to the secure payment page for the ${plan} plan? Nothing changes until the payment provider confirms your payment.`)) return;
    try { const r = await api('/subscriptions/checkout', { method: 'POST', body: JSON.stringify({ plan, interval: 'month', seats: 1 }) }); if (/^https:\/\//.test(r.url || '')) location.href = r.url; else notice('Checkout could not be started.'); }
    catch (e) { notice(e.body?.code === 'feature_disabled' || e.status === 503 ? 'Online billing is not available right now.' : describe(e)); }
  };

  let html = '';
  if (cur.suspended) html += '<p class="warn" role="status" id="suspended-note">This workspace is suspended. Plan features are unavailable until the suspension is lifted; contact support.</p>';
  if (!live) html += '<p class="muted" id="billing-off" role="status">Live billing is not enabled for this deployment. You can review your plan, access and usage here; checkout and payment management are unavailable.</p>';

  // ---- renewal
  const renew = [];
  if (sub?.status === 'trialing') renew.push(`<p>Trial · ends ${esc(day(sub.renewsOrEndsAt))}</p>`);
  else if (sub?.renewsOrEndsAt) renew.push(`<p>${sub.cancelAtPeriodEnd ? `<strong>Cancels on ${esc(day(sub.renewsOrEndsAt))}</strong> · you keep your plan until then` : `Renews ${esc(day(sub.renewsOrEndsAt))}`}</p>`);
  if (sub?.status === 'past_due') renew.push('<p class="warn">Your last payment failed. The provider is retrying; your plan stays active for a short grace period.</p>');
  if (sub?.cancelAtPeriodEnd && live && canManage) renew.push('<div class="row"><button type="button" id="resume" class="secondary">Keep my subscription</button></div>');
  if (renew.length) html += panel('Renewal', renew.join(''));

  // ---- available plans
  const mine = cur.plan;
  html += panel('Available plans', `<div class="cards" id="plan-cards">${plans.plans.map((p) => {
    const included = Object.values(p.features).filter((f) => f.enabled).length;
    const action = p.slug === mine ? '<span class="pill active">Current plan</span>'
      : p.contact_sales ? '<a class="button secondary small" href="/pricing/">Contact sales</a>'
      : PURCHASABLE.includes(p.slug) && live && canManage && !cur.suspended ? `<button type="button" class="small" data-choose="${esc(p.slug)}">Choose ${esc(p.name)}</button>`
      : PURCHASABLE.includes(p.slug) ? '<a class="button secondary small" href="/pricing/">See pricing</a>' : '';
    return `<article class="card" data-plan="${esc(p.slug)}"><h3>${esc(p.name)}</h3><p>${esc(p.description)}</p><p class="muted">${included} features included</p>${action}</article>`;
  }).join('')}</div>`);

  // ---- features and access
  const entries = Object.entries(ent.features);
  html += panel('What your plan includes', GROUPS.map(([title, re]) => {
    const rows = entries.filter(([k]) => re.test(k)); if (!rows.length) return '';
    return `<h3>${esc(title)}</h3><ul class="features">${rows.map(([k, f]) => featureRow(k, f, ctx)).join('')}</ul>`;
  }).join('') + '<p class="muted">Having a feature in your plan is necessary but not sufficient: your role, document permissions, meeting consent and AI policy still apply.</p>');

  // ---- usage this month (limits are shown only when they are enforced)
  html += panel('Usage this month', usage.usage.length ? `<table id="usage-table"><thead><tr><th>Feature</th><th>Used</th><th>Limit</th></tr></thead><tbody>${usage.usage.map((u) => {
    const pct = u.quota ? Math.min(100, Math.round((u.used / u.quota) * 100)) : 0;
    return `<tr data-usage-feature="${esc(u.feature)}"><td>${esc(plain(u.description, u.feature))}</td><td>${esc(u.used)}</td><td>${u.limitStatus === 'enforced' ? `${esc(u.quota)} <span class="meter" aria-hidden="true"><i style="width:${pct}%"></i></span>` : '<span class="muted">No limit applied</span>'}</td></tr>`;
  }).join('')}</tbody></table>` : '<div class="empty">Nothing used yet this month.</div>');

  // ---- payment methods: the provider's hosted portal. A button exists only when it can work; otherwise the page says why it is unavailable.
  const hasCustomer = !!cur.billing?.hasBillingCustomer;
  let pm;
  if (!live) pm = '<p id="pm-unavailable" class="muted"><strong>Payment management unavailable.</strong> Live billing is not enabled for this deployment.</p>';
  else if (!canManage) pm = '<p id="pm-unavailable" class="muted"><strong>Payment management unavailable to you.</strong> Only owners, admins and billing contacts can manage payment methods.</p>';
  else if (cur.suspended) pm = '<p id="pm-unavailable" class="muted"><strong>Payment management unavailable</strong> while the workspace is suspended.</p>';
  else if (!hasCustomer) pm = '<p id="pm-unavailable" class="muted"><strong>No payment method on file yet.</strong> A payment profile is created when you purchase a plan.</p>';
  else pm = '<div class="row"><button type="button" id="manage-payment" class="secondary">Manage payment methods</button></div><p class="muted">You will be taken to the secure page of your payment provider and brought back here afterwards.</p>';
  html += panel('Payment methods', `<p class="muted">Card details are entered and stored only by the payment provider; Qorlla never sees or stores them.</p>${pm}`);

  root.innerHTML = html;
  root.querySelector('#resume')?.addEventListener('click', async () => { try { await api('/subscriptions/resume', { method: 'POST', body: '{}' }); notice('Your subscription will continue to renew.'); await redraw(); } catch (e) { notice(describe(e)); } });
  root.querySelector('#manage-payment')?.addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    try { const r = await api('/subscriptions/payment-methods', { method: 'POST', body: '{}' }); if (/^https:\/\//.test(r.url || '')) location.href = r.url; else { notice('The payment portal could not be opened.'); ev.target.disabled = false; } }
    catch (e) { notice(e.body?.code === 'no_billing_customer' ? 'There is no payment method on file yet.' : e.status === 503 ? 'Payment management is not available right now.' : describe(e)); ev.target.disabled = false; }
  });
  root.querySelectorAll('[data-choose]').forEach((btn) => btn.addEventListener('click', () => checkout(btn.dataset.choose)));
  root.querySelectorAll('[data-upgrade]').forEach((btn) => btn.addEventListener('click', () => checkout(PURCHASABLE.find((s) => s !== mine) || 'pro')));
}
