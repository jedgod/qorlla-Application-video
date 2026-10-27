'use strict';
/**
 * Meeting-passcode lockout (v4.6.1): ONE policy, two persistence adapters.
 *
 *   Policy   5 failed attempts per meeting -> locked for 10 minutes. A locked meeting refuses every attempt BEFORE the passcode is checked,
 *            including a correct one. Only an authorised host action (clearLockLimited) lifts an active lock early; it never sees or changes the passcode.
 *   Design   "reserve -> verify -> settle". reserve() atomically counts the attempt BEFORE the costly hash check and returns a unique attemptId, so
 *            concurrent attempts (even across processes) can never exceed the budget. settleSuccess()/settleFailure() consume the reservation.
 *            If the comparison itself FAULTS (not a wrong passcode), release(attemptId) gives that one attempt back: it is idempotent, only removes
 *            the caller's own reservation, and only while the counting epoch is unchanged (a reset or lock invalidates every open reservation), so it
 *            can never reduce the count for another request. If the store cannot confirm the release the request fails closed (503).
 *   Recovery clearLockLimited() checks the 3-per-hour allowance (durable cleared_by_host history), clears the lock and records the event in ONE
 *            atomic operation. Rejected requests are recorded with audit() under a different kind and never use up the allowance.
 *   Adapters PostgreSQL (full stack: row-locked transactions, database clock) and an encrypted file store (standalone MAIN: exclusive cross-process
 *            lock directory + fsync'd atomic replace). Neither falls back to memory: any storage fault is "unavailable" and the join is refused.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const MAX_FAILURES = 5;
const LOCK_MS = 10 * 60 * 1000;
const EVENTS_KEPT = 50;
const CLEAR_MAX = 3;
const CLEAR_WINDOW_MS = 60 * 60 * 1000;
const hash12 = (s) => crypto.createHash('sha256').update('qorlla-lockout|' + String(s)).digest('hex').slice(0, 12);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ----------------------------------------------------------------------------------------------- file adapter (standalone MAIN)
function createFileLockoutStore({ dir, now = () => Date.now(), lockWaitMs = 3000, staleLockMs = 15000 }) {
    const file = path.join(dir, 'passcode-lockout.json');
    const lockDir = path.join(dir, 'passcode-lockout.lock');
    fs.mkdirSync(dir, { recursive: true });

    /** Exclusive cross-process lock: mkdir is atomic. A lock older than staleLockMs is taken over (crashed holder). Failure to acquire throws. */
    function withLock(fn) {
        const started = Date.now(); let acquired = false;
        while (!acquired) {
            try { fs.mkdirSync(lockDir); acquired = true; fs.writeFileSync(path.join(lockDir, 'owner'), JSON.stringify({ pid: process.pid, at: Date.now() })); }
            catch (err) {
                if (err.code !== 'EEXIST') throw err;
                try { if (Date.now() - fs.statSync(lockDir).mtimeMs > staleLockMs) { fs.rmSync(lockDir, { recursive: true, force: true }); continue; } } catch (e) { /* vanished: retry */ }
                if (Date.now() - started > lockWaitMs) throw new Error('lockout store busy: could not take the exclusive lock');
                sleepSync(15 + Math.floor(Math.random() * 25));
            }
        }
        try { return fn(); } finally { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (e) { /* best effort */ } }
    }
    // Corrupt or undecryptable state THROWS (store.inspect never treats damage as "empty"), so the caller fails closed.
    const load = () => { const r = store.inspect(file); const d = r ? r.data : { meetings: {} }; if (!d || typeof d.meetings !== 'object') throw new Error('lockout state has an unexpected shape'); return d; };
    const save = (d) => {
        const cutoff = now() - 24 * 3600 * 1000;
        for (const [id, m] of Object.entries(d.meetings)) if (!(m.lockedUntil && Date.parse(m.lockedUntil) > now()) && !m.failed && (m.touched || 0) < cutoff) delete d.meetings[id];
        store.writeJson(file, d, { durable: true, strict: true });
    };
    const entry = (d, id) => { const m = (d.meetings[id] = d.meetings[id] || { failed: 0, lockedUntil: null, events: [], touched: now() }); m.open = m.open || {}; m.epoch = m.epoch || 0; m.clears = m.clears || []; return m; };
    const lockedNow = (m) => !!(m.lockedUntil && Date.parse(m.lockedUntil) > now());
    const event = (m, kind, actor, reason) => { m.events.unshift({ at: new Date(now()).toISOString(), kind, actor: actor || null, ...(reason ? { reason } : {}) }); m.events.length = Math.min(m.events.length, EVENTS_KEPT); };
    const resetEpoch = (m) => { m.epoch += 1; m.open = {}; };                     // every open reservation becomes void

    return {
        kind: 'file',
        async reserve(id) { return withLock(() => {
            const d = load(); const m = entry(d, id); m.touched = now();
            if (lockedNow(m)) { save(d); return { allowed: false, locked: true, lockedUntil: m.lockedUntil }; }
            if (m.lockedUntil) { m.lockedUntil = null; m.failed = 0; resetEpoch(m); }   // expired lock: fresh budget
            if (m.failed >= MAX_FAILURES) { save(d); return { allowed: false, locked: false, busy: true }; }
            const attemptId = crypto.randomUUID(); m.failed += 1; m.open[attemptId] = m.epoch; save(d); return { allowed: true, attemptId };
        }); },
        async release(id, attemptId) { return withLock(() => {
            const d = load(); const m = entry(d, id); const e = m.open[attemptId];
            if (e === undefined) return { released: false };                       // unknown, already settled or already released: nothing to do
            delete m.open[attemptId];
            if (e !== m.epoch) { save(d); return { released: false }; }            // reservation predates a reset/lock: it no longer counts toward the current budget
            if (m.failed > 0) m.failed -= 1; save(d); return { released: true };
        }); },
        async settleSuccess(id, attemptId) { return withLock(() => {
            const d = load(); const m = entry(d, id); delete m.open[attemptId];
            if (lockedNow(m)) { save(d); return { ok: false, locked: true, lockedUntil: m.lockedUntil }; }
            m.failed = 0; resetEpoch(m); m.touched = now(); save(d); return { ok: true };
        }); },
        async settleFailure(id, client, attemptId) { return withLock(() => {
            const d = load(); const m = entry(d, id); m.touched = now(); delete m.open[attemptId];
            if (lockedNow(m)) { save(d); return { locked: true, newlyLocked: false, lockedUntil: m.lockedUntil, remaining: 0 }; }
            if (m.failed >= MAX_FAILURES) { m.lockedUntil = new Date(now() + LOCK_MS).toISOString(); m.failed = 0; resetEpoch(m); event(m, 'locked', client); save(d); return { locked: true, newlyLocked: true, lockedUntil: m.lockedUntil, remaining: 0 }; }
            save(d); return { locked: false, newlyLocked: false, lockedUntil: null, remaining: MAX_FAILURES - m.failed };
        }); },
        async status(id) { return withLock(() => { const d = load(); const m = d.meetings[id]; if (!m) return { locked: false, lockedUntil: null, failed: 0, events: [] }; return { locked: lockedNow(m), lockedUntil: lockedNow(m) ? m.lockedUntil : null, failed: m.failed, events: m.events.slice(0, 20) }; }); },
        /** Atomic: allowance check + lock clear + history, under the exclusive lock. */
        async clearLockLimited(id, actor, max = CLEAR_MAX, windowMs = CLEAR_WINDOW_MS) { return withLock(() => {
            const d = load(); const m = entry(d, id); const t = now();
            m.clears = m.clears.filter((c) => t - Date.parse(c.at) < 24 * 3600 * 1000);
            const recent = m.clears.filter((c) => c.actor === actor && t - Date.parse(c.at) < windowMs);
            if (recent.length >= max) { event(m, 'clear_rejected', actor, 'rate_limited'); save(d); return { ok: false, reason: 'rate_limited', retryAfterMs: windowMs - (t - Date.parse(recent[0].at)) }; }
            const was = lockedNow(m); m.lockedUntil = null; m.failed = 0; resetEpoch(m);
            m.clears.push({ at: new Date(t).toISOString(), actor }); event(m, 'cleared_by_host', actor); save(d); return { ok: true, wasLocked: was };
        }); },
        async audit(id, kind, actor, reason) { return withLock(() => { const d = load(); const m = entry(d, id); event(m, kind, actor, reason); save(d); return { recorded: true }; }); }
    };
}

