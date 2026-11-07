// npm test: runs the API tests on a throwaway database.
//   default                       a temporary SQLite file
//   TEST_DATABASE_URL=postgresql://user:pw@host:5432/dbname   the same tests on PostgreSQL (the database must be disposable)
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { generate, prisma, providerOf, root } from './lib.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'qorlla-clips-'));
const url = process.env.TEST_DATABASE_URL || 'file:' + path.join(dir, 'test.db').replace(/\\/g, '/');
const env = { ...process.env, DATABASE_URL: url, NODE_ENV: 'test' };
let code = 1;
try {
  console.log(`# provider: ${providerOf(url)}`);
  const schema = generate(env);
  // a fresh SQLite file needs no reset; on PostgreSQL the tests use unique organizations, so a reused disposable database is fine too
  prisma(['db', 'push', '--schema', schema, '--skip-generate'], env);
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2).length ? process.argv.slice(2) : ['tests/*.test.js']], { cwd: root, env, stdio: 'inherit' });
  code = r.status ?? 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
process.exit(code);
