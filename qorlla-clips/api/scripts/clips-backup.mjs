#!/usr/bin/env node
/**
 * Qorlla Clips: PostgreSQL backup and RESTORE CHECK. A backup that was never restored is a hope, not a backup.
 *
 *   node scripts/clips-backup.mjs backup --out <dir> [--keep 14] [--upload]
 *   node scripts/clips-backup.mjs verify <dump-file>
 *
 * Environment
 *   DATABASE_URL         the live database (backup only; read-only access is enough)
 *   RESTORE_ADMIN_URL    a server where a scratch database may be created and dropped (default: DATABASE_URL's server, database "postgres").
 *                        Use a NON-production server when you can. The scratch database has a random name and is always dropped.
 *   PG_EXEC_PREFIX       optional, to run pg_dump/pg_restore/psql somewhere else, e.g. "docker exec -i my-postgres" (the URLs are then
 *                        resolved from inside that container). Plain words only: it is split on spaces and run without a shell.
 *   BACKUP_S3_BUCKET     with --upload: copy the dump to this bucket (BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, BACKUP_S3_ACCESS_KEY,
 *                        BACKUP_S3_SECRET_KEY, BACKUP_S3_PREFIX are read; the credentials are never printed)
 *
 * "verify" restores the dump into the scratch database, checks that every table exists and counts the rows. It exits non-zero when
 * the dump is empty, truncated, or does not restore. It is NOT point-in-time recovery: it proves one dump restores, nothing more.
 */
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_TABLES = ['Organization', 'User', 'Clip', 'Playlist', 'ClipShare', 'Notification', 'PlaybackEvent', 'ClipReport', 'AuditLog'];

export function parseUrl(url) {
  const u = new URL(url);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('not a PostgreSQL URL');
  return { host: u.hostname, port: u.port || '5432', user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), db: decodeURIComponent(u.pathname.slice(1)) };
}

function prefixFrom(env) {
  const p = String(env.PG_EXEC_PREFIX || '').trim().split(/\s+/).filter(Boolean);
  if (p[0] === 'docker' && p[1] === 'exec') p.splice(2, 0, '-e', 'PGPASSWORD');     // pass the password by environment, never on the command line
  return p;
}

