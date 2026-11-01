// Qorlla AI consent in Meet: the host's REQUEST, the participant prompt (also for late joiners), and a read-only export for the Workplace portal.
// This does NOT replace the per-person consent records (recording-store.mjs, table ai_consents: separate purposes, append-only, hash-chained audit); it adds the missing pieces around them:
//   * the host can ask everyone present (and everyone who joins later) whether their messages may be processed by Qorlla AI. Asking never counts as anyone else's answer;
//   * the portal can read who agreed to what (read-only secret), so content from people who have not agreed - or who withdrew - never reaches an AI provider;
//   * recording consent is unrelated: agreeing to be recorded never implies any AI purpose, and these answers never start or change a recording.
import { AI_PURPOSES } from './recording-store.mjs';

export const AI_NOTICE = {
  version: 'qorlla-ai-consent-2026-11',
  text: 'The host would like Qorlla AI to turn this meeting\'s chat into a summary, decisions and action items. Your messages are used only if you agree, separately for each purpose. Saying no, or changing your mind later, never removes you from the meeting; your messages are simply left out. This is separate from any recording request.',
  purposes: { transcription: 'Turn my messages into text for processing', summary: 'Include my messages in an AI summary, decisions and action items' }
};
const CORE = ['transcription', 'summary'];

export function registerAiConsent({ app, io, db, auth, fail, audit, room, getName, readAuth }) {
  const paths = (p) => ['/api/meetings/:id' + p, '/api/v1/meetings/:id' + p];
  const member = async (req, res, next) => {
    try {
      if (req.user.meetingId !== req.params.id) return fail(res, 403, 'Wrong meeting');
      const { rows } = await db.query("SELECT 1 FROM participants WHERE id=$1 AND meeting_id=$2 AND admission='admitted'", [req.user.participantId, req.params.id]); if (!rows.length) return fail(res, 403, 'Meeting unavailable'); next();
    } catch { fail(res, 500, 'Database unavailable'); }
  };
  const hostOnly = (req, res, next) => (req.user.role === 'host' ? next() : fail(res, 403, 'Only the host can do this'));
  const guard = (fn, msg) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('[ai-consent]', msg, e.message); if (!res.headersSent) fail(res, 500, msg); } };
  const requestedAt = async (meetingId) => (await db.query('SELECT ai_requested_at FROM meetings WHERE id=$1', [meetingId])).rows[0]?.ai_requested_at || null;
  const latest = async (meetingId) => (await db.query('SELECT DISTINCT ON (participant_id,purpose) participant_id, purpose, decision, created_at FROM ai_consents WHERE meeting_id=$1 ORDER BY participant_id, purpose, created_at DESC, id DESC', [meetingId])).rows;

  // the host asks; the host's own agreement is recorded like anybody else's, then everyone in the room is prompted
  app.post(paths('/ai-consent/request'), auth, member, hostOnly, guard(async (req, res) => {
    const r = await db.query('UPDATE meetings SET ai_requested_at=now(), ai_requested_by=$2 WHERE id=$1 AND ai_requested_at IS NULL AND ended_at IS NULL RETURNING ai_requested_at', [req.params.id, req.user.participantId]);
    if (!r.rowCount) return fail(res, 409, 'An AI consent request is already open, or the meeting has ended');
    const ref = await audit(req.params.id, null, req.user.participantId, 'host', 'ai_consent.requested', { purposes: CORE, noticeVersion: AI_NOTICE.version });
    const name = getName(req.params.id, req.user.participantId); const last = new Map((await latest(req.params.id)).filter((x) => x.participant_id === req.user.participantId).map((x) => [x.purpose, x.decision]));
    for (const p of CORE) if (last.get(p) !== 'agree') {
      const hr = await audit(req.params.id, null, req.user.participantId, 'host', 'ai_consent.agree', { purpose: p, by: 'host_request' });
      await db.query('INSERT INTO ai_consents(id,meeting_id,participant_id,participant_name,purpose,decision,policy_version,audit_ref) VALUES(gen_random_uuid(),$1,$2,$3,$4,\'agree\',$5,$6)', [req.params.id, req.user.participantId, name, p, AI_NOTICE.version, hr]);
    }
    io.to(room(req.params.id)).emit('ai-consent-request', { notice: AI_NOTICE, by: name });
    res.status(201).json({ requested: true, auditRef: ref, notice: AI_NOTICE });
  }, 'Could not send the AI consent request'));

  // the host closes the request: the portal sees requested=false and processes nothing further for this meeting
  app.post(paths('/ai-consent/cancel'), auth, member, hostOnly, guard(async (req, res) => {
    const r = await db.query('UPDATE meetings SET ai_requested_at=NULL WHERE id=$1 AND ai_requested_at IS NOT NULL RETURNING id', [req.params.id]);
    if (!r.rowCount) return fail(res, 409, 'There is no open AI consent request');
    const ref = await audit(req.params.id, null, req.user.participantId, 'host', 'ai_consent.request_cancelled', {});
    io.to(room(req.params.id)).emit('ai-consent-closed', {}); res.json({ requested: false, auditRef: ref });
  }, 'Could not close the AI consent request'));

  // what the page needs: the notice, whether a request is open, and the caller's OWN answers (never anybody else's)
  app.get(paths('/ai-consent'), auth, member, guard(async (req, res) => {
    const at = await requestedAt(req.params.id), mine = {}; for (const p of AI_PURPOSES) mine[p] = 'pending';
    for (const x of await latest(req.params.id)) if (x.participant_id === req.user.participantId) mine[x.purpose] = x.decision;
    res.set('Cache-Control', 'no-store').json({ requested: !!at, notice: AI_NOTICE, mine });
  }, 'AI consent state unavailable'));

  // READ-ONLY export for the Workplace portal (its own secret). Names are what people typed; decisions are the latest per person and purpose.
  app.get('/api/integrations/meetings/:id/ai-consent', readAuth, guard(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return fail(res, 400, 'Invalid meeting id');
    const m = await db.query('SELECT id, ai_requested_at FROM meetings WHERE id=$1', [req.params.id]); if (!m.rowCount) return fail(res, 404, 'Meeting unavailable');
    const { rows: ps } = await db.query("SELECT id, display_name, role FROM participants WHERE meeting_id=$1 AND admission='admitted'", [req.params.id]); const dec = await latest(req.params.id);
    res.json({ meetingId: m.rows[0].id, requested: !!m.rows[0].ai_requested_at, requestedAt: m.rows[0].ai_requested_at, noticeVersion: AI_NOTICE.version,
      participants: ps.map((p) => ({ participantId: p.id, name: p.display_name, role: p.role, decisions: Object.fromEntries(AI_PURPOSES.map((pp) => { const d = dec.find((x) => x.participant_id === p.id && x.purpose === pp); return [pp, d ? { decision: d.decision, at: d.created_at } : { decision: 'pending', at: null }]; })) })) });
  }, 'Unavailable'));

  /** Called when a socket connects: a late joiner who has not answered yet is asked at once. */
  async function onJoin(socket, meetingId, participantId) {
    try {
      if (!(await requestedAt(meetingId))) return;
      const mine = (await latest(meetingId)).filter((x) => x.participant_id === participantId && CORE.includes(x.purpose));
      if (CORE.every((p) => mine.some((x) => x.purpose === p))) return;                 // already answered both purposes
      socket.emit('ai-consent-request', { notice: AI_NOTICE, late: true });
    } catch (e) { console.error('[ai-consent] join prompt failed:', e.message); }
  }
  return { onJoin };
}
