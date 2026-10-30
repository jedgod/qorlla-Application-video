import { el, api, uuid, fmt, why, shell, table } from './ops.js';
const A = '/api/v1/ops/admin';
const form = (fields, submit, label) => { const f = el('form', { class: 'row' }, [...fields, el('button', { type: 'submit', text: label })]); f.addEventListener('submit', (e) => { e.preventDefault(); submit(new FormData(f), f); }); return f; };
const input = (name, ph, extra = {}) => el('input', { name, placeholder: ph, 'aria-label': ph, required: true, ...extra });
const ROLES = ['support_agent', 'billing_agent', 'technical_agent', 'supervisor', 'ops_admin', 'super_admin'];
const PERMS = ['ticket:read', 'ticket:work', 'billing:refund:request', 'numbers:read', 'numbers:request', 'meetings:diagnose', 'calling:read', 'calling:request', 'workforce:self'];

const nav = {
  async Overview(m, say) {
    const r = await api('GET', `${A}/gates`); if (!r.ok) return say(why(r), true);
    m.append(el('h2', { text: 'Release and security controls' }), el('div', { class: 'cards' }, [
      el('article', {}, [el('label', { text: 'Release' }), el('strong', { text: r.data.release })]),
      el('article', {}, [el('label', { text: 'Admin MFA required' }), el('strong', { text: r.data.adminMfaRequired ? 'yes' : 'NO' })]),
      el('article', {}, [el('label', { text: 'Two-person refunds' }), el('strong', { text: r.data.refundTwoPerson ? 'enforced' : 'OFF' })]),
      ...Object.entries(r.data.gates).map(([k, v]) => el('article', {}, [el('label', { text: k }), el('strong', { text: v ? 'ON' : 'off' })]))]),
      el('p', { class: 'muted', text: 'This page only reports these values. They are set by deployment configuration and certification, never from here.' }));
  },
  async Staff(m, say) {
    const r = await api('GET', `${A}/staff`); if (!r.ok) return say(why(r), true);
    m.append(el('h2', { text: 'Staff directory' }), table([['Name', (s) => s.display_name], ['Role', (s) => s.role], ['Team', (s) => s.team], ['Status', (s) => s.employment_status], ['Permissions', (s) => s.permissions.join(', ')]], r.data.items),
      el('h3', { text: 'Add staff' }), form([input('user_id', 'Qorlla user id'), input('display_name', 'Name'), input('team', 'Team'), el('select', { name: 'role', 'aria-label': 'Role' }, ROLES.map((x) => el('option', { value: x, text: x }))), el('select', { name: 'perms', multiple: true, 'aria-label': 'Permissions', size: 5 }, PERMS.map((x) => el('option', { value: x, text: x })))],
        async (f) => { const x = await api('POST', `${A}/staff`, { user_id: f.get('user_id').trim(), display_name: f.get('display_name'), team: f.get('team'), role: f.get('role'), permissions: f.getAll('perms') }); say(x.ok ? 'Staff member added.' : why(x), !x.ok); }, 'Add'),
      el('h3', { text: 'Change status' }), form([input('id', 'Staff user id'), el('select', { name: 'status', 'aria-label': 'Status' }, ['active', 'suspended', 'terminated'].map((x) => el('option', { value: x, text: x })))],
        async (f) => { const x = await api('PATCH', `${A}/staff/${f.get('id').trim()}`, { employment_status: f.get('status') }); say(x.ok ? `Updated. ${x.data.released_tickets} case(s) returned to the queue.` : why(x), !x.ok); }, 'Update'));
  },
  async 'Refund approvals'(m, say) {
    const r = await api('GET', `${A}/refunds`); if (!r.ok) return say(why(r), true);
    const decide = async (x, what) => { const d = await api('POST', `${A}/refunds/${x.id}/${what}`, {}); say(d.ok ? (what === 'approve' ? 'Approved. It will be executed through the billing service.' : 'Rejected.') : (d.data?.code === 'separation_of_duties' ? 'You requested this refund, so someone else must decide it.' : why(d)), !d.ok); };
    m.append(el('h2', { text: 'Refunds' }), el('p', { class: 'muted', text: 'The person who requested a refund cannot approve it. Approved refunds execute exactly once through the billing service.' }),
      table([['Status', (x) => x.status], ['Amount (cents)', (x) => x.amount_cents], ['Reason', (x) => x.reason], ['Requested', (x) => fmt(x.created_at)], ['Reconciled', (x) => x.reconcile_state || '']], r.data.items),
      ...r.data.items.filter((x) => x.status === 'pending').map((x) => el('div', { class: 'row' }, [el('span', { text: `${x.amount_cents} cents — ${x.reason}` }), el('button', { type: 'button', text: 'Approve', onclick: () => decide(x, 'approve') }), el('button', { type: 'button', text: 'Reject', onclick: () => decide(x, 'reject') })])),
      el('div', { class: 'row' }, [el('button', { type: 'button', text: 'Execute approved now', onclick: async () => { const x = await api('POST', `${A}/refunds/process`, {}); say(x.ok ? `Succeeded ${x.data.succeeded}, failed ${x.data.failed}.` : why(x), !x.ok); } }), el('button', { type: 'button', text: 'Reconcile with billing', onclick: async () => { const x = await api('POST', `${A}/refunds/reconcile`, {}); say(x.ok ? `Matched ${x.data.matched}, mismatched ${x.data.mismatch}, needs review ${x.data.needs_review}.` : why(x), !x.ok); } })]));
  },
  async Payroll(m, say) {
    m.append(el('h2', { text: 'Payroll export' }), el('p', { class: 'muted', text: 'Approved hours only. The export is audited.' }),
      form([input('from', 'From', { type: 'date' }), input('to', 'To', { type: 'date' })], async (f) => {
        const q = `from=${encodeURIComponent(new Date(f.get('from') + 'T00:00:00Z').toISOString())}&to=${encodeURIComponent(new Date(f.get('to') + 'T00:00:00Z').toISOString())}`, r = await api('GET', `${A}/payroll/export?${q}`);
        if (!r.ok) return say(why(r), true); const a = el('a', { href: URL.createObjectURL(new Blob([r.data], { type: 'text/csv' })), download: 'payroll.csv', text: 'Download payroll.csv' }); m.append(a); say('Export ready.'); }, 'Export'));
  }
};
shell('Admin', nav, 'role + MFA');
