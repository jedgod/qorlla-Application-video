// ASCS-M1.2: connects the RELAY AUTHORITY (relay-authority.mjs) to Meet's share lifecycle (ascs.mjs). Off unless ASCS_RELAY_ENABLED=true (and ASCS_ENABLED=true).
//
//   * POST /api/meetings/:id/shares/:sid/relay-credentials   -- the ONLY way to obtain TURN credentials for a share's dedicated relay-only connection. The SERVER decides the role
//     (the share's owner is the presenter, everybody else a viewer: the page cannot choose), checks that the share is live and the caller still allowed, and asks the relay to issue
//     a short-lived credential that exists only for that meeting + participant + share. A reconnect or an ICE restart therefore needs a FRESH authorization.
//   * onShareEnded  -- the share stopped, was revoked (host, permission, Shield) or expired: its credentials are revoked and its relay allocations terminated, in that order.
//   * startGuard    -- FAIL CLOSED: while the credential store or the relay's control service is unreachable, no NEW share can start.
//   * reconcile     -- on boot and on every sweep: finishes any revocation that was recorded but not completed, ends credentials of shares that are no longer active (a crash between
//     the share ending and its credentials being revoked), and terminates allocations of expired credentials.
import { RelayUnavailable, RelayRefused } from './relay-authority.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIVE_PER_PERSON_PER_SHARE = 6;           // reconnects need fresh credentials; this bounds a client that asks again and again

/** The two hooks ascs.mjs takes at construction (before the routes can exist). */
export function createRelayHooks({ relay, log = console }) {
  return {
    onShareEnded: async (e) => {
      const r = await relay.revokeShare(e.share.id, 'share_' + (e.reason || e.type));
      if (r.errors.length) log.error('[ascs-relay] share ' + e.share.id + ' revoked, termination incomplete (the reconciler will retry): ' + r.errors.join('; '));
    },
    onHeartbeat: async (shareId) => { await relay.renewShare(shareId); },          // the share is alive: its relay credentials are extended with it
    startGuard: async () => { const h = await relay.health(); return h.ok ? { ok: true } : { ok: false, error: 'Screen sharing is unavailable: the relay cannot be controlled right now' }; },
  };
}

