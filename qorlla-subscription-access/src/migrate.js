/**
 * Migration runner. Run it as the MIGRATOR role (the owner of the tables), never as an application role.
 *  - Each file runs in its own transaction: a failing migration leaves nothing behind.
 *  - Applied files are recorded with a SHA-256 checksum; editing an applied file is refused.
 *  - An advisory lock serialises concurrent runners (several instances starting at once).
 */

import pg from 'pg';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');

export async function migrate({ pool, connectionString, dir = DEFAULT_DIR, log = () => {} } = {}) {
  const own = !pool;
  const p = pool || new pg.Pool({ connectionString: connectionString || process.env.DATABASE_URL, max: 1 });
  const client = await p.connect();
  client.on('error', () => {});                       // a connection lost mid-run surfaces as a rejected query, not a crash
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', ['qorlla-subscription-access:migrate']);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map((await client.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version, r.checksum]));
    const files = (await readdir(dir)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
    for (const f of files) {
      const sql = await readFile(join(dir, f), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      if (done.has(f)) {
        if (done.get(f) !== sum) throw new Error(`migration ${f} was changed after it was applied (checksum mismatch)`);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [f, sum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        err.message = `migration ${f} failed and was rolled back: ${err.message}`;
        throw err;
      }
      log(`applied ${f}`);
      applied.push(f);
    }
    return applied;
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', ['qorlla-subscription-access:migrate']); } catch { /* connection gone */ }
    client.release();
    if (own) await p.end();
  }
}
