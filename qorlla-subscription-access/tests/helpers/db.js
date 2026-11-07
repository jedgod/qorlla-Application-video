// Disposable PostgreSQL databases for the integration tests.
// SUBACC_TEST_ADMIN_URL must be a SUPERUSER url of a throwaway server, e.g. postgres://postgres:pw@127.0.0.1:35441/postgres
// Each call creates its own database, migrates it as the owner, and creates real LOGIN roles that are members of the
// three group roles, so the tests exercise the actual least-privilege grants (never the superuser) on the request path.
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { migrate } from '../../src/migrate.js';
import { seedCatalog } from '../../src/seed.js';

const ADMIN_URL = process.env.SUBACC_TEST_ADMIN_URL;
export const skip = ADMIN_URL ? false : 'set SUBACC_TEST_ADMIN_URL (superuser URL of a disposable PostgreSQL) to run the database tests';

// Connections to the package's database resolve unqualified names to its dedicated schema, exactly as production pools must.
const withDb = (url, db, user, pw, appName) => {
  const u = new URL(url);
  u.pathname = '/' + db;
  u.searchParams.set('options', '-c search_path=subscription_access,pg_catalog');
  if (user) { u.username = user; u.password = pw; }
  if (appName) u.searchParams.set('application_name', appName);
  return u.toString();
};

export const GROUPS = { runtime: 'qorlla_sub_runtime', billing: 'qorlla_sub_billing', admin: 'qorlla_sub_admin', ops: 'qorlla_sub_ops' };

export async function createTestDb({ migrateAndSeed = true } = {}) {
  const id = randomBytes(4).toString('hex');
  const name = `subacc_${id}`;
  const adminPool = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
  await adminPool.query(`CREATE DATABASE ${name}`);
  const owner = new pg.Pool({ connectionString: withDb(ADMIN_URL, name), max: 6 });
  const quiet = (p) => p.on('error', () => {});     // idle clients may be terminated during teardown (DROP DATABASE ... FORCE)
  quiet(owner);
  const pools = [owner];
  if (migrateAndSeed) { await migrate({ pool: owner }); await seedCatalog(owner); }

  const logins = {};
  if (migrateAndSeed) {
    for (const [kind, group] of Object.entries(GROUPS)) {
      const role = `subacc_${kind}_${id}`;
      const pw = 'pw' + randomBytes(10).toString('hex');
      await adminPool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}' IN ROLE ${group}`);
      logins[kind] = { role, pw };
    }
  }

  const db = {
    name, owner,
    url: (kind, app) => withDb(ADMIN_URL, name, logins[kind].role, logins[kind].pw, app || `subacc_${kind}_${id}`),
    poolFor(kind, { max = 5, app } = {}) {
      const p = new pg.Pool({ connectionString: db.url(kind, app), max });
      quiet(p);
      pools.push(p);
      return p;
    },
    async drop() {
      await Promise.all(pools.map((p) => p.end().catch(() => {})));
      await adminPool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      for (const { role } of Object.values(logins)) await adminPool.query(`DROP ROLE IF EXISTS ${role}`);
      await adminPool.end();
    },
  };
  return db;
}

export const newCustomer = () => randomUUID();

/** Inserts a subscription as the owner. Dates default to "in the middle of a paid period". */
export async function seedSubscription(owner, customerId, o = {}) {
  const day = 86_400_000;
  const now = Date.now();
  const v = {
    plan: 'pro', status: 'active', start: new Date(now - 10 * day), end: new Date(now + 20 * day),
    trialEnds: null, graceEnds: null, provider: null, externalId: null, revision: 0, quantity: 1, ...o,
  };
  await owner.query(
    `INSERT INTO subscriptions (customer_id, plan_code, status, quantity, trial_ends_at, current_period_start, current_period_end,
       grace_period_ends_at, provider, external_id, provider_revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [customerId, v.plan, v.status, v.quantity, v.trialEnds, v.start, v.end, v.graceEnds, v.provider, v.externalId, v.revision]);
  return v;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
