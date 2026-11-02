// AI Meeting Intelligence UI (dashboard + report viewer). Plain DOM building, no innerHTML with user data except through esc().
import { $, esc, api, notice, day, describe, heading, panel } from './core.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
const pill = (s) => `<span class="pill ${esc(s)}">${esc(s)}</span>`;
const short = (id) => String(id).slice(0, 8);
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '-');

export async function renderAiDashboard(root) {
  root.innerHTML = '<div class="empty">Loading…</div>';
  const [status, usage, meetings, jobs, reports] = await Promise.all([api('/meeting-ai/status'), api('/meeting-ai/usage'), api('/meeting-ai/meetings'), api('/meeting-ai/jobs'), api('/meeting-ai/reports')]);
  const busy = jobs.some((j) => ['queued', 'running'].includes(j.status));
  root.innerHTML =
    (!status.ai_provider_configured ? '<p class="warn" role="alert">No AI provider is configured on this server, so report jobs will stay <strong>blocked</strong> (nothing is simulated). An administrator must set <code>AI_LLM_API_KEY</code>.</p>' : '') +
    panel('Your plan', `<p><strong>${esc(usage.plan)}</strong> plan · ${usage.unlimited ? 'unlimited AI meeting reports' : `<span id="ai-quota">${esc(usage.reports_used)} of ${esc(usage.reports_limit)}</span> AI meeting reports used this month`}</p><p class="muted">${esc(status.note)}</p>`) +
    panel('Meetings', meetings.length ? `<table><thead><tr><th>Meeting</th><th>When</th><th>Consent</th><th>Latest job</th><th>Actions</th></tr></thead><tbody>${meetings.map((m) => {
      const consented = ['transcription', 'summary'].every((s) => m.consent_scopes.includes(s));
      return `<tr data-meeting="${esc(m.meet_uuid)}"><td><strong>${esc(m.title)}</strong><br><span class="muted">ID ${esc(m.meet_code)}</span></td><td>${esc(when(m.scheduled_at))}</td>
        <td>${consented ? pill('active') : '<span class="muted">none</span>'}</td><td>${m.latest_job ? pill(m.latest_job.status) + (m.latest_job.error_code ? `<br><span class="muted">${esc(m.latest_job.error_code)}</span>` : '') : '-'}</td>
        <td class="row">${!consented ? (m.i_am_host ? '<button data-act="consent">Give consent…</button>' : '<span class="muted">Waiting for the host to consent</span>') : `<button data-act="chat">Summarize meeting chat</button><button class="secondary" data-act="import">Import transcript…</button>${m.i_am_host ? '<button class="secondary" data-act="revoke">Revoke consent</button>' : ''}`}${m.report_id ? `<a class="button secondary" href="/app/ai/reports/${esc(m.report_id)}">Open report</a>` : ''}</td></tr>`;
    }).join('')}</tbody></table>` : '<div class="empty">No eligible meetings yet. Schedule a meeting from your Qorlla home page; AI is offered for meetings you host (admins see their workspace\'s).</div>') +
    panel('Jobs', jobs.length ? `<table><thead><tr><th>Created</th><th>Source</th><th>Status</th><th></th></tr></thead><tbody>${jobs.slice(0, 15).map((j) => `<tr><td>${esc(when(j.created_at))}</td><td>${esc(j.source.replace('_', ' '))}</td><td>${pill(j.status)}${j.error_message ? `<br><span class="muted">${esc(j.error_message)}</span>` : ''}</td>
      <td class="row">${['failed', 'blocked'].includes(j.status) ? `<button class="secondary" data-job="${esc(j.id)}" data-act="retry">Retry</button>` : ''}${['queued', 'blocked', 'failed'].includes(j.status) ? `<button class="secondary" data-job="${esc(j.id)}" data-act="cancel">Cancel</button>` : ''}${j.report_id ? `<a class="link" href="/app/ai/reports/${esc(j.report_id)}">Report</a>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No jobs yet.</div>') +
    panel('Reports', reports.length ? `<div class="cards">${reports.map((r) => `<article class="card"><h3>${esc(r.title)}</h3><p>${r.status === 'withdrawn' ? '<em>Withdrawn after consent was revoked.</em>' : esc(r.excerpt)}</p><span class="muted">${esc(when(r.created_at))} · ${esc(r.open_items)} open item(s)</span><br><a class="link" href="/app/ai/reports/${esc(r.id)}">Open ${r.status === 'withdrawn' ? '(metadata only)' : 'report'} →</a></article>`).join('')}</div>` : '<div class="empty">No reports yet.</div>') +
    consentDialog() + importDialog();
  const again = async () => { try { await renderAiDashboard(root); } catch (e) { notice(describe(e)); } };
  if (busy) { clearTimeout(renderAiDashboard.t); renderAiDashboard.t = setTimeout(again, 3000); }

  root.querySelectorAll('[data-job]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/meeting-ai/jobs/${b.dataset.job}/${b.dataset.act}`, { method: 'POST', body: '{}' }); notice(b.dataset.act === 'retry' ? 'Job queued again.' : 'Job cancelled.'); await again(); } catch (e) { notice(describe(e)); } }));
  root.querySelectorAll('tr[data-meeting] [data-act]').forEach((b) => b.addEventListener('click', async () => {
    const meet = b.closest('tr').dataset.meeting; const act = b.dataset.act;
    try {
      if (act === 'consent') { $('#consent-dlg').dataset.meeting = meet; $('#consent-ok').checked = false; $('#consent-go').disabled = true; $('#consent-dlg').showModal(); }
      if (act === 'import') { $('#import-dlg').dataset.meeting = meet; $('#import-dlg').showModal(); }
      if (act === 'chat') { await api('/meeting-ai/jobs', { method: 'POST', body: JSON.stringify({ meet_meeting_id: meet, source: 'meet_chat', idempotency_key: uid() }) }); notice('Reading the meeting chat and building the report…'); await again(); }
      if (act === 'revoke') {
        if (!confirm('Revoke consent? This DELETES the transcript text, withdraws every report from this meeting, removes its action items and kills all share links. It cannot be undone.')) return;
        const { consents } = await api(`/meeting-ai/meetings/${meet}/consents`); let out = {};
        for (const c of consents.filter((x) => !x.revoked_at)) out = await api(`/meeting-ai/consents/${c.id}/revoke`, { method: 'POST', body: JSON.stringify({ reason: 'revoked from the dashboard' }) });
        notice(`Consent revoked. ${out.withdrawn_reports || 0} report(s) withdrawn.`); await again();
      }
    } catch (e) { notice(describe(e)); }
  }));
  $('#consent-ok').addEventListener('change', (e) => { $('#consent-go').disabled = !e.target.checked; });
  $('#consent-cancel').addEventListener('click', () => $('#consent-dlg').close()); $('#import-cancel').addEventListener('click', () => $('#import-dlg').close());
  $('#consent-form').addEventListener('submit', async (e) => { e.preventDefault(); try { await api(`/meeting-ai/meetings/${$('#consent-dlg').dataset.meeting}/consents`, { method: 'POST', body: JSON.stringify({ attest: true, notice_version: $('#consent-notice').dataset.version }) }); $('#consent-dlg').close(); notice('Consent recorded.'); await again(); } catch (err) { notice(describe(err)); } });
  $('#import-file').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; if (f.size > 500000) { notice('That file is too large (500 KB maximum).'); e.target.value = ''; return; } $('#import-text').value = await f.text(); const ext = f.name.split('.').pop().toLowerCase(); if (['txt', 'vtt', 'srt'].includes(ext)) $('#import-format').value = ext; });
  $('#import-form').addEventListener('submit', async (e) => { e.preventDefault(); try { await api('/meeting-ai/jobs', { method: 'POST', body: JSON.stringify({ meet_meeting_id: $('#import-dlg').dataset.meeting, source: 'transcript_import', idempotency_key: uid(), transcript: { format: $('#import-format').value, text: $('#import-text').value } }) }); $('#import-dlg').close(); notice('Transcript imported. Building the report…'); await again(); } catch (err) { notice(describe(err)); } });
  api('/meeting-ai/notice').then((n) => { $('#consent-notice').textContent = n.text; $('#consent-notice').dataset.version = n.version; }).catch(() => {});
}
const consentDialog = () => `<dialog id="consent-dlg" aria-labelledby="consent-title"><form id="consent-form" method="dialog"><h2 id="consent-title">Consent to AI processing</h2><p id="consent-notice" class="notice-text" data-version="v1">Loading…</p><label class="check"><input type="checkbox" id="consent-ok"> I confirm the statement above</label><div class="row"><button type="button" class="secondary" id="consent-cancel">Cancel</button><button id="consent-go" disabled>Record consent</button></div></form></dialog>`;
const importDialog = () => `<dialog id="import-dlg" aria-labelledby="import-title"><form id="import-form" method="dialog"><h2 id="import-title">Import a transcript</h2><p class="muted">Plain text ("Name: words"), WebVTT or SRT. Speaker names are used as typed; they are not verified identities.</p><label>File (optional)<input type="file" id="import-file" accept=".txt,.vtt,.srt,text/plain,text/vtt"></label><label>Format<select id="import-format"><option value="txt">Text</option><option value="vtt">WebVTT</option><option value="srt">SRT</option></select></label><label>Transcript<textarea id="import-text" required rows="10"></textarea></label><div class="row"><button type="button" class="secondary" id="import-cancel">Cancel</button><button>Build report</button></div></form></dialog>`;

