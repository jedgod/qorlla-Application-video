// Subscription enforcement for Meet (server side only; clients cannot influence any of it).
//
//   SUBSCRIPTION_ENFORCEMENT = off (default: Meet behaves exactly as before) | log (decide and log, never block) | enforce
//   SUBSCRIPTION_DATABASE_URL  the subscription engine's database, role qorlla_sub_runtime, search_path subscription_access
//   SUBSCRIPTION_UNOWNED       basic (default) | deny | allow   - what a meeting with no customer (anonymous) gets
//
// What it guarantees in "enforce":
//  * ATOMIC ADMISSION. A join (and a reconnect after leaving) takes a per-meeting advisory lock, counts the seats, asks the engine
//    for the CURRENT entitlement and inserts the participant in ONE transaction, so two simultaneous joins can never both take the
//    last seat. The host is always admitted (and counted).
//  * DURATION ENFORCED ON THE SERVER. The deadline is fixed once at first admission and stored on the meeting row. It is checked at
//    every admission, every socket (re)connect and every authenticated request, ended by an in-process timer, and by a sweeper that
//    also runs at start-up, so a restart, a reconnect or a change of host cannot extend a meeting.
//  * ANONYMOUS meetings get the free plan's limits, through the same code path.
//  * FAIL CLOSED. If the engine cannot be reached or answers badly, the join is refused (503), never allowed.
//  * Suspended customers (directory) cannot join, and their running meetings are ended by the sweeper.
//  Downgrades apply to the NEXT join; a running meeting keeps the deadline it started with.
import { fileURLToPath, pathToFileURL } from 'node:url';

const SEAT_GRACE = "interval '60 seconds'";
const BASIC = Object.freeze({ entitled: true, effective_plan: 'basic', effective_status: 'active' });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inert = Object.freeze({
  mode: 'off', active: false, enforcing: false,
  bridgeCreate: (_req, _res, next) => next(),
  async onCreate() { return { ok: true }; },
  async admitJoin() { throw new Error('subscription enforcement is off'); },
  async assertRunning() { return true; },
  async onSocketAuth() { return { ok: true }; },
  async start() {}, async stop() {},
});

