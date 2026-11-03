// Qorlla Phone, meeting dial-in: a caller dials a number, enters the 11-digit meeting ID and a PIN, and joins the meeting as an audio-only participant.
//
// WHAT THIS MODULE DOES (all server-side, tested): per-meeting PINs stored as scrypt verifiers (shown once, revocable, separate from the host credential and
// the web passcode); a signed-webhook IVR (signature + timestamp + replay protection + idempotent events); bounded PIN attempts per caller and per meeting;
// generic failure answers; meeting rules before admission (ended, locked, banned, waiting room / host absent); callers become participants of the SAME meeting
// (kind='phone', attendance + peak + history), appear in the waiting list, can be admitted/denied/muted/removed by the host; the meeting ending hangs every call up;
// recording consent is asked of callers (keypad), and the recording state machine counts them.
//
// LIFECYCLE (v4.24, phone-lifecycle.mjs): REQUESTED -> VERIFIED -> AWAITING_HOST -> APPROVED -> MEDIA_CONNECTING -> MEDIA_CONNECTED -> TERMINATED (+ REFUSED, TIMED_OUT, CANCELLED, ORPHANED). A correct PIN, an
// acknowledged webhook or a host's approval end at APPROVED. A caller is connected (participant online, room told, counted by recording, status 'connected') ONLY when the gateway's media report passes
// audioVerified() here: live, fresh, encrypted audio in both directions. The Security Shield is asked before APPROVED and again before MEDIA_CONNECTED, and on a timer for every open call.
//
// WHAT IT DOES NOT DO: there is no telephone carrier and no media gateway in this repository. PHONE_PROVIDER=test enables a TEST DOUBLE (calls are simulated by
// signed requests) so the rules can be tested; any other value is refused. Real inbound calls, real numbers, and bridging telephone audio into the WebRTC meeting
// need a provider adapter and a PSTN<->WebRTC gateway that do not exist here, so "mute at the media bridge" is recorded and announced but cannot silence real audio.
import crypto from 'node:crypto';
import express from 'express';
import { canMove, legacyStatus, audioVerified, cleanEvidence, newMediaToken, hashToken, tokenMatches } from './phone-lifecycle.mjs';

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

