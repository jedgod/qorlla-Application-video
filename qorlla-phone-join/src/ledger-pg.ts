import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { CallLedger, CallState } from './admission.js';

/** Allowed moves. Nothing goes backwards, failed/ended are final, and an orphan (a leg that could not be terminated) is resolved only by an operator or the reaper. */
export const TRANSITIONS: Record<CallState, readonly CallState[]> = {
  claimed: ['authorizing', 'failed', 'terminating'],
  authorizing: ['awaiting_host', 'attaching', 'failed', 'terminating'],
  awaiting_host: ['attaching', 'failed', 'terminating'],
  attaching: ['connected', 'failed', 'terminating', 'orphaned'],
  connected: ['ended', 'terminating'],
  terminating: ['failed', 'orphaned', 'ended'],
  failed: [],
  ended: [],
  orphaned: ['failed', 'ended']
};
const OPEN: CallState[] = ['claimed', 'authorizing', 'awaiting_host', 'attaching', 'terminating'];
const FINAL: CallState[] = ['failed', 'ended', 'orphaned'];

/** How long a lease lasts without renewal, and how long a reaper waits AFTER challenging a lapsed lease before it may take the call over. */
export type LeasePolicy = { leaseMs: number; graceMs: number };
export const DEFAULT_LEASE: LeasePolicy = { leaseMs: 15_000, graceMs: 15_000 };
/**
 * One deadline per lifecycle state, measured from the last state change (each is a different rule, not one generic timeout):
 *  claimed / authorizing: the gateway is still deciding (seconds); awaiting_host: a person has to answer; attaching: a media leg is being built; terminating: teardown is under way;
 *  released: how long a `failed` row may linger before it is purged (the id is normally freed at once). `connected` has NO deadline here: a connected call lives as long as its media does,
 *  and Meet's media verification (not this reaper) ends it.
 */
export type StateDeadlines = { claimed: number; authorizing: number; awaiting_host: number; attaching: number; terminating: number; released: number };
export const DEFAULT_DEADLINES: StateDeadlines = { claimed: 30_000, authorizing: 30_000, awaiting_host: 300_000, attaching: 60_000, terminating: 120_000, released: 600_000 };
const REAPABLE = ['claimed', 'authorizing', 'awaiting_host', 'attaching', 'terminating'] as const;
export type LossReason = 'fenced' | 'lost' | 'unconfirmed';
type Held = { generation: number; state: CallState; confirmedAt: number };

/**
 * The shared call ledger on PostgreSQL. Safe with any number of gateway replicas: ownership is the PRIMARY KEY (one INSERT wins), and every state change locks the row, checks the move against TRANSITIONS,
 * and writes the history in the same transaction. Nothing but the generation this instance believes it holds is kept in process memory.
 *
 * OWNERSHIP (migration 002): every open call has a lease (owner, generation, expiry). The owner renews it (renew / renewAll, driven by startLeaseKeeper). Every write by the owner is FENCED: it must present the
 * generation it holds, and the row accepts it only while owner and generation still match, so an old gateway that resumes after a takeover changes nothing and learns it lost the call (onLost).
 * A reaper never assumes: a lapsed lease is first CHALLENGED; the owner's next renewal clears the challenge; only a lease that stayed lapsed for the whole grace period is taken over (generation + 1).
 */
export class PostgresCallLedger implements CallLedger {
  private readonly held = new Map<string, Held>();
  private readonly lost: ((callId: string, reason: LossReason) => void)[] = [];
  private readonly lease: LeasePolicy; private readonly clock: () => number;
  constructor(private readonly pool: Pool, private readonly instance: string = 'gateway-' + randomBytes(4).toString('hex'), o: { lease?: Partial<LeasePolicy>; clock?: () => number } = {}) {
    this.lease = { ...DEFAULT_LEASE, ...o.lease }; this.clock = o.clock ?? (() => performance.now());
  }

