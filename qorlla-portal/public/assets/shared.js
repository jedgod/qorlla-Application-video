// Public, read-only view of a report shared by link. No sign-in, no cookies, nothing is editable.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const out = document.getElementById('out');
const token = location.pathname.split('/').pop();
fetch('/api/v1/shared/reports/' + encodeURIComponent(token), { credentials: 'omit', cache: 'no-store' })
  .then(async (r) => { if (!r.ok) throw new Error('invalid'); return r.json(); })
  .then((r) => {
    document.title = r.title + ' | Qorlla';
    out.innerHTML = `<h1>${esc(r.title)}</h1><p class="muted">${esc(r.note)}</p>
      <section class="panel"><h2>Summary</h2><p style="white-space:pre-wrap">${esc(r.summary)}</p></section>
      ${r.decisions.length ? `<section class="panel"><h2>Decisions</h2><ul>${r.decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></section>` : ''}
      <section class="panel"><h2>Action items</h2>${r.action_items.length ? `<ul>${r.action_items.map((i) => `<li>${i.status === 'done' ? '✓ ' : ''}${esc(i.title)}${i.due_at ? ' <span class="muted">(due ' + esc(new Date(i.due_at).toLocaleDateString()) + ')</span>' : ''}</li>`).join('')}</ul>` : '<p class="muted">None.</p>'}</section>
      ${r.transcript ? `<section class="panel"><h2>Transcript</h2>${r.transcript.map((s) => `<p><strong>${esc(s.speaker || '')}</strong> ${esc(s.text)}</p>`).join('')}</section>` : ''}`;
  })
  .catch(() => { out.innerHTML = '<section class="panel"><h2>This link is not valid</h2><p>It may have expired or been revoked by the person who shared it.</p></section>'; });
