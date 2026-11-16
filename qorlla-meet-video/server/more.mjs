import { randomUUID } from 'node:crypto';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const problem = (status, message) => Object.assign(new Error(message), { status });
const missing = error => error.code === '42P01';
export const REACTIONS = Object.freeze(['👍', '👏', '❤️', '🎉', '😂', '😮']);

/** Backend policy and durable Q&A, isolated from the five existing tab contracts. */
export function meetingMore({ db, io, room, audit = () => {}, clock = () => Date.now() }) {
  const reactionTimes = new Map();
  async function isManager(meetingId, participantId, baseRole) {
    if (baseRole === 'host') return true;
    try {
      const { rows } = await db.query('SELECT c.active FROM meet_more_moderators c JOIN meet_more_occurrences o ON o.id=c.occurrence_id WHERE o.meeting_id=$1 AND c.participant_id=$2 AND c.active=true', [meetingId, participantId]);
      return rows.length > 0;
    } catch { return false; }
  }
  async function permissions(meetingId) {
    try {
      const { rows } = await db.query('SELECT guest_chat,reactions FROM meet_more_occurrences WHERE meeting_id=$1', [meetingId]);
      return rows[0] || { guest_chat: true, reactions: true };
    } catch (error) { if (missing(error)) return { guest_chat: true, reactions: true }; throw error; }
  }
  async function chatAllowed(meetingId, participantId, role) {
    const settings = await permissions(meetingId);
    return settings.guest_chat || await isManager(meetingId, participantId, role);
  }
  async function react(meetingId, participantId, role, name, emoji) {
    if (!REACTIONS.includes(emoji)) throw problem(400, 'Choose a supported reaction.');
    if (!(await permissions(meetingId)).reactions) throw problem(403, 'Reactions are paused by the host.');
    const now = clock();
    const recent = (reactionTimes.get(participantId) || []).filter(at => now - at < 5000);
    if (recent.length >= 3) throw problem(429, 'Please wait before sending another reaction.');
    if (reactionTimes.size >= 5000 && !reactionTimes.has(participantId)) {
      for (const [id, times] of reactionTimes) if (times.every(at => now - at >= 5000)) reactionTimes.delete(id);
      if (reactionTimes.size >= 5000) throw problem(429, 'Reactions are busy. Try again shortly.');
    }
    reactionTimes.set(participantId, [...recent, now]);
    io.to(room(meetingId)).emit('reaction', { name, emoji });
    return { ok: true };
  }
  const changed = id => io.to(room(id)).emit('more:changed', { meetingId: id });
  async function transaction(meetingId, work) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Serialize policy/Q&A mutations with ending this occurrence.
      const active = await client.query('SELECT id FROM meetings WHERE id=$1 AND ended_at IS NULL FOR UPDATE', [meetingId]);
      if (!active.rows.length) throw problem(410, 'This meeting has ended.');
      await client.query('INSERT INTO meet_more_occurrences(id,meeting_id) VALUES($1,$2) ON CONFLICT(meeting_id) DO NOTHING', [randomUUID(), meetingId]);
      const { rows: [occurrence] } = await client.query('SELECT * FROM meet_more_occurrences WHERE meeting_id=$1 FOR UPDATE', [meetingId]);
      const result = await work(client, occurrence);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  const primary = actor => actor.role === 'host';
  const manager = async (client, occurrence, actor) => primary(actor) || (await client.query('SELECT participant_id FROM meet_more_moderators WHERE occurrence_id=$1 AND participant_id=$2 AND active=true', [occurrence.id, actor.participantId])).rows.length > 0;
  function register(app, auth, member) {
    const route = (method, suffix, handler) => app[method]('/api/meetings/:id/more' + suffix, auth, member, async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try { return res.json(await handler(req)); }
      catch (error) { return res.status(error.status || 503).json({ error: error.status ? error.message : 'This meeting feature is unavailable. Please try again later.' }); }
    });
    route('get', '', async req => {
      try {
        return await transaction(req.params.id, async (client, occurrence) => {
          const canManage = await manager(client, occurrence, req.user);
          const { rows: questions } = await client.query("SELECT q.id,q.question,q.answer,q.status,q.author_id,q.created_at,p.display_name AS author FROM meet_more_questions q JOIN participants p ON p.id=q.author_id WHERE q.occurrence_id=$1 AND (q.status IN ('published','answered') OR q.author_id=$2 OR $3) ORDER BY q.created_at ASC LIMIT 200", [occurrence.id, req.user.participantId, canManage]);
          const { rows: votes } = await client.query('SELECT question_id,participant_id FROM meet_more_votes WHERE occurrence_id=$1 AND active=true', [occurrence.id]);
          const { rows: participants } = canManage ? await client.query('SELECT id,display_name,role FROM participants WHERE meeting_id=$1 ORDER BY joined_at ASC LIMIT 200', [req.params.id]) : { rows: [] };
          const { rows: moderators } = canManage ? await client.query('SELECT participant_id FROM meet_more_moderators WHERE occurrence_id=$1 AND active=true', [occurrence.id]) : { rows: [] };
          const { rows: events } = canManage ? await client.query('SELECT event_type,created_at FROM audit_events WHERE meeting_id=$1 ORDER BY created_at DESC LIMIT 12', [req.params.id]) : { rows: [] };
          return { available: true, occurrenceId: occurrence.id, isHost: primary(req.user), canManage,
            permissions: { guestChat: occurrence.guest_chat, reactions: occurrence.reactions },
            questions: questions.map(({ author_id, ...question }) => ({ ...question, own: author_id === req.user.participantId, votes: votes.filter(v => v.question_id === question.id).length, voted: votes.some(v => v.question_id === question.id && v.participant_id === req.user.participantId) })),
            participants: participants.map(p => ({ id: p.id, name: p.display_name, role: p.role === 'host' ? 'host' : moderators.some(c => c.participant_id === p.id) ? 'cohost' : 'guest' })), events };
        });
      } catch (error) {
        if (!missing(error)) throw error;
        return { available: false, canManage: primary(req.user), isHost: primary(req.user), permissions: { guestChat: true, reactions: true }, questions: [], participants: [], events: [] };
      }
    });
    route('patch', '/permissions', req => transaction(req.params.id, async (client, occurrence) => {
      if (!(await manager(client, occurrence, req.user))) throw problem(403, 'Host or co-host only.');
      if (typeof req.body?.guestChat !== 'boolean' || typeof req.body?.reactions !== 'boolean') throw problem(400, 'Choose chat and reaction permissions.');
      await client.query('UPDATE meet_more_occurrences SET guest_chat=$1,reactions=$2 WHERE id=$3', [req.body.guestChat, req.body.reactions, occurrence.id]);
      return { ok: true };
    }).then(result => { changed(req.params.id); audit(req.params.id, req.user.participantId, 'more.permissions_changed'); return result; }));
    route('put', '/cohosts/:participantId', req => transaction(req.params.id, async (client, occurrence) => {
      if (!primary(req.user)) throw problem(403, 'Only the host can assign co-hosts.');
      if (!uuid(req.params.participantId) || typeof req.body?.active !== 'boolean') throw problem(400, 'Invalid co-host selection.');
      const { rows: [target] } = await client.query('SELECT role FROM participants WHERE id=$1 AND meeting_id=$2', [req.params.participantId, req.params.id]);
      if (!target || target.role === 'host') throw problem(403, 'Choose a participant in this meeting.');
      await client.query('INSERT INTO meet_more_moderators(occurrence_id,participant_id,active) VALUES($1,$2,$3) ON CONFLICT(occurrence_id,participant_id) DO UPDATE SET active=EXCLUDED.active', [occurrence.id, req.params.participantId, req.body.active]);
      return { ok: true };
    }).then(result => { changed(req.params.id); audit(req.params.id, req.user.participantId, 'more.cohost_changed'); return result; }));
    route('post', '/questions', req => transaction(req.params.id, async (client, occurrence) => {
      const question = text(req.body?.question, 1000);
      if (!question) throw problem(400, 'Write a question first.');
      const { rows } = await client.query('SELECT author_id FROM meet_more_questions WHERE occurrence_id=$1', [occurrence.id]);
      if (rows.length >= 200 || rows.filter(q => q.author_id === req.user.participantId).length >= 30) throw problem(429, 'The question limit for this meeting has been reached.');
      const published = await manager(client, occurrence, req.user);
      await client.query('INSERT INTO meet_more_questions(id,occurrence_id,author_id,question,status) VALUES($1,$2,$3,$4,$5)', [randomUUID(), occurrence.id, req.user.participantId, question, published ? 'published' : 'pending']);
      return { ok: true, pending: !published };
    }).then(result => { changed(req.params.id); return result; }));
    route('patch', '/questions/:questionId', req => transaction(req.params.id, async (client, occurrence) => {
      if (!(await manager(client, occurrence, req.user))) throw problem(403, 'Host or co-host only.');
      if (!uuid(req.params.questionId) || !['published','answered','dismissed'].includes(req.body?.status)) throw problem(400, 'Choose a valid moderation action.');
      const answer = text(req.body.answer, 2000);
      if (req.body.status === 'answered' && !answer) throw problem(400, 'Write an answer first.');
      const result = await client.query('UPDATE meet_more_questions SET status=$1,answer=$2 WHERE id=$3 AND occurrence_id=$4 RETURNING id', [req.body.status, answer, req.params.questionId, occurrence.id]);
      if (!result.rows.length) throw problem(404, 'Question not found in this meeting.');
      return { ok: true };
    }).then(result => { changed(req.params.id); audit(req.params.id, req.user.participantId, 'more.question_moderated'); return result; }));
    route('put', '/questions/:questionId/vote', req => transaction(req.params.id, async (client, occurrence) => {
      if (!uuid(req.params.questionId) || typeof req.body?.active !== 'boolean') throw problem(400, 'Invalid vote.');
      const { rows } = await client.query("SELECT id FROM meet_more_questions WHERE id=$1 AND occurrence_id=$2 AND status IN ('published','answered')", [req.params.questionId, occurrence.id]);
      if (!rows.length) throw problem(404, 'Question not available in this meeting.');
      await client.query('INSERT INTO meet_more_votes(occurrence_id,question_id,participant_id,active) VALUES($1,$2,$3,$4) ON CONFLICT(occurrence_id,question_id,participant_id) DO UPDATE SET active=EXCLUDED.active', [occurrence.id, req.params.questionId, req.user.participantId, req.body.active]);
      return { ok: true };
    }).then(result => { changed(req.params.id); return result; }));
  }
  return { register, isManager, chatAllowed, react };
}