// ----------------------------------------------------------------------------------------------- PostgreSQL adapter (full stack)
function createPgLockoutStore({ pool }) {
    // Every method runs in ONE transaction holding a row lock on the meeting's counter row; expiry uses the database clock, so replicas with
    // skewed clocks agree. Any error rolls back and propagates (the caller fails closed).
    async function run(id, body) {
        const c = await pool.connect();
        try {
            await c.query('BEGIN');
            await c.query('INSERT INTO public.meeting_passcode_attempts(meeting_id) VALUES ($1) ON CONFLICT (meeting_id) DO NOTHING', [id]);
            const out = await body(c); await c.query('COMMIT'); return out;
        } catch (e) { try { await c.query('ROLLBACK'); } catch (x) { /* connection already gone */ } throw e; } finally { c.release(); }
    }
    const row = async (c, id) => (await c.query('SELECT failed_attempts, epoch, locked_until, (locked_until IS NOT NULL AND locked_until > now()) AS locked FROM public.meeting_passcode_attempts WHERE meeting_id=$1 FOR UPDATE', [id])).rows[0];
    const ev = async (c, id, kind, actor, reason) => {
        await c.query('INSERT INTO public.meeting_passcode_events(meeting_id, kind, actor, reason) VALUES ($1,$2,$3,$4)', [id, kind, actor || null, reason || null]);
        await c.query('DELETE FROM public.meeting_passcode_events WHERE meeting_id=$1 AND kind IN (\'clear_rejected\') AND id NOT IN (SELECT id FROM public.meeting_passcode_events WHERE meeting_id=$1 AND kind=\'clear_rejected\' ORDER BY id DESC LIMIT 100)', [id]);
    };
    const resetEpoch = async (c, id) => { await c.query('UPDATE public.meeting_passcode_attempts SET epoch = epoch + 1 WHERE meeting_id=$1', [id]); await c.query('DELETE FROM public.meeting_passcode_reservations WHERE meeting_id=$1', [id]); };
    return {
        kind: 'postgres',
        reserve: (id) => run(id, async (c) => {
            const r = await row(c, id);
            if (r.locked) return { allowed: false, locked: true, lockedUntil: r.locked_until.toISOString() };
            let failed = r.failed_attempts;
            if (r.locked_until) { await c.query('UPDATE public.meeting_passcode_attempts SET failed_attempts=0, locked_until=NULL, updated_at=now() WHERE meeting_id=$1', [id]); await resetEpoch(c, id); failed = 0; }
            if (failed >= MAX_FAILURES) return { allowed: false, locked: false, busy: true };
            const epoch = r.locked_until ? r.epoch + 1 : r.epoch; const attemptId = crypto.randomUUID();
            await c.query("DELETE FROM public.meeting_passcode_reservations WHERE created_at < now() - interval '1 day'");
            await c.query('INSERT INTO public.meeting_passcode_reservations(attempt_id, meeting_id, epoch) VALUES ($1,$2,$3)', [attemptId, id, epoch]);
            await c.query('UPDATE public.meeting_passcode_attempts SET failed_attempts=$2, updated_at=now() WHERE meeting_id=$1', [id, failed + 1]);
            return { allowed: true, attemptId };
        }),
        release: (id, attemptId) => run(id, async (c) => {
            const r = await row(c, id);
            const d = await c.query('DELETE FROM public.meeting_passcode_reservations WHERE attempt_id=$1 AND meeting_id=$2 RETURNING epoch', [attemptId, id]);
            if (!d.rowCount) return { released: false };                              // unknown / settled / already released
            if (Number(d.rows[0].epoch) !== Number(r.epoch)) return { released: false };   // predates a reset or lock
            if (r.failed_attempts > 0) await c.query('UPDATE public.meeting_passcode_attempts SET failed_attempts = failed_attempts - 1, updated_at=now() WHERE meeting_id=$1', [id]);
            return { released: true };
        }),
        settleSuccess: (id, attemptId) => run(id, async (c) => {
            const r = await row(c, id); await c.query('DELETE FROM public.meeting_passcode_reservations WHERE attempt_id=$1', [attemptId]);
            if (r.locked) return { ok: false, locked: true, lockedUntil: r.locked_until.toISOString() };
            await c.query('UPDATE public.meeting_passcode_attempts SET failed_attempts=0, updated_at=now() WHERE meeting_id=$1', [id]); await resetEpoch(c, id); return { ok: true };
        }),
        settleFailure: (id, client, attemptId) => run(id, async (c) => {
            const r = await row(c, id); await c.query('DELETE FROM public.meeting_passcode_reservations WHERE attempt_id=$1', [attemptId]);
            if (r.locked) return { locked: true, newlyLocked: false, lockedUntil: r.locked_until.toISOString(), remaining: 0 };
            if (r.failed_attempts >= MAX_FAILURES) {
                const u = await c.query("UPDATE public.meeting_passcode_attempts SET failed_attempts=0, locked_until=now() + ($2 || ' milliseconds')::interval, updated_at=now() WHERE meeting_id=$1 RETURNING locked_until", [id, String(LOCK_MS)]);
                await resetEpoch(c, id); await ev(c, id, 'locked', client); return { locked: true, newlyLocked: true, lockedUntil: u.rows[0].locked_until.toISOString(), remaining: 0 };
            }
            return { locked: false, newlyLocked: false, lockedUntil: null, remaining: MAX_FAILURES - r.failed_attempts };
        }),
        status: (id) => run(id, async (c) => {
            const r = await row(c, id); const e = (await c.query('SELECT kind, actor, reason, at FROM public.meeting_passcode_events WHERE meeting_id=$1 ORDER BY id DESC LIMIT 20', [id])).rows;
            return { locked: r.locked, lockedUntil: r.locked ? r.locked_until.toISOString() : null, failed: r.failed_attempts, events: e.map((x) => ({ at: x.at.toISOString(), kind: x.kind, actor: x.actor, ...(x.reason ? { reason: x.reason } : {}) })) };
        }),
        /** Atomic: the counter row is locked (FOR UPDATE), so concurrent recoveries serialise; allowance check, clear and event are one transaction. */
        clearLockLimited: (id, actor, max = CLEAR_MAX, windowMs = CLEAR_WINDOW_MS) => run(id, async (c) => {
            const r = await row(c, id);
            const q = await c.query("SELECT count(*)::int AS n, min(at) AS oldest FROM public.meeting_passcode_events WHERE meeting_id=$1 AND kind='cleared_by_host' AND actor=$2 AND at > now() - ($3 || ' milliseconds')::interval", [id, actor, String(windowMs)]);
            if (q.rows[0].n >= max) { await ev(c, id, 'clear_rejected', actor, 'rate_limited'); return { ok: false, reason: 'rate_limited', retryAfterMs: windowMs }; }
            await c.query('UPDATE public.meeting_passcode_attempts SET failed_attempts=0, locked_until=NULL, updated_at=now() WHERE meeting_id=$1', [id]); await resetEpoch(c, id);
            await ev(c, id, 'cleared_by_host', actor); return { ok: true, wasLocked: r.locked };
        }),
        audit: (id, kind, actor, reason) => run(id, async (c) => { await ev(c, id, kind, actor, reason); return { recorded: true }; })
    };
}

