// Consent-gated live transcripts (v4.34).
//
// What is captured: ONLY each participant's own microphone, recorded by their own page and sent here in short chunks. Nothing is recorded from other people's audio, from the call, or from the server side of
// WebRTC. The audio is held in memory for one speech-to-text request to the private engine (STT_URL, a fixed internal address) and then dropped: it is never written to disk or stored in the database.
//
// Who must agree: EVERYBODY currently in the session's room scope (the main room, or one breakout room), the host included. A session is `active` only while that is true. A join, a move, a leave or a withdrawal
// makes the membership differ from the consents and the session is paused and its EPOCH is bumped, which invalidates every chunk made under the old epoch.
//
// The race protocol (all in PostgreSQL, so it holds across Meet instances):
//   * a status change takes the session row FOR UPDATE and bumps the epoch;
//   * a chunk is accepted, and again its result is stored, inside a transaction that takes the same row FOR SHARE and re-derives everything from the database: session active, epoch current, the speaker's OWN consent,
//     the speaker really in that scope right now, and every present participant consenting. A change either commits before the chunk's transaction (the chunk is refused) or waits for it (the chunk was valid when it ran).
//   * a person's audio is only ever processed while THEY consented, whatever happens to the others: the privacy of the speaker never depends on a hook arriving in time.
// Withdrawing deletes that person's segments of the session, stops their capture (their page is told) and pauses the session for everyone.
// Honest limits: presence comes from `participant_sessions` (a crashed server can leave a ghost that keeps a session paused until the 6-hour bound); phone callers are not captured and cannot consent; chunk
// timestamps are the page's own clock (relative, not authoritative); MediaRecorder chunks are not guaranteed to decode on Safari/iOS.
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (status, error) => Object.assign(new Error(error), { status });
export const TRANSCRIPT_LIMITS = Object.freeze({ retentionDays: 30, maxAudioBytes: 2_000_000, minAudioBytes: 100, chunksPerMinute: 30, inflightPerSpeaker: 2, maxSegments: 100, sttTimeoutMs: 25000, presenceHours: 6 });
const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4'];

