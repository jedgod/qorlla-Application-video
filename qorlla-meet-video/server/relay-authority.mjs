// ASCS-M1.2: the RELAY AUTHORITY. It issues, revokes and terminates the TURN credentials of a screen share's dedicated relay-only connection.
//
// WHY it exists (measured in ASCS-M1.1): cancelling a relay allocation is not enough, because a client holding a still-valid credential simply allocates again; and stateless REST
// credentials cannot be revoked before they expire. So credentials here are INDIVIDUAL (one per meeting + participant + share + role), SHORT-LIVED, and stored in coturn's USER
// DATABASE (Redis) where they can be deleted. Revocation is a fixed, idempotent sequence:
//     1. record it DURABLY (relay_credentials.revoked_at)          -- survives a crash at any later step
//     2. DELETE the credential's key in Redis                      -- from now on NOTHING can authenticate with it: no new allocation, no ICE restart, no reconnect
//     3. cancel the live allocations through coturn's admin CLI    -- needed because an allocation that already exists keeps running (and even refreshing) on its cached key
//     4. verify none remain, then stamp terminated_at
// If step 2 or 3 cannot be done (Redis or the CLI is down) the row stays "pending termination" and reconcile() retries it on every boot and sweep.
//
// FAIL CLOSED: issue() refuses (RelayUnavailable) unless Redis AND the coturn CLI both answer, so while the credential authority or the TURN control service is unavailable no NEW
// screen-sharing session can be authorized. It also re-checks authorization AFTER the credential exists (the race with a concurrent revocation).
//
// What this CANNOT do (documented, demonstrated in the tests): the relay is content-agnostic. A modified client can send screen frames over its ordinary camera/microphone
// connection, which this design does not touch. That needs an SFU.
import { randomBytes, createHash } from 'node:crypto';
import { respCommand } from './resp-client.mjs';
import { turnCli, parseSessions } from './turn-cli.mjs';
import { createReaper } from './relay-reaper.mjs';

export class RelayUnavailable extends Error { constructor(m) { super(m); this.code = 'relay_unavailable'; } }
export class RelayRefused extends Error { constructor(m) { super(m); this.code = 'relay_refused'; } }

const md5hex = (s) => createHash('md5').update(s).digest('hex');
const b64url = (n) => randomBytes(n).toString('base64url');

/**
 * @param db        a pg Pool (the durable registry)
 * @param redis     { host, port, password? }  -- coturn's user database
 * @param cli       { host, port, password }   -- coturn's admin CLI
 * @param realm     coturn's realm (--realm)
 * @param ttlSeconds  life of a credential: short, so even a lost revocation expires on its own (it does NOT stop an allocation that already runs: see terminate)
 */