// ----------------------------------------------------------------------------------------------- shared policy service
/**
 * verify({ meetingId, check, clientKey }) -> { status: 'ok' | 'wrong' | 'locked' | 'busy' | 'rate_limited' | 'unavailable', lockedUntil?, newlyLocked?, remaining? }
 * `check` is the (costly) passcode comparison, called ONLY after the attempt has been durably reserved. A thrown comparison is an infrastructure
 * fault, not a wrong passcode: the reservation is released (when the store confirms it) and the request is refused as 'unavailable'.
 */
function createLockoutService({ store: backing, now = () => Date.now(), perClientMax = 10, perClientWindowMs = 10 * 60 * 1000, log = console }) {
    const clients = new Map();
    const timer = setInterval(() => { const t = now(); for (const [k, v] of clients) if (v.reset <= t) clients.delete(k); }, 60 * 1000); if (timer.unref) timer.unref();
    // Best-effort per-client brake in front of the durable meeting budget (in memory by design; the meeting-wide lock is the durable control).
    function clientAllowed(key) {
        const t = now(); let v = clients.get(key);
        if (!v || v.reset <= t) { v = { n: 0, reset: t + perClientWindowMs }; clients.set(key, v); }
        return ++v.n <= perClientMax;
    }
    return {
        store: backing,
        async verify({ meetingId, check, clientKey }) {
            if (!clientAllowed(String(clientKey || 'unknown') + '|' + meetingId)) return { status: 'rate_limited' };
            let r;
            try { r = await backing.reserve(meetingId); } catch (e) { log.error('[lockout] reserve failed (refusing):', e.message); return { status: 'unavailable' }; }
            if (!r.allowed) return r.locked ? { status: 'locked', lockedUntil: r.lockedUntil } : { status: 'busy' };
            let ok = false;
            try { ok = !!(await check()); }
            catch (e) {
                log.error('[lockout] passcode comparison faulted:', e.message);
                try { await backing.release(meetingId, r.attemptId); } catch (x) { log.error('[lockout] release failed (reservation stays counted):', x.message); }
                return { status: 'unavailable' };
            }
            try {
                if (ok) { const s = await backing.settleSuccess(meetingId, r.attemptId); return s.ok ? { status: 'ok' } : { status: 'locked', lockedUntil: s.lockedUntil }; }
                const f = await backing.settleFailure(meetingId, hash12(clientKey), r.attemptId);
                return f.locked ? { status: 'locked', lockedUntil: f.lockedUntil, newlyLocked: f.newlyLocked } : { status: 'wrong', remaining: f.remaining };
            } catch (e) { log.error('[lockout] settle failed (refusing):', e.message); return { status: 'unavailable' }; }   // the reservation stays counted
        },
        status: (id) => backing.status(id),
        clearLockLimited: (id, actor, max, windowMs) => backing.clearLockLimited(id, hash12(actor), max, windowMs),
        audit: (id, kind, actor, reason) => backing.audit(id, kind, actor ? hash12(actor) : null, reason)
    };
}

module.exports = { createFileLockoutStore, createPgLockoutStore, createLockoutService, MAX_FAILURES, LOCK_MS, CLEAR_MAX, CLEAR_WINDOW_MS, hash12 };
