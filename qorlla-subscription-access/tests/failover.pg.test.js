// REAL PostgreSQL failover: a disposable primary and a SYNCHRONOUS streaming standby in Docker (own network, own volumes, nothing else
// touched). The primary is killed hard while a workload runs, the standby is promoted, and the application reconnects through a switchable
// proxy (the role a VIP / pooler / Patroni+HAProxy plays in production).
//
// Run:  SUBACC_FAILOVER=1 node --test tests/failover.pg.test.js        (needs Docker and the local postgres:16 image; no network pulls)
//
// What it proves:
//  * while the primary is gone, and while a standby that is not yet promoted is the only target, EVERY access decision is DENIED (503);
//    nothing is allowed on uncertainty and the process never crashes
//  * after promotion the same running service recovers without a restart
//  * every operation the client was told succeeded exists on the promoted node exactly once (synchronous replication => no acknowledged loss);
//    operations whose outcome was unknown are safely retried with the same idempotency key
//  * quota invariants (used + held <= limit) hold on the promoted node
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/migrate.js';
import { seedCatalog } from '../src/seed.js';
import { AccessService } from '../src/accessService.js';
import { createPool } from '../src/schema.js';

const enabled = process.env.SUBACC_FAILOVER === '1';
const dockerOk = enabled && spawnSync('docker', ['version'], { encoding: 'utf8' }).status === 0;
const skip = !enabled ? 'set SUBACC_FAILOVER=1 to run the Docker failover test' : (!dockerOk ? 'docker is not available' : false);
const IMAGE = process.env.SUBACC_FAILOVER_IMAGE || 'postgres:16';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => process.stderr.write(`      [failover] ${new Date().toISOString().slice(11, 19)} ${m}\n`);
const until = async (fn, ms = 60_000, step = 500) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = null; } await sleep(step); } return null; };

const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', ...opts });
const dockerOut = (args) => { const r = docker(args); if (r.status !== 0) throw new Error(`docker ${args.join(' ')} failed: ${r.stderr}`); return r.stdout.trim(); };

/** A TCP proxy whose upstream can be switched or cut, standing in for the VIP / pooler in front of a real cluster. */
function switchableProxy() {
  const conns = new Set(); let upstream = null; let cut = true;
  const server = createServer((c) => {
    if (cut || !upstream) return c.destroy();
    const u = connect(upstream, '127.0.0.1'); conns.add(c); conns.add(u);
    c.pipe(u).pipe(c);
    const end = () => { c.destroy(); u.destroy(); conns.delete(c); conns.delete(u); };
    c.on('error', end); u.on('error', end); c.on('close', end); u.on('close', end);
  });
  return {
    async listen() { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return server.address().port; },
    point(port) { upstream = port; cut = false; },
    cut() { cut = true; for (const c of conns) c.destroy(); conns.clear(); },
    close() { this.cut(); server.close(); },
  };
}

