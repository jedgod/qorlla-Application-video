// Creates the next PostgreSQL migration from the difference between prisma/migrations and prisma/schema.prisma.
//   SHADOW_DATABASE_URL=postgresql://user:pw@host:5432/scratch npm run db:new-migration -- add_something
// The scratch database is only used to replay the existing migrations; it must be disposable and empty. Review the SQL before committing.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { root, schemaFor } from './lib.mjs';

const name = (process.argv[2] || '').toLowerCase();
const shadow = process.env.SHADOW_DATABASE_URL;
if (!/^[a-z][a-z0-9_]{2,40}$/.test(name)) { console.error('usage: npm run db:new-migration -- <name_with_underscores>'); process.exit(2); }
if (!shadow) { console.error('SHADOW_DATABASE_URL (a scratch PostgreSQL database) is required'); process.exit(2); }

const dir = path.join(root, 'prisma', 'migrations');
const next = String(Math.max(0, ...readdirSync(dir).map((d) => parseInt(d, 10)).filter(Number.isFinite)) + 1).padStart(4, '0');
const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma');
const r = spawnSync(bin, ['migrate', 'diff', '--from-migrations', 'prisma/migrations', '--to-schema-datamodel', schemaFor('postgresql'), '--shadow-database-url', shadow, '--script'],
  { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, DATABASE_URL: shadow } });
if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }
const sql = r.stdout.replace(/\r\n/g, '\n');
if (/^-- This is an empty migration\./m.test(sql) || !sql.trim()) { console.log('schema.prisma has no changes that are missing from the migrations; nothing written'); process.exit(0); }
const out = path.join(dir, `${next}_${name}`);
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'migration.sql'), sql);
console.log(`wrote prisma/migrations/${next}_${name}/migration.sql: review it, then commit it with the schema change`);
