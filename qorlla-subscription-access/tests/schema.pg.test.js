// Schema, migrations, constraints, immutability and the least-privilege role matrix, on a real PostgreSQL.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, newCustomer, seedSubscription, skip } from './helpers/db.js';
import { migrate } from '../src/migrate.js';
import { seedCatalog, verifyCatalog } from '../src/seed.js';

const SCHEMA = fileURLToPath(new URL('../schema', import.meta.url));

describe('migrations (PostgreSQL)', { skip }, () => {
  let blank, dir;
  before(async () => { blank = await createTestDb({ migrateAndSeed: false }); dir = await mkdtemp(join(tmpdir(), 'subacc-mig-')); await cp(SCHEMA, dir, { recursive: true }); });
  after(async () => { await blank.drop(); await rm(dir, { recursive: true, force: true }); });

  test('four parallel runners on an empty database apply every file exactly once', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => migrate({ pool: blank.owner, dir })));
    const all = results.flat();
    assert.deepEqual([...all].sort(), ['001_subscriptions.sql', '002_hardening.sql', '003_billing.sql', '004_roles_and_grants.sql', '005_directory.sql', '006_stepup.sql', '007_ops.sql', '008_unified_billing.sql']);
    assert.equal((await blank.owner.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 8);
  });

  test('running again applies nothing (idempotent)', async () => {
    assert.deepEqual(await migrate({ pool: blank.owner, dir }), []);
  });

  test('editing an applied migration is refused', async () => {
    await appendFile(join(dir, '001_subscriptions.sql'), '\n-- sneaky edit\n');
    await assert.rejects(migrate({ pool: blank.owner, dir }), /001_subscriptions\.sql was changed after it was applied/);
    await cp(join(SCHEMA, '001_subscriptions.sql'), join(dir, '001_subscriptions.sql'));
    assert.deepEqual(await migrate({ pool: blank.owner, dir }), []);
  });

  test('a failing migration is rolled back completely and is not recorded; fixing it lets the run continue', async () => {
    await writeFile(join(dir, '099_broken.sql'), 'CREATE TABLE zz_half_done (a int);\nINSERT INTO zz_half_done VALUES (1);\nSELECT 1/0;\n');
    await assert.rejects(migrate({ pool: blank.owner, dir }), /099_broken\.sql failed and was rolled back/);
    assert.equal((await blank.owner.query(`SELECT to_regclass('zz_half_done') AS t`)).rows[0].t, null, 'nothing half-applied');
    assert.equal((await blank.owner.query(`SELECT count(*)::int n FROM schema_migrations WHERE version='099_broken.sql'`)).rows[0].n, 0);
    await writeFile(join(dir, '099_broken.sql'), 'CREATE TABLE zz_fixed (a int);\n');
    assert.deepEqual(await migrate({ pool: blank.owner, dir }), ['099_broken.sql']);
  });

  test('files that do not follow the naming rule are ignored, not executed', async () => {
    await writeFile(join(dir, 'evil.sql'), 'DROP TABLE subscriptions;');
    await writeFile(join(dir, '9_oops.sql'), 'DROP TABLE subscriptions;');
    assert.deepEqual(await migrate({ pool: blank.owner, dir }), []);
    assert.equal((await blank.owner.query(`SELECT to_regclass('subscriptions') IS NOT NULL AS ok`)).rows[0].ok, true);
  });
});

