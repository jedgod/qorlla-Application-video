// Shared files in a Meet room (v4.34), built around an IMMUTABLE scan pipeline:
//   upload -> the SERVER streams the bytes into a quarantine object it names (size-capped, hashed while written, read-only) -> exactly those bytes are scanned (anti-malware + content-type + active content) ->
//   clean: promoted to a write-once, content-addressed object clean/<sha256>; anything else: deleted -> download re-hashes the clean object and refuses on mismatch.
// There is no pre-signed upload URL, so nobody can overwrite an object after it was scanned. A scanner that cannot run leaves the file "scanning" (retried by a supervised sweep, then rejected): never clean by default.
//
// Access (decided on the server from the participant's token and CURRENT room, never from the browser): the host sees and approves everything; a guest's upload is hidden from other guests until the host approves it;
// a "room" file is for the people in that room, a "meeting" file (host only) for everybody, a "host_only" file for the host. A person outside a room does not learn that a room's files exist.
import { randomUUID } from 'node:crypto';
import { ALLOWED_TYPES, MAX_FILE_BYTES } from './file-scanner.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (status, error) => Object.assign(new Error(error), { status });
export const FILE_LIMITS = Object.freeze({ maxBytes: MAX_FILE_BYTES, perMeeting: 100, uploadsPerMinute: 6, retentionDays: 7, scanAttempts: 3, scanLeaseSeconds: 60 });

