// Qorlla Workplace portal (browser). Identity comes from MAIN's cookies; this file never stores tokens in JavaScript-visible storage.
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
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, cur = 'usd') => new Intl.NumberFormat(undefined, { style: 'currency', currency: cur.toUpperCase() }).format(cents / 100);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '-');
const cookie = (n) => decodeURIComponent((document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]+)')) || [])[1] || '');
const state = { me: null, workspace: null, role: null, signedIn: null };
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
const signInUrl = () => '/login.html?next=' + encodeURIComponent(location.pathname + location.search);

const card = (m) => `<article class="card"><div class="emoji" aria-hidden="true">${m[1]}</div><h3>${esc(m[2])}</h3><p>${esc(m[3])}</p><a class="link" href="/app/${m[0]}">Explore ${esc(m[2])} →</a></article>`;
const heading = (title, sub, icon = '✦') => `<div class="hero"><div><div class="eyebrow">Qorlla Workplace</div><h1>${esc(title)}</h1><p>${esc(sub)}</p></div><div class="symbol" aria-hidden="true">${icon}</div></div>`;
const panel = (title, body) => `<section class="panel"><h2>${esc(title)}</h2>${body}</section>`;
const tiles = (items) => `<div class="cards">${items.map(([a, b]) => `<article class="card"><h3>${esc(a)}</h3><p>${esc(b)}</p><span class="pill">Provider integration pending</span></article>`).join('')}</div>`;
const signInPrompt = () => panel('Sign in required', `<p>Please sign in with your Qorlla account to use this page.</p><a class="button" href="${esc(signInUrl())}">Sign in</a>`);
const onboarding = () => panel('Create your workspace', `<p>You are signed in as a Qorlla user, but you do not belong to a workspace yet. Create one to start (you will be its owner on the free Basic plan).</p><form id="ws-form"><label>Workspace name<input name="name" maxlength="120" value="My workspace" required></label><button>Create workspace</button></form>`);

const routes = {
  products: () => heading('All Products', 'One workspace for communication, meetings, intelligent collaboration and productivity.', '📦') + `<div class="cards">${modules.filter((m) => !['products', 'solutions', 'support'].includes(m[0])).map(card).join('')}</div>`,
  meet: () => heading('Qorlla Meet', 'Schedule and host meetings, manage recordings, review reports and collaborate securely.', '📹') + panel('Open Qorlla Meet', '<p>Meetings run on the Qorlla Meet service. Scheduled meetings are created from your Qorlla home page.</p><a class="button" href="/meet/">Open Meet</a> <a class="button secondary" href="/qorlla.html">Schedule from Home</a>'),
  receptionist: () => heading('AI Receptionist', 'An intelligent front desk for your organization.', '🎧') + tiles([['Incoming Calls', 'Call log, summaries and caller identification'], ['Call Routing', 'Teams, departments and escalation'], ['Appointment Scheduling', 'Calendar integration and reminders'], ['Receptionist Voice', 'Voice and language configuration'], ['Knowledge Base', 'Approved answers to common questions'], ['Analytics', 'Call volume and handoff metrics']]),
  phone: () => heading('Qorlla Phone', 'Business calling and telephony management.', '📞') + tiles([['Dialer', 'Make and receive business calls'], ['Numbers', 'Manage assigned business phone numbers'], ['Voicemail', 'Messages, transcripts and notifications'], ['Extensions', 'Teams, queues and call forwarding'], ['Call History', 'Audit inbound and outbound calls'], ['Settings', 'Working hours, devices and routing']]),
  mate: () => heading('QorllaMate', 'An AI assistant for your workplace.', '🤖') + tiles([['Ask QorllaMate', 'Workspace-aware AI conversations'], ['Meeting Prep', 'Agendas and background briefs'], ['Task Planner', 'Action items and follow-ups'], ['Workflow Approvals', 'Review actions before execution'], ['Knowledge Search', 'Search authorized documents'], ['Assistant History', 'Saved sessions and conversations']]),
  suite: () => heading('AI Productivity Suite', 'Create, organize and collaborate in a single workspace.', '✨') + tiles([['Qorlla Docs', 'Rich text documents and coauthoring'], ['Qorlla Sheets', 'Spreadsheets and analysis'], ['Qorlla Slides', 'Presentation builder'], ['Qorlla Paper', 'Research and long-form writing'], ['Shared Files', 'Team folders and permissions'], ['Templates', 'Ready-to-use productivity templates']]),
  ai: () => heading('AI Meeting Intelligence', 'Turn authorized meetings into searchable knowledge and shareable reports.', '🧠') + tiles([['Transcription', 'Consent-aware speaker transcripts'], ['Smart Summaries', 'Decisions and key discussion points'], ['Action Items', 'Owners, deadlines and follow-up'], ['Meeting Reports', 'Browse and export reports'], ['Secure Sharing', 'Controlled, revocable report access'], ['Usage & Fees', 'Metered AI features and invoices']]) + '<div id="reports"></div>',
  solutions: () => heading('Solutions for Every Team', 'Purpose-built workflows across organizations.', '🏢') + tiles([['Education', 'Classes, tutoring and office hours'], ['Healthcare', 'Administrative communication and scheduling'], ['Small Business', 'Customer engagement and meetings'], ['Enterprise', 'Security, governance and scale'], ['Events', 'Webinars, registration and reporting'], ['Remote Teams', 'Async collaboration and meetings']]),
  support: () => heading('Support Center', 'Get help, report problems and track requests.', '🛟') + `<div class="cards">${[['Help Center', 'Documentation and troubleshooting'], ['Technical Diagnostics', 'Browser, connection and meeting checks'], ['Billing Support', 'Plan, invoice and payment questions']].map(([a, b]) => `<article class="card"><h3>${a}</h3><p>${b}</p></article>`).join('')}</div>` +
    panel('Create support ticket', '<form id="ticket-form"><label>Subject<input name="subject" required minlength="3" maxlength="160"></label><label>Describe the issue<textarea name="details" required minlength="5"></textarea></label><button>Submit Ticket</button></form>') + panel('Your tickets', '<div id="tickets" class="empty">Loading…</div>'),
  notes: () => heading('My Notes', 'Capture ideas, meeting takeaways and workplace knowledge.', '📝') + panel('New note', '<p id="note-quota" class="muted"></p><form id="note-form"><label>Title<input name="title" required maxlength="160"></label><label>Content<textarea name="body"></textarea></label><button>Save Note</button></form>') + panel('Recent notes', '<div id="notes" class="empty">Loading…</div>'),
  billing: () => heading('Plans & Billing', 'Your plan, subscription status, invoices and receipts.', '💳') + '<div id="billing" class="empty">Loading…</div>',
  team: () => heading('Team', 'People in this workspace and what they can do.', '👥') + '<div id="team" class="empty">Loading…</div>'
};

