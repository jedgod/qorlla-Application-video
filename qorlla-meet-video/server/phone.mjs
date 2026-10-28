// Qorlla Phone, meeting dial-in: a caller dials a number, enters the 11-digit meeting ID and a PIN, and joins the meeting as an audio-only participant.
//
// WHAT THIS MODULE DOES (all server-side, tested): per-meeting PINs stored as scrypt verifiers (shown once, revocable, separate from the host credential and
// the web passcode); a signed-webhook IVR (signature + timestamp + replay protection + idempotent events); bounded PIN attempts per caller and per meeting;
// generic failure answers; meeting rules before admission (ended, locked, banned, waiting room / host absent); callers become participants of the SAME meeting
// (kind='phone', attendance + peak + history), appear in the waiting list, can be admitted/denied/muted/removed by the host; the meeting ending hangs every call up;
// recording consent is asked of callers (keypad), and the recording state machine counts them.
//
// WHAT IT DOES NOT DO: there is no telephone carrier and no media gateway in this repository. PHONE_PROVIDER=test enables a TEST DOUBLE (calls are simulated by
// signed requests) so the rules can be tested; any other value is refused. Real inbound calls, real numbers, and bridging telephone audio into the WebRTC meeting
// need a provider adapter and a PSTN<->WebRTC gateway that do not exist here, so "mute at the media bridge" is recorded and announced but cannot silence real audio.
import crypto from 'node:crypto';
import express from 'express';

const GENERIC = 'We could not connect you to that meeting. Check the meeting ID and PIN and try again.';
const FAILS_PER_CALLER = Number(process.env.PHONE_MAX_FAILS_CALLER || 5), FAILS_PER_MEETING = Number(process.env.PHONE_MAX_FAILS_MEETING || 30);
const WINDOW_MS = Number(process.env.PHONE_ATTEMPT_WINDOW_MS || 10 * 60 * 1000), LOCK_MS = Number(process.env.PHONE_LOCK_MS || 15 * 60 * 1000), SKEW_S = Number(process.env.PHONE_SIGNATURE_SKEW_S || 300);
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const e164 = (v) => { const s = String(v ?? '').trim(); return /^\+[1-9]\d{6,14}$/.test(s) ? s : ''; };
const masked = (last4) => 'Phone ••••' + (last4 || '');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function makePin() { return String(crypto.randomInt(0, 100000000)).padStart(8, '0'); }
export const hashPin = (pin) => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex'); };
export const verifyPin = (pin, stored) => { const [salt, h] = String(stored || '').split(':'); if (!salt || !h) return false; return eq(crypto.scryptSync(String(pin), salt, 32).toString('hex'), h); };

/** Provider adapter. Only the test double exists: it verifies HMAC-SHA256 signatures over `${t}.${rawBody}` with PHONE_WEBHOOK_SECRET. */
export function createProvider(env = process.env) {
  const name = String(env.PHONE_PROVIDER || '');
  if (name !== 'test') return { name: name || null, ready: false, reason: name ? 'The "' + name + '" provider adapter is not implemented in this build' : 'Telephony is not enabled (PHONE_PROVIDER is not set)' };
  const secret = String(env.PHONE_WEBHOOK_SECRET || '');
  if (secret.length < 16) return { name: 'test-double', ready: false, reason: 'PHONE_WEBHOOK_SECRET (16+ characters) is required' };
  const sign = (raw, t = Math.floor(Date.now() / 1000)) => 't=' + t + ',v1=' + crypto.createHmac('sha256', secret).update(t + '.' + raw).digest('hex');
  return { name: 'test-double', ready: true, sign, calls: [],
    verify(header, raw) {
      const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(header || '')); if (!m) return false;
      if (Math.abs(Date.now() / 1000 - Number(m[1])) > SKEW_S) return false;                     // too old or from the future: replay protection, part 1
      return eq(m[2], crypto.createHmac('sha256', secret).update(m[1] + '.' + raw).digest('hex'));
    },
    hangup(callId) { this.calls.push({ op: 'hangup', callId, at: Date.now() }); },
    setMute(callId, muted) { this.calls.push({ op: muted ? 'mute' : 'unmute', callId, at: Date.now() }); } };
}