export function registerTranscripts({ app, db, auth, member, fail, scopeOf, notify = () => {}, audit = async () => {}, env = process.env, fetchImpl = fetch, limits = TRANSCRIPT_LIMITS, sweepMs = 10000 }) {
  const sttUrl = env.STT_URL, sttToken = String(env.STT_INTERNAL_TOKEN || '');
  const enabled = env.MEET_TRANSCRIPT === 'on' && /^https?:\/\//.test(sttUrl || '') && sttToken.length >= 32;
  const reason = env.MEET_TRANSCRIPT !== 'on' ? 'off' : !/^https?:\/\//.test(sttUrl || '') ? 'STT_URL is not set' : sttToken.length < 32 ? 'STT_INTERNAL_TOKEN must be at least 32 characters' : null;
  const paths = (p) => ['/api/meetings/:id/transcripts' + p, '/api/v1/meetings/:id/transcripts' + p];
  const run = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { if (e.status) return fail(res, e.status, e.message); console.error('[transcripts]', e.message); if (!res.headersSent) fail(res, 500, 'Something went wrong'); } };
  const gate = (req, res, next) => (enabled ? next() : fail(res, 503, 'Live transcripts are not available on this server' + (reason && reason !== 'off' ? ': ' + reason : '')));
  const isHost = (req) => req.user.role === 'host';
  const inflight = new Map();          // sessionId -> Set(AbortController): a withdrawal aborts this instance's requests to the engine at once
  const abortSession = (sid) => { for (const c of inflight.get(sid) || []) c.abort(); inflight.delete(sid); };
  const rate = new Map(); const okRate = (pid) => { const now = Date.now(), a = (rate.get(pid) || []).filter((t) => now - t < 60000); if (a.length >= limits.chunksPerMinute) { rate.set(pid, a); return false; } a.push(now); rate.set(pid, a); return true; };
  const busy = new Map();

  /** who is in this scope RIGHT NOW, from PostgreSQL (so every instance agrees): admitted, connected recently, and assigned to this room (or to none for the main room while rooms are not open) */
  async function members(q, mid, scope) {
    const { rows } = await q.query(`SELECT p.id, p.display_name FROM participants p
      WHERE p.meeting_id=$1 AND p.admission='admitted'
        AND EXISTS (SELECT 1 FROM participant_sessions s WHERE s.participant_id=p.id AND s.disconnected_at IS NULL AND s.connected_at > now() - make_interval(hours => $3))
        AND (CASE WHEN EXISTS (SELECT 1 FROM more_breakout_sessions b WHERE b.meeting_id=$1 AND b.state='active') THEN (SELECT a.room_id FROM more_breakout_assignments a WHERE a.meeting_id=$1 AND a.participant_id=p.id) ELSE NULL END) IS NOT DISTINCT FROM $2
      ORDER BY p.display_name, p.id`, [mid, scope, limits.presenceHours]);
    return rows;
  }
  const consentsOf = async (q, sid) => new Map((await q.query('SELECT participant_id, consent FROM more_transcript_consents WHERE session_id=$1', [sid])).rows.map((r) => [r.participant_id, r.consent]));
  /** recompute the status of a session whose row is locked by `c`. Returns { status, epoch, changed, members, consents } */
  async function reconcile(c, s) {
    if (s.status === 'stopped') return { status: 'stopped', epoch: Number(s.epoch), changed: false, members: [], consents: new Map() };
    const ms = await members(c, s.meeting_id, s.room_id), cs = await consentsOf(c, s.id);
    const unanimous = ms.length > 0 && ms.every((m) => cs.get(m.id) === true);
    const status = unanimous ? 'active' : s.status === 'awaiting_consent' ? 'awaiting_consent' : 'paused'; const changed = status !== s.status;
    if (changed) await c.query('UPDATE more_transcript_sessions SET status=$2, epoch=epoch+1 WHERE id=$1', [s.id, status]);
    return { status, epoch: Number(s.epoch) + (changed ? 1 : 0), changed, members: ms, consents: cs };
  }
  const lockSession = async (c, mid, sid, mode = 'UPDATE') => { const r = await c.query(`SELECT * FROM more_transcript_sessions WHERE id=$1 AND meeting_id=$2 FOR ${mode}`, [sid, mid]); if (!r.rows[0]) throw bad(404, 'Transcript not found'); return r.rows[0]; };
  async function tx(fn) { const c = await db.connect(); try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); } }
  const announce = (s, status, epoch) => { if (status !== 'active') abortSession(s.id); notify(s.meeting_id, s.room_id, 'transcript', { sessionId: s.id, status, epoch }); };
  /** re-check every live session of a meeting (a join, leave, move or consent change happened, or the periodic sweep) */
  async function reconcileMeeting(mid) {
    if (!enabled) return 0; let n = 0;
    for (const s of (await db.query(`SELECT id FROM more_transcript_sessions WHERE meeting_id=$1 AND status<>'stopped'`, [mid])).rows) {
      const out = await tx(async (c) => { const row = await lockSession(c, mid, s.id); return { row, r: await reconcile(c, row) }; }).catch(() => null);
      if (out?.r.changed) { n++; announce(out.row, out.r.status, out.r.epoch); }
    }
    return n;
  }
  async function sweep() {
    const out = { reconciled: 0, purged: 0 };
    for (const m of (await db.query(`SELECT DISTINCT meeting_id FROM more_transcript_sessions WHERE status<>'stopped'`)).rows) out.reconciled += await reconcileMeeting(m.meeting_id);
    out.purged = (await db.query(`DELETE FROM more_transcript_sessions WHERE expires_at < now()`)).rowCount;
    await db.query(`DELETE FROM more_transcript_chunks WHERE created_at < now() - interval '1 day'`).catch(() => {});
    return out;
  }
  const timer = enabled ? setInterval(() => { sweep().catch((e) => console.error('[transcripts] sweep failed', e.message)); }, sweepMs) : null; timer?.unref?.();

  const viewOf = async (c, s, req) => {
    const r = await reconcile(c, s); const mine = r.consents.get(req.user.participantId);
    return { id: s.id, roomId: s.room_id, status: r.status, epoch: r.epoch, language: s.language, required: r.members.length, agreed: r.members.filter((m) => r.consents.get(m.id) === true).length, declined: r.members.filter((m) => r.consents.get(m.id) === false).length,
      inScope: r.members.some((m) => m.id === req.user.participantId), mine: mine === undefined ? null : mine,
      waiting: isHost(req) ? r.members.filter((m) => r.consents.get(m.id) !== true).map((m) => m.display_name) : undefined, createdAt: s.created_at, stoppedAt: s.stopped_at };
  };

  // ---- sessions
  app.post(paths(''), auth, member, gate, run(async (req, res) => {
    if (!isHost(req)) throw bad(403, 'Only the host can start a live transcript');
    const mid = req.params.id; let scope = req.body?.roomId ?? scopeOf(mid, req.user.participantId) ?? null; if (req.body?.roomId === 'main') scope = null;
    if (scope !== null && !(UUID.test(String(scope)) && (await db.query('SELECT 1 FROM more_breakout_rooms WHERE id=$1 AND meeting_id=$2', [scope, mid])).rowCount)) throw bad(404, 'Room not found');
    const language = String(req.body?.language || 'en').toLowerCase(); if (!/^[a-z]{2,3}$/.test(language)) throw bad(400, 'Invalid language');
    let id; try { id = (await db.query(`INSERT INTO more_transcript_sessions(meeting_id, room_id, created_by, language, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(days => $5)) RETURNING id`, [mid, scope, req.user.participantId, language, limits.retentionDays])).rows[0].id; }
    catch (e) { if (e.code === '23505') throw bad(409, 'A transcript is already running or waiting in this room'); throw e; }
    await audit(mid, req.user.participantId, 'transcript.created', { id, roomId: scope }); notify(mid, scope, 'transcript', { sessionId: id, status: 'awaiting_consent', epoch: 1 });
    const s = await tx(async (c) => viewOf(c, await lockSession(c, mid, id), req)); res.status(201).json(s);
  }));
  app.get(paths(''), auth, member, gate, run(async (req, res) => {
    const mid = req.params.id, scope = scopeOf(mid, req.user.participantId) ?? null; const out = [];
    const rows = (await db.query(`SELECT * FROM more_transcript_sessions WHERE meeting_id=$1 ORDER BY created_at DESC LIMIT 30`, [mid])).rows;
    for (const s of rows) {
      const mineSaid = (await db.query('SELECT consent FROM more_transcript_consents WHERE session_id=$1 AND participant_id=$2', [s.id, req.user.participantId])).rows[0]?.consent === true;
      if (!(isHost(req) || (s.status !== 'stopped' && (s.room_id ?? null) === scope) || mineSaid)) continue;          // another room's live session does not exist for you; a finished one is yours only if you agreed to it
      out.push(await tx(async (c) => viewOf(c, await lockSession(c, mid, s.id), req)));
    }
    res.set('Cache-Control', 'no-store').json({ sessions: out });
  }));
  app.post(paths('/:sid/consent'), auth, member, gate, run(async (req, res) => {
    const mid = req.params.id, sid = req.params.sid, yes = req.body?.consent === true; if (!UUID.test(sid) || typeof req.body?.consent !== 'boolean') throw bad(400, 'Say yes or no');
    const out = await tx(async (c) => {
      const s = await lockSession(c, mid, sid); if (s.status === 'stopped') throw bad(409, 'This transcript has ended');
      const here = (await members(c, mid, s.room_id)).some((m) => m.id === req.user.participantId); if (!here) throw bad(403, 'You are not in the room this transcript is for');
      await c.query(`INSERT INTO more_transcript_consents(session_id, participant_id, consent) VALUES ($1,$2,$3) ON CONFLICT (session_id, participant_id) DO UPDATE SET consent=EXCLUDED.consent, decided_at=now()`, [sid, req.user.participantId, yes]);
      if (!yes) await c.query('DELETE FROM more_transcript_segments WHERE session_id=$1 AND speaker_id=$2', [sid, req.user.participantId]);          // withdrawing takes their words back out
      const r = await reconcile(c, s); if (!yes && !r.changed) { await c.query('UPDATE more_transcript_sessions SET epoch=epoch+1 WHERE id=$1', [sid]); r.epoch += 1; r.changed = true; }          // a withdrawal always invalidates what is in flight
      return { s, r, view: await viewOf(c, { ...s, status: r.status, epoch: r.epoch }, req) };
    });
    await audit(mid, req.user.participantId, yes ? 'transcript.consented' : 'transcript.withdrawn', { id: sid }); if (out.r.changed || !yes) announce(out.s, out.r.status, out.r.epoch);
    if (!yes) abortSession(sid); res.json(out.view);
  }));
  app.post(paths('/:sid/stop'), auth, member, gate, run(async (req, res) => {
    if (!isHost(req)) throw bad(403, 'Only the host can stop a transcript'); const s = await tx(async (c) => { const row = await lockSession(c, req.params.id, req.params.sid); await c.query(`UPDATE more_transcript_sessions SET status='stopped', stopped_at=now(), stopped_reason='host_stopped', epoch=epoch+1 WHERE id=$1`, [row.id]); return row; });
    abortSession(s.id); await audit(req.params.id, req.user.participantId, 'transcript.stopped', { id: s.id }); notify(s.meeting_id, s.room_id, 'transcript', { sessionId: s.id, status: 'stopped', epoch: Number(s.epoch) + 1 }); res.json({ id: s.id, status: 'stopped' });
  }));

  // ---- the transcript itself: the host, and anybody who agreed to THIS session
  async function readable(req, sid) {
    const s = await tx(async (c) => lockSession(c, req.params.id, sid, 'SHARE'));
    if (!isHost(req) && (await db.query('SELECT consent FROM more_transcript_consents WHERE session_id=$1 AND participant_id=$2', [sid, req.user.participantId])).rows[0]?.consent !== true) throw bad(404, 'Transcript not found');
    return s;
  }
  app.get(paths('/:sid'), auth, member, gate, run(async (req, res) => {
    if (!UUID.test(req.params.sid)) throw bad(400, 'Invalid transcript'); const s = await readable(req, req.params.sid);
    const segs = (await db.query(`SELECT g.speaker_id, p.display_name AS speaker, g.start_ms, g.end_ms, g.text FROM more_transcript_segments g JOIN participants p ON p.id=g.speaker_id WHERE g.session_id=$1 ORDER BY g.created_at, g.start_ms LIMIT 5000`, [s.id])).rows;
    res.set('Cache-Control', 'no-store').json({ session: { id: s.id, status: s.status, roomId: s.room_id, language: s.language }, segments: segs.map((g) => ({ speaker: g.speaker, startMs: Number(g.start_ms), endMs: Number(g.end_ms), text: g.text })) });
  }));
  app.get(paths('/:sid/export.txt'), auth, member, gate, run(async (req, res) => {
    if (!UUID.test(req.params.sid)) throw bad(400, 'Invalid transcript'); const s = await readable(req, req.params.sid);
    const segs = (await db.query(`SELECT p.display_name AS speaker, g.start_ms, g.text FROM more_transcript_segments g JOIN participants p ON p.id=g.speaker_id WHERE g.session_id=$1 ORDER BY g.created_at, g.start_ms`, [s.id])).rows;
    await audit(req.params.id, req.user.participantId, 'transcript.exported', { id: s.id });
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="transcript.txt"', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).send(segs.map((g) => `[${new Date(Number(g.start_ms)).toISOString().slice(14, 19)}] ${g.speaker}: ${g.text}`).join('\n') + '\n');
  }));

  // ---- the audio gateway
  async function checkChunk(c, mid, sid, epoch, pid) {
    const s = await lockSession(c, mid, sid, 'SHARE');          // a status change waits for this transaction; this transaction sees every change that committed before it
    if (s.status !== 'active') throw bad(409, 'The transcript is not running (everybody must agree first)'); if (Number(s.epoch) !== epoch) throw bad(409, 'Your page is out of date: the consent state changed');
    const ms = await members(c, mid, s.room_id), cs = await consentsOf(c, sid);
    if (!ms.some((m) => m.id === pid)) throw bad(403, 'You are not in the room this transcript is for'); if (cs.get(pid) !== true) throw bad(403, 'You have not agreed');
    if (!ms.every((m) => cs.get(m.id) === true)) throw bad(409, 'Someone in the room has not agreed');
    return s;
  }
  app.post(paths('/:sid/audio'), auth, member, gate, run(async (req, res) => {
    const mid = req.params.id, sid = req.params.sid, pid = req.user.participantId, type = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const epoch = Number(req.get('x-consent-epoch')), chunkId = String(req.get('x-chunk-id') || ''), startMs = Number(req.get('x-chunk-start-ms') || 0), len = Number(req.get('content-length'));
    if (!UUID.test(sid) || !UUID.test(chunkId) || !Number.isSafeInteger(epoch) || epoch < 1 || !Number.isSafeInteger(startMs) || startMs < 0 || startMs > 12 * 3600 * 1000) throw bad(400, 'Invalid audio request');
    if (!AUDIO_TYPES.includes(type)) throw bad(415, 'Unsupported audio type'); if (!Number.isSafeInteger(len) || len < limits.minAudioBytes || len > limits.maxAudioBytes) throw bad(413, 'Invalid audio size');
    if (!okRate(pid)) throw bad(429, 'Too many audio chunks'); if ((busy.get(pid) || 0) >= limits.inflightPerSpeaker) throw bad(429, 'Too many chunks in flight');
    const chunks = []; let size = 0; await new Promise((resolve, reject) => { req.on('data', (d) => { size += d.length; if (size > limits.maxAudioBytes) { req.destroy(); reject(bad(413, 'Invalid audio size')); } else chunks.push(d); }); req.on('end', resolve); req.on('error', reject); req.on('aborted', () => reject(bad(400, 'Upload interrupted'))); });
    const audio = Buffer.concat(chunks); if (audio.length !== len) throw bad(400, 'Audio size did not match');
    const s = await tx(async (c) => { const row = await checkChunk(c, mid, sid, epoch, pid); const ins = await c.query(`INSERT INTO more_transcript_chunks(session_id, chunk_id, speaker_id, epoch, status) VALUES ($1,$2,$3,$4,'processing') ON CONFLICT DO NOTHING RETURNING chunk_id`, [sid, chunkId, pid, epoch]); return ins.rowCount ? row : null; });
    if (!s) return res.json({ accepted: true, duplicate: true });
    busy.set(pid, (busy.get(pid) || 0) + 1); const ctl = new AbortController(); (inflight.get(sid) || inflight.set(sid, new Set()).get(sid)).add(ctl);
    const settle = (status) => db.query('UPDATE more_transcript_chunks SET status=$3 WHERE session_id=$1 AND chunk_id=$2', [sid, chunkId, status]).catch(() => {});
    try {
      const timer2 = setTimeout(() => ctl.abort(), limits.sttTimeoutMs); let result;
      try { const r = await fetchImpl(new URL('/internal/transcribe', sttUrl), { method: 'POST', headers: { 'content-type': type, 'x-internal-token': sttToken, 'x-language': s.language }, body: audio, signal: ctl.signal }); if (!r.ok) throw new Error('stt ' + r.status); result = await r.json(); } finally { clearTimeout(timer2); }
      const segs = (Array.isArray(result?.segments) ? result.segments : []).slice(0, limits.maxSegments).filter((g) => g && typeof g.text === 'string' && g.text.trim() && Number.isSafeInteger(g.startMs) && Number.isSafeInteger(g.endMs) && g.endMs >= g.startMs && g.startMs >= 0).map((g) => ({ text: g.text.trim().slice(0, 4000), startMs: g.startMs, endMs: g.endMs }));
      let stored = 0;
      try { await tx(async (c) => { await checkChunk(c, mid, sid, epoch, pid); for (const g of segs) await c.query(`INSERT INTO more_transcript_segments(session_id, speaker_id, epoch, start_ms, end_ms, text, chunk_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [sid, pid, epoch, startMs + g.startMs, startMs + g.endMs, g.text, chunkId]); stored = segs.length; await c.query(`UPDATE more_transcript_chunks SET status='done' WHERE session_id=$1 AND chunk_id=$2`, [sid, chunkId]); }); }
      catch (e) { await settle('rejected'); throw e; }          // consent or epoch changed while the engine worked: the result is discarded, nothing is stored
      res.json({ accepted: true, segments: stored });
    } catch (e) { if (!e.status) { await settle('failed'); console.error('[transcripts] engine failed:', e.message); throw bad(502, 'Speech recognition is unavailable right now'); } throw e; }
    finally { busy.set(pid, Math.max(0, (busy.get(pid) || 1) - 1)); inflight.get(sid)?.delete(ctl); }
  }));
  return { enabled, reason, reconcileMeeting, sweep, members, abortSession, stop: () => timer && clearInterval(timer) };
}
