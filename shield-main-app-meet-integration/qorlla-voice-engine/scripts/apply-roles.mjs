// Applies deploy/roles.sql after the migrations (run by the migration role). Needs APP_ROLE; SCHEMA defaults to public. The role itself is created by the database bootstrap (deploy/postgres-init.sh).
import { readFileSync } from 'node:fs';
import pg from 'pg';

const role = process.env.APP_ROLE; if (!role || !/^[a-z_][a-z0-9_]*$/.test(role)) { console.error('APP_ROLE is required (lowercase letters, digits, underscore)'); process.exit(1); }
const schema = process.env.SCHEMA || 'public'; if (!/^[a-z_][a-z0-9_]*$/.test(schema)) { console.error('invalid SCHEMA'); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const owner = (await pool.query('SELECT current_user AS u')).rows[0].u;
  const sql = readFileSync(new URL('../deploy/roles.sql', import.meta.url), 'utf8').replaceAll('{{APP_ROLE}}', role).replaceAll('{{APP_PASSWORD}}', 'unused-role-already-exists').replaceAll('{{SCHEMA}}', schema).replaceAll('{{OWNER}}', owner);
  await pool.query(sql); console.log(`least-privilege grants applied for ${role} on ${schema}`);
} finally { await pool.end(); }
