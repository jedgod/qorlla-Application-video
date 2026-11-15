// Meet "More" tab backend (v4.27): the parts of the More V4.1 design that can be real today, wired into Meet's own authentication, database and real-time layer.
//
//   REAL here:      Q&A (ask, vote, host answers or hides), the meeting timer (server clock, host starts and stops, everyone counts down the same moment), per-person view
//                   preferences (layout, focus mode) and the host's attendance report (from the connection sessions Meet already records). Locking the room and the quick
//                   reactions keep using the existing host settings and socket event.
//   NOT built:      whiteboard, breakout rooms, shared files, live transcript, AI summary / key takeaways / QorllaMate, background effects. They need infrastructure that does not
//                   exist yet (operation log + merge, media routing, quarantine + malware scan + object storage, STT pipeline, the consent-gated AI gateway, a video effects pipeline).
//                   The API says so (`features` is false and the routes answer 503) and the page keeps their buttons visible but disabled. Nothing reports success without a backend.
//
// Identity and permission come ONLY from the verified Meet token (`auth`) and the admitted-participant check (`member`); the page never sends an actor id. A meeting row is one
// OCCURRENCE (a reused Meeting ID + password starts a new row), so rows are keyed by meetings(id) and cannot leak into another run.
import express from 'express';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FEATURES = Object.freeze({ reactions: true, qa: true, timer: true, preferences: true, attendance: true, lock: true,
  whiteboard: false, breakouts: false, files: false, transcript: false, ai: false, background: false });
export const LAYOUTS = Object.freeze(['gallery', 'speaker', 'stage']);
export const TIMER_SECONDS = Object.freeze({ min: 10, max: 3 * 3600 });
const bad = (status, error) => Object.assign(new Error(error), { status });

