import { el, api, fmt, why, shell, table } from './ops.js';
const P = '/api/v1/ops/support';
const nav = {
  async 'My cases'(m, say) {
    const r = await api('GET', `${P}/tickets`); if (!r.ok) return say(why(r), true);
    m.append(el('h2', { text: 'Your support cases' }), r.data.items.length ? table([['Subject', (t) => t.subject], ['Status', (t) => t.status.replace(/_/g, ' ')], ['Updated', (t) => fmt(t.updated_at)]], r.data.items, (t) => view(t.id)) : el('p', { text: 'You have no support cases.' }));
    async function view(id) {
      const d = await api('GET', `${P}/tickets/${id}`); if (!d.ok) return say(why(d), true); m.textContent = '';
      const f = el('form', { class: 'row' }, [el('textarea', { name: 'body', 'aria-label': 'Your reply', required: true, maxlength: 10000 }), el('button', { type: 'submit', text: 'Reply' })]);
      f.addEventListener('submit', async (e) => { e.preventDefault(); const x = await api('POST', `${P}/tickets/${id}/messages`, { body: new FormData(f).get('body') }); if (!x.ok) return say(why(x), true); view(id); });
      m.append(el('h2', { text: d.data.subject }), el('p', { class: 'muted', text: d.data.status.replace(/_/g, ' ') }), el('p', { text: d.data.description }), ...d.data.messages.map((x) => el('div', { class: 'msgbox ' + x.author_kind }, [el('small', { text: (x.author_kind === 'staff' ? 'Qorlla support' : 'You') + ' · ' + fmt(x.created_at) }), el('p', { text: x.body })])), d.data.status === 'closed' ? el('p', { text: 'This case is closed.' }) : f);
    }
  },
  async 'New case'(m, say) {
    const f = el('form', { class: 'col' }, [el('select', { name: 'category', 'aria-label': 'Category' }, ['audio', 'video', 'meeting', 'chat', 'billing', 'number', 'external_call', 'account', 'abuse', 'other'].map((c) => el('option', { value: c, text: c.replace(/_/g, ' ') }))),
      el('input', { name: 'subject', placeholder: 'Subject', 'aria-label': 'Subject', required: true, minlength: 3, maxlength: 200 }), el('textarea', { name: 'description', placeholder: 'What happened? Do not include passwords or card numbers.', 'aria-label': 'Description', required: true, minlength: 3, maxlength: 10000 }), el('button', { type: 'submit', text: 'Open case' })]);
    f.addEventListener('submit', async (e) => { e.preventDefault(); const d = new FormData(f), x = await api('POST', `${P}/tickets`, { category: d.get('category'), subject: d.get('subject'), description: d.get('description') }); say(x.ok ? 'Your case was opened.' : why(x), !x.ok); if (x.ok) f.reset(); });
    m.append(el('h2', { text: 'Open a support case' }), f);
  }
};
shell('Support', nav, 'your own cases');
