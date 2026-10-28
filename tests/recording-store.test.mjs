// Recording storage building blocks against REAL PostgreSQL and the real filesystem object store: node --test tests/recording-store.test.mjs
// Needs the dev Meet database (npm run dev:stack) or TEST_DATABASE_URL; skips the database tests (and says so) when none is reachable.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadKeyring, newDataKey, encryptChunk, decryptChunk } from '../qorlla-meet-video/server/recording-crypto.mjs';
import { createObjectStore } from '../qorlla-meet-video/server/recording-objects.mjs';
import { makeAudit, verifyChain } from '../qorlla-meet-video/server/recording-audit.mjs';

const require = createRequire(import.meta.url);
const key = () => crypto.randomBytes(32).toString('base64');

test('chunk encryption: authenticated, bound to recording and position, tamper-evident', () => {
  const dek = newDataKey(), rid = crypto.randomUUID(), plain = crypto.randomBytes(5000), blob = encryptChunk(dek, rid, 3, plain);
  assert.equal(blob.length, plain.length + 28); assert.equal(Buffer.compare(decryptChunk(dek, rid, 3, blob), plain), 0); assert.equal(blob.includes(plain.subarray(0, 32)), false);
  const bad = Buffer.from(blob); bad[100] ^= 1; assert.throws(() => decryptChunk(dek, rid, 3, bad));                                   // modified byte
  assert.throws(() => decryptChunk(dek, rid, 4, blob));                                                                                // reordered / replayed at another position
  assert.throws(() => decryptChunk(dek, crypto.randomUUID(), 3, blob));                                                                // moved to another recording
  assert.throws(() => decryptChunk(newDataKey(), rid, 3, blob)); assert.throws(() => decryptChunk(dek, rid, 3, blob.subarray(0, 20)));
  assert.notEqual(encryptChunk(dek, rid, 3, plain).toString('hex'), blob.toString('hex'));                                              // fresh nonce every time
});

test('keyring: data keys are wrapped, bound to the recording, and old master keys keep working after rotation', () => {
  const k1 = key(), k2 = key(); const ring1 = loadKeyring({ RECORDING_MASTER_KEYS: JSON.stringify({ a: k1 }), RECORDING_ACTIVE_KEY_ID: 'a' }); assert.equal(ring1.ready, true);
  const dek = newDataKey(), rid = crypto.randomUUID(), { keyId, wrapped } = ring1.wrap(dek, rid); assert.equal(keyId, 'a'); assert.equal(wrapped.includes(dek), false);
  assert.equal(Buffer.compare(ring1.unwrap('a', wrapped, rid), dek), 0); assert.throws(() => ring1.unwrap('a', wrapped, crypto.randomUUID()));
  const ring2 = loadKeyring({ RECORDING_MASTER_KEYS: JSON.stringify({ a: k1, b: k2 }), RECORDING_ACTIVE_KEY_ID: 'b' });                  // rotate: new recordings use b, old ones still open
  assert.equal(ring2.wrap(newDataKey(), rid).keyId, 'b'); assert.equal(Buffer.compare(ring2.unwrap('a', wrapped, rid), dek), 0);
  assert.throws(() => loadKeyring({ RECORDING_MASTER_KEYS: JSON.stringify({ b: k2 }), RECORDING_ACTIVE_KEY_ID: 'b' }).unwrap('a', wrapped, rid));   // a dropped key = unrecoverable
  for (const env of [{}, { RECORDING_MASTER_KEYS: '{' }, { RECORDING_MASTER_KEYS: JSON.stringify({ a: 'short' }), RECORDING_ACTIVE_KEY_ID: 'a' }, { RECORDING_MASTER_KEYS: JSON.stringify({ a: k1 }), RECORDING_ACTIVE_KEY_ID: 'zzz' }]) assert.equal(loadKeyring(env).ready, false);
});