export function registerMore({ app, io, db, auth, member, room, fail, rateLimit }) {
  const r = express.Router({ mergeParams: true });
  const host = (req) => req.user.role === 'host';
  const limiter = rateLimit ? rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => (req.user?.participantId || 'anon') }) : (req, res, next) => next();
  const run = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { if (e.status) return fail(res, e.status, e.message); console.error('[more]', e.message); fail(res, 500, 'Something went wrong'); });

  // Every change is written to the durable event log first, then pushed to the room; a client that missed a push catches up from /events?after=<id>.
  async function emit(meetingId, actorId, kind, payload) {
    const { rows } = await db.query('INSERT INTO more_events (meeting_id, actor_id, kind, payload) VALUES ($1,$2,$3,$4) RETURNING id', [meetingId, actorId, kind, JSON.stringify(payload)]);
    try { io.to(room(meetingId)).emit('more', { id: Number(rows[0].id), kind, payload }); } catch (e) { console.error('[more] publish failed', e.message); }
    return Number(rows[0].id);
  }
  const timerOf = (row) => (row ? { label: row.label, running: !!row.running && !!row.ends_at && new Date(row.ends_at) > new Date(), endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null, serverNow: new Date().toISOString() } : { label: '', running: false, endsAt: null, serverNow: new Date().toISOString() });

  r.use(auth, member, limiter);

  r.get('/state', run(async (req, res) => {
    const id = req.params.id;
    const [t, p, last] = await Promise.all([
      db.query('SELECT label, ends_at, running FROM more_timers WHERE meeting_id=$1', [id]),
      db.query('SELECT focus_mode, layout FROM more_preferences WHERE meeting_id=$1 AND participant_id=$2', [id, req.user.participantId]),
      db.query('SELECT COALESCE(MAX(id),0) AS last FROM more_events WHERE meeting_id=$1', [id]),
    ]);
    res.json({ features: FEATURES, timer: timerOf(t.rows[0]), preferences: p.rows[0] ? { focusMode: p.rows[0].focus_mode, layout: p.rows[0].layout } : { focusMode: false, layout: null }, lastEvent: Number(last.rows[0].last), serverNow: new Date().toISOString() });
  }));

  r.get('/events', run(async (req, res) => {
    const after = Number.parseInt(req.query.after ?? '0', 10); if (!Number.isInteger(after) || after < 0) throw bad(400, 'Invalid cursor');
    const { rows } = await db.query('SELECT id, kind, payload, created_at FROM more_events WHERE meeting_id=$1 AND id>$2 ORDER BY id LIMIT 200', [req.params.id, after]);
    res.json({ events: rows.map((e) => ({ id: Number(e.id), kind: e.kind, payload: e.payload, at: e.created_at })) });
  }));

  // ------------------------------------------------------------------ Q&A
  const questionRow = (q, mine) => ({ id: q.id, question: q.question, state: q.state, answer: q.answer, author: q.author_name, mine: q.author_id === mine, votes: Number(q.votes), voted: !!q.voted, at: q.created_at, answeredAt: q.answered_at });
  async function listQuestions(meetingId, me, isHost) {
    const { rows } = await db.query(
      `SELECT q.id, q.question, q.state, q.answer, q.author_id, q.created_at, q.answered_at, p.display_name AS author_name,
              (SELECT count(*) FROM more_question_votes v WHERE v.question_id=q.id) AS votes,
              EXISTS (SELECT 1 FROM more_question_votes v WHERE v.question_id=q.id AND v.voter_id=$2) AS voted
         FROM more_questions q JOIN participants p ON p.id=q.author_id
        WHERE q.meeting_id=$1 AND ($3 OR q.state<>'hidden') ORDER BY (q.state='answered'), votes DESC, q.created_at DESC LIMIT 100`, [meetingId, me, isHost]);
    return rows.map((q) => questionRow(q, me));
  }
  r.get('/questions', run(async (req, res) => res.json({ questions: await listQuestions(req.params.id, req.user.participantId, host(req)) })));
  r.post('/questions', run(async (req, res) => {
    const text = typeof req.body?.question === 'string' ? req.body.question.trim() : ''; if (!text || text.length > 2000) throw bad(400, 'Write a question (up to 2000 characters)');
    const { rows } = await db.query('INSERT INTO more_questions (meeting_id, author_id, question) VALUES ($1,$2,$3) RETURNING id', [req.params.id, req.user.participantId, text]);
    await emit(req.params.id, req.user.participantId, 'question.created', { id: rows[0].id }); res.status(201).json({ id: rows[0].id });
  }));
  r.post('/questions/:qid/vote', run(async (req, res) => {
    if (!UUID.test(req.params.qid)) throw bad(400, 'Invalid question');
    const q = await db.query("SELECT 1 FROM more_questions WHERE id=$1 AND meeting_id=$2 AND state<>'hidden'", [req.params.qid, req.params.id]); if (!q.rows.length) throw bad(404, 'Question not found');
    const del = await db.query('DELETE FROM more_question_votes WHERE question_id=$1 AND voter_id=$2', [req.params.qid, req.user.participantId]);
    let voted = false; if (!del.rowCount) { await db.query('INSERT INTO more_question_votes (question_id, voter_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.qid, req.user.participantId]); voted = true; }
    await emit(req.params.id, req.user.participantId, 'question.voted', { id: req.params.qid }); res.json({ voted });
  }));
  r.post('/questions/:qid/answer', run(async (req, res) => {
    if (!host(req)) throw bad(403, 'Only the host can answer questions');
    if (!UUID.test(req.params.qid)) throw bad(400, 'Invalid question'); const answer = typeof req.body?.answer === 'string' ? req.body.answer.trim() : ''; if (!answer || answer.length > 4000) throw bad(400, 'Write an answer (up to 4000 characters)');
    const { rowCount } = await db.query("UPDATE more_questions SET answer=$3, answered_by=$4, answered_at=now(), state='answered' WHERE id=$1 AND meeting_id=$2 AND state<>'hidden'", [req.params.qid, req.params.id, answer, req.user.participantId]); if (!rowCount) throw bad(404, 'Question not found');
    await emit(req.params.id, req.user.participantId, 'question.answered', { id: req.params.qid }); res.json({ ok: true });
  }));
  r.post('/questions/:qid/hide', run(async (req, res) => {
    if (!host(req)) throw bad(403, 'Only the host can hide questions'); if (!UUID.test(req.params.qid)) throw bad(400, 'Invalid question');
    const hide = req.body?.hidden !== false;
    const { rowCount } = await db.query("UPDATE more_questions SET state=CASE WHEN $3 THEN 'hidden' WHEN answer IS NOT NULL THEN 'answered' ELSE 'open' END WHERE id=$1 AND meeting_id=$2", [req.params.qid, req.params.id, hide]); if (!rowCount) throw bad(404, 'Question not found');
    await emit(req.params.id, req.user.participantId, 'question.hidden', { id: req.params.qid, hidden: hide }); res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ timer (server clock)
  r.get('/timer', run(async (req, res) => { const { rows } = await db.query('SELECT label, ends_at, running FROM more_timers WHERE meeting_id=$1', [req.params.id]); res.json(timerOf(rows[0])); }));
  r.post('/timer', run(async (req, res) => {
    if (!host(req)) throw bad(403, 'Only the host runs the timer');
    const action = req.body?.action;
    if (action === 'start') {
      const seconds = req.body?.seconds; if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < TIMER_SECONDS.min || seconds > TIMER_SECONDS.max) throw bad(400, 'Choose between 10 seconds and 3 hours');
      const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 60) : '';
      await db.query(`INSERT INTO more_timers (meeting_id, label, ends_at, running, updated_by) VALUES ($1,$2, now() + make_interval(secs => $3), true, $4)
                      ON CONFLICT (meeting_id) DO UPDATE SET label=EXCLUDED.label, ends_at=EXCLUDED.ends_at, running=true, updated_by=EXCLUDED.updated_by, updated_at=now()`, [req.params.id, label, seconds, req.user.participantId]);
    } else if (action === 'stop') {
      await db.query(`INSERT INTO more_timers (meeting_id, ends_at, running, updated_by) VALUES ($1, NULL, false, $2)
                      ON CONFLICT (meeting_id) DO UPDATE SET ends_at=NULL, running=false, updated_by=EXCLUDED.updated_by, updated_at=now()`, [req.params.id, req.user.participantId]);
    } else throw bad(400, 'Unknown timer action');
    const { rows } = await db.query('SELECT label, ends_at, running FROM more_timers WHERE meeting_id=$1', [req.params.id]); const t = timerOf(rows[0]);
    await emit(req.params.id, req.user.participantId, 'timer', t); res.json(t);
  }));

  // ------------------------------------------------------------------ preferences (mine only)
  r.put('/preferences', run(async (req, res) => {
    const b = req.body || {}; const layout = LAYOUTS.includes(b.layout) ? b.layout : null; const focus = typeof b.focusMode === 'boolean' ? b.focusMode : null;
    if (layout === null && focus === null) throw bad(400, 'Nothing to save');
    await db.query(`INSERT INTO more_preferences (meeting_id, participant_id, focus_mode, layout) VALUES ($1,$2,COALESCE($3,false),COALESCE($4,'gallery'))
                    ON CONFLICT (meeting_id, participant_id) DO UPDATE SET focus_mode=COALESCE($3, more_preferences.focus_mode), layout=COALESCE($4, more_preferences.layout), updated_at=now()`, [req.params.id, req.user.participantId, focus, layout]);
    const { rows } = await db.query('SELECT focus_mode, layout FROM more_preferences WHERE meeting_id=$1 AND participant_id=$2', [req.params.id, req.user.participantId]);
    res.json({ focusMode: rows[0].focus_mode, layout: rows[0].layout });
  }));

  // ------------------------------------------------------------------ attendance (host only; from the connection sessions Meet already records)
  r.get('/attendance', run(async (req, res) => {
    if (!host(req)) throw bad(403, 'Only the host sees the attendance report');
    const { rows } = await db.query(
      `SELECT p.id, p.display_name, p.role, min(s.connected_at) AS first_join, max(COALESCE(s.disconnected_at, s.connected_at)) AS last_seen, count(s.id) AS joins,
              bool_or(s.disconnected_at IS NULL) AS online,
              COALESCE(sum(EXTRACT(EPOCH FROM (COALESCE(s.disconnected_at, now()) - s.connected_at))),0)::int AS seconds
         FROM participants p LEFT JOIN participant_sessions s ON s.participant_id=p.id WHERE p.meeting_id=$1 AND p.admission='admitted' GROUP BY p.id ORDER BY min(s.connected_at) NULLS LAST`, [req.params.id]);
    res.json({ attendance: rows.map((a) => ({ id: a.id, name: a.display_name, role: a.role, firstJoin: a.first_join, lastSeen: a.last_seen, joins: Number(a.joins), online: !!a.online, seconds: a.seconds })) });
  }));

  // Everything the design lists but Meet cannot back yet answers 503 (never a fake success).
  for (const key of ['whiteboard', 'breakouts', 'files', 'transcript', 'ai', 'background']) r.all(`/${key}`, (req, res) => fail(res, 503, 'This tool is not available yet'));

  app.use(['/api/meetings/:id/more', '/api/v1/meetings/:id/more'], r);
  return { emit, FEATURES };
}