describe('schema integrity, immutability and roles (PostgreSQL)', { skip }, () => {
  let db, c, resv;
  before(async () => {
    db = await createTestDb();
    c = newCustomer();
    await seedSubscription(db.owner, c, { plan: 'pro' });
    resv = (await db.owner.query(`INSERT INTO quota_reservations (customer_id, feature_key, quantity, expires_at, max_expires_at, period_start, period_end, idempotency_key)
      VALUES ($1,'ai.queries',1, now()+interval '1 hour', now()+interval '1 hour', now(), now()+interval '1 day','seed') RETURNING id`, [c])).rows[0].id;
  });
  after(async () => { await db.drop(); });

  const fails = (sql, args, match) => assert.rejects(db.owner.query(sql, args), match);

  test('subscription constraints: period order, provider pairing, status, quantity, revision, unique customer', async () => {
    const ins = (cols, vals) => db.owner.query(`INSERT INTO subscriptions (customer_id, plan_code, current_period_start, current_period_end ${cols}) VALUES ($1,'pro', now(), now()+interval '1 day' ${vals})`, [newCustomer()]);
    await ins('', '');
    await fails(`INSERT INTO subscriptions (customer_id, plan_code, current_period_start, current_period_end) VALUES ($1,'pro', now(), now())`, [newCustomer()], { code: '23514' });
    await fails(`INSERT INTO subscriptions (customer_id, plan_code, current_period_start, current_period_end) VALUES ($1,'pro', now(), now()-interval '1 day')`, [newCustomer()], { code: '23514' });
    await assert.rejects(ins(', provider', ", 'acme'"), { code: '23514' }, 'provider without external id');
    await assert.rejects(ins(', external_id', ", 'sub_x'"), { code: '23514' }, 'external id without provider');
    await assert.rejects(ins(', status', ", 'zombie'"), { code: '23514' });
    await assert.rejects(ins(', quantity', ', 0'), { code: '23514' });
    await assert.rejects(ins(', provider_revision', ', -1'), { code: '23514' });
    await fails(`INSERT INTO subscriptions (customer_id, plan_code, current_period_start, current_period_end) VALUES ($1,'platinum', now(), now()+interval '1 day')`, [newCustomer()], { code: '23503' });
    await fails(`INSERT INTO subscriptions (customer_id, plan_code, current_period_start, current_period_end) VALUES ($1,'pro', now(), now()+interval '1 day')`, [c], { code: '23505' });
  });

  test('override constraints: a reason is mandatory and values must be a boolean, a 0-999999999 integer or "unlimited"', async () => {
    const put = (feature, value, reason = 'because') => db.owner.query(
      `INSERT INTO entitlement_overrides (customer_id, feature_key, value, reason, created_by) VALUES ($1,$2,$3,$4,'t') ON CONFLICT (customer_id, feature_key) DO UPDATE SET value=EXCLUDED.value`,
      [c, feature, JSON.stringify(value), reason]);
    for (const [f, v] of [['meetings.cloud_recording', true], ['meetings.participants', 5], ['meetings.participants', 999_999_999], ['meetings.participants', 'unlimited']]) await put(f, v);
    for (const v of ['yes', 1.5, -1, 1_000_000_000, null, [], {}, 'Unlimited']) await assert.rejects(put('meetings.participants', v), { code: '23514' }, JSON.stringify(v));
    await assert.rejects(put('meetings.participants', 3, '  '), { code: '23514' });
    await assert.rejects(put('made.up', 3), { code: '23503' });
  });

  test('reservation constraints: idempotency key bounds and uniqueness in every state, quantity, window, committed pairing, expiry cap', async () => {
    const base = (o = {}) => {
      const v = { q: 1, key: 'k-' + Math.random(), expires: "now() + interval '1 hour'", max: "now() + interval '1 hour'", status: 'reserved', committed: 'NULL', pe: "now() + interval '1 day'", ...o };
      return db.owner.query(`INSERT INTO quota_reservations (customer_id, feature_key, quantity, status, expires_at, max_expires_at, committed_at, period_start, period_end, idempotency_key)
        VALUES ($1,'ai.queries',$2,$3, ${v.expires}, ${v.max}, ${v.committed}, now(), ${v.pe}, $4)`, [c, v.q, v.status, v.key]);
    };
    await base();
    await assert.rejects(base({ q: 0 }), { code: '23514' });
    await assert.rejects(base({ key: '' }), { code: '23514' });
    await assert.rejects(base({ key: 'x'.repeat(201) }), { code: '23514' });
    await assert.rejects(base({ expires: "now() - interval '1 hour'" }), { code: '23514' }, 'expires before it was reserved');
    await assert.rejects(base({ expires: "now() + interval '2 hours'" }), { code: '23514' }, 'beyond the maximum lifetime');
    await assert.rejects(base({ pe: "now() - interval '1 day'" }), { code: '23514' });
    await assert.rejects(base({ status: 'committed' }), { code: '23514' }, 'committed without committed_at');
    await assert.rejects(base({ committed: 'now()' }), { code: '23514' }, 'committed_at without committed status');
    await assert.rejects(base({ status: 'bogus' }), { code: '23514' });
    await base({ key: 'dup', status: 'released' });
    await assert.rejects(base({ key: 'dup' }), { code: '23505' }, 'the key is taken even though the first one is released');
  });

  test('one usage row per reservation, and a sane window', async () => {
    const use = (rid, end = "now() + interval '1 day'") => db.owner.query(`INSERT INTO usage_events (customer_id, feature_key, quantity, reservation_id, period_start, period_end) VALUES ($1,'ai.queries',1,$2, now(), ${end})`, [c, rid]);
    await use(resv);
    await assert.rejects(use(resv), { code: '23505' });
    await assert.rejects(use(null, "now() - interval '1 day'"), { code: '23514' });
    await use(null); await use(null);                                   // usage without a reservation (direct metering) is allowed
  });

  test('the audit and usage tables are append-only for EVERYONE, including a superuser owner: no UPDATE, DELETE or TRUNCATE', async () => {
    await db.owner.query(`INSERT INTO access_audit (customer_id, allowed) VALUES ($1, true)`, [c]);
    await db.owner.query(`INSERT INTO security_events (event_type, severity) VALUES ('probe','info')`);
    await db.owner.query(`INSERT INTO usage_events (customer_id, feature_key, quantity, period_start, period_end) VALUES ($1,'ai.queries',1, now(), now()+interval '1 day')`, [c]);
    await db.owner.query(`INSERT INTO entitlement_override_history (customer_id, feature_key, action, new_value, reason, actor) VALUES ($1,'meetings.participants','set','5','probe','a')`, [c]);   // row triggers need a row to fire on
    for (const t of ['access_audit', 'security_events', 'usage_events', 'entitlement_override_history']) {
      await fails(`UPDATE ${t} SET ${t === 'security_events' ? 'event_type' : t === 'entitlement_override_history' ? 'actor' : t === 'usage_events' ? 'feature_key' : 'reason'} = 'tampered'`, [], /append-only/);
      await fails(`DELETE FROM ${t}`, [], /append-only/);
      await fails(`TRUNCATE ${t}`, [], /append-only/);
    }
  });

  test('updated_at moves on change', async () => {
    const x = newCustomer(); await seedSubscription(db.owner, x, {});
    const t0 = (await db.owner.query('SELECT updated_at FROM subscriptions WHERE customer_id=$1', [x])).rows[0].updated_at;
    await new Promise((r) => setTimeout(r, 20));
    await db.owner.query(`UPDATE subscriptions SET quantity = 2 WHERE customer_id=$1`, [x]);
    assert.ok((await db.owner.query('SELECT updated_at FROM subscriptions WHERE customer_id=$1', [x])).rows[0].updated_at > t0);
  });

  // ---- the role matrix ----------------------------------------------------
  const ROW = `'${'00000000-0000-4000-8000-000000000001'}'`;
  const INS_RES = `INSERT INTO quota_reservations (customer_id, feature_key, quantity, expires_at, max_expires_at, period_start, period_end, idempotency_key)
    VALUES (${ROW},'ai.queries',1, now()+interval '1 min', now()+interval '1 min', now(), now()+interval '1 day','m-'||random()::text)`;
  const MATRIX = {
    runtime: {
      allow: ['SELECT * FROM subscriptions', 'SELECT * FROM entitlement_overrides', 'SELECT * FROM plans', 'SELECT * FROM plan_entitlements', 'SELECT * FROM quota_reservations',
        `INSERT INTO access_audit (customer_id, allowed) VALUES (${ROW}, true)`, `INSERT INTO security_events (event_type, severity) VALUES ('t','info')`, INS_RES,
        `INSERT INTO usage_events (customer_id, feature_key, quantity, period_start, period_end) VALUES (${ROW},'ai.queries',1, now(), now()+interval '1 day')`,
        `UPDATE quota_reservations SET status='released'`, `UPDATE quota_reservations SET expires_at = expires_at, renewed_count = 1`],
      deny: ['INSERT INTO subscriptions (customer_id, plan_code, current_period_start, current_period_end) VALUES (gen_random_uuid(),\'pro\',now(),now()+interval \'1 day\')',
        `UPDATE subscriptions SET plan_code='enterprise'`, 'DELETE FROM subscriptions', `UPDATE subscriptions SET status='active'`,
        `INSERT INTO entitlement_overrides (customer_id, feature_key, value, reason, created_by) VALUES (${ROW},'meetings.participants','9','x','x')`,
        'UPDATE entitlement_overrides SET value = \'1\'', 'DELETE FROM entitlement_overrides',
        'UPDATE quota_reservations SET customer_id = customer_id', 'UPDATE quota_reservations SET quantity = quantity', 'UPDATE quota_reservations SET idempotency_key = idempotency_key', 'DELETE FROM quota_reservations',
        'UPDATE access_audit SET allowed = false', 'DELETE FROM access_audit', 'UPDATE usage_events SET quantity = 1', 'DELETE FROM usage_events', 'UPDATE security_events SET severity = \'info\'',
        'SELECT * FROM billing_inbox', 'SELECT * FROM billing_outbox', 'SELECT * FROM billing_customers', 'SELECT * FROM entitlement_override_history', 'SELECT * FROM schema_migrations',
        `INSERT INTO plans (code, display_name, rank) VALUES ('pro','x',99)`, `UPDATE plan_entitlements SET value='1'`, 'DELETE FROM features',
        'TRUNCATE subscriptions', 'TRUNCATE quota_reservations', 'DROP TABLE subscriptions', 'ALTER TABLE subscriptions ADD COLUMN z int', 'CREATE TABLE zz_intruder (a int)', 'DROP TRIGGER subscriptions_touch ON subscriptions',
        'CREATE ROLE zz_intruder_role', 'ALTER TABLE access_audit DISABLE TRIGGER ALL', 'CREATE OR REPLACE FUNCTION qorlla_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$'],
    },
    billing: {
      allow: ['SELECT * FROM subscriptions', 'SELECT * FROM plans', 'SELECT * FROM billing_customers', 'SELECT * FROM billing_inbox', 'SELECT * FROM billing_outbox',
        `UPDATE subscriptions SET quantity = quantity`, `INSERT INTO billing_inbox (provider, event_id, event_type, raw_sha256, payload) VALUES ('acme','m-'||random()::text,'t','x','{}')`,
        `INSERT INTO billing_outbox (dedupe_key, topic, payload) VALUES ('m-'||random()::text,'t','{}')`, `INSERT INTO security_events (event_type, severity) VALUES ('t','info')`,
        `INSERT INTO subscriptions (customer_id, plan_code, current_period_start, current_period_end) VALUES (gen_random_uuid(),'pro',now(),now()+interval '1 day')`],
      deny: ['SELECT * FROM entitlement_overrides', 'SELECT * FROM quota_reservations', 'SELECT * FROM usage_events', 'SELECT * FROM access_audit', 'SELECT * FROM entitlement_override_history',
        `INSERT INTO billing_customers (provider, external_customer_id, customer_id, linked_by) VALUES ('acme','z',${ROW},'w')`, 'UPDATE billing_customers SET linked_by = \'w\'', 'DELETE FROM billing_customers',
        'DELETE FROM subscriptions', 'DELETE FROM billing_inbox', 'DELETE FROM billing_outbox', 'TRUNCATE billing_inbox', 'DROP TABLE billing_inbox',
        `INSERT INTO entitlement_overrides (customer_id, feature_key, value, reason, created_by) VALUES (${ROW},'meetings.participants','9','x','x')`, INS_RES, 'ALTER TABLE subscriptions ADD COLUMN z int'],
    },
    admin: {
      allow: ['SELECT * FROM subscriptions', 'SELECT * FROM plans', 'SELECT * FROM entitlement_overrides', 'SELECT * FROM billing_customers', 'SELECT * FROM entitlement_override_history',
        `INSERT INTO entitlement_overrides (customer_id, feature_key, value, reason, created_by) VALUES (${ROW},'meetings.participants','9','x','x')`, 'UPDATE entitlement_overrides SET value = value', 'DELETE FROM entitlement_overrides',
        `INSERT INTO entitlement_override_history (customer_id, feature_key, action, new_value, reason, actor) VALUES (${ROW},'meetings.participants','set','9','x','a')`,
        `INSERT INTO billing_customers (provider, external_customer_id, customer_id, linked_by) VALUES ('acme','m-'||random()::text,gen_random_uuid(),'a')`, `INSERT INTO security_events (event_type, severity) VALUES ('t','info')`],
      deny: ['UPDATE subscriptions SET plan_code=\'enterprise\'', 'DELETE FROM subscriptions', `INSERT INTO subscriptions (customer_id, plan_code, current_period_start, current_period_end) VALUES (gen_random_uuid(),'pro',now(),now()+interval '1 day')`,
        'SELECT * FROM quota_reservations', INS_RES, 'SELECT * FROM billing_inbox', 'SELECT * FROM billing_outbox', 'SELECT * FROM usage_events', 'SELECT * FROM access_audit',
        'UPDATE entitlement_override_history SET actor = \'x\'', 'DELETE FROM entitlement_override_history', 'UPDATE billing_customers SET linked_by = \'x\'', 'DELETE FROM billing_customers', 'DROP TABLE entitlement_overrides', 'TRUNCATE entitlement_overrides'],
    },
  };

  for (const [kind, { allow, deny }] of Object.entries(MATRIX)) {
    test(`role matrix - ${kind}: ${allow.length} permitted statements work, ${deny.length} forbidden ones are refused with "permission denied"`, async () => {
      const seeded = await db.owner.query(`INSERT INTO quota_reservations (customer_id, feature_key, quantity, expires_at, max_expires_at, period_start, period_end, idempotency_key)
        VALUES ($1,'ai.queries',1, now()+interval '1 hour', now()+interval '1 hour', now(), now()+interval '1 day','matrix-${kind}') RETURNING id`, [c]);
      assert.ok(seeded.rowCount);
      await db.owner.query(`INSERT INTO entitlement_overrides (customer_id, feature_key, value, reason, created_by) VALUES ($1,'notes.ai_note_taking','2','seed','t') ON CONFLICT DO NOTHING`, [c]);
      const pool = db.poolFor(kind);
      for (const sql of allow) {
        const cl = await pool.connect();
        try { await cl.query('BEGIN'); await cl.query(sql); } catch (e) { assert.fail(`${kind} should be ALLOWED: ${sql.slice(0, 100)} -> ${e.message}`); } finally { await cl.query('ROLLBACK').catch(() => {}); cl.release(); }
      }
      for (const sql of deny) {
        const cl = await pool.connect();
        try {
          await cl.query('BEGIN');
          await assert.rejects(cl.query(sql), (e) => e.code === '42501', `${kind} should be DENIED (42501): ${sql.slice(0, 100)}`);
        } finally { await cl.query('ROLLBACK').catch(() => {}); cl.release(); }
      }
    });
  }

  test('a role with no membership has no access at all (PUBLIC was stripped)', async () => {
    const role = 'subacc_nobody_' + Math.random().toString(36).slice(2, 8);
    const cl = await db.owner.connect();
    try {
      await cl.query(`CREATE ROLE ${role} NOLOGIN`);
      await cl.query(`SET ROLE ${role}`);
      assert.equal((await cl.query(`SELECT has_schema_privilege('subscription_access', 'USAGE') AS u`)).rows[0].u, false, 'no usage on the schema');
      for (const t of ['subscriptions', 'plans', 'features', 'plan_entitlements', 'entitlement_overrides', 'usage_events', 'quota_reservations', 'access_audit', 'security_events', 'billing_inbox', 'billing_outbox', 'billing_customers', 'entitlement_override_history', 'customers', 'customer_members', 'customer_member_history', 'platform_staff', 'platform_staff_customers']) {
        await assert.rejects(cl.query(`SELECT 1 FROM subscription_access.${t}`), { code: '42501' }, 'qualified: ' + t);
        await assert.rejects(cl.query(`SELECT 1 FROM ${t}`), (e) => e.code === '42501' || e.code === '42P01', 'unqualified: ' + t + ' (no schema usage: the table is not even visible)');
      }
      await cl.query('RESET ROLE');
    } finally { await cl.query('RESET ROLE').catch(() => {}); await cl.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {}); cl.release(); }
  });

  test('the catalog in the database matches src/plans.js, and drift in either direction is detected and repaired by reseeding', async () => {
    assert.deepEqual(await verifyCatalog(db.owner), { ok: true, differences: [] });
    await db.owner.query(`UPDATE plan_entitlements SET value='999' WHERE plan_code='basic' AND feature_key='meetings.participants'`);
    await db.owner.query(`DELETE FROM plan_entitlements WHERE plan_code='pro' AND feature_key='phone.voip'`);
    await db.owner.query(`INSERT INTO features (key, value_type, metering) VALUES ('rogue.feature','boolean','none')`);
    const drift = await verifyCatalog(db.owner);
    assert.equal(drift.ok, false);
    assert.ok(drift.differences.some((d) => d.includes('entitlement differs: basic/meetings.participants')));
    assert.ok(drift.differences.some((d) => d.includes('entitlement missing in database: pro/phone.voip')));
    assert.ok(drift.differences.some((d) => d.includes('feature only in database: rogue.feature')));
    await db.owner.query(`DELETE FROM features WHERE key='rogue.feature'`);
    await seedCatalog(db.owner);
    assert.deepEqual(await verifyCatalog(db.owner), { ok: true, differences: [] });
  });
});
