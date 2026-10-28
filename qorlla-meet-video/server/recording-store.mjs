// Qorlla Meet recording storage (v4.0.3): the authorized media pipeline behind the consent state machine in recording.mjs.
//
//   consent session  ready -> recording        (host start; creates a `recordings` row + a fresh data key)
//   recording row    recording -> finalizing -> available | failed -> deleted (retention, host delete)
//
// What this module guarantees: the server accepts media chunks ONLY from the recorder, ONLY while the consent session is in `recording` (not awaiting, paused,
// blocked or ended - with a short, policy-limited allowance for the last chunk after a host stop), encrypts every chunk before it touches storage, serves it back
// only through short-lived single-use links for the meeting's host, audits every step, expires and deletes on schedule, and recovers from a crashed recorder.
// What it does NOT do: capture media itself. The browser of the person recording composes the picture and audio (leaving out anyone who has not consented) and
// uploads chunks; a malicious or modified client could still send what it likes. Server-side (SFU) capture would be the stronger design.
import crypto from 'node:crypto';
import express from 'express';
import { loadKeyring, newDataKey, encryptChunk, decryptChunk } from './recording-crypto.mjs';
import { createObjectStore } from './recording-objects.mjs';
import { verifyChain } from './recording-audit.mjs';

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
export const AI_PURPOSES = ['transcription', 'summary', 'translation', 'third_party'];