/** Runs a PostgreSQL client tool without a shell. stdin/stdout can be files; the password goes in PGPASSWORD. */
function pg(tool, args, conn, env, { stdinFile, stdoutFile } = {}) {
  const pre = prefixFrom(env); const [cmd, ...rest] = pre.length ? [...pre, tool, ...args] : [tool, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, rest, { env: { ...process.env, PGPASSWORD: conn.password }, stdio: [stdinFile ? 'pipe' : 'ignore', stdoutFile ? 'pipe' : 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    if (stdinFile) { const s = createReadStream(stdinFile); s.on('error', reject); s.pipe(child.stdin); child.stdin.on('error', () => { /* tool exited early */ }); }
    if (stdoutFile) { const w = createWriteStream(stdoutFile); child.stdout.pipe(w); } else child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}
const connArgs = (c, db) => ['-h', c.host, '-p', c.port, '-U', c.user, '-d', db ?? c.db];

export async function backup({ databaseUrl, outDir, keep = 14, env = process.env, now = new Date() }) {
  const c = parseUrl(databaseUrl);
  mkdirSync(outDir, { recursive: true });
  const name = `clips-${now.toISOString().replace(/[:.]/g, '-')}.dump`;
  const tmp = path.join(outDir, name + '.partial'); const final = path.join(outDir, name);
  const r = await pg('pg_dump', ['-Fc', '--no-owner', '--no-privileges', ...connArgs(c)], c, env, { stdoutFile: tmp });
  if (r.code !== 0) { rmSync(tmp, { force: true }); throw new Error('pg_dump failed: ' + r.err.trim().split('\n').pop()); }
  if (!existsSync(tmp) || statSync(tmp).size < 100) { rmSync(tmp, { force: true }); throw new Error('pg_dump produced an empty file'); }
  renameSync(tmp, final);                                                           // a half-written file never carries the final name
  const old = readdirSync(outDir).filter((f) => /^clips-.*\.dump$/.test(f)).sort().slice(0, -Math.max(1, keep));
  for (const f of old) rmSync(path.join(outDir, f), { force: true });
  return { file: final, bytes: statSync(final).size, pruned: old.length };
}

/** Restores a dump into a throwaway database, checks it, and always drops that database. Returns row counts. */
export async function verify({ dumpFile, adminUrl, env = process.env }) {
  if (!existsSync(dumpFile) || statSync(dumpFile).size < 100) throw new Error('the dump file is missing or empty');
  const a = parseUrl(adminUrl);
  const scratch = 'restore_check_' + randomBytes(5).toString('hex');                // generated here, so it is a safe identifier
  const sql = async (db, text) => { const r = await pg('psql', [...connArgs(a, db), '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', text], a, env); if (r.code !== 0) throw new Error(r.err.trim().split('\n').pop() || 'psql failed'); return r.out.trim(); };
  await sql(a.db, `CREATE DATABASE ${scratch}`);
  try {
    const r = await pg('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', ...connArgs(a, scratch)], a, env, { stdinFile: dumpFile });
    if (r.code !== 0) throw new Error('the dump does not restore: ' + r.err.trim().split('\n').pop());
    const counts = {};
    for (const t of REQUIRED_TABLES) {
      const exists = await sql(scratch, `SELECT to_regclass('public."${t}"') IS NOT NULL`);
      if (exists !== 't') throw new Error(`table "${t}" is missing from the restored database`);
      counts[t] = Number(await sql(scratch, `SELECT count(*) FROM "${t}"`));
    }
    return { database: scratch, counts };
  } finally {
    try { await sql(a.db, `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`); } catch (e) { console.error(`WARNING: could not drop ${scratch}: ${e.message}`); }
  }
}

export async function upload(file, env = process.env) {
  if (!env.BACKUP_S3_BUCKET) throw new Error('BACKUP_S3_BUCKET is not set');
  const { S3Client } = await import('@aws-sdk/client-s3'); const { Upload } = await import('@aws-sdk/lib-storage');
  const client = new S3Client({ region: env.BACKUP_S3_REGION || 'us-east-1', endpoint: env.BACKUP_S3_ENDPOINT || undefined, forcePathStyle: !!env.BACKUP_S3_ENDPOINT,
    credentials: env.BACKUP_S3_ACCESS_KEY ? { accessKeyId: env.BACKUP_S3_ACCESS_KEY, secretAccessKey: env.BACKUP_S3_SECRET_KEY || '' } : undefined });
  const key = (env.BACKUP_S3_PREFIX ? env.BACKUP_S3_PREFIX.replace(/\/+$/, '') + '/' : '') + path.basename(file);
  await new Upload({ client, params: { Bucket: env.BACKUP_S3_BUCKET, Key: key, Body: createReadStream(file) } }).done();
  return { bucket: env.BACKUP_S3_BUCKET, key };
}

async function main(argv, env) {
  const [cmd, ...rest] = argv;
  const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === 'backup') {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    const r = await backup({ databaseUrl: env.DATABASE_URL, outDir: opt('--out') || 'backups', keep: Number(opt('--keep') || 14), env });
    console.log(`backup written: ${r.file} (${r.bytes} bytes), ${r.pruned} old file(s) removed`);
    if (rest.includes('--upload')) { const u = await upload(r.file, env); console.log(`uploaded to ${u.bucket}/${u.key}`); }
    return;
  }
  if (cmd === 'verify') {
    const file = rest[0]; if (!file) throw new Error('usage: verify <dump-file>');
    const admin = env.RESTORE_ADMIN_URL || (() => { const c = parseUrl(env.DATABASE_URL || ''); return `postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/postgres`; })();
    const r = await verify({ dumpFile: file, adminUrl: admin, env });
    console.log('restore OK (scratch database dropped). Rows: ' + Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(' '));
    return;
  }
  throw new Error('usage: clips-backup.mjs backup --out <dir> [--keep N] [--upload] | verify <dump-file>');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
}