export function registerPhone({ app, io, db, auth, member, fail, room, audit, resolveMeeting, activeHas, phoneOnline, names, recording, env = process.env, provider = createProvider(env) }) {
  const hashKey = crypto.createHmac('sha256', String(env.PHONE_HASH_KEY || env.JWT_SECRET || 'dev')).update('qorlla-phone-caller-v1').digest();
  const callerHash = (n) => crypto.createHmac('sha256', hashKey).update(String(n)).digest('hex');
  const hostOnly = (req, res, next) => (req.user.role === 'host' ? next() : fail(res, 403, 'Only the host can do this'));
  const guard = (fn, msg) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('[phone]', msg, e.message); if (!res.headersSent) fail(res, 500, msg); } };
  const paths = (p) => ['/api/meetings/:id' + p, '/api/v1/meetings/:id' + p];

  // ---------------------------------------------------------------- PIN (host)
  async function setPin(meetingId) { const pin = makePin(); await db.query('INSERT INTO meeting_phone_access(meeting_id,pin_hash) VALUES($1,$2) ON CONFLICT (meeting_id) DO UPDATE SET pin_hash=EXCLUDED.pin_hash, rotated_at=now(), revoked_at=NULL', [meetingId, hashPin(pin)]); return pin; }
  async function revokePin(meetingId) { const r = await db.query('UPDATE meeting_phone_access SET revoked_at=now() WHERE meeting_id=$1 AND revoked_at IS NULL', [meetingId]); await endAll(meetingId, 'pin_revoked', true); return r.rowCount > 0; }
  app.post(paths('/phone-access'), auth, member, hostOnly, guard(async (req, res) => {
    const pin = await setPin(req.params.id); audit(req.params.id, req.user.participantId, 'phone.pin_set', {});
    res.status(201).set('Cache-Control', 'no-store').json({ pin, shownOnce: true, telephony: { enabled: provider.ready, provider: provider.name, note: provider.ready ? null : provider.reason } });
  }, 'Could not create the phone PIN'));
  app.delete(paths('/phone-access'), auth, member, hostOnly, guard(async (req, res) => { const done = await revokePin(req.params.id); audit(req.params.id, req.user.participantId, 'phone.pin_revoked', {}); res.json({ revoked: done }); }, 'Could not revoke'));

  // ---------------------------------------------------------------- a call joins / leaves
  const callView = (c) => ({ id: c.id, name: masked(c.caller_last4), status: c.status, muted: c.muted, joinedAt: c.connected_at, leftAt: c.ended_at, endReason: c.end_reason, provider: c.provider });
  async function connect(c, name, meetingId) {                       // the caller is let in: a participant session opens, the room is told
    await db.query("UPDATE phone_calls SET status='connected', connected_at=now() WHERE id=$1", [c.id]);
    await db.query("UPDATE participants SET admission='admitted', wait_reason=NULL WHERE id=$1", [c.participant_id]);
    await db.query('INSERT INTO participant_sessions(id,meeting_id,participant_id) VALUES($1,$2,$3)', [crypto.randomUUID(), meetingId, c.participant_id]);
    if (!phoneOnline.has(meetingId)) phoneOnline.set(meetingId, new Set()); phoneOnline.get(meetingId).add(c.participant_id);
    if (!names.has(meetingId)) names.set(meetingId, new Map()); names.get(meetingId).set(c.participant_id, name);
    io.to(room(meetingId)).emit('participant-online', { participantId: c.participant_id, name, role: 'guest', phone: true });
    audit(meetingId, c.participant_id, 'phone.joined', { call: c.id }); recording?.reevaluate(meetingId, 'joined', c.participant_id, 'guest').catch(() => {});
  }
  async function leave(c, status, reason) {                           // idempotent: a call ends once
    const { rows: [u] } = await db.query("UPDATE phone_calls SET status=$2, ended_at=now(), end_reason=$3 WHERE id=$1 AND status NOT IN ('ended','removed','denied') RETURNING *", [c.id, status, reason]); if (!u) return false;
    if (c.participant_id) {
      await db.query('UPDATE participant_sessions SET disconnected_at=now() WHERE participant_id=$1 AND disconnected_at IS NULL', [c.participant_id]);
      if (status === 'denied' || status === 'removed') await db.query("UPDATE participants SET admission='denied' WHERE id=$1", [c.participant_id]);
      phoneOnline.get(c.meeting_id)?.delete(c.participant_id);
      io.to(room(c.meeting_id)).emit('participant-offline', { participantId: c.participant_id }); io.to(room(c.meeting_id)).emit('waiting-changed', {});
      audit(c.meeting_id, c.participant_id, 'phone.left', { call: c.id, reason }); recording?.reevaluate(c.meeting_id, 'left', c.participant_id, 'guest').catch(() => {});
    }
    return true;
  }
  /** The meeting is over (or the PIN was revoked): every call that is still up is hung up. */
  async function endAll(meetingId, reason, onlyActive) {
    const { rows } = await db.query("SELECT * FROM phone_calls WHERE meeting_id=$1 AND status IN ('waiting','connected')", [meetingId]);
    for (const c of rows) { if (await leave(c, 'ended', reason)) try { provider.hangup?.(c.provider_call_id); } catch (e) { /* the call is already gone */ } }
    return rows.length;
  }

  // ---------------------------------------------------------------- bounded attempts
  async function locked(key) { const { rows: [a] } = await db.query('SELECT failures, locked_until FROM phone_attempts WHERE key=$1', [key]); return !!(a && a.locked_until && new Date(a.locked_until) > new Date()); }
  async function fail1(key, max) {
    await db.query(`INSERT INTO phone_attempts(key,failures) VALUES($1,1) ON CONFLICT (key) DO UPDATE SET
      failures = CASE WHEN phone_attempts.window_started < now() - ($2::int * interval '1 millisecond') THEN 1 ELSE phone_attempts.failures + 1 END,
      window_started = CASE WHEN phone_attempts.window_started < now() - ($2::int * interval '1 millisecond') THEN now() ELSE phone_attempts.window_started END`, [key, WINDOW_MS]);
    await db.query("UPDATE phone_attempts SET locked_until = now() + ($3::int * interval '1 millisecond') WHERE key=$1 AND failures >= $2", [key, max, LOCK_MS]);
  }
  const clear = (key) => db.query('DELETE FROM phone_attempts WHERE key=$1', [key]);

  // ---------------------------------------------------------------- signed provider requests
  function signed(handler) {
    return [async (req, res) => {
      try {
        if (!provider.ready) return res.status(503).json({ error: 'Telephony is not enabled: ' + provider.reason });
        const body = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : '';
        if (!provider.verify(req.get('x-qorlla-signature'), body)) return res.status(401).json({ error: 'Invalid signature' });
        let j; try { j = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
        const eventId = String(j.eventId || ''); if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(eventId)) return res.status(400).json({ error: 'eventId required' });
        const ins = await db.query('INSERT INTO phone_webhook_events(event_id,provider) VALUES($1,$2) ON CONFLICT DO NOTHING', [eventId, provider.name]);
        if (!ins.rowCount) { const { rows: [p] } = await db.query('SELECT result FROM phone_webhook_events WHERE provider=$1 AND event_id=$2', [provider.name, eventId]); return res.json({ ...(p && p.result ? p.result : {}), duplicate: true }); }   // replay: same answer, no second effect
        const out = await handler(j); await db.query('UPDATE phone_webhook_events SET result=$3 WHERE provider=$1 AND event_id=$2', [provider.name, eventId, JSON.stringify(out)]); res.json(out);
      } catch (e) { console.error('[phone] webhook failed:', e.message); if (!res.headersSent) res.status(500).json({ error: 'Telephony request failed' }); }
    }];
  }
  const recordingState = async (meetingId) => { try { const s = await recording.publicState(meetingId); return s && s.status !== 'disabled' ? s : null; } catch { return null; } };

  app.post('/api/phone/ivr/verify', ...signed(async (j) => {
    const num = e164(j.from), callId = String(j.callId || '').slice(0, 120), denied = (extra = {}) => ({ result: 'denied', say: GENERIC, ...extra });
    if (!num || !callId) return { result: 'denied', say: GENERIC };
    const ch = callerHash(num), ckey = 'caller:' + ch;
    if (await locked(ckey)) return { result: 'locked', say: GENERIC };                              // same words as any other failure
    const id = await resolveMeeting(digits(j.meetingId));
    const mkey = id ? 'meeting:' + id : null; if (mkey && await locked(mkey)) return { result: 'locked', say: GENERIC };
    const { rows: [m] } = id ? await db.query('SELECT id, ended_at, locked, waiting_room, join_before_host FROM meetings WHERE id=$1', [id]) : { rows: [] };
    const { rows: [acc] } = m ? await db.query('SELECT pin_hash, revoked_at FROM meeting_phone_access WHERE meeting_id=$1', [m.id]) : { rows: [] };
    const pinOk = !!(m && acc && !acc.revoked_at && /^\d{4,12}$/.test(String(j.pin || '')) && verifyPin(String(j.pin), acc.pin_hash));
    const banned = pinOk && (await db.query('SELECT 1 FROM phone_bans WHERE meeting_id=$1 AND caller_hash=$2', [m.id, ch])).rowCount > 0;
    if (!pinOk || m.ended_at || m.locked || banned) { await fail1(ckey, FAILS_PER_CALLER); if (mkey) await fail1(mkey, FAILS_PER_MEETING); return denied(); }
    await clear(ckey);
    const last4 = num.slice(-4), name = masked(last4), pid = crypto.randomUUID(), cid = crypto.randomUUID();
    const hostHere = (await db.query("SELECT id FROM participants WHERE meeting_id=$1 AND role='host'", [m.id])).rows.some((r) => activeHas(m.id, r.id));
    const wait = m.waiting_room ? 'waiting_room' : !m.join_before_host && !hostHere ? 'host_absent' : null;
    await db.query("INSERT INTO participants(id,meeting_id,display_name,role,admission,wait_reason,kind) VALUES($1,$2,$3,'guest',$4,$5,'phone')", [pid, m.id, name, wait ? 'waiting' : 'admitted', wait]);
    const { rows: [c] } = await db.query("INSERT INTO phone_calls(id,meeting_id,provider,provider_call_id,caller_hash,caller_last4,status,participant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (provider,provider_call_id) DO NOTHING RETURNING *",
      [cid, m.id, provider.name, callId, ch, last4, wait ? 'waiting' : 'connected', pid]);
    if (!c) return denied();                                                                           // the same call id twice with a new event id: refused
    audit(m.id, pid, wait ? 'phone.waiting' : 'phone.admitted', { call: cid, reason: wait });
    if (wait) { io.to(room(m.id)).emit('waiting-changed', {}); return { result: 'waiting', say: 'Please hold. The host will let you in shortly.', callRef: cid }; }
    await connect(c, name, m.id); const rec = await recordingState(m.id);
    return { result: 'connected', say: 'You are connected to the meeting.', callRef: cid, ...(rec ? { recordingNotice: true, consentPrompt: 'This meeting may be recorded only if everyone agrees. Press 1 to agree or 2 to decline.' } : {}) };
  }));

  app.post('/api/phone/ivr/consent', ...signed(async (j) => {                                       // keypad answer to the recording request: 1 agree, 2 decline, 9 withdraw
    const { rows: [c] } = await db.query("SELECT * FROM phone_calls WHERE provider=$1 AND provider_call_id=$2 AND status='connected'", [provider.name, String(j.callId || '')]); if (!c) return { result: 'denied', say: GENERIC };
    const decision = { 1: 'agree', 2: 'decline', 9: 'withdraw' }[String(j.digit)]; if (!decision) return { result: 'retry', say: 'Press 1 to agree, 2 to decline.' };
    const r = await recording.consentFor({ meetingId: c.meeting_id, participantId: c.participant_id, name: masked(c.caller_last4), decision, by: 'keypad' });
    return r.ok ? { result: decision, say: decision === 'agree' ? 'Thank you. You agreed to the recording.' : 'Understood. You declined the recording.' } : { result: 'none', say: 'There is no recording request right now.' };
  }));
  const ended = async (j) => { const { rows: [c] } = await db.query('SELECT * FROM phone_calls WHERE provider=$1 AND provider_call_id=$2', [provider.name, String(j.callId || '')]); if (!c) return { result: 'unknown' }; await leave(c, 'ended', String(j.type || 'caller_hung_up').slice(0, 40)); return { result: 'ended' }; };
  app.post('/api/phone/ivr/disconnect', ...signed(ended));
  app.post('/api/phone/webhooks/provider', ...signed(ended));

  // ---------------------------------------------------------------- the host
  app.post(paths('/phone/:cid/mute'), auth, member, hostOnly, guard(async (req, res) => {
    const muted = req.body?.muted !== false; const { rows: [c] } = await db.query("UPDATE phone_calls SET muted=$3 WHERE id=$1 AND meeting_id=$2 AND status='connected' RETURNING *", [req.params.cid, req.params.id, muted]); if (!c) return fail(res, 404, 'No such caller');
    try { provider.setMute?.(c.provider_call_id, muted); } catch (e) { /* adapter unavailable */ }
    audit(req.params.id, req.user.participantId, muted ? 'phone.muted' : 'phone.unmuted', { call: c.id }); io.to(room(req.params.id)).emit('phone-state', { participantId: c.participant_id, muted });
    res.json({ ...callView(c), bridged: false, note: 'Muting at the media bridge needs a PSTN gateway, which this build does not include: the state is recorded and announced only.' });
  }, 'Could not mute'));
  app.post(paths('/phone/:cid/remove'), auth, member, hostOnly, guard(async (req, res) => {
    const { rows: [c] } = await db.query("SELECT * FROM phone_calls WHERE id=$1 AND meeting_id=$2 AND status IN ('waiting','connected')", [req.params.cid, req.params.id]); if (!c) return fail(res, 404, 'No such caller');
    await db.query('INSERT INTO phone_bans(meeting_id,caller_hash) VALUES($1,$2) ON CONFLICT DO NOTHING', [c.meeting_id, c.caller_hash]);       // a removed caller cannot dial back in to this meeting
    await leave(c, 'removed', 'removed_by_host'); try { provider.hangup?.(c.provider_call_id); } catch (e) { /* gone */ } audit(req.params.id, req.user.participantId, 'phone.removed', { call: c.id }); res.json({ removed: true });
  }, 'Could not remove'));
  app.get(paths('/phone-attendance'), auth, member, hostOnly, guard(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM phone_calls WHERE meeting_id=$1 ORDER BY created_at', [req.params.id]);
    res.set('Cache-Control', 'no-store').json({ calls: rows.map((c) => ({ ...callView(c), seconds: c.connected_at ? Math.max(0, Math.round(((c.ended_at ? new Date(c.ended_at) : new Date()) - new Date(c.connected_at)) / 1000)) : 0 })) });
  }, 'Phone attendance unavailable'));

  /** Called by the existing waiting-room routes: admitted phone callers connect, denied ones are hung up. */
  async function onAdmission(meetingId, ids, allow) {
    const { rows } = await db.query("SELECT * FROM phone_calls WHERE meeting_id=$1 AND participant_id = ANY($2::uuid[]) AND status='waiting'", [meetingId, ids]);
    for (const c of rows) { if (allow) await connect(c, masked(c.caller_last4), meetingId); else { await leave(c, 'denied', 'denied_by_host'); try { provider.hangup?.(c.provider_call_id); } catch (e) { /* gone */ } } }
  }
  async function onHostArrived(meetingId) {                             // "host absent" waiters are let in when the host connects
    const { rows } = await db.query("SELECT c.* FROM phone_calls c JOIN participants p ON p.id=c.participant_id WHERE c.meeting_id=$1 AND c.status='waiting' AND p.kind='phone' AND (p.wait_reason='host_absent' OR p.admission='admitted')", [meetingId]);
    for (const c of rows) await connect(c, masked(c.caller_last4), meetingId);
  }
  return { provider, endAll, onAdmission, onHostArrived, setPin, revokePin, enabled: provider.ready,
    calls: async (meetingId) => (await db.query('SELECT * FROM phone_calls WHERE meeting_id=$1 ORDER BY created_at', [meetingId])).rows.map((c) => ({ ...callView(c), seconds: c.connected_at ? Math.max(0, Math.round(((c.ended_at ? new Date(c.ended_at) : new Date()) - new Date(c.connected_at)) / 1000)) : 0 })) };
}