export function registerRecordingStorage({ app, db, auth, fail, audit, getRoster, getName, env = process.env, ring = loadKeyring(env), store = createObjectStore(env), policyVersion = 'qorlla-recording-consent-2026-10' }) {
  const cfg = {
    dayMs: num(env.RECORDING_DAY_MS, 86400000), defaultDays: num(env.RECORDING_RETENTION_DEFAULT_DAYS, 30), maxChunk: num(env.RECORDING_MAX_CHUNK_BYTES, 8 * 1024 * 1024), maxTotal: num(env.RECORDING_MAX_BYTES, 4 * 1024 ** 3),
    lateMs: num(env.RECORDING_LATE_CHUNK_MS, 30000), idleMs: num(env.RECORDING_IDLE_MS, 120000), finalizeGraceMs: num(env.RECORDING_FINALIZE_GRACE_MS, 45000), sweepMs: num(env.RECORDING_SWEEP_MS, 30000), tokenSec: num(env.RECORDING_LINK_SECONDS, 300),
  };
  const ready = !!(ring.ready && store.ready), notReady = ring.ready ? store.reason : ring.reason;
  const tokenKey = crypto.createHmac('sha256', String(env.JWT_SECRET || 'dev')).update('qorlla-recording-access-v1').digest();
  const paths = (p) => ['/api/meetings/:id' + p, '/api/v1/meetings/:id' + p];
  const rpaths = (p) => ['/api/recordings/:rid' + p, '/api/v1/recordings/:rid' + p];
  const guard = (fn, msg) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('[recording-store]', msg, e.message); if (!res.headersSent) fail(res, 500, msg); } };
  const participant = async (req, res, next) => {                                // any participant of the meeting, also after it ended
    try {
      if (req.user.meetingId !== req.params.id) return fail(res, 403, 'Wrong meeting');
      const { rows } = await db.query("SELECT 1 FROM participants WHERE id=$1 AND meeting_id=$2 AND admission='admitted'", [req.user.participantId, req.params.id]); if (!rows.length) return fail(res, 403, 'Meeting unavailable'); next();
    } catch { fail(res, 500, 'Database unavailable'); }
  };
  const hostOnly = (req, res, next) => (req.user.role === 'host' ? next() : fail(res, 403, 'Only the host can do this'));
  const getRec = async (id) => (/^[0-9a-f-]{36}$/i.test(id) ? (await db.query('SELECT * FROM recordings WHERE id=$1', [id])).rows[0] : null);
  const view = (r) => ({ id: r.id, status: r.status, startedAt: r.started_at, endedAt: r.ended_at, endReason: r.end_reason, bytes: Number(r.bytes), chunks: r.chunk_count, partial: r.partial, video: r.has_video, audio: r.has_audio, retentionDays: r.retention_days, retentionUntil: r.retention_until, legalHold: r.legal_hold, failReason: r.fail_reason });
  const nextSeq = async (id) => { const { rows } = await db.query('SELECT seq FROM recording_chunks WHERE recording_id=$1 ORDER BY seq', [id]); let n = 0; for (const r of rows) { if (r.seq === n) n++; else break; } return { next: n, total: rows.length }; };

  // ------------------------------------------------------------------------------------------------------------------ lifecycle hooks used by recording.mjs
  const media = {
    ready, notReady,
    /** Called by the start gate (consent already complete). Creates the recording and its data key. */
    async onStart(session, recorderPid) {
      if (!ready) throw Object.assign(new Error('Recording storage is not configured: ' + notReady), { code: 'STORAGE_NOT_READY' });
      const id = crypto.randomUUID(), dek = newDataKey(), { keyId, wrapped } = ring.wrap(dek, id), days = session.retention_days || cfg.defaultDays;
      try { await db.query('INSERT INTO recordings(id,meeting_id,session_id,recorder,status,has_video,has_audio,key_id,wrapped_key,retention_days) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, session.meeting_id, session.id, recorderPid, 'recording', session.want_video, session.want_audio, keyId, wrapped, days]); }
      catch (e) { if (e.code === '23505') throw Object.assign(new Error('Recording already started'), { code: 'ALREADY_STARTED' }); throw e; }
      await audit(session.meeting_id, session.id, recorderPid, 'host', 'recording.media_created', { recordingId: id, retentionDays: days, keyId });
      return id;
    },
    /** Called whenever the consent session ends (host stop, withdrawal, decline, host left, meeting ended). */
    async onEnd(session, reason, actor) {
      const { rows: [r] } = await db.query("UPDATE recordings SET status='finalizing', ended_at=now(), end_reason=$2 WHERE session_id=$1 AND status='recording' RETURNING *", [session.id, reason]);
      if (r) await audit(session.meeting_id, session.id, actor || null, actor ? 'host' : 'system', 'recording.finalizing', { recordingId: r.id, reason });
    },
    async recordingIdFor(sessionId) { return (await db.query('SELECT id FROM recordings WHERE session_id=$1', [sessionId])).rows[0]?.id || null; },
  };

  // ------------------------------------------------------------------------------------------------------------------ chunk upload (the authorization gate for media)
  const raw = express.raw({ type: () => true, limit: cfg.maxChunk + 1024 });
  app.post(paths('/recordings/:rid/chunks'), auth, participant, raw, guard(async (req, res) => {
    const rec = await getRec(req.params.rid);
    if (!rec || rec.meeting_id !== req.params.id) return fail(res, 404, 'No such recording');
    if (rec.recorder !== req.user.participantId) return fail(res, 403, 'Only the recorder can upload media');
    const seq = Number(req.query.seq); if (!Number.isInteger(seq) || seq < 0 || seq > 1_000_000) return fail(res, 400, 'Bad sequence number');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0); if (!body.length) return fail(res, 400, 'Empty chunk'); if (body.length > cfg.maxChunk) return fail(res, 413, 'Chunk too large');
    // authorization at the moment of capture: consent session must be recording; after a host-initiated stop only a short window for the final chunk
    const { rows: [s] } = await db.query('SELECT status,end_reason FROM recording_sessions WHERE id=$1', [rec.session_id]);
    const live = rec.status === 'recording' && s?.status === 'recording';
    const late = rec.status === 'finalizing' && ['host_stopped', 'meeting_ended', 'host_left'].includes(rec.end_reason) && (await db.query("SELECT (ended_at > now() - ($2::int * interval '1 millisecond')) AS fresh FROM recordings WHERE id=$1", [rec.id, cfg.lateMs])).rows[0]?.fresh === true;
    if (!live && !late) { await audit(rec.meeting_id, rec.session_id, req.user.participantId, 'host', 'recording.chunk_refused', { recordingId: rec.id, seq, sessionStatus: s?.status, recordingStatus: rec.status }).catch(() => {}); return res.status(409).json({ error: 'Media is not being accepted right now', state: s?.status || 'ended', recording: rec.status }); }
    const { rows: [ex] } = await db.query('SELECT size FROM recording_chunks WHERE recording_id=$1 AND seq=$2', [rec.id, seq]);
    if (ex) return ex.size === body.length ? res.json({ seq, duplicate: true, ...(await nextSeq(rec.id)) }) : fail(res, 409, 'That chunk was already stored with different content');
    if (Number(rec.bytes) + body.length > cfg.maxTotal) return fail(res, 413, 'Recording size limit reached');
    const dek = ring.unwrap(rec.key_id, rec.wrapped_key, rec.id), key = rec.id + '/' + String(seq).padStart(8, '0') + '.bin';
    await store.put(key, encryptChunk(dek, rec.id, seq, body));
    const ins = await db.query('INSERT INTO recording_chunks(recording_id,seq,size,object_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [rec.id, seq, body.length, key]);
    if (ins.rowCount) await db.query('UPDATE recordings SET bytes=bytes+$2, last_chunk_at=now() WHERE id=$1', [rec.id, body.length]);
    res.status(201).json({ seq, ...(await nextSeq(rec.id)) });
  }, 'Could not store the chunk'));

  app.get(paths('/recordings/:rid/status'), auth, participant, guard(async (req, res) => {
    const rec = await getRec(req.params.rid); if (!rec || rec.meeting_id !== req.params.id) return fail(res, 404, 'No such recording');
    if (rec.recorder !== req.user.participantId) return fail(res, 403, 'Only the recorder can see this');
    res.set('Cache-Control', 'no-store').json({ ...view(rec), ...(await nextSeq(rec.id)) });
  }, 'Status unavailable'));

  app.post(paths('/recordings/:rid/complete'), auth, participant, guard(async (req, res) => {
    const rec = await getRec(req.params.rid); if (!rec || rec.meeting_id !== req.params.id) return fail(res, 404, 'No such recording');
    if (rec.recorder !== req.user.participantId) return fail(res, 403, 'Only the recorder can complete it');
    if (rec.status === 'available' || rec.status === 'failed') return res.json(view(rec));
    if (rec.status === 'recording') await db.query("UPDATE recordings SET status='finalizing', ended_at=COALESCE(ended_at,now()), end_reason=COALESCE(end_reason,'recorder_completed') WHERE id=$1 AND status='recording'", [rec.id]);
    const expected = Number.isInteger(req.body?.chunks) ? req.body.chunks : null;
    res.json(view(await finalize(rec.id, expected, req.user.participantId)));
  }, 'Could not finalize'));

  // ------------------------------------------------------------------------------------------------------------------ finalize / delete / sweeps
  async function finalize(id, expected, actor) {
    const rec = await getRec(id); if (!rec || !['recording', 'finalizing'].includes(rec.status)) return rec;
    const { rows } = await db.query('SELECT seq,size FROM recording_chunks WHERE recording_id=$1 ORDER BY seq', [id]);
    let n = 0, bytes = 0; for (const r of rows) { if (r.seq === n) { n++; bytes += r.size; } else break; }
    const partial = rows.length > n || (expected !== null && n < expected) || rec.end_reason === 'recorder_lost';
    if (n === 0) {
      const { rows: [u] } = await db.query("UPDATE recordings SET status='failed', fail_reason='no_media', finalized_at=now(), retention_until=now() + ($2::bigint * interval '1 millisecond'), chunk_count=0, bytes=0 WHERE id=$1 AND status IN ('recording','finalizing') RETURNING *", [id, rec.retention_days * cfg.dayMs]);
      if (u) await audit(rec.meeting_id, rec.session_id, actor || null, actor ? 'host' : 'system', 'recording.failed', { recordingId: id, reason: 'no_media' });
      return u || await getRec(id);
    }
    const { rows: [u] } = await db.query("UPDATE recordings SET status='available', chunk_count=$2, bytes=$3, partial=$4, finalized_at=now(), retention_until=now() + ($5::bigint * interval '1 millisecond') WHERE id=$1 AND status IN ('recording','finalizing') RETURNING *", [id, n, bytes, partial, rec.retention_days * cfg.dayMs]);
    if (u) await audit(rec.meeting_id, rec.session_id, actor || null, actor ? 'host' : 'system', 'recording.available', { recordingId: id, chunks: n, bytes, partial, retentionDays: rec.retention_days });
    return u || await getRec(id);
  }
  async function destroy(rec, reason, actor, role) {
    const { rows } = await db.query('SELECT object_key FROM recording_chunks WHERE recording_id=$1', [rec.id]);
    for (const r of rows) await store.delete(r.object_key).catch(() => {}); await store.removePrefix(rec.id).catch(() => {});
    await db.query('DELETE FROM recording_chunks WHERE recording_id=$1', [rec.id]);
    const { rows: [u] } = await db.query("UPDATE recordings SET status='deleted', wrapped_key=NULL, deleted_at=now(), deleted_by=$2, delete_reason=$3 WHERE id=$1 AND status<>'deleted' RETURNING id", [rec.id, actor || 'system', reason]);
    if (u) await audit(rec.meeting_id, rec.session_id, role === 'system' ? null : actor, role, 'recording.deleted', { recordingId: rec.id, reason });
  }
  async function sweep() {
    if (!ready) return;
    try {
      // a recorder that vanished (crash, closed tab, lost connection past the grace period): finalize what was received
      const idle = await db.query("SELECT id,meeting_id,session_id FROM recordings WHERE status='recording' AND COALESCE(last_chunk_at, started_at) < now() - ($1::int * interval '1 millisecond')", [cfg.idleMs]);
      for (const r of idle.rows) { await db.query("UPDATE recordings SET status='finalizing', ended_at=now(), end_reason='recorder_lost' WHERE id=$1 AND status='recording'", [r.id]); await audit(r.meeting_id, r.session_id, null, 'system', 'recording.recorder_lost', { recordingId: r.id }); await finalize(r.id, null, null); }
      // finalization that never completed (worker crash between stop and finalize)
      const stuck = await db.query("SELECT id FROM recordings WHERE status='finalizing' AND ended_at < now() - ($1::int * interval '1 millisecond')", [cfg.finalizeGraceMs]);
      for (const r of stuck.rows) await finalize(r.id, null, null);
      // retention
      const due = await db.query("SELECT * FROM recordings WHERE status IN ('available','failed') AND retention_until IS NOT NULL AND retention_until <= now() AND NOT legal_hold");
      for (const r of due.rows) await destroy(r, 'retention_expired', 'system', 'system');
    } catch (e) { console.error('[recording-store] sweep failed:', e.message); }
  }
  if (ready) { setTimeout(sweep, 500).unref(); setInterval(sweep, cfg.sweepMs).unref(); }
  media.sweep = sweep;

  // ------------------------------------------------------------------------------------------------------------------ listing, access links, download, delete
  app.get(paths('/recordings'), auth, participant, hostOnly, guard(async (req, res) => {
    const { rows } = await db.query("SELECT * FROM recordings WHERE meeting_id=$1 ORDER BY started_at DESC LIMIT 50", [req.params.id]);
    res.set('Cache-Control', 'no-store').json({ recordings: rows.map(view), storage: { ready, reason: ready ? null : notReady } });
  }, 'Recordings unavailable'));

  const signToken = (p) => { const body = Buffer.from(JSON.stringify(p)).toString('base64url'); return body + '.' + crypto.createHmac('sha256', tokenKey).update(body).digest('base64url'); };
  const readToken = (t) => { const [body, sig] = String(t || '').split('.'); if (!body || !sig) return null; const want = crypto.createHmac('sha256', tokenKey).update(body).digest('base64url'); const a = Buffer.from(sig), b = Buffer.from(want); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null; try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; } };
  const ownerOf = (req, rec) => rec && req.user.meetingId === rec.meeting_id && req.user.role === 'host';

  app.get(rpaths('/access'), auth, guard(async (req, res) => {
    const rec = await getRec(req.params.rid);
    if (!ownerOf(req, rec)) { if (rec) await audit(rec.meeting_id, rec.session_id, req.user.participantId, req.user.role, 'recording.access_denied', { recordingId: rec.id }).catch(() => {}); return fail(res, rec ? 403 : 404, rec ? 'You do not have access to this recording' : 'No such recording'); }
    if (rec.status === 'deleted') return fail(res, 410, 'This recording has been deleted');
    if (rec.status !== 'available') return fail(res, 409, 'The recording is not available yet (' + rec.status + ')');
    const jti = crypto.randomUUID(), exp = Date.now() + cfg.tokenSec * 1000;
    await db.query("INSERT INTO recording_access_tokens(jti,recording_id,participant_id,expires_at) VALUES($1,$2,$3, now() + ($4::int * interval '1 second'))", [jti, rec.id, req.user.participantId, cfg.tokenSec]);
    await audit(rec.meeting_id, rec.session_id, req.user.participantId, 'host', 'recording.access_granted', { recordingId: rec.id, linkSeconds: cfg.tokenSec });
    res.set('Cache-Control', 'no-store').json({ url: '/api/recordings/' + rec.id + '/download?token=' + encodeURIComponent(signToken({ jti, rid: rec.id, pid: req.user.participantId, exp })), expiresInSeconds: cfg.tokenSec, singleUse: true });
  }, 'Access unavailable'));

  app.get(rpaths('/download'), guard(async (req, res) => {
    const t = readToken(req.query.token); const rec = t && await getRec(req.params.rid);
    if (!t || !rec || t.rid !== rec.id || Date.now() > t.exp) return fail(res, 403, 'This link is invalid or has expired');
    const { rows: [used] } = await db.query('UPDATE recording_access_tokens SET used_at=now() WHERE jti=$1 AND recording_id=$2 AND used_at IS NULL AND expires_at > now() RETURNING participant_id', [t.jti, rec.id]);
    if (!used) return fail(res, 403, 'This link was already used or has expired');
    if (rec.status === 'deleted') return fail(res, 410, 'This recording has been deleted'); if (rec.status !== 'available') return fail(res, 409, 'The recording is not available');
    const { rows } = await db.query('SELECT seq,object_key FROM recording_chunks WHERE recording_id=$1 AND seq < $2 ORDER BY seq', [rec.id, rec.chunk_count]); if (rows.length !== rec.chunk_count) return fail(res, 500, 'The recording is incomplete');
    const dek = ring.unwrap(rec.key_id, rec.wrapped_key, rec.id);
    await audit(rec.meeting_id, rec.session_id, t.pid, 'host', 'recording.downloaded', { recordingId: rec.id, bytes: Number(rec.bytes), chunks: rec.chunk_count });
    res.set({ 'Content-Type': rec.mime, 'Content-Length': String(rec.bytes), 'Content-Disposition': 'attachment; filename="qorlla-recording-' + rec.id.slice(0, 8) + '.webm"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    try { for (const r of rows) { if (!res.write(decryptChunk(dek, rec.id, r.seq, await store.get(r.object_key)))) await new Promise((ok) => res.once('drain', ok)); } res.end(); }
    catch (e) { await audit(rec.meeting_id, rec.session_id, t.pid, 'host', 'recording.integrity_failure', { recordingId: rec.id }).catch(() => {}); res.destroy(); }   // a chunk failed authentication: never deliver altered media
  }, 'Download failed'));

  app.delete(rpaths(''), auth, guard(async (req, res) => {
    const rec = await getRec(req.params.rid);
    if (!ownerOf(req, rec)) return fail(res, rec ? 403 : 404, rec ? 'You cannot delete this recording' : 'No such recording');
    if (rec.status === 'deleted') return fail(res, 410, 'Already deleted'); if (['recording', 'finalizing'].includes(rec.status)) return fail(res, 409, 'Stop the recording first');
    if (rec.legal_hold) { await audit(rec.meeting_id, rec.session_id, req.user.participantId, 'host', 'recording.delete_refused', { recordingId: rec.id, reason: 'legal_hold' }); return fail(res, 409, 'This recording is under legal hold and cannot be deleted'); }
    await destroy(rec, 'host_deleted', req.user.participantId, 'host'); res.json({ deleted: true });
  }, 'Could not delete'));

  // administrative legal hold: server-to-server / compliance tooling only, with its own secret (not the meeting token)
  app.post('/api/admin/recordings/:rid/hold', express.json({ limit: '4kb' }), guard(async (req, res) => {
    const want = String(env.RECORDING_ADMIN_SECRET || ''); const got = String(req.headers['x-qorlla-admin'] || '');
    if (!want) return fail(res, 404, 'Not found'); const a = Buffer.from(got), b = Buffer.from(want); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(res, 403, 'Forbidden');
    const rec = await getRec(req.params.rid); if (!rec) return fail(res, 404, 'No such recording'); if (rec.status === 'deleted') return fail(res, 410, 'Already deleted');
    const hold = req.body?.hold === true, reason = String(req.body?.reason || '').slice(0, 300);
    await db.query('UPDATE recordings SET legal_hold=$2, legal_hold_reason=$3 WHERE id=$1', [rec.id, hold, hold ? reason : null]);
    await audit(rec.meeting_id, rec.session_id, null, 'admin', hold ? 'recording.legal_hold_set' : 'recording.legal_hold_released', { recordingId: rec.id, reason }); res.json({ legalHold: hold });
  }, 'Could not change the hold'));

  // ------------------------------------------------------------------------------------------------------------------ audit trail + AI consent (separate purposes)
  app.get(paths('/recordings-audit'), auth, participant, hostOnly, guard(async (req, res) => {
    const { rows } = await db.query('SELECT id,audit_ref,actor,actor_role,action,detail,created_at FROM recording_audit WHERE meeting_id=$1 ORDER BY id DESC LIMIT 300', [req.params.id]);
    res.set('Cache-Control', 'no-store').json({ events: rows, chain: await verifyChain(db, req.params.id) });
  }, 'Audit unavailable'));

  app.post(paths('/ai-consent'), auth, participant, guard(async (req, res) => {
    const purpose = String(req.body?.purpose || ''), decision = String(req.body?.decision || '');
    if (!AI_PURPOSES.includes(purpose)) return fail(res, 400, 'Unknown purpose'); if (!['agree', 'decline', 'withdraw'].includes(decision)) return fail(res, 400, 'decision must be agree, decline or withdraw');
    const { rows: [last] } = await db.query('SELECT decision FROM ai_consents WHERE meeting_id=$1 AND participant_id=$2 AND purpose=$3 ORDER BY created_at DESC, id DESC LIMIT 1', [req.params.id, req.user.participantId, purpose]);
    if (decision === 'withdraw' && last?.decision !== 'agree') return fail(res, 409, 'There is no consent to withdraw');
    const ref = await audit(req.params.id, null, req.user.participantId, req.user.role, 'ai_consent.' + decision, { purpose });
    await db.query('INSERT INTO ai_consents(id,meeting_id,participant_id,participant_name,purpose,decision,policy_version,audit_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [crypto.randomUUID(), req.params.id, req.user.participantId, getName(req.params.id, req.user.participantId), purpose, decision, policyVersion, ref]);
    res.status(201).json({ auditRef: ref, purpose, decision, note: 'AI processing is not enabled in this version; this records your choice only.' });
  }, 'Could not record your choice'));

  app.get(paths('/consent-status'), auth, participant, guard(async (req, res) => {
    const { rows } = await db.query('SELECT DISTINCT ON (participant_id,purpose) participant_id,participant_name,purpose,decision FROM ai_consents WHERE meeting_id=$1 ORDER BY participant_id,purpose,created_at DESC,id DESC', [req.params.id]);
    const roster = getRoster(req.params.id), out = {};
    for (const p of AI_PURPOSES) { const mine = rows.filter((r) => r.purpose === p); out[p] = { agree: roster.filter((id) => mine.find((r) => r.participant_id === id)?.decision === 'agree').length, decline: roster.filter((id) => ['decline', 'withdraw'].includes(mine.find((r) => r.participant_id === id)?.decision)).length, mine: mine.find((r) => r.participant_id === req.user.participantId)?.decision || 'pending' }; out[p].pending = roster.length - out[p].agree - out[p].decline; }
    const { rows: [rs] } = await db.query("SELECT status FROM recording_sessions WHERE meeting_id=$1 AND status IN ('awaiting','blocked','ready','recording','paused') LIMIT 1", [req.params.id]);
    res.set('Cache-Control', 'no-store').json({ recording: { status: rs?.status || 'disabled' }, ai: out, aiProcessingEnabled: false });
  }, 'Status unavailable'));

  return media;
}
