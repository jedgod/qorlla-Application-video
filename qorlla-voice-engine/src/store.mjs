// Qorlla Voice Engine: PostgreSQL operations. Every state change is one transaction; concurrent writers for the same accounts are serialised with advisory locks, and the
// partial unique indexes in 001_voice.sql are the last line of defence (a violation is reported as "busy").
import pg from 'pg';
import { newId, allowedTransition, validExtension, validAccountId } from './core.mjs';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
const fail = (code) => Object.assign(new Error(code), { code });
const CALL_COLS = 'id, caller_id, callee_id, status, created_at, answered_at, ended_at, end_reason, version';

export function createStore(db = pool) {
  async function tx(fn) {
    const c = await db.connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); if (e && e.code === '23505' && /voice_one_live|voice_calls/.test(String(e.constraint || e.detail || ''))) throw fail('busy'); throw e; }
    finally { c.release(); }
  }
  const lockAccounts = async (c, ids) => { for (const id of [...new Set(ids)].sort()) await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id]); };

  const identity = async (account) => (await db.query('SELECT account_id, extension, enabled FROM voice_identities WHERE account_id=$1', [account])).rows[0] || null;

  // ---------------------------------------------------------------- identities (trusted provisioning only)
  async function provisionIdentity(accountId, extension) {
    if (!validAccountId(accountId)) throw fail('invalid_input'); if (extension != null && !validExtension(extension)) throw fail('invalid_input');
    return tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('voice-extension-allocation',0))");
      const have = (await c.query('SELECT account_id, extension, enabled FROM voice_identities WHERE account_id=$1', [accountId])).rows[0];
      if (have) return { identity: have, created: false };
      let ext = extension;
      if (ext) { if ((await c.query('SELECT 1 FROM voice_identities WHERE extension=$1', [ext])).rowCount) throw fail('extension_taken'); }
      else {
        const used = new Set((await c.query('SELECT extension FROM voice_identities')).rows.map((r) => r.extension));
        for (let n = 2000; n <= 99999 && !ext; n++) if (!used.has(String(n))) ext = String(n);       // 2000-9999 first, then five digits
        if (!ext) throw fail('extensions_exhausted');
      }
      const row = (await c.query('INSERT INTO voice_identities(account_id, extension) VALUES($1,$2) RETURNING account_id, extension, enabled', [accountId, ext])).rows[0];
      return { identity: row, created: true };
    });
  }
  async function listIdentities({ ids, limit = 500 } = {}) {
    if (Array.isArray(ids)) return (await db.query('SELECT account_id, extension, enabled FROM voice_identities WHERE account_id = ANY($1::text[]) ORDER BY extension LIMIT 500', [ids.filter(validAccountId).slice(0, 500)])).rows;
    return (await db.query('SELECT account_id, extension, enabled FROM voice_identities ORDER BY extension LIMIT $1', [Math.min(500, Math.max(1, limit))])).rows;
  }
  /** Disabling an identity also ends its live calls, so a suspended account cannot stay in a call it was already in. */
  async function setEnabled(accountId, enabled) {
    return tx(async (c) => {
      await lockAccounts(c, [accountId]);
      const row = (await c.query('UPDATE voice_identities SET enabled=$2 WHERE account_id=$1 RETURNING account_id, extension, enabled', [accountId, !!enabled])).rows[0];
      if (!row) throw fail('not_found');
      const ended = [];
      if (!enabled) for (const call of (await c.query("SELECT id FROM voice_calls WHERE status IN ('ringing','active') AND (caller_id=$1 OR callee_id=$1) FOR UPDATE", [accountId])).rows) {
        const next = (await c.query("UPDATE voice_calls SET status='ended', ended_at=now(), end_reason='account_disabled', version=version+1 WHERE id=$1 RETURNING " + CALL_COLS, [call.id])).rows[0];
        await c.query("INSERT INTO voice_call_events(call_id, actor_id, kind) VALUES($1,'system','account_disabled')", [call.id]); ended.push(next);
      }
      return { identity: row, ended };
    });
  }

  // ---------------------------------------------------------------- calls
  async function createCall(caller, extension, key) {
    return tx(async (c) => {
      const callee = (await c.query('SELECT account_id FROM voice_identities WHERE extension=$1 AND enabled=true', [extension])).rows[0]?.account_id;
      if (!callee || callee === caller) throw fail('invalid_recipient');
      const ids = [caller, callee]; await lockAccounts(c, ids);                                          // serialise callers and recipients
      const old = (await c.query('SELECT call_id, extension FROM voice_idempotency WHERE account_id=$1 AND request_key=$2', [caller, key])).rows[0];
      if (old) { if (old.extension && old.extension !== extension) throw fail('idempotency_conflict'); return { call: (await c.query('SELECT ' + CALL_COLS + ' FROM voice_calls WHERE id=$1', [old.call_id])).rows[0], reused: true }; }
      if (!(await c.query('SELECT enabled FROM voice_identities WHERE account_id=$1', [caller])).rows[0]?.enabled) throw fail('caller_disabled');
      if ((await c.query('SELECT 1 FROM voice_blocks WHERE (owner_id=$1 AND blocked_id=$2) OR (owner_id=$2 AND blocked_id=$1)', [caller, callee])).rowCount) throw fail('blocked');
      if ((await c.query("SELECT 1 FROM voice_calls WHERE status IN ('ringing','active') AND (caller_id = ANY($1::text[]) OR callee_id = ANY($1::text[])) LIMIT 1", [ids])).rowCount) throw fail('busy');
      const id = newId();
      const call = (await c.query("INSERT INTO voice_calls(id, caller_id, callee_id, status) VALUES($1,$2,$3,'ringing') RETURNING " + CALL_COLS, [id, caller, callee])).rows[0];
      await c.query('INSERT INTO voice_idempotency(account_id, request_key, call_id, extension) VALUES($1,$2,$3,$4)', [caller, key, id, extension]);
      await c.query("INSERT INTO voice_call_events(call_id, actor_id, kind) VALUES($1,$2,'created')", [id, caller]);
      return { call, reused: false };
    });
  }
  const getCall = async (id) => (await db.query('SELECT ' + CALL_COLS + ' FROM voice_calls WHERE id=$1', [id])).rows[0] || null;
  const liveCall = async (account) => (await db.query("SELECT " + CALL_COLS + " FROM voice_calls WHERE status IN ('ringing','active') AND (caller_id=$1 OR callee_id=$1) ORDER BY created_at DESC LIMIT 1", [account])).rows[0] || null;
  async function listCalls(account, limit = 100) {
    return (await db.query(`SELECT c.id, c.caller_id, c.callee_id, c.status, c.created_at, c.answered_at, c.ended_at, c.end_reason, ci.extension AS caller_extension, ei.extension AS callee_extension
      FROM voice_calls c JOIN voice_identities ci ON ci.account_id=c.caller_id JOIN voice_identities ei ON ei.account_id=c.callee_id
      WHERE c.caller_id=$1 OR c.callee_id=$1 ORDER BY c.created_at DESC LIMIT $2`, [account, Math.min(200, Math.max(1, limit))])).rows;
  }
  async function transition(id, actor, to, reason) {
    return tx(async (c) => {
      const call = (await c.query('SELECT ' + CALL_COLS + ' FROM voice_calls WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!call || ![call.caller_id, call.callee_id].includes(actor)) throw fail('not_found');        // a non-participant learns nothing, not even that the call exists
      if (!allowedTransition(call.status, to)) throw fail('invalid_transition');
      if ((to === 'active' || to === 'rejected') && actor !== call.callee_id) throw fail('forbidden');
      const why = reason || (to === 'rejected' ? 'rejected_by_callee' : to === 'ended' ? (actor === call.caller_id ? 'ended_by_caller' : 'ended_by_callee') : to === 'failed' ? 'connection_failed' : null);
      const next = (await c.query(`UPDATE voice_calls SET status=$2, version=version+1, answered_at=CASE WHEN $2='active' THEN now() ELSE answered_at END,
        ended_at=CASE WHEN $2 IN ('ended','failed','rejected','missed') THEN now() ELSE ended_at END, end_reason=COALESCE($3, end_reason) WHERE id=$1 RETURNING ${CALL_COLS}`, [id, to, why])).rows[0];
      await c.query('INSERT INTO voice_call_events(call_id, actor_id, kind) VALUES($1,$2,$3)', [id, actor, to]);
      return next;
    });
  }
  /** Unanswered calls become "missed" with an audit event. Returns the calls it changed so the caller can notify both parties. */
  async function expireRinging(seconds = 60) {
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 600) throw fail('invalid_timeout');
    return (await db.query(`WITH expired AS (
        UPDATE voice_calls SET status='missed', ended_at=now(), end_reason='ring_timeout', version=version+1
        WHERE status='ringing' AND created_at < now() - make_interval(secs => $1::int) RETURNING ${CALL_COLS}
      ), audit AS (INSERT INTO voice_call_events(call_id, actor_id, kind) SELECT id, 'system', 'missed' FROM expired RETURNING call_id)
      SELECT expired.* FROM expired JOIN audit ON audit.call_id = expired.id`, [seconds])).rows;
  }

  // ---------------------------------------------------------------- blocks and usage
  const listBlocks = async (owner) => (await db.query('SELECT i.extension FROM voice_blocks b JOIN voice_identities i ON i.account_id=b.blocked_id WHERE b.owner_id=$1 ORDER BY i.extension', [owner])).rows.map((r) => r.extension);
  async function addBlock(owner, extension) {
    const target = (await db.query('SELECT account_id FROM voice_identities WHERE extension=$1', [extension])).rows[0]?.account_id;
    if (!target || target === owner) throw fail('invalid_recipient');
    await db.query('INSERT INTO voice_blocks(owner_id, blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [owner, target]); return true;
  }
  async function removeBlock(owner, extension) { await db.query('DELETE FROM voice_blocks WHERE owner_id=$1 AND blocked_id=(SELECT account_id FROM voice_identities WHERE extension=$2)', [owner, extension]); return true; }
  async function usage(account, days = 30) {
    const d = Math.min(366, Math.max(1, Math.round(days)));
    const r = (await db.query(`SELECT count(*)::int AS calls, count(*) FILTER (WHERE answered_at IS NOT NULL)::int AS answered, COALESCE(sum(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - answered_at))) FILTER (WHERE answered_at IS NOT NULL),0)::bigint AS seconds
      FROM voice_calls WHERE (caller_id=$1 OR callee_id=$1) AND created_at > now() - make_interval(days => $2::int)`, [account, d])).rows[0];
    return { days: d, calls: r.calls, answered: r.answered, seconds: Number(r.seconds), note: 'Seconds are measured by the server from answer to end. Client-supplied durations are never used.' };
  }
  const ping = async () => { await db.query('SELECT 1'); return true; };
  return { identity, provisionIdentity, listIdentities, setEnabled, createCall, getCall, liveCall, listCalls, transition, expireRinging, listBlocks, addBlock, removeBlock, usage, ping };
}

const defaultStore = createStore(pool);
export const { identity, provisionIdentity, listIdentities, setEnabled, createCall, getCall, liveCall, listCalls, transition, expireRinging, listBlocks, addBlock, removeBlock, usage } = defaultStore;
export default defaultStore;