export async function renderReport(root, id) {
  let r;
  try { r = await api('/meeting-ai/reports/' + id); } catch (e) { root.innerHTML = panel('Report', `<p>${esc(e.status === 404 ? 'This report does not exist or you do not have access to it.' : describe(e))}</p><a class="link" href="/app/ai">← Back to AI Meeting Intelligence</a>`); return; }
  if (r.status === 'withdrawn') { root.innerHTML = panel(r.title, '<p class="warn">Consent for this meeting was revoked. The summary, transcript and action items have been deleted.</p><a class="link" href="/app/ai">← Back</a>'); return; }
  const manage = r.permissions.manage; const label = (m) => m.display_name || `Member ${short(m.user_id)}`;
  const memberOptions = (sel) => `<option value="">Unassigned</option>` + (r.members || []).map((m) => `<option value="${esc(m.user_id)}" ${sel === m.user_id ? 'selected' : ''}>${esc(label(m))}</option>`).join('');
  const dueInput = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
  const itemRow = (i) => `<tr data-item="${esc(i.id)}"><td><label class="check"><input type="checkbox" data-f="done" ${i.status === 'done' ? 'checked' : ''} aria-label="Done: ${esc(i.title)}"> ${esc(i.title)}</label>${i.owner_hint || i.due_hint ? `<br><span class="muted">AI suggestion: ${esc(i.owner_hint || '?')}${i.due_hint ? ' · ' + esc(i.due_hint) : ''}</span>` : ''}</td>
    <td>${manage ? `<select data-f="owner" aria-label="Assignee">${memberOptions(i.owner_id)}</select>` : esc(i.owner_label || (i.owner_id ? 'Assigned' : 'Unassigned'))}</td>
    <td>${manage ? `<input type="date" data-f="due" value="${esc(dueInput(i.due_at))}" aria-label="Due date">` : esc(i.due_at ? day(i.due_at) : '-')}</td></tr>`;
  root.innerHTML =
    `<p><a class="link" href="/app/ai">← AI Meeting Intelligence</a></p>` +
    `<div class="hero"><div><div class="eyebrow">AI-generated meeting report</div><h1>${esc(r.title)}</h1><p>${esc(when(r.created_at))} · ${esc(r.generated_by || 'AI')}${manage ? ` · visibility: ${esc(r.visibility)}` : ''}</p></div><div class="symbol" aria-hidden="true">🧠</div></div>` +
    '<p class="muted" role="note">AI can make mistakes. Speaker names are labels typed by participants, not verified identities. Check anything important before acting on it.</p>' +
    (r.summary_hidden ? '<p class="warn">You can see only the action items assigned to you.</p>' : panel('Summary', `<p style="white-space:pre-wrap">${esc(r.summary)}</p>`) +
      (r.decisions.length ? panel('Decisions', `<ul>${r.decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`) : '') + (r.topics.length ? panel('Topics', `<p>${r.topics.map((t) => `<span class="pill">${esc(t)}</span>`).join(' ')}</p>`) : '')) +
    panel('Action items', r.action_items.length ? `<table><thead><tr><th>Item</th><th>Assignee</th><th>Due</th></tr></thead><tbody>${r.action_items.map(itemRow).join('')}</tbody></table>` : '<div class="empty">No action items.</div>') +
    (manage ? panel('Add action item', `<form id="item-form" class="row"><input name="title" required maxlength="500" placeholder="What needs to happen?" aria-label="New action item"><select name="owner" aria-label="Assignee">${memberOptions('')}</select><input type="date" name="due" aria-label="Due date"><button>Add</button></form>`) : '') +
    (r.permissions.export ? panel('Export', `<div class="row"><a class="button" href="/api/v1/meeting-ai/reports/${esc(r.id)}/export.pdf" download>Download PDF</a><a class="button secondary" href="/api/v1/meeting-ai/reports/${esc(r.id)}/export.docx" download>Download DOCX</a>${r.permissions.transcript ? `<label class="check"><input type="checkbox" id="exp-tr"> include transcript</label>` : ''}</div>`) : '') +
    (r.permissions.transcript ? panel('Transcript', '<button class="secondary" id="show-tr">Show transcript</button><div id="tr"></div>') : '') +
    (manage ? panel('Sharing', '<div id="shares" class="empty">Loading…</div>' + `<form id="share-form"><div class="row"><label>Share with<select name="kind" id="share-kind"><option value="member">A workspace member</option><option value="link">Anyone with a link</option></select></label>
      <label id="share-member">Member<select name="user_id">${(r.members || []).map((m) => `<option value="${esc(m.user_id)}">${esc(label(m))}</option>`).join('')}</select></label>
      <label id="share-days" hidden>Expires in (days)<input type="number" name="days" min="1" max="90" value="14"></label><label id="share-tr" class="check" hidden><input type="checkbox" name="tr"> include transcript</label><button>Create share</button></div></form><div id="share-result"></div>` +
      `<div class="row"><label class="check"><input type="checkbox" id="vis" ${r.visibility === 'workspace' ? 'checked' : ''}> Everyone in this workspace can read this report (not the transcript)</label></div>` +
      '<div class="row"><button class="secondary" id="del-report">Delete report</button></div>') : '');
  const reload = () => renderReport(root, id);
  root.querySelectorAll('tr[data-item]').forEach((tr) => {
    const iid = tr.dataset.item; const send = async (body) => { try { await api('/meeting-ai/action-items/' + iid, { method: 'PATCH', body: JSON.stringify(body) }); notice('Saved.'); } catch (e) { notice(describe(e)); await reload(); } };
    tr.querySelector('[data-f=done]')?.addEventListener('change', (e) => send({ status: e.target.checked ? 'done' : 'open' }));
    tr.querySelector('[data-f=owner]')?.addEventListener('change', (e) => send({ owner_id: e.target.value || null }));
    tr.querySelector('[data-f=due]')?.addEventListener('change', (e) => send({ due_at: e.target.value ? e.target.value + 'T12:00:00.000Z' : null }));
  });
  $('#item-form')?.addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(e.target); try { await api(`/meeting-ai/reports/${id}/action-items`, { method: 'POST', body: JSON.stringify({ title: f.get('title'), owner_id: f.get('owner') || null, due_at: f.get('due') ? new Date(f.get('due') + 'T23:59:00').toISOString() : null }) }); await reload(); } catch (err) { notice(describe(err)); } });
  $('#exp-tr')?.addEventListener('change', (e) => root.querySelectorAll('a[download]').forEach((a) => { a.href = a.href.split('?')[0] + (e.target.checked ? '?transcript=1' : ''); }));
  $('#show-tr')?.addEventListener('click', async () => { try { const t = await api(`/meeting-ai/reports/${id}/transcript`); $('#tr').innerHTML = `<p class="muted">${esc(t.speaker_note)}</p><div class="transcript">${t.segments.map((s) => `<p><strong>${esc(s.speaker || '')}</strong> ${esc(s.text)}</p>`).join('')}</div>`; } catch (e) { $('#tr').textContent = describe(e); } });
  if (manage) {
    const drawShares = async () => {
      const list = await api(`/meeting-ai/reports/${id}/shares`); const el = $('#shares'); el.className = '';
      el.innerHTML = list.length ? `<table><thead><tr><th>Who</th><th>Status</th><th>Opened</th><th></th></tr></thead><tbody>${list.map((s) => `<tr><td>${s.kind === 'member' ? esc(label({ user_id: s.recipient_user_id, display_name: (r.members.find((m) => m.user_id === s.recipient_user_id) || {}).display_name })) : 'Link' + (s.recipient_label ? ' (' + esc(s.recipient_label) + ')' : '')}${s.include_transcript ? ' + transcript' : ''}</td>
        <td>${s.revoked_at ? pill('revoked') : s.expires_at && new Date(s.expires_at) < new Date() ? pill('expired') : pill('active')}${s.expires_at ? `<br><span class="muted">expires ${esc(day(s.expires_at))}</span>` : ''}</td><td>${esc(s.access_count)}</td><td>${s.revoked_at ? '' : `<button class="secondary" data-rv="${esc(s.id)}">Revoke</button>`}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Not shared with anyone.</div>';
      el.querySelectorAll('[data-rv]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/meeting-ai/shares/${b.dataset.rv}/revoke`, { method: 'POST', body: '{}' }); notice('Share revoked. Access ended immediately.'); await drawShares(); } catch (e) { notice(describe(e)); } }));
    };
    await drawShares();
    const kind = $('#share-kind'); const toggle = () => { const link = kind.value === 'link'; $('#share-member').hidden = link; $('#share-days').hidden = !link; $('#share-tr').hidden = !link; }; kind.addEventListener('change', toggle); toggle();
    $('#share-form').addEventListener('submit', async (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      try {
        const body = f.get('kind') === 'member' ? { kind: 'member', user_id: f.get('user_id') } : { kind: 'link', expires_in_days: Number(f.get('days')), include_transcript: f.get('tr') === 'on' };
        const out = await api(`/meeting-ai/reports/${id}/shares`, { method: 'POST', body: JSON.stringify(body) });
        $('#share-result').innerHTML = out.token ? `<p class="warn">Copy this link now - it is shown only once and cannot be recovered. Anyone who has it can read the report until ${esc(day(out.expires_at))} or until you revoke it.</p><input readonly id="share-url" value="${esc(location.origin + out.path)}" aria-label="Share link"><button class="secondary" id="copy-url">Copy link</button>` : '<p>Shared.</p>';
        $('#copy-url')?.addEventListener('click', () => { $('#share-url').select(); navigator.clipboard?.writeText($('#share-url').value); notice('Link copied.'); });
        await drawShares();
      } catch (err) { notice(describe(err)); }
    });
    $('#vis').addEventListener('change', async (e) => { try { await api('/meeting-ai/reports/' + id, { method: 'PATCH', body: JSON.stringify({ visibility: e.target.checked ? 'workspace' : 'restricted' }) }); notice('Visibility updated.'); } catch (err) { notice(describe(err)); e.target.checked = !e.target.checked; } });
    $('#del-report').addEventListener('click', async () => { if (!confirm('Delete this report and end all of its shares?')) return; try { await api('/meeting-ai/reports/' + id, { method: 'DELETE' }); location.href = '/app/ai'; } catch (e) { notice(describe(e)); } });
  }
}
