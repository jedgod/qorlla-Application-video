// Qorlla Voice Engine: PostgreSQL operations. Every state change is ONE transaction that also writes the durable events about it (the outbox), so the state and its notifications commit
// together or not at all. Concurrent writers for the same accounts are serialised with advisory locks, and the partial unique indexes in the SQL files are the last line of defence.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { newId, allowedTransition, validExtension, validAccountId, publicCall } from './core.mjs';
import { appendEvent, lockEvents } from './reliability.mjs';
import { createRooms } from './rooms.mjs';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX || 10), ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
pool.on('error', (e) => console.error('voice: idle database connection lost (the pool replaces it):', e.code || e.message));   // a dropped connection must never crash the process
const fail = (code) => Object.assign(new Error(code), { code });
const CALL_COLS = 'id, caller_id, callee_id, status, created_at, answered_at, ended_at, end_reason, version';
export const LEASE_SECONDS = 90;

export function createStore(db = pool) {
  async function tx(fn) {
    for (let attempt = 1; ; attempt++) {
      const c = await db.connect(), onError = () => {};            // a connection dropped between statements must not crash the process: the next statement fails and the transaction rolls back
      c.on('error', onError);
      try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
      catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        if (e && (e.code === '40P01' || e.code === '40001') && attempt < 4) { await new Promise((r) => setTimeout(r, 15 * attempt + Math.random() * 25)); continue; }      // deadlock / serialization failure: nothing was committed, run it again
        if (e && e.code === '23505' && /voice_one_live|voice_calls|voice_room_one_joined|voice_room/.test(String(e.constraint || e.detail || ''))) throw fail('busy'); throw e;
      }
      finally { c.removeListener('error', onError); c.release(); }
    }
  }
  const lockAccounts = async (c, ids) => { for (const id of [...new Set(ids)].sort()) await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id]); };
  const ev = (c, account, kind, payload, callId = null) => appendEvent(c, { account, callId, kind, payload });
  const stateEvents = async (c, call) => { const p = { type: 'state', call: publicCall(call) }; await lockEvents(c, [call.caller_id, call.callee_id]); for (const a of new Set([call.caller_id, call.callee_id])) await ev(c, a, 'state', p, call.id); };
  const extensionOf = async (c, account) => (await c.query('SELECT extension FROM voice_identities WHERE account_id=$1', [account])).rows[0]?.extension || null;
  /** An account is busy while it is in a live one-to-one call or has joined a live group room. */
  const busyAccounts = async (c, ids) => (await c.query(`SELECT 1 FROM voice_calls WHERE status IN ('ringing','active') AND (caller_id = ANY($1::text[]) OR callee_id = ANY($1::text[]))
    UNION ALL SELECT 1 FROM voice_room_members m JOIN voice_rooms r ON r.id=m.room_id WHERE r.status='live' AND m.status='joined' AND m.account_id = ANY($1::text[]) LIMIT 1`, [ids])).rowCount > 0;
  const validDevice = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  const setLease = (c, callId, account, deviceId, generation) => c.query(`INSERT INTO voice_media_leases(call_id, account_id, device_id, lease_token, generation, expires_at)
    VALUES($1,$2,$3,$4,$5, now() + make_interval(secs => ${LEASE_SECONDS})) ON CONFLICT (call_id, account_id) DO UPDATE SET device_id=EXCLUDED.device_id, lease_token=EXCLUDED.lease_token, generation=EXCLUDED.generation, expires_at=EXCLUDED.expires_at
    RETURNING call_id, account_id, device_id, lease_token, generation, expires_at`, [callId, account, deviceId, randomUUID(), generation]);

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

  const rooms = createRooms({ db, tx, lockAccounts, ev, lockEvents, busyAccounts, validDevice, extensionOf, LEASE_SECONDS });

  /** Disabling an identity also ends its live calls and removes it from rooms, so a suspended account cannot stay in a call it was already in. */
  async function setEnabled(accountId, enabled) {
    return tx(async (c) => {
      await lockAccounts(c, [accountId]);
      const row = (await c.query('UPDATE voice_identities SET enabled=$2 WHERE account_id=$1 RETURNING account_id, extension, enabled', [accountId, !!enabled])).rows[0];
      if (!row) throw fail('not_found');
      const ended = [];
      if (!enabled) {
        for (const call of (await c.query("SELECT id FROM voice_calls WHERE status IN ('ringing','active') AND (caller_id=$1 OR callee_id=$1) FOR UPDATE", [accountId])).rows) {
          const next = (await c.query("UPDATE voice_calls SET status='ended', ended_at=now(), end_reason='account_disabled', version=version+1 WHERE id=$1 RETURNING " + CALL_COLS, [call.id])).rows[0];
          await c.query("INSERT INTO voice_call_events(call_id, actor_id, kind) VALUES($1,'system','account_disabled')", [call.id]); await stateEvents(c, next); ended.push(next);
        }
        await rooms.removeAccountTx(c, accountId, 'account_disabled');
      }
      return { identity: row, ended };
    });
  }

  // ---------------------------------------------------------------- calls
  async function createCall(caller, extension, key, deviceId = null) {
    if (deviceId != null && !validDevice(deviceId)) throw fail('invalid_input');
    return tx(async (c) => {
      const callee = (await c.query('SELECT account_id FROM voice_identities WHERE extension=$1 AND enabled=true', [extension])).rows[0]?.account_id;
      if (!callee || callee === caller) throw fail('invalid_recipient');
      const ids = [caller, callee]; await lockAccounts(c, ids);                                          // serialise callers and recipients
      const old = (await c.query('SELECT call_id, extension FROM voice_idempotency WHERE account_id=$1 AND request_key=$2', [caller, key])).rows[0];
      if (old) { if (old.extension && old.extension !== extension) throw fail('idempotency_conflict'); return { call: (await c.query('SELECT ' + CALL_COLS + ' FROM voice_calls WHERE id=$1', [old.call_id])).rows[0], reused: true }; }
      if (!(await c.query('SELECT enabled FROM voice_identities WHERE account_id=$1', [caller])).rows[0]?.enabled) throw fail('caller_disabled');
      if ((await c.query('SELECT 1 FROM voice_blocks WHERE (owner_id=$1 AND blocked_id=$2) OR (owner_id=$2 AND blocked_id=$1)', [caller, callee])).rowCount) throw fail('blocked');
      if (await busyAccounts(c, ids)) throw fail('busy');
      const id = newId();
      const call = (await c.query("INSERT INTO voice_calls(id, caller_id, callee_id, status) VALUES($1,$2,$3,'ringing') RETURNING " + CALL_COLS, [id, caller, callee])).rows[0];
      await c.query('INSERT INTO voice_idempotency(account_id, request_key, call_id, extension) VALUES($1,$2,$3,$4)', [caller, key, id, extension]);
      await c.query("INSERT INTO voice_call_events(call_id, actor_id, kind) VALUES($1,$2,'created')", [id, caller]);
      let lease = null; if (deviceId) lease = (await setLease(c, id, caller, deviceId, 1)).rows[0];                       // the dialling device owns the caller side from the start
      await ev(c, callee, 'incoming', { type: 'incoming', call: publicCall(call), from: { extension: await extensionOf(c, caller) } }, id);
      return { call, reused: false, lease };
    });
  }
  const getCall = async (id) => (await db.query('SELECT ' + CALL_COLS + ' FROM voice_calls WHERE id=$1', [id])).rows[0] || null;
  const liveCall = async (account) => (await db.query("SELECT " + CALL_COLS + " FROM voice_calls WHERE status IN ('ringing','active') AND (caller_id=$1 OR callee_id=$1) ORDER BY created_at DESC LIMIT 1", [account])).rows[0] || null;
  async function listCalls(account, limit = 100) {
    return (await db.query(`SELECT c.id, c.caller_id, c.callee_id, c.status, c.created_at, c.answered_at, c.ended_at, c.end_reason, ci.extension AS caller_extension, ei.extension AS callee_extension
      FROM voice_calls c JOIN voice_identities ci ON ci.account_id=c.caller_id JOIN voice_identities ei ON ei.account_id=c.callee_id
      WHERE c.caller_id=$1 OR c.callee_id=$1 ORDER BY c.created_at DESC LIMIT $2`, [account, Math.min(200, Math.max(1, limit))])).rows;
  }
  /** fence = { deviceId, generation }: when given, the acting device must hold the current lease (a replaced device cannot fail the call). deviceId: the answering device gets the callee lease. */
  async function transition(id, actor, to, reason, { deviceId = null, fence = null } = {}) {
    if (deviceId != null && !validDevice(deviceId)) throw fail('invalid_input');
    return tx(async (c) => {
      const call = (await c.query('SELECT ' + CALL_COLS + ' FROM voice_calls WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!call || ![call.caller_id, call.callee_id].includes(actor)) throw fail('not_found');        // a non-participant learns nothing, not even that the call exists
      if (!allowedTransition(call.status, to)) throw fail('invalid_transition');
      if ((to === 'active' || to === 'rejected') && actor !== call.callee_id) throw fail('forbidden');
      if (fence) {
        const l = (await c.query('SELECT device_id, generation, expires_at > now() AS valid FROM voice_media_leases WHERE call_id=$1 AND account_id=$2', [id, actor])).rows[0];
        if (!l || !l.valid || l.device_id !== fence.deviceId || Number(l.generation) !== fence.generation) throw fail('device_not_owner');
      }
      const why = reason || (to === 'rejected' ? 'rejected_by_callee' : to === 'ended' ? (actor === call.caller_id ? 'ended_by_caller' : 'ended_by_callee') : to === 'failed' ? 'connection_failed' : null);
      const next = (await c.query(`UPDATE voice_calls SET status=$2, version=version+1, answered_at=CASE WHEN $2='active' THEN now() ELSE answered_at END,
        ended_at=CASE WHEN $2 IN ('ended','failed','rejected','missed') THEN now() ELSE ended_at END, end_reason=COALESCE($3, end_reason) WHERE id=$1 RETURNING ${CALL_COLS}`, [id, to, why])).rows[0];
      await c.query('INSERT INTO voice_call_events(call_id, actor_id, kind) VALUES($1,$2,$3)', [id, actor, to]);
      let lease = null; if (to === 'active' && deviceId) lease = (await setLease(c, id, actor, deviceId, 1)).rows[0];          // the answering device owns the callee side
      await stateEvents(c, next);
      return Object.assign(next, { _lease: lease });
    });
  }
  /** Unanswered calls become "missed" with an audit event and a durable state event for both parties. Returns the calls it changed. */
  async function expireRinging(seconds = 60) {
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 600) throw fail('invalid_timeout');
    return tx(async (c) => {
      const rows = (await c.query(`UPDATE voice_calls SET status='missed', ended_at=now(), end_reason='ring_timeout', version=version+1
        WHERE id IN (SELECT id FROM voice_calls WHERE status='ringing' AND created_at < now() - make_interval(secs => $1::int) FOR UPDATE SKIP LOCKED) RETURNING ${CALL_COLS}`, [seconds])).rows;
      for (const call of rows) { await c.query("INSERT INTO voice_call_events(call_id, actor_id, kind) VALUES($1,'system','missed')", [call.id]); await stateEvents(c, call); }
      return rows;
    });
  }
  /** An active call whose participant stopped renewing the device lease (browser gone, network lost) ends after a grace period instead of holding both accounts busy forever. */
  async function expireStaleCalls(graceSeconds = 120) {
    return tx(async (c) => {
      const rows = (await c.query(`UPDATE voice_calls SET status='ended', ended_at=now(), end_reason='lease_expired', version=version+1
        WHERE id IN (SELECT c.id FROM voice_calls c WHERE c.status='active' AND c.answered_at < now() - make_interval(secs => $1::int)
          AND EXISTS (SELECT 1 FROM voice_media_leases l WHERE l.call_id=c.id AND l.expires_at < now() - make_interval(secs => $1::int)) FOR UPDATE SKIP LOCKED) RETURNING ${CALL_COLS}`, [graceSeconds])).rows;
      for (const call of rows) { await c.query("INSERT INTO voice_call_events(call_id, actor_id, kind) VALUES($1,'system','lease_expired')", [call.id]); await stateEvents(c, call); }
      return rows;
    });
  }

  // ---------------------------------------------------------------- device ownership (v1.2 leases with v1.4 generation fencing)
  /** The calling device becomes the account's media device for this call. The generation grows on every claim, so anything the replaced device sends is recognisably stale. */
  async function claimDevice(callId, account, deviceId) {
    if (!validDevice(deviceId)) throw fail('invalid_input');
    return tx(async (c) => {
      const call = (await c.query('SELECT ' + CALL_COLS + ' FROM voice_calls WHERE id=$1 FOR UPDATE', [callId])).rows[0];
      if (!call || ![call.caller_id, call.callee_id].includes(account)) throw fail('not_found');
      if (call.status !== 'active' && !(call.status === 'ringing' && account === call.caller_id)) throw fail('call_not_active');
      const old = (await c.query('SELECT device_id, generation FROM voice_media_leases WHERE call_id=$1 AND account_id=$2 FOR UPDATE', [callId, account])).rows[0];
      const generation = old ? Number(old.generation) + 1 : 1;
      const lease = (await setLease(c, callId, account, deviceId, generation)).rows[0];
      const peerAcct = account === call.caller_id ? call.callee_id : call.caller_id; await lockEvents(c, [account, peerAcct]);
      if (old && old.device_id !== deviceId) await ev(c, account, 'device_revoked', { type: 'device_revoked', callId, revokedDevice: old.device_id, newDevice: deviceId, generation }, callId);
      const peer = account === call.caller_id ? call.callee_id : call.caller_id;
      await lockEvents(c, [account, peer]);
      await ev(c, peer, 'device_claimed', { type: 'device_claimed', callId, generation, by: account === call.caller_id ? 'caller' : 'callee' }, callId);
      return { lease: { ...lease, generation: Number(lease.generation) }, call };
    });
  }
  async function refreshLease(callId, account, deviceId, generation) {
    const r = await db.query(`UPDATE voice_media_leases l SET expires_at = now() + make_interval(secs => ${LEASE_SECONDS}) FROM voice_calls c
      WHERE l.call_id=$1 AND l.account_id=$2 AND l.device_id=$3 AND l.generation=$4 AND l.expires_at > now() AND c.id=l.call_id AND c.status IN ('ringing','active') RETURNING l.expires_at`, [callId, account, deviceId, generation]);
    return r.rows[0] || null;
  }
  /** Everything a signaling decision needs, in one read from PostgreSQL (so every replica decides the same way): the call and both participants' current leases. */
  async function signalContext(callId) {
    const { rows } = await db.query(`SELECT c.id, c.caller_id, c.callee_id, c.status, l.account_id AS lease_account, l.device_id, l.generation, (l.expires_at > now()) AS valid
      FROM voice_calls c LEFT JOIN voice_media_leases l ON l.call_id=c.id WHERE c.id=$1`, [callId]);
    if (!rows.length) return null;
    const call = { id: rows[0].id, caller_id: rows[0].caller_id, callee_id: rows[0].callee_id, status: rows[0].status }, leases = {};
    for (const r of rows) if (r.lease_account) leases[r.lease_account] = { device_id: r.device_id, generation: Number(r.generation), valid: r.valid };
    return { call, leases };
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
    const g = (await db.query(`SELECT count(*)::int AS rooms, COALESCE(sum(EXTRACT(EPOCH FROM (COALESCE(left_at, now()) - joined_at))),0)::bigint AS seconds FROM voice_room_members WHERE account_id=$1 AND joined_at IS NOT NULL AND joined_at > now() - make_interval(days => $2::int)`, [account, d])).rows[0];
    return { days: d, calls: r.calls, answered: r.answered, seconds: Number(r.seconds), groupRooms: g.rooms, groupSeconds: Number(g.seconds), note: 'Seconds are measured by the server from answer (or join) to end (or leave). Client-supplied durations are never used.' };
  }
  const ping = async () => { await db.query('SELECT 1'); return true; };
  return { tx, identity, provisionIdentity, listIdentities, setEnabled, createCall, getCall, liveCall, listCalls, transition, expireRinging, expireStaleCalls, claimDevice, refreshLease, signalContext, listBlocks, addBlock, removeBlock, usage, ping, validDevice, rooms };
}

const defaultStore = createStore(pool);
export const { identity, provisionIdentity, listIdentities, setEnabled, createCall, getCall, liveCall, listCalls, transition, expireRinging, listBlocks, addBlock, removeBlock, usage } = defaultStore;
export default defaultStore;
