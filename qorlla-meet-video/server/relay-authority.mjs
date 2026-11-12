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
export function createRelayAuthority({ db, redis, cli, realm, ttlSeconds = 300, probeTimeoutMs = 2500 }) {
  if (!db || !redis || !cli || !realm) throw new Error('relay authority needs db, redis, cli and realm');
  const ttl = Math.min(3600, Math.max(30, Number(ttlSeconds) || 300));
  const redisCfg = { ...redis, timeoutMs: probeTimeoutMs }, cliCfg = { ...cli, timeoutMs: Math.max(probeTimeoutMs, 4000) };
  const keyOf = (username) => `turn/realm/${realm}/user/${username}/key`;

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
    const h = await health(); if (!h.ok) throw new RelayUnavailable('the relay cannot be controlled right now (' + h.errors.join(', ') + '): no new screen-sharing session');
    if (!(await stillActive())) throw new RelayRefused('this share is no longer authorized');
    const username = 'q' + b64url(12), credential = b64url(18), expiresAt = new Date(Date.now() + ttl * 1000);
    try {
      await db.query('INSERT INTO relay_credentials(username, meeting_id, participant_id, share_id, role, expires_at) VALUES($1,$2,$3,$4,$5,$6)', [username, meetingId, participantId, shareId, role, expiresAt]);
      await respCommand(['SET', keyOf(username), md5hex(`${username}:${realm}:${credential}`), 'EX', String(ttl)], redisCfg);          // coturn reads the key from here on every authentication
    } catch (e) { await db.query("UPDATE relay_credentials SET revoked_at=now(), revoke_reason='issue_failed' WHERE username=$1", [username]).catch(() => {}); throw new RelayUnavailable('could not store the credential: ' + e.message); }
    let ok = false; try { ok = await stillActive(); } catch { ok = false; }
    if (!ok) { await revokeUsernames([username], 'revoked_during_issue'); throw new RelayRefused('this share was revoked while its credential was being issued'); }
    return { username, credential, expiresAt: expiresAt.toISOString(), ttlSeconds: ttl };
  }

  /** The termination sequence for these usernames (steps 2-4). Idempotent; never throws: the outcome lists what could not be done. */
  async function terminate(usernames) {
    const out = { usernames: usernames.length, keysDeleted: 0, sessionsCancelled: 0, errors: [] };
    if (!usernames.length) return out;
    try { out.keysDeleted = Number(await respCommand(['DEL', ...usernames.map(keyOf)], redisCfg)); } catch (e) { out.errors.push('redis:' + e.message); }      // from here on nothing can authenticate with them
    try {
      let left = null;                                           // list -> cancel -> list again; the LAST listing is the verification that none remain
      for (let round = 0; round < 3; round++) {
        left = (await turnCli(usernames.map((u) => 'ps ' + u), cliCfg)).flatMap(parseSessions).filter((s) => usernames.includes(s.user));
        if (!left.length) break;
        await turnCli([...new Set(left.map((s) => s.id))].map((id) => 'cs ' + id), cliCfg); out.sessionsCancelled += left.length;
        if (round === 2) left = (await turnCli(usernames.map((u) => 'ps ' + u), cliCfg)).flatMap(parseSessions).filter((s) => usernames.includes(s.user));
      }
      if (left && left.length) out.errors.push('sessions_remaining:' + left.length);
    } catch (e) { out.errors.push('cli:' + e.message); }
    return out;
  }

  /** Step 1 + 2-4 for a set of usernames. The durable record comes FIRST. */
  async function revokeUsernames(usernames, reason) {
    if (!usernames.length) return { revoked: 0, terminated: 0, errors: [] };
    await db.query('UPDATE relay_credentials SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = COALESCE(revoke_reason, $2) WHERE username = ANY($1)', [usernames, reason]);
    const t = await terminate(usernames);
    if (!t.errors.length) await db.query('UPDATE relay_credentials SET terminated_at = now(), termination_error = NULL WHERE username = ANY($1) AND terminated_at IS NULL', [usernames]);
    else await db.query('UPDATE relay_credentials SET termination_error = $2 WHERE username = ANY($1) AND terminated_at IS NULL', [usernames, t.errors.join('; ').slice(0, 300)]).catch(() => {});
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
    const expired = (await db.query("SELECT username FROM relay_credentials WHERE revoked_at IS NULL AND expires_at < now()")).rows.map((r) => r.username);
    if (expired.length) await db.query("UPDATE relay_credentials SET revoked_at = now(), revoke_reason = 'expired' WHERE username = ANY($1) AND revoked_at IS NULL", [expired]);
    const pending = (await db.query('SELECT username FROM relay_credentials WHERE revoked_at IS NOT NULL AND terminated_at IS NULL')).rows.map((r) => r.username);
    const r = await revokeUsernames(pending, 'reconcile');          // keeps the original reason (COALESCE)
    return { expiredNow: expired.length, pending: pending.length, terminated: r.terminated, errors: r.errors };
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

  return { ttlSeconds: ttl, realm, keyOf, health, issue, renewShare, terminate, revokeUsernames, revokeShare, revokeParticipant, revokeMeeting, reconcile, sessionsOf };
}
