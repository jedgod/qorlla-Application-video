// Fails when prisma/schema.prisma has changed without a matching migration in prisma/migrations (run in CI with a scratch PostgreSQL).
//   SHADOW_DATABASE_URL=postgresql://user:pw@host:5432/scratch node scripts/check-migrations.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { root, schemaFor } from './lib.mjs';

const shadow = process.env.SHADOW_DATABASE_URL;
if (!shadow) { console.error('SHADOW_DATABASE_URL (a scratch PostgreSQL database) is required'); process.exit(2); }
const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma');
const r = spawnSync(bin, ['migrate', 'diff', '--from-migrations', 'prisma/migrations', '--to-schema-datamodel', schemaFor('postgresql'), '--shadow-database-url', shadow, '--exit-code'],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, DATABASE_URL: shadow } });
if (r.status === 0) console.log('migrations are in sync with schema.prisma');
else if (r.status === 2) console.error('\nschema.prisma has changes that no migration contains. Create one (see README: "Changing the schema").');
process.exit(r.status === 0 ? 0 : 1);
