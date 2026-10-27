'use strict';
/**
 * Meeting-passcode lockout (v4.6.1): ONE policy, two persistence adapters.
 *
 *   Policy   5 failed attempts per meeting -> locked for 10 minutes. A locked meeting refuses every attempt BEFORE the passcode is checked,
 *            including a correct one. Only an authorised host action (clearLock) lifts an active lock early; it never sees or changes the passcode.
 *   Design   "reserve -> verify -> settle". reserve() atomically counts the attempt BEFORE the costly hash check, so concurrent attempts (even from
 *            several processes) can never exceed the budget: the sixth in-flight attempt is refused without being verified. settleSuccess() resets
 *            the counter unless a lock became active meanwhile (then the attempt is refused); settleFailure() locks when the budget is spent.
 *   Adapters PostgreSQL (full stack: row-locked transactions, database clock) and an encrypted file store (standalone MAIN: exclusive cross-process
 *            lock directory + fsync'd atomic replace). Neither falls back to memory: any storage fault is "unavailable" and the join is refused.
 *
 *   Interface mapping to the proposal: check -> status(), recordFailure -> settleFailure(), clearAfterSuccess -> settleSuccess().
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const MAX_FAILURES = 5;
const LOCK_MS = 10 * 60 * 1000;
const EVENTS_KEPT = 50;
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
    const entry = (d, id) => (d.meetings[id] = d.meetings[id] || { failed: 0, lockedUntil: null, events: [], touched: now() });
    const lockedNow = (m) => !!(m.lockedUntil && Date.parse(m.lockedUntil) > now());
    const event = (m, kind, actor) => { m.events.unshift({ at: new Date(now()).toISOString(), kind, actor: actor || null }); m.events.length = Math.min(m.events.length, EVENTS_KEPT); };

    return {
        kind: 'file',
        async reserve(id) { return withLock(() => {
            const d = load(); const m = entry(d, id); m.touched = now();
            if (lockedNow(m)) { save(d); return { allowed: false, locked: true, lockedUntil: m.lockedUntil }; }
            if (m.lockedUntil) { m.lockedUntil = null; m.failed = 0; }             // expired lock: fresh budget
            if (m.failed >= MAX_FAILURES) { save(d); return { allowed: false, locked: false, busy: true }; }
            m.failed += 1; save(d); return { allowed: true };
        }); },
        async settleSuccess(id) { return withLock(() => {
            const d = load(); const m = entry(d, id);
            if (lockedNow(m)) { save(d); return { ok: false, locked: true, lockedUntil: m.lockedUntil }; }
            m.failed = 0; m.touched = now(); save(d); return { ok: true };
        }); },
        async settleFailure(id, client) { return withLock(() => {
            const d = load(); const m = entry(d, id); m.touched = now();
            if (lockedNow(m)) { save(d); return { locked: true, newlyLocked: false, lockedUntil: m.lockedUntil, remaining: 0 }; }
            if (m.failed >= MAX_FAILURES) { m.lockedUntil = new Date(now() + LOCK_MS).toISOString(); m.failed = 0; event(m, 'locked', client); save(d); return { locked: true, newlyLocked: true, lockedUntil: m.lockedUntil, remaining: 0 }; }
            save(d); return { locked: false, newlyLocked: false, lockedUntil: null, remaining: MAX_FAILURES - m.failed };
        }); },
        async status(id) { return withLock(() => { const d = load(); const m = d.meetings[id]; if (!m) return { locked: false, lockedUntil: null, failed: 0, events: [] }; return { locked: lockedNow(m), lockedUntil: lockedNow(m) ? m.lockedUntil : null, failed: m.failed, events: m.events.slice(0, 20) }; }); },
        async clearLock(id, actor) { return withLock(() => {
            const d = load(); const m = entry(d, id); const was = lockedNow(m); m.lockedUntil = null; m.failed = 0; event(m, 'cleared_by_host', actor); save(d); return { cleared: true, wasLocked: was };
        }); }
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
    const row = async (c, id) => (await c.query('SELECT failed_attempts, locked_until, (locked_until IS NOT NULL AND locked_until > now()) AS locked FROM public.meeting_passcode_attempts WHERE meeting_id=$1 FOR UPDATE', [id])).rows[0];
    const ev = (c, id, kind, actor) => c.query('INSERT INTO public.meeting_passcode_events(meeting_id, kind, actor) VALUES ($1,$2,$3)', [id, kind, actor || null]);
    return {
        kind: 'postgres',
        reserve: (id) => run(id, async (c) => {
            const r = await row(c, id);
            if (r.locked) return { allowed: false, locked: true, lockedUntil: r.locked_until.toISOString() };
            if (r.locked_until) await c.query('UPDATE public.meeting_passcode_attempts SET failed_attempts=0, locked_until=NULL, updated_at=now() WHERE meeting_id=$1', [id]);
            const failed = r.locked_until ? 0 : r.failed_attempts;
            if (failed >= MAX_FAILURES) return { allowed: false, locked: false, busy: true };
            await c.query('UPDATE public.meeting_passcode_attempts SET failed_attempts=$2, updated_at=now() WHERE meeting_id=$1', [id, failed + 1]);
            return { allowed: true };
        }),
        settleSuccess: (id) => run(id, async (c) => {
            const r = await row(c, id);
            if (r.locked) return { ok: false, locked: true, lockedUntil: r.locked_until.toISOString() };
            await c.query('UPDATE public.meeting_passcode_attempts SET failed_attempts=0, updated_at=now() WHERE meeting_id=$1', [id]); return { ok: true };
        }),
        settleFailure: (id, client) => run(id, async (c) => {
            const r = await row(c, id);
            if (r.locked) return { locked: true, newlyLocked: false, lockedUntil: r.locked_until.toISOString(), remaining: 0 };
            if (r.failed_attempts >= MAX_FAILURES) {
                const u = await c.query("UPDATE public.meeting_passcode_attempts SET failed_attempts=0, locked_until=now() + ($2 || ' milliseconds')::interval, updated_at=now() WHERE meeting_id=$1 RETURNING locked_until", [id, String(LOCK_MS)]);
                await ev(c, id, 'locked', client); return { locked: true, newlyLocked: true, lockedUntil: u.rows[0].locked_until.toISOString(), remaining: 0 };
            }
            return { locked: false, newlyLocked: false, lockedUntil: null, remaining: MAX_FAILURES - r.failed_attempts };
        }),
        status: (id) => run(id, async (c) => {
            const r = await row(c, id); const e = (await c.query('SELECT kind, actor, at FROM public.meeting_passcode_events WHERE meeting_id=$1 ORDER BY id DESC LIMIT 20', [id])).rows;
            return { locked: r.locked, lockedUntil: r.locked ? r.locked_until.toISOString() : null, failed: r.failed_attempts, events: e.map((x) => ({ at: x.at.toISOString(), kind: x.kind, actor: x.actor })) };
        }),
        clearLock: (id, actor) => run(id, async (c) => {
            const r = await row(c, id); await c.query('UPDATE public.meeting_passcode_attempts SET failed_attempts=0, locked_until=NULL, updated_at=now() WHERE meeting_id=$1', [id]);
            await ev(c, id, 'cleared_by_host', actor); return { cleared: true, wasLocked: r.locked };
        })
    };
}

// ----------------------------------------------------------------------------------------------- shared policy service
/**
 * verify({ meetingId, check, clientKey }) -> { status: 'ok' | 'wrong' | 'locked' | 'busy' | 'rate_limited' | 'unavailable', lockedUntil?, newlyLocked?, remaining? }
 * `check` is the (costly) passcode comparison, called ONLY after the attempt has been durably reserved.
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
            try { ok = !!(await check()); } catch (e) { ok = false; }
            try {
                if (ok) { const s = await backing.settleSuccess(meetingId); return s.ok ? { status: 'ok' } : { status: 'locked', lockedUntil: s.lockedUntil }; }
                const f = await backing.settleFailure(meetingId, hash12(clientKey));
                return f.locked ? { status: 'locked', lockedUntil: f.lockedUntil, newlyLocked: f.newlyLocked } : { status: 'wrong', remaining: f.remaining };
            } catch (e) { log.error('[lockout] settle failed (refusing):', e.message); return { status: 'unavailable' }; }   // the reservation stays counted
        },
        status: (id) => backing.status(id),
        clearLock: (id, actor) => backing.clearLock(id, hash12(actor))
    };
}

module.exports = { createFileLockoutStore, createPgLockoutStore, createLockoutService, MAX_FAILURES, LOCK_MS, hash12 };
