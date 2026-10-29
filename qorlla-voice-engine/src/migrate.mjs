// Applies sql/*.sql in order. Run with a migration role (not the runtime role):  DATABASE_URL=... npm run db:migrate
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pool } from './store.mjs';

export async function migrate(db = pool) {
  const dir = new URL('../sql/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  for (const f of files) await db.query(await readFile(new URL(f, dir), 'utf8'));
  return files;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { console.log('voice migrations complete:', (await migrate()).join(', ')); } finally { await pool.end(); }
}
