// Atomic quota reservations against a real PostgreSQL: concurrency across independent pools and OS processes,
// idempotency, late commits, renewal, writer/reader races, killed connections and lock timeouts.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createTestDb, newCustomer, seedSubscription, sleep, skip } from './helpers/db.js';
import { AccessService } from '../src/accessService.js';

const WORKER = fileURLToPath(new URL('./helpers/reserve-worker.mjs', import.meta.url));
const FEATURE = 'ai.meeting_summaries';        // basic: 3 per window, pro: unlimited
const settled = async (p, ms) => { let done = false; p.then(() => { done = true; }, () => { done = true; }); await sleep(ms); return done; };

describe('reservations (PostgreSQL)', { skip }, () => {
  let db, svc;
  before(async () => { db = await createTestDb(); svc = new AccessService({ pool: db.poolFor('runtime') }); });
  after(async () => { await db.drop(); });

  const basic = async (o = {}) => { const c = newCustomer(); await seedSubscription(db.owner, c, { plan: 'basic', ...o }); return c; };
  const metered = async (feature, limit, plan = 'pro') => {                     // a paid customer with a numeric limit via override
    const c = newCustomer(); await seedSubscription(db.owner, c, { plan });
    await db.owner.query(`INSERT INTO entitlement_overrides (customer_id, feature_key, value, reason, created_by, expires_at)
      VALUES ($1,$2,$3,'limit for test','t', now() + interval '1 day')`, [c, feature, JSON.stringify(limit)]);
    return c;
  };
  // Stress tests queue many reservations for ONE customer+feature on purpose, so they get a long lock budget.
  const instance = (o = {}) => new AccessService({ pool: db.poolFor('runtime', { max: 8 }), lockTimeoutMs: 30_000, statementTimeoutMs: 40_000, ...o });
  const rows = async (c, extra = '') => (await db.owner.query(`SELECT * FROM quota_reservations WHERE customer_id=$1 ${extra} ORDER BY reserved_at`, [c])).rows;
  const usage = async (c, feature = FEATURE) => Number((await db.owner.query(`SELECT COALESCE(sum(quantity),0) AS n FROM usage_events WHERE customer_id=$1 AND feature_key=$2`, [c, feature])).rows[0].n);
  const key = () => randomBytes(8).toString('hex');
  // Pin a reservation's expiry relative to NOW, from the owner connection: timing then does not depend on how fast the host created it.
  const expireIn = (c, ms, extra = '') => db.owner.query(`UPDATE quota_reservations SET expires_at = now() + make_interval(secs => $2::double precision) WHERE customer_id = $1 AND status = 'reserved' ${extra}`, [c, ms / 1000]);

  test('reserve -> commit records usage once; a second commit is a harmless replay; the limit boundary is exact', async () => {
    const c = await basic();
    const held = [];
    for (let i = 0; i < 3; i++) { const r = await svc.reserve(c, FEATURE, 1, { idempotencyKey: `s${i}` }); assert.equal(r.allowed, true); held.push(r.reservationId); }
    const over = await svc.reserve(c, FEATURE, 1, { idempotencyKey: 's3' });
    assert.equal(over.allowed, false); assert.equal(over.reason, 'limit_exceeded'); assert.equal(over.remaining, 0);
    assert.deepEqual(await svc.commitReservation(held[0], { customerId: c, metadata: { meeting: 'm1' } }), { ok: true, reservationId: held[0], late: false });
    assert.equal((await svc.commitReservation(held[0], { customerId: c })).replay, true);
    assert.equal(await usage(c), 1);
    assert.equal((await db.owner.query('SELECT metadata FROM usage_events WHERE reservation_id=$1', [held[0]])).rows[0].metadata.meeting, 'm1');
    assert.equal((await svc.reserve(c, FEATURE, 1, { idempotencyKey: 's4' })).allowed, false, 'committed usage + 2 held still fills the window');
  });

  test('a quantity larger than what remains is refused whole, not clipped', async () => {
    const c = await metered('ai.queries', 10);
    assert.equal((await svc.reserve(c, 'ai.queries', 11, { idempotencyKey: key() })).allowed, false);
    assert.equal((await svc.reserve(c, 'ai.queries', 10, { idempotencyKey: key() })).allowed, true);
    assert.equal((await svc.reserve(c, 'ai.queries', 1, { idempotencyKey: key() })).allowed, false);
  });

  test('60 concurrent reservations from 4 independent instances for a limit of 3: exactly 3 succeed, nothing errors', async () => {
    const c = await basic();
    const instances = Array.from({ length: 4 }, () => instance());
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => instances[i % 4].reserve(c, FEATURE, 1, { idempotencyKey: `race-${i}` })));
    assert.equal(results.filter((r) => r.allowed).length, 3);
    assert.equal(results.filter((r) => r.reason === 'limit_exceeded').length, 57);
    assert.equal((await rows(c, `AND status='reserved'`)).length, 3);
  });

  test('100 concurrent reserve/commit cycles against a limit of 25: usage never exceeds the limit', async () => {
    const c = await metered('ai.queries', 25);
    const instances = Array.from({ length: 5 }, () => instance());
    const outcomes = await Promise.all(Array.from({ length: 100 }, async (_, i) => {
      const s = instances[i % 5];
      const r = await s.reserve(c, 'ai.queries', 1, { idempotencyKey: `cyc-${i}` });
      if (!r.allowed) return 'denied';
      await sleep(Math.random() * 30);
      if (i % 4 === 0) { await s.releaseReservation(r.reservationId, { customerId: c }); return 'released'; }
      await s.commitReservation(r.reservationId, { customerId: c });
      return 'committed';
    }));
    const committed = outcomes.filter((o) => o === 'committed').length;
    assert.equal(await usage(c, 'ai.queries'), committed);
    assert.ok(committed <= 25, `committed ${committed}`);
    assert.equal((await rows(c, `AND status='reserved'`)).length, 0, 'nothing left holding quota');
  });

  test('real multi-process concurrency: 4 OS processes x 25 attempts against a limit of 10 -> exactly 10 reservations exist', async () => {
    const c = await metered('ai.queries', 10);
    const run = (n) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [WORKER, db.url('runtime', `proc${n}`), c, 'ai.queries', '25', `p${n}`], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = ''; p.stdout.on('data', (d) => { out += d; });
      p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error('worker exit ' + code))));
    });
    const results = await Promise.all([1, 2, 3, 4].map(run));
    assert.equal(results.reduce((a, r) => a + r.allowed, 0), 10);
    assert.equal(results.reduce((a, r) => a + r.errors, 0), 0);
    assert.equal((await rows(c)).length, 10);
  });

  test('idempotency: the same key sent 20 times at once creates ONE reservation and every caller gets it', async () => {
    const c = await basic();
    const instances = Array.from({ length: 4 }, () => instance());
    const k = key();
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => instances[i % 4].reserve(c, FEATURE, 1, { idempotencyKey: k })));
    assert.equal(new Set(rs.map((r) => r.reservationId)).size, 1);
    assert.equal(rs.every((r) => r.allowed), true);
    assert.equal(rs.filter((r) => !r.replay).length, 1, 'exactly one caller created it');
    assert.equal((await rows(c)).length, 1);
  });

  test('idempotency holds in every state: retry after commit replays, retry after release says so, and a changed request is a conflict', async () => {
    const c = await basic();
    const a = await svc.reserve(c, FEATURE, 1, { idempotencyKey: 'ia' });
    await svc.commitReservation(a.reservationId, { customerId: c });
    const again = await svc.reserve(c, FEATURE, 1, { idempotencyKey: 'ia' });
    assert.equal(again.replay, true); assert.equal(again.status, 'committed'); assert.equal(again.allowed, true); assert.equal(again.reservationId, a.reservationId);
    assert.equal(await usage(c), 1, 'the retry consumed nothing');
    assert.equal((await rows(c)).length, 1);

    const b = await svc.reserve(c, FEATURE, 1, { idempotencyKey: 'ib' });
    await svc.releaseReservation(b.reservationId, { customerId: c });
    const r = await svc.reserve(c, FEATURE, 1, { idempotencyKey: 'ib' });
    assert.equal(r.allowed, false); assert.equal(r.reason, 'reservation_released'); assert.equal(r.replay, true);

    await assert.rejects(svc.reserve(c, FEATURE, 2, { idempotencyKey: 'ia' }), { code: 'idempotency_key_conflict', statusCode: 409 });
  });

  test('idempotency is checked BEFORE denial: a retry of a successful request is never turned into a limit error', async () => {
    const c = await basic();
    const first = await svc.reserve(c, FEATURE, 1, { idempotencyKey: 'first' });
    await svc.reserve(c, FEATURE, 1, { idempotencyKey: 'x2' }); await svc.reserve(c, FEATURE, 1, { idempotencyKey: 'x3' });
    assert.equal((await svc.reserve(c, FEATURE, 1, { idempotencyKey: 'x4' })).allowed, false, 'window is full');
    const retry = await svc.reserve(c, FEATURE, 1, { idempotencyKey: 'first' });
    assert.equal(retry.allowed, true); assert.equal(retry.reservationId, first.reservationId);
  });

  test('keys are scoped to customer and feature; invalid keys and invalid targets are rejected before touching quota', async () => {
    const [c1, c2] = [await basic(), await basic()];
    assert.equal((await svc.reserve(c1, FEATURE, 1, { idempotencyKey: 'same' })).allowed, true);
    assert.equal((await svc.reserve(c2, FEATURE, 1, { idempotencyKey: 'same' })).replay, undefined, 'other customer, same key: independent');
    assert.equal((await svc.reserve(c1, 'ai.queries', 1, { idempotencyKey: 'same' })).replay, undefined, 'other feature, same key: independent');
    for (const bad of [undefined, '', 5, null, 'x'.repeat(201)]) await assert.rejects(svc.reserve(c1, FEATURE, 1, { idempotencyKey: bad }), { code: 'invalid_idempotency_key' });
    await assert.rejects(svc.reserve(c1, 'meetings.cloud_recording', 1, { idempotencyKey: key() }), { code: 'not_consumption_feature' });
    await assert.rejects(svc.reserve(c1, 'meetings.participants', 1, { idempotencyKey: key() }), { code: 'not_consumption_feature' });
    await assert.rejects(svc.reserve(c1, FEATURE, 1, { idempotencyKey: key(), soft: true }), { code: 'soft_quota_disabled' });
    await assert.rejects(svc.reserve(c1, FEATURE, 0, { idempotencyKey: key() }), { code: 'invalid_quantity' });
  });

  test('release frees quota at once; commit and release are final in the right ways', async () => {
    const c = await basic();
    const held = [];
    for (let i = 0; i < 3; i++) held.push((await svc.reserve(c, FEATURE, 1, { idempotencyKey: `r${i}` })).reservationId);
    assert.equal((await svc.reserve(c, FEATURE, 1, { idempotencyKey: 'rx' })).allowed, false);
    assert.deepEqual(await svc.releaseReservation(held[0], { customerId: c }), { ok: true });
    assert.equal((await svc.releaseReservation(held[0], { customerId: c })).replay, true);
    assert.equal((await svc.reserve(c, FEATURE, 1, { idempotencyKey: 'ry' })).allowed, true);
    assert.deepEqual(await svc.commitReservation(held[0], { customerId: c }), { ok: false, reason: 'reservation_released' });
    await svc.commitReservation(held[1], { customerId: c });
    assert.deepEqual(await svc.releaseReservation(held[1], { customerId: c }), { ok: false, reason: 'already_committed' });
    assert.equal(await usage(c), 1);
  });

  test('cross-tenant: another customer can neither commit, release nor renew your reservation, and it is recorded', async () => {
    const [owner, thief] = [await basic(), await basic()];
    const r = await svc.reserve(owner, FEATURE, 1, { idempotencyKey: 'mine' });
    for (const attempt of [() => svc.commitReservation(r.reservationId, { customerId: thief }), () => svc.releaseReservation(r.reservationId, { customerId: thief }),
      () => svc.renewReservation(r.reservationId, { customerId: thief })]) {
      assert.deepEqual(await attempt(), { ok: false, reason: 'reservation_not_found' }, 'same answer as a reservation that does not exist');
    }
    assert.deepEqual(await svc.commitReservation('00000000-0000-4000-8000-000000000000', { customerId: thief }), { ok: false, reason: 'reservation_not_found' });
    assert.deepEqual(await svc.commitReservation('not-a-uuid', { customerId: thief }), { ok: false, reason: 'reservation_not_found' });
    const ev = (await db.owner.query(`SELECT details FROM security_events WHERE event_type='reservation_cross_tenant_attempt' AND customer_id=$1`, [thief])).rows;
    assert.equal(ev.length, 3);
    assert.equal(ev[0].details.reservationId, r.reservationId);
    assert.equal((await rows(owner))[0].status, 'reserved', 'untouched');
    assert.equal(await usage(owner), 0);
    await assert.rejects(svc.commitReservation(r.reservationId, {}), { code: 'customer_context_invalid' });
    await assert.rejects(svc.commitReservation(r.reservationId, { customerId: 'attacker' }), { code: 'customer_context_invalid' });
    assert.equal((await svc.commitReservation(r.reservationId, { customerId: owner })).ok, true);
  });

  test('timed-out reservations stop holding quota on the database clock; a LATE commit still records the work done', async () => {
    const c = await basic();
    const held = [];
    for (let i = 0; i < 3; i++) held.push((await svc.reserve(c, FEATURE, 1, { idempotencyKey: `t${i}` })).reservationId);
    await expireIn(c, 2500);                                                                                // all three time out 2.5 s from now
    assert.equal((await svc.reserve(c, FEATURE, 1, { idempotencyKey: 'tx' })).allowed, false, 'still holding quota before the deadline');
    await sleep(2800);
    assert.equal((await svc.reserve(c, FEATURE, 1, { idempotencyKey: 'ty' })).allowed, true, 'time ran out: quota is free again');
    const late = await svc.commitReservation(held[0], { customerId: c });
    assert.deepEqual(late, { ok: true, reservationId: held[0], late: true });
    assert.equal(await usage(c), 1, 'the usage was NOT dropped');
    const row = (await rows(c)).find((x) => x.id === held[0]);
    assert.equal(row.status, 'committed'); assert.equal(row.late, true);
    assert.equal((await db.owner.query(`SELECT count(*)::int n FROM security_events WHERE event_type='late_commit' AND customer_id=$1`, [c])).rows[0].n, 1);
    assert.equal((await svc.reserve(c, FEATURE, 1, { idempotencyKey: 'tz' })).allowed, true);
    assert.equal((await svc.reserve(c, FEATURE, 1, { idempotencyKey: 'tw' })).allowed, false, 'the late usage counts against the window');
  });

  test('the sweeper marks timed-out reservations expired, is idempotent, and a swept reservation can still be committed late', async () => {
    const c = await basic();
    const a = await svc.reserve(c, FEATURE, 1, { idempotencyKey: 'sw1' });
    const keep = await svc.reserve(c, FEATURE, 1, { idempotencyKey: 'sw2' });
    await expireIn(c, 1000, `AND id = '${a.reservationId}'`);
    await sleep(1300);
    const first = await svc.sweepExpiredReservations();
    assert.ok(first.expired >= 1);
    assert.equal((await svc.sweepExpiredReservations()).expired, 0, 'a second sweep finds nothing left');
    assert.equal((await rows(c)).find((x) => x.id === a.reservationId).status, 'expired');
    assert.equal((await rows(c)).find((x) => x.id === keep.reservationId).status, 'reserved');
    assert.equal((await svc.reserve(c, FEATURE, 1, { idempotencyKey: 'sw1' })).reason, 'reservation_expired', 'replay of an expired key says so');
    assert.equal((await svc.commitReservation(a.reservationId, { customerId: c })).late, true);
    assert.equal((await svc.releaseReservation(a.reservationId, { customerId: c })).ok, false, 'committed is final');
  });

  test('sweepers on several instances never double-process (SKIP LOCKED)', async () => {
    const c = await metered('ai.queries', 1000);
    for (let i = 0; i < 40; i++) await svc.reserve(c, 'ai.queries', 1, { idempotencyKey: `m${i}`, ttlMs: 1000 });
    await sleep(1300);
    const total = (await Promise.all(Array.from({ length: 4 }, () => instance().sweepExpiredReservations({ limit: 15 })))).reduce((a, r) => a + r.expired, 0);
    assert.ok(total <= 40);
    await instance().sweepExpiredReservations({ limit: 100 });
    assert.equal((await rows(c, `AND status='reserved'`)).length, 0);
    assert.equal((await rows(c, `AND status='expired'`)).length, 40);
  });

  test('renewal keeps a long job alive, is bounded by the maximum lifetime, and refuses expired or finished reservations', async () => {
    const short = instance({ maxReservationLifetimeMs: 6000 });
    const c = await basic();
    const r = await short.reserve(c, FEATURE, 1, { idempotencyKey: 'rn', ttlMs: 2000 });
    const rn = await short.renewReservation(r.reservationId, { customerId: c, extendMs: 60_000 });
    assert.equal(rn.ok, true); assert.equal(rn.at_maximum, true, 'clamped to the 6 s maximum, not 60 s');
    await sleep(2600);                                                                                       // past the ORIGINAL 2 s expiry, inside the renewed one
    assert.equal((await short.commitReservation(r.reservationId, { customerId: c })).late, false, 'renewed: not late');

    const gone = await short.reserve(c, FEATURE, 1, { idempotencyKey: 'rn2', ttlMs: 1000 });
    await sleep(1300);
    assert.deepEqual(await short.renewReservation(gone.reservationId, { customerId: c }), { ok: false, reason: 'reservation_expired' });
    assert.deepEqual(await short.renewReservation(r.reservationId, { customerId: c }), { ok: false, reason: 'reservation_committed' });
    assert.equal((await rows(c)).find((x) => x.id === r.reservationId).renewed_count, 1);
  });

  test('unlimited plans hold nothing; a lapsed subscription is metered against Basic in the UTC month window', async () => {
    const pro = newCustomer(); await seedSubscription(db.owner, pro, { plan: 'pro' });
    const u = await svc.reserve(pro, FEATURE, 5, { idempotencyKey: key() });
    assert.equal(u.allowed, true); assert.equal(u.reservationId, null); assert.equal(u.held, false);
    assert.equal((await rows(pro)).length, 0);

    const lapsed = newCustomer(); await seedSubscription(db.owner, lapsed, { plan: 'pro', status: 'paused' });
    const r = await svc.reserve(lapsed, FEATURE, 1, { idempotencyKey: key() });
    assert.equal(r.allowed, true); assert.equal(r.plan, 'basic'); assert.equal(r.limit, 3);
    const row = (await rows(lapsed))[0];
    const now = new Date();
    assert.equal(new Date(row.period_start).toISOString(), new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString());
  });

  test('a paid customer reserves inside their own billing period', async () => {
    const c = await metered('ai.queries', 5);
    const sub = (await db.owner.query('SELECT current_period_start s, current_period_end e FROM subscriptions WHERE customer_id=$1', [c])).rows[0];
    await svc.reserve(c, 'ai.queries', 1, { idempotencyKey: key() });
    const row = (await rows(c))[0];
    assert.equal(new Date(row.period_start).getTime(), new Date(sub.s).getTime());
    assert.equal(new Date(row.period_end).getTime(), new Date(sub.e).getTime());
  });

  test('a downgrade committed BEFORE the reservation takes the lock is honoured: the reservation waits, then sees the new plan', async () => {
    const c = newCustomer(); await seedSubscription(db.owner, c, { plan: 'pro' });                        // templates: pro 8, basic 0
    const w = await db.owner.connect();
    try {
      await w.query('BEGIN');
      await w.query(`UPDATE subscriptions SET plan_code='basic' WHERE customer_id=$1`, [c]);               // trigger takes the exclusive lock
      const pending = svc.reserve(c, 'ai.custom_summary_templates', 1, { idempotencyKey: key() });
      assert.equal(await settled(pending, 500), false, 'the reservation is waiting for the writer');
      await w.query('COMMIT');
      const r = await pending;
      assert.equal(r.allowed, false, 'it decided on the NEW plan, not the one it could have read earlier');
      assert.equal(r.plan, 'basic');
    } finally { w.release(); }
  });

  test('...and a writer waits for an in-flight reservation, so nothing interleaves (also for overrides and manual SQL)', async () => {
    const c = newCustomer(); await seedSubscription(db.owner, c, { plan: 'pro' });
    const holder = await db.owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`, [`sub:${c}`]);     // what a reservation holds
      const downgrade = db.owner.query(`UPDATE subscriptions SET plan_code='basic' WHERE customer_id=$1`, [c]);
      const grant = db.owner.query(`INSERT INTO entitlement_overrides (customer_id, feature_key, value, reason, created_by) VALUES ($1,'meetings.participants','500','test','t')`, [c]);
      assert.equal(await settled(downgrade, 400), false, 'plan change waits');
      assert.equal(await settled(grant, 10), false, 'override change waits');
      await holder.query('COMMIT');
      await Promise.all([downgrade, grant]);
      assert.equal((await db.owner.query('SELECT plan_code FROM subscriptions WHERE customer_id=$1', [c])).rows[0].plan_code, 'basic');
    } finally { holder.release(); }
  });

  test('readers never block each other: while one reservation holds the shared customer lock, reservations for other features still complete', async () => {
    const c = await metered('ai.queries', 1000);
    const holder = await db.owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`, [`sub:${c}`]);      // a slow in-flight reservation
      const instances = Array.from({ length: 3 }, () => instance());
      const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => instances[i % 3].reserve(c, i % 2 ? 'ai.queries' : 'clips.custom_avatars_minutes', 1, { idempotencyKey: `p${i}` })));
      assert.equal(rs.filter((r) => r.allowed && r.reservationId).length, 15 + 3, '15 queries + the 3 avatar minutes pro allows');
    } finally { await holder.query('ROLLBACK'); holder.release(); }
  });

  test('FAILOVER: a connection killed mid-reservation fails closed, leaves nothing behind, and the pool recovers', async () => {
    const app = 'fo_' + randomBytes(4).toString('hex');
    const fo = new AccessService({ pool: db.poolFor('runtime', { max: 3, app }) });
    const c = await basic();
    const blocker = await db.owner.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`quota:${c}:${FEATURE}`]);   // the reservation will wait here
      const pending = fo.reserve(c, FEATURE, 1, { idempotencyKey: 'killme' });
      let pid = null;
      for (let i = 0; i < 40 && !pid; i++) {
        await sleep(50);
        pid = (await db.owner.query(`SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'`, [app])).rows[0]?.pid;
      }
      assert.ok(pid, 'found the waiting backend');
      await db.owner.query('SELECT pg_terminate_backend($1)', [pid]);
      await assert.rejects(pending, { code: 'access_unavailable', statusCode: 503 });
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    assert.equal((await rows(c)).length, 0, 'no partial reservation');
    const after = await fo.reserve(c, FEATURE, 1, { idempotencyKey: 'killme' });
    assert.equal(after.allowed, true, 'the same retry now succeeds on a fresh connection');
    assert.equal((await rows(c)).length, 1);
  });

  test('lock timeout: a stuck lock holder cannot hang requests; they fail closed quickly and recover afterwards', async () => {
    const quick = instance({ lockTimeoutMs: 400 });
    const c = await basic();
    const blocker = await db.owner.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`quota:${c}:${FEATURE}`]);
      const t0 = Date.now();
      await assert.rejects(quick.reserve(c, FEATURE, 1, { idempotencyKey: 'lt' }), { code: 'access_unavailable' });
      assert.ok(Date.now() - t0 < 2500, `gave up after ${Date.now() - t0} ms`);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    assert.equal((await quick.reserve(c, FEATURE, 1, { idempotencyKey: 'lt' })).allowed, true);
  });

  test('invariant after a mixed storm: usage + live holds never exceeds the limit, and every committed reservation has exactly one usage row', async () => {
    const c = await metered('ai.queries', 40);
    const instances = Array.from({ length: 4 }, () => instance());
    await Promise.all(Array.from({ length: 160 }, async (_, i) => {
      const s = instances[i % 4];
      const r = await s.reserve(c, 'ai.queries', 1 + (i % 3), { idempotencyKey: `storm-${i}` }).catch(() => ({ allowed: false }));
      if (!r.allowed) return;
      const roll = i % 5;
      if (roll === 0) await s.releaseReservation(r.reservationId, { customerId: c });
      else if (roll !== 1) await s.commitReservation(r.reservationId, { customerId: c });             // roll 1 stays held
    }));
    const used = await usage(c, 'ai.queries');
    const held = Number((await db.owner.query(`SELECT COALESCE(sum(quantity),0) n FROM quota_reservations WHERE customer_id=$1 AND status='reserved'`, [c])).rows[0].n);
    assert.ok(used + held <= 40, `used ${used} + held ${held}`);
    const dup = await db.owner.query(`SELECT reservation_id FROM usage_events WHERE customer_id=$1 GROUP BY reservation_id HAVING count(*) > 1`, [c]);
    assert.equal(dup.rowCount, 0);
    const orphan = await db.owner.query(`SELECT 1 FROM quota_reservations r WHERE customer_id=$1 AND status='committed' AND NOT EXISTS (SELECT 1 FROM usage_events u WHERE u.reservation_id=r.id)`, [c]);
    assert.equal(orphan.rowCount, 0);
  });
});
