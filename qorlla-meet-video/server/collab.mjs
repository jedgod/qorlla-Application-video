// Qorlla Meet collaboration backend: structured meeting notes (autosave, revisions, edit grants, post-meeting access) and polls (server-authoritative:
// one ballot per participant, host-controlled publication, anonymous ballots that cannot be tied to a person).
//
// Permissions are checked HERE, never in the browser: only the host (or a participant the host granted) edits notes; only the host creates, launches, closes,
// publishes, exports and deletes polls; every participant may vote once while a poll is open. Reading notes/polls stays possible after the meeting ended.
import { randomUUID } from 'node:crypto';

const strip = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, n);
const line = (v, n) => strip(v, n).replace(/\s+/g, ' ').trim();
const newId = () => randomUUID().slice(0, 8);
const goodId = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(x);
export const SECTIONS = ['template', 'agenda', 'notes', 'decisions', 'tasks'];
export const EMPTY_DOC = () => ({ template: '', agenda: [], notes: '', decisions: [], tasks: [] });
const secs = (n) => { n = Number(n); return Number.isFinite(n) ? Math.max(0, Math.min(86400, Math.round(n))) : 0; };

/** Validate and clean a notes document (or the listed sections of one). Unknown fields are dropped; sizes are capped. */
export function normalizeDoc(d) {
  d = d && typeof d === 'object' ? d : {};
  const list = (a, max, f) => (Array.isArray(a) ? a.slice(0, max).map(f) : []);
  return {
    template: line(d.template, 30),
    agenda: list(d.agenda, 100, (x) => ({ id: goodId(x?.id) ? x.id : newId(), text: line(x?.text, 300), done: x?.done === true })),
    notes: strip(d.notes, 20000),
    decisions: list(d.decisions, 100, (x) => ({ id: goodId(x?.id) ? x.id : newId(), text: line(x?.text, 400), owner: line(x?.owner, 80), at: secs(x?.at), by: line(x?.by, 60) })),
    tasks: list(d.tasks, 200, (x) => ({ id: goodId(x?.id) ? x.id : newId(), text: line(x?.text, 400), owner: line(x?.owner, 80), due: /^\d{4}-\d{2}-\d{2}$/.test(x?.due || '') ? x.due : '', status: x?.status === 'done' ? 'done' : 'open', at: secs(x?.at) })),
  };
}

const KINDS = ['single', 'multiple', 'yesno', 'rating', 'ranking'];
/** Validate a poll definition. Returns { error } or the clean fields. */
export function cleanPoll(b) {
  b = b || {};
  const question = line(b.question, 300); if (!question) return { error: 'A question is required' };
  const kind = String(b.kind || 'single'); if (!KINDS.includes(kind)) return { error: 'Unknown poll type' };
  let options = [], scale = null;
  if (kind === 'yesno') options = ['Yes', 'No'];
  else if (kind === 'rating') { scale = Number(b.scale ?? 5); if (![3, 5, 10].includes(scale)) return { error: 'Rating scale must be 3, 5 or 10' }; }
  else { options = (Array.isArray(b.options) ? b.options : []).map((o) => line(o, 100)).filter(Boolean); if (options.length < 2 || options.length > 10) return { error: 'Give between 2 and 10 options' }; if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return { error: 'Options must be different' }; }
  const quiz = b.quiz === true; let correct = null;
  if (quiz) {
    if (!['single', 'multiple', 'yesno'].includes(kind)) return { error: 'Quiz mode needs a single-choice, multiple-choice or yes/no poll' };
    correct = [...new Set((Array.isArray(b.correct) ? b.correct : []).map(Number))].filter((i) => Number.isInteger(i) && i >= 0 && i < options.length).sort((x, y) => x - y);
    if (!correct.length || (kind !== 'multiple' && correct.length !== 1)) return { error: 'Mark the correct answer' };
  }
  const durationSec = b.durationSec ? Math.max(15, Math.min(3600, Math.round(Number(b.durationSec)) || 0)) : null;
  return { question, kind, options, scale, anonymous: b.anonymous === true, liveResults: b.liveResults === true, quiz, correct, explanation: quiz ? line(b.explanation, 400) : '', durationSec };
}