async function list(path, sel, format, empty = 'No records yet.') {
  try { const items = await api(path); $(sel).className = ''; $(sel).innerHTML = items.length ? items.map(format).join('') : `<div class="empty">${esc(empty)}</div>`; return items; }
  catch (e) { $(sel).className = 'empty'; $(sel).textContent = e.message; return []; }
}
function describe(e) {
  if (e.status === 402) return `Your ${e.body.plan} plan allows ${e.body.limit} for this. Upgrade on the pricing page to add more.`;
  if (e.status === 403) return 'You do not have permission to do that in this workspace.';
  return e.message;
}

async function renderNotes() {
  const draw = (x) => `<article class="card"><h3>${esc(x.title)}</h3><p>${esc(x.body)}</p><span class="muted">${esc(new Date(x.created_at).toLocaleString())}</span></article>`;
  const refresh = async () => {
    const items = await list('/notes', '#notes', draw, 'No notes yet.');
    try { const q = (await api('/entitlements')).features['notes.max']; $('#note-quota').textContent = q.unlimited ? 'Unlimited notes on your plan.' : `${items.length} of ${q.quota} notes used on your plan.`; } catch { /* quota text is optional */ }
  };
  await refresh();
  $('#note-form').onsubmit = async (e) => { e.preventDefault(); try { await api('/notes', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); notice('Note saved.'); e.target.reset(); await refresh(); } catch (err) { notice(describe(err)); } };
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
  const slug = location.pathname.split('/')[2] || 'products';
  $('#side').innerHTML = modules.filter((m) => !['products', 'ai', 'solutions', 'support', 'meet'].includes(m[0])).map((m) => `<a class="${slug === m[0] ? 'active' : ''}" ${slug === m[0] ? 'aria-current="page"' : ''} href="/app/${m[0]}"><span aria-hidden="true">${m[1]}</span> ${esc(m[2])}</a>`).join('');
  document.title = (modules.find((m) => m[0] === slug)?.[2] || { billing: 'Plans & Billing', team: 'Team' }[slug] || 'Workplace') + ' | Qorlla';
  $('#page').innerHTML = (routes[slug] || routes.products)();

  // who am I?
  try { state.me = await api('/me'); state.signedIn = true; } catch (e) { state.signedIn = e.status === 401 ? false : null; }
  const who = $('#who');
  if (state.signedIn) { who.innerHTML = '<button id="signout" class="linkbtn">Sign out</button>'; $('#signout').onclick = async () => { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); location.href = '/login.html'; }; }
  else who.innerHTML = `<a class="button small" href="${esc(signInUrl())}">Sign in</a>`;

  const privateRoute = ['notes', 'support', 'billing', 'team'].includes(slug) || slug === 'ai';
  if (!privateRoute) return;
  if (state.signedIn === false) { $('#page').innerHTML = heading('Sign in', 'This page is private to your workspace.', '🔒') + signInPrompt(); return; }
  if (state.signedIn === null) { notice('The service is temporarily unavailable. Please try again shortly.'); return; }
  if (!state.me.workspaces.length) {
    $('#page').innerHTML = heading('Welcome', 'Let us set up your workspace.', '👋') + onboarding();
    $('#ws-form').onsubmit = async (e) => { e.preventDefault(); try { await api('/workspaces', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); location.reload(); } catch (err) { notice(describe(err)); } };
    return;
  }
  if (slug === 'notes') await renderNotes();
  if (slug === 'support') await renderSupport();
  if (slug === 'billing') await renderBilling();
  if (slug === 'team') await renderTeam();
  if (slug === 'ai') await list('/reports', '#reports', (x) => `<article class="card"><h3>${esc(x.title)}</h3><p>${esc(x.summary)}</p></article>`, 'No meeting reports yet.');
}
boot();