export function registerRelayRoutes({ app, auth, member, ascs, relay, db, bridgeAuth = null, requireSession = null, turnUrls, sweepMs = 10_000, alertPendingSeconds = 30, log = console }) {
  const PATHS = ['/api/meetings/:id/shares/:sid/relay-credentials', '/api/v1/meetings/:id/shares/:sid/relay-credentials'];
  app.post(PATHS, auth, member, async (req, res) => {
    try {
      const { id: meetingId, sid } = req.params, pid = req.user.participantId; if (!UUID.test(sid)) return res.status(400).json({ error: 'Invalid share' });
      const owner = await ascs.shareOwner(meetingId, sid); if (!owner) return res.status(404).json({ error: 'No such share' });
      if (!(await ascs.isShareLive(meetingId, sid))) return res.status(409).json({ error: 'This share is not active' });
      if (requireSession && !requireSession(meetingId, pid)) return res.status(403).json({ error: 'No live authorized session: reconnect to the meeting first' });          // M1.3: no Shield-authorized session, no relay credential
      const role = owner === pid ? 'presenter' : 'viewer';                                                  // decided HERE: never taken from the request
      if (role === 'presenter' && !(await ascs.allowedNow(meetingId, pid)).ok) return res.status(403).json({ error: 'You are not allowed to share' });
      const { rows: [c] } = await db.query("SELECT count(*)::int n FROM relay_credentials WHERE meeting_id=$1 AND participant_id=$2 AND share_id=$3 AND revoked_at IS NULL AND expires_at > now()", [meetingId, pid, sid]);
      if (c.n >= MAX_LIVE_PER_PERSON_PER_SHARE) return res.status(429).json({ error: 'Too many live relay credentials for this share' });
      const cred = await relay.issue({ meetingId, participantId: pid, shareId: sid, role }, { stillActive: () => ascs.isShareLive(meetingId, sid) });
      res.set('Cache-Control', 'no-store').json({ role, iceTransportPolicy: 'relay', iceServers: [{ urls: turnUrls, username: cred.username, credential: cred.credential }], expiresAt: cred.expiresAt, ttlSeconds: cred.ttlSeconds });
    } catch (e) {
      if (e instanceof RelayUnavailable) return res.status(503).json({ error: 'Screen sharing is unavailable: the relay cannot be controlled right now' });         // fail closed
      if (e instanceof RelayRefused) return res.status(409).json({ error: 'This share is no longer authorized' });
      log.error('[ascs-relay] credential request failed:', e.message); if (!res.headersSent) res.status(500).json({ error: 'Screen sharing is unavailable' });
    }
  });

  let lastAudit = { at: null, violations: [] };
  async function reconcileAll() {
    const out = { relay: await relay.reconcile(), endedShares: 0 };
    const { rows } = await db.query("SELECT DISTINCT rc.share_id FROM relay_credentials rc JOIN meeting_shares s ON s.id = rc.share_id WHERE rc.revoked_at IS NULL AND s.state <> 'active'");
    for (const { share_id } of rows) { await relay.revokeShare(share_id, 'share_not_active'); out.endedShares++; }
    // M1.3: a person who is no longer admitted (removed, denied, or a change that bypassed the hooks) keeps no relay credential and no allocation
    const gone = await db.query("SELECT DISTINCT rc.meeting_id, rc.participant_id FROM relay_credentials rc LEFT JOIN participants p ON p.id = rc.participant_id WHERE rc.revoked_at IS NULL AND (p.id IS NULL OR p.admission <> 'admitted')");
    for (const g of gone.rows) { await relay.revokeParticipant(g.meeting_id, g.participant_id, 'participant_not_admitted'); out.endedShares++; }
    // M1.3: after repairing, CHECK the invariants between the registry and the share state; whatever is still wrong is an alert (logged as [ALERT] and exposed by /api/ops/relay)
    const violations = await relay.audit(); lastAudit = { at: new Date().toISOString(), violations };
    if (violations.length) log.error('[ALERT][ascs-relay] invariant violated after reconcile: ' + JSON.stringify(violations.slice(0, 5)));
    return out;
  }
  // MONITORING (service token): JSON snapshot + Prometheus text. The alert that matters is oldest_pending_revocation_seconds: a revocation that is recorded but NOT yet enforced.
  if (bridgeAuth) {
    app.get('/api/ops/relay', bridgeAuth, async (req, res) => {
      try { const st = await relay.stats(); res.set('Cache-Control', 'no-store').json({ ...st, invariantAudit: lastAudit, alerts: [
        ...(st.pending > 0 && st.oldest_pending_seconds > alertPendingSeconds ? [{ severity: 'critical', name: 'RelayRevocationUnenforced', detail: st.pending + ' revocation(s) not enforced for ' + Math.round(st.oldest_pending_seconds) + ' s' }] : []),
        ...(!st.healthy ? [{ severity: 'critical', name: 'RelayControlDown', detail: 'redis=' + st.redisUp + ' cli=' + st.cliUp + ': no new sharing; revocations stay pending' }] : []),
        ...(lastAudit.violations.length ? [{ severity: 'critical', name: 'RelayInvariantViolated', detail: lastAudit.violations.length + ' violation(s)' }] : []) ] }); }
      catch (e) { res.status(500).json({ error: 'stats unavailable' }); }
    });
    app.get('/api/ops/relay/metrics', bridgeAuth, async (req, res) => { try { res.set('Content-Type', 'text/plain; version=0.0.4').set('Cache-Control', 'no-store').send(await relay.prometheus()); } catch (e) { res.status(500).send('# unavailable'); } });
  }
  const run = () => reconcileAll().catch((e) => log.error('[ascs-relay] reconcile failed:', e.message));
  run();                                                                                                     // on boot: finish whatever the previous process left half done
  const timer = setInterval(run, sweepMs); timer.unref?.();

  return {
    reconcile: reconcileAll,
    /** Shield (or the host) removed this person: every credential they hold, as presenter or viewer, in this meeting is revoked and its allocations terminated. */
    onParticipantRevoked: (meetingId, participantId) => relay.revokeParticipant(meetingId, participantId, 'participant_removed'),
    close: () => clearInterval(timer),
  };
}
