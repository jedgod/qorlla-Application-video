// Recording consent for Qorlla Meet: a server-side state machine, the consent records and the audit trail.
//
//   (no request)  RECORDING_DISABLED  - the default for every meeting
//        |  host: POST recording/request
//        v
//     awaiting  ----- someone declines ----->  blocked   ----- they leave / host cancels ----->  (re-evaluated / cancelled)
//        |  every person in the meeting has agreed to every requested scope
//        v
//      ready  ---- host: POST recording/start ---->  recording  <---->  paused (a late joiner has not answered yet)
//                                                        |
//                                                        v   host stops, host leaves, meeting ends, someone declines or withdraws
//                                                     stopped
//
// Rules enforced HERE, not in the browser: only the host may request, start or stop; recording cannot start unless every person currently in the meeting has
// consented to everything requested; people who join later are asked and recording is held until they answer; a decline or a withdrawal stops it; a new
// request after a stop starts the whole process again. Consent rows and audit events are append-only.
//
// Honest limit: a web page cannot technically stop a participant's own computer from capturing the screen. What this module guarantees is the notice, the
// recorded consent, the host authorization gate, the visible status for everyone, the automatic stop on decline/withdrawal, and the audit trail. A future
// server-side/cloud recorder MUST call authorize() before capturing anything.
import { randomUUID } from 'node:crypto';

export const POLICY_VERSION = 'qorlla-recording-consent-2026-10';
export const LIVE = ['awaiting', 'blocked', 'ready', 'recording', 'paused'];
const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** Pure decision logic. roster: participant ids currently in the meeting. latest: Map(participantId -> {decision, video, audio}). */
export function evaluate({ session, roster, latest }) {
  const covers = (c) => !!c && c.decision === 'agree' && (!session.want_video || c.video) && (!session.want_audio || c.audio);
  const declined = roster.filter((p) => { const c = latest.get(p); return c && (c.decision === 'decline' || c.decision === 'withdraw'); });
  const pending = roster.filter((p) => !covers(latest.get(p)) && !declined.includes(p));
  const live = session.status === 'recording' || session.status === 'paused';
  if (declined.length) return { status: live ? 'stopped' : 'blocked', endReason: live ? (declined.some((p) => latest.get(p).decision === 'withdraw') ? 'consent_withdrawn' : 'declined_during_recording') : null, pending, declined };
  if (pending.length) return { status: live ? 'paused' : 'awaiting', pending, declined };
  return { status: live ? 'recording' : 'ready', pending, declined };
}

