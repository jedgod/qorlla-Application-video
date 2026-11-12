// ASCS v1-v2: server-tracked screen-share state for a Meet room (feature flag ASCS_ENABLED, OFF by default).
//
//   * ONE active presenter per meeting. This is enforced by the database (a partial unique index) and by a row lock on the meeting, so two start requests that
//     arrive together produce exactly one share and one 409, never two shares.
//   * Every change takes the next per-meeting revision number (meetings.share_revision) and is written, with its audit row, in ONE transaction. Events are sent
//     after the commit and carry that revision, so a page that sees an old revision after a newer one ignores it, and a stopped share can never be brought back.
//   * A share has a LEASE. The presenter's page renews it every few seconds; a share whose lease runs out (closed laptop, crashed tab) is expired by a sweeper,
//     which also ends shares of a meeting that has ended.
//   * Permission is never taken from the browser: the server asks host-controls (host, per-person grant, or sharing switched on for everyone). When that permission is
//     withdrawn, the share is revoked here (reconcile()), and the presenter's page is told to stop capturing.
//   * Retrying a start with the same clientRequestId returns the same outcome, even after the share has stopped; it never starts a second share.
//   * A person who starts again with a NEW request id (after a reload) replaces their own earlier share; anyone else is refused with 409 while a share is live.
//
// HONEST LIMITS (see docs/ASCS_V1_V2.md): screen media travels peer to peer in this Meet, so "revoke" is the server ending the share and telling every page; a page
// that ignores it cannot be force-stopped by the server (an SFU/bridge would be needed). There is no durable outbox worker: events are broadcast after commit and pages
// reconcile from GET /shares/current (which carries the revision) on join and reconnect.
import { randomUUID } from 'node:crypto';

export const KINDS = Object.freeze(['screen', 'window', 'tab']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; } }

