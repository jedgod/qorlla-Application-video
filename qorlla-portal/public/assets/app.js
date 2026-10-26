// Qorlla Workplace portal (browser). Identity comes from MAIN's cookies; this file never stores tokens in JavaScript-visible storage.
import { $, esc, money, day, cookie, notice, ApiError, api, heading, panel, describe } from './core.js';
import { renderAiDashboard, renderReport } from './ai.js';
import { renderPhone, renderReceptionist } from './phone.js';
import { renderNotes, renderMate, renderSuite } from './workspace.js';
import { renderChangePlan, renderUsage } from './billing-ops.js';
import { renderAdmin } from './admin.js';
const state = { me: null, workspace: null, role: null, signedIn: null };
const modules = [
  ['products', '📦', 'Products', 'Explore all Qorlla applications and workplace tools.'],
  ['meet', '📹', 'Meet', 'Host, schedule and join secure meetings.'],
  ['receptionist', '🎧', 'AI Receptionist', 'Manage incoming calls, business hours, intelligent routing and appointments.'],
  ['phone', '📞', 'Phone', 'Business dialer, numbers, extensions, voicemail and call history.'],
  ['notes', '📝', 'My Notes', 'Create notes, review meeting summaries and organize your knowledge.'],
  ['mate', '🤖', 'QorllaMate', 'Your AI companion for meeting preparation and workplace tasks.'],
  ['suite', '✨', 'AI Productivity Suite', 'Docs, Sheets, Slides, Paper and shared team workspaces.'],
  ['ai', '🧠', 'AI Meeting Intelligence', 'Transcription, summaries, action items and report sharing.'],
  ['solutions', '🏢', 'Solutions', 'Qorlla solutions for education, business, healthcare and events.'],
  ['support', '🛟', 'Support', 'Help center, service requests and technical assistance.']
];
const signInUrl = () => '/login.html?next=' + encodeURIComponent(location.pathname + location.search);

const card = (m) => `<article class="card"><div class="emoji" aria-hidden="true">${m[1]}</div><h3>${esc(m[2])}</h3><p>${esc(m[3])}</p><a class="link" href="/app/${m[0]}">Explore ${esc(m[2])} →</a></article>`;
const tiles = (items) => `<div class="cards">${items.map(([a, b]) => `<article class="card"><h3>${esc(a)}</h3><p>${esc(b)}</p><span class="pill">Provider integration pending</span></article>`).join('')}</div>`;
const signInPrompt = () => panel('Sign in required', `<p>Please sign in with your Qorlla account to use this page.</p><a class="button" href="${esc(signInUrl())}">Sign in</a>`);
const onboarding = () => panel('Create your workspace', `<p>You are signed in as a Qorlla user, but you do not belong to a workspace yet. Create one to start (you will be its owner on the free Basic plan).</p><form id="ws-form"><label>Workspace name<input name="name" maxlength="120" value="My workspace" required></label><button>Create workspace</button></form>`);