/** Validate one ballot against a poll. Returns { choices } or { error }. */
export function cleanBallot(poll, raw) {
  const arr = Array.isArray(raw) ? raw.map(Number) : [];
  if (!arr.every((n) => Number.isInteger(n))) return { error: 'Invalid answer' };
  const n = poll.options.length;
  if (poll.kind === 'single' || poll.kind === 'yesno') return arr.length === 1 && arr[0] >= 0 && arr[0] < n ? { choices: arr } : { error: 'Choose one answer' };
  if (poll.kind === 'multiple') { const u = [...new Set(arr)]; return u.length && u.length === arr.length && u.every((i) => i >= 0 && i < n) ? { choices: u.sort((a, b) => a - b) } : { error: 'Choose at least one answer' }; }
  if (poll.kind === 'rating') return arr.length === 1 && arr[0] >= 1 && arr[0] <= poll.scale ? { choices: arr } : { error: 'Choose a rating' };
  if (poll.kind === 'ranking') { const ok = arr.length === n && new Set(arr).size === n && arr.every((i) => i >= 0 && i < n); return ok ? { choices: arr } : { error: 'Rank every option' }; }
  return { error: 'Invalid answer' };
}

/** Aggregate ballots. Never needs to know who voted. */
export function tally(poll, ballots) {
  const total = ballots.length, n = poll.options.length;
  if (poll.kind === 'rating') { const counts = Array.from({ length: poll.scale }, () => 0); let sum = 0; for (const b of ballots) { counts[b[0] - 1]++; sum += b[0]; } return { total, counts, average: total ? Math.round((sum / total) * 100) / 100 : null }; }
  if (poll.kind === 'ranking') { const score = Array(n).fill(0), first = Array(n).fill(0); for (const b of ballots) { b.forEach((opt, pos) => { score[opt] += n - pos; }); first[b[0]]++; } return { total, score, first }; }
  const counts = Array(n).fill(0); for (const b of ballots) for (const i of b) counts[i]++;
  const out = { total, counts };
  if (poll.quiz && poll.correct) { const c = new Set(poll.correct); out.correctCount = ballots.filter((b) => b.length === c.size && b.every((i) => c.has(i))).length; }
  return out;
}
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

