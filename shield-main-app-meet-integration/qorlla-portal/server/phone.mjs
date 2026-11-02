// Workplace v4.3 - AI Receptionist and Phone.
// SAFETY MODEL
//  * Telephony is OFF unless configured AND the operator acknowledged number provisioning, recording-consent and regulatory review
//    (TELEPHONY_COMPLIANCE_ACK). While off, every provider webhook answers 503 and nothing is stored or dialled.
//  * Every provider callback must carry a valid X-Twilio-Signature computed over the PUBLIC url (built from configuration, not headers).
//  * Calls shown in the dashboard are rows created by real provider callbacks / REST responses. Nothing is simulated.
//  * A voicemail is recorded only after the profile's recording notice has been played to the caller.
import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { UUID_RE } from './auth.mjs';
import { PlanLimitError, quotaFor, withWorkspaceLock } from './entitlements.mjs';
import { hoursState, menuRoutes, decide, openSlots, localParts } from './telephony/routing.mjs';
import { verifySignature, twiml, say, hangup, gather, dial, record, createTwilio, accessToken, xml } from './telephony/twilio.mjs';

const E164 = /^\+[1-9][0-9]{6,14}$/;
const isManager = (r) => r === 'owner' || r === 'admin';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const STATUS = { queued: 'initiated', initiated: 'initiated', ringing: 'ringing', 'in-progress': 'in_progress', completed: 'completed', busy: 'busy', failed: 'failed', 'no-answer': 'no_answer', canceled: 'canceled' };
const TERMINAL = new Set(['completed', 'busy', 'no_answer', 'failed', 'canceled']);
const err = (status, error, code, extra = {}) => Object.assign(new Error(error), { http: { status, body: { error, code, ...extra } } });

/** Outbound destination policy: toll-fraud guard. NANP only unless the operator explicitly allows international; premium-rate and emergency-style numbers never. */
export function destinationAllowed(e164, { allowInternational = false } = {}) {
  if (!E164.test(e164)) return { ok: false, reason: 'not_e164' };
  if (/^\+1(900|976)/.test(e164) || /^\+(1)?(911|112)$/.test(e164) || /^\+(44)(9|87)/.test(e164)) return { ok: false, reason: 'premium_or_emergency' };
  if (!allowInternational && !e164.startsWith('+1')) return { ok: false, reason: 'international_disabled' };
  return { ok: true };
}