const routes = {
  products: () => heading('All Products', 'One workspace for communication, meetings, intelligent collaboration and productivity.', '📦') + `<div class="cards">${modules.filter((m) => !['products', 'solutions', 'support'].includes(m[0])).map(card).join('')}</div>`,
  meet: () => heading('Qorlla Meet', 'Schedule and host meetings, manage recordings, review reports and collaborate securely.', '📹') + panel('Open Qorlla Meet', '<p>Meetings run on the Qorlla Meet service. Scheduled meetings are created from your Qorlla home page.</p><a class="button" href="/meet/">Open Meet</a> <a class="button secondary" href="/qorlla.html">Schedule from Home</a>'),
  receptionist: () => heading('AI Receptionist', 'An intelligent front desk for your organization.', '🎧') + '<div id="receptionist-root"></div>',
  phone: () => heading('Qorlla Phone', 'Business calling and telephony management.', '📞') + '<div id="phone-root"></div>',
  mate: () => heading('QorllaMate', 'An AI assistant for your workplace.', '🤖') + '<div id="mate-root"></div>',
  suite: () => heading('AI Productivity Suite', 'Create, organize and collaborate in a single workspace.', '✨') + '<div id="suite-root"></div>',
  ai: () => heading('AI Meeting Intelligence', 'Consent-based summaries, decisions and action items from your meetings.', '🧠') + '<div id="ai-root"></div>',
  solutions: () => heading('Solutions for Every Team', 'Purpose-built workflows across organizations.', '🏢') + tiles([['Education', 'Classes, tutoring and office hours'], ['Healthcare', 'Administrative communication and scheduling'], ['Small Business', 'Customer engagement and meetings'], ['Enterprise', 'Security, governance and scale'], ['Events', 'Webinars, registration and reporting'], ['Remote Teams', 'Async collaboration and meetings']]),
  support: () => heading('Support Center', 'Get help, report problems and track requests.', '🛟') + `<div class="cards">${[['Help Center', 'Documentation and troubleshooting'], ['Technical Diagnostics', 'Browser, connection and meeting checks'], ['Billing Support', 'Plan, invoice and payment questions']].map(([a, b]) => `<article class="card"><h3>${a}</h3><p>${b}</p></article>`).join('')}</div>` +
    panel('Create support ticket', '<form id="ticket-form"><label>Subject<input name="subject" required minlength="3" maxlength="160"></label><label>Describe the issue<textarea name="details" required minlength="5"></textarea></label><button>Submit Ticket</button></form>') + panel('Your tickets', '<div id="tickets" class="empty">Loading…</div>'),
  notes: () => heading('My Notes', 'Capture ideas, meeting takeaways and workplace knowledge.', '📝') + '<div id="notes-root"></div>',
  billing: () => heading('Plans & Billing', 'Your plan, subscription status, invoices and receipts.', '💳') + '<div id="billing" class="empty">Loading…</div>',
  admin: () => heading('Platform admin', 'Billing operations, sales leads and launch controls.', '🛡️') + '<div id="admin-root"></div>',
  team: () => heading('Team', 'People in this workspace and what they can do.', '👥') + '<div id="team" class="empty">Loading…</div>'
};

async function list(path, sel, format, empty = 'No records yet.') {
  try { const items = await api(path); $(sel).className = ''; $(sel).innerHTML = items.length ? items.map(format).join('') : `<div class="empty">${esc(empty)}</div>`; return items; }
  catch (e) { $(sel).className = 'empty'; $(sel).textContent = e.message; return []; }
}


