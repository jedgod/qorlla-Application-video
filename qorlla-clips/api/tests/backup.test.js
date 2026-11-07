// Backup + restore check against a REAL PostgreSQL. Skipped unless BACKUP_TEST_PREFIX is set, e.g.
//   BACKUP_TEST_PREFIX="docker exec -i a5-pg" BACKUP_TEST_ADMIN_URL=postgresql://postgres:pw@localhost:5432/postgres npm test
// (the URL is resolved from inside the container). It creates and drops its own databases, and a bucket if S3_TEST_ENDPOINT is set.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backup, verify, parseUrl, upload } from '../scripts/clips-backup.mjs';

const PREFIX = process.env.BACKUP_TEST_PREFIX; const ADMIN = process.env.BACKUP_TEST_ADMIN_URL;
const skip = PREFIX && ADMIN ? false : 'set BACKUP_TEST_PREFIX and BACKUP_TEST_ADMIN_URL to test against a real PostgreSQL';
const env = { ...process.env, PG_EXEC_PREFIX: PREFIX };
const migrations = path.resolve(import.meta.dirname, '../prisma/migrations');

function psql(db, input, args = []) {
  const a = parseUrl(ADMIN); const pre = PREFIX.split(/\s+/); pre.splice(2, 0, '-e', 'PGPASSWORD');
  const r = spawnSync(pre[0], [...pre.slice(1), 'psql', '-h', a.host, '-p', a.port, '-U', a.user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-tAq', ...args, ...(input ? ['-f', '-'] : [])],
    { input, encoding: 'utf8', env: { ...process.env, PGPASSWORD: a.password } });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
  return r.stdout.trim();
}

describe('backup and restore check', { skip }, () => {
  const src = 'bk_src_' + Date.now().toString(36); let dir; let url;
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clips-backup-'));
    psql('postgres', null, ['-c', `CREATE DATABASE ${src}`]);
    for (const d of readdirSync(migrations).filter((x) => /^\d{4}_/.test(x)).sort()) psql(src, readFileSync(path.join(migrations, d, 'migration.sql'), 'utf8'));
    psql(src, `INSERT INTO "Organization"(id,name,slug,"updatedAt") VALUES ('o1','Acme','acme',now());
      INSERT INTO "User"(id,email,"organizationId","updatedAt") VALUES ('u1','a@acme.test','o1',now());
      INSERT INTO "Clip"(id,title,"ownerId","organizationId","updatedAt") VALUES ('c1','Standup','u1','o1',now()),('c2','Demo','u1','o1',now());`);
    const a = parseUrl(ADMIN); url = `postgresql://${a.user}:${encodeURIComponent(a.password)}@${a.host}:${a.port}/${src}`;
  });
  after(() => {
    try { psql('postgres', null, ['-c', `DROP DATABASE IF EXISTS ${src} WITH (FORCE)`]); } catch (e) { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  });
  const scratchLeft = () => psql('postgres', null, ['-c', "SELECT count(*) FROM pg_database WHERE datname LIKE 'restore_check_%'"]);

  test('a dump restores into a scratch database, the rows are all there, and the scratch database is dropped afterwards', async () => {
    const b = await backup({ databaseUrl: url, outDir: dir, env });
    assert.match(path.basename(b.file), /^clips-.*\.dump$/); assert.ok(b.bytes > 1000);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.partial')).length, 0);
    const v = await verify({ dumpFile: b.file, adminUrl: ADMIN, env });
    assert.equal(v.counts.Clip, 2); assert.equal(v.counts.User, 1); assert.equal(v.counts.Organization, 1); assert.equal(v.counts.ClipReport, 0);
    assert.equal(scratchLeft(), '0');
  });

  test('a truncated dump, an empty file and garbage are all rejected, and nothing is left behind', async () => {
    const good = (await backup({ databaseUrl: url, outDir: dir, env, now: new Date(Date.now() + 1000) })).file;
    const bytes = readFileSync(good);
    const cut = path.join(dir, 'cut.dump'); writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const empty = path.join(dir, 'empty.dump'); writeFileSync(empty, '');
    const junk = path.join(dir, 'junk.dump'); writeFileSync(junk, Buffer.alloc(4096, 7));
    for (const f of [cut, empty, junk]) await assert.rejects(verify({ dumpFile: f, adminUrl: ADMIN, env }), undefined, f);
    await assert.rejects(verify({ dumpFile: path.join(dir, 'missing.dump'), adminUrl: ADMIN, env }));
    assert.equal(scratchLeft(), '0');
  });

  test('a dump of a database that lacks the tables fails the check', async () => {
    const other = 'bk_other_' + Date.now().toString(36);
    psql('postgres', null, ['-c', `CREATE DATABASE ${other}`]);
    try {
      psql(other, 'CREATE TABLE unrelated(id int); INSERT INTO unrelated VALUES (1);');
      const a = parseUrl(ADMIN);
      const b = await backup({ databaseUrl: `postgresql://${a.user}:${encodeURIComponent(a.password)}@${a.host}:${a.port}/${other}`, outDir: dir, env, now: new Date(Date.now() + 5000) });
      await assert.rejects(verify({ dumpFile: b.file, adminUrl: ADMIN, env }), /missing/);
    } finally { psql('postgres', null, ['-c', `DROP DATABASE IF EXISTS ${other} WITH (FORCE)`]); }
    assert.equal(scratchLeft(), '0');
  });

  test('a failed dump (database does not exist) leaves no file and the error never contains the password', async () => {
    const a = parseUrl(ADMIN); const bad = `postgresql://${a.user}:${encodeURIComponent(a.password)}@${a.host}:${a.port}/no_such_db_${Date.now()}`;
    const d2 = mkdtempSync(path.join(os.tmpdir(), 'clips-backup-bad-'));
    try {
      await assert.rejects(backup({ databaseUrl: bad, outDir: d2, env }), (e) => { assert.ok(!String(e.message).includes(a.password), 'the password must not appear in errors'); return true; });
      assert.deepEqual(readdirSync(d2), []);
    } finally { rmSync(d2, { recursive: true, force: true }); }
  });

  test('retention keeps the newest N dumps', async () => {
    const d3 = mkdtempSync(path.join(os.tmpdir(), 'clips-backup-keep-'));
    try {
      for (let i = 0; i < 4; i++) await backup({ databaseUrl: url, outDir: d3, keep: 2, env, now: new Date(Date.UTC(2030, 0, 1 + i)) });
      assert.deepEqual(readdirSync(d3).sort().map((f) => f.slice(6, 16)), ['2030-01-03', '2030-01-04']);
    } finally { rmSync(d3, { recursive: true, force: true }); }
  });

  test('the dump can be copied to object storage', { skip: process.env.S3_TEST_ENDPOINT ? false : 'set S3_TEST_ENDPOINT' }, async () => {
    const { S3Client, CreateBucketCommand, GetObjectCommand, DeleteObjectCommand, DeleteBucketCommand } = await import('@aws-sdk/client-s3');
    const bucket = 'clips-backup-test-' + Date.now().toString(36);
    const s3env = { BACKUP_S3_BUCKET: bucket, BACKUP_S3_ENDPOINT: process.env.S3_TEST_ENDPOINT, BACKUP_S3_ACCESS_KEY: process.env.S3_TEST_ACCESS_KEY, BACKUP_S3_SECRET_KEY: process.env.S3_TEST_SECRET_KEY, BACKUP_S3_PREFIX: 'nightly/' };
    const client = new S3Client({ region: 'us-east-1', endpoint: s3env.BACKUP_S3_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: s3env.BACKUP_S3_ACCESS_KEY, secretAccessKey: s3env.BACKUP_S3_SECRET_KEY } });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    const f = path.join(dir, 'copy.dump'); copyFileSync((await backup({ databaseUrl: url, outDir: dir, env, now: new Date(Date.now() + 9000) })).file, f);
    try {
      const r = await upload(f, s3env); assert.equal(r.key, 'nightly/copy.dump');
      const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: r.key }));
      assert.deepEqual(Buffer.from(await got.Body.transformToByteArray()), readFileSync(f));
      await assert.rejects(upload(f, { ...s3env, BACKUP_S3_BUCKET: '' }), /BACKUP_S3_BUCKET/);
    } finally { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: 'nightly/copy.dump' })).catch(() => {}); await client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => {}); }
  });
});