export function registerPhone(app, { pool, cfg, auth, h, log, llm, limiters = {}, fetchImpl = fetch, now = () => Date.now(), twilio: twilioOverride }) {
  const { member } = auth;
  const t = cfg.telephony;
  const reasons = [];
  if (!t.enabled) reasons.push('telephony_disabled');
  else {
    if (!t.accountSid) reasons.push('missing_account_sid');
    if (!t.authToken) reasons.push('missing_auth_token');
    if (!cfg.origin) reasons.push('missing_public_origin');
    if (t.complianceAck !== 'confirmed-numbers-consent-and-regulatory-review') reasons.push('compliance_not_acknowledged');
  }
  const available = reasons.length === 0;
  const dialerAvailable = available && !!(t.apiKeySid && t.apiKeySecret && t.twimlAppSid);
  const provider = twilioOverride || (available ? createTwilio({ accountSid: t.accountSid, authToken: t.authToken, apiBase: t.apiBase, fetchImpl }) : null);
  const audit = (db, ws, actor, action, obj) => db.query('INSERT INTO portal.audit_events(workspace_id,actor_id,action,object_id) VALUES($1,$2,$3,$4)', [ws, actor, action, String(obj ?? '')]);
  const hook = (p) => `${cfg.origin}/api/v1/telephony/voice/${p}`;

  // ================================================================== data helpers
  const profileFull = async (db, id) => {
    const p = (await db.query('SELECT * FROM portal.receptionist_profiles WHERE id=$1', [id])).rows[0]; if (!p) return null;
    const [windows, closures, routes] = await Promise.all([
      db.query('SELECT weekday, to_char(opens,\'HH24:MI\') AS opens, to_char(closes,\'HH24:MI\') AS closes FROM portal.business_hours WHERE profile_id=$1 ORDER BY weekday, opens', [id]),
      db.query('SELECT to_char(on_date,\'YYYY-MM-DD\') AS on_date, reason FROM portal.business_closures WHERE profile_id=$1 ORDER BY on_date', [id]),
      db.query('SELECT id, position, name, hours, digit, caller_prefix, action, destination, message FROM portal.call_routes WHERE profile_id=$1 ORDER BY position', [id])]);
    return { ...p, windows: windows.rows, closures: closures.rows, routes: routes.rows };
  };
  const usedMinutes = async (db, ws) => Number((await db.query(`SELECT COALESCE(sum(units),0) s FROM portal.ai_usage_events WHERE workspace_id=$1 AND feature='phone_minutes' AND created_at >= date_trunc('month', now())`, [ws])).rows[0].s);
  const minutesExhausted = async (db, ws) => { const q = await quotaFor(db, ws, 'phone.minutes_per_month'); return q.quota !== null && (await usedMinutes(db, ws)) >= q.quota; };
  const meter = (db, ws, feature, units, key) => db.query(`INSERT INTO portal.ai_usage_events(workspace_id,feature,units,idempotency_key) VALUES($1,$2,$3,$4) ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`, [ws, feature, units, key]);

  // ================================================================== provider webhooks (public, signature-verified)
  const form = express.urlencoded({ extended: false, limit: '64kb' });
  const verified = [limiters.webhook || ((req, res, next) => next()), form, (req, res, next) => {
    if (!available) return res.status(503).type('text/plain').send('Telephony is not enabled');
    const ok = verifySignature({ authToken: t.authToken, url: cfg.origin + req.originalUrl, params: req.body || {}, signature: req.get('x-twilio-signature') });
    if (!ok) { log.warn('telephony webhook rejected: bad signature', { path: req.path }); return res.status(403).type('text/plain').send('Forbidden'); }
    next();
  }];
  const xmlOut = (res, body) => res.set({ 'Cache-Control': 'no-store' }).type('text/xml').send(body);
  const sidOk = (s) => typeof s === 'string' && /^[A-Za-z0-9]{10,64}$/.test(s);

  async function loadCall(sid) {
    const s = (await pool.query('SELECT s.*, rc.profile_id, rc.hours_state FROM portal.call_sessions s LEFT JOIN portal.receptionist_calls rc ON rc.call_session_id=s.id WHERE s.provider=$1 AND s.provider_call_sid=$2', ['twilio', sid])).rows[0];
    return s || null;
  }
  async function respond(res, call, profile, decision) {
    const mark = (outcome, extra = '') => pool.query(`UPDATE portal.receptionist_calls SET outcome=$2, route_id=$3${extra} WHERE call_session_id=$1`, [call.id, outcome, decision.route?.id || null]);
    const voicemail = () => { const prompt = `${profile.recording_notice} ${profile.voicemail_prompt}`; return twiml(say(prompt), record({ action: hook('recorded'), statusCallback: hook('recording') })); };
    switch (decision.action) {
      case 'forward': await mark('forwarded'); return xmlOut(res, twiml(say('Please hold while we connect you.'), dial({ action: hook('dial-result'), callerId: call.to_e164, numbers: [decision.destination] })));
      case 'escalate': await mark('escalated', ', escalated_at=now()'); return xmlOut(res, twiml(say('Please hold while we connect you to a team member.'), dial({ action: hook('dial-result'), callerId: call.to_e164, numbers: profile.escalation_numbers })));
      case 'voicemail': await mark('voicemail'); await pool.query(`UPDATE portal.call_sessions SET recording_basis='notice_played' WHERE id=$1`, [call.id]); return xmlOut(res, voicemail());
      case 'message': await mark('message_played'); return xmlOut(res, twiml(say(decision.message), hangup()));
      default: await mark('hung_up'); return xmlOut(res, twiml(hangup()));
    }
  }

  app.post('/api/v1/telephony/voice/inbound', verified, h(async (req, res) => {
    const { CallSid, From, To } = req.body; if (!sidOk(CallSid) || !E164.test(To || '')) return xmlOut(res, twiml(say('This call cannot be completed.'), hangup()));
    const num = (await pool.query(`SELECT n.id, n.workspace_id, n.profile_id FROM portal.phone_numbers n WHERE n.e164=$1 AND n.status='active'`, [To])).rows[0];
    if (!num) return xmlOut(res, twiml(say('This number is not in service.'), hangup()));
    const prof = num.profile_id && (await profileFull(pool, num.profile_id));
    const sess = (await pool.query(`INSERT INTO portal.call_sessions(workspace_id,direction,from_e164,to_e164,number_id,status,provider,provider_call_sid) VALUES($1,'inbound',$2,$3,$4,'ringing','twilio',$5)
      ON CONFLICT (provider, provider_call_sid) DO UPDATE SET provider_call_sid=EXCLUDED.provider_call_sid RETURNING *`, [num.workspace_id, E164.test(From || '') ? From : null, To, num.id, CallSid])).rows[0];
    if (!prof || !prof.enabled) return xmlOut(res, twiml(say('Thank you for calling. Nobody is available to take your call right now. Goodbye.'), hangup()));
    const hours = hoursState({ timezone: prof.timezone, windows: prof.windows, closures: prof.closures }, new Date(now()));
    await pool.query(`INSERT INTO portal.receptionist_calls(workspace_id,call_session_id,profile_id,hours_state) VALUES($1,$2,$3,$4) ON CONFLICT (call_session_id) DO NOTHING`, [num.workspace_id, sess.id, prof.id, hours]);
    const greeting = hours === 'open' ? prof.greeting_text : prof.closed_greeting_text;
    const menu = menuRoutes(prof.routes, hours);
    if (menu.length) return xmlOut(res, twiml(say(greeting), gather({ action: hook('menu'), prompt: menu.map((r) => `Press ${r.digit} for ${r.name}.`).join(' ') }), `<Redirect method="POST">${xml(hook('menu'))}</Redirect>`));
    const decision = decide({ profile: prof, routes: prof.routes, hours, caller: From || '', minutesExhausted: await minutesExhausted(pool, num.workspace_id) });
    await pool.query(`UPDATE portal.receptionist_calls SET digits=NULL WHERE call_session_id=$1`, [sess.id]);
    return xmlOut(res, twiml(say(greeting)).replace('</Response>', '') + (await captured(res, sess, prof, decision)));
  }));
  // helper: build the decision TwiML and persist its outcome (shared by the no-menu path)
  async function captured(res, call, profile, decision) {
    const fake = { set() { return this; }, type() { return this; }, send(b) { this.body = b; } }; const sink = Object.assign(Object.create(fake), { body: '' });
    await respond(sink, call, profile, decision); return String(sink.body).replace(/^<\?xml[^>]*\?><Response>/, '').replace(/<\/Response>$/, '') + '</Response>';
  }

  app.post('/api/v1/telephony/voice/menu', verified, h(async (req, res) => {
    const { CallSid, From } = req.body; const call = sidOk(CallSid) && (await loadCall(CallSid)); if (!call || !call.profile_id) return xmlOut(res, twiml(hangup()));
    const prof = await profileFull(pool, call.profile_id); const digit = /^[0-9*#]$/.test(req.body.Digits || '') ? req.body.Digits : null;
    const hours = call.hours_state || 'closed';
    if (digit && !menuRoutes(prof.routes, hours).some((r) => r.digit === digit)) return xmlOut(res, twiml(say('Sorry, that is not a valid choice.'), gather({ action: hook('menu'), prompt: menuRoutes(prof.routes, hours).map((r) => `Press ${r.digit} for ${r.name}.`).join(' ') }), hangup()));
    await pool.query('UPDATE portal.receptionist_calls SET digits=$2 WHERE call_session_id=$1', [call.id, digit]);
    const decision = decide({ profile: prof, routes: prof.routes, hours, digit, caller: From || call.from_e164 || '', minutesExhausted: await minutesExhausted(pool, call.workspace_id) });
    return respond(res, call, prof, decision);
  }));
  app.post('/api/v1/telephony/voice/dial-result', verified, h(async (req, res) => {
    const call = sidOk(req.body.CallSid) && (await loadCall(req.body.CallSid)); if (!call || !call.profile_id) return xmlOut(res, twiml(hangup()));
    if (req.body.DialCallStatus === 'completed') return xmlOut(res, twiml(hangup()));
    const prof = await profileFull(pool, call.profile_id);              // nobody answered: never leave the caller in silence
    return respond(res, call, prof, prof.voicemail_enabled ? { action: 'voicemail', route: null } : { action: 'message', route: null, message: 'Sorry, nobody is available. Please try again later.' });
  }));
  app.post('/api/v1/telephony/voice/recorded', verified, (req, res) => xmlOut(res, twiml(say('Thank you. Goodbye.'), hangup())));

  app.post('/api/v1/telephony/voice/status', verified, h(async (req, res) => {
    const b = req.body; if (!sidOk(b.CallSid)) return res.status(400).end();
    const status = STATUS[b.CallStatus]; if (!status) return res.status(204).end();
    const eventId = `${b.CallSid}:${b.CallStatus}:${b.SequenceNumber || ''}`;
    const dup = await pool.query(`INSERT INTO portal.telephony_events(provider,event_id,kind,payload) VALUES('twilio',$1,'status',$2) ON CONFLICT DO NOTHING RETURNING event_id`, [eventId, JSON.stringify({ CallSid: b.CallSid, CallStatus: b.CallStatus, CallDuration: b.CallDuration })]);
    if (!dup.rowCount) return res.status(204).end();                      // replay
    const call = await loadCall(b.CallSid); if (!call) return res.status(204).end();   // not ours (e.g. a leg we do not track)
    if (TERMINAL.has(call.status) && !TERMINAL.has(status)) return res.status(204).end();   // late 'ringing' after 'completed' must not regress the state
    const dur = Number.isFinite(Number(b.CallDuration)) ? Math.max(0, Math.floor(Number(b.CallDuration))) : null;
    await withWorkspaceLock(pool, call.workspace_id, async (c) => {
      await c.query(`UPDATE portal.call_sessions SET status=$2, answered_at=CASE WHEN $2='in_progress' THEN COALESCE(answered_at, now()) ELSE answered_at END, ended_at=CASE WHEN $3::boolean THEN COALESCE(ended_at, now()) ELSE ended_at END, duration_seconds=COALESCE($4, duration_seconds) WHERE id=$1`, [call.id, status, TERMINAL.has(status), dur]);
      if (status === 'completed' && dur > 0) await meter(c, call.workspace_id, 'phone_minutes', Math.ceil(dur / 60), `call:${b.CallSid}:minutes`);
    });
    res.status(204).end();
  }));

  const recordingOk = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || cfg.telephony.apiBase.startsWith('http:') ? x.origin === new URL(cfg.telephony.apiBase).origin : false; } catch { return false; } };
  app.post('/api/v1/telephony/voice/recording', verified, h(async (req, res) => {
    const b = req.body; if (b.RecordingStatus && b.RecordingStatus !== 'completed') return res.status(204).end();
    if (!sidOk(b.RecordingSid) || !sidOk(b.CallSid) || !recordingOk(b.RecordingUrl)) return res.status(400).end();   // the url is later fetched WITH our credentials: only the provider's own origin is acceptable
    const call = await loadCall(b.CallSid); if (!call) return res.status(204).end();
    if (call.recording_basis !== 'notice_played') { log.warn('recording callback for a call where no recording notice was played; ignored', { call: call.id }); return res.status(204).end(); }
    await pool.query(`INSERT INTO portal.voicemails(workspace_id,call_session_id,profile_id,from_e164,provider_recording_sid,recording_url,duration_seconds) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (provider_recording_sid) DO NOTHING`,
      [call.workspace_id, call.id, call.profile_id, call.from_e164, b.RecordingSid, b.RecordingUrl, Number(b.RecordingDuration) || null]);
    res.status(204).end();
  }));
  app.post('/api/v1/telephony/voice/transcription', verified, h(async (req, res) => {
    const b = req.body; if (!sidOk(b.RecordingSid) || b.TranscriptionStatus !== 'completed' || typeof b.TranscriptionText !== 'string') return res.status(204).end();
    const vm = (await pool.query(`UPDATE portal.voicemails SET transcript=$2, transcript_status='received' WHERE provider_recording_sid=$1 AND deleted_at IS NULL AND transcript IS NULL RETURNING id, workspace_id`, [b.RecordingSid, b.TranscriptionText.slice(0, 20000)])).rows[0];
    if (vm) await queueSummary(pool, vm.workspace_id, vm.id);
    res.status(204).end();
  }));
  async function queueSummary(db, ws, vmId) {
    const q = await quotaFor(db, ws, 'ai.call_summaries_per_month');
    const used = Number((await db.query(`SELECT count(*) FROM portal.phone_ai_jobs WHERE workspace_id=$1 AND status IN ('queued','running','completed') AND created_at >= date_trunc('month', now())`, [ws])).rows[0].count);
    if (!llm.available || (q.quota !== null && used >= q.quota)) { await db.query(`UPDATE portal.voicemails SET summary_status='blocked' WHERE id=$1`, [vmId]); return false; }
    await db.query(`INSERT INTO portal.phone_ai_jobs(workspace_id,voicemail_id) VALUES($1,$2) ON CONFLICT (voicemail_id) DO NOTHING`, [ws, vmId]);
    await db.query(`UPDATE portal.voicemails SET summary_status='queued' WHERE id=$1`, [vmId]); return true;
  }

  // Browser dialer / TwiML application: identity = "<workspace uuid>_<user uuid>"; the user must (still) be a member and the destination must pass policy.
  app.post('/api/v1/telephony/voice/outbound', verified, h(async (req, res) => {
    const b = req.body; const m = /^client:([0-9a-f-]{36})_([0-9a-f-]{36})$/i.exec(b.From || ''); const to = b.To;
    const deny = (msg) => xmlOut(res, twiml(say(msg), hangup()));
    if (!m || !sidOk(b.CallSid)) return deny('This call cannot be completed.');
    const [ws, user] = [m[1].toLowerCase(), m[2].toLowerCase()];
    const mem = (await pool.query('SELECT role FROM portal.members WHERE workspace_id=$1 AND user_id=$2', [ws, user])).rows[0]; if (!mem) return deny('You are not allowed to place calls.');
    const dest = destinationAllowed(to, { allowInternational: t.allowInternational }); if (!dest.ok) return deny('That number cannot be dialled.');
    const num = (await pool.query(`SELECT id, e164 FROM portal.phone_numbers WHERE workspace_id=$1 AND status='active' ORDER BY created_at LIMIT 1`, [ws])).rows[0]; if (!num) return deny('Your workspace has no active phone number.');
    if (await minutesExhausted(pool, ws)) return deny('Your plan has no phone minutes left this month.');
    await pool.query(`INSERT INTO portal.call_sessions(workspace_id,direction,from_e164,to_e164,number_id,status,provider,provider_call_sid,initiated_by) VALUES($1,'outbound',$2,$3,$4,'initiated','twilio',$5,$6) ON CONFLICT (provider, provider_call_sid) DO NOTHING`, [ws, num.e164, to, num.id, b.CallSid, user]);
    return xmlOut(res, twiml(dial({ action: hook('recorded'), callerId: num.e164, numbers: [to], timeout: 30 })));
  }));
  // click-to-call leg 2: the provider fetches this when the agent answers; destination travels in the (signed) url
  app.post('/api/v1/telephony/voice/bridge', verified, h(async (req, res) => {
    const to = String(req.query.to || ''); const call = sidOk(req.body.CallSid) && (await loadCall(req.body.CallSid));
    if (!call || !destinationAllowed(to, { allowInternational: t.allowInternational }).ok || to !== call.to_e164) return xmlOut(res, twiml(say('This call cannot be completed.'), hangup()));
    return xmlOut(res, twiml(say('Connecting your call.'), dial({ action: hook('recorded'), callerId: call.from_e164, numbers: [to], timeout: 30 })));
  }));

  // ================================================================== authenticated API
  app.get('/api/v1/phone/status', member, h(async (req, res) => {
    const nums = Number((await pool.query(`SELECT count(*) FROM portal.phone_numbers WHERE workspace_id=$1 AND status='active'`, [req.workspace])).rows[0].count);
    res.set('Cache-Control', 'no-store').json({ available, reasons: available ? [] : reasons, provider: 'twilio', dialer_available: dialerAvailable && nums > 0, active_numbers: nums,
      note: available ? 'Calls and voicemails below come from real provider events.' : 'Telephony is OFF. Nothing is dialled or recorded, and the call history stays empty until it is enabled and verified.' }); }));

  // ---- profiles, hours, closures, routes
  const profileBody = z.object({
    name: z.string().trim().min(1).max(120), enabled: z.boolean().optional(), timezone: z.string().trim().max(60).optional(),
    greeting_text: z.string().trim().min(1).max(500).optional(), closed_greeting_text: z.string().trim().min(1).max(500).optional(),
    voicemail_prompt: z.string().trim().min(1).max(500).optional(), recording_notice: z.string().trim().min(10).max(500).optional(),
    voicemail_enabled: z.boolean().optional(), escalation_numbers: z.array(z.string().regex(E164)).max(5).optional()
  });
  const tzOk = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
  const mgr = (req, res) => (isManager(req.role) ? true : (res.status(403).json({ error: 'Only workspace owners and admins can change phone settings' }), false));
  app.get('/api/v1/receptionist/profiles', member, h(async (req, res) => {
    const ids = (await pool.query('SELECT id FROM portal.receptionist_profiles WHERE workspace_id=$1 ORDER BY created_at', [req.workspace])).rows;
    res.set('Cache-Control', 'no-store').json(await Promise.all(ids.map((r) => profileFull(pool, r.id))));
  }));
  app.post('/api/v1/receptionist/profiles', member, h(async (req, res) => {
    if (!mgr(req, res)) return; const p = profileBody.parse(req.body); if (p.timezone && !tzOk(p.timezone)) return res.status(400).json({ error: 'Unknown time zone' });
    const r = await pool.query(`INSERT INTO portal.receptionist_profiles(workspace_id,name,timezone,greeting_text,closed_greeting_text,voicemail_prompt,recording_notice,voicemail_enabled,escalation_numbers,created_by)
      VALUES($1,$2,COALESCE($3,'UTC'),COALESCE($4,'Thank you for calling. How can we help you?'),COALESCE($5,'Our office is closed right now.'),COALESCE($6,'Please leave a message after the tone.'),COALESCE($7,'Please note that your voicemail message will be recorded.'),COALESCE($8,true),COALESCE($9::text[],'{}'::text[]),$10) ON CONFLICT DO NOTHING RETURNING id`,
      [req.workspace, p.name, p.timezone ?? null, p.greeting_text ?? null, p.closed_greeting_text ?? null, p.voicemail_prompt ?? null, p.recording_notice ?? null, p.voicemail_enabled ?? null, p.escalation_numbers ?? null, req.actor]);
    if (!r.rowCount) return res.status(409).json({ error: 'A profile with that name already exists' });
    await audit(pool, req.workspace, req.actor, 'phone.profile_created', r.rows[0].id); res.status(201).json(await profileFull(pool, r.rows[0].id));
  }));
  const ownProfile = async (req, res) => { if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid id' }); return null; } const p = (await pool.query('SELECT * FROM portal.receptionist_profiles WHERE id=$1 AND workspace_id=$2', [req.params.id, req.workspace])).rows[0]; if (!p) res.status(404).json({ error: 'Profile not found' }); return p; };
  app.patch('/api/v1/receptionist/profiles/:id', member, h(async (req, res) => {
    if (!mgr(req, res)) return; const cur = await ownProfile(req, res); if (!cur) return; const p = profileBody.partial().parse(req.body); if (p.timezone && !tzOk(p.timezone)) return res.status(400).json({ error: 'Unknown time zone' });
    if (p.enabled === true && !(await pool.query('SELECT 1 FROM portal.business_hours WHERE profile_id=$1', [cur.id])).rowCount) return res.status(409).json({ error: 'Set business hours before enabling the receptionist', code: 'hours_required' });
    await pool.query(`UPDATE portal.receptionist_profiles SET name=COALESCE($3,name), enabled=COALESCE($4,enabled), timezone=COALESCE($5,timezone), greeting_text=COALESCE($6,greeting_text), closed_greeting_text=COALESCE($7,closed_greeting_text),
      voicemail_prompt=COALESCE($8,voicemail_prompt), recording_notice=COALESCE($9,recording_notice), voicemail_enabled=COALESCE($10,voicemail_enabled), escalation_numbers=COALESCE($11::text[],escalation_numbers), updated_at=now() WHERE id=$1 AND workspace_id=$2`,
      [cur.id, req.workspace, p.name ?? null, p.enabled ?? null, p.timezone ?? null, p.greeting_text ?? null, p.closed_greeting_text ?? null, p.voicemail_prompt ?? null, p.recording_notice ?? null, p.voicemail_enabled ?? null, p.escalation_numbers ?? null]);
    await audit(pool, req.workspace, req.actor, 'phone.profile_updated', cur.id); res.json(await profileFull(pool, cur.id));
  }));
  app.put('/api/v1/receptionist/profiles/:id/hours', member, h(async (req, res) => {
    if (!mgr(req, res)) return; const cur = await ownProfile(req, res); if (!cur) return;
    const p = z.object({ windows: z.array(z.object({ weekday: z.number().int().min(0).max(6), opens: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), closes: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).refine((w) => w.closes > w.opens, 'closes must be after opens')).max(70), closures: z.array(z.object({ on_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().max(120).optional() })).max(366).default([]) }).parse(req.body);
    const sorted = [...p.windows].sort((a, b) => a.weekday - b.weekday || a.opens.localeCompare(b.opens)); for (let i = 1; i < sorted.length; i++) if (sorted[i].weekday === sorted[i - 1].weekday && sorted[i].opens < sorted[i - 1].closes) return res.status(400).json({ error: 'Opening windows on the same day must not overlap' });
    await withWorkspaceLock(pool, req.workspace, async (c) => {
      await c.query('DELETE FROM portal.business_hours WHERE profile_id=$1', [cur.id]); await c.query('DELETE FROM portal.business_closures WHERE profile_id=$1', [cur.id]);
      for (const w of p.windows) await c.query('INSERT INTO portal.business_hours(profile_id,weekday,opens,closes) VALUES($1,$2,$3,$4)', [cur.id, w.weekday, w.opens, w.closes]);
      for (const x of p.closures) await c.query('INSERT INTO portal.business_closures(profile_id,on_date,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [cur.id, x.on_date, x.reason || null]);
      await audit(c, req.workspace, req.actor, 'phone.hours_updated', cur.id);
    });
    res.json(await profileFull(pool, cur.id));
  }));
  app.put('/api/v1/receptionist/profiles/:id/routes', member, h(async (req, res) => {
    if (!mgr(req, res)) return; const cur = await ownProfile(req, res); if (!cur) return;
    const p = z.object({ routes: z.array(z.object({ name: z.string().trim().min(1).max(120), hours: z.enum(['open', 'closed', 'any']).default('any'), digit: z.string().regex(/^[0-9*#]$/).nullish(), caller_prefix: z.string().regex(/^\+[0-9]{1,15}$/).nullish(),
      action: z.enum(['forward', 'voicemail', 'message', 'escalate', 'hangup']), destination: z.string().regex(E164).nullish(), message: z.string().max(500).nullish() }).refine((r) => r.action !== 'forward' || r.destination, 'forward needs a destination')).max(50) }).parse(req.body);
    const digits = p.routes.filter((r) => r.digit).map((r) => `${r.hours}:${r.digit}`); if (new Set(digits).size !== digits.length) return res.status(400).json({ error: 'Each menu key can be used once per hours setting' });
    await withWorkspaceLock(pool, req.workspace, async (c) => {
      await c.query('DELETE FROM portal.call_routes WHERE profile_id=$1', [cur.id]);
      let i = 0; for (const r of p.routes) await c.query(`INSERT INTO portal.call_routes(workspace_id,profile_id,position,name,hours,digit,caller_prefix,action,destination,message) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [req.workspace, cur.id, ++i, r.name, r.hours, r.digit || null, r.caller_prefix || null, r.action, r.destination || null, r.message || null]);
      await audit(c, req.workspace, req.actor, 'phone.routes_updated', cur.id);
    });
    res.json(await profileFull(pool, cur.id));
  }));

  // ---- numbers
  app.get('/api/v1/phone/numbers', member, h(async (req, res) => { if (!mgr(req, res)) return; res.json((await pool.query('SELECT id, e164, label, status, profile_id, created_at FROM portal.phone_numbers WHERE workspace_id=$1 ORDER BY created_at', [req.workspace])).rows); }));
  app.post('/api/v1/phone/numbers', member, h(async (req, res) => {
    if (!mgr(req, res)) return; const p = z.object({ e164: z.string().regex(E164), label: z.string().trim().max(80).optional(), profile_id: z.string().regex(UUID_RE).nullish() }).parse(req.body);
    const out = await withWorkspaceLock(pool, req.workspace, async (c) => {
      const q = await quotaFor(c, req.workspace, 'phone.numbers_max'); const n = Number((await c.query(`SELECT count(*) FROM portal.phone_numbers WHERE workspace_id=$1 AND status<>'disabled'`, [req.workspace])).rows[0].count);
      if (q.quota !== null && n >= q.quota) throw new PlanLimitError('phone.numbers_max', q.quota, q.plan);
      if (p.profile_id && !(await c.query('SELECT 1 FROM portal.receptionist_profiles WHERE id=$1 AND workspace_id=$2', [p.profile_id, req.workspace])).rowCount) throw err(400, 'Unknown profile', 'bad_profile');
      // a number starts as `pending`: it is activated by an owner/admin AFTER they confirmed with the provider that it is provisioned for this account
      const r = await c.query(`INSERT INTO portal.phone_numbers(workspace_id,e164,label,profile_id,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT (e164) DO NOTHING RETURNING id,e164,label,status,profile_id`, [req.workspace, p.e164, p.label || null, p.profile_id || null, req.actor]);
      if (!r.rowCount) throw err(409, 'That number is already registered', 'number_taken'); await audit(c, req.workspace, req.actor, 'phone.number_added', r.rows[0].id); return r.rows[0];
    });
    res.status(201).json(out);
  }));
  app.patch('/api/v1/phone/numbers/:id', member, h(async (req, res) => {
    if (!mgr(req, res)) return; if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const p = z.object({ status: z.enum(['pending', 'active', 'disabled']).optional(), profile_id: z.string().regex(UUID_RE).nullable().optional(), label: z.string().trim().max(80).optional() }).parse(req.body);
    if (p.status === 'active' && !available) return res.status(409).json({ error: 'Telephony is not enabled, so numbers cannot be activated', code: 'telephony_unavailable', reasons });
    if (p.profile_id && !(await pool.query('SELECT 1 FROM portal.receptionist_profiles WHERE id=$1 AND workspace_id=$2', [p.profile_id, req.workspace])).rowCount) return res.status(400).json({ error: 'Unknown profile' });
    const r = await pool.query(`UPDATE portal.phone_numbers SET status=COALESCE($3,status), profile_id=CASE WHEN $4::boolean THEN $5::uuid ELSE profile_id END, label=COALESCE($6,label) WHERE id=$1 AND workspace_id=$2 RETURNING id,e164,label,status,profile_id`, [req.params.id, req.workspace, p.status ?? null, p.profile_id !== undefined, p.profile_id ?? null, p.label ?? null]);
    if (!r.rowCount) return res.status(404).json({ error: 'Number not found' }); await audit(pool, req.workspace, req.actor, 'phone.number_updated', req.params.id); res.json(r.rows[0]);
  }));

  // ---- calls
  app.get('/api/v1/phone/calls', member, h(async (req, res) => {
    const rows = (await pool.query(`SELECT s.id, s.direction, s.from_e164, s.to_e164, s.status, s.started_at, s.answered_at, s.ended_at, s.duration_seconds, s.initiated_by, rc.outcome, rc.hours_state, rc.escalated_at
      FROM portal.call_sessions s LEFT JOIN portal.receptionist_calls rc ON rc.call_session_id=s.id WHERE s.workspace_id=$1 AND ($2::boolean OR s.initiated_by=$3) ORDER BY s.started_at DESC LIMIT 200`, [req.workspace, isManager(req.role), req.actor])).rows;
    res.set('Cache-Control', 'no-store').json(rows);
  }));
  app.post('/api/v1/phone/calls', member, (limiters.call || ((req, res, next) => next())), h(async (req, res) => {       // click-to-call: ring the user's own phone, then bridge to the destination
    if (!available) return res.status(503).json({ error: 'Telephony is not enabled', code: 'telephony_unavailable', reasons });
    const p = z.object({ my_phone: z.string().regex(E164), to: z.string().regex(E164) }).parse(req.body);
    const dest = destinationAllowed(p.to, { allowInternational: t.allowInternational }); if (!dest.ok) return res.status(400).json({ error: 'That destination is not allowed', code: dest.reason });
    const num = (await pool.query(`SELECT id, e164 FROM portal.phone_numbers WHERE workspace_id=$1 AND status='active' ORDER BY created_at LIMIT 1`, [req.workspace])).rows[0]; if (!num) return res.status(409).json({ error: 'No active phone number', code: 'no_number' });
    if (await minutesExhausted(pool, req.workspace)) throw new PlanLimitError('phone.minutes_per_month', (await quotaFor(pool, req.workspace, 'phone.minutes_per_month')).quota, (await quotaFor(pool, req.workspace, 'phone.minutes_per_month')).plan);
    let call; try { call = await provider.placeCall({ to: p.my_phone, from: num.e164, url: `${hook('bridge')}?to=${encodeURIComponent(p.to)}`, statusCallback: hook('status') }); } catch (e) { log.error('outbound call failed', { err: e.message, status: e.status }); return res.status(502).json({ error: 'The telephony provider rejected the call', code: 'provider_error' }); }
    const row = (await pool.query(`INSERT INTO portal.call_sessions(workspace_id,direction,from_e164,to_e164,number_id,status,provider,provider_call_sid,initiated_by) VALUES($1,'outbound',$2,$3,$4,'initiated','twilio',$5,$6) ON CONFLICT (provider, provider_call_sid) DO NOTHING RETURNING id,status`, [req.workspace, num.e164, p.to, num.id, call.sid, req.actor])).rows[0];
    await audit(pool, req.workspace, req.actor, 'phone.call_started', row?.id || call.sid); res.status(202).json({ id: row?.id, status: row?.status || 'initiated' });
  }));
  app.get('/api/v1/phone/dialer-token', member, h(async (req, res) => {
    if (!dialerAvailable) return res.status(503).json({ error: 'The browser dialer is not available', code: 'dialer_unavailable', reasons: available ? ['missing_dialer_credentials_or_number'] : reasons });
    if (!(await pool.query(`SELECT 1 FROM portal.phone_numbers WHERE workspace_id=$1 AND status='active'`, [req.workspace])).rowCount) return res.status(409).json({ error: 'No active phone number', code: 'no_number' });
    res.set('Cache-Control', 'no-store').json({ token: accessToken({ accountSid: t.accountSid, apiKeySid: t.apiKeySid, apiKeySecret: t.apiKeySecret, twimlAppSid: t.twimlAppSid, identity: `${req.workspace}_${req.actor}`, now }), expires_in: 600 });
  }));

  // ---- voicemails (managers; audio is proxied after our own permission check, with our credentials)
  const ownVm = async (req, res) => { if (!mgr(req, res)) return null; if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid id' }); return null; } const v = (await pool.query('SELECT * FROM portal.voicemails WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL', [req.params.id, req.workspace])).rows[0]; if (!v) res.status(404).json({ error: 'Voicemail not found' }); return v; };
  app.get('/api/v1/phone/voicemails', member, h(async (req, res) => {
    if (!mgr(req, res)) return;
    res.set('Cache-Control', 'no-store').json((await pool.query(`SELECT id, from_e164, duration_seconds, transcript, transcript_status, ai_summary, summary_status, listened_at, created_at FROM portal.voicemails WHERE workspace_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100`, [req.workspace])).rows);
  }));
  app.get('/api/v1/phone/voicemails/:id/audio', member, h(async (req, res) => {
    const v = await ownVm(req, res); if (!v) return; if (!provider) return res.status(503).json({ error: 'Telephony is not enabled' });
    let up; try { up = await provider.fetchRecording(v.recording_url); } catch (e) { return res.status(502).json({ error: 'The recording is not available from the provider' }); }
    await pool.query('UPDATE portal.voicemails SET listened_at=COALESCE(listened_at,now()), listened_by=COALESCE(listened_by,$2) WHERE id=$1', [v.id, req.actor]);
    res.set({ 'Content-Type': up.headers.get('content-type') || 'audio/mpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); res.send(Buffer.from(await up.arrayBuffer()));
  }));
  app.delete('/api/v1/phone/voicemails/:id', member, h(async (req, res) => {
    const v = await ownVm(req, res); if (!v) return;
    await pool.query(`UPDATE portal.voicemails SET deleted_at=now(), transcript=NULL, ai_summary=NULL, recording_url='deleted' WHERE id=$1`, [v.id]); await audit(pool, req.workspace, req.actor, 'phone.voicemail_deleted', v.id); res.status(204).end();
  }));
  app.post('/api/v1/phone/voicemails/:id/summarize', member, h(async (req, res) => {
    const v = await ownVm(req, res); if (!v) return; if (!v.transcript) return res.status(409).json({ error: 'There is no transcript to summarise', code: 'no_transcript' });
    if (!llm.available) return res.status(503).json({ error: 'No AI provider is configured', code: 'no_ai_provider' });
    await pool.query(`UPDATE portal.phone_ai_jobs SET status='queued', attempts=0, error_code=NULL, next_attempt_at=now() WHERE voicemail_id=$1 AND status IN ('failed','blocked')`, [v.id]);
    const queued = await queueSummary(pool, req.workspace, v.id); if (!queued) return res.status(402).json({ error: 'Your plan has no AI call summaries left this month', code: 'plan_limit' }); res.status(202).json({ queued: true });
  }));

  // ---- escalations
  app.get('/api/v1/receptionist/escalations', member, h(async (req, res) => {
    if (!mgr(req, res)) return;
    res.set('Cache-Control', 'no-store').json((await pool.query(`SELECT rc.id, rc.escalated_at, rc.escalation_acknowledged_at, s.from_e164, s.status, s.duration_seconds FROM portal.receptionist_calls rc JOIN portal.call_sessions s ON s.id=rc.call_session_id WHERE rc.workspace_id=$1 AND rc.escalated_at IS NOT NULL ORDER BY rc.escalated_at DESC LIMIT 100`, [req.workspace])).rows);
  }));
  app.post('/api/v1/receptionist/escalations/:id/acknowledge', member, h(async (req, res) => {
    if (!mgr(req, res)) return; if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const r = await pool.query(`UPDATE portal.receptionist_calls SET escalation_acknowledged_by=$3, escalation_acknowledged_at=now() WHERE id=$1 AND workspace_id=$2 AND escalated_at IS NOT NULL AND escalation_acknowledged_at IS NULL RETURNING id`, [req.params.id, req.workspace, req.actor]);
    res.status(r.rowCount ? 200 : 409).json(r.rowCount ? { acknowledged: true } : { error: 'Nothing to acknowledge', code: 'not_pending' });
  }));

  // ---- appointments (booked by staff against the receptionist's business hours; conflict-free)
  app.get('/api/v1/appointments/slots', member, h(async (req, res) => {
    const q = z.object({ profile_id: z.string().regex(UUID_RE), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), duration: z.coerce.number().int().min(15).max(240).default(30) }).parse(req.query);
    const prof = await profileFull(pool, q.profile_id); if (!prof || prof.workspace_id !== req.workspace) return res.status(404).json({ error: 'Profile not found' });
    const day0 = new Date(`${q.date}T00:00:00Z`).getTime(); const booked = (await pool.query(`SELECT starts_at, ends_at FROM portal.appointments WHERE workspace_id=$1 AND profile_id=$2 AND status='booked' AND starts_at >= $3 AND starts_at < $4`, [req.workspace, prof.id, new Date(day0 - 864e5).toISOString(), new Date(day0 + 2 * 864e5).toISOString()])).rows;
    const slots = openSlots({ timezone: prof.timezone, windows: prof.windows, closures: prof.closures, date: q.date, durationMin: q.duration, booked }).filter((s) => new Date(s).getTime() > now());
    res.set('Cache-Control', 'no-store').json({ timezone: prof.timezone, slots });
  }));
  app.get('/api/v1/appointments', member, h(async (req, res) => res.set('Cache-Control', 'no-store').json((await pool.query(`SELECT id, profile_id, title, starts_at, ends_at, attendee_name, attendee_phone, status, source, created_by FROM portal.appointments WHERE workspace_id=$1 AND ends_at >= now() - interval '1 day' ORDER BY starts_at LIMIT 200`, [req.workspace])).rows)));
  app.post('/api/v1/appointments', member, h(async (req, res) => {
    const p = z.object({ profile_id: z.string().regex(UUID_RE), title: z.string().trim().min(1).max(200), starts_at: z.string().datetime({ offset: true }), duration: z.number().int().min(15).max(240).default(30), attendee_name: z.string().trim().min(1).max(120), attendee_phone: z.string().regex(E164).nullish(), attendee_email: z.string().email().max(200).nullish(), idempotency_key: z.string().min(8).max(100) }).parse(req.body);
    const prof = await profileFull(pool, p.profile_id); if (!prof || prof.workspace_id !== req.workspace) return res.status(404).json({ error: 'Profile not found' });
    const start = new Date(p.starts_at); const end = new Date(start.getTime() + p.duration * 60000); if (start.getTime() <= now()) return res.status(400).json({ error: 'The appointment must be in the future', code: 'in_the_past' });
    const l = localParts(start, prof.timezone); const date = l.date;
    const out = await withWorkspaceLock(pool, req.workspace, async (c) => {
      const dup = (await c.query('SELECT * FROM portal.appointments WHERE workspace_id=$1 AND idempotency_key=$2', [req.workspace, p.idempotency_key])).rows[0]; if (dup) return { row: dup, dup: true };
      const booked = (await c.query(`SELECT starts_at, ends_at FROM portal.appointments WHERE workspace_id=$1 AND profile_id=$2 AND status='booked' AND starts_at < $4 AND ends_at > $3`, [req.workspace, prof.id, start.toISOString(), end.toISOString()])).rows;
      const free = openSlots({ timezone: prof.timezone, windows: prof.windows, closures: prof.closures, date, durationMin: p.duration, step: 15, booked }).includes(start.toISOString());
      if (!free) throw err(409, 'That time is not available', booked.length ? 'slot_taken' : 'outside_hours');
      const row = (await c.query(`INSERT INTO portal.appointments(workspace_id,profile_id,title,starts_at,ends_at,attendee_name,attendee_phone,attendee_email,created_by,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [req.workspace, prof.id, p.title, start.toISOString(), end.toISOString(), p.attendee_name, p.attendee_phone || null, p.attendee_email || null, req.actor, p.idempotency_key])).rows[0];
      await audit(c, req.workspace, req.actor, 'phone.appointment_booked', row.id); return { row, dup: false };
    });
    res.status(out.dup ? 200 : 201).json(out.row);
  }));
  app.post('/api/v1/appointments/:id/cancel', member, h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const a = (await pool.query('SELECT * FROM portal.appointments WHERE id=$1 AND workspace_id=$2', [req.params.id, req.workspace])).rows[0]; if (!a) return res.status(404).json({ error: 'Appointment not found' });
    if (!isManager(req.role) && a.created_by !== req.actor) return res.status(403).json({ error: 'Not allowed' });
    await pool.query(`UPDATE portal.appointments SET status='cancelled' WHERE id=$1`, [a.id]); await audit(pool, req.workspace, req.actor, 'phone.appointment_cancelled', a.id); res.json({ cancelled: true });
  }));

  // ---- analytics and usage
  app.get('/api/v1/phone/analytics', member, h(async (req, res) => {
    if (!mgr(req, res)) return; const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const [tot, perDay, outcomes, vm, esc, mins] = await Promise.all([
      pool.query(`SELECT direction, count(*)::int AS calls, count(*) FILTER (WHERE status='completed' AND COALESCE(duration_seconds,0)>0)::int AS answered, count(*) FILTER (WHERE status IN ('no_answer','busy','failed','canceled'))::int AS missed, COALESCE(round(avg(duration_seconds) FILTER (WHERE duration_seconds>0)),0)::int AS avg_seconds
        FROM portal.call_sessions WHERE workspace_id=$1 AND started_at >= now() - ($2::int * interval '1 day') GROUP BY direction`, [req.workspace, days]),
      pool.query(`SELECT to_char(date_trunc('day', started_at),'YYYY-MM-DD') AS day, count(*)::int AS calls FROM portal.call_sessions WHERE workspace_id=$1 AND started_at >= now() - ($2::int * interval '1 day') GROUP BY 1 ORDER BY 1`, [req.workspace, days]),
      pool.query(`SELECT outcome, count(*)::int AS n FROM portal.receptionist_calls WHERE workspace_id=$1 AND created_at >= now() - ($2::int * interval '1 day') GROUP BY outcome ORDER BY outcome`, [req.workspace, days]),
      pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE listened_at IS NULL)::int AS unheard FROM portal.voicemails WHERE workspace_id=$1 AND deleted_at IS NULL AND created_at >= now() - ($2::int * interval '1 day')`, [req.workspace, days]),
      pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE escalation_acknowledged_at IS NULL)::int AS open FROM portal.receptionist_calls WHERE workspace_id=$1 AND escalated_at IS NOT NULL AND created_at >= now() - ($2::int * interval '1 day')`, [req.workspace, days]),
      usedMinutes(pool, req.workspace)]);
    const q = await quotaFor(pool, req.workspace, 'phone.minutes_per_month');
    res.set('Cache-Control', 'no-store').json({ days, by_direction: tot.rows, per_day: perDay.rows, outcomes: outcomes.rows, voicemails: vm.rows[0], escalations: esc.rows[0], minutes: { used_this_month: mins, limit: q.quota, plan: q.plan } });
  }));
}
