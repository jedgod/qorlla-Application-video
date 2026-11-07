// Coexistence: the migrations must change NOTHING outside the `subscription_access` schema (other schemas, tables, views, sequences,
// functions, default privileges, databases or roles), and must be removable without touching anything else.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, skip } from './helpers/db.js';
import { migrate } from '../src/migrate.js';
import { seedCatalog } from '../src/seed.js';

const SNAPSHOT = `
  SELECT 'rel:' || n.nspname || '.' || c.relname || ':' || c.relkind::text AS k, coalesce(c.relacl::text, '<default>') AS v
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname NOT IN ('subscription_access', 'pg_catalog', 'information_schema', 'pg_toast') AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast%'
  UNION ALL SELECT 'col:' || n.nspname || '.' || c.relname || '.' || a.attname, a.attacl::text
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE a.attacl IS NOT NULL AND n.nspname NOT IN ('subscription_access', 'pg_catalog', 'information_schema')
  UNION ALL SELECT 'ns:' || nspname, coalesce(nspacl::text, '<default>') FROM pg_namespace
   WHERE nspname <> 'subscription_access' AND nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
  UNION ALL SELECT 'fn:' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', coalesce(p.proacl::text, '<default>')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('subscription_access', 'pg_catalog', 'information_schema')
  UNION ALL SELECT 'defacl:' || coalesce(n.nspname, '<global>') || ':' || d.defaclrole::regrole::text || ':' || d.defaclobjtype::text, d.defaclacl::text
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace WHERE n.nspname IS DISTINCT FROM 'subscription_access'
  UNION ALL SELECT 'db:' || datname, coalesce(datacl::text, '<default>') FROM pg_database WHERE datname = current_database()
  UNION ALL SELECT 'role:' || rolname, concat_ws(',', rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconnlimit::text, rolconfig::text)
    FROM pg_roles WHERE rolname NOT LIKE 'pg_%' AND rolname NOT LIKE 'qorlla_sub_%' AND rolname NOT LIKE 'subacc_%'
  UNION ALL SELECT 'member:' || r.rolname || '>' || m.rolname, am.admin_option::text
    FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
   WHERE r.rolname NOT LIKE 'pg_%' AND r.rolname NOT LIKE 'qorlla_sub_%' AND r.rolname NOT LIKE 'subacc_%' AND m.rolname NOT LIKE 'subacc_%'
  ORDER BY 1`;

/** A database that already hosts someone else's application, with deliberately varied privileges. */
async function populateUnrelated(pool, tag) {
  const r = { reader: `unrelated_reader_${tag}`, writer: `unrelated_writer_${tag}`, login: `unrelated_login_${tag}` };
  await pool.query(`CREATE ROLE ${r.reader} NOLOGIN`);
  await pool.query(`CREATE ROLE ${r.writer} NOLOGIN`);
  await pool.query(`CREATE ROLE ${r.login} LOGIN PASSWORD 'x' CONNECTION LIMIT 7 IN ROLE ${r.reader}`);
  await pool.query(`ALTER ROLE ${r.writer} SET statement_timeout = '45s'`);
  await pool.query(`
    CREATE TABLE public.legacy_accounts (id serial PRIMARY KEY, owner_name text, balance numeric);
    CREATE TABLE public.legacy_audit (id serial PRIMARY KEY, note text);
    CREATE VIEW public.legacy_view AS SELECT id, owner_name FROM public.legacy_accounts;
    CREATE SEQUENCE public.legacy_counter;
    CREATE FUNCTION public.legacy_fn(i int) RETURNS int LANGUAGE sql AS 'SELECT i + 1';
    CREATE SCHEMA other_app;
    CREATE TABLE other_app.orders (id int PRIMARY KEY, total numeric);
    GRANT SELECT ON public.legacy_accounts TO PUBLIC;
    GRANT SELECT, INSERT, UPDATE ON public.legacy_audit TO ${r.writer};
    GRANT SELECT ON public.legacy_view TO ${r.reader};
    GRANT USAGE, SELECT ON SEQUENCE public.legacy_counter TO ${r.writer};
    GRANT USAGE ON SEQUENCE public.legacy_audit_id_seq TO ${r.writer};
    GRANT UPDATE (balance) ON public.legacy_accounts TO ${r.writer};
    REVOKE EXECUTE ON FUNCTION public.legacy_fn(int) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.legacy_fn(int) TO ${r.reader};
    GRANT USAGE ON SCHEMA other_app TO ${r.reader};
    GRANT SELECT ON other_app.orders TO ${r.reader};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${r.reader};
    ALTER DEFAULT PRIVILEGES IN SCHEMA other_app GRANT INSERT ON TABLES TO ${r.writer};
    INSERT INTO public.legacy_accounts (owner_name, balance) VALUES ('alice', 10), ('bob', 20);`);
  return r;
}