export function registerCollab({ app, io, db, auth, fail, room, getName, audit, getRoster }) {
  const paths = (p) => ['/api/meetings/:id' + p, '/api/v1/meetings/:id' + p];
  // Any participant of the meeting, even after it ended (post-meeting review); `edit` routes use `live` as well.
  const participant = async (req, res, next) => {
    try {
      if (req.user.meetingId !== req.params.id) return fail(res, 403, 'Wrong meeting');
      const { rows } = await db.query("SELECT m.ended_at FROM meetings m JOIN participants p ON p.meeting_id=m.id WHERE m.id=$1 AND p.id=$2 AND p.admission='admitted'", [req.params.id, req.user.participantId]);
      if (!rows.length) return fail(res, 403, 'Meeting unavailable'); req.ended = !!rows[0].ended_at; next();
    } catch { fail(res, 500, 'Database unavailable'); }
  };
  const live = (req, res, next) => (req.ended ? fail(res, 403, 'The meeting has ended') : next());
  const hostOnly = (req, res, next) => (req.user.role === 'host' ? next() : fail(res, 403, 'Only the host can do this'));
  const guard = (fn, msg) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('[collab]', msg, e.message); if (!res.headersSent) fail(res, 500, msg); } };

  // ------------------------------------------------------------------ notes
  async function loadNotes(meetingId) {
    let { rows: [n] } = await db.query('SELECT * FROM meeting_notes WHERE meeting_id=$1', [meetingId]);
    if (!n) {                                                     // first use: carry over anything typed in the old single text box
      const { rows: [m] } = await db.query('SELECT notes FROM meetings WHERE id=$1', [meetingId]); const doc = EMPTY_DOC(); doc.notes = strip(m?.notes, 20000);
      await db.query('INSERT INTO meeting_notes(meeting_id,doc,version) VALUES($1,$2,1) ON CONFLICT DO NOTHING', [meetingId, JSON.stringify(doc)]);
      ({ rows: [n] } = await db.query('SELECT * FROM meeting_notes WHERE meeting_id=$1', [meetingId]));
    }
    return n;
  }
  const editorIds = async (meetingId) => (await db.query('SELECT participant_id FROM notes_editors WHERE meeting_id=$1', [meetingId])).rows.map((r) => r.participant_id);
  const canEdit = async (req) => req.user.role === 'host' || (await db.query('SELECT 1 FROM notes_editors WHERE meeting_id=$1 AND participant_id=$2', [req.params.id, req.user.participantId])).rowCount > 0;
  const notesView = async (req, n) => ({ doc: n.doc, version: n.version, updatedBy: n.updated_by_name || null, updatedAt: n.updated_at, canEdit: !req.ended && (await canEdit(req)), isHost: req.user.role === 'host', ended: !!req.ended, editors: await editorIds(req.params.id) });
  const lastRevision = async (c, meetingId) => (await c.query('SELECT version,saved_by,created_at,reason FROM meeting_notes_revisions WHERE meeting_id=$1 ORDER BY version DESC LIMIT 1', [meetingId])).rows[0];

  app.get(paths('/notes'), auth, participant, guard(async (req, res) => { res.set('Cache-Control', 'no-store').json(await notesView(req, await loadNotes(req.params.id))); }, 'Notes unavailable'));

  // Save: only the sections the client says it changed are applied, onto the CURRENT document, so two editors in different sections never overwrite each other.
  app.patch(paths('/notes'), auth, participant, live, guard(async (req, res) => {
    if (!(await canEdit(req))) return fail(res, 403, 'You do not have edit access to the notes');
    const b = req.body || {}; const want = (Array.isArray(b.sections) ? b.sections : []).filter((s) => SECTIONS.includes(s)); if (!want.length) return fail(res, 400, 'Nothing to save');
    if (JSON.stringify(b.doc || {}).length > 70000) return fail(res, 413, 'Notes are too large');
    const incoming = normalizeDoc(b.doc), name = getName(req.params.id, req.user.participantId);
    const c = await db.connect();
    try {
      await c.query('BEGIN'); await loadNotes(req.params.id);
      const { rows: [cur] } = await c.query('SELECT * FROM meeting_notes WHERE meeting_id=$1 FOR UPDATE', [req.params.id]);
      const next = { ...cur.doc }; for (const s of want) next[s] = incoming[s];
      if (JSON.stringify(next) === JSON.stringify(cur.doc)) { await c.query('COMMIT'); return res.json({ version: cur.version, doc: cur.doc, changed: false }); }
      const version = cur.version + 1;
      await c.query('UPDATE meeting_notes SET doc=$2,version=$3,updated_by=$4,updated_by_name=$5,updated_at=now() WHERE meeting_id=$1', [req.params.id, JSON.stringify(next), version, req.user.participantId, name]);
      const last = await lastRevision(c, req.params.id);                                   // autosave coalesces: a new snapshot at most every 30 s per author
      if (!last || last.saved_by !== req.user.participantId || Date.now() - new Date(last.created_at).getTime() > 30000 || want.includes('template'))
        await c.query('INSERT INTO meeting_notes_revisions(meeting_id,version,doc,saved_by,saved_by_name,reason) VALUES($1,$2,$3,$4,$5,$6)', [req.params.id, version, JSON.stringify(next), req.user.participantId, name, want.includes('template') ? 'template' : 'edit']);
      await c.query('COMMIT');
      io.to(room(req.params.id)).emit('notes-updated', { version, doc: next, by: name, byId: req.user.participantId, sections: want });
      res.json({ version, doc: next, changed: true });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }, 'Could not save the notes'));

  app.post(paths('/notes/snapshot'), auth, participant, live, guard(async (req, res) => {
    if (!(await canEdit(req))) return fail(res, 403, 'You do not have edit access to the notes');
    const n = await loadNotes(req.params.id), name = getName(req.params.id, req.user.participantId);
    await db.query('INSERT INTO meeting_notes_revisions(meeting_id,version,doc,saved_by,saved_by_name,reason) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (meeting_id,version) DO NOTHING', [req.params.id, n.version, JSON.stringify(n.doc), req.user.participantId, name, 'manual']);
    res.json({ version: n.version });
  }, 'Could not save a version'));

  app.get(paths('/notes/revisions'), auth, participant, guard(async (req, res) => {
    const { rows } = await db.query('SELECT version,saved_by_name AS "savedBy",reason,created_at AS "at" FROM meeting_notes_revisions WHERE meeting_id=$1 ORDER BY version DESC LIMIT 100', [req.params.id]);
    res.set('Cache-Control', 'no-store').json({ revisions: rows });
  }, 'History unavailable'));
  app.get(paths('/notes/revisions/:v'), auth, participant, guard(async (req, res) => {
    const { rows: [r] } = await db.query('SELECT version,doc,saved_by_name AS "savedBy",reason,created_at AS "at" FROM meeting_notes_revisions WHERE meeting_id=$1 AND version=$2', [req.params.id, parseInt(req.params.v, 10) || 0]);
    r ? res.json(r) : fail(res, 404, 'No such version');
  }, 'History unavailable'));
  app.post(paths('/notes/restore'), auth, participant, live, hostOnly, guard(async (req, res) => {
    const { rows: [r] } = await db.query('SELECT doc FROM meeting_notes_revisions WHERE meeting_id=$1 AND version=$2', [req.params.id, parseInt(req.body?.version, 10) || 0]); if (!r) return fail(res, 404, 'No such version');
    const name = getName(req.params.id, req.user.participantId), doc = normalizeDoc(r.doc), c = await db.connect();
    try {
      await c.query('BEGIN'); await loadNotes(req.params.id);
      const { rows: [cur] } = await c.query('SELECT version FROM meeting_notes WHERE meeting_id=$1 FOR UPDATE', [req.params.id]); const version = cur.version + 1;
      await c.query('UPDATE meeting_notes SET doc=$2,version=$3,updated_by=$4,updated_by_name=$5,updated_at=now() WHERE meeting_id=$1', [req.params.id, JSON.stringify(doc), version, req.user.participantId, name]);
      await c.query('INSERT INTO meeting_notes_revisions(meeting_id,version,doc,saved_by,saved_by_name,reason) VALUES($1,$2,$3,$4,$5,$6)', [req.params.id, version, JSON.stringify(doc), req.user.participantId, name, 'restore']);
      await c.query('COMMIT'); io.to(room(req.params.id)).emit('notes-updated', { version, doc, by: name, byId: req.user.participantId, sections: SECTIONS, restored: true });
      audit(req.params.id, req.user.participantId, 'notes.restored', { from: req.body.version }); res.json({ version, doc });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }, 'Could not restore'));

  app.post(paths('/notes/editors'), auth, participant, live, hostOnly, guard(async (req, res) => {
    const pid = String(req.body?.participantId || ''), allow = req.body?.allow === true;
    const { rows } = await db.query('SELECT 1 FROM participants WHERE id=$1 AND meeting_id=$2', [pid, req.params.id]); if (!rows.length) return fail(res, 404, 'No such participant');
    if (allow) await db.query('INSERT INTO notes_editors(meeting_id,participant_id,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [req.params.id, pid, req.user.participantId]);
    else await db.query('DELETE FROM notes_editors WHERE meeting_id=$1 AND participant_id=$2', [req.params.id, pid]);
    audit(req.params.id, req.user.participantId, allow ? 'notes.edit_granted' : 'notes.edit_revoked', { participant: pid });
    const editors = await editorIds(req.params.id); io.to(room(req.params.id)).emit('notes-editors', { editors }); res.json({ editors });
  }, 'Could not change access'));

  // ------------------------------------------------------------------ polls
  const isHost = (req) => req.user.role === 'host';
  const seeResults = (p, host) => host || (p.status === 'closed' && p.published) || (p.status === 'open' && p.live_results);
  async function expire(meetingId) {                              // lazy close of timed polls
    const { rows } = await db.query("UPDATE meeting_polls SET status='closed', closed_at=now() WHERE status='open' AND closes_at IS NOT NULL AND closes_at<=now() " + (meetingId ? 'AND meeting_id=$1 ' : '') + 'RETURNING meeting_id', meetingId ? [meetingId] : []);
    for (const m of new Set(rows.map((r) => r.meeting_id))) io.to(room(m)).emit('polls-changed');
  }
  setInterval(() => expire().catch(() => {}), 5000).unref();
  const ballotsOf = async (pollId) => (await db.query('SELECT choices FROM poll_ballots WHERE poll_id=$1', [pollId])).rows.map((r) => r.choices);
  async function pollView(p, req) {
    const host = isHost(req), voters = (await db.query('SELECT count(*)::int AS n FROM poll_voters WHERE poll_id=$1', [p.id])).rows[0].n;
    const mine = (await db.query('SELECT 1 FROM poll_voters WHERE poll_id=$1 AND participant_id=$2', [p.id, req.user.participantId])).rowCount > 0;
    const v = { id: p.id, question: p.question, kind: p.kind, options: p.options, scale: p.scale, anonymous: p.anonymous, liveResults: p.live_results, quiz: p.quiz, status: p.status, published: p.published, durationSec: p.duration_sec, closesAt: p.closes_at, responses: voters, hasVoted: mine, createdAt: p.created_at };
    if (seeResults(p, host)) v.results = tally(p, await ballotsOf(p.id));
    if (p.quiz && (host || (p.status === 'closed' && p.published))) { v.correct = p.correct; v.explanation = p.explanation; }
    return v;
  }
  const getPoll = async (req) => (await db.query('SELECT * FROM meeting_polls WHERE id=$1 AND meeting_id=$2', [req.params.pid, req.params.id])).rows[0];
  const changed = (meetingId) => io.to(room(meetingId)).emit('polls-changed');

  app.get(paths('/polls'), auth, participant, guard(async (req, res) => {
    await expire(req.params.id);
    const { rows } = await db.query('SELECT * FROM meeting_polls WHERE meeting_id=$1 ' + (isHost(req) ? '' : "AND status<>'draft' ") + 'ORDER BY created_at DESC LIMIT 60', [req.params.id]);
    res.set('Cache-Control', 'no-store').json({ polls: await Promise.all(rows.map((p) => pollView(p, req))) });
  }, 'Polls unavailable'));

  app.post(paths('/polls'), auth, participant, live, hostOnly, guard(async (req, res) => {
    const c = cleanPoll(req.body); if (c.error) return fail(res, 400, c.error);
    const { rows: [n] } = await db.query('SELECT count(*)::int AS n FROM meeting_polls WHERE meeting_id=$1', [req.params.id]); if (n.n >= 100) return fail(res, 409, 'Too many polls in this meeting');
    const id = randomUUID(), launch = req.body.launch === true;
    await db.query('INSERT INTO meeting_polls(id,meeting_id,created_by,question,kind,options,scale,anonymous,live_results,quiz,correct,explanation,duration_sec,status,opened_at,closes_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [id, req.params.id, req.user.participantId, c.question, c.kind, JSON.stringify(c.options), c.scale, c.anonymous, c.liveResults, c.quiz, c.correct && JSON.stringify(c.correct), c.explanation, c.durationSec, launch ? 'open' : 'draft', null, null]);
    if (launch) await db.query("UPDATE meeting_polls SET opened_at=now(), closes_at=CASE WHEN duration_sec IS NULL THEN NULL ELSE now()+duration_sec*interval '1 second' END WHERE id=$1", [id]);   // times come from the database clock
    audit(req.params.id, req.user.participantId, launch ? 'poll.launched' : 'poll.drafted', { poll: id }); changed(req.params.id);
    res.status(201).json(await pollView((await db.query('SELECT * FROM meeting_polls WHERE id=$1', [id])).rows[0], req));
  }, 'Could not create the poll'));

  app.post(paths('/polls/:pid/open'), auth, participant, live, hostOnly, guard(async (req, res) => {
    const p = await getPoll(req); if (!p) return fail(res, 404, 'No such poll'); if (p.status !== 'draft') return fail(res, 409, 'Only a draft can be launched');
    await db.query("UPDATE meeting_polls SET status='open', opened_at=now(), closes_at=CASE WHEN duration_sec IS NULL THEN NULL ELSE now()+duration_sec*interval '1 second' END WHERE id=$1", [p.id]);
    audit(req.params.id, req.user.participantId, 'poll.launched', { poll: p.id }); changed(req.params.id); res.json({ ok: true });
  }, 'Could not launch'));
  app.post(paths('/polls/:pid/close'), auth, participant, live, hostOnly, guard(async (req, res) => {
    const p = await getPoll(req); if (!p) return fail(res, 404, 'No such poll'); if (p.status !== 'open') return fail(res, 409, 'The poll is not open');
    await db.query("UPDATE meeting_polls SET status='closed', closed_at=now() WHERE id=$1", [p.id]); audit(req.params.id, req.user.participantId, 'poll.closed', { poll: p.id }); changed(req.params.id); res.json({ ok: true });
  }, 'Could not close'));
  app.post(paths('/polls/:pid/publish'), auth, participant, live, hostOnly, guard(async (req, res) => {
    const p = await getPoll(req); if (!p) return fail(res, 404, 'No such poll'); const on = req.body?.published !== false;
    await db.query('UPDATE meeting_polls SET published=$2 WHERE id=$1', [p.id, on]); audit(req.params.id, req.user.participantId, on ? 'poll.published' : 'poll.unpublished', { poll: p.id }); changed(req.params.id); res.json({ ok: true });
  }, 'Could not publish'));
  app.delete(paths('/polls/:pid'), auth, participant, live, hostOnly, guard(async (req, res) => {
    const p = await getPoll(req); if (!p) return fail(res, 404, 'No such poll'); if (p.status !== 'draft') return fail(res, 409, 'Only a draft can be deleted');
    await db.query('DELETE FROM meeting_polls WHERE id=$1', [p.id]); changed(req.params.id); res.json({ ok: true });
  }, 'Could not delete'));

  app.post(paths('/polls/:pid/votes'), auth, participant, live, guard(async (req, res) => {
    await expire(req.params.id);
    const p = await getPoll(req); if (!p || p.status === 'draft') return fail(res, 404, 'No such poll'); if (p.status !== 'open') return fail(res, 409, 'This poll is closed');
    const b = cleanBallot(p, req.body?.choices); if (b.error) return fail(res, 400, b.error);
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const ins = await c.query('INSERT INTO poll_voters(poll_id,participant_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [p.id, req.user.participantId]);
      if (!ins.rowCount) { await c.query('ROLLBACK'); return fail(res, 409, 'You have already voted in this poll'); }
      await c.query('INSERT INTO poll_ballots(id,poll_id,participant_id,choices) VALUES($1,$2,$3,$4)', [randomUUID(), p.id, p.anonymous ? null : req.user.participantId, JSON.stringify(b.choices)]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    audit(req.params.id, p.anonymous ? null : req.user.participantId, 'poll.voted', { poll: p.id }); changed(req.params.id);
    const out = { ok: true }; if (p.quiz) { const cs = new Set(p.correct); out.correct = b.choices.length === cs.size && b.choices.every((i) => cs.has(i)); }   // told to the voter once; never stored against an anonymous ballot
    res.status(201).json(out);
  }, 'Could not record your vote'));

  app.get(paths('/polls/:pid/results'), auth, participant, guard(async (req, res) => {
    const p = await getPoll(req); if (!p || (p.status === 'draft' && !isHost(req))) return fail(res, 404, 'No such poll');
    if (!seeResults(p, isHost(req))) return fail(res, 403, 'Results have not been published');
    res.set('Cache-Control', 'no-store').json(await pollView(p, req));
  }, 'Results unavailable'));

  app.get(paths('/polls/:pid/export.csv'), auth, participant, hostOnly, guard(async (req, res) => {
    const p = await getPoll(req); if (!p) return fail(res, 404, 'No such poll');
    const rows = [['Question', p.question], ['Type', p.kind], ['Anonymous', p.anonymous ? 'yes' : 'no'], ['Status', p.status], []];
    const { rows: bs } = await db.query('SELECT b.choices, pa.display_name FROM poll_ballots b LEFT JOIN participants pa ON pa.id=b.participant_id WHERE b.poll_id=$1', [p.id]);
    const t = tally(p, bs.map((b) => b.choices)); rows.push(['Responses', t.total]);
    if (p.kind === 'rating') { t.counts.forEach((n, i) => rows.push(['Rating ' + (i + 1), n])); rows.push(['Average', t.average ?? '']); }
    else if (p.kind === 'ranking') p.options.forEach((o, i) => rows.push([o, 'score ' + t.score[i], 'first choice ' + t.first[i]]));
    else p.options.forEach((o, i) => rows.push([o, t.counts[i]]));
    if (!p.anonymous) { rows.push([], ['Participant', 'Answer']); for (const b of bs) rows.push([b.display_name || '', (p.kind === 'ranking' ? b.choices.map((i) => p.options[i]).join(' > ') : p.kind === 'rating' ? b.choices[0] : b.choices.map((i) => p.options[i]).join('; '))]); }
    else rows.push([], ['Anonymous poll: individual answers are not recorded against names.']);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="poll-results.csv"', 'Cache-Control': 'no-store' }).send(rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
    audit(req.params.id, req.user.participantId, 'poll.exported', { poll: p.id });
  }, 'Export unavailable'));

  return { normalizeDoc };
}
