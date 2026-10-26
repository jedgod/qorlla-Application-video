// Phone + AI Receptionist UI. Everything shown comes from real provider events stored by the portal; when telephony is not enabled the page
// says so plainly and the history stays empty (nothing is simulated).
import { $, esc, api, notice, day, describe, heading, panel } from './core.js';

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '-');
const dur = (s) => (s == null ? '-' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
const pill = (s) => `<span class="pill ${esc(s)}">${esc(String(s).replace('_', ' '))}</span>`;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
const isManager = (role) => role === 'owner' || role === 'admin';

function statusBanner(st) {
  if (st.available) return `<p class="ok" role="status">Telephony is enabled. ${esc(st.note)}</p>`;
  return `<p class="warn" role="alert"><strong>Telephony is OFF.</strong> ${esc(st.note)} Reasons: ${st.reasons.map((r) => `<code>${esc(r)}</code>`).join(', ')}. No call is placed or recorded until an administrator configures the provider and confirms the compliance acknowledgement.</p>`;
}

export async function renderPhone(root, { role }) {
  root.innerHTML = '<div class="empty">Loading…</div>';
  const mgr = isManager(role);
  const [st, calls, numbers, vms, an] = await Promise.all([api('/phone/status'), api('/phone/calls'), mgr ? api('/phone/numbers') : [], mgr ? api('/phone/voicemails') : [], mgr ? api('/phone/analytics?days=30') : null]);
  root.innerHTML = statusBanner(st) +
    (an ? panel('This month', `<p><span id="ph-minutes">${esc(an.minutes.used_this_month)}</span> of ${an.minutes.limit == null ? 'unlimited' : esc(an.minutes.limit)} phone minutes used on the <strong>${esc(an.minutes.plan)}</strong> plan · ${an.voicemails.unheard} unheard voicemail(s) · ${an.escalations.open} open escalation(s)</p>`) : '') +
    panel('Place a call', st.available ? `<p class="muted">Click-to-call rings your own phone first, then connects the other party. Your workspace's active number is shown as the caller ID.</p>
      <form id="call-form" class="row"><label>Your phone (E.164)<input name="my_phone" placeholder="+12025550100" pattern="\\+[1-9][0-9]{6,14}" required></label><label>Call (E.164)<input name="to" placeholder="+12025550123" pattern="\\+[1-9][0-9]{6,14}" required></label><button ${st.active_numbers ? '' : 'disabled'}>Call</button></form>${st.active_numbers ? '' : '<p class="muted">Activate a phone number first.</p>'}` : '<p class="muted">Unavailable while telephony is off.</p>') +
    (mgr ? panel('Phone numbers', `${numbers.length ? `<table><thead><tr><th>Number</th><th>Label</th><th>Status</th><th></th></tr></thead><tbody>${numbers.map((n) => `<tr data-num="${esc(n.id)}"><td>${esc(n.e164)}</td><td>${esc(n.label || '')}</td><td>${pill(n.status)}</td><td class="row">${n.status !== 'active' ? '<button data-act="active">Activate</button>' : '<button class="secondary" data-act="disabled">Disable</button>'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No numbers registered.</div>'}
      <p class="muted">Register a number you have already provisioned with the telephony provider. It stays <em>pending</em> until you activate it.</p>
      <form id="num-form" class="row"><label>Number (E.164)<input name="e164" placeholder="+12025550100" pattern="\\+[1-9][0-9]{6,14}" required></label><label>Label<input name="label" maxlength="80"></label><button>Register number</button></form>`) : '') +
    panel('Call history', calls.length ? `<table><thead><tr><th>When</th><th>Direction</th><th>From</th><th>To</th><th>Status</th><th>Duration</th><th>Receptionist</th></tr></thead><tbody>${calls.map((c) => `<tr><td>${esc(when(c.started_at))}</td><td>${esc(c.direction)}</td><td>${esc(c.from_e164 || '-')}</td><td>${esc(c.to_e164 || '-')}</td><td>${pill(c.status)}</td><td>${esc(dur(c.duration_seconds))}</td><td>${esc(c.outcome || '-')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No calls yet. Calls appear here only when the provider reports them.</div>') +
    (mgr ? panel('Voicemail', vms.length ? `<table><thead><tr><th>When</th><th>From</th><th>Length</th><th>Transcript / summary</th><th></th></tr></thead><tbody>${vms.map((v) => `<tr data-vm="${esc(v.id)}"><td>${esc(when(v.created_at))}</td><td>${esc(v.from_e164 || 'unknown')}</td><td>${esc(dur(v.duration_seconds))}</td>
      <td>${v.ai_summary ? `<strong>${esc(v.ai_summary)}</strong><br>` : v.summary_status === 'blocked' ? '<span class="muted">Summary blocked (no AI provider or plan limit)</span><br>' : v.summary_status === 'queued' ? '<span class="muted">Summarising…</span><br>' : ''}${v.transcript ? `<span class="muted">${esc(v.transcript.slice(0, 300))}</span>` : '<span class="muted">No transcript</span>'}</td>
      <td class="row"><button data-act="play" class="secondary">${v.listened_at ? 'Play again' : 'Play'}</button>${v.transcript && !v.ai_summary ? '<button data-act="sum" class="secondary">Summarise</button>' : ''}<button data-act="del" class="secondary">Delete</button></td></tr>`).join('')}</tbody></table><audio id="vm-audio" controls hidden></audio>` : '<div class="empty">No voicemails.</div>') : '');

  const again = async () => { try { await renderPhone(root, { role }); } catch (e) { notice(describe(e)); } };
  $('#call-form')?.addEventListener('submit', async (e) => { e.preventDefault(); try { await api('/phone/calls', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); notice('Calling your phone…'); setTimeout(again, 1500); } catch (err) { notice(err.body?.code ? `${err.message} (${err.body.code})` : describe(err)); } });
  $('#num-form')?.addEventListener('submit', async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { await api('/phone/numbers', { method: 'POST', body: JSON.stringify({ e164: f.e164, label: f.label || undefined }) }); notice('Number registered (pending).'); await again(); } catch (err) { notice(describe(err)); } });
  root.querySelectorAll('tr[data-num] [data-act]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/phone/numbers/${b.closest('tr').dataset.num}`, { method: 'PATCH', body: JSON.stringify({ status: b.dataset.act }) }); await again(); } catch (err) { notice(err.body?.code === 'telephony_unavailable' ? 'Telephony is not enabled, so numbers cannot be activated.' : describe(err)); } }));
  root.querySelectorAll('tr[data-vm] [data-act]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.closest('tr').dataset.vm;
    try {
      if (b.dataset.act === 'del') { if (!confirm('Delete this voicemail, its transcript and summary?')) return; await api(`/phone/voicemails/${id}`, { method: 'DELETE' }); await again(); }
      if (b.dataset.act === 'sum') { await api(`/phone/voicemails/${id}/summarize`, { method: 'POST', body: '{}' }); notice('Summary queued.'); setTimeout(again, 2500); }
      if (b.dataset.act === 'play') { const r = await fetch(`/api/v1/phone/voicemails/${id}/audio`, { credentials: 'same-origin' }); if (!r.ok) throw Object.assign(new Error('The recording is not available.'), { status: r.status, body: {} }); const a = $('#vm-audio'); a.src = URL.createObjectURL(await r.blob()); a.hidden = false; a.play().catch(() => {}); }
    } catch (err) { notice(describe(err)); }
  }));
}

const hoursRows = (p) => DAYS.map((d, i) => { const w = p.windows.find((x) => x.weekday === i); return `<tr><td><label><input type="checkbox" data-day="${i}" ${w ? 'checked' : ''}> ${d}</label></td><td><input type="time" data-opens="${i}" value="${esc(w?.opens || '09:00')}" aria-label="${d} opens"></td><td><input type="time" data-closes="${i}" value="${esc(w?.closes || '17:00')}" aria-label="${d} closes"></td></tr>`; }).join('');
const routeRow = (r) => `<tr class="route"><td><input data-f="name" value="${esc(r.name || '')}" maxlength="120" aria-label="Rule name"></td><td><select data-f="hours" aria-label="When">${['any', 'open', 'closed'].map((h) => `<option ${h === (r.hours || 'any') ? 'selected' : ''}>${h}</option>`).join('')}</select></td><td><input data-f="digit" value="${esc(r.digit || '')}" maxlength="1" size="2" aria-label="Menu key"></td><td><select data-f="action" aria-label="Action">${['forward', 'voicemail', 'message', 'escalate', 'hangup'].map((a) => `<option ${a === (r.action || 'voicemail') ? 'selected' : ''}>${a}</option>`).join('')}</select></td><td><input data-f="destination" value="${esc(r.destination || '')}" placeholder="+1…" aria-label="Forward to"></td><td><button type="button" class="secondary" data-del>Remove</button></td></tr>`;

export async function renderReceptionist(root, { role }) {
  root.innerHTML = '<div class="empty">Loading…</div>';
  const mgr = isManager(role);
  const [st, profiles, appts, esc_] = await Promise.all([api('/phone/status'), mgr ? api('/receptionist/profiles') : [], api('/appointments'), mgr ? api('/receptionist/escalations') : []]);
  root.innerHTML = statusBanner(st) +
    (mgr ? panel('Receptionist profiles', `${profiles.map((p) => `<details class="profile" data-profile="${esc(p.id)}"><summary><strong>${esc(p.name)}</strong> ${p.enabled ? pill('active') : pill('disabled')} · ${esc(p.timezone)}</summary>
      <h3>Business hours</h3><form class="hours-form"><table><thead><tr><th>Day</th><th>Opens</th><th>Closes</th></tr></thead><tbody>${hoursRows(p)}</tbody></table><label>Closed dates (one YYYY-MM-DD per line)<textarea name="closures" rows="3">${esc(p.closures.map((c) => c.on_date).join('\n'))}</textarea></label><button>Save hours</button></form>
      <h3>Greeting and voicemail</h3><form class="text-form"><label>Greeting (open)<input name="greeting_text" value="${esc(p.greeting_text)}" maxlength="500"></label><label>Greeting (closed)<input name="closed_greeting_text" value="${esc(p.closed_greeting_text)}" maxlength="500"></label><label>Recording notice (played before every voicemail beep)<input name="recording_notice" value="${esc(p.recording_notice)}" maxlength="500" minlength="10" required></label><label>Escalation numbers (comma separated)<input name="escalation_numbers" value="${esc(p.escalation_numbers.join(', '))}"></label><label><input type="checkbox" name="enabled" ${p.enabled ? 'checked' : ''}> Receptionist enabled</label><button>Save</button></form>
      <h3>Routing rules</h3><p class="muted">First matching rule wins. A menu key makes the rule a keypad choice; leave it empty for automatic rules.</p><form class="routes-form"><table><thead><tr><th>Name</th><th>When</th><th>Key</th><th>Action</th><th>Forward to</th><th></th></tr></thead><tbody>${p.routes.map(routeRow).join('')}</tbody></table><button type="button" class="secondary" data-add>Add rule</button> <button>Save rules</button></form></details>`).join('') || '<div class="empty">No profiles yet.</div>'}
      <form id="profile-form" class="row"><label>New profile name<input name="name" required maxlength="120"></label><label>Time zone<input name="timezone" value="${esc(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')}"></label><button>Create profile</button></form>`) : '') +
    (mgr ? panel('Escalations', esc_.length ? `<table><thead><tr><th>When</th><th>Caller</th><th></th></tr></thead><tbody>${esc_.map((e) => `<tr data-esc="${esc(e.id)}"><td>${esc(when(e.escalated_at))}</td><td>${esc(e.from_e164 || 'unknown')}</td><td>${e.escalation_acknowledged_at ? 'Acknowledged ' + esc(when(e.escalation_acknowledged_at)) : '<button data-ack>Acknowledge</button>'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No escalated calls.</div>') : '') +
    panel('Appointments', `${appts.length ? `<table><thead><tr><th>When</th><th>Title</th><th>With</th><th>Status</th><th></th></tr></thead><tbody>${appts.map((a) => `<tr data-appt="${esc(a.id)}"><td>${esc(when(a.starts_at))}</td><td>${esc(a.title)}</td><td>${esc(a.attendee_name)}</td><td>${pill(a.status)}</td><td>${a.status === 'booked' ? '<button class="secondary" data-cancel>Cancel</button>' : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No upcoming appointments.</div>'}
      ${profiles.length ? `<h3>Book</h3><form id="appt-form" class="row"><label>Profile<select name="profile_id">${profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><label>Date<input type="date" name="date" required></label><label>Time<select name="slot" required><option value="">Pick a date…</option></select></label><label>Title<input name="title" required maxlength="200"></label><label>Name<input name="attendee_name" required maxlength="120"></label><label>Phone<input name="attendee_phone" placeholder="+1…"></label><button>Book</button></form>` : '<p class="muted">Create a receptionist profile with business hours to book appointments.</p>'}`);

  const again = async () => { try { await renderReceptionist(root, { role }); } catch (e) { notice(describe(e)); } };
  const pid = (el) => el.closest('[data-profile]').dataset.profile;
  $('#profile-form')?.addEventListener('submit', async (e) => { e.preventDefault(); try { await api('/receptionist/profiles', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); await again(); } catch (err) { notice(describe(err)); } });
  root.querySelectorAll('.hours-form').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault(); const windows = [...f.querySelectorAll('[data-day]')].filter((c) => c.checked).map((c) => ({ weekday: Number(c.dataset.day), opens: f.querySelector(`[data-opens="${c.dataset.day}"]`).value, closes: f.querySelector(`[data-closes="${c.dataset.day}"]`).value }));
    const closures = f.elements.closures.value.split(/\s+/).filter(Boolean).map((d) => ({ on_date: d }));
    try { await api(`/receptionist/profiles/${pid(f)}/hours`, { method: 'PUT', body: JSON.stringify({ windows, closures }) }); notice('Hours saved.'); } catch (err) { notice(err.status === 400 ? 'Check the hours: closing must be after opening and dates must be YYYY-MM-DD.' : describe(err)); }
  }));
  root.querySelectorAll('.text-form').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault(); const v = Object.fromEntries(new FormData(f)); const body = { greeting_text: v.greeting_text, closed_greeting_text: v.closed_greeting_text, recording_notice: v.recording_notice, escalation_numbers: String(v.escalation_numbers).split(',').map((x) => x.trim()).filter(Boolean), enabled: f.elements.enabled.checked };
    try { await api(`/receptionist/profiles/${pid(f)}`, { method: 'PATCH', body: JSON.stringify(body) }); notice('Saved.'); } catch (err) { notice(err.body?.code === 'hours_required' ? 'Save business hours before enabling the receptionist.' : describe(err)); }
  }));
  root.querySelectorAll('.routes-form').forEach((f) => {
    const body = f.querySelector('tbody');
    f.querySelector('[data-add]').addEventListener('click', () => body.insertAdjacentHTML('beforeend', routeRow({})));
    f.addEventListener('click', (e) => { if (e.target.matches('[data-del]')) e.target.closest('tr').remove(); });
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); const routes = [...body.querySelectorAll('tr.route')].map((tr) => { const g = (n) => tr.querySelector(`[data-f=${n}]`).value.trim(); return { name: g('name'), hours: g('hours'), digit: g('digit') || null, action: g('action'), destination: g('destination') || null }; });
      try { await api(`/receptionist/profiles/${pid(f)}/routes`, { method: 'PUT', body: JSON.stringify({ routes }) }); notice('Rules saved.'); } catch (err) { notice(err.status === 400 ? 'Each rule needs a name; forwarding needs a number in +E.164 format; a menu key can be used once.' : describe(err)); }
    });
  });
  root.querySelectorAll('tr[data-esc] [data-ack]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/receptionist/escalations/${b.closest('tr').dataset.esc}/acknowledge`, { method: 'POST', body: '{}' }); await again(); } catch (err) { notice(describe(err)); } }));
  root.querySelectorAll('tr[data-appt] [data-cancel]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/appointments/${b.closest('tr').dataset.appt}/cancel`, { method: 'POST', body: '{}' }); await again(); } catch (err) { notice(describe(err)); } }));
  const af = $('#appt-form');
  if (af) {
    const loadSlots = async () => {
      const sel = af.elements.slot; const date = af.elements.date.value; if (!date) return;
      try { const r = await api(`/appointments/slots?profile_id=${af.elements.profile_id.value}&date=${date}`); sel.innerHTML = r.slots.length ? r.slots.map((s) => `<option value="${esc(s)}">${esc(new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</option>`).join('') : '<option value="">No free slots</option>'; } catch (err) { notice(describe(err)); }
    };
    af.elements.date.addEventListener('change', loadSlots); af.elements.profile_id.addEventListener('change', loadSlots);
    const key = uid();
    af.addEventListener('submit', async (e) => {
      e.preventDefault(); const v = Object.fromEntries(new FormData(af));
      try { await api('/appointments', { method: 'POST', body: JSON.stringify({ profile_id: v.profile_id, title: v.title, starts_at: v.slot, duration: 30, attendee_name: v.attendee_name, attendee_phone: v.attendee_phone || undefined, idempotency_key: key }) }); notice('Appointment booked.'); await again(); }
      catch (err) { notice(err.status === 409 ? 'That time is no longer available.' : describe(err)); await loadSlots(); }
    });
  }
}