export function registerFiles({ app, db, auth, member, fail, store, scanner, scopeOf, notify = () => {}, audit = async () => {}, env = process.env, limits = FILE_LIMITS, sweepMs = 60000 }) {
  const enabled = env.MEET_FILES === 'on' && !!store?.ready && !!scanner?.ready;
  const paths = (p) => ['/api/meetings/:id/files' + p, '/api/v1/meetings/:id/files' + p];
  const run = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { if (e.status) return fail(res, e.status, e.message); console.error('[files]', e.message); if (!res.headersSent) fail(res, 500, 'Something went wrong'); } };
  const gate = (req, res, next) => (enabled ? next() : fail(res, 503, 'Shared files are not available on this server' + (env.MEET_FILES === 'on' ? ': ' + (store?.reason || scanner?.reason || 'not configured') : '')));
  const isHost = (req) => req.user.role === 'host';
  const rate = new Map(); const okRate = (pid) => { const now = Date.now(), a = (rate.get(pid) || []).filter((t) => now - t < 60000); if (a.length >= limits.uploadsPerMinute) { rate.set(pid, a); return false; } a.push(now); rate.set(pid, a); return true; };
  const view = (f, req) => ({ id: f.id, name: f.filename, type: f.declared_type, bytes: f.bytes === null ? null : Number(f.bytes), state: f.state, reason: isHost(req) || f.uploader_id === req.user.participantId ? f.reason : undefined, visibility: f.visibility, approved: f.host_approved,
    mine: f.uploader_id === req.user.participantId, roomId: f.room_id, at: f.created_at, expiresAt: f.expires_at });
  /** may this person download this file right now */
  function canRead(req, f) {
    if (f.state !== 'clean' || !f.host_approved || f.deleted_at || new Date(f.expires_at) <= new Date()) return false;
    if (isHost(req)) return true;
    if (f.uploader_id === req.user.participantId) return true;
    if (f.visibility === 'host_only') return false;
    return f.visibility === 'meeting' || (f.room_id || null) === (scopeOf(req.params.id, req.user.participantId) ?? null);
  }

  // ---- scanning: one file, fenced by a lease so two workers never scan (or promote) the same file twice
  async function scanFile(id) {
    const lease = await db.query(`UPDATE more_files SET scan_lease=now() + make_interval(secs => $2), scan_attempts=scan_attempts+1 WHERE id=$1 AND state='scanning' AND (scan_lease IS NULL OR scan_lease < now()) RETURNING *`, [id, limits.scanLeaseSeconds]);
    const f = lease.rows[0]; if (!f) return null;
    const settle = async (state, reason, extra = {}) => { const r = await db.query(`UPDATE more_files SET state=$2, reason=$3, detected_type=$4, scanned_at=now(), scan_lease=NULL, quarantine_key=NULL WHERE id=$1 AND state='scanning' AND sha256=$5 RETURNING id`, [id, state, reason, extra.detectedType ?? null, f.sha256]); return r.rowCount; };
    let bytes; try { bytes = await store.quarantineRead(f.quarantine_key); } catch { await settle('rejected', 'quarantine_missing'); return 'rejected'; }
    let verdict;
    try { verdict = await scanner.inspect(bytes, f.declared_type); }
    catch (e) { if (f.scan_attempts >= limits.scanAttempts) { await settle('rejected', 'scan_unavailable'); await store.removeQuarantine(f.quarantine_key).catch(() => {}); return 'rejected'; } return 'scanning'; }          // could not run: stays in quarantine, retried, never clean
    if (!verdict.clean) { await settle('rejected', verdict.reason, { detectedType: verdict.detectedType }); await store.removeQuarantine(f.quarantine_key).catch(() => {}); return 'rejected'; }
    try { await store.promote(f.quarantine_key, f.sha256); }          // re-hashes the quarantine object: only the scanned bytes can be promoted
    catch (e) { await settle('rejected', e.code === 'hash_mismatch' ? 'tampered' : 'promotion_failed'); await store.removeQuarantine(f.quarantine_key).catch(() => {}); return 'rejected'; }
    const ok = await settle('clean', 'ok', { detectedType: verdict.detectedType }); await store.removeQuarantine(f.quarantine_key).catch(() => {}); return ok ? 'clean' : null;
  }
  /** supervised sweep: retry stale scans, expire and purge, remove orphaned quarantine objects */
  async function sweep() {
    const out = { rescanned: 0, purged: 0, orphans: 0 };
    for (const r of (await db.query(`SELECT id FROM more_files WHERE state='scanning' AND (scan_lease IS NULL OR scan_lease < now()) AND created_at < now() - interval '30 seconds' ORDER BY created_at LIMIT 20`)).rows) { await scanFile(r.id).catch(() => {}); out.rescanned++; }
    await db.query(`UPDATE more_files SET state='rejected', reason='upload_incomplete' WHERE state='uploading' AND created_at < now() - interval '15 minutes'`);
    const gone = (await db.query(`UPDATE more_files SET state='deleted', deleted_at=COALESCE(deleted_at, now()), reason=COALESCE(reason,'expired') WHERE state IN ('clean','rejected') AND expires_at < now() RETURNING sha256`)).rows;
    const shas = new Set([...gone.map((g) => g.sha256), ...(await db.query(`SELECT DISTINCT sha256 FROM more_files WHERE state='deleted' AND sha256 IS NOT NULL AND deleted_at > now() - interval '1 day'`)).rows.map((g) => g.sha256)].filter(Boolean));
    for (const sha of shas) { if ((await db.query(`SELECT 1 FROM more_files WHERE sha256=$1 AND state IN ('clean','scanning')`, [sha])).rowCount) continue; if (await store.hasClean(sha)) { await store.removeClean(sha); out.purged++; } }          // an object goes only when no live file uses those bytes
    const live = new Set((await db.query(`SELECT quarantine_key FROM more_files WHERE state IN ('scanning','uploading') AND quarantine_key IS NOT NULL`)).rows.map((r) => r.quarantine_key));
    for (const q of await store.listQuarantine()) if (!live.has(q.key) && Date.now() - q.mtimeMs > 15 * 60000) { await store.removeQuarantine(q.key); out.orphans++; }
    return out;
  }
  const timer = enabled ? setInterval(() => { sweep().catch((e) => console.error('[files] sweep failed', e.message)); }, sweepMs) : null; timer?.unref?.();

  app.get(paths(''), auth, member, gate, run(async (req, res) => {
    const mid = req.params.id;
    const { rows } = await db.query(`SELECT * FROM more_files WHERE meeting_id=$1 AND state<>'deleted' AND deleted_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 200`, [mid]);
    res.set('Cache-Control', 'no-store').json({ files: rows.filter((f) => isHost(req) || f.uploader_id === req.user.participantId || canRead(req, f)).map((f) => view(f, req)), limits: { maxBytes: limits.maxBytes, types: ALLOWED_TYPES } });
  }));

  app.post(paths(''), auth, member, gate, run(async (req, res) => {
    const mid = req.params.id, pid = req.user.participantId; let name; try { name = decodeURIComponent(String(req.get('x-filename') || '')); } catch { throw bad(400, 'Invalid file name'); }
    const type = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase(), len = Number(req.get('content-length'));
    if (!name || name.length > 180 || /[\\/\u0000-\u001f]/.test(name) || name.startsWith('.')) throw bad(400, 'Invalid file name');
    if (!ALLOWED_TYPES.includes(type)) throw bad(415, 'That file type is not allowed (PDF, text, PNG, JPEG, Word .docx)');
    if (!Number.isSafeInteger(len) || len < 1) throw bad(411, 'The file size is required'); if (len > limits.maxBytes) throw bad(413, 'Files can be at most ' + Math.floor(limits.maxBytes / 1048576) + ' MB');
    const scope = scopeOf(mid, pid) ?? null; let visibility = String(req.get('x-visibility') || 'room'); if (!['room', 'meeting', 'host_only'].includes(visibility)) throw bad(400, 'Invalid visibility'); if (visibility === 'meeting' && !isHost(req)) throw bad(403, 'Only the host can share a file with the whole meeting');
    if (!okRate(pid)) throw bad(429, 'Too many uploads. Wait a minute.');
    if ((await db.query(`SELECT count(*)::int AS n FROM more_files WHERE meeting_id=$1 AND state<>'deleted'`, [mid])).rows[0].n >= limits.perMeeting) throw bad(409, 'This meeting has reached its file limit');
    const id = randomUUID(); await db.query(`INSERT INTO more_files(id, meeting_id, room_id, uploader_id, filename, declared_type, visibility, host_approved, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(days => $9))`, [id, mid, scope, pid, name, type, visibility, isHost(req), limits.retentionDays]);
    let w; try { w = await store.quarantineWrite(req, { id, maxBytes: limits.maxBytes }); }
    catch (e) { await db.query(`UPDATE more_files SET state='rejected', reason=$2 WHERE id=$1`, [id, e.code === 'too_large' ? 'too_large' : 'upload_failed']); throw bad(e.code === 'too_large' ? 413 : 400, e.code === 'too_large' ? 'The file is larger than it said' : 'The upload was interrupted'); }
    if (w.bytes !== len) { await store.removeQuarantine(w.key); await db.query(`UPDATE more_files SET state='rejected', reason='size_mismatch' WHERE id=$1`, [id]); throw bad(400, 'The file size did not match'); }
    await db.query(`UPDATE more_files SET state='scanning', bytes=$2, sha256=$3, quarantine_key=$4 WHERE id=$1`, [id, w.bytes, w.sha256, w.key]);
    const state = (await scanFile(id)) || (await db.query('SELECT state FROM more_files WHERE id=$1', [id])).rows[0].state;
    await audit(mid, pid, 'file.uploaded', { id, state, bytes: w.bytes }); notify(mid, scope, 'files'); res.status(state === 'clean' ? 201 : 202).json({ id, state, approved: isHost(req) });
  }));

  async function fileFor(req) { if (!UUID.test(req.params.fid)) throw bad(400, 'Invalid file'); const f = (await db.query('SELECT * FROM more_files WHERE id=$1 AND meeting_id=$2', [req.params.fid, req.params.id])).rows[0]; if (!f || f.state === 'deleted') throw bad(404, 'File not found'); return f; }
  app.get(paths('/:fid/download'), auth, member, gate, run(async (req, res) => {
    const f = await fileFor(req); if (!canRead(req, f)) throw bad(404, 'File not found');          // another room's file, or one not yet approved: it does not exist for you
    let bytes; try { bytes = await store.readClean(f.sha256); } catch (e) { console.error('[files] object failed verification', f.id); await db.query(`UPDATE more_files SET state='rejected', reason='object_corrupt' WHERE id=$1`, [f.id]); throw bad(410, 'This file failed its integrity check and was withdrawn'); }
    await audit(req.params.id, req.user.participantId, 'file.downloaded', { id: f.id });
    res.set({ 'Content-Type': f.declared_type, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'private, no-store', 'Content-Length': String(bytes.length) }).end(bytes);
  }));
  app.post(paths('/:fid/approve'), auth, member, gate, run(async (req, res) => {
    if (!isHost(req)) throw bad(403, 'Only the host can approve files'); const f = await fileFor(req); const yes = req.body?.approved !== false;
    const r = await db.query(`UPDATE more_files SET host_approved=$2 WHERE id=$1 AND state='clean' RETURNING id`, [f.id, yes]); if (!r.rowCount) throw bad(409, 'Only a clean file can be approved');
    await audit(req.params.id, req.user.participantId, yes ? 'file.approved' : 'file.unapproved', { id: f.id }); notify(req.params.id, f.room_id, 'files'); res.json({ id: f.id, approved: yes });
  }));
  app.delete(paths('/:fid'), auth, member, gate, run(async (req, res) => {
    const f = await fileFor(req); if (!isHost(req) && f.uploader_id !== req.user.participantId) throw bad(403, 'Only the host or the person who uploaded it can delete a file');
    await db.query(`UPDATE more_files SET state='deleted', deleted_at=now(), reason='deleted' WHERE id=$1`, [f.id]);
    if (f.quarantine_key) await store.removeQuarantine(f.quarantine_key).catch(() => {});
    if (f.sha256 && !(await db.query(`SELECT 1 FROM more_files WHERE sha256=$1 AND state IN ('clean','scanning')`, [f.sha256])).rowCount) await store.removeClean(f.sha256).catch(() => {});          // the bytes go with the last file that used them
    await audit(req.params.id, req.user.participantId, 'file.deleted', { id: f.id }); notify(req.params.id, f.room_id, 'files'); res.json({ ok: true });
  }));
  return { enabled, scanFile, sweep, stop: () => timer && clearInterval(timer) };
}
