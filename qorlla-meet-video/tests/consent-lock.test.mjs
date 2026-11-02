import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { withConsentLock } from '../server/consent-lock.mjs';

// Review finding M2: a sequence number is taken at INSERT time but becomes visible at COMMIT time. This runs against a real PostgreSQL
// (TEST_PG_URL, a scratch database; default the unit-test container) with random delays between "take the number" and "commit".
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
const MEETING = '22222222-2222-2222-2222-222222222222';

async function scratch() {
  const admin = new pg.Pool({ connectionString: URL, max: 2 }); const name = 'cl_' + Math.random().toString(36).slice(2, 10);
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ connectionString: URL.replace(/\/[^/]*$/, '/' + name), max: 40 });
  pool.on('error', () => {});          // the scratch database is dropped with FORCE at the end: idle clients being cut off is expected
  await pool.query('CREATE SEQUENCE s; CREATE TABLE t(seq bigint DEFAULT nextval(\'s\'), who int, committed_at timestamptz DEFAULT clock_timestamp())');
  return { pool, drop: async () => { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); } };
}
const insertWithDelay = (c, who) => c.query('INSERT INTO t(who) VALUES($1) RETURNING seq::int', [who]).then(async (r) => { await c.query('SELECT pg_sleep($1)', [Math.random() * 0.05]); return r.rows[0].seq; });

test('under the consent lock, numbers are handed out in commit order (a reader that has seen N has seen everything below N)', async () => {
  const db = await scratch();
  try {
    const finished = [];
    await Promise.all(Array.from({ length: 30 }, (_, i) => withConsentLock(db.pool, MEETING, (c) => insertWithDelay(c, i)).then((seq) => finished.push(seq))));
    assert.equal(finished.length, 30);
    assert.deepEqual(finished, [...finished].sort((a, b) => a - b), 'commit order = number order');
  } finally { await db.drop(); }
});

test('control: WITHOUT the lock the same workload does commit out of number order (this is the bug the lock removes)', async () => {
  const db = await scratch();
  try {
    let inverted = false;
    for (let round = 0; round < 5 && !inverted; round += 1) {
      const finished = [];
      await Promise.all(Array.from({ length: 30 }, (_, i) => (async () => { const c = await db.pool.connect(); try { await c.query('BEGIN'); const seq = await insertWithDelay(c, i); await c.query('COMMIT'); finished.push(seq); } finally { c.release(); } })()));
      inverted = finished.some((s, i) => i > 0 && s < finished[i - 1]);
    }
    assert.ok(inverted, 'with random delays, an unlocked workload commits out of order');
  } finally { await db.drop(); }
});

test('the lock is per meeting: another meeting is not held up, and an error rolls back and releases', async () => {
  const db = await scratch();
  try {
    let slowDone = false;
    const slow = withConsentLock(db.pool, MEETING, async (c) => { await c.query('SELECT pg_sleep(1.5)'); return 'slow'; }).then(() => { slowDone = true; });
    await new Promise((r) => setTimeout(r, 200));          // the slow holder has the lock by now
    await withConsentLock(db.pool, '33333333-3333-3333-3333-333333333333', async () => 'fast'); assert.equal(slowDone, false, 'a different meeting does not wait for it');
    await slow;
    await assert.rejects(withConsentLock(db.pool, MEETING, async (c) => { await c.query('INSERT INTO t(who) VALUES(1)'); throw new Error('boom'); }), /boom/);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM t')).rows[0].n, 0, 'rolled back');
    assert.equal(await withConsentLock(db.pool, MEETING, async () => 'again'), 'again', 'lock released after the error');
  } finally { await db.drop(); }
});
