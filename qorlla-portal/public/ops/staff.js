import { el, api, uuid, fmt, why, shell, table } from './ops.js';
const S = '/api/v1/ops/staff';
let me = null;
const form = (fields, submit, label) => { const f = el('form', { class: 'row' }, [...fields, el('button', { type: 'submit', text: label })]); f.addEventListener('submit', (e) => { e.preventDefault(); submit(new FormData(f), f); }); return f; };
const input = (name, ph, extra = {}) => el('input', { name, placeholder: ph, 'aria-label': ph, required: true, ...extra });
const select = (name, opts) => el('select', { name, 'aria-label': name }, opts.map((o) => el('option', { value: o, text: o })));

const nav = {
  async 'My queue'(m, say) {
    const r = await api('GET', `${S}/tickets`); if (!r.ok) return say(why(r), true);
    m.append(el('h2', { text: 'Cases' }), r.data.items.length ? table([['Subject', (t) => t.subject], ['Status', (t) => t.status], ['Priority', (t) => t.priority], ['Category', (t) => t.category + (t.restricted ? ' (restricted)' : '')], ['Opened', (t) => fmt(t.created_at)]], r.data.items, (t) => open(t.id)) : el('p', { text: 'No cases in your queue.' }));
    async function open(id) {
      const d = await api('GET', `${S}/tickets/${id}`); if (!d.ok) return say(why(d), true); m.textContent = '';
      const t = d.data, back = el('button', { type: 'button', onclick: () => nav['My queue'](m = (m.textContent = '', m), say), text: '← Back' });
      m.append(back, el('h2', { text: t.subject }), el('p', { class: 'muted', text: `${t.status} · ${t.priority} · ${t.category}` }), el('p', { text: t.description }),
        el('h3', { text: 'Conversation' }), ...t.messages.map((x) => el('div', { class: 'msgbox ' + x.visibility }, [el('small', { text: `${x.author_kind} · ${x.visibility === 'internal' ? 'INTERNAL NOTE (customer cannot see)' : 'visible to customer'} · ${fmt(x.created_at)}` }), el('p', { text: x.body })])),
        form([el('textarea', { name: 'body', 'aria-label': 'Message', required: true, maxlength: 10000 }), select('visibility', ['internal', 'customer'])], async (f) => { const r = await api('POST', `${S}/tickets/${id}/messages`, { body: f.get('body'), visibility: f.get('visibility') }); if (!r.ok) return say(why(r), true); open(id); }, 'Send'),
        el('h3', { text: 'Actions' }), el('div', { class: 'row' }, [
          el('button', { type: 'button', text: 'Claim', onclick: async () => { const r = await api('POST', `${S}/tickets/${id}/claim`); say(r.ok ? 'Claimed.' : why(r), !r.ok); if (r.ok) open(id); } }),
          form([select('status', ['triaged', 'in_progress', 'waiting_customer', 'escalated', 'resolved', 'closed'])], async (f) => { const r = await api('POST', `${S}/tickets/${id}/status`, { status: f.get('status') }); say(r.ok ? 'Status updated.' : why(r), !r.ok); if (r.ok) open(id); }, 'Set status'),
          me.lead ? form([input('assignee_id', 'Assignee user id')], async (f) => { const r = await api('POST', `${S}/tickets/${id}/assign`, { assignee_id: f.get('assignee_id').trim() }); say(r.ok ? 'Assigned.' : why(r), !r.ok); if (r.ok) open(id); }, 'Assign') : null]),
        el('h3', { text: 'History' }), table([['Event', (e) => e.event_type], ['When', (e) => fmt(e.created_at)]], t.events));
    }
  },
  async Timesheet(m, say) {
    const r = await api('GET', `${S}/time-entries`); if (!r.ok) return say(why(r), true);
    m.append(el('h2', { text: 'Time clock' }), el('div', { class: 'row' }, [
      el('button', { type: 'button', text: 'Clock in', onclick: async () => { const x = await api('POST', `${S}/clock-in`); say(x.ok ? 'Clocked in.' : why(x), !x.ok); } }),
      el('button', { type: 'button', text: 'Clock out', onclick: async () => { const x = await api('POST', `${S}/clock-out`); say(x.ok ? 'Clocked out.' : why(x), !x.ok); } })]),
      table([['Started', (e) => fmt(e.started_at)], ['Ended', (e) => fmt(e.ended_at)], ['Approved', (e) => (e.approved_by ? 'yes' : 'no')]], r.data.items),
      me.lead ? el('p', { class: 'muted', text: 'Supervisors approve other people’s hours; nobody can approve their own.' }) : null);
  },
  async Leave(m, say) {
    const r = await api('GET', `${S}/leave`); if (!r.ok) return say(why(r), true);
    m.append(el('h2', { text: 'Leave' }), form([select('kind', ['vacation', 'sick', 'unpaid', 'other']), input('starts_on', 'Start', { type: 'date' }), input('ends_on', 'End', { type: 'date' })], async (f) => { const x = await api('POST', `${S}/leave`, { kind: f.get('kind'), starts_on: f.get('starts_on'), ends_on: f.get('ends_on') }); say(x.ok ? 'Requested.' : why(x), !x.ok); }, 'Request leave'),
      table([['Kind', (l) => l.kind], ['From', (l) => l.starts_on.slice(0, 10)], ['To', (l) => l.ends_on.slice(0, 10)], ['Status', (l) => l.status]], r.data.items, me.lead ? async (l) => { if (l.status !== 'pending') return; const x = await api('POST', `${S}/leave/${l.id}/approve`, {}); say(x.ok ? 'Approved.' : why(x), !x.ok); } : null));
  },
  async 'Billing requests'(m, say) {
    const r = await api('GET', `${S}/refunds`); if (!r.ok) return say(why(r), true);
    m.append(el('h2', { text: 'Refund requests' }), el('p', { class: 'muted', text: 'A refund needs a second person to approve it. Nothing is sent to the payment provider until then.' }),
      form([input('invoice_id', 'Invoice id'), input('amount_cents', 'Amount (cents)', { type: 'number', min: 1 }), input('reason', 'Reason')], async (f) => { const x = await api('POST', `${S}/refunds`, { invoice_id: f.get('invoice_id').trim(), amount_cents: Number(f.get('amount_cents')), reason: f.get('reason'), idempotency_key: uuid() }); say(x.ok ? 'Requested; waiting for approval.' : why(x), !x.ok); }, 'Request refund'),
      table([['Status', (x) => x.status], ['Amount', (x) => x.amount_cents], ['Reason', (x) => x.reason], ['Requested', (x) => fmt(x.created_at)]], r.data.items));
  },
  async Customers(m, say) {
    m.append(el('h2', { text: 'Customer lookup' }), el('p', { class: 'muted', text: 'Read-only. External calling, number issue and PSTN are controlled elsewhere and are not changed here.' }),
      form([input('id', 'Customer user id')], async (f, frm) => { const id = f.get('id').trim(), out = frm.nextElementSibling; out.textContent = '';
        const [c, n] = await Promise.all([api('GET', `${S}/customers/${id}/external-calling`), api('GET', `${S}/customers/${id}/number`)]);
        out.append(el('h3', { text: 'External calling' }), el('p', { text: c.ok ? (c.data.allowed ? 'Would be allowed (activation is not performed here).' : 'Not allowed: ' + c.data.reasons.join(', ')) : why(c) }), el('h3', { text: 'Number' }), el('p', { text: n.ok ? (n.data.assignment ? n.data.assignment.number + ' (' + n.data.assignment.country + ')' : 'No number assigned.') : why(n) })); }, 'Look up'), el('div', { class: 'out' }));
  },
  async 'Meeting diagnostics'(m, say) {
    m.append(el('h2', { text: 'Meeting diagnostics' }), el('p', { class: 'muted', text: 'Health only (state, participant count, signaling). You cannot join, listen to or act in a meeting from here.' }),
      form([input('id', 'Meeting id')], async (f, frm) => { const r = await api('GET', `${S}/meetings/${f.get('id').trim()}/diagnostics`), out = frm.nextElementSibling; out.textContent = r.ok ? `State: ${r.data.state} · participants: ${r.data.participants ?? 'unknown'} · signaling ${r.data.signalingHealthy ? 'healthy' : 'unhealthy'}` : why(r); }, 'Check'), el('p', { class: 'out' }));
  }
};
const w = await api('GET', `${S}/me`);
if (!w.ok) { document.body.textContent = ''; document.body.append(el('main', {}, [el('h1', { text: 'Qorlla Staff' }), el('p', { text: why(w) })])); } else { me = w.data; shell('Staff Operations', nav, me.role.replace(/_/g, ' ')); }