export function createRelayAuthority({ db, redis, cli, realm, ttlSeconds = 300, probeTimeoutMs = 2500, onEvent = null }) {
  if (!db || !redis || !cli || !realm) throw new Error('relay authority needs db, redis, cli and realm');
  const ttl = Math.min(3600, Math.max(30, Number(ttlSeconds) || 300));
  const redisCfg = { ...redis, timeoutMs: probeTimeoutMs }, cliCfg = { ...cli, timeoutMs: Math.max(probeTimeoutMs, 4000) };
  const keyOf = (username) => `turn/realm/${realm}/user/${username}/key`;
  // M1.3 monitoring: in-process counters (rendered by prometheus()) and audit events (onEvent(type, meetingId, participantId, detail); an audit failure never changes enforcement).
  const counters = { issued: 0, refused_unavailable: 0, refused_inactive: 0, revoked: 0, terminated: 0, termination_failed: 0, keys_resurrected: 0, orphans_reaped: 0, reconcile_runs: 0, reconcile_failures: 0 };
  const last = { reconcileAt: null, reconcileOk: null, reconcileMs: null };
  const reaper = createReaper({ redis, cli, realm, log: { warn: () => {} }, timeoutMs: probeTimeoutMs });
  const emit = (type, meetingId, participantId, detail) => { if (!onEvent) return; try { Promise.resolve(onEvent(type, meetingId, participantId, detail)).catch(() => {}); } catch { /* never into the caller */ } };

  /** Is the credential store AND the relay control reachable right now? (what issue() requires) */
  async function health() {
    const out = { ok: false, redis: false, cli: false, errors: [] };
    try { out.redis = (await respCommand(['PING'], redisCfg)) === 'PONG'; } catch (e) { out.errors.push('redis:' + e.message); }
    try { await turnCli([], { ...cliCfg, timeoutMs: probeTimeoutMs }); out.cli = true; } catch (e) { out.errors.push('cli:' + e.message); }
    out.ok = out.redis && out.cli; return out;
  }

  /**
   * A fresh credential for ONE role on ONE share. `stillActive()` must say whether the share may still be relayed; it is asked before AND after the credential exists,
   * so a revocation that races with issuing cannot leave a usable credential behind.
   * Returns { username, credential, expiresAt, ttlSeconds }; throws RelayUnavailable (fail closed) or RelayRefused.
   */
  async function issue({ meetingId, participantId, shareId, role }, { stillActive = async () => true } = {}) {
    if (!['presenter', 'viewer'].includes(role)) throw new RelayRefused('role must be presenter or viewer');
    const h = await health(); if (!h.ok) { counters.refused_unavailable++; throw new RelayUnavailable('the relay cannot be controlled right now (' + h.errors.join(', ') + '): no new screen-sharing session'); }
    if (!(await stillActive())) { counters.refused_inactive++; throw new RelayRefused('this share is no longer authorized'); }
    const username = 'q' + b64url(12), credential = b64url(18), expiresAt = new Date(Date.now() + ttl * 1000);
    try {
      await db.query('INSERT INTO relay_credentials(username, meeting_id, participant_id, share_id, role, expires_at) VALUES($1,$2,$3,$4,$5,$6)', [username, meetingId, participantId, shareId, role, expiresAt]);
      await respCommand(['SET', keyOf(username), md5hex(`${username}:${realm}:${credential}`), 'EX', String(ttl)], redisCfg);          // coturn reads the key from here on every authentication
    } catch (e) { await db.query("UPDATE relay_credentials SET revoked_at=now(), revoke_reason='issue_failed' WHERE username=$1", [username]).catch(() => {}); throw new RelayUnavailable('could not store the credential: ' + e.message); }
    let ok = false; try { ok = await stillActive(); } catch { ok = false; }
    if (!ok) { await revokeUsernames([username], 'revoked_during_issue'); throw new RelayRefused('this share was revoked while its credential was being issued'); }
    counters.issued++; emit('relay.credential_issued', meetingId, participantId, { shareId, role, username, ttlSeconds: ttl });
    return { username, credential, expiresAt: expiresAt.toISOString(), ttlSeconds: ttl };
  }

  /** The termination sequence for these usernames (steps 2-4). Idempotent; never throws: the outcome lists what could not be done. */
  async function terminate(usernames) {
    const out = { usernames: usernames.length, keysDeleted: 0, sessionsCancelled: 0, errors: [] };
    if (!usernames.length) return out;
    try { out.keysDeleted = Number(await respCommand(['DEL', ...usernames.map(keyOf)], redisCfg)); } catch (e) { out.errors.push('redis:' + e.message); }      // from here on nothing can authenticate with them
    try {
      const ps = usernames.map((u) => 'ps ' + u);                  // list (1 CLI connection) -> cancel AND list again in ONE connection (the second listing is the verification); repeat if anything is left
      let left = (await turnCli(ps, cliCfg)).flatMap(parseSessions).filter((s) => usernames.includes(s.user));
      for (let round = 0; round < 3 && left.length; round++) {
        const ids = [...new Set(left.map((s) => s.id))]; out.sessionsCancelled += left.length;
        const outs = await turnCli([...ids.map((id) => 'cs ' + id), ...ps], cliCfg);
        left = outs.slice(ids.length).flatMap(parseSessions).filter((s) => usernames.includes(s.user));
      }
      if (left && left.length) out.errors.push('sessions_remaining:' + left.length);
    } catch (e) { out.errors.push('cli:' + e.message); }
    return out;
  }

  /** Step 1 + 2-4 for a set of usernames. The durable record comes FIRST. */
  async function revokeUsernames(usernames, reason) {
    if (!usernames.length) return { revoked: 0, terminated: 0, errors: [] };
    const { rows: rv } = await db.query('UPDATE relay_credentials SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = COALESCE(revoke_reason, $2) WHERE username = ANY($1) RETURNING username, meeting_id, participant_id, share_id, role, terminated_at', [usernames, reason]);
    const fresh = rv.filter((r) => !r.terminated_at), t0 = Date.now(), t = await terminate(usernames); counters.revoked += fresh.length;
    if (!t.errors.length) {
      const { rows: done } = await db.query('UPDATE relay_credentials SET terminated_at = now(), termination_error = NULL WHERE username = ANY($1) AND terminated_at IS NULL RETURNING username', [usernames]); counters.terminated += done.length;
      for (const r of fresh) emit('relay.credential_terminated', r.meeting_id, r.participant_id, { shareId: r.share_id, role: r.role, username: r.username, reason, sessionsCancelled: t.sessionsCancelled, ms: Date.now() - t0 });
    } else {
      counters.termination_failed++; for (const r of fresh) emit('relay.termination_failed', r.meeting_id, r.participant_id, { shareId: r.share_id, username: r.username, reason, errors: t.errors });
      await db.query('UPDATE relay_credentials SET termination_error = $2 WHERE username = ANY($1) AND terminated_at IS NULL', [usernames, t.errors.join('; ').slice(0, 300)]).catch(() => {});
    }
    return { revoked: usernames.length, terminated: t.errors.length ? 0 : usernames.length, keysDeleted: t.keysDeleted, sessionsCancelled: t.sessionsCancelled, errors: t.errors };
  }

  const liveUsernames = async (where, args) => (await db.query(`SELECT username FROM relay_credentials WHERE ${where} AND terminated_at IS NULL`, args)).rows.map((r) => r.username);
  /** Host revoke / lease expiry / handoff: every credential of this share. */
  const revokeShare = async (shareId, reason) => revokeUsernames(await liveUsernames('share_id = $1', [shareId]), reason);
  /** Shield denied this person: every credential they hold, in any share of the meeting. */
  const revokeParticipant = async (meetingId, participantId, reason) => revokeUsernames(await liveUsernames('meeting_id = $1 AND participant_id = $2', [meetingId, participantId]), reason);
  /** The meeting ended. */
  const revokeMeeting = async (meetingId, reason) => revokeUsernames(await liveUsernames('meeting_id = $1', [meetingId]), reason);

  /**
   * Run on boot and on every sweep. (a) finishes every revocation that was recorded but not completed (a crash, a restart, an unreachable relay);
   * (b) revokes and terminates credentials that EXPIRED while their allocation could still be running (an allocation outlives its credential's TTL).
   */
  async function reconcile() {
    const t0 = Date.now(); counters.reconcile_runs++;
    try { const r = await reconcileInner(); Object.assign(last, { reconcileAt: new Date(), reconcileOk: !r.errors.length, reconcileMs: Date.now() - t0 }); if (r.errors.length) counters.reconcile_failures++; return r; }
    catch (e) { counters.reconcile_failures++; Object.assign(last, { reconcileAt: new Date(), reconcileOk: false, reconcileMs: Date.now() - t0 }); throw e; }
  }
  async function reconcileInner() {
    const expired = (await db.query("SELECT username FROM relay_credentials WHERE revoked_at IS NULL AND expires_at < now()")).rows.map((r) => r.username);
    if (expired.length) await db.query("UPDATE relay_credentials SET revoked_at = now(), revoke_reason = 'expired' WHERE username = ANY($1) AND revoked_at IS NULL", [expired]);
    const pending = (await db.query('SELECT username FROM relay_credentials WHERE revoked_at IS NOT NULL AND terminated_at IS NULL')).rows.map((r) => r.username);
    const r = await revokeUsernames(pending, 'reconcile');          // keeps the original reason (COALESCE)
    // RESURRECTION GUARD: a revoked credential whose Redis key could come back (a restored backup, a replica promoted with old data, a mistaken write) is deleted AGAIN for as long as the
    // credential would have been valid. DEL of an absent key is free; a key that EXISTED is a finding (counted, audited) and the allocations of that user are cancelled too.
    const guard = (await db.query("SELECT username, meeting_id, participant_id FROM relay_credentials WHERE revoked_at IS NOT NULL AND terminated_at IS NOT NULL AND expires_at > now() - interval '1 minute'")).rows;
    let resurrected = 0; const errors = [...r.errors];
    try {
      for (let i = 0; i < guard.length; i += 100) {                      // one DEL per 100 credentials; a non-zero count means a key had come back
        const chunk = guard.slice(i, i + 100), n = Number(await respCommand(['DEL', ...chunk.map((g) => keyOf(g.username))], redisCfg));
        if (n > 0) { resurrected += n; await terminate(chunk.map((g) => g.username)); for (const g of chunk) emit('relay.key_resurrected_check', g.meeting_id, g.participant_id, { username: g.username, keysFoundInChunk: n }); }
      }
    } catch (e) { errors.push('redis:' + e.message); }
    counters.keys_resurrected += resurrected;
    // ORPHAN SWEEP (the same logic as the stand-alone relay-reaper process, which keeps working when Meet is down): allocations whose credential key no longer exists are cancelled
    const rp = await reaper.sweep(); counters.orphans_reaped += rp.cancelled; errors.push(...rp.errors.map((e) => 'reaper:' + e));
    return { expiredNow: expired.length, pending: pending.length, terminated: r.terminated, resurrected, orphansReaped: rp.cancelled, errors };
  }

  /** Operational snapshot (GET /api/ops/relay): what is live, what is revoked but NOT yet confirmed terminated (an unenforced revocation: the alert that matters) and for how long. */
  async function stats() {
    const q = (await db.query(`SELECT count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now())::int AS live,
        count(*) FILTER (WHERE revoked_at IS NOT NULL AND terminated_at IS NULL)::int AS pending,
        COALESCE(EXTRACT(EPOCH FROM now() - min(revoked_at) FILTER (WHERE revoked_at IS NOT NULL AND terminated_at IS NULL)), 0)::float AS oldest_pending_seconds,
        count(*) FILTER (WHERE revoked_at IS NULL AND expires_at < now())::int AS expired_unreaped FROM relay_credentials`)).rows[0];
    const h = await health();
    return { ...q, healthy: h.ok, redisUp: h.redis, cliUp: h.cli, counters: { ...counters }, lastReconcile: { ...last } };
  }
  async function prometheus() {
    const s = await stats(), L = []; const g = (n, help, v, type = 'gauge') => L.push(`# HELP qorlla_relay_${n} ${help}`, `# TYPE qorlla_relay_${n} ${type}`, `qorlla_relay_${n} ${v}`);
    g('credentials_live', 'Relay credentials valid now', s.live); g('revocations_pending', 'Revoked credentials whose relay allocation is NOT yet confirmed terminated (unenforced revocations)', s.pending);
    g('oldest_pending_revocation_seconds', 'Age of the oldest unenforced revocation', s.oldest_pending_seconds.toFixed(1)); g('credentials_expired_unreaped', 'Expired credentials not yet reaped', s.expired_unreaped);
    g('redis_up', 'Credential store reachable', s.redisUp ? 1 : 0); g('cli_up', 'Relay control (coturn CLI) reachable', s.cliUp ? 1 : 0);
    g('last_reconcile_ok', 'Last reconcile run succeeded', s.lastReconcile.reconcileOk ? 1 : 0);
    g('last_reconcile_age_seconds', 'Seconds since the last reconcile run (-1 = never)', s.lastReconcile.reconcileAt ? ((Date.now() - s.lastReconcile.reconcileAt) / 1000).toFixed(1) : -1);
    for (const [k, v] of Object.entries(s.counters)) g(k + '_total', 'Counter (this process)', v, 'counter');
    return L.join('\n') + '\n';
  }
  /** INVARIANTS between the registry and the share state. The sweeper alerts on any violation; reconcile repairs the first kind. */
  async function audit() {
    const v = [];
    for (const r of (await db.query("SELECT rc.username, rc.share_id FROM relay_credentials rc LEFT JOIN meeting_shares s ON s.id = rc.share_id WHERE rc.revoked_at IS NULL AND rc.expires_at > now() AND (s.id IS NULL OR s.state <> 'active')")).rows) v.push({ rule: 'live_credential_of_inactive_share', username: r.username, shareId: r.share_id });
    for (const r of (await db.query("SELECT rc.username, rc.participant_id FROM relay_credentials rc LEFT JOIN participants p ON p.id = rc.participant_id WHERE rc.revoked_at IS NULL AND rc.expires_at > now() AND (p.id IS NULL OR p.admission <> 'admitted')")).rows) v.push({ rule: 'live_credential_of_unadmitted_participant', username: r.username, participantId: r.participant_id });
    for (const r of (await db.query("SELECT rc.username FROM relay_credentials rc JOIN meeting_shares s ON s.id = rc.share_id WHERE rc.revoked_at IS NULL AND rc.role = 'presenter' AND s.state = 'active' AND rc.participant_id <> s.owner_id")).rows) v.push({ rule: 'presenter_credential_of_non_owner', username: r.username });
    return v;
  }

  /**
   * The share is ALIVE (its presenter renewed the lease): its credentials live on. Without this a share would be terminated when its FIRST credential expires: an allocation outlives its
   * credential (measured), and reconcile() terminates the allocations of expired credentials. A failure to extend the Redis TTL is harmless to media already flowing; the next heartbeat retries.
   */
  async function renewShare(shareId) {
    const { rows } = await db.query("UPDATE relay_credentials SET expires_at = now() + ($2 || ' seconds')::interval WHERE share_id = $1 AND revoked_at IS NULL RETURNING username", [shareId, String(ttl)]);
    for (const { username } of rows) { try { await respCommand(['EXPIRE', keyOf(username), String(ttl)], redisCfg); } catch { /* retried at the next heartbeat */ } }
    return rows.length;
  }

  /** The live relay allocations of a credential, as coturn reports them. */
  async function sessionsOf(username) { return (await turnCli(['ps ' + username], cliCfg)).flatMap(parseSessions).filter((s) => s.user === username); }

  return { ttlSeconds: ttl, realm, stats, prometheus, audit, keyOf, health, issue, renewShare, terminate, revokeUsernames, revokeShare, revokeParticipant, revokeMeeting, reconcile, sessionsOf };
}