test('object store: private directory, path-safe keys, put/get/delete, nothing outside the root', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrec-')); const s = createObjectStore({ RECORDING_STORE_DIR: dir }); assert.equal(s.ready, true);
  const rid = crypto.randomUUID(), k = rid + '/00000001.bin'; await s.put(k, Buffer.from('ciphertext')); assert.equal((await s.get(k)).toString(), 'ciphertext');
  for (const bad of ['../x', rid + '/../../x', '/etc/passwd', rid + '/abc.bin', 'a/b']) await assert.rejects(() => s.get(bad));
  await s.delete(k); await assert.rejects(() => s.get(k)); await s.removePrefix(rid); assert.equal(fs.existsSync(path.join(dir, rid)), false);
  assert.equal(createObjectStore({}).ready, false); assert.equal(createObjectStore({ RECORDING_STORE: 's3', RECORDING_STORE_DIR: dir }).ready, false);   // S3 is not implemented: refuses instead of pretending
  fs.rmSync(dir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------------------------------------------------------------------------- real PostgreSQL
let pool = null, why = '';
try {
  const { Pool } = require('../qorlla-meet-video/node_modules/pg'); let url = process.env.TEST_DATABASE_URL;
  if (!url) { const s = JSON.parse(fs.readFileSync(new URL('../.dev-stack/secrets.json', import.meta.url), 'utf8')); url = 'postgres://qorlla:' + s.dbPassword + '@127.0.0.1:35432/qorlla_meet'; }
  pool = new Pool({ connectionString: url, max: 12, connectionTimeoutMillis: 3000 }); await pool.query('SELECT 1 FROM recording_audit LIMIT 1');
} catch (e) { why = e.message; pool = null; }
const db = (name, fn) => test(name, { skip: pool ? false : 'no PostgreSQL with the v4.9 migration: ' + why }, fn);
const purge = async (c, sql, params) => { await c.query("SET qorlla.allow_purge = 'on'"); try { return await c.query(sql, params); } finally { await c.query('RESET qorlla.allow_purge'); } };

db('audit chain (real PostgreSQL): concurrent writers cannot fork it; edits and deletes are refused; a bypassed edit is detected', async () => {
  const meeting = crypto.randomUUID(); await pool.query("INSERT INTO meetings(id,title,host_secret_hash) VALUES($1,'chain test','x')", [meeting]);
  const audit = makeAudit(pool);
  try {
    await Promise.all(Array.from({ length: 30 }, (_, i) => audit(meeting, null, null, 'system', 'test.event', { i, nested: { b: 2, a: [1, { z: 1, y: 2 }] } })));
    const v = await verifyChain(pool, meeting); assert.equal(v.ok, true); assert.equal(v.checked, 30);
    const { rows } = await pool.query('SELECT id,prev_hash,hash FROM recording_audit WHERE meeting_id=$1 ORDER BY id', [meeting]);
    assert.equal(new Set(rows.map((r) => r.prev_hash)).size, 30);                                                                           // a single line, no forks
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i].prev_hash, rows[i - 1].hash);
    await assert.rejects(() => pool.query("UPDATE recording_audit SET action='forged' WHERE id=$1", [rows[5].id]), /append-only/);       // refused for every database role
    await assert.rejects(() => pool.query('DELETE FROM recording_audit WHERE id=$1', [rows[5].id]), /append-only/);
    assert.equal((await verifyChain(pool, meeting)).ok, true);
    // someone with maintenance rights bypasses the trigger and edits a row: the chain shows exactly where
    const c = await pool.connect(); try { await purge(c, "UPDATE recording_audit SET detail='{\"i\":999}'::jsonb WHERE id=$1", [rows[10].id]); } finally { c.release(); }
    const broken = await verifyChain(pool, meeting); assert.equal(broken.ok, false); assert.equal(broken.brokenAt, Number(rows[10].id));
    // removing a row from the middle is detected too
    const c2 = await pool.connect(); try { await purge(c2, 'UPDATE recording_audit SET detail=detail WHERE id=$1', [rows[10].id]); await purge(c2, 'DELETE FROM recording_audit WHERE id=$1', [rows[20].id]); } finally { c2.release(); }
    assert.equal((await verifyChain(pool, meeting)).ok, false);
  } finally { const c = await pool.connect(); try { await purge(c, 'DELETE FROM recording_audit WHERE meeting_id=$1', [meeting]); } finally { c.release(); } await pool.query('DELETE FROM meetings WHERE id=$1', [meeting]); }
});

db('consent records (real PostgreSQL) are append-only for every role, and a purge needs an explicit maintenance flag', async () => {
  const meeting = crypto.randomUUID(), host = crypto.randomUUID(), sid = crypto.randomUUID(); await pool.query("INSERT INTO meetings(id,title,host_secret_hash) VALUES($1,'consent test','x')", [meeting]); await pool.query("INSERT INTO participants(id,meeting_id,display_name,role) VALUES($1,$2,'H','host')", [host, meeting]);
  try {
    await pool.query("INSERT INTO recording_sessions(id,meeting_id,requested_by,status,purpose,recipients,retention,controller,privacy_contact,want_video,want_audio,policy_version,retention_days) VALUES($1,$2,$3,'awaiting','p','r','30 days','c','x@y.z',true,true,'v',30)", [sid, meeting, host]);
    const cid = crypto.randomUUID(); await pool.query("INSERT INTO recording_consents(id,session_id,meeting_id,participant_id,participant_name,role,decision,video,audio,notice_reviewed,policy_version,audit_ref) VALUES($1,$2,$3,$4,'H','host','agree',true,true,true,'v',$5)", [cid, sid, meeting, host, crypto.randomUUID()]);
    await assert.rejects(() => pool.query("UPDATE recording_consents SET decision='decline' WHERE id=$1", [cid]), /append-only/); await assert.rejects(() => pool.query('DELETE FROM recording_consents WHERE id=$1', [cid]), /append-only/);
    const aid = crypto.randomUUID(); await pool.query("INSERT INTO ai_consents(id,meeting_id,participant_id,participant_name,purpose,decision,policy_version,audit_ref) VALUES($1,$2,$3,'H','transcription','agree','v',$4)", [aid, meeting, host, crypto.randomUUID()]);
    await assert.rejects(() => pool.query("UPDATE ai_consents SET decision='withdraw' WHERE id=$1", [aid]), /append-only/);
    await assert.rejects(() => pool.query("INSERT INTO ai_consents(id,meeting_id,participant_id,participant_name,purpose,decision,policy_version,audit_ref) VALUES($1,$2,$3,'H','mind_reading','agree','v',$4)", [crypto.randomUUID(), meeting, host, crypto.randomUUID()]));   // only defined purposes
  } finally { const c = await pool.connect(); try { await purge(c, 'DELETE FROM recording_consents WHERE meeting_id=$1', [meeting]); await purge(c, 'DELETE FROM ai_consents WHERE meeting_id=$1', [meeting]); } finally { c.release(); } await pool.query('DELETE FROM recording_sessions WHERE id=$1', [sid]); await pool.query('DELETE FROM meetings WHERE id=$1', [meeting]); }
});

test.after(async () => { await pool?.end(); });
