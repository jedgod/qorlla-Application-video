// Development database initialisation for Qorlla Meet (used by scripts/dev-stack.mjs; runnable on its own against any container you name).
//   node scripts/dev-db-migrate.mjs <container>        e.g. a disposable PostgreSQL container with user "qorlla" and database "qorlla_meet"
//
// What it guarantees (development only; production uses the reviewed deployment path):
//  * migrations run in ONE explicit order, each in a single transaction together with its tracking record, so a failure leaves nothing half-applied;
//  * applied migrations are tracked (qorlla_dev_migrations: name, sha256, time); a recorded migration whose file changed is REFUSED (add a new migration instead;
//    DEV_MIGRATIONS_REAPPLY=1 re-applies it knowingly - every file here is idempotent);
//  * a partially initialised database (base tables missing) and a database that is still missing required columns/tables after migrating are REJECTED,
//    so Meet is never started on a schema it cannot use (which otherwise shows up later as a misleading application error);
//  * startup stops (non-zero exit) on the first failure.
// Not applied here: sql/005_app_role.sql (role/ownership step for deployments) and sql/main_sync.sql (a different database).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql'];   // applied once, to an empty database (some manage their own transaction)
// Order matters: v4_16 needs v4_14/v4_15 (qphone_* tables); v4_17 needs the base meetings/participants; v4_18 needs qphone_accounts (v4_14).
export const ORDERED = ['v4_7_recording_consent.sql', 'v4_8_collab.sql', 'v4_9_recording_storage.sql', 'v4_10_admission.sql', 'v4_11_history.sql', 'v4_12_limit.sql', 'v4_13_phone.sql',
  'v4_14_telephony.sql', 'v4_15_telephony_features.sql', 'v4_16_number_authority.sql', 'v4_17_shield_identity.sql', 'v4_18_billing_hold.sql'];
// What the application code needs from the schema (a missing item means a migration did not apply).
export const REQUIRED_COLUMNS = [['meetings', 'host_account_id'], ['meetings', 'org_id'], ['meetings', 'guest_enabled'], ['participants', 'account_id'], ['qphone_accounts', 'billing_hold'], ['qphone_numbers', 'authority_version'], ['qphone_numbers', 'hold_reason']];
export const REQUIRED_TABLES = ['meetings', 'participants', 'qphone_numbers', 'qphone_accounts', 'qphone_audit', 'qphone_provider_operations', 'qphone_number_outbox', 'qphone_assignment_conflicts'];

const PSQL = ['-v', 'ON_ERROR_STOP=1', '-q', '-U', 'qorlla', '-d', 'qorlla_meet'];
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function migrate({ container, root, env = process.env, log = () => {} }) {
  const sqlDir = path.join(root, 'qorlla-meet-video', 'sql');
  const exec = (args, input) => spawnSync('docker', ['exec', ...(input !== undefined ? ['-i'] : []), container, 'psql', ...args], { input, encoding: 'utf8' });
  const scalar = (sql) => { const r = exec([...PSQL, '-tAc', sql]); if (r.status !== 0) throw new Error('query failed: ' + r.stderr.trim()); return r.stdout.trim(); };
  for (const f of [...BASE, ...ORDERED]) if (!fs.existsSync(path.join(sqlDir, f))) throw new Error('migration file missing: ' + f);

  // 1. base schema: all-or-nothing
  const has = scalar("select (to_regclass('public.meetings') is not null)::int || ',' || (to_regclass('public.participants') is not null)::int");
  if (has === '1,0' || has === '0,1') throw new Error('The database is partially initialised (meetings/participants: ' + has + '). Use a fresh database; refusing to guess.');
  if (has === '0,0') for (const f of BASE) { const r = exec(PSQL, fs.readFileSync(path.join(sqlDir, f))); if (r.status !== 0) throw new Error('base schema step failed: ' + f + '\n' + r.stderr); log('base ' + f); }

  // 2. tracking table
  const t = exec(PSQL, 'CREATE TABLE IF NOT EXISTS qorlla_dev_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());');
  if (t.status !== 0) throw new Error('could not create the migration tracking table\n' + t.stderr);

  // 3. ordered migrations, each atomic with its record
  const applied = [], skipped = [];
  for (const f of ORDERED) {
    const body = fs.readFileSync(path.join(sqlDir, f)), digest = sha(body);
    const rec = scalar("select sha256 from qorlla_dev_migrations where name='" + f + "'");
    if (rec === digest) { skipped.push(f); continue; }
    if (rec && env.DEV_MIGRATIONS_REAPPLY !== '1') throw new Error('Migration ' + f + ' changed after it was applied (recorded ' + rec.slice(0, 12) + ', file ' + digest.slice(0, 12) + '). Add a new migration, or set DEV_MIGRATIONS_REAPPLY=1 to re-apply this idempotent file.');
    const sql = Buffer.concat([body, Buffer.from("\n;\nINSERT INTO qorlla_dev_migrations(name, sha256) VALUES ('" + f + "', '" + digest + "') ON CONFLICT (name) DO UPDATE SET sha256 = EXCLUDED.sha256, applied_at = now();\n")]);
    const r = exec(['-1', ...PSQL], sql);
    if (r.status !== 0) throw new Error('migration failed (rolled back): ' + f + '\n' + r.stderr);
    applied.push(f); log('applied ' + f);
  }

  // 4. the schema must now be what the application needs
  const missing = [];
  for (const tb of REQUIRED_TABLES) if (scalar("select to_regclass('public." + tb + "') is not null") !== 't') missing.push('table ' + tb);
  for (const [tb, col] of REQUIRED_COLUMNS) if (scalar("select count(*) from information_schema.columns where table_schema='public' and table_name='" + tb + "' and column_name='" + col + "'") !== '1') missing.push(tb + '.' + col);
  if (missing.length) throw new Error('The database schema is incomplete after migrating; refusing to start. Missing: ' + missing.join(', '));
  return { applied, skipped };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const container = process.argv[2];
  if (!container) { console.error('usage: node scripts/dev-db-migrate.mjs <container>'); process.exit(2); }
  try { const r = migrate({ container, root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), log: (m) => console.log(m) }); console.log('ok: applied ' + r.applied.length + ', already applied ' + r.skipped.length); }
  catch (e) { console.error(String(e.message || e)); process.exit(1); }
}