export function registerRecording({ app, io, db, auth, member, fail, room, getRoster, getName }) {
  const paths = (suffix) => [`/api/meetings/:id/recording${suffix}`, `/api/v1/meetings/:id/recording${suffix}`];
  const hostOnly = (req, res, next) => (req.user.role === 'host' ? next() : fail(res, 403, 'Only the host can do this'));
  const audit = async (meetingId, sessionId, actor, role, action, detail = {}) => {
    const ref = randomUUID();
    await db.query('INSERT INTO recording_audit(audit_ref,meeting_id,session_id,actor,actor_role,action,detail) VALUES($1,$2,$3,$4,$5,$6,$7)', [ref, meetingId, sessionId, actor, role, action, JSON.stringify(detail)]);
    return ref;
  };
  const active = async (meetingId) => (await db.query(`SELECT * FROM recording_sessions WHERE meeting_id=$1 AND status = ANY($2) LIMIT 1`, [meetingId, LIVE])).rows[0] || null;
  const latestConsents = async (sessionId) => {
    const { rows } = await db.query('SELECT DISTINCT ON (participant_id) participant_id, participant_name, role, decision, video, audio, created_at FROM recording_consents WHERE session_id=$1 ORDER BY participant_id, created_at DESC, id DESC', [sessionId]);
    return new Map(rows.map((r) => [r.participant_id, r]));
  };
  const notice = (s) => ({ sessionId: s.id, purpose: s.purpose, recipients: s.recipients, retention: s.retention, controller: s.controller, privacyContact: s.privacy_contact, privacyUrl: s.privacy_url || null, video: s.want_video, audio: s.want_audio, ai: false, policyVersion: s.policy_version });

  /** What everyone may see: the notice, the state, counts. Never who declined (the host asks for that explicitly). */
  async function publicState(meetingId) {
    const s = await active(meetingId);
    if (!s) return { status: 'disabled' };
    const roster = getRoster(meetingId), latest = await latestConsents(s.id), ev = evaluate({ session: s, roster, latest });
    return { ...notice(s), status: s.status, recorder: s.recorder_participant ? { participantId: s.recorder_participant, name: getName(meetingId, s.recorder_participant) } : null, requestedBy: getName(meetingId, s.requested_by), pending: ev.pending.length, declined: ev.declined.length, total: roster.length };
  }
  const broadcast = async (meetingId) => io.to(room(meetingId)).emit('recording-state', await publicState(meetingId));

  async function end(s, status, reason, actor, role) {
    await db.query('UPDATE recording_sessions SET status=$2, ended_at=now(), end_reason=$3 WHERE id=$1 AND status = ANY($4)', [s.id, status, reason, LIVE]);
    await audit(s.meeting_id, s.id, actor, role, status === 'cancelled' ? 'recording.cancelled' : 'recording.stopped', { reason });
  }

  /** Recompute the state after anything changed (consent, someone joined or left, start). Applies the transition and tells the room. */
  async function reevaluate(meetingId, cause, actor = null, role = null) {
    const s = await active(meetingId); if (!s) return null;
    const roster = getRoster(meetingId), latest = await latestConsents(s.id), ev = evaluate({ session: s, roster, latest });
    if (ev.status === 'stopped') await end(s, 'stopped', ev.endReason, actor, role);
    else if (ev.status !== s.status) {
      await db.query('UPDATE recording_sessions SET status=$2 WHERE id=$1', [s.id, ev.status]);
      await audit(meetingId, s.id, actor, role, 'recording.' + ev.status, { cause, pending: ev.pending.length, declined: ev.declined.length });
    }
    await broadcast(meetingId);
    return ev;
  }

  app.get(paths(''), auth, member, async (req, res) => { try { res.set('Cache-Control', 'no-store').json(await publicState(req.params.id)); } catch { fail(res, 500, 'Recording state unavailable'); } });

  // 1. the host asks to record, disclosing who/why/how long
  app.post(paths('/request'), auth, member, hostOnly, async (req, res) => {
    const b = req.body || {};
    const purpose = clip(b.purpose, 300), recipients = clip(b.recipients, 300), retention = clip(b.retention, 100), privacyContact = clip(b.privacyContact, 200);
    const controller = clip(b.controller, 120) || ('Host ' + getName(req.params.id, req.user.participantId));
    let privacyUrl = clip(b.privacyUrl, 300); if (privacyUrl && !/^https?:\/\/[^\s]+$/i.test(privacyUrl)) return fail(res, 400, 'The privacy policy link must be an http(s) address');
    const video = b.video !== false, audio = b.audio !== false;
    if (!purpose || !recipients || !retention || !privacyContact) return fail(res, 400, 'Purpose, recipients, retention period and a privacy contact must be disclosed before recording can be requested');
    if (!video && !audio) return fail(res, 400, 'Choose video, audio or both');
    try {
      const id = randomUUID();
      try { await db.query(`INSERT INTO recording_sessions(id,meeting_id,requested_by,status,purpose,recipients,retention,controller,privacy_contact,privacy_url,want_video,want_audio,policy_version) VALUES($1,$2,$3,'awaiting',$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, req.params.id, req.user.participantId, purpose, recipients, retention, controller, privacyContact, privacyUrl || null, video, audio, POLICY_VERSION]); }
      catch (e) { if (e.code === '23505') return fail(res, 409, 'A recording request is already in progress'); throw e; }
      await audit(req.params.id, id, req.user.participantId, 'host', 'recording.requested', { video, audio, policy: POLICY_VERSION });
      // the host's own agreement, recorded like anyone else's
      const ref = await audit(req.params.id, id, req.user.participantId, 'host', 'consent.agree', { video, audio, by: 'host_request' });
      await db.query(`INSERT INTO recording_consents(id,session_id,meeting_id,participant_id,participant_name,role,decision,video,audio,notice_reviewed,policy_version,audit_ref) VALUES($1,$2,$3,$4,$5,'host','agree',$6,$7,true,$8,$9)`, [randomUUID(), id, req.params.id, req.user.participantId, getName(req.params.id, req.user.participantId), video, audio, POLICY_VERSION, ref]);
      await reevaluate(req.params.id, 'requested', req.user.participantId, 'host');
      res.status(201).json(await publicState(req.params.id));
    } catch (e) { console.error('[recording] request failed:', e.message); fail(res, 500, 'Recording request failed'); }
  });

  // 2. every participant answers (agree / decline / later withdraw); each answer is a new immutable record
  app.post(paths('/consent'), auth, member, async (req, res) => {
    const b = req.body || {}; const decision = String(b.decision || '');
    if (!['agree', 'decline', 'withdraw'].includes(decision)) return fail(res, 400, 'decision must be agree, decline or withdraw');
    try {
      const s = await active(req.params.id);
      if (!s || s.id !== b.sessionId) return fail(res, 409, 'There is no recording request to answer');
      const latest = (await latestConsents(s.id)).get(req.user.participantId);
      if (decision === 'agree') {
        if (b.noticeReviewed !== true) return fail(res, 400, 'Confirm that you reviewed the recording notice');
        if ((s.want_video && b.video !== true) || (s.want_audio && b.audio !== true)) return fail(res, 400, 'Agreeing means consenting to everything requested (' + [s.want_video && 'video', s.want_audio && 'audio'].filter(Boolean).join(' and ') + '). Decline if you do not consent.');
      }
      if (decision === 'withdraw' && latest?.decision !== 'agree') return fail(res, 409, 'There is no consent to withdraw');
      const role = req.user.role === 'host' ? 'host' : 'guest', name = getName(req.params.id, req.user.participantId);
      const ref = await audit(req.params.id, s.id, req.user.participantId, role, 'consent.' + decision, { video: decision === 'agree' && !!b.video, audio: decision === 'agree' && !!b.audio });
      await db.query(`INSERT INTO recording_consents(id,session_id,meeting_id,participant_id,participant_name,role,decision,video,audio,ai,notice_reviewed,policy_version,audit_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11,$12)`, [randomUUID(), s.id, req.params.id, req.user.participantId, name, role, decision, decision === 'agree' && b.video === true, decision === 'agree' && b.audio === true, b.noticeReviewed === true, s.policy_version, ref]);
      await reevaluate(req.params.id, 'consent.' + decision, req.user.participantId, role);
      res.json({ auditRef: ref, state: await publicState(req.params.id) });
    } catch (e) { console.error('[recording] consent failed:', e.message); fail(res, 500, 'Could not record your answer'); }
  });

  // 3. who has answered what (the host sees everyone; a participant sees only their own answer)
  app.get(paths('/consents'), auth, member, async (req, res) => {
    try {
      const s = await active(req.params.id); if (!s) return res.json({ status: 'disabled', participants: [] });
      const roster = getRoster(req.params.id), latest = await latestConsents(s.id);
      const rows = roster.map((p) => { const c = latest.get(p); return { participantId: p, name: getName(req.params.id, p), decision: c?.decision || 'pending', video: !!c?.video, audio: !!c?.audio, at: c?.created_at || null }; });
      if (req.user.role === 'host') return res.set('Cache-Control', 'no-store').json({ sessionId: s.id, status: s.status, required: { video: s.want_video, audio: s.want_audio }, participants: rows });
      res.set('Cache-Control', 'no-store').json({ sessionId: s.id, status: s.status, mine: rows.find((r) => r.participantId === req.user.participantId) || { decision: 'pending' } });
    } catch { fail(res, 500, 'Consent list unavailable'); }
  });

  // 4. start: the authorization gate. Capture may only begin after this answers 200.
  app.post(paths('/start'), auth, member, hostOnly, async (req, res) => {
    try {
      let s = await active(req.params.id); if (!s) return fail(res, 409, 'Request recording and collect consent first');
      await reevaluate(req.params.id, 'start_check', req.user.participantId, 'host'); s = await active(req.params.id);
      if (!s || s.status !== 'ready') {
        const st = await publicState(req.params.id);
        await audit(req.params.id, s?.id || null, req.user.participantId, 'host', 'recording.start_refused', { status: st.status, pending: st.pending, declined: st.declined });
        return res.status(409).json({ error: st.status === 'blocked' ? 'A participant declined, so recording cannot start' : 'Not everyone in the meeting has consented yet', ...st });
      }
      await db.query(`UPDATE recording_sessions SET status='recording', started_at=now(), recorder_participant=$2 WHERE id=$1 AND status='ready'`, [s.id, req.user.participantId]);
      await audit(req.params.id, s.id, req.user.participantId, 'host', 'recording.started', { video: s.want_video, audio: s.want_audio });
      await broadcast(req.params.id);
      res.json({ recordingId: s.id, ...(await publicState(req.params.id)) });
    } catch (e) { console.error('[recording] start failed:', e.message); fail(res, 500, 'Could not start recording'); }
  });

  // 5. stop (or cancel a request that never started)
  app.post(paths('/stop'), auth, member, hostOnly, async (req, res) => {
    try {
      const s = await active(req.params.id); if (!s) return res.json({ status: 'disabled' });
      const started = s.status === 'recording' || s.status === 'paused';
      await end(s, started ? 'stopped' : 'cancelled', started ? 'host_stopped' : 'host_cancelled', req.user.participantId, 'host');
      await broadcast(req.params.id); res.json({ status: started ? 'stopped' : 'cancelled' });
    } catch { fail(res, 500, 'Could not stop recording'); }
  });

  // 6. audit trail for the host
  app.get(paths('/audit'), auth, member, hostOnly, async (req, res) => {
    try { const { rows } = await db.query('SELECT audit_ref, session_id, actor, actor_role, action, detail, created_at FROM recording_audit WHERE meeting_id=$1 ORDER BY id DESC LIMIT 200', [req.params.id]); res.set('Cache-Control', 'no-store').json({ events: rows }); }
    catch { fail(res, 500, 'Audit unavailable'); }
  });

  return {
    reevaluate, publicState, broadcast,
    /** Hook for any future server-side recorder: nothing may be captured unless this returns true. */
    authorize: async (meetingId) => { const s = await active(meetingId); if (!s || s.status !== 'recording') return false; const ev = evaluate({ session: s, roster: getRoster(meetingId), latest: await latestConsents(s.id) }); return ev.status === 'recording'; },
    /** The host left or the meeting ended: a live recording must stop. */
    stopFor: async (meetingId, reason, actor = null) => { const s = await active(meetingId); if (!s) return; await end(s, (s.status === 'recording' || s.status === 'paused') ? 'stopped' : 'cancelled', reason, actor, 'system'); await broadcast(meetingId); }
  };
}
