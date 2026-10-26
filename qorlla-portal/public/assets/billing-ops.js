// Workspace billing operations UI: change plan (with preview), pending/scheduled change, usage and pay-as-you-go overage.
import { $, esc, api, notice, day, money, describe, panel } from './core.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
const KINDS = { upgrade: 'Upgrade', downgrade: 'Downgrade', seats: 'Seat change', interval: 'Billing-cycle change' };
const FEATURES = { meeting_report: 'AI meeting reports', assistant_message: 'QorllaMate messages', doc_generation: 'AI document drafts' };

export async function renderChangePlan(root, b, reload) {
  const sub = b.subscription;
  if (!b.can_manage || !sub || !['active', 'trialing'].includes(sub.status)) { root.innerHTML = ''; return; }
  if (!b.checkout_available) { root.innerHTML = panel('Change plan', '<p class="muted">Plan changes are not available until online billing is enabled for this deployment.</p>'); return; }
  const pending = (await api('/billing/pending-change').catch(() => ({ change: null }))).change;
  root.innerHTML = panel('Change plan', `${pending ? `<p class="warn" role="status" id="pending-change"><strong>${esc(KINDS[pending.kind])} to ${esc(pending.to_plan)}</strong> (${pending.to_interval === 'year' ? 'annual' : 'monthly'}, ${esc(pending.to_seats)} seat(s)) is ${pending.status === 'scheduled' ? `scheduled for ${esc(day(pending.effective_at))}` : 'waiting for the payment provider to confirm'}. ${pending.status === 'scheduled' ? '<button id="cancel-change" class="secondary">Cancel this change</button>' : ''}</p>` : ''}
    ${sub.cancel_at_period_end ? '<p class="muted">Your subscription is set to cancel at the end of the period; plan changes are unavailable.</p>' : `<form id="change-form" class="row"><label>Plan<select name="plan"><option value="pro" ${sub.plan === 'pro' ? 'selected' : ''}>Pro</option><option value="business" ${sub.plan === 'business' ? 'selected' : ''}>Business</option></select></label>
      <label>Billing<select name="interval"><option value="month" ${sub.interval === 'month' ? 'selected' : ''}>Monthly</option><option value="year" ${sub.interval === 'year' ? 'selected' : ''}>Annual</option></select></label>
      <label>Seats<input name="seats" type="number" min="1" max="1000" value="${esc(sub.seats)}" required></label><button type="button" id="preview-change" class="secondary">Preview</button><button ${pending ? 'disabled' : ''}>Change plan</button></form>
      <div id="change-preview" aria-live="polite"></div><p class="muted">Upgrades and added seats take effect now and the provider charges the prorated difference. Downgrades, fewer seats and billing-cycle changes take effect at the end of the current period.</p>`}`);
  const read = () => { const f = Object.fromEntries(new FormData($('#change-form'))); return { plan: f.plan, interval: f.interval, seats: Number(f.seats) }; };
  const explain = (e) => ({ no_change: 'That is already your plan.', too_many_members: `That plan allows ${e.body.limit} members; you have ${e.body.members}. Remove members first.`, payment_required: 'Fix the failed payment first.', change_pending: 'A change is already pending.', billing_unavailable: 'Billing is not available right now.', feature_disabled: 'Plan changes are temporarily switched off.', provider_error: 'The payment provider did not accept the change. Nothing was changed.' }[e.body?.code] || describe(e));
  $('#cancel-change')?.addEventListener('click', async () => { try { await api(`/billing/change-plan/${pending.id}`, { method: 'DELETE' }); notice('Scheduled change cancelled.'); await reload(); } catch (e) { notice(explain(e)); } });
  $('#preview-change')?.addEventListener('click', async () => {
    try { const p = await api('/billing/change-plan/preview', { method: 'POST', body: JSON.stringify(read()) });
      $('#change-preview').innerHTML = `<div class="card"><strong>${esc(KINDS[p.kind])}</strong> · ${p.immediate ? 'takes effect now' : `takes effect ${esc(day(p.effective_at))}`}<br>New price: ${esc(money(p.to.unit_amount_cents))} per seat per ${p.to.interval === 'year' ? 'year' : 'month'} × ${esc(p.to.seats)} = <strong>${esc(money(p.new_total_per_period_cents))}</strong>${p.proration_estimate_cents != null ? `<br>Estimated charge today: ${esc(money(Math.max(0, p.proration_estimate_cents)))} (the provider calculates the final amount)` : ''}<ul>${p.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>`; }
    catch (e) { notice(explain(e)); }
  });
  $('#change-form')?.addEventListener('submit', async (e) => {
    e.preventDefault(); const body = read(); if (!confirm('Change your plan now? ' + (body.plan === sub.plan && body.interval === sub.interval && body.seats < sub.seats ? 'The change applies at the end of the period.' : 'You may be charged a prorated amount.'))) return;
    try { const r = await api('/billing/change-plan', { method: 'POST', body: JSON.stringify({ ...body, idempotency_key: uid() }) });
      notice(r.status === 'applied' ? 'Your plan has been updated.' : r.status === 'scheduled' ? 'Change scheduled for the end of the current period.' : 'The provider accepted the change; it will apply once payment is confirmed.'); await reload(); }
    catch (err) { notice(explain(err)); }
  });
}

export async function renderUsage(root, b, reload) {
  if (!b.can_manage) { root.innerHTML = ''; return; }
  const u = await api('/billing/usage').catch(() => null); if (!u) { root.innerHTML = ''; return; }
  root.innerHTML = panel('AI usage this month', `<table><thead><tr><th>Feature</th><th>Used</th><th>Included</th><th>Pay-as-you-go</th></tr></thead><tbody>${u.features.map((f) => `<tr data-usage="${esc(f.feature)}"><td>${esc(FEATURES[f.feature])}</td><td>${esc(f.used)}</td><td>${f.quota == null ? 'unlimited' : esc(f.quota)}</td><td>${f.overage_units ? `${esc(f.overage_units)} extra · ${esc(money(f.overage_cents))}` : f.unit_amount_cents ? `${esc(money(f.unit_amount_cents))} each beyond plan` : '-'}</td></tr>`).join('')}</tbody></table>
    ${u.overage_possible || u.overage_enabled ? `<form id="overage-form"><label class="check"><input type="checkbox" name="enabled" ${u.overage_enabled ? 'checked' : ''}> Keep AI features running past my plan limits and charge me for the extra usage</label>
      ${u.overage_enabled ? '' : '<label class="check"><input type="checkbox" name="terms"> I understand extra usage is billed at the prices shown, added to my next invoice</label>'}<button>Save</button></form>` : `<p class="muted">${u.plan === 'basic' ? 'Pay-as-you-go usage needs a paid plan.' : 'Pay-as-you-go prices have not been published, so usage stops at your plan limits.'}</p>`}`);
  $('#overage-form')?.addEventListener('submit', async (e) => {
    e.preventDefault(); const enabled = e.target.elements.enabled.checked;
    try { await api('/billing/overage', { method: 'PUT', body: JSON.stringify({ enabled, accept_terms: !!e.target.elements.terms?.checked }) }); notice(enabled ? 'Pay-as-you-go usage enabled.' : 'Pay-as-you-go usage disabled.'); await reload(); }
    catch (err) { notice({ terms_required: 'Please confirm that you accept the extra charges.', paid_plan_required: 'Pay-as-you-go needs a paid plan.', no_usage_prices: 'Usage prices have not been published yet.' }[err.body?.code] || describe(err)); }
  });
}
