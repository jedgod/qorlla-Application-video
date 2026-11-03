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

/**
 * The shared call ledger on PostgreSQL. Safe with any number of gateway replicas: ownership is the PRIMARY KEY (one INSERT wins), and every state change locks the row, checks the move against TRANSITIONS,
 * and writes the history in the same transaction. Nothing is held in process memory.
 */
export class PostgresCallLedger implements CallLedger {
  constructor(private readonly pool: Pool, private readonly instance: string = 'gateway') {}

  /** True for exactly one caller per call id, however many replicas race for it. */
  async claim(callId: string): Promise<boolean> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query("INSERT INTO phone_join_calls(call_id, state, claimed_by) VALUES($1,'claimed',$2) ON CONFLICT (call_id) DO NOTHING RETURNING call_id", [callId, this.instance]);
      if (r.rowCount) await c.query("INSERT INTO phone_join_call_events(call_id, from_state, to_state, actor) VALUES($1,NULL,'claimed',$2)", [callId, this.instance]);
      await c.query('COMMIT'); return r.rowCount === 1;
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }

  /** false when the call is unknown or the move is not allowed from its current state (the row is not changed). */
  async transition(callId: string, to: CallState, detail: { meetingSessionId?: string; reason?: string } = {}): Promise<boolean> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const cur = (await c.query('SELECT state FROM phone_join_calls WHERE call_id=$1 FOR UPDATE', [callId])).rows[0] as { state: CallState } | undefined;
      if (!cur || !TRANSITIONS[cur.state]?.includes(to)) { await c.query('ROLLBACK'); return false; }
      await c.query(`UPDATE phone_join_calls SET state=$2, updated_at=now(), meeting_session_id=COALESCE($3, meeting_session_id), reason=COALESCE($4, reason),
        ended_at=CASE WHEN $2 IN ('failed','ended') THEN now() ELSE ended_at END WHERE call_id=$1`, [callId, to, detail.meetingSessionId ?? null, detail.reason ? String(detail.reason).slice(0, 200) : null]);
      await c.query('INSERT INTO phone_join_call_events(call_id, from_state, to_state, reason, actor) VALUES($1,$2,$3,$4,$5)', [callId, cur.state, to, detail.reason ? String(detail.reason).slice(0, 200) : null, this.instance]);
      await c.query('COMMIT'); return true;
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }

  /** Frees a call id for a retry, but ONLY when the attempt is finished with (failed). A claimed, connected, terminating or orphaned call keeps its id: a leg may still exist. */
  async release(callId: string): Promise<void> {
    await this.pool.query("DELETE FROM phone_join_calls WHERE call_id=$1 AND state='failed'", [callId]);
  }

  /** Connected calls, for the Shield re-check and for shutdown: any replica can list and end any replica's calls. */
  async listConnected(limit = 500): Promise<{ callId: string; meetingSessionId: string }[]> {
    const r = await this.pool.query("SELECT call_id, meeting_session_id FROM phone_join_calls WHERE state='connected' AND meeting_session_id IS NOT NULL ORDER BY updated_at LIMIT $1", [limit]);
    return r.rows.map((x) => ({ callId: x.call_id, meetingSessionId: x.meeting_session_id }));
  }
  async stateOf(callId: string): Promise<CallState | null> {
    const r = await this.pool.query('SELECT state FROM phone_join_calls WHERE call_id=$1', [callId]); return r.rows[0]?.state ?? null;
  }

  /**
   * Crash recovery. A replica that died mid-admission leaves a claim open. Claims in a non-final state for longer than `olderThanMs` are moved to `terminating` (each by exactly one reaper, even with
   * several running) and returned, so the caller can disconnect their media and then settle them with finishReap(). Connected calls are not touched.
   */
  async reapStale(olderThanMs: number, limit = 100): Promise<string[]> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const rows = (await c.query(`SELECT call_id, state FROM phone_join_calls WHERE state = ANY($1::text[]) AND state <> 'terminating' AND updated_at < now() - make_interval(secs => $2::float8)
        ORDER BY updated_at LIMIT $3 FOR UPDATE SKIP LOCKED`, [OPEN, olderThanMs / 1000, limit])).rows as { call_id: string; state: CallState }[];
      for (const r of rows) {
        await c.query("UPDATE phone_join_calls SET state='terminating', reason='stale_claim', updated_at=now() WHERE call_id=$1", [r.call_id]);
        await c.query("INSERT INTO phone_join_call_events(call_id, from_state, to_state, reason, actor) VALUES($1,$2,'terminating','stale_claim',$3)", [r.call_id, r.state, this.instance]);
      }
      await c.query('COMMIT'); return rows.map((r) => r.call_id);
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }
  /** After the media of a reaped call was disconnected (terminated) or could not be (orphaned: an operator must act). */
  async finishReap(callId: string, terminated: boolean): Promise<void> { await this.transition(callId, terminated ? 'failed' : 'orphaned', { reason: 'reaped' }); if (terminated) await this.release(callId); }
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