describe('coexistence with unrelated applications (PostgreSQL)', { skip }, () => {
  let db, roles;
  before(async () => { db = await createTestDb({ migrateAndSeed: false }); roles = await populateUnrelated(db.owner, 'a'); });
  after(async () => {
    for (const r of Object.values(roles)) await db.owner.query(`DROP OWNED BY ${r}`).catch(() => {});
    await db.drop();
    const { default: pg } = await import('pg');
    const admin = new pg.Pool({ connectionString: process.env.SUBACC_TEST_ADMIN_URL, max: 1 });
    for (const r of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS ${r}`).catch(() => {});
    await admin.end();
  });

  test('CONTROL: the snapshot really is sensitive - the old broad "REVOKE ... IN SCHEMA public" would be detected', async () => {
    const before = (await db.owner.query(SNAPSHOT)).rows;
    assert.ok(before.length > 20, 'the snapshot covers a meaningful number of objects (' + before.length + ')');
    const cl = await db.owner.connect();
    try {
      await cl.query('BEGIN');
      await cl.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC');             // what migration 004 used to do
      const during = (await cl.query(SNAPSHOT)).rows;
      assert.notDeepEqual(during, before, 'the old statement changes unrelated ACLs and the snapshot sees it');
      assert.ok(during.find((r) => r.k.startsWith('rel:public.legacy_accounts')).v !== before.find((r) => r.k.startsWith('rel:public.legacy_accounts')).v);
    } finally { await cl.query('ROLLBACK'); cl.release(); }
    assert.deepEqual((await db.owner.query(SNAPSHOT)).rows, before, 'and the rollback restored it');
  });

  test('applying every migration changes NOTHING outside the subscription_access schema', async () => {
    const before = (await db.owner.query(SNAPSHOT)).rows;
    const applied = await migrate({ pool: db.owner });
    assert.equal(applied.length, 5);
    await seedCatalog(db.owner);
    const after = (await db.owner.query(SNAPSHOT)).rows;
    assert.deepEqual(after, before, 'every ACL, default privilege, role attribute and membership outside our schema is identical');
  });

  test('no object of ours leaks into the public schema or any other schema', async () => {
    const strays = await db.owner.query(`
      SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ('subscription_access','pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%'
         AND c.relname NOT IN ('legacy_accounts','legacy_audit','legacy_view','legacy_counter','orders','legacy_accounts_id_seq','legacy_audit_id_seq','legacy_accounts_pkey','legacy_audit_pkey','orders_pkey')`);
    assert.deepEqual(strays.rows, []);
    const fns = await db.owner.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname <> 'legacy_fn'`);
    assert.deepEqual(fns.rows, [], 'our trigger functions live in the dedicated schema only');
    assert.equal((await db.owner.query(`SELECT count(*)::int n FROM subscription_access.schema_migrations`)).rows[0].n, 5);
  });

  test('the unrelated application keeps working with exactly its old permissions', async () => {
    const asRole = async (role, sql) => { const cl = await db.owner.connect(); try { await cl.query(`SET ROLE ${role}`); return await cl.query(sql); } finally { await cl.query('RESET ROLE').catch(() => {}); cl.release(); } };
    assert.equal((await asRole(roles.reader, 'SELECT count(*)::int n FROM public.legacy_accounts')).rows[0].n, 2, 'PUBLIC select kept');
    assert.equal((await asRole(roles.reader, 'SELECT count(*)::int n FROM public.legacy_view')).rows[0].n, 2);
    assert.equal((await asRole(roles.reader, 'SELECT public.legacy_fn(1) AS v')).rows[0].v, 2);
    assert.equal((await asRole(roles.writer, `UPDATE public.legacy_accounts SET balance = balance + 1`)).rowCount, 2, 'column grant kept');
    await asRole(roles.writer, `INSERT INTO public.legacy_audit (note) VALUES ('x')`);
    assert.equal((await asRole(roles.writer, `SELECT nextval('public.legacy_counter') AS n`)).rows[0].n, '1');
    await assert.rejects(asRole(roles.writer, `DELETE FROM public.legacy_audit`), { code: '42501' }, 'and nothing was widened');
    await assert.rejects(asRole(roles.reader, `INSERT INTO public.legacy_audit (note) VALUES ('y')`), { code: '42501' });
    await assert.rejects(asRole(roles.writer, 'SELECT * FROM subscription_access.subscriptions'), { code: '42501' }, 'unrelated roles get nothing of ours');
    await assert.rejects(asRole(roles.reader, 'SELECT * FROM subscription_access.access_audit'), { code: '42501' });
    assert.equal((await db.owner.query(`SELECT count(*)::int n FROM pg_roles WHERE rolname = '${roles.login}' AND rolconnlimit = 7`)).rows[0].n, 1, 'role attributes untouched');
  });

  test('re-running the migrations is a no-op for unrelated objects too', async () => {
    const before = (await db.owner.query(SNAPSHOT)).rows;
    assert.deepEqual(await migrate({ pool: db.owner }), []);
    assert.deepEqual((await db.owner.query(SNAPSHOT)).rows, before);
  });

  test('UNINSTALL: dropping the schema removes everything of ours and leaves every unrelated object and privilege exactly as it was', async () => {
    const before = (await db.owner.query(SNAPSHOT)).rows;
    await db.owner.query('DROP SCHEMA subscription_access CASCADE');
    assert.equal((await db.owner.query(`SELECT count(*)::int n FROM pg_namespace WHERE nspname = 'subscription_access'`)).rows[0].n, 0);
    assert.deepEqual((await db.owner.query(SNAPSHOT)).rows, before, 'unrelated state unchanged by the uninstall');
    assert.equal((await db.owner.query('SELECT count(*)::int n FROM public.legacy_accounts')).rows[0].n, 2);
    const again = await migrate({ pool: db.owner });                                   // and it installs again cleanly
    assert.equal(again.length, 5);
    assert.deepEqual((await db.owner.query(SNAPSHOT)).rows, before, 'and reinstalling is equally harmless');
  });

  test('trigger functions are pinned to their own schema: they behave identically whatever search_path the session has', async () => {
    const cl = await db.owner.connect();
    try {
      await cl.query('SET search_path = public');                                          // an unrelated application default
      const cid = (await cl.query(`INSERT INTO subscription_access.customers (name, created_by) VALUES ('Pinned', 'tester') RETURNING id`)).rows[0].id;
      await cl.query(`INSERT INTO subscription_access.customer_members (customer_id, user_id, role, added_by) VALUES ($1,'a','owner','t'), ($1,'b','owner','t')`, [cid]);
      await cl.query(`DELETE FROM subscription_access.customer_members WHERE customer_id=$1 AND user_id='b'`, [cid]);       // fires qorlla_keep_an_owner
      await assert.rejects(cl.query(`DELETE FROM subscription_access.customer_members WHERE customer_id=$1`, [cid]), { code: '23514' }, 'last-owner rule still enforced');
      const sub = (await cl.query(`INSERT INTO subscription_access.subscriptions (customer_id, plan_code, current_period_start, current_period_end) VALUES (gen_random_uuid(),'pro',now(),now()+interval '1 day') RETURNING customer_id`)).rows[0].customer_id;
      await cl.query(`UPDATE subscription_access.subscriptions SET quantity = 3 WHERE customer_id=$1`, [sub]);               // lock + touch triggers
      await cl.query(`INSERT INTO subscription_access.security_events (event_type, severity) VALUES ('pin','info')`);
      await assert.rejects(cl.query(`UPDATE subscription_access.security_events SET severity='info' WHERE event_type='pin'`), /append-only/, 'immutability trigger');
    } finally { await cl.query('RESET search_path').catch(() => {}); cl.release(); }
  });

  test('a misconfigured connection (default search_path) fails closed with a clear message instead of reading the wrong tables', async () => {
    const { default: pg } = await import('pg');
    const { AccessService } = await import('../src/accessService.js');
    const u = new URL(process.env.SUBACC_TEST_ADMIN_URL); u.pathname = '/' + db.name;       // a pool WITHOUT the schema search path
    const raw = new pg.Pool({ connectionString: u.toString(), max: 1 });
    try {
      const svc = new AccessService({ pool: raw });
      const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
      try { await assert.rejects(svc.canAccess('00000000-0000-4000-8000-000000000001', 'chat.instant'), { code: 'access_unavailable' }); } finally { console.error = orig; }
      assert.ok(logs.some((l) => /search_path/.test(l) && /subscription_access/.test(l)), 'the log says exactly what is wrong');
    } finally { await raw.end(); }
  });
});