  /** Called when this instance learns it no longer owns a call (a newer generation took it over, or its lease could not be confirmed). The affected leg must be stopped. */
  onLost(cb: (callId: string, reason: LossReason) => void): void { this.lost.push(cb); }
  private forgetHeld(callId: string, reason?: LossReason): void { if (this.held.delete(callId) && reason) for (const cb of this.lost) { try { cb(callId, reason); } catch { /* a listener must not break the ledger */ } } }
  /** The calls this instance believes it owns. */
  heldCalls(): string[] { return [...this.held.keys()]; }
  generationOf(callId: string): number | undefined { return this.held.get(callId)?.generation; }
  /** Drops local ownership without touching the row (the leg was stopped locally; a reaper will settle the row). */
  forget(callId: string): void { this.held.delete(callId); }
  /** Held calls whose lease this instance has not been able to renew for a whole lease period (database outage): a reaper may legitimately take them after the grace period, so the leg must stop. Connected calls are excluded: their liveness is Meet's media verification. */
  unconfirmed(): string[] { const now = this.clock(); return [...this.held].filter(([, h]) => h.state !== 'connected' && now - h.confirmedAt >= this.lease.leaseMs).map(([id]) => id); }

  /** True for exactly one caller per call id, however many replicas race for it. The winner owns generation 1. */
  async claim(callId: string): Promise<boolean> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query(`INSERT INTO phone_join_calls(call_id, state, claimed_by, lease_owner, lease_generation, lease_expires_at) VALUES($1,'claimed',$2,$2,1, now() + make_interval(secs => $3::float8))
        ON CONFLICT (call_id) DO NOTHING RETURNING call_id`, [callId, this.instance, this.lease.leaseMs / 1000]);
      if (r.rowCount) await c.query("INSERT INTO phone_join_call_events(call_id, from_state, to_state, actor) VALUES($1,NULL,'claimed',$2)", [callId, this.instance]);
      await c.query('COMMIT');
      if (r.rowCount === 1) this.held.set(callId, { generation: 1, state: 'claimed', confirmedAt: this.clock() });
      return r.rowCount === 1;
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }

  /**
   * false when the call is unknown, the move is not allowed from its current state, or this instance does not own the call any more (the row is not changed; onLost fires). A replica that never owned a
   * call may only END a CONNECTED one (`terminating`, the Shield / operator path): that move takes the call over under a new generation.
   */
  async transition(callId: string, to: CallState, detail: { meetingSessionId?: string; reason?: string } = {}): Promise<boolean> {
    const c = await this.pool.connect(); let outcome: { generation: number } | 'refused' | 'fenced' = 'refused';
    try {
      await c.query('BEGIN');
      const cur = (await c.query('SELECT state, lease_owner, lease_generation FROM phone_join_calls WHERE call_id=$1 FOR UPDATE', [callId])).rows[0] as { state: CallState; lease_owner: string | null; lease_generation: string } | undefined;
      const mine = this.held.get(callId), gen = cur ? Number(cur.lease_generation) : 0;
      if (!cur || !TRANSITIONS[cur.state]?.includes(to)) { await c.query('ROLLBACK'); if (cur && mine && (cur.lease_owner !== this.instance || gen !== mine.generation)) outcome = 'fenced'; }
      else if (mine && (cur.lease_owner !== this.instance || gen !== mine.generation)) { await c.query('ROLLBACK'); outcome = 'fenced'; }
      else if (!mine && !(to === 'terminating' && cur.state === 'connected')) { await c.query('ROLLBACK'); }
      else {
        const bump = mine ? 0 : 1, reason = detail.reason ? String(detail.reason).slice(0, 200) : null;
        await c.query(`UPDATE phone_join_calls SET state=$2, updated_at=now(), meeting_session_id=COALESCE($3, meeting_session_id), reason=COALESCE($4, reason),
          ended_at=CASE WHEN $2 IN ('failed','ended') THEN now() ELSE ended_at END, lease_owner=$5, lease_generation=lease_generation+$6,
          lease_expires_at=CASE WHEN $2 IN ('failed','ended','orphaned') THEN lease_expires_at ELSE now() + make_interval(secs => $7::float8) END, lease_challenged_at=NULL WHERE call_id=$1`,
          [callId, to, detail.meetingSessionId ?? null, reason, this.instance, bump, this.lease.leaseMs / 1000]);
        await c.query('INSERT INTO phone_join_call_events(call_id, from_state, to_state, reason, actor) VALUES($1,$2,$3,$4,$5)', [callId, cur.state, to, reason, this.instance]);
        await c.query('COMMIT'); outcome = { generation: gen + bump };
      }
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
    if (outcome === 'refused') return false;
    if (outcome === 'fenced') { this.forgetHeld(callId, 'fenced'); return false; }
    if (FINAL.includes(to)) this.held.delete(callId); else this.held.set(callId, { generation: outcome.generation, state: to, confirmedAt: this.clock() });
    return true;
  }

  /** Extends this instance's lease on one call. true = renewed (and any reaper challenge is cleared). false = the call is no longer owned (a newer generation took it, or it is final): onLost fires. Throws on a database error WITHOUT changing ownership. */
  async renew(callId: string): Promise<boolean> {
    const mine = this.held.get(callId); if (!mine) return false;
    const r = await this.pool.query(`UPDATE phone_join_calls SET lease_expires_at = now() + make_interval(secs => $4::float8), lease_challenged_at = NULL
      WHERE call_id=$1 AND lease_owner=$2 AND lease_generation=$3 AND state NOT IN ('failed','ended','orphaned') RETURNING state`, [callId, this.instance, mine.generation, this.lease.leaseMs / 1000]);
    const cur = this.held.get(callId); if (!cur || cur.generation !== mine.generation) return false;      // changed while the query was in flight
    if (r.rowCount === 1) { cur.confirmedAt = this.clock(); cur.state = r.rows[0].state; return true; }
    this.forgetHeld(callId, 'lost'); return false;
  }
  /** Renews every held call. `unavailable` are the ones the database could not answer for (ownership unchanged, nothing assumed). */
  async renewAll(): Promise<{ renewed: string[]; lost: string[]; unavailable: string[] }> {
    const out = { renewed: [] as string[], lost: [] as string[], unavailable: [] as string[] };
    for (const id of this.heldCalls()) { try { (await this.renew(id) ? out.renewed : out.lost).push(id); } catch { out.unavailable.push(id); } }
    return out;
  }

  /** Frees a call id for a retry, but ONLY when the attempt is finished with (failed). A claimed, connected, terminating or orphaned call keeps its id: a leg may still exist. */
  async release(callId: string): Promise<void> {
    await this.pool.query("DELETE FROM phone_join_calls WHERE call_id=$1 AND state='failed'", [callId]); this.held.delete(callId);
  }

  /** Connected calls, for the Shield re-check and for shutdown: any replica can list and end any replica's calls. */
  async listConnected(limit = 500): Promise<{ callId: string; meetingSessionId: string }[]> {
    const r = await this.pool.query("SELECT call_id, meeting_session_id FROM phone_join_calls WHERE state='connected' AND meeting_session_id IS NOT NULL ORDER BY updated_at LIMIT $1", [limit]);
    return r.rows.map((x) => ({ callId: x.call_id, meetingSessionId: x.meeting_session_id }));
  }
  /** The meeting session recorded for a call (needed to end it in the meeting service when its gateway replica died). */
  async sessionOf(callId: string): Promise<string | null> { const r = await this.pool.query('SELECT meeting_session_id FROM phone_join_calls WHERE call_id=$1', [callId]); return r.rows[0]?.meeting_session_id ?? null; }
  async stateOf(callId: string): Promise<CallState | null> {
    const r = await this.pool.query('SELECT state FROM phone_join_calls WHERE call_id=$1', [callId]); return r.rows[0]?.state ?? null;
  }

  /**
   * Crash recovery with ownership. For each reapable state whose OWN deadline has passed AND whose lease has lapsed - and, since A5.5, for a `connected` call whose OWNER IS GONE (lease lapsed; a connected call has no
   * state deadline, the lease is its only liveness evidence):
   *  - first sight: the lease is CHALLENGED (the row is otherwise untouched, nothing is returned) - a slow but healthy owner renews and the challenge disappears;
   *  - still lapsed a full grace period after the challenge: the call is TAKEN OVER under generation + 1 (state `terminating`, owner = this instance, by exactly one reaper) and returned,
   *    so the caller can disconnect its media and then settle it with finishReap().
   * Every step is a conditional write on the generation read under the row lock, so a renewal that wins the race (before or after) can never be overridden.
   */
  async reapStale(o: { deadlines?: Partial<StateDeadlines>; limit?: number } = {}): Promise<string[]> {
    const d = { ...DEFAULT_DEADLINES, ...o.deadlines }, secs = REAPABLE.map((s) => d[s] / 1000), grace = this.lease.graceMs / 1000;
    const c = await this.pool.connect(); const taken: { callId: string; generation: number }[] = [];
    try {
      await c.query('BEGIN');
      const due = `((state = ANY($1::text[]) AND lease_expires_at < now() AND updated_at < now() - make_interval(secs => CASE state WHEN 'claimed' THEN $2::float8 WHEN 'authorizing' THEN $3::float8
        WHEN 'awaiting_host' THEN $4::float8 WHEN 'attaching' THEN $5::float8 ELSE $6::float8 END)) OR (state = 'connected' AND lease_expires_at < now()))`;
      const params = [REAPABLE, ...secs];
      await c.query(`UPDATE phone_join_calls SET lease_challenged_at = now() WHERE call_id IN (SELECT call_id FROM phone_join_calls WHERE ${due} AND lease_challenged_at IS NULL ORDER BY updated_at LIMIT $7 FOR UPDATE SKIP LOCKED)`, [...params, o.limit ?? 100]);
      const rows = (await c.query(`SELECT call_id, state, reason, lease_generation FROM phone_join_calls WHERE ${due} AND lease_challenged_at < now() - make_interval(secs => $7::float8)
        ORDER BY updated_at LIMIT $8 FOR UPDATE SKIP LOCKED`, [...params, grace, o.limit ?? 100])).rows as { call_id: string; state: CallState; reason: string | null; lease_generation: string }[];
      for (const r of rows) {
        // WHY it was taken: a connected call keeps that fact through every later takeover of its cleanup (`stale_connected`), because its release needs Meet's word, not just a stale lease
        const why = r.state === 'connected' || (r.state === 'terminating' && r.reason === 'stale_connected') ? 'stale_connected' : r.state === 'terminating' ? 'stale_terminating' : 'stale_claim';
        const u = await c.query(`UPDATE phone_join_calls SET state='terminating', reason=$4, updated_at=now(), lease_owner=$5, lease_generation=lease_generation+1,
          lease_expires_at = now() + make_interval(secs => $6::float8), lease_challenged_at = NULL WHERE call_id=$1 AND lease_generation=$2 AND state=$3`,
          [r.call_id, r.lease_generation, r.state, why, this.instance, this.lease.leaseMs / 1000]);
        if (u.rowCount !== 1) continue;
        await c.query("INSERT INTO phone_join_call_events(call_id, from_state, to_state, reason, actor) VALUES($1,$2,'terminating',$3,$4)", [r.call_id, r.state, why, this.instance]);
        taken.push({ callId: r.call_id, generation: Number(r.lease_generation) + 1 });
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
    for (const t of taken) this.held.set(t.callId, { generation: t.generation, state: 'terminating', confirmedAt: this.clock() });      // only after the commit: a failed reap assumes nothing
    return taken.map((t) => t.callId);
  }
  /** Why the call is in its current state (`stale_connected`: its owner vanished while it was connected and a reaper holds it for cleanup). */
  async reasonOf(callId: string): Promise<string | null> { const r = await this.pool.query('SELECT reason FROM phone_join_calls WHERE call_id=$1', [callId]); return r.rows[0]?.reason ?? null; }
  /** Cleanups THIS instance already holds (taken over earlier, Meet could not confirm yet): they are retried, never forgotten. */
  async pendingCleanups(limit = 100): Promise<string[]> {
    const mine = [...this.held].filter(([, h]) => h.state === 'terminating').map(([id]) => id); if (!mine.length) return [];
    const r = await this.pool.query("SELECT call_id FROM phone_join_calls WHERE state='terminating' AND reason='stale_connected' AND lease_owner=$1 AND call_id = ANY($2::text[]) ORDER BY updated_at LIMIT $3", [this.instance, mine, limit]); return r.rows.map((x: { call_id: string }) => x.call_id);
  }
  /**
   * Meet could not confirm, within the bound, that a connected call whose owner vanished is over. The call becomes `orphaned` for an OPERATOR: this records only that the cleanup could not be confirmed. It does NOT
   * release the call id (an orphan keeps its id: claim() cannot take it, release() and purgeReleased() only ever delete `failed` rows), does not touch any credential, and does not claim that media was terminated.
   * Fenced by the takeover generation; repeating it changes nothing.
   */
  async orphanCleanup(callId: string): Promise<boolean> { return this.transition(callId, 'orphaned', { reason: 'cleanup_unconfirmed' }); }
  /** What an operator has to reconcile: every orphaned call, oldest first, with the reason it was left (read-only). */
  async listOrphans(limit = 100): Promise<{ callId: string; reason: string | null; since: Date; meetingSessionId: string | null }[]> {
    const r = await this.pool.query("SELECT call_id, reason, ended_at, updated_at, meeting_session_id FROM phone_join_calls WHERE state='orphaned' ORDER BY updated_at LIMIT $1", [limit]);
    return r.rows.map((x: { call_id: string; reason: string | null; ended_at: Date | null; updated_at: Date; meeting_session_id: string | null }) => ({ callId: x.call_id, reason: x.reason, since: x.ended_at ?? x.updated_at, meetingSessionId: x.meeting_session_id }));
  }
  /**
   * The ONLY way out of `orphaned`: an operator who has reconciled the call by hand (confirmed in Meet and on the carrier side that it is over) records the outcome. Audited with the operator's name; `failed` also frees
   * the call id, `ended` keeps the row. Not fenced by a generation (an orphan has no live owner) but conditional on the call still being orphaned, so repeating or racing it changes nothing.
   */
  async resolveOrphan(callId: string, outcome: 'ended' | 'failed', operator: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(operator)) throw new Error('operator must be a short identifier'); const c = await this.pool.connect(); let done = false;
    try {
      await c.query('BEGIN'); const r = await c.query("UPDATE phone_join_calls SET state=$2, reason='operator_reconciled', ended_at=now(), updated_at=now() WHERE call_id=$1 AND state='orphaned' RETURNING call_id", [callId, outcome]);
      if (r.rowCount === 1) { await c.query("INSERT INTO phone_join_call_events(call_id, from_state, to_state, reason, actor) VALUES($1,'orphaned',$2,'operator_reconciled',$3)", [callId, outcome, 'operator:' + operator]); done = true; }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
    if (done && outcome === 'failed') await this.release(callId); return done;
  }
  /** The call is over in Meet (confirmed by Meet itself): a connected call whose cleanup this instance holds becomes `ended`, fenced by the generation of the takeover. Repeating it changes nothing. */
  async finishCleanup(callId: string): Promise<boolean> { return this.transition(callId, 'ended', { reason: 'reconciled_stale_connected' }); }
  /** After the media of a reaped call was disconnected (terminated) or could not be (orphaned: an operator must act). Fenced by the generation the reap took; false (and nothing released) when that ownership is gone. Repeating it changes nothing. */
  async finishReap(callId: string, terminated: boolean): Promise<boolean> {
    const done = await this.transition(callId, terminated ? 'failed' : 'orphaned', { reason: 'reaped' });
    if (done && terminated) await this.release(callId);
    return done;
  }
  /** The `released` rule: a `failed` row whose id should have been freed (the process died between the two steps) is purged after `retentionMs`, so the call id is not blocked for ever. Idempotent. */
  async purgeReleased(retentionMs: number = DEFAULT_DEADLINES.released): Promise<number> {
    const r = await this.pool.query("DELETE FROM phone_join_calls WHERE state='failed' AND ended_at < now() - make_interval(secs => $1::float8)", [retentionMs / 1000]); return r.rowCount ?? 0;
  }
}

/** Replay record for one-use workload tokens (see gateway-auth.ts). seen() is true the first time a jti is offered, false for every later offer until it expires. */
export class PostgresReplayStore {
  constructor(private readonly pool: Pool) {}
  async firstUse(jti: string, issuer: string, expiresAtMs: number): Promise<boolean> {
    await this.pool.query('DELETE FROM phone_join_replay WHERE expires_at < now() - interval \'1 minute\'');
    const r = await this.pool.query('INSERT INTO phone_join_replay(jti, issuer, expires_at) VALUES($1,$2,to_timestamp($3)) ON CONFLICT (jti) DO NOTHING RETURNING jti', [jti, issuer, expiresAtMs / 1000]);
    return r.rowCount === 1;
  }
}