async function renderSupport() {
  const draw = (x) => `<article class="card"><h3>${esc(x.subject)}</h3><p>${esc(x.details)}</p><span class="pill">${esc(x.status)}</span></article>`;
  await list('/support/tickets', '#tickets', draw, 'No tickets yet.');
  $('#ticket-form').onsubmit = async (e) => { e.preventDefault(); try { await api('/support/tickets', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); notice('Ticket created.'); e.target.reset(); await list('/support/tickets', '#tickets', draw); } catch (err) { notice(describe(err)); } };
}
async function renderBilling() {
  const root = $('#billing');
  const justPaid = new URLSearchParams(location.search).get('checkout') === 'success';
  const draw = async () => {
    const [b, inv] = await Promise.all([api('/billing'), api('/billing/invoices').catch(() => [])]);
    const sub = b.subscription;
    root.className = '';
    root.innerHTML =
      panel('Current plan', `<p><strong>${esc(b.plan)}</strong>${sub ? ` · ${esc(sub.status)} · billed ${sub.interval === 'year' ? 'annually' : 'monthly'} · ${esc(sub.seats)} seat(s)` : ' · free'}</p>` +
        (sub?.current_period_end ? `<p class="muted">Current period ends ${esc(day(sub.current_period_end))}${sub.cancel_at_period_end ? ' · <strong>cancels at period end</strong>' : ''}</p>` : '') +
        (sub?.status === 'past_due' ? '<p class="warn">Your last payment failed. We are retrying; update your payment method with your provider to keep your plan.</p>' : '') +
        `<div class="row"><a class="button" href="/pricing/">View plans</a>${b.can_manage && sub && ['active', 'trialing', 'past_due'].includes(sub.status) && !sub.cancel_at_period_end ? '<button id="cancel" class="secondary">Cancel at period end</button>' : ''}${b.can_manage && sub ? '<button id="reconcile" class="secondary">Refresh from payment provider</button>' : ''}</div>` +
        (!b.checkout_available ? '<p class="muted">Online checkout is not enabled for this deployment yet.</p>' : '')) +
      panel('Invoices & receipts', b.can_manage ? (inv.length ? `<table><thead><tr><th>Date</th><th>Number</th><th>Status</th><th>Amount</th><th>Receipt</th></tr></thead><tbody>${inv.map((i) => `<tr><td>${esc(day(i.created_at))}</td><td>${esc(i.number || '-')}</td><td>${esc(i.status.replace('_', ' '))}</td><td>${esc(money(i.amount_paid_cents || i.amount_due_cents, i.currency))}${i.amount_refunded_cents ? ` <span class="muted">(refunded ${esc(money(i.amount_refunded_cents, i.currency))})</span>` : ''}</td><td>${i.hosted_invoice_url && /^https:\/\//.test(i.hosted_invoice_url) ? `<a class="link" href="${esc(i.hosted_invoice_url)}" rel="noopener noreferrer">View</a>` : '-'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No invoices yet.</div>') : '<p class="muted">Only owners, admins and billing contacts can see invoices.</p>');
    root.insertAdjacentHTML('beforeend', '<div id="plan-change"></div><div id="usage-panel"></div>');
    await renderChangePlan($('#plan-change'), b, draw).catch((e) => notice(describe(e)));
    await renderUsage($('#usage-panel'), b, draw).catch((e) => notice(describe(e)));
    const act = async (fn, msg) => { try { await fn(); notice(msg); await draw(); } catch (e) { notice(describe(e)); } };
    $('#cancel')?.addEventListener('click', () => confirm('Cancel at the end of the current period? You keep your plan until then.') && act(() => api('/billing/cancel', { method: 'POST', body: '{}' }), 'Cancellation requested. Your plan stays active until the period ends.'));
    $('#reconcile')?.addEventListener('click', () => act(() => api('/billing/reconcile', { method: 'POST', body: '{}' }), 'Refreshed from the payment provider.'));
    return b;
  };
  let b = await draw();
  if (justPaid) {
    // Returning from the provider proves nothing. Show the truth and wait for the server-side confirmation (signed webhook).
    notice('Thanks! We are confirming your payment with the provider. Your plan updates here only after it is confirmed.');
    for (let i = 0; i < 20 && b.plan === 'basic'; i++) { await new Promise((r) => setTimeout(r, 3000)); b = await draw(); }
    notice(b.plan !== 'basic' ? `Payment confirmed. You are now on the ${b.plan} plan.` : 'Still waiting for the provider to confirm the payment. This page will show your plan as soon as it does; nothing has been charged to your plan until then.');
  }
}
async function renderTeam() {
  const root = $('#team');
  const draw = async () => {
    const [mem, ws] = await Promise.all([api('/members'), api('/workspace')]);
    const manage = ['owner', 'admin'].includes(ws.role);
    root.className = '';
    root.innerHTML = panel(`${ws.name} · ${ws.plan} plan`, `<table><thead><tr><th>Member</th><th>Role</th></tr></thead><tbody>${mem.map((m) => `<tr><td><code>${esc(m.user_id)}</code></td><td>${esc(m.role)}</td></tr>`).join('')}</tbody></table>`) +
      (manage ? panel('Add a member', '<p class="muted">Use the person\'s Qorlla account id (shown on their profile).</p><form id="member-form"><label>Account id<input name="user_id" required pattern="[0-9a-fA-F-]{36}"></label><label>Role<select name="role"><option>member</option><option>billing</option><option>admin</option></select></label><button>Add member</button></form>') : '');
    $('#member-form')?.addEventListener('submit', async (e) => { e.preventDefault(); try { await api('/members', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); notice('Member added.'); await draw(); } catch (err) { notice(describe(err)); } });
  };
  await draw();
}

async function boot() {
  const parts = location.pathname.split('/'); const slug = parts[2] || 'products';
  $('#side').innerHTML = modules.filter((m) => !['products', 'ai', 'solutions', 'support', 'meet'].includes(m[0])).map((m) => `<a class="${slug === m[0] ? 'active' : ''}" ${slug === m[0] ? 'aria-current="page"' : ''} href="/app/${m[0]}"><span aria-hidden="true">${m[1]}</span> ${esc(m[2])}</a>`).join('');
  document.title = (modules.find((m) => m[0] === slug)?.[2] || { billing: 'Plans & Billing', team: 'Team', admin: 'Platform admin' }[slug] || 'Workplace') + ' | Qorlla';
  $('#page').innerHTML = (routes[slug] || routes.products)();

  // who am I?
  try { state.me = await api('/me'); state.signedIn = true; } catch (e) { state.signedIn = e.status === 401 ? false : null; }
  const who = $('#who');
  if (state.signedIn) { who.innerHTML = '<button id="signout" class="linkbtn">Sign out</button>'; $('#signout').onclick = async () => { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); location.href = '/login.html'; }; }
  else who.innerHTML = `<a class="button small" href="${esc(signInUrl())}">Sign in</a>`;

  const privateRoute = ['notes', 'support', 'billing', 'team', 'phone', 'receptionist', 'mate', 'suite', 'admin'].includes(slug) || slug === 'ai';
  if (!privateRoute) return;
  if (state.signedIn === false) { $('#page').innerHTML = heading('Sign in', 'This page is private to your workspace.', '🔒') + signInPrompt(); return; }
  if (state.signedIn === null) { notice('The service is temporarily unavailable. Please try again shortly.'); return; }
  if (state.me.platform_admin) $('#side').insertAdjacentHTML('beforeend', `<a class="${slug === 'admin' ? 'active' : ''}" href="/app/admin"><span aria-hidden="true">🛡️</span> Platform admin</a>`);
  if (slug === 'admin') { try { await renderAdmin($('#admin-root')); } catch (e) { $('#admin-root').innerHTML = `<div class="empty">${esc(e.status === 404 ? 'Not found.' : describe(e))}</div>`; } return; }   // the console needs no workspace
  if (!state.me.workspaces.length) {
    $('#page').innerHTML = heading('Welcome', 'Let us set up your workspace.', '👋') + onboarding();
    $('#ws-form').onsubmit = async (e) => { e.preventDefault(); try { await api('/workspaces', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); location.reload(); } catch (err) { notice(describe(err)); } };
    return;
  }
  const role = state.me.workspaces[0]?.role;
  if (slug === 'phone') { try { await renderPhone($('#phone-root'), { role }); } catch (e) { $('#phone-root').innerHTML = `<div class="empty">${esc(describe(e))}</div>`; } }
  if (slug === 'receptionist') { try { await renderReceptionist($('#receptionist-root'), { role }); } catch (e) { $('#receptionist-root').innerHTML = `<div class="empty">${esc(describe(e))}</div>`; } }
  if (slug === 'notes') { try { await renderNotes(); } catch (e) { $('#notes-root').innerHTML = `<div class="empty">${esc(describe(e))}</div>`; } }
  if (slug === 'mate') { try { await renderMate($('#mate-root')); } catch (e) { $('#mate-root').innerHTML = `<div class="empty">${esc(describe(e))}</div>`; } }
  if (slug === 'suite') { try { await renderSuite($('#suite-root')); } catch (e) { $('#suite-root').innerHTML = `<div class="empty">${esc(describe(e))}</div>`; } }
  if (slug === 'support') await renderSupport();
  if (slug === 'billing') await renderBilling();
  if (slug === 'team') await renderTeam();
  if (slug === 'ai' && parts[3] === 'reports' && parts[4]) { $('#page').innerHTML = ''; const root = document.createElement('div'); $('#page').append(root); await renderReport(root, parts[4]); }
  else if (slug === 'ai') { try { await renderAiDashboard($('#ai-root')); } catch (e) { $('#ai-root').innerHTML = `<div class="empty">${esc(describe(e))}</div>`; } }
}
boot();