export function registerAscs({ app, io, db, auth, member, room, socketOf, mayShare, enabled = false, leaseMs = 30_000, sweepMs = 10_000, disconnectGraceMs = 8_000 }) {
  const PATHS = (suffix) => [`/api/meetings/:id/shares${suffix}`, `/api/v1/meetings/:id/shares${suffix}`];
  const gate = (req, res, next) => (enabled ? next() : res.status(404).json({ error: 'Not available' }));
  const hostOnly = (req, res, next) => (req.user.role === 'host' ? next() : res.status(403).json({ error: 'Only the host can do this' }));
  const handle = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, ...e.extra });
      if (e?.code === '23505') return res.status(409).json({ error: 'Another presenter is active' });      // the unique index won a race
      console.error('[ascs]', e.message); if (!res.headersSent) res.status(500).json({ error: 'Sharing is unavailable' });
    }
  };

  const shape = (r) => r && ({ id: r.id, meetingId: r.meeting_id, ownerId: r.owner_id, kind: r.kind, mode: r.mode, state: r.state, revision: Number(r.revision), leaseExpiresAt: r.lease_expires_at, startedAt: r.started_at, endedAt: r.ended_at || null, endReason: r.end_reason || null });

  async function tx(fn) {
    const c = await db.connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  const lockMeeting = async (c, meetingId) => {
    const { rows: [m] } = await c.query('SELECT id, ended_at FROM meetings WHERE id=$1 FOR UPDATE', [meetingId]);
    if (!m) throw new HttpError(404, 'Meeting unavailable'); return m;
  };
  const bump = async (c, meetingId) => Number((await c.query('UPDATE meetings SET share_revision = share_revision + 1 WHERE id=$1 RETURNING share_revision', [meetingId])).rows[0].share_revision);
  const auditIn = (c, meetingId, pid, type, detail) => c.query('INSERT INTO audit_events(meeting_id, participant_id, event_type, detail) VALUES($1,$2,$3,$4)', [meetingId, pid, type, JSON.stringify(detail)]);
  const emit = (events) => { for (const e of events) io.to(room(e.meetingId)).emit(e.type, e); };
  const ev = (type, row, extra = {}) => ({ type, meetingId: row.meeting_id, revision: Number(row.revision), share: shape(row), ...extra });

  /** Ends the active share(s) of a meeting that have an unsound basis: lease run out, or the meeting is over. Runs inside the caller's transaction (meeting row locked). */
  async function expireIn(c, meetingId, meetingEnded) {
    const { rows } = await c.query("SELECT id FROM meeting_shares WHERE meeting_id=$1 AND state='active' AND (lease_expires_at < now() OR $2::boolean) FOR UPDATE", [meetingId, !!meetingEnded]);
    const events = [];
    for (const { id } of rows) {
      const rev = await bump(c, meetingId);
      const { rows: [r] } = await c.query("UPDATE meeting_shares SET state='expired', revision=$2, ended_at=now(), end_reason=$3 WHERE id=$1 RETURNING *", [id, rev, meetingEnded ? 'meeting_ended' : 'lease_expired']);
      await auditIn(c, meetingId, r.owner_id, 'share.expired', { shareId: id, reason: r.end_reason });
      events.push(ev('share.stopped', r, { reason: r.end_reason }));
    }
    return events;
  }

  /** Ends one active share with the given state. Returns the events to send after commit ([] when there was nothing active to end). */
  async function endIn(c, meetingId, shareId, state, reason, actorId) {
    const { rows: [cur] } = await c.query("SELECT id, owner_id FROM meeting_shares WHERE id=$1 AND meeting_id=$2 AND state='active' FOR UPDATE", [shareId, meetingId]);
    if (!cur) return [];
    const rev = await bump(c, meetingId);
    const { rows: [r] } = await c.query('UPDATE meeting_shares SET state=$2, revision=$3, ended_at=now(), end_reason=$4 WHERE id=$1 RETURNING *', [shareId, state, rev, reason]);
    await auditIn(c, meetingId, actorId, 'share.' + state, { shareId, ownerId: r.owner_id, reason });
    return [ev(state === 'revoked' ? 'share.revoked' : 'share.stopped', r, { reason })];
  }

  /** May this person hold the floor RIGHT NOW? Still admitted (Shield or the host can withdraw that), and still permitted. ANY doubt, including a lookup that throws, is a NO:
   *  an unauthorized share must never stay up because a check broke. */
  async function allowedNow(executor, meetingId, ownerId) {
    try {
      const { rows: [p] } = await executor.query('SELECT role, admission FROM participants WHERE id=$1 AND meeting_id=$2', [ownerId, meetingId]);
      if (!p || p.admission !== 'admitted') return { ok: false, reason: 'participant_removed' };
      if (p.role === 'host') return { ok: true };
      return (await mayShare(meetingId, ownerId, p.role)) ? { ok: true } : { ok: false, reason: 'permission_withdrawn' };
    } catch { return { ok: false, reason: 'authorization_unavailable' }; }
  }

  const currentRow = async (executor, meetingId) => (await executor.query("SELECT * FROM meeting_shares WHERE meeting_id=$1 AND state='active' AND lease_expires_at > now()", [meetingId])).rows[0];

  // ---- who is sharing now (late joiners and reconnecting pages reconcile from this)
  app.get(PATHS('/current'), gate, auth, member, handle(async (req, res) => {
    const { rows: [m] } = await db.query('SELECT share_revision FROM meetings WHERE id=$1', [req.params.id]);
    const r = await currentRow(db, req.params.id);
    res.set('Cache-Control', 'no-store').json({ revision: Number(m?.share_revision || 0), share: shape(r) || null });
  }));

  // ---- start. Idempotent on clientRequestId.
  app.post(PATHS(''), gate, auth, member, handle(async (req, res) => {
    const b = req.body || {}, { id: meetingId } = req.params, pid = req.user.participantId;
    if (!KINDS.includes(b.kind)) throw new HttpError(400, 'Choose screen, window or tab');
    if ((b.mode ?? 'content') !== 'content') throw new HttpError(400, 'Only the content mode is available');
    if (typeof b.clientRequestId !== 'string' || b.clientRequestId.length < 1 || b.clientRequestId.length > 128) throw new HttpError(400, 'A request id is required');
    if (req.user.role !== 'host' && !(await mayShare(meetingId, pid, req.user.role))) throw new HttpError(403, 'The host has not allowed you to share your screen');
    const out = await tx(async (c) => {
      const m = await lockMeeting(c, meetingId); if (m.ended_at) throw new HttpError(404, 'Meeting unavailable');
      const { rows: [again] } = await c.query('SELECT * FROM meeting_shares WHERE meeting_id=$1 AND owner_id=$2 AND request_id=$3', [meetingId, pid, b.clientRequestId]);
      if (again) return { status: 200, share: shape(again), events: [] };            // the same answer as the first time, whatever the share has become since
      const events = await expireIn(c, meetingId, false);
      let active = await currentRow(c, meetingId);
      // The SAME person starting again (a reloaded or crashed page lost its capture, and their old lease has not run out yet) takes over their own share: the old one ends
      // as 'replaced' and the new one begins in the same transaction, so there is still exactly ONE active share and nobody waits for a lease.
      if (active && active.owner_id === pid) { events.push(...await endIn(c, meetingId, active.id, 'stopped', 'replaced', pid)); active = null; }
      // refuse AFTER the commit: a lease that expired just now must stay expired (throwing here would roll that back while the page was already told)
      if (active) return { status: 409, share: { error: 'Another presenter is active', shareId: active.id }, events };
      const rev = await bump(c, meetingId);
      const { rows: [r] } = await c.query("INSERT INTO meeting_shares(id, meeting_id, owner_id, kind, mode, request_id, state, revision, lease_expires_at) VALUES($1,$2,$3,$4,'content',$5,'active',$6, now() + ($7 || ' milliseconds')::interval) RETURNING *", [randomUUID(), meetingId, pid, b.kind, b.clientRequestId, rev, String(leaseMs)]);
      await auditIn(c, meetingId, pid, 'share.started', { shareId: r.id, kind: b.kind });
      events.push(ev('share.started', r));
      return { status: 201, share: shape(r), events };
    });
    emit(out.events); res.status(out.status).json(out.share);
  }));

  // ---- the presenter's page renews the lease while it is capturing
  app.post(PATHS('/:sid/heartbeat'), gate, auth, member, handle(async (req, res) => {
    const { id: meetingId, sid } = req.params; if (!UUID.test(sid)) throw new HttpError(400, 'Invalid share');
    // a presenter who is no longer allowed cannot renew: the share is ended now (and if even that fails, the lease simply runs out: nothing renews an unauthorized share)
    const permitted = (await allowedNow(db, meetingId, req.user.participantId)).ok;
    if (!permitted) await reconcileWithRetry(meetingId).catch(() => {});
    const { rows: [r] } = permitted ? await db.query("UPDATE meeting_shares SET lease_expires_at = now() + ($4 || ' milliseconds')::interval WHERE id=$1 AND meeting_id=$2 AND owner_id=$3 AND state='active' AND lease_expires_at > now() RETURNING *", [sid, meetingId, req.user.participantId, String(leaseMs)]) : { rows: [] };
    const { rows: [m] } = await db.query('SELECT share_revision FROM meetings WHERE id=$1', [meetingId]);
    if (r) return res.json({ leaseExpiresAt: r.lease_expires_at, revision: Number(m.share_revision) });
    await sweepMeeting(meetingId);                                                     // a lease that ran out is closed and announced now, not at the next sweep
    const { rows: [now] } = await db.query('SELECT state, owner_id FROM meeting_shares WHERE id=$1 AND meeting_id=$2', [sid, meetingId]);
    if (!now || now.owner_id !== req.user.participantId) throw new HttpError(404, 'No such share');
    throw new HttpError(409, 'Share is not active', { state: now.state, revision: Number((await db.query('SELECT share_revision FROM meetings WHERE id=$1', [meetingId])).rows[0].share_revision) });
  }));

  // ---- host hands the floor to someone else: ends the current share and lets exactly that person start the next one. Registered BEFORE '/:sid' routes.
  app.post(PATHS('/handoff'), gate, auth, member, hostOnly, handle(async (req, res) => {
    const { id: meetingId } = req.params, to = req.body?.to;
    if (typeof to !== 'string' || !UUID.test(to)) throw new HttpError(400, 'Choose who presents next');
    const out = await tx(async (c) => {
      const m = await lockMeeting(c, meetingId); if (m.ended_at) throw new HttpError(404, 'Meeting unavailable');
      const { rows: [p] } = await c.query("SELECT id, role FROM participants WHERE id=$1 AND meeting_id=$2 AND admission='admitted' AND left_at IS NULL", [to, meetingId]);
      if (!p) throw new HttpError(404, 'That person is not in the meeting');
      if (p.role === 'host') throw new HttpError(400, 'The host does not need permission');
      const events = await expireIn(c, meetingId, false);
      const active = await currentRow(c, meetingId);
      let revoked = null;
      if (active) {
        events.push(...await endIn(c, meetingId, active.id, 'revoked', 'handoff', req.user.participantId)); revoked = active.id;
        if (active.owner_id !== to) await c.query("UPDATE participants SET can_share=false WHERE id=$1 AND role<>'host'", [active.owner_id]);       // the floor moved: the previous presenter's personal grant goes with it
      }
      await c.query('UPDATE participants SET can_share=true WHERE id=$1', [to]);
      const rev = await bump(c, meetingId);
      await auditIn(c, meetingId, req.user.participantId, 'share.handoff', { to, revoked });
      events.push({ type: 'share.updated', meetingId, revision: rev, share: null, nextPresenter: to });
      return { events, revoked, revision: rev };
    });
    emit(out.events); const sid = socketOf?.(meetingId, to); if (sid) io.to(sid).emit('tools-changed', { refresh: true });
    res.json({ revoked: out.revoked, next: to, revision: out.revision });
  }));

  // ---- stop: the presenter, or the host
  app.delete(PATHS('/:sid'), gate, auth, member, handle(async (req, res) => {
    const { id: meetingId, sid } = req.params; if (!UUID.test(sid)) throw new HttpError(400, 'Invalid share');
    const out = await tx(async (c) => {
      await lockMeeting(c, meetingId);
      const { rows: [cur] } = await c.query('SELECT owner_id, state FROM meeting_shares WHERE id=$1 AND meeting_id=$2', [sid, meetingId]);
      if (!cur) throw new HttpError(404, 'No such share');
      if (cur.owner_id !== req.user.participantId && req.user.role !== 'host') throw new HttpError(403, 'Not allowed to stop this share');
      const events = await endIn(c, meetingId, sid, 'stopped', cur.owner_id === req.user.participantId ? 'stopped' : 'stopped_by_host', req.user.participantId);
      return { events, stopped: events.length > 0, revision: Number((await c.query('SELECT share_revision FROM meetings WHERE id=$1', [meetingId])).rows[0].share_revision) };
    });
    emit(out.events); res.json({ stopped: out.stopped, revision: out.revision });
  }));

  // ---- the host takes the floor back
  app.post(PATHS('/:sid/revoke'), gate, auth, member, hostOnly, handle(async (req, res) => {
    const { id: meetingId, sid } = req.params; if (!UUID.test(sid)) throw new HttpError(400, 'Invalid share');
    const out = await tx(async (c) => {
      await lockMeeting(c, meetingId);
      const events = await endIn(c, meetingId, sid, 'revoked', 'host_revoked', req.user.participantId);
      return { events, revoked: events.length > 0, revision: Number((await c.query('SELECT share_revision FROM meetings WHERE id=$1', [meetingId])).rows[0].share_revision) };
    });
    emit(out.events); res.json({ revoked: out.revoked, revision: out.revision });
  }));

  // ---- internal: used by host-controls when a permission changes, by the sweeper, and by the signalling gate
  async function sweepMeeting(meetingId) {
    const events = await tx(async (c) => { const m = await lockMeeting(c, meetingId).catch(() => null); return m ? expireIn(c, meetingId, !!m.ended_at) : []; });
    emit(events); return events.length;
  }
  /** The permission to share may have been withdrawn (a person's grant removed, or sharing switched off for everyone): end a share that is no longer allowed. */
  async function reconcile(meetingId) {
    const events = await tx(async (c) => {
      await lockMeeting(c, meetingId);
      const a = await currentRow(c, meetingId); if (!a) return [];
      const v = await allowedNow(c, meetingId, a.owner_id); if (v.ok) return [];
      return endIn(c, meetingId, a.id, 'revoked', v.reason, null);
    });
    emit(events); return events.length;
  }
  /** reconcile, retried a few times; THROWS if it still cannot be done, so the caller can say so instead of pretending (the sweeper then keeps trying). */
  async function reconcileWithRetry(meetingId, tries = 3) {
    let last; for (let i = 0; i < tries; i++) { try { return await reconcile(meetingId); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 40 * (i + 1))); } }
    throw last;
  }
  /** The invariant "every live share belongs to someone who may still share", checked for ALL meetings. It runs on every sweep, so a reconcile that was missed (a failure, a restart,
   *  a change made by another path) is corrected within one sweep interval. */
  async function reconcileAll() {
    const { rows } = await db.query("SELECT DISTINCT meeting_id FROM meeting_shares WHERE state='active'");
    let ended = 0, failed = 0;
    for (const { meeting_id } of rows) { try { ended += await reconcile(meeting_id); } catch (e) { failed++; console.error('[ascs] reconcile failed:', e.message); } }
    return { ended, failed };
  }
  /** The presenter's signalling connection dropped: the lease is cut to a short grace period (a reload or a blip renews it with the next heartbeat; a vanished page loses the share in seconds, not after a whole lease). */
  async function onDisconnect(meetingId, pid) {
    if (!enabled) return 0;
    const { rowCount } = await db.query("UPDATE meeting_shares SET lease_expires_at = LEAST(lease_expires_at, now() + ($3 || ' milliseconds')::interval) WHERE meeting_id=$1 AND owner_id=$2 AND state='active'", [meetingId, pid, String(disconnectGraceMs)]);
    return rowCount;
  }
  /** True when this person has the live share of the meeting (what the signalling gate checks before it announces a share to the room). */
  const ownsActive = async (meetingId, pid) => { const r = await currentRow(db, meetingId); if (!r || r.owner_id !== pid) return false; return (await allowedNow(db, meetingId, pid)).ok; };

  let timer = null;
  if (enabled && sweepMs > 0) {
    timer = setInterval(async () => {
      try {
        const { rows } = await db.query("SELECT DISTINCT s.meeting_id FROM meeting_shares s JOIN meetings m ON m.id=s.meeting_id WHERE s.state='active' AND (s.lease_expires_at < now() OR m.ended_at IS NOT NULL)");
        for (const { meeting_id } of rows) await sweepMeeting(meeting_id);
        await reconcileAll();
      } catch (e) { console.error('[ascs] sweep failed:', e.message); }
    }, sweepMs); timer.unref?.();
  }
  return { enabled, leaseMs, ownsActive, reconcile, reconcileWithRetry, reconcileAll, onDisconnect, sweepMeeting, close: () => { if (timer) clearInterval(timer); } };
}
