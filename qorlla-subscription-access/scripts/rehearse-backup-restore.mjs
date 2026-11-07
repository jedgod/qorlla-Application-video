// Backup and restore rehearsal. Builds a populated database through the real services, dumps it, restores it into a NEW
// database and proves the restored copy is identical and still enforces everything. Disposable servers only.
//
//   SUBACC_TEST_ADMIN_URL=postgres://postgres:pw@127.0.0.1:5432/postgres \
//   PG_DOCKER_CONTAINER=a5-pg   node scripts/rehearse-backup-restore.mjs      # pg tools run inside that container
//   (omit PG_DOCKER_CONTAINER to use pg_dump / pg_restore from PATH)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../src/schema.js';
import { createTestDb, newCustomer, seedSubscription } from '../tests/helpers/db.js';
import { AccessService } from '../src/accessService.js';
import { AdminService } from '../src/admin.js';
import { migrate } from '../src/migrate.js';

const ADMIN_URL = process.env.SUBACC_TEST_ADMIN_URL;
if (!ADMIN_URL) { console.error('set SUBACC_TEST_ADMIN_URL'); process.exit(2); }
const container = process.env.PG_DOCKER_CONTAINER;
const u = new URL(ADMIN_URL);

function tool(name, args, input) {
  const base = container ? ['docker', ['exec', '-i', '-e', `PGPASSWORD=${decodeURIComponent(u.password)}`, container, name, ...args]] : [name, args];
  const env = container ? process.env : { ...process.env, PGPASSWORD: decodeURIComponent(u.password) };
  const r = spawnSync(base[0], base[1], { input, env, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${name} failed: ${r.stderr?.toString().slice(0, 500)}`);
  return r.stdout;
}
const conn = ['-h', container ? '127.0.0.1' : u.hostname, '-p', container ? '5432' : (u.port || '5432'), '-U', decodeURIComponent(u.username)];

const TABLES = ['plans', 'features', 'plan_entitlements', 'subscriptions', 'entitlement_overrides', 'entitlement_override_history', 'usage_events',
  'quota_reservations', 'access_audit', 'security_events', 'billing_customers', 'billing_inbox', 'billing_outbox', 'schema_migrations'];
async function fingerprint(pool) {
  const out = {};
  for (const t of TABLES) {
    const r = await pool.query(`SELECT count(*)::int AS n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`);
    out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
  }
  return out;
}

const log = (m) => console.log(m);
const quietPool = (p) => { p.on('error', () => {}); return p; };      // DROP DATABASE ... FORCE terminates idle sessions on purpose
const source = await createTestDb();
let restoredName; let ok = true;
try {
  // 1. Populate through the real services (so the data is realistic, not hand-inserted).
  const rt = new AccessService({ pool: source.poolFor('runtime') });
  const admin = new AdminService({ pool: source.poolFor('admin'), authorize: async () => true });
  const actor = { id: 'ops-1', roles: ['billing_admin'], mfaVerifiedAt: Date.now() };
  const customers = [];
  for (let i = 0; i < 25; i++) {
    const c = newCustomer(); customers.push(c);
    await seedSubscription(source.owner, c, { plan: ['basic', 'pro', 'business'][i % 3] });
    if (i % 4 === 0) await admin.setOverride(actor, c, 'meetings.participants', 250, { reason: 'rehearsal override', expiresAt: new Date(Date.now() + 86_400_000) });
    const r = await rt.reserve(c, 'ai.queries', 1, { idempotencyKey: `rehearse-${i}` });
    if (r.reservationId) await rt.commitReservation(r.reservationId, { customerId: c });
    await rt.canAccess(c, 'meetings.cloud_recording');
  }
  const before = await fingerprint(source.owner);
  log(`populated: ${Object.entries(before).map(([t, v]) => `${t}=${v.split(':')[0]}`).join(' ')}`);

  // 2. Backup
  const dump = tool('pg_dump', [...conn, '-Fc', '-d', source.name]);
  log(`backup: ${dump.length} bytes, sha256 ${createHash('sha256').update(dump).digest('hex').slice(0, 16)}...`);

  // 3. Restore into a brand-new database
  restoredName = source.name + '_restored';
  const adminPool = quietPool(new pg.Pool({ connectionString: ADMIN_URL, max: 1 }));
  await adminPool.query(`CREATE DATABASE ${restoredName}`);
  tool('pg_restore', [...conn, '-d', restoredName, '--exit-on-error'], dump);
  const restoredUrl = new URL(ADMIN_URL); restoredUrl.pathname = '/' + restoredName;
  const restored = createPool(restoredUrl.toString(), { max: 4 });

  // 4. Verify content
  const after = await fingerprint(restored);
  for (const t of TABLES) { if (before[t] !== after[t]) { ok = false; log(`MISMATCH ${t}: ${before[t]} != ${after[t]}`); } }
  log(ok ? 'content: every table identical (row counts and content hashes)' : 'content: DIFFERENCES FOUND');

  // 5. Verify enforcement survived: constraints, immutability, migrations, roles, and the application itself
  const check = async (name, fn) => { try { await fn(); log(`ok   ${name}`); } catch (e) { ok = false; log(`FAIL ${name}: ${e.message}`); } };
  await check('append-only trigger fires', async () => { try { await restored.query('DELETE FROM access_audit'); } catch (e) { if (/append-only/.test(e.message)) return; throw e; } throw new Error('DELETE succeeded'); });
  await check('check constraints present', async () => { try { await restored.query(`INSERT INTO subscriptions (customer_id, plan_code, current_period_start, current_period_end) VALUES (gen_random_uuid(),'pro',now(),now())`); } catch (e) { if (e.code === '23514') return; throw e; } throw new Error('invalid row accepted'); });
  await check('customer lock triggers present', async () => {
    const t = await restored.query(`SELECT tgname FROM pg_trigger WHERE tgname IN ('subscriptions_customer_lock','entitlement_overrides_customer_lock') AND NOT tgisinternal`);
    if (t.rowCount !== 2) throw new Error('missing');
  });
  await check('migration checksums still verify (nothing to apply)', async () => { const a = await migrate({ pool: restored }); if (a.length) throw new Error('applied ' + a); });
  await check('role grants survived the restore', async () => {
    const g = await restored.query(`SELECT has_table_privilege('qorlla_sub_runtime','subscriptions','UPDATE') AS u, has_table_privilege('qorlla_sub_runtime','subscriptions','SELECT') AS s`);
    if (g.rows[0].u || !g.rows[0].s) throw new Error(JSON.stringify(g.rows[0]));
  });
  await check('the application works on the restored copy (as the least-privilege role)', async () => {
    const u2 = new URL(source.url('runtime')); u2.pathname = '/' + restoredName;
    const live = new AccessService({ connectionString: u2.toString(), poolMax: 2 });
    const d = await live.canAccess(customers[1], 'meetings.cloud_recording');
    if (!d.allowed) throw new Error('pro customer denied after restore');
    const r = await live.reserve(customers[0], 'ai.queries', 1, { idempotencyKey: 'post-restore' });
    if (!r.allowed) throw new Error('reserve failed');
    const replay = await live.reserve(customers[0], 'ai.queries', 1, { idempotencyKey: 'rehearse-0' });
    if (!replay.replay || replay.status !== 'committed') throw new Error('idempotency history lost');
    await live.close();
  });
  await restored.end(); await adminPool.query(`DROP DATABASE IF EXISTS ${restoredName} WITH (FORCE)`); await adminPool.end();
} catch (e) {
  ok = false; console.error('REHEARSAL ERROR:', e.message);
} finally {
  await source.drop();
}

// ---- Rollback rehearsal: a migration that SUCCEEDED is rolled back by restoring the backup taken just before it ----------------
// (Migrations are forward-only; this is the supported way back. Run it in staging before every release.)
try {
  const { mkdtemp, cp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const SCHEMA_DIR = fileURLToPath(new URL('../schema', import.meta.url));
  const old = await mkdtemp(join(tmpdir(), 'subacc-old-'));
  for (const f of ['001_subscriptions.sql', '002_hardening.sql', '003_billing.sql', '004_roles_and_grants.sql']) await cp(join(SCHEMA_DIR, f), join(old, f));   // the release BEFORE 005

  const rb = await createTestDb({ migrateAndSeed: false });
  const rbRestored = rb.name + '_rolledback';
  const adminPool = quietPool(new pg.Pool({ connectionString: ADMIN_URL, max: 1 }));
  try {
    await migrate({ pool: rb.owner, dir: old });
    const c = newCustomer(); await seedSubscription(rb.owner, c, { plan: 'pro' });
    const before = await fingerprint4(rb.owner);
    const dump = tool('pg_dump', [...conn, '-Fc', '-d', rb.name]);                                     // backup taken immediately before the release
    log(`rollback rehearsal: backup before 005 (${dump.length} bytes), versions ${before.versions}`);

    const applied = await migrate({ pool: rb.owner });                                                   // the release goes out
    if (applied.join() !== '005_directory.sql') throw new Error('expected only 005 to apply, got ' + applied);
    await rb.owner.query(`INSERT INTO customers (name, created_by) VALUES ('after-release', 't')`);      // real life continues on the new schema...

    await adminPool.query(`CREATE DATABASE ${rbRestored}`);                                              // ...then the release is rolled back
    tool('pg_restore', [...conn, '-d', rbRestored, '--exit-on-error'], dump);
    const rr = createPool((() => { const x = new URL(ADMIN_URL); x.pathname = '/' + rbRestored; return x.toString(); })(), { max: 2 });
    const after = await fingerprint4(rr);
    const check = async (name, cond) => { if (cond) log(`ok   ${name}`); else { ok = false; log(`FAIL ${name}`); } };
    await check('restored data identical to the pre-release backup', after.hash === before.hash);
    await check('migration 005 is not recorded after the rollback', after.versions === before.versions);
    await check('the 005 tables are gone (customers)', (await rr.query(`SELECT to_regclass('customers') AS t`)).rows[0].t === null);
    await check('the release can be re-applied cleanly after the rollback', (await migrate({ pool: rr })).join() === '005_directory.sql');
    await rr.end();
  } finally {
    await rb.drop().catch(() => {});
    await adminPool.query(`DROP DATABASE IF EXISTS ${rbRestored} WITH (FORCE)`).catch(() => {}); await adminPool.end();
    await rm(old, { recursive: true, force: true });
  }
} catch (e) {
  ok = false; console.error('ROLLBACK REHEARSAL ERROR:', e.message);
}

async function fingerprint4(pool) {
  const t = ['plans', 'features', 'plan_entitlements', 'subscriptions', 'entitlement_overrides', 'usage_events', 'quota_reservations', 'access_audit', 'security_events'];
  let h = '';
  for (const x of t) h += (await pool.query(`SELECT md5(COALESCE(string_agg(y::text, '|' ORDER BY y::text), '')) AS h FROM ${x} y`)).rows[0].h;
  const versions = (await pool.query('SELECT string_agg(version, \',\' ORDER BY version) AS v FROM schema_migrations')).rows[0].v;
  return { hash: createHash('md5').update(h).digest('hex'), versions };
}

console.log(ok ? '\nREHEARSAL PASSED' : '\nREHEARSAL FAILED');
process.exit(ok ? 0 : 1);