export function registerPhone({ app, io, db, auth, member, fail, room, audit, resolveMeeting, activeHas, phoneOnline, names, recording, env = process.env, provider = createProvider(env), carrier = null, shield = null, gateway = null, readiness = null, now = () => Date.now() }) {
  // GATEWAY MODE: when gateway authentication is configured, the signed telephone routes accept ONLY a verified gateway workload token (never the provider HMAC), need PHONE_GATEWAY_ENABLED=true,
  // and admission needs all six readiness conditions from an authoritative source. Without gateway configuration everything behaves as before (test double / carrier IVR).
  const gatewayMode = !!(gateway && gateway.configured), providerName = () => (gatewayMode ? 'gateway' : provider.name);
  const APPROVAL_MS = Number(env.PHONE_APPROVAL_TIMEOUT_MS || 120000), MEDIA_MS = Number(env.PHONE_MEDIA_TIMEOUT_MS || 30000), STALE_MS = Number(env.PHONE_MEDIA_STALE_MS || 45000);
  const CONFIRM_MS = Number(env.PHONE_HANGUP_CONFIRM_MS || 60000), ORPHAN_MS = Number(env.PHONE_ORPHAN_AFTER_MS || 300000), SHIELD_GRACE_MS = Number(env.SHIELD_RECHECK_GRACE_SECONDS || 120) * 1000;
  const READY_KEYS = ['carrierConnected', 'inboundNumberCertified', 'gatewayHealthy', 'mediaBridgeCertified', 'billingCertified', 'productionApproved'];

  const hashKey = crypto.createHmac('sha256', String(env.PHONE_HASH_KEY || env.JWT_SECRET || 'dev')).update('qorlla-phone-caller-v1').digest();
  const callerHash = (n) => crypto.createHmac('sha256', hashKey).update(String(n)).digest('hex');
  const hostOnly = (req, res, next) => (req.user.role === 'host' ? next() : fail(res, 403, 'Only the host can do this'));
  const confirmHangup = (id) => db.query('UPDATE phone_calls SET hangup_confirmed_at=COALESCE(hangup_confirmed_at, now()) WHERE id=$1', [id]).catch(() => {});
  // Ends the leg. Confirmation is evidence that it is really gone: a carrier that accepted the hang-up, the test double, or the gateway saying so (disconnect / media closed). Without it the sweeper escalates to ORPHANED.
  const hang = (c) => { try { if (carrier && c.provider === carrier.name) carrier.endCall(c.provider_call_id).then(() => confirmHangup(c.id)).catch(() => {}); else if (provider.name === 'test-double') { provider.hangup?.(c.provider_call_id); confirmHangup(c.id); } } catch (e) { /* the call is already gone */ } };
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
  const callView = (c) => ({ id: c.id, name: masked(c.caller_last4), status: c.status, state: c.state, muted: c.muted, joinedAt: c.connected_at, leftAt: c.ended_at, endReason: c.end_reason, provider: c.provider });
  async function connect(c, name, meetingId) {                       // the caller is let in: a participant session opens, the room is told
    await db.query("UPDATE participants SET admission='admitted', wait_reason=NULL WHERE id=$1", [c.participant_id]);
    await db.query('INSERT INTO participant_sessions(id,meeting_id,participant_id) VALUES($1,$2,$3)', [crypto.randomUUID(), meetingId, c.participant_id]);
    if (!phoneOnline.has(meetingId)) phoneOnline.set(meetingId, new Set()); phoneOnline.get(meetingId).add(c.participant_id);
    if (!names.has(meetingId)) names.set(meetingId, new Map()); names.get(meetingId).set(c.participant_id, name);
    io.to(room(meetingId)).emit('participant-online', { participantId: c.participant_id, name, role: 'guest', phone: true });
    audit(meetingId, c.participant_id, 'phone.joined', { call: c.id }); recording?.reevaluate(meetingId, 'joined', c.participant_id, 'guest').catch(() => {});
  }
  // One lifecycle move, atomic and recorded: the row is locked, the move must be allowed from its CURRENT state, the legacy `status` is derived, and the history gets a line, all in one transaction.
  async function move(id, to, reason, o = {}) {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const { rows: [cur] } = await c.query('SELECT * FROM phone_calls WHERE id=$1 FOR UPDATE', [id]);
      if (!cur || !canMove(cur.state, to)) { await c.query('ROLLBACK'); return null; }
      const status = legacyStatus(to, o.status), over = status !== 'waiting' && status !== 'connected', why = reason ? String(reason).slice(0, 60) : null, p = [id, to, status];
      let extra = '';
      if (over) { p.push(why); extra += ', ended_at=COALESCE(ended_at, now()), terminated_at=COALESCE(terminated_at, now()), end_reason=COALESCE(end_reason, $' + p.length + '::text)'; }
      if (to === 'APPROVED') extra += ', approved_at=now()';
      if (to === 'MEDIA_CONNECTED') { p.push(JSON.stringify(o.evidence || {})); extra += ', connected_at=COALESCE(connected_at, now()), media_verified_at=now(), media_evidence=$' + p.length + '::jsonb'; }
      const { rows: [u] } = await c.query('UPDATE phone_calls SET state=$2, status=$3, state_changed_at=now()' + extra + ' WHERE id=$1 RETURNING *', p);
      await c.query('INSERT INTO phone_call_events(call_id, from_state, to_state, reason) VALUES($1,$2,$3,$4)', [id, cur.state, to, why]);
      await c.query('COMMIT'); return u;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  /** Moves a call to an ending state, then removes the participant's presence (sessions, roster, room, recording). Idempotent: a call ends once. */
  async function close(c, to, reason, o = {}) {
    const u = await move(c.id, to, reason, o); if (!u) return false;
    if (u.participant_id) {
      await db.query('UPDATE participant_sessions SET disconnected_at=now() WHERE participant_id=$1 AND disconnected_at IS NULL', [u.participant_id]);
      if (to === 'REFUSED' || o.status === 'removed') await db.query("UPDATE participants SET admission='denied' WHERE id=$1", [u.participant_id]);
      phoneOnline.get(u.meeting_id)?.delete(u.participant_id);
      io.to(room(u.meeting_id)).emit('participant-offline', { participantId: u.participant_id }); io.to(room(u.meeting_id)).emit('waiting-changed', {});
      audit(u.meeting_id, u.participant_id, 'phone.left', { call: u.id, reason, state: to }); recording?.reevaluate(u.meeting_id, 'left', u.participant_id, 'guest').catch(() => {});
    }
    return true;
  }
  /** Ends a call by what happened: refused by the host, removed, or simply over (caller hung up, meeting ended): CANCELLED if it never connected, TERMINATED if it did. */
  async function leave(c, status, reason) {
    const { rows: [cur] } = await db.query('SELECT * FROM phone_calls WHERE id=$1', [c.id]); if (!cur) return false;
    const to = status === 'denied' ? 'REFUSED' : status === 'removed' ? 'TERMINATED' : cur.state === 'MEDIA_CONNECTED' ? 'TERMINATED' : ['REQUESTED', 'VERIFIED', 'AWAITING_HOST', 'APPROVED', 'MEDIA_CONNECTING'].includes(cur.state) ? 'CANCELLED' : 'TERMINATED';
    return close(cur, to, reason, { status });
  }
  /** The meeting is over (or the PIN was revoked): every call that is still up is hung up. */
  async function endAll(meetingId, reason, onlyActive) {
    const { rows } = await db.query("SELECT * FROM phone_calls WHERE meeting_id=$1 AND state IN ('REQUESTED','VERIFIED','AWAITING_HOST','APPROVED','MEDIA_CONNECTING','MEDIA_CONNECTED')", [meetingId]);
    for (const c of rows) { if (await leave(c, 'ended', reason)) hang(c); }
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
  // Two ways in, never mixed. GATEWAY MODE (gateway authentication configured): only a verified gateway workload token with the right scope, PHONE_GATEWAY_ENABLED=true, and (for admission) all six readiness
  // conditions. Otherwise the original scheme: the provider's HMAC signature (the test double) as before.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const allReady = (r) => !!r && typeof r === 'object' && READY_KEYS.every((k) => r[k] === true);
  function signed(handler, scope = 'phone.verify', o = {}) {
    return [async (req, res) => {
      try {
        const body = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : '';
        if (gatewayMode) {
          if (env.PHONE_GATEWAY_ENABLED !== 'true') return res.status(503).json({ error: 'Telephone gateway is not enabled' });
          try { await gateway.authenticate(req, scope, Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0)); }
          catch (e) { try { audit(null, null, 'phone.gateway_refused', { reason: e.reason || 'error', scope }); } catch (x) { /* audit is best effort */ } return res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 401).json({ error: e.status === 401 || e.status === 403 ? 'Gateway authentication failed' : 'Gateway unavailable' }); }
          if (o.admission) { let r = null; try { r = readiness ? (await readiness()).readiness : null; } catch { r = null; } if (!allReady(r)) return res.status(503).json({ error: 'Telephone join is not available', code: 'PHONE_JOIN_UNAVAILABLE' }); }
        } else {
          if (!provider.ready) return res.status(503).json({ error: 'Telephony is not enabled: ' + provider.reason });
          if (!provider.verify(req.get('x-qorlla-signature'), body)) return res.status(401).json({ error: 'Invalid signature' });
        }
        let j; try { j = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
        if (o.noEvent) return res.json(await handler(j));
        const eventId = String(j.eventId || ''); if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(eventId)) return res.status(400).json({ error: 'eventId required' });
        const pn = providerName();
        const ins = await db.query('INSERT INTO phone_webhook_events(event_id,provider) VALUES($1,$2) ON CONFLICT DO NOTHING', [eventId, pn]);
        if (!ins.rowCount) { const { rows: [p] } = await db.query('SELECT result FROM phone_webhook_events WHERE provider=$1 AND event_id=$2', [pn, eventId]); return res.json({ ...(p && p.result ? p.result : {}), duplicate: true }); }   // replay: same answer, no second effect
        const out = await handler(j); await db.query('UPDATE phone_webhook_events SET result=$3 WHERE provider=$1 AND event_id=$2', [pn, eventId, JSON.stringify(out)]); res.json(out);
      } catch (e) { console.error('[phone] webhook failed:', e.message); if (!res.headersSent) res.status(500).json({ error: 'Telephony request failed' }); }
    }];
  }
  const recordingState = async (meetingId) => { try { const s = await recording.publicState(meetingId); return s && s.status !== 'disabled' ? s : null; } catch { return null; } };

  const verifyCall = async (j, pn = providerName()) => {
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
    await db.query("INSERT INTO participants(id,meeting_id,display_name,role,admission,wait_reason,kind) VALUES($1,$2,$3,'guest',$4,$5,'phone')", [pid, m.id, name, wait ? 'waiting' : 'admitted', wait, ]);
    const { rows: [c] } = await db.query("INSERT INTO phone_calls(id,meeting_id,provider,provider_call_id,caller_hash,caller_last4,status,state,participant_id) VALUES($1,$2,$3,$4,$5,$6,'waiting','REQUESTED',$7) ON CONFLICT (provider,provider_call_id) DO NOTHING RETURNING *",
      [cid, m.id, pn, callId, ch, last4, pid]);
    if (!c) { await db.query('DELETE FROM participants WHERE id=$1', [pid]).catch(() => {}); return denied(); }          // the same call id twice with a new event id: refused
    await db.query("INSERT INTO phone_call_events(call_id, from_state, to_state, reason) VALUES($1,NULL,'REQUESTED','created')", [c.id]);
    await move(c.id, 'VERIFIED', 'pin_verified');                                                                         // the PIN was right. That is all this means.
    if (wait) { await move(c.id, 'AWAITING_HOST', wait); audit(m.id, pid, 'phone.waiting', { call: cid, reason: wait }); io.to(room(m.id)).emit('waiting-changed', {}); return { result: 'waiting', say: 'Please hold. The host will let you in shortly.', callRef: cid, meetingId: m.id }; }
    const ok = await approve(c); if (!ok) return denied();
    audit(m.id, pid, 'phone.approved', { call: cid });
    return { result: 'approved', say: 'Connecting you to the meeting.', callRef: cid, meetingId: m.id, mediaToken: await issueMediaToken(cid) };        // NOT connected: media must be verified first
  };
  app.post('/api/phone/ivr/verify', ...signed((j) => verifyCall(j), 'phone.verify', { admission: true }));

  const consentCall = async (j, pn = providerName()) => {                                       // keypad answer to the recording request: 1 agree, 2 decline, 9 withdraw
    const { rows: [c] } = await db.query("SELECT * FROM phone_calls WHERE provider=$1 AND provider_call_id=$2 AND status='connected'", [pn, String(j.callId || '')]); if (!c) return { result: 'denied', say: GENERIC };
    const decision = { 1: 'agree', 2: 'decline', 9: 'withdraw' }[String(j.digit)]; if (!decision) return { result: 'retry', say: 'Press 1 to agree, 2 to decline.' };
    const r = await recording.consentFor({ meetingId: c.meeting_id, participantId: c.participant_id, name: masked(c.caller_last4), decision, by: 'keypad' });
    return r.ok ? { result: decision, say: decision === 'agree' ? 'Thank you. You agreed to the recording.' : 'Understood. You declined the recording.' } : { result: 'none', say: 'There is no recording request right now.' };
  };
  app.post('/api/phone/ivr/consent', ...signed((j) => consentCall(j), 'phone.consent'));
  // The gateway (or carrier) says the leg ended: the caller hung up, or the leg Meet asked to be torn down is gone. Either way the hang-up is now CONFIRMED.
  const ended = async (j, pn = providerName()) => {
    const { rows: [c] } = await db.query('SELECT * FROM phone_calls WHERE provider=$1 AND provider_call_id=$2', [pn, String(j.callId || '')]); if (!c) return { result: 'unknown' };
    await leave(c, 'ended', String(j.type || 'caller_hung_up').slice(0, 40)); await confirmHangup(c.id); return { result: 'ended' };
  };
  app.post('/api/phone/ivr/disconnect', ...signed((j) => ended(j), 'phone.end'));
  app.post('/api/phone/webhooks/provider', ...signed((j) => ended(j), 'phone.end'));

  // ---------------------------------------------------------------- Shield, approval, media
  /** The Security Shield's decision for this caller in this meeting. With SHIELD_MEET_ENFORCE=true (or in gateway mode, always) any failure is a denial: no Shield, no admission. */
  async function shieldAllows(meetingId, participantId) {
    const must = (shield && shield.enforce) || gatewayMode; if (!must) return { allow: true, reason: 'SHIELD_OFF' };
    if (!shield || !shield.authorize) return { allow: false, reason: 'SHIELD_UNAVAILABLE' };
    try { const r = await shield.authorize(meetingId, participantId); return r && r.allow === true ? { allow: true, reason: 'ALLOW' } : { allow: false, reason: String((r && r.reason) || 'SHIELD_REFUSED') }; } catch { return { allow: false, reason: 'SHIELD_UNAVAILABLE' }; }
  }
  /** VERIFIED or AWAITING_HOST -> APPROVED, if the Shield agrees. A refusal ends the call (REFUSED). */
  async function approve(c) {
    const sh = await shieldAllows(c.meeting_id, c.participant_id);
    if (!sh.allow) { if (await close(c, 'REFUSED', 'shield_' + sh.reason.toLowerCase().slice(0, 40), { status: 'denied' })) { hang(c); audit(c.meeting_id, c.participant_id, 'phone.shield_refused', { call: c.id, reason: sh.reason }); } return false; }
    return !!(await move(c.id, 'APPROVED', 'approved'));
  }
  /** The one-time token the gateway must present with its media reports. Issued once (only its hash is kept), only while the call is APPROVED. */
  async function issueMediaToken(callId) {
    const token = newMediaToken();
    const r = await db.query("UPDATE phone_calls SET media_nonce_hash=$2, media_nonce_issued_at=now() WHERE id=$1 AND state='APPROVED' AND media_nonce_hash IS NULL RETURNING id", [callId, hashToken(token)]);
    return r.rowCount ? token : null;
  }
  const TERM = ['REFUSED', 'TIMED_OUT', 'CANCELLED', 'TERMINATED', 'ORPHANED'];
  /**
   * The gateway reports what its media is doing. Meet judges the evidence ITSELF. Only a report that passes audioVerified(), for an APPROVED call, with the right one-time token, with the Shield still saying yes,
   * makes the caller connected. A report for a call Meet has refused/ended/timed out means the gateway holds a leg Meet does not want: ORPHANED + 'terminate'.
   */
  const mediaReport = async (j, pn = providerName()) => {
    const { rows: [c] } = await db.query('SELECT * FROM phone_calls WHERE provider=$1 AND provider_call_id=$2', [pn, String(j.callId || '').slice(0, 120)]); if (!c) return { result: 'unknown', action: 'terminate' };
    const ev = cleanEvidence(j.evidence);
    if (TERM.includes(c.state)) {                                                                  // media for a call that is over
      const live = !!ev && ev.state !== 'closed' && ev.state !== 'terminating';
      if (live) {                                                                                  // audio that should not exist: refused, recorded, and reported (a call whose hang-up was already confirmed cannot change state, but it must not pass silently)
        if (c.state !== 'TERMINATED' && c.state !== 'ORPHANED') await move(c.id, 'ORPHANED', 'late_media');
        audit(c.meeting_id, c.participant_id, 'phone.late_media', { call: c.id, was: c.state }); shield?.report?.('phone_late_media', c.id)?.catch?.(() => {});
      }
      return { result: 'terminate', action: 'terminate', state: c.state };
    }
    if (!tokenMatches(j.mediaToken, c.media_nonce_hash)) return { result: 'denied', action: 'none' };       // not the gateway Meet approved this call for
    if (!['APPROVED', 'MEDIA_CONNECTING', 'MEDIA_CONNECTED'].includes(c.state)) return { result: 'not_approved', action: 'none', state: c.state };
    if (!ev) return { result: 'invalid', action: 'none' };                                            // an unreadable report changes nothing (it is not evidence, and it is not a hang-up)
    const closing = ev.state === 'closed' || ev.state === 'terminating';
    if (closing) { await leave(c, 'ended', 'media_closed'); await confirmHangup(c.id); return { result: 'terminate', action: 'terminate', state: 'TERMINATED' }; }
    const verified = audioVerified(ev, { now: now(), allowSynthetic: pn === 'test-double' });
    if (c.state === 'MEDIA_CONNECTED') {
      if (!verified) { await close(c, 'TERMINATED', 'media_unverified'); hang(c); return { result: 'terminate', action: 'terminate', state: 'TERMINATED' }; }       // connected calls must KEEP showing audio
      const sh = await shieldAllows(c.meeting_id, c.participant_id); if (!sh.allow) { await close(c, 'TERMINATED', 'shield_' + sh.reason.toLowerCase().slice(0, 40)); hang(c); return { result: 'terminate', action: 'terminate', state: 'TERMINATED' }; }
      await db.query('UPDATE phone_calls SET media_verified_at=now(), media_evidence=$2::jsonb WHERE id=$1 AND state=\'MEDIA_CONNECTED\'', [c.id, JSON.stringify(ev)]); return { result: 'connected', action: 'none', refreshed: true };
    }
    let cur = c; if (c.state === 'APPROVED') cur = (await move(c.id, 'MEDIA_CONNECTING', 'media_reported')) || c;
    if (!verified) return { result: 'connecting', action: 'none' };                                  // negotiating, one-way, silent, stale, unencrypted, wrong codec: not connected
    const { rows: [m] } = await db.query('SELECT ended_at, locked FROM meetings WHERE id=$1', [c.meeting_id]);
    if (!m || m.ended_at) { await leave(cur, 'ended', 'meeting_ended'); hang(cur); return { result: 'terminate', action: 'terminate', state: 'TERMINATED' }; }
    const sh = await shieldAllows(c.meeting_id, c.participant_id);
    if (!sh.allow) { await close(cur, 'REFUSED', 'shield_' + sh.reason.toLowerCase().slice(0, 40), { status: 'denied' }); hang(cur); return { result: 'terminate', action: 'terminate', state: 'REFUSED' }; }
    const u = await move(c.id, 'MEDIA_CONNECTED', 'media_verified', { evidence: ev }); if (!u) return { result: 'connecting', action: 'none' };
    await connect(u, masked(u.caller_last4), u.meeting_id); const rec = await recordingState(u.meeting_id);
    return { result: 'connected', action: 'none', say: 'You are connected to the meeting.', callRef: u.id, ...(rec ? { recordingNotice: true, consentPrompt: 'This meeting may be recorded only if everyone agrees. Press 1 to agree or 2 to decline.' } : {}) };
  };
  app.post('/api/phone/ivr/media', ...signed((j) => mediaReport(j), 'phone.media'));
  // Where a call stands, by the carrier/gateway's own call id (the signed counterpart of the decision route, for the test double and carrier paths): once the call is APPROVED it also hands over the media token, once.
  const statusReport = async (j, pn = providerName()) => {
    const { rows: [c] } = await db.query('SELECT id FROM phone_calls WHERE provider=$1 AND provider_call_id=$2', [pn, String(j.callId || '').slice(0, 120)]); if (!c) return { result: 'unknown' };
    const out = await decision(c.id, 0); return out && !out.busy ? { result: 'ok', ...out } : { result: 'unknown' };
  };
  app.post('/api/phone/ivr/status', ...signed((j) => statusReport(j), 'phone.decision', { noEvent: true }));
  app.post('/api/phone/ivr/gateway-health', ...signed(async (j) => { const inst = String(j.instance || ''); if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(inst)) return { result: 'invalid' }; await db.query('INSERT INTO phone_gateway_health(instance, healthy, observed_at, detail) VALUES($1,$2,now(),$3) ON CONFLICT (instance) DO UPDATE SET healthy=EXCLUDED.healthy, observed_at=now(), detail=EXCLUDED.detail', [inst, j.healthy === true, String(j.detail || '').slice(0, 200)]); return { result: 'ok' }; }, 'phone.health', { noEvent: true }));

  // The host's decision, durable and bounded: the state lives in PostgreSQL (every replica sees it), the wait is capped, and silence becomes TIMED_OUT on its own.
  let waiters = 0; const MAX_WAITERS = Number(env.PHONE_DECISION_MAX_WAITERS || 200);
  const decisionOf = (c) => ({ callRef: c.id, state: c.state, decision: c.state === 'AWAITING_HOST' || c.state === 'VERIFIED' || c.state === 'REQUESTED' ? 'pending' : ['APPROVED', 'MEDIA_CONNECTING', 'MEDIA_CONNECTED'].includes(c.state) ? 'approved' : c.state === 'REFUSED' ? 'refused' : c.state === 'TIMED_OUT' ? 'timed_out' : c.state === 'CANCELLED' ? 'cancelled' : 'ended' });
  async function decision(callRef, waitMs) {
    if (!/^[0-9a-f-]{36}$/i.test(String(callRef))) return null;
    if (waiters >= MAX_WAITERS) return { busy: true };
    waiters++;
    try {
      const deadline = Date.now() + Math.min(Math.max(0, Number(waitMs) || 0), 20000);
      for (;;) {
        await expire(callRef);
        const { rows: [c] } = await db.query('SELECT * FROM phone_calls WHERE id=$1', [callRef]); if (!c) return null;
        const out = decisionOf(c);
        if (out.decision !== 'pending' || Date.now() >= deadline) { if (c.state === 'APPROVED') out.mediaToken = (await issueMediaToken(c.id)) || undefined; return out; }
        await sleep(250);
      }
    } finally { waiters--; }
  }
  // The six readiness conditions, for the gateway (least privilege: its own scope, not the bridge secret). Same source Meet itself enforces.
  app.get('/api/phone/ivr/readiness', async (req, res) => {
    try {
      if (!gatewayMode) return res.status(404).json({ error: 'Not available' });
      try { await gateway.authenticate(req, 'phone.readiness', null); } catch (e) { return res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 401).json({ error: e.status === 401 || e.status === 403 ? 'Gateway authentication failed' : 'Gateway unavailable' }); }
      let out = null; try { out = readiness ? await readiness() : null; } catch { out = null; }
      if (!out || !out.readiness) return res.status(503).json({ error: 'Readiness unavailable' });
      res.set('Cache-Control', 'no-store').json(out);
    } catch (e) { console.error('[phone] readiness failed:', e.message); if (!res.headersSent) res.status(500).json({ error: 'Telephony request failed' }); }
  });
  app.get('/api/phone/ivr/calls/:callRef/decision', async (req, res) => {
    try {
      if (!gatewayMode) return res.status(404).json({ error: 'Not available' });
      if (env.PHONE_GATEWAY_ENABLED !== 'true') return res.status(503).json({ error: 'Telephone gateway is not enabled' });
      try { await gateway.authenticate(req, 'phone.decision', null); } catch (e) { return res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 401).json({ error: e.status === 401 || e.status === 403 ? 'Gateway authentication failed' : 'Gateway unavailable' }); }
      const out = await decision(req.params.callRef, req.query.waitMs); if (!out) return res.status(404).json({ error: 'Not available' }); if (out.busy) return res.status(429).json({ error: 'Too many waiting requests' });
      res.set('Cache-Control', 'no-store').json(out);
    } catch (e) { console.error('[phone] decision failed:', e.message); if (!res.headersSent) res.status(500).json({ error: 'Telephony request failed' }); }
  });

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
    await leave(c, 'removed', 'removed_by_host'); hang(c); audit(req.params.id, req.user.participantId, 'phone.removed', { call: c.id }); res.json({ removed: true });
  }, 'Could not remove'));
  app.get(paths('/phone-attendance'), auth, member, hostOnly, guard(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM phone_calls WHERE meeting_id=$1 ORDER BY created_at', [req.params.id]);
    res.set('Cache-Control', 'no-store').json({ calls: rows.map((c) => ({ ...callView(c), seconds: c.connected_at ? Math.max(0, Math.round(((c.ended_at ? new Date(c.ended_at) : new Date()) - new Date(c.connected_at)) / 1000)) : 0 })) });
  }, 'Phone attendance unavailable'));

  /** Called by the existing waiting-room routes: an admitted phone caller is APPROVED (media still has to be verified), a denied one is refused and hung up. */
  async function onAdmission(meetingId, ids, allow) {
    const { rows } = await db.query("SELECT * FROM phone_calls WHERE meeting_id=$1 AND participant_id = ANY($2::uuid[]) AND state='AWAITING_HOST'", [meetingId, ids]);
    for (const c of rows) { if (allow) await approve(c); else { await close(c, 'REFUSED', 'denied_by_host', { status: 'denied' }); hang(c); } }
  }
  async function onHostArrived(meetingId) {                             // "host absent" waiters are approved when the host connects
    const { rows } = await db.query("SELECT c.* FROM phone_calls c JOIN participants p ON p.id=c.participant_id WHERE c.meeting_id=$1 AND c.state='AWAITING_HOST' AND p.kind='phone' AND (p.wait_reason='host_absent' OR p.admission='admitted')", [meetingId]);
    for (const c of rows) await approve(c);
  }
  const statusOf = async (callId, pn) => { const { rows: [c] } = await db.query('SELECT status, state FROM phone_calls WHERE provider=$1 AND provider_call_id=$2', [pn, String(callId || '')]); return c ? (c.state === 'APPROVED' || c.state === 'MEDIA_CONNECTING' ? 'approved' : c.status) : null; };

  /** Approval timeout for ONE call (lazy, so a long-poll never waits on a timer): the host did not answer in time. */
  async function expire(callRef) {
    const { rows: [c] } = await db.query("SELECT * FROM phone_calls WHERE id=$1 AND state='AWAITING_HOST' AND state_changed_at < now() - ($2::int * interval '1 millisecond')", [callRef, APPROVAL_MS]);
    if (c && await close(c, 'TIMED_OUT', 'approval_timeout')) { hang(c); audit(c.meeting_id, c.participant_id, 'phone.approval_timeout', { call: c.id }); }
  }
  /**
   * The sweeper (any replica may run it, any number of times: every move is atomic and checked against the current state).
   *  - the host never answered -> TIMED_OUT;  - APPROVED but no verified media in time -> TIMED_OUT (a gateway that reports media later is told to terminate, and the call becomes ORPHANED);
   *  - MEDIA_CONNECTED but no fresh verified audio -> TERMINATED (media_lost);  - ended calls whose leg nobody confirmed gone: hang up again, and past ORPHAN_MS -> ORPHANED + an alert.
   */
  async function sweep() {
    const out = { approval: 0, media: 0, stale: 0, retried: 0, orphaned: 0 };
    for (const c of (await db.query("SELECT * FROM phone_calls WHERE state='AWAITING_HOST' AND state_changed_at < now() - ($1::int * interval '1 millisecond') LIMIT 200", [APPROVAL_MS])).rows) if (await close(c, 'TIMED_OUT', 'approval_timeout')) { hang(c); out.approval++; }
    for (const c of (await db.query("SELECT * FROM phone_calls WHERE state IN ('APPROVED','MEDIA_CONNECTING') AND state_changed_at < now() - ($1::int * interval '1 millisecond') LIMIT 200", [MEDIA_MS])).rows) if (await close(c, 'TIMED_OUT', 'media_timeout')) { hang(c); out.media++; }
    for (const c of (await db.query("SELECT * FROM phone_calls WHERE state='MEDIA_CONNECTED' AND media_verified_at < now() - ($1::int * interval '1 millisecond') LIMIT 200", [STALE_MS])).rows) if (await close(c, 'TERMINATED', 'media_lost')) { hang(c); out.stale++; }
    // Every age is computed by the DATABASE (never application clock minus database timestamp: the two clocks need not agree).
    for (const c of (await db.query("SELECT *, (terminated_at < now() - ($2::int * interval '1 millisecond')) AS past_orphan_limit FROM phone_calls WHERE hangup_confirmed_at IS NULL AND state IN ('REFUSED','TIMED_OUT','CANCELLED','TERMINATED') AND terminated_at < now() - ($1::int * interval '1 millisecond') LIMIT 200", [CONFIRM_MS, ORPHAN_MS])).rows) {
      hang(c); out.retried++;
      if (c.past_orphan_limit && await move(c.id, 'ORPHANED', 'hangup_unconfirmed')) { out.orphaned++; audit(c.meeting_id, c.participant_id, 'phone.orphaned', { call: c.id }); shield?.report?.('phone_media_orphaned', c.id)?.catch?.(() => {}); }
    }
    return out;
  }
  /** Calls the Shield must keep authorizing: everything between approval and the end. */
  const openForShield = async () => (await db.query("SELECT id, meeting_id, participant_id FROM phone_calls WHERE state IN ('APPROVED','MEDIA_CONNECTING','MEDIA_CONNECTED') AND participant_id IS NOT NULL LIMIT 500")).rows;
  let shieldOk = now();
  /** Re-checks every open call with the Shield (like Meet's session guard for signalling): revoked -> hung up now; Shield unreachable past the grace period -> every call hung up (fail closed). */
  async function shieldSweep() {
    const open = await openForShield(); if (!open.length) { shieldOk = now(); return { revoked: 0 }; }
    if (!shield || !shield.recheck) { return { revoked: await revokeCalls(open, 'SHIELD_UNAVAILABLE', now() - shieldOk > SHIELD_GRACE_MS) }; }
    let out = null; try { out = await shield.recheck(open.map((c) => ({ meetingId: c.meeting_id, participantId: c.participant_id }))); } catch { out = null; }
    if (!out || !Array.isArray(out.revoke)) return { revoked: await revokeCalls(open, 'SHIELD_UNAVAILABLE', now() - shieldOk > SHIELD_GRACE_MS) };
    shieldOk = now(); let n = 0;
    for (const rv of out.revoke) { const c = open.find((x) => x.participant_id === rv.participantId && x.meeting_id === rv.meetingId); if (c) n += await revokeCalls([c], String(rv.reason || 'REVOKED'), true); }
    return { revoked: n };
  }
  async function revokeCalls(list, reason, doIt) {
    if (!doIt) return 0; let n = 0;
    for (const o of list) { const { rows: [c] } = await db.query('SELECT * FROM phone_calls WHERE id=$1', [o.id]); if (c && await close(c, c.state === 'MEDIA_CONNECTED' ? 'TERMINATED' : 'REFUSED', 'shield_' + String(reason).toLowerCase().slice(0, 40), { status: c.state === 'MEDIA_CONNECTED' ? 'ended' : 'denied' })) { hang(c); n++; audit(c.meeting_id, c.participant_id, 'phone.revoked', { call: c.id, reason }); } }
    return n;
  }
  return { provider, verifyCall, consentCall, endedCall: ended, mediaReport, statusReport, decision, statusOf, endAll, onAdmission, onHostArrived, sweep, shieldSweep, setPin, revokePin, gatewayMode, enabled: gatewayMode ? env.PHONE_GATEWAY_ENABLED === 'true' : provider.ready,
    calls: async (meetingId) => (await db.query('SELECT * FROM phone_calls WHERE meeting_id=$1 ORDER BY created_at', [meetingId])).rows.map((c) => ({ ...callView(c), seconds: c.connected_at ? Math.max(0, Math.round(((c.ended_at ? new Date(c.ended_at) : new Date()) - new Date(c.connected_at)) / 1000)) : 0 })) };
}