export async function createSubscription({ db, io, audit, room, env = process.env, log = console }) {
  const mode = ['log', 'enforce'].includes(env.SUBSCRIPTION_ENFORCEMENT) ? env.SUBSCRIPTION_ENFORCEMENT : 'off';
  if (mode === 'off') return inert;
  if (!env.SUBSCRIPTION_DATABASE_URL) throw new Error('SUBSCRIPTION_ENFORCEMENT is on but SUBSCRIPTION_DATABASE_URL is not set (refusing to start unenforced)');
  const enforcing = mode === 'enforce';
  const unowned = ['basic', 'deny', 'allow'].includes(env.SUBSCRIPTION_UNOWNED) ? env.SUBSCRIPTION_UNOWNED : 'basic';
  const entry = env.SUBSCRIPTION_ACCESS_ENTRY || fileURLToPath(new URL('../../qorlla-subscription-access/src/index.js', import.meta.url));
  const sub = await import(pathToFileURL(entry).href);
  const service = new sub.AccessService({ connectionString: env.SUBSCRIPTION_DATABASE_URL, poolMax: Number(env.SUBSCRIPTION_POOL_MAX || 10) });
  const guard = sub.createMeetGuard({ service, lookupMeeting: async () => null, unowned });
  const sweepMs = Number(env.SUBSCRIPTION_SWEEP_MS || 10_000);
  const note = (event, detail = {}) => (log.info || log.log).call(log, JSON.stringify({ subscription: event, mode, ...detail }));

  // ---- decisions ------------------------------------------------------------------------------------------------------------------
  /** Capacity decision for a customer (or the anonymous policy). Throws if the engine fails. */
  async function decide(customerId, feature, quantity) {
    if (!customerId) {
      if (unowned === 'allow') return { allowed: true, limit: 'unlimited' };
      if (unowned === 'deny') return { allowed: false, reason: 'subscription_inactive' };
      return sub.decide(BASIC, {}, feature, quantity, null);
    }
    return service.canAccess(customerId, feature, { quantity, actor: 'meet' });
  }
  /** In "log" mode a refusal is only reported. */
  const refuse = (why, detail) => { note('would_refuse', { why, ...detail }); return enforcing; };

  // ---- bridge: a trusted caller names the customer; the plan decides what the meeting may be ---------------------------------------
  const bridgeMw = guard.bridgeCreate();
  const bridgeCreate = async (req, res, next) => {
    try {
      const src = req.body?.sourceId;
      if (typeof src === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(src)) {            // an existing registration is an idempotent retry: never re-judge it
        const { rows } = await db.query("SELECT 1 FROM external_meeting_links WHERE source_system='qorlla-main' AND source_id=$1", [src]);
        if (rows.length) return next();
      }
    } catch { return res.status(503).json({ error: 'Database unavailable' }); }
    const done = (passed) => {
      const b = req.body || {};
      req.entitledFeatures = { recording: b.recording === true, webinar: b.webinar === true, breakoutRooms: b.breakoutRooms === true };
      // In log mode a "would refuse" still records WHO the meeting belongs to, so every later decision is made for the right customer.
      if (!passed && !enforcing && typeof b.customerId === 'string' && UUID_RE.test(b.customerId)) req.meetingCustomerId = b.customerId.toLowerCase();
      return next();
    };
    if (enforcing) return bridgeMw(req, res, () => done(true));
    // log mode: run the same checks but let the request through whatever they say
    let settled = false;
    const once = (fn) => (...a) => { if (!settled) { settled = true; fn(...a); } };
    const spy = { status(code) { this.code = code; return this; }, json(body) { note('would_refuse_bridge_create', { status: this.code, body }); once(() => done(false))(); return this; } };
    return bridgeMw(req, spy, once(() => done(true)));
  };

  // ---- seats, deadlines, ending ------------------------------------------------------------------------------------------------
  const timers = new Map();
  function arm(meetingId, deadline) {
    clearTimeout(timers.get(meetingId));
    const ms = Math.max(0, new Date(deadline).getTime() - Date.now());
    const t = setTimeout(() => expireOne(meetingId), Math.min(ms, 2 ** 31 - 1)); t.unref?.();
    timers.set(meetingId, t);
  }
  function notifyEnded(meetingId, reason) {
    clearTimeout(timers.get(meetingId)); timers.delete(meetingId);
    io.to(room(meetingId)).emit('meeting-ended', { reason });
    io.in(room(meetingId)).disconnectSockets(true);
    audit(meetingId, null, 'meeting.ended_by_policy', { reason });
  }
  async function endIn(client, meetingId, reason) {
    const r = await client.query('UPDATE meetings SET ended_at = now(), end_reason = $2 WHERE id = $1 AND ended_at IS NULL RETURNING id', [meetingId, reason]);
    if (r.rowCount) await client.query('UPDATE participants SET left_at = now() WHERE meeting_id = $1 AND left_at IS NULL', [meetingId]);
    return r.rowCount > 0;
  }
  async function expireOne(meetingId) {
    try {
      const c = await db.connect();
      try {
        await c.query('BEGIN');
        const r = await c.query("UPDATE meetings SET ended_at = now(), end_reason = 'time_limit' WHERE id = $1 AND ended_at IS NULL AND deadline_at IS NOT NULL AND deadline_at <= now() RETURNING id", [meetingId]);
        if (r.rowCount) await c.query('UPDATE participants SET left_at = now() WHERE meeting_id = $1 AND left_at IS NULL', [meetingId]);
        await c.query('COMMIT');
        if (r.rowCount) { if (enforcing) notifyEnded(meetingId, 'time_limit'); }
        else { const d = await db.query('SELECT deadline_at FROM meetings WHERE id = $1 AND ended_at IS NULL AND deadline_at IS NOT NULL', [meetingId]); if (d.rows[0]) arm(meetingId, d.rows[0].deadline_at); }   // the database clock is slightly behind ours: try again
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    } catch (e) { log.error?.('[subscription] expire failed:', e.message); }
  }

  /** Sets the deadline once (first admission). Returns the deadline or null (unlimited). Throws if the engine fails. */
  async function ensureDeadline(client, m) {
    if (m.deadline_at) return m.deadline_at;
    const d = await decide(m.customer_id, 'meetings.duration_minutes', 1);
    const minutes = d.allowed ? d.limit : (refuse('duration_denied', { meeting: m.id, reason: d.reason }) ? 0 : 'unlimited');
    if (typeof minutes === 'number' && minutes >= 0 && enforcing) {
      const r = await client.query('UPDATE meetings SET started_at = COALESCE(started_at, now()), deadline_at = now() + make_interval(mins => $2::int) WHERE id = $1 AND deadline_at IS NULL RETURNING deadline_at', [m.id, minutes]);
      if (r.rows[0]) return r.rows[0].deadline_at;
    }
    await client.query('UPDATE meetings SET started_at = COALESCE(started_at, now()) WHERE id = $1', [m.id]);
    return null;
  }

  /** Inside the caller's transaction, with the per-meeting lock held. */
  async function admitInTx(client, m, { participantId, host }) {
    if (m.customer_id && (await service.suspendedCustomers([m.customer_id])).has(m.customer_id.toLowerCase())) {
      if (refuse('customer_suspended', { meeting: m.id })) return { ok: false, status: 403, error: 'Account suspended' };
    }
    if (!host) {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM participants WHERE meeting_id = $1 AND ($2::uuid IS NULL OR id <> $2) AND left_at IS NULL AND (connected_at IS NOT NULL OR joined_at > now() - ${SEAT_GRACE})`, [m.id, participantId]);
      const d = await decide(m.customer_id, 'meetings.participants', rows[0].n + 1);
      if (!d.allowed && refuse('meeting_full', { meeting: m.id, seats: rows[0].n, limit: d.limit, reason: d.reason })) return { ok: false, status: 403, error: 'Meeting is full' };
    }
    return { ok: true, deadline: await ensureDeadline(client, m) };
  }

  const LOAD = `SELECT id, customer_id, ended_at, deadline_at, (deadline_at IS NOT NULL AND deadline_at <= now()) AS overdue FROM meetings WHERE id = $1 FOR UPDATE`;
  const lock = (client, meetingId) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['seat:' + meetingId]);
  const unavailable = { ok: false, status: 503, error: 'Entitlement check unavailable' };

  /** The join route: admission AND the participant insert are one transaction. */
  async function admitJoin({ meeting, participantId, name, role, host }) {
    const client = await db.connect().catch(() => null);
    if (!client) return { ok: false, status: 503, error: 'Database unavailable' };
    let out; let deadline = null; let ended = false;
    try {
      await client.query('BEGIN');
      await lock(client, meeting.id);
      const m = (await client.query(LOAD, [meeting.id])).rows[0];
      if (!m || m.ended_at) out = { ok: false, status: 404, error: 'Meeting unavailable' };
      else if (m.overdue && enforcing) { ended = await endIn(client, m.id, 'time_limit'); out = { ok: false, status: 403, error: 'Meeting time limit reached' }; }
      else {
        out = await admitInTx(client, m, { participantId: null, host });
        if (out.ok) { await client.query('INSERT INTO participants(id,meeting_id,display_name,role) VALUES($1,$2,$3,$4)', [participantId, meeting.id, name, role]); deadline = out.deadline; }
      }
      await client.query(out.ok || ended ? 'COMMIT' : 'ROLLBACK');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (!enforcing) { note('engine_error_allowing', { error: e.message }); client.release(); return { ok: true, passthrough: true }; }
      log.error?.('[subscription] admission failed closed:', e.code || '', e.message);
      client.release(); return unavailable;
    }
    client.release();
    if (ended) notifyEnded(meeting.id, 'time_limit');
    if (deadline && enforcing) arm(meeting.id, deadline);
    return out;
  }

  /** Anonymous create: called inside the create transaction after the host row exists. */
  async function onCreate(client, meetingId) {
    try {
      const m = { id: meetingId, customer_id: null, deadline_at: null };
      if (unowned === 'deny' && enforcing) return { ok: false, status: 403, error: 'Anonymous meetings are not available' };
      const deadline = await ensureDeadline(client, m);
      return { ok: true, deadline, arm: () => { if (deadline && enforcing) arm(meetingId, deadline); } };
    } catch (e) {
      if (!enforcing) return { ok: true, arm() {} };
      log.error?.('[subscription] create failed closed:', e.message); return unavailable;
    }
  }

  /** HTTP requests of a participant: false once the meeting is over by time or policy (and then it is ended). */
  async function assertRunning(meetingId) {
    if (!enforcing) return true;
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query("UPDATE meetings SET ended_at = now(), end_reason = 'time_limit' WHERE id = $1 AND ended_at IS NULL AND deadline_at IS NOT NULL AND deadline_at <= now() RETURNING id", [meetingId]);
      if (r.rowCount) await c.query('UPDATE participants SET left_at = now() WHERE meeting_id = $1 AND left_at IS NULL', [meetingId]);
      await c.query('COMMIT');
      if (r.rowCount) { notifyEnded(meetingId, 'time_limit'); return false; }
      return true;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }

  /** Socket authentication: deadline, and re-admission after leaving (or after a seat grace that lapsed). */
  async function onSocketAuth(user) {
    const client = await db.connect();
    let deadline = null; let ended = false; let out;
    try {
      await client.query('BEGIN');
      await lock(client, user.meetingId);
      const m = (await client.query(LOAD, [user.meetingId])).rows[0];
      const p = (await client.query(`SELECT id, role, left_at, connected_at, (joined_at < now() - ${SEAT_GRACE}) AS stale FROM participants WHERE id = $1 AND meeting_id = $2 FOR UPDATE`, [user.participantId, user.meetingId])).rows[0];
      if (!m || !p || m.ended_at) out = { ok: false, error: 'Meeting unavailable' };
      else if (m.overdue && enforcing) { ended = await endIn(client, m.id, 'time_limit'); out = { ok: false, error: 'Meeting time limit reached' }; }
      else {
        const needsSeat = p.left_at !== null || (p.connected_at === null && p.stale);
        const a = needsSeat ? await admitInTx(client, m, { participantId: p.id, host: p.role === 'host' }) : { ok: true, deadline: m.deadline_at };
        if (!a.ok) out = { ok: false, error: a.error };
        else { await client.query('UPDATE participants SET connected_at = now(), left_at = NULL WHERE id = $1', [p.id]); deadline = a.deadline; out = { ok: true }; }
      }
      await client.query(out.ok || ended ? 'COMMIT' : 'ROLLBACK');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (!enforcing) { note('engine_error_allowing', { error: e.message }); return { ok: true }; }
      log.error?.('[subscription] socket admission failed closed:', e.message);
      return { ok: false, error: 'Entitlement check unavailable' };
    } finally { client.release(); }
    if (ended) notifyEnded(user.meetingId, 'time_limit');
    if (deadline && enforcing) arm(user.meetingId, deadline);
    return out;
  }

  // ---- background: overdue meetings, suspended customers, "ending soon" notices -----------------------------------------------------
  async function sweep() {
    try {
      if (enforcing) {
        const over = await db.query("UPDATE meetings SET ended_at = now(), end_reason = 'time_limit' WHERE ended_at IS NULL AND deadline_at IS NOT NULL AND deadline_at <= now() RETURNING id");
        for (const r of over.rows) { await db.query('UPDATE participants SET left_at = now() WHERE meeting_id = $1 AND left_at IS NULL', [r.id]); notifyEnded(r.id, 'time_limit'); }
        const owners = (await db.query('SELECT DISTINCT customer_id FROM meetings WHERE ended_at IS NULL AND customer_id IS NOT NULL')).rows.map((r) => r.customer_id);
        if (owners.length) {
          const bad = await service.suspendedCustomers(owners);
          if (bad.size) {
            const ended = await db.query("UPDATE meetings SET ended_at = now(), end_reason = 'account_suspended' WHERE ended_at IS NULL AND customer_id = ANY($1::uuid[]) RETURNING id", [[...bad]]);
            for (const r of ended.rows) { await db.query('UPDATE participants SET left_at = now() WHERE meeting_id = $1 AND left_at IS NULL', [r.id]); notifyEnded(r.id, 'account_suspended'); }
          }
        }
        const soon = await db.query("UPDATE meetings SET warned_at = now() WHERE ended_at IS NULL AND deadline_at IS NOT NULL AND warned_at IS NULL AND deadline_at - now() <= interval '5 minutes' RETURNING id, deadline_at");
        for (const r of soon.rows) io.to(room(r.id)).emit('meeting-ending-soon', { secondsLeft: Math.max(0, Math.round((new Date(r.deadline_at) - Date.now()) / 1000)) });
      }
    } catch (e) { log.error?.('[subscription] sweep failed:', e.message); }
  }
  let interval;
  async function start() {
    // After a restart no socket is connected: every open seat is released and each client re-enters through admission (cap enforced again).
    await db.query('UPDATE participants SET left_at = now() WHERE left_at IS NULL AND meeting_id IN (SELECT id FROM meetings WHERE ended_at IS NULL)');
    if (enforcing) {
      for (const r of (await db.query('SELECT id, deadline_at FROM meetings WHERE ended_at IS NULL AND deadline_at IS NOT NULL')).rows) arm(r.id, r.deadline_at);
      await sweep();                                                                                // meetings that expired while the server was down end NOW
    }
    interval = setInterval(sweep, sweepMs); interval.unref?.();
    note('started', { sweepMs, unowned });
  }
  async function stop() { clearInterval(interval); for (const t of timers.values()) clearTimeout(t); timers.clear(); await service.close(); }

  return { mode, active: true, enforcing, bridgeCreate, onCreate, admitJoin, assertRunning, onSocketAuth, start, stop, service, sweep };
}