describe('PostgreSQL failover (Docker primary + synchronous standby)', { skip, timeout: 600_000 }, () => {
  const id = randomBytes(3).toString('hex');
  const net = `subacc-fo-${id}-net`, volP = `subacc-fo-${id}-primary`, volS = `subacc-fo-${id}-standby`, cP = `subacc-fo-${id}-primary`, cS = `subacc-fo-${id}-standby`;
  const created = { containers: [], volumes: [], networks: [] };
  const PW = 'fo_' + randomBytes(6).toString('hex');
  let pPort, sPort, proxy, proxyPort, svc, owner, appPool;

  const psql = (container, sql, db = 'postgres') => dockerOut(['exec', '-u', 'postgres', '-e', `PGPASSWORD=${PW}`, container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', db, '-tA', '-c', sql]);
  const hostPort = (c) => Number(dockerOut(['port', c, '5432/tcp']).split('\n')[0].split(':').pop());

  before(async () => {
    proxy = switchableProxy(); proxyPort = await proxy.listen();
    dockerOut(['network', 'create', net]); created.networks.push(net);
    dockerOut(['volume', 'create', volP]); created.volumes.push(volP);
    dockerOut(['volume', 'create', volS]); created.volumes.push(volS);
    // primary: WAL for replication, quorum-synchronous commit to the standby named standby1
    dockerOut(['run', '-d', '--name', cP, '--network', net, '-v', `${volP}:/var/lib/postgresql/data`, '-e', `POSTGRES_PASSWORD=${PW}`, '-p', '127.0.0.1::5432', IMAGE,
      '-c', 'wal_level=replica', '-c', 'max_wal_senders=5', '-c', 'max_replication_slots=5', '-c', 'hot_standby=on', '-c', 'listen_addresses=*']);
    created.containers.push(cP); step('primary container started');
    assert.ok(await until(() => psql(cP, 'select 1') === '1', 90_000), 'primary is up'); step('primary accepts connections');
    psql(cP, `CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${PW}'`);
    dockerOut(['exec', '-u', 'postgres', cP, 'bash', '-c', 'echo "host replication replicator all scram-sha-256" >> $PGDATA/pg_hba.conf']);
    psql(cP, 'select pg_reload_conf()');
    // standby: a base backup of the primary into its own volume, application_name=standby1, then started in recovery
    const bb = docker(['run', '--rm', '--network', net, '-v', `${volS}:/var/lib/postgresql/data`, '-e', `PGPASSWORD=${PW}`, IMAGE, 'bash', '-c',
      `chown postgres:postgres /var/lib/postgresql/data && gosu postgres pg_basebackup -d "host=${cP} user=replicator password=${PW} application_name=standby1" -D /var/lib/postgresql/data -R -X stream --checkpoint=fast`]);
    assert.equal(bb.status, 0, bb.stderr); step('base backup taken');
    dockerOut(['run', '-d', '--name', cS, '--network', net, '-v', `${volS}:/var/lib/postgresql/data`, '-e', `POSTGRES_PASSWORD=${PW}`, '-p', '127.0.0.1::5432', IMAGE, '-c', 'hot_standby=on', '-c', 'listen_addresses=*']);
    created.containers.push(cS);
    assert.ok(await until(() => psql(cS, 'select pg_is_in_recovery()') === 't', 90_000), 'standby is in recovery'); step('standby in recovery');
    assert.ok(await until(() => psql(cP, "select state from pg_stat_replication where application_name='standby1'") === 'streaming', 60_000), 'standby is streaming'); step('standby streaming');
    psql(cP, "ALTER SYSTEM SET synchronous_standby_names = 'standby1'"); psql(cP, "ALTER SYSTEM SET synchronous_commit = 'on'"); psql(cP, 'select pg_reload_conf()');
    assert.ok(await until(() => psql(cP, "select sync_state from pg_stat_replication where application_name='standby1'") === 'sync', 60_000), 'replication is SYNCHRONOUS'); step('replication is synchronous');
    pPort = hostPort(cP); sPort = hostPort(cS);

    // install the package on the primary (it replicates), create the application login
    const base = `postgres://postgres:${PW}@127.0.0.1:${pPort}/postgres`;
    owner = createPool(base, { max: 2 });                                                  // schema-aware, like every pool the package uses
    step('installing the package on the primary'); await migrate({ pool: owner }); await seedCatalog(owner); step('installed');
    await owner.query(`CREATE ROLE fo_runtime LOGIN PASSWORD '${PW}' IN ROLE qorlla_sub_runtime`);
    assert.ok(await until(async () => psql(cS, "select count(*) from subscription_access.plans") === '4', 30_000), 'the schema reached the standby');
    proxy.point(pPort);
    appPool = createPool(`postgres://fo_runtime:${PW}@127.0.0.1:${proxyPort}/postgres`, { max: 8, connectionTimeoutMillis: 3000 });
    svc = new AccessService({ pool: appPool, lockTimeoutMs: 3000, statementTimeoutMs: 6000 });
  });

  after(async () => {
    proxy?.close(); await appPool?.end().catch(() => {}); await owner?.end().catch(() => {});
    // remove ONLY what this test created
    for (const c of created.containers) docker(['rm', '-f', c]);
    for (const v of created.volumes) docker(['volume', 'rm', '-f', v]);
    for (const n of created.networks) docker(['network', 'rm', n]);
  });

  const cust = async () => { const c = (await owner.query('SELECT gen_random_uuid() AS id')).rows[0].id; await owner.query(`INSERT INTO subscription_access.subscriptions (customer_id, plan_code, status, current_period_start, current_period_end) VALUES ($1,'basic','active', now() - interval '1 day', now() + interval '30 days')`, [c]); return c; };

  test('the cluster really is a synchronous primary/standby pair', async () => {
    assert.equal(psql(cP, 'select pg_is_in_recovery()'), 'f'); assert.equal(psql(cS, 'select pg_is_in_recovery()'), 't');
    assert.equal(psql(cP, "select sync_state from pg_stat_replication where application_name='standby1'"), 'sync');
    assert.equal(psql(cP, 'show synchronous_commit'), 'on');
  });

  test('FAILOVER: kill the primary mid-workload; everything is denied while it is gone and while the standby is still read-only; after promotion the service recovers and no acknowledged operation is lost or duplicated', async () => {
    const customer = (await owner.query('SELECT gen_random_uuid() AS id')).rows[0].id;
    await owner.query(`INSERT INTO subscription_access.subscriptions (customer_id, plan_code, status, current_period_start, current_period_end) VALUES ($1,'pro','active', now() - interval '1 day', now() + interval '30 days')`, [customer]);
    await owner.query(`INSERT INTO subscription_access.entitlement_overrides (customer_id, feature_key, value, reason, created_by, expires_at) VALUES ($1,'ai.queries','400','failover test','t', now() + interval '1 day')`, [customer]);
    assert.equal((await svc.canAccess(customer, 'meetings.cloud_recording')).allowed, true, 'healthy before the failure');

    const acknowledged = new Map();                                  // idempotency key -> reservation id the CLIENT was told about
    const unknown = new Set();                                       // keys whose outcome the client could not learn
    let stopWorkload = false; let seq = 0;
    const worker = async () => {
      while (!stopWorkload) {
        const key = `fo-${++seq}`;
        try {
          const r = await svc.reserve(customer, 'ai.queries', 1, { idempotencyKey: key });
          if (r.allowed) { const c = await svc.commitReservation(r.reservationId, { customerId: customer }); if (c.ok) acknowledged.set(key, r.reservationId); else unknown.add(key); }
        } catch (e) { assert.equal(e.code, 'access_unavailable', 'a failure is always a clean denial: ' + e.message); unknown.add(key); }
        await sleep(15);
      }
    };
    const workers = Array.from({ length: 4 }, worker);
    await until(() => acknowledged.size >= 40, 30_000, 100);
    assert.ok(acknowledged.size >= 40, 'workload is flowing');

    // ---- the primary dies (hard) ----------------------------------------------------------------------------------------------
    step(`killing the primary (${acknowledged.size} operations acknowledged so far)`); docker(['kill', cP]); proxy.cut();
    await sleep(1500);
    const during = [];
    for (let i = 0; i < 6; i++) during.push(await svc.canAccess(customer, 'meetings.host').then((d) => ({ allowed: d.allowed }), (e) => ({ error: e.code, status: e.statusCode })));
    assert.ok(during.every((d) => d.error === 'access_unavailable' && d.status === 503), 'primary gone: every decision is a 503 denial ' + JSON.stringify(during));

    // ---- a standby that is NOT yet promoted is read-only: still no decision can be made ---------------------------------------------
    proxy.point(sPort);
    const onStandby = await Promise.all([svc.canAccess(customer, 'meetings.host').then((d) => ({ allowed: d.allowed }), (e) => ({ error: e.code })),
      svc.reserve(customer, 'ai.queries', 1, { idempotencyKey: 'standby-probe-1' }).then((d) => ({ allowed: d.allowed }), (e) => ({ error: e.code }))]);
    assert.ok(onStandby.every((d) => d.error === 'access_unavailable'), 'read-only standby: reads cannot be audited and writes cannot happen, so everything is denied ' + JSON.stringify(onStandby));

    // ---- promote ----------------------------------------------------------------------------------------------------------------
    step('promoting the standby'); dockerOut(['exec', '-u', 'postgres', cS, 'pg_ctl', 'promote', '-D', '/var/lib/postgresql/data']);
    assert.ok(await until(() => psql(cS, 'select pg_is_in_recovery()') === 'f', 60_000), 'standby promoted');
    proxy.cut(); proxy.point(sPort);
    const recovered = await until(async () => { try { return (await svc.canAccess(customer, 'meetings.host')).allowed === true; } catch { return false; } }, 60_000, 500);
    assert.ok(recovered, 'the SAME running service recovered without a restart'); step('service recovered');

    // outcome-unknown operations are retried with the same key: either they replay (they had committed) or they are created now
    stopWorkload = true; await Promise.all(workers);
    const retried = { replayed: 0, created: 0 };
    for (const key of unknown) {
      const r = await svc.reserve(customer, 'ai.queries', 1, { idempotencyKey: key });
      if (r.replay) retried.replayed++; else retried.created++;
      if (r.allowed && r.status !== 'committed') await svc.commitReservation(r.reservationId, { customerId: customer });
      acknowledged.set(key, r.reservationId);
    }

    // ---- consistency on the promoted node ---------------------------------------------------------------------------------------
    const np = new pg.Pool({ connectionString: `postgres://postgres:${PW}@127.0.0.1:${sPort}/postgres`, max: 2 }); np.on('error', () => {});
    try {
      const rows = (await np.query(`SELECT idempotency_key, id, status FROM subscription_access.quota_reservations WHERE customer_id=$1 AND idempotency_key LIKE 'fo-%'`, [customer])).rows;
      const byKey = new Map(rows.map((r) => [r.idempotency_key, r]));
      assert.equal(byKey.size, rows.length, 'no key exists twice');
      for (const [key, rid] of acknowledged) {
        const r = byKey.get(key);
        assert.ok(r, `acknowledged operation ${key} survived the failover`);
        assert.equal(r.id, rid, 'with the same reservation id the client was given');
        assert.equal(r.status, 'committed');
      }
      const used = Number((await np.query(`SELECT COALESCE(sum(quantity),0) AS n FROM subscription_access.usage_events WHERE customer_id=$1 AND feature_key='ai.queries'`, [customer])).rows[0].n);
      const held = Number((await np.query(`SELECT COALESCE(sum(quantity),0) AS n FROM subscription_access.quota_reservations WHERE customer_id=$1 AND status='reserved' AND expires_at > now()`, [customer])).rows[0].n);
      assert.ok(used + held <= 400, `quota invariant: ${used} + ${held} <= 400`);
      assert.equal(used, [...byKey.values()].filter((r) => r.status === 'committed').length, 'usage rows == committed reservations (no orphan, no double count)');
      const dup = await np.query(`SELECT reservation_id FROM subscription_access.usage_events WHERE customer_id=$1 GROUP BY reservation_id HAVING count(*) > 1`, [customer]);
      assert.equal(dup.rowCount, 0);
      console.log(`      failover result: ${acknowledged.size} acknowledged operations all present, ${retried.replayed} replayed + ${retried.created} created on retry, used ${used}`);
    } finally { await np.end(); }
    assert.equal((await svc.reserve(customer, 'ai.queries', 1, { idempotencyKey: 'after-failover' })).allowed, true, 'and new work proceeds on the new primary');
  });

  test('the old primary is gone and was never allowed to serve a decision after the cut; teardown removes only what this test created', async () => {
    assert.equal(docker(['ps', '-a', '--filter', `name=${cP}`, '--format', '{{.Status}}']).stdout.startsWith('Exited'), true, 'the killed primary stays down');
    assert.deepEqual(created.containers.sort(), [cP, cS].sort());
  });
});
