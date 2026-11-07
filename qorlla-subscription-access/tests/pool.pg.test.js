// A database restart or failover kills idle connections. A pool with no 'error' listener turns that into an uncaught exception and the
// whole process dies. Every pool the package creates must survive it, log it, and reconnect on the next call.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createTestDb, newCustomer, sleep, skip } from './helpers/db.js';
import { AccessService } from '../src/accessService.js';
import { AdminService } from '../src/admin.js';
import { BillingProcessor } from '../src/billing.js';
import { Directory, DirectoryAdmin } from '../src/directory.js';
import { createStaff } from '../src/staff.js';

describe('owned pools survive killed connections (PostgreSQL)', { skip }, () => {
  let db, uncaught, onUncaught, logs, origError;
  before(async () => {
    db = await createTestDb();
    uncaught = []; onUncaught = (e) => uncaught.push(e); process.on('uncaughtException', onUncaught);
    logs = []; origError = console.error; console.error = (...a) => { logs.push(a.join(' ')); };
  });
  after(async () => { console.error = origError; process.removeListener('uncaughtException', onUncaught); await db.drop(); });

  const kill = async (app) => (await db.owner.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()`, [app])).rowCount;

  const cases = [
    ['AccessService', 'runtime', (url) => new AccessService({ connectionString: url, poolMax: 2 }), async (s) => (await s.canAccess(newCustomer(), 'chat.instant')).allowed === true, (s) => s.close()],
    ['Directory', 'runtime', (url) => new Directory({ connectionString: url }), async (s) => Array.isArray(await s.membershipsOf('u_nobody')), (s) => s.close()],
    ['DirectoryAdmin', 'admin', (url) => new DirectoryAdmin({ connectionString: url }), async (s) => (await s.createCustomer('u_pool_' + randomBytes(4).toString('hex'), 'Pool Co')).customer_id.length === 36, (s) => s.close()],
    ['AdminService', 'admin', (url) => new AdminService({ connectionString: url, authorize: async () => false }), async (s) => (await s.pool.query('SELECT 1 AS ok')).rows[0].ok === 1, (s) => s.close()],
    ['BillingProcessor', 'billing', (url) => new BillingProcessor({ connectionString: url, adapters: [] }), async (s) => (await s.drainOutbox(async () => {})).published === 0, (s) => s.close()],
    ['createStaff', 'admin', (url) => createStaff({ connectionString: url }), async (s) => (await s.authorize({ id: 'u_nobody' }, 'override.set', newCustomer())) === false, (s) => s.close()],
  ];

  for (const [name, role, make, op, close] of cases) {
    test(`${name}: an idle connection killed by the database is logged, not fatal, and the next call reconnects`, async () => {
      const app = 'pool_' + name + '_' + randomBytes(3).toString('hex');
      const svc = make(db.url(role, app));
      try {
        assert.equal(await op(svc), true, 'works before');
        const before = logs.length;                                            // taken BEFORE the kill: the event can arrive immediately
        const killed = await kill(app);
        assert.ok(killed >= 1, 'an idle backend existed and was terminated');
        await sleep(400);                                                      // the error event arrives asynchronously
        assert.deepEqual(uncaught, [], 'NO uncaught exception: the process is alive');
        assert.ok(logs.slice(before).some((l) => /idle database connection error/.test(l)), 'the event was logged, not swallowed silently');
        assert.equal(await op(svc), true, 'and the very next call works on a fresh connection');
      } finally { await close(svc); }
    });
  }
});
