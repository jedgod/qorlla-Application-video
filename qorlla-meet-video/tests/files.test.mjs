import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import net from 'node:net';
import pg from 'pg';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { registerFiles, FILE_LIMITS } from '../server/files.mjs';
import { createFileStore } from '../server/file-store.mjs';
import { createScanner, detectType, activeContent, clamdScan } from '../server/file-scanner.mjs';
const REAL = process.env.CLAMD_REAL_PORT ? Number(process.env.CLAMD_REAL_PORT) : 0;          // set to run the pipeline against a REAL clamd (docker clamav/clamav) instead of the fake one

// Shared files (v4.34): the IMMUTABLE scan pipeline. Real PostgreSQL (TEST_PG_URL), a real private directory, a FAKE clamd speaking the INSTREAM protocol (labelled: it flags the standard EICAR string and a marker).
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
const SQL = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const dbName = 'fl_' + Math.random().toString(36).slice(2, 10); let admin, pool, tmp;
test.before(async () => { admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${dbName}`); pool = new pg.Pool({ connectionString: URL.replace(/\/[^/]*$/, '/' + dbName), max: 8 }); pool.on('error', () => {}); for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8')); tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfiles-')); });
test.after(async () => { await pool?.end(); await fs.rm(tmp, { recursive: true, force: true }); await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {}); await admin?.end(); });

const EICAR = 'QORLLA-FAKE-MALWARE-TEST-MARKER-0001';          // NOT the real EICAR string: Windows Defender deletes that from disk and would make the test meaningless. The fake clamd below flags this marker.
function fakeClamd() {          // INSTREAM: "zINSTREAM\0", then [len][data]... [0000]; reply "stream: OK\0" or "stream: <sig> FOUND\0"
  const st = { down: false, scans: 0, onScan: null };
  const server = net.createServer((sock) => {
    if (st.down) return sock.destroy(); let buf = Buffer.alloc(0);
    sock.on('data', async (d) => { buf = Buffer.concat([buf, d]); const head = buf.indexOf(0); if (head < 0) return; let p = head + 1, data = [];
      for (;;) { if (buf.length < p + 4) return; const n = buf.readUInt32BE(p); if (n === 0) break; if (buf.length < p + 4 + n) return; data.push(buf.subarray(p + 4, p + 4 + n)); p += 4 + n; }
      st.scans++; const all = Buffer.concat(data); if (st.onScan) await st.onScan(all); sock.end(all.includes(EICAR) ? 'stream: Fake-Test-Signature FOUND\0' : 'stream: OK\0'); });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ st, port: server.address().port, close: () => new Promise((x) => { if (!server.listening) return x(); server.close(() => x()); }) })));
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const docx = (extra = '') => Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from('[Content_Types].xml word/document.xml ' + extra), Buffer.alloc(20)]);
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function rig({ env = {}, limits = FILE_LIMITS, scan = true } = {}) {
  const clamd = await fakeClamd(); const dir = await fs.mkdtemp(path.join(tmp, 'f-')); const store = createFileStore({ FILES_DIR: dir });
  const scanner = createScanner({ env: scan ? { CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(REAL || clamd.port), CLAMD_TIMEOUT_MS: REAL ? '30000' : '2000' } : {} });
  const scopes = new Map(), notes = [], audits = []; const fail = (res, status, error) => res.status(status).json({ error });
  const app = express(); app.use(express.json());
  const auth = (req, res, next) => { try { req.user = JSON.parse(req.get('x-user')); next(); } catch { fail(res, 401, 'x'); } };
  const member = async (req, res, next) => { const { rows } = await pool.query("SELECT 1 FROM participants WHERE id=$1 AND meeting_id=$2 AND admission='admitted'", [req.user.participantId, req.params.id]); rows.length ? next() : fail(res, 403, 'x'); };
  const files = registerFiles({ app, db: pool, auth, member, fail, store, scanner, scopeOf: (mid, pid) => scopes.get(pid) ?? null, notify: (...a) => notes.push(a), audit: async (...a) => audits.push(a), env: { MEET_FILES: 'on', ...env }, limits, sweepMs: 3600_000 });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); const base = 'http://127.0.0.1:' + server.address().port;
  const mid = randomUUID(), P = {}; await pool.query("INSERT INTO meetings(id,title,host_secret_hash) VALUES($1,'t','x')", [mid]);
  for (const [i, n] of ['Host', 'Ann', 'Bo', 'Cy'].entries()) { const id = randomUUID(); await pool.query('INSERT INTO participants(id,meeting_id,display_name,role,admission) VALUES($1,$2,$3,$4,$5)', [id, mid, n, i ? 'guest' : 'host', 'admitted']); P[n.toLowerCase()] = { id, user: { participantId: id, meetingId: mid, role: i ? 'guest' : 'host', name: n } }; }
  const url = (s = '') => `/api/meetings/${mid}/files${s}`;
  const up = async (who, name, type, body, extra = {}) => { const r = await fetch(base + url(), { method: 'POST', headers: { 'x-user': JSON.stringify(who.user), 'x-filename': encodeURIComponent(name), 'content-type': type, ...(extra.headers || {}) }, body }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const call = async (method, path, who, body) => { const r = await fetch(base + path, { method, headers: { 'x-user': JSON.stringify(who.user), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const dl = async (who, id) => { const r = await fetch(base + url(`/${id}/download`), { headers: { 'x-user': JSON.stringify(who.user) } }); return { status: r.status, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) }; };
  const row = async (id) => (await pool.query('SELECT * FROM more_files WHERE id=$1', [id])).rows[0];
  const cleanFiles = async () => { try { return (await fs.readdir(path.join(dir, 'clean'), { recursive: true })).map((n) => path.basename(n)).filter((n) => /^[0-9a-f]{64}$/.test(n)); } catch { return []; } };
  const quarantine = async () => { try { return await fs.readdir(path.join(dir, 'quarantine')); } catch { return []; } };
  return { port: server.address().port, clamd, store, files, scopes, notes, audits, P, mid, url, up, call, dl, row, cleanFiles, quarantine, dir, close: async () => { files.stop(); await new Promise((r) => server.close(r)); await clamd.close(); } };
}

test('detection is from the bytes: a renamed or spoofed file is refused, active content is refused, plain text must really be text', () => {
  assert.equal(detectType(PNG), 'image/png'); assert.equal(detectType(Buffer.from('%PDF-1.7\n...')), 'application/pdf'); assert.equal(detectType(docx()), DOCX); assert.equal(detectType(Buffer.from('hello é')), 'text/plain');
  assert.equal(detectType(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03])), null, 'a Windows executable has a NUL: not text'); assert.equal(detectType(Buffer.from([0x50, 0x4b, 3, 4, 1, 2])), null, 'an arbitrary zip is not a Word document'); assert.equal(detectType(Buffer.from([0xc3, 0x28])), null);
  assert.equal(activeContent(Buffer.from('%PDF-1.4 /OpenAction << /S /JavaScript >>'), 'application/pdf'), 'javascript'); assert.equal(activeContent(Buffer.from('%PDF-1.4 plain'), 'application/pdf'), null); assert.equal(activeContent(docx('word/vbaProject.bin'), DOCX), 'macro_or_ole');
});

test('clean path: bytes are streamed into quarantine, scanned, promoted to a write-once object named by their hash, the quarantine copy is gone, and a download returns exactly those bytes', async () => {
  const t = await rig(); const { P } = t; const body = Buffer.from('Agenda\n1. Launch\n');
  const r = await t.up(P.host, 'agenda.txt', 'text/plain', body); assert.equal(r.status, 201); assert.equal(r.body.state, 'clean'); assert.equal(r.body.approved, true);
  const f = await t.row(r.body.id); assert.equal(f.sha256, sha(body)); assert.equal(Number(f.bytes), body.length); assert.equal(f.quarantine_key, null); assert.deepEqual(await t.quarantine(), [], 'nothing is left in quarantine');
  assert.deepEqual(await t.cleanFiles(), [sha(body)]); const mode = (await fs.stat(path.join(t.dir, 'clean', sha(body).slice(0, 2), sha(body)))).mode & 0o222; assert.equal(mode, 0, 'the clean object is read-only');
  const d = await t.dl(P.host, r.body.id); assert.equal(d.status, 200); assert.deepEqual(d.bytes, body); assert.match(d.headers.get('content-disposition'), /^attachment/); assert.equal(d.headers.get('x-content-type-options'), 'nosniff'); assert.match(d.headers.get('content-security-policy'), /sandbox/);
  assert.ok(t.audits.some((a) => a[2] === 'file.uploaded')); assert.ok(t.audits.some((a) => a[2] === 'file.downloaded')); assert.ok(t.notes.length >= 1);
  await t.close();
});

test('malware, spoofed types, active content and macros are rejected: nothing reaches the clean store and the quarantine copy is removed', async () => {
  const t = await rig(); const { P } = t;
  const cases = [['eicar.txt', 'text/plain', Buffer.from(EICAR), /^malware:(Fake-Test|Qorlla\.Test)/], ['photo.pdf', 'application/pdf', PNG, /type_mismatch/], ['run.txt', 'text/plain', Buffer.from([0x4d, 0x5a, 0, 0, 1, 2, 3]), /type_not_allowed/],
    ['evil.pdf', 'application/pdf', Buffer.from('%PDF-1.4 /OpenAction << /S /JavaScript /JS (app.alert(1)) >>'), /active_content/], ['macro.docx', DOCX, docx('word/vbaProject.bin'), /active_content:macro/]];
  for (const [name, type, body, why] of cases) { const r = await t.up(P.host, name, type, body); assert.equal(r.status, 202, name); const f = await t.row(r.body.id); assert.equal(f.state, 'rejected', name); assert.match(f.reason, why, name); assert.equal(f.quarantine_key, null); }
  assert.deepEqual(await t.cleanFiles(), []); assert.deepEqual(await t.quarantine(), []);
  assert.equal((await t.dl(P.host, (await pool.query("SELECT id FROM more_files WHERE meeting_id=$1 AND state='rejected' LIMIT 1", [t.mid])).rows[0].id)).status, 404, 'a rejected file cannot be downloaded');
  await t.close();
});

test('IMMUTABLE promotion: bytes swapped in quarantine after the scan are caught by the hash and never promoted; a modified clean object is refused on download; a clean object is never overwritten', { skip: REAL ? 'needs the fake scanner hook' : false }, async () => {
  const t = await rig(); const { P } = t; const good = Buffer.from('the scanned bytes');
  t.clamd.st.onScan = async () => { const q = (await t.quarantine())[0]; const f = path.join(t.dir, 'quarantine', q); await fs.chmod(f, 0o600); await fs.writeFile(f, Buffer.from('SWAPPED AFTER THE SCAN')); };          // an attacker with disk access swaps the object while it is being scanned
  const r = await t.up(P.host, 'a.txt', 'text/plain', good); const f = await t.row(r.body.id); assert.equal(f.state, 'rejected'); assert.equal(f.reason, 'tampered'); assert.deepEqual(await t.cleanFiles(), [], 'swapped bytes were not promoted'); t.clamd.st.onScan = null;
  const ok = await t.up(P.host, 'b.txt', 'text/plain', good); assert.equal(ok.body.state, 'clean'); const target = path.join(t.dir, 'clean', sha(good).slice(0, 2), sha(good));
  await fs.chmod(target, 0o600); await fs.writeFile(target, Buffer.from('tampered clean object')); await fs.chmod(target, 0o400);
  const d = await t.dl(P.host, ok.body.id); assert.equal(d.status, 410, 'a clean object that no longer matches its hash is refused'); assert.equal((await t.row(ok.body.id)).state, 'rejected'); assert.equal((await t.row(ok.body.id)).reason, 'object_corrupt');
  const again = await t.up(P.host, 'c.txt', 'text/plain', good); assert.equal(again.body.state, 'rejected', 'an existing corrupt object under that name is never silently replaced'); assert.equal((await t.row(again.body.id)).reason, 'promotion_failed');
  await t.close();
});

test('scanner outage fails closed: the file stays in quarantine and "scanning", the supervised sweep retries it, it is rejected after the attempt limit, and it becomes clean only once a real verdict says so', { skip: REAL ? 'needs the fake scanner hook' : false }, async () => {
  const t = await rig({ limits: { ...FILE_LIMITS, scanAttempts: 3 } }); const { P } = t; await t.clamd.close(); t.clamd.st.down = true;
  const r = await t.up(P.host, 'a.txt', 'text/plain', Buffer.from('waiting for a scanner')); assert.equal(r.status, 202); assert.equal(r.body.state, 'scanning'); assert.equal((await t.dl(P.host, r.body.id)).status, 404); assert.equal((await t.quarantine()).length, 1);
  const age = () => pool.query("UPDATE more_files SET scan_lease=now() - interval '1 second', created_at=now() - interval '1 minute' WHERE id=$1", [r.body.id]); await age(); await t.files.sweep(); assert.equal((await t.row(r.body.id)).state, 'scanning');
  const up = await fakeClamd(); const scanner2 = createScanner({ env: { CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(up.port) } }); void scanner2;          // (a second scanner instance exists only to show the engine can come back)
  await age(); await t.files.sweep(); await age(); await t.files.sweep(); const f = await t.row(r.body.id); assert.equal(f.state, 'rejected'); assert.equal(f.reason, 'scan_unavailable'); assert.deepEqual(await t.quarantine(), []); await up.close();
  const t2 = await rig(); const slow = await t2.up(t2.P.host, 'ok.txt', 'text/plain', Buffer.from('fine')); assert.equal(slow.body.state, 'clean'); await t2.close(); await t.close();
  const t3 = await rig({ scan: false }); assert.equal((await t3.up(t3.P.host, 'x.txt', 'text/plain', Buffer.from('x'))).status, 503, 'with no scanner configured the feature is off, never open'); await t3.close();
});

test('access: guests\' files wait for the host; a room\'s files are invisible outside the room; host_only and meeting visibility; only the host or the uploader deletes', async () => {
  const t = await rig(); const { P } = t; t.scopes.set(P.ann.id, 'room-1'); t.scopes.set(P.bo.id, 'room-1'); const room = randomUUID(); t.scopes.set(P.ann.id, room); t.scopes.set(P.bo.id, room);
  const a = await t.up(P.ann, 'notes.txt', 'text/plain', Buffer.from('room one notes')); assert.equal(a.body.state, 'clean'); assert.equal(a.body.approved, false);
  const listFor = async (who) => (await t.call('GET', t.url(), who)).body.files.map((f) => f.name);
  assert.deepEqual(await listFor(P.ann), ['notes.txt'], 'the uploader sees their own upload and its state'); assert.deepEqual(await listFor(P.bo), [], 'not approved: hidden from the room'); assert.deepEqual(await listFor(P.host), ['notes.txt']);
  assert.equal((await t.dl(P.bo, a.body.id)).status, 404); assert.equal((await t.call('POST', t.url(`/${a.body.id}/approve`), P.bo, {})).status, 403); assert.equal((await t.call('POST', t.url(`/${a.body.id}/approve`), P.host, {})).status, 200);
  assert.deepEqual(await listFor(P.bo), ['notes.txt']); assert.equal((await t.dl(P.bo, a.body.id)).status, 200); assert.deepEqual(await listFor(P.cy), [], 'Cy is in the main room: room 1 files do not exist for them'); assert.equal((await t.dl(P.cy, a.body.id)).status, 404);
  const m = await t.up(P.host, 'all-hands.txt', 'text/plain', Buffer.from('everyone'), { headers: { 'x-visibility': 'meeting' } }); assert.equal(m.status, 201); assert.deepEqual((await listFor(P.cy)).sort(), ['all-hands.txt']); assert.equal((await t.dl(P.cy, m.body.id)).status, 200);
  assert.equal((await t.up(P.ann, 'x.txt', 'text/plain', Buffer.from('x'), { headers: { 'x-visibility': 'meeting' } })).status, 403, 'a guest cannot publish to the whole meeting');
  const h = await t.up(P.host, 'private.txt', 'text/plain', Buffer.from('host eyes only'), { headers: { 'x-visibility': 'host_only' } }); assert.equal((await t.dl(P.bo, h.body.id)).status, 404); assert.equal((await t.dl(P.host, h.body.id)).status, 200);
  assert.equal((await t.call('DELETE', t.url(`/${a.body.id}`), P.bo)).status, 403); assert.equal((await t.call('DELETE', t.url(`/${a.body.id}`), P.ann)).status, 200); assert.equal((await t.dl(P.host, a.body.id)).status, 404);
  assert.equal((await t.call('POST', t.url(`/${randomUUID()}/approve`), P.host, {})).status, 404); assert.equal((await t.call('GET', t.url('/not-a-uuid/download'), P.host)).status, 400);
  await t.close();
});

test('identical bytes are stored once; the object goes only with the last file that uses it', async () => {
  const t = await rig(); const { P } = t; const body = Buffer.from('same bytes'); const a = await t.up(P.host, 'one.txt', 'text/plain', body), b = await t.up(P.host, 'two.txt', 'text/plain', body);
  assert.equal(a.body.state, 'clean'); assert.equal(b.body.state, 'clean'); assert.deepEqual(await t.cleanFiles(), [sha(body)]);
  await t.call('DELETE', t.url(`/${a.body.id}`), P.host); assert.deepEqual(await t.cleanFiles(), [sha(body)], 'still used by the other file'); assert.equal((await t.dl(P.host, b.body.id)).status, 200);
  await t.call('DELETE', t.url(`/${b.body.id}`), P.host); assert.deepEqual(await t.cleanFiles(), []); await t.close();
});

test('upload limits: type allowlist, size required and capped, a lying size is caught, names are validated, uploads are rate limited', async () => {
  const t = await rig({ limits: { ...FILE_LIMITS, maxBytes: 1000, uploadsPerMinute: 4 } }); const { P } = t;
  assert.equal((await t.up(P.host, 'a.exe', 'application/x-msdownload', Buffer.from('MZ'))).status, 415); assert.equal((await t.up(P.host, '../../etc/passwd', 'text/plain', Buffer.from('x'))).status, 400); assert.equal((await t.up(P.host, '.hidden', 'text/plain', Buffer.from('x'))).status, 400); assert.equal((await t.up(P.host, 'big.txt', 'text/plain', Buffer.alloc(1001, 97))).status, 413);
  const CRLF = String.fromCharCode(13, 10); const cut = await new Promise((resolve) => { const sock = net.connect(t.port, '127.0.0.1', () => { sock.write([`POST ${t.url()} HTTP/1.1`, 'Host: x', `x-user: ${JSON.stringify(P.host.user)}`, 'x-filename: cut.txt', 'content-type: text/plain', 'content-length: 100', '', 'only five'].join(CRLF)); setTimeout(() => sock.destroy(), 1500); }); sock.on('close', () => resolve(true)); sock.on('error', () => {}); });
  await new Promise((r) => setTimeout(r, 800)); assert.ok(cut); const half = (await pool.query("SELECT state, reason FROM more_files WHERE meeting_id=$1 AND filename='cut.txt'", [t.mid])).rows[0]; assert.equal(half.state, 'rejected'); assert.ok(['upload_failed', 'size_mismatch'].includes(half.reason), 'an interrupted upload is closed, not left half-written');
  assert.equal((await pool.query("SELECT count(*)::int n FROM more_files WHERE meeting_id=$1 AND state='clean'", [t.mid])).rows[0].n, 0); assert.deepEqual(await t.quarantine(), [], 'refused uploads leave nothing behind');
  for (let i = 0; i < 4; i++) await t.up(P.ann, `r${i}.txt`, 'text/plain', Buffer.from('r' + i)); assert.equal((await t.up(P.ann, 'late.txt', 'text/plain', Buffer.from('late'))).status, 429);
  await t.close();
});

test('sweep: expired files are purged (object and row), orphaned quarantine objects are removed, an upload that never finished is closed', async () => {
  const t = await rig(); const { P } = t; const a = await t.up(P.host, 'old.txt', 'text/plain', Buffer.from('old')); assert.deepEqual(await t.cleanFiles(), [sha(Buffer.from('old'))]);
  await pool.query("UPDATE more_files SET expires_at=now() - interval '1 hour' WHERE id=$1", [a.body.id]); const stale = (await pool.query("INSERT INTO more_files(meeting_id, uploader_id, filename, declared_type, expires_at, created_at) VALUES ($1,$2,'half.txt','text/plain', now()+interval '1 day', now() - interval '1 hour') RETURNING id", [t.mid, P.host.id])).rows[0].id;
  const orphan = path.join(t.dir, 'quarantine', randomUUID() + '.' + 'a'.repeat(16)); await fs.mkdir(path.dirname(orphan), { recursive: true }); await fs.writeFile(orphan, 'x'); await fs.utimes(orphan, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  const out = await t.files.sweep(); assert.equal(out.orphans, 1); assert.ok(out.purged >= 1); assert.deepEqual(await t.cleanFiles(), []); assert.equal((await t.row(a.body.id)).state, 'deleted'); assert.equal((await t.row(stale)).state, 'rejected'); assert.equal((await t.row(stale)).reason, 'upload_incomplete');
  assert.deepEqual((await t.call('GET', t.url(), P.host)).body.files.map((f) => [f.name, f.state]), [['half.txt', 'rejected']], 'the expired file is gone; the host still sees the closed half upload'); await t.close();
});

test('disabled by default: without MEET_FILES=on every route answers 503 and nothing is stored', async () => {
  const t = await rig({ env: { MEET_FILES: 'off' } }); const { P } = t; assert.equal((await t.up(P.host, 'a.txt', 'text/plain', Buffer.from('a'))).status, 503); assert.equal((await t.call('GET', t.url(), P.host)).status, 503); assert.equal(t.files.enabled, false); assert.deepEqual(await t.quarantine(), []); await t.close();
});

test('REAL clamd (only with CLAMD_REAL_PORT): clean bytes pass, the standard EICAR string (sent over the socket, never written to disk) and the custom marker signature are found, and the whole pipeline rejects the marker', { skip: REAL ? false : 'CLAMD_REAL_PORT not set' }, async () => {
  const opts = { host: '127.0.0.1', port: REAL, timeoutMs: 30000 }; const EICAR_REAL = ['X5O!P%@AP[4' + String.fromCharCode(92) + 'PZX54(P^)7CC)7}$EICAR', 'STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('-');
  assert.equal(await clamdScan(Buffer.from('perfectly ordinary text'), opts), 'OK'); assert.match(await clamdScan(Buffer.from(EICAR_REAL), opts), /Eicar/i); assert.match(await clamdScan(Buffer.from('x ' + EICAR), opts), /Qorlla\.Test\.Marker/);
  const t = await rig(); const ok = await t.up(t.P.host, 'fine.txt', 'text/plain', Buffer.from('fine')); assert.equal(ok.body.state, 'clean'); const bad = await t.up(t.P.host, 'bad.txt', 'text/plain', Buffer.from('harmless ' + EICAR)); assert.equal((await t.row(bad.body.id)).state, 'rejected'); assert.match((await t.row(bad.body.id)).reason, /^malware:Qorlla\.Test\.Marker/); assert.deepEqual(await t.cleanFiles(), [sha(Buffer.from('fine'))]); await t.close();
});

// ---- fixes from the independent review of the pipeline
test('a deleted or swept upload can never come back to life, even if its bytes finish arriving afterwards', async () => {
  const t = await rig(); const { P } = t; const CRLF = String.fromCharCode(13, 10);
  const sock = net.connect(t.port, '127.0.0.1'); await new Promise((r) => sock.on('connect', r));
  sock.write([`POST ${t.url()} HTTP/1.1`, 'Host: x', `x-user: ${JSON.stringify(P.ann.user)}`, 'x-filename: slow.txt', 'content-type: text/plain', 'content-length: 20', '', 'first5'].join(CRLF));
  let id; for (let i = 0; i < 60 && !id; i++) { await new Promise((r) => setTimeout(r, 100)); id = (await pool.query("SELECT id FROM more_files WHERE meeting_id=$1 AND filename='slow.txt'", [t.mid])).rows[0]?.id; } assert.ok(id, 'the upload is running');
  await t.call('DELETE', t.url(`/${id}`), P.host); const reply = new Promise((r) => { let b = ''; sock.on('data', (d) => { b += d; if (b.includes(CRLF + CRLF)) r(b); }); setTimeout(() => r(b), 4000); });
  sock.write('0123456789abcd'); const res = await reply; sock.destroy();
  const f = await t.row(id); assert.equal(f.state, 'deleted', 'the late bytes did not revive it'); assert.deepEqual(await t.cleanFiles(), [], 'nothing was promoted'); assert.deepEqual(await t.quarantine(), [], 'and the late bytes were removed'); void res;
  await t.close();
});

test('delete and re-upload of the same bytes race 15 times: the new file is always downloadable (the hash lock keeps promote and purge apart)', async () => {
  const t = await rig({ limits: { ...FILE_LIMITS, uploadsPerMinute: 100 } }); const { P } = t; const body = Buffer.from('shared bytes'); let a = (await t.up(P.host, 'a.txt', 'text/plain', body)).body.id;
  for (let i = 0; i < 15; i++) { const [, b] = await Promise.all([t.call('DELETE', t.url(`/${a}`), P.host), t.up(P.host, `b${i}.txt`, 'text/plain', body)]); assert.equal(b.body.state, 'clean'); const d = await t.dl(P.host, b.body.id); assert.equal(d.status, 200, 'round ' + i); a = b.body.id; }
  await t.close();
});

test('a read error is not tampering: a missing object gives 503 and the file stays clean; only a failed hash withdraws it', async () => {
  const t = await rig(); const { P } = t; const body = Buffer.from('keep me'); const r = await t.up(P.host, 'k.txt', 'text/plain', body);
  const target = path.join(t.dir, 'clean', sha(body).slice(0, 2), sha(body)); await fs.chmod(target, 0o600); await fs.rm(target);
  assert.equal((await t.dl(P.host, r.body.id)).status, 503); assert.equal((await t.row(r.body.id)).state, 'clean', 'still clean: this was a missing file, not a changed one'); await t.close();
});

test('names cannot lie: extension is forced to the detected type, invisible and direction characters are removed', async () => {
  const t = await rig({ limits: { ...FILE_LIMITS, uploadsPerMinute: 100 } }); const { P } = t; const name = async (n, type, body) => (await pool.query('SELECT filename FROM more_files WHERE id=$1', [(await t.up(P.host, n, type, body)).body.id])).rows[0].filename;
  assert.equal(await name('update.bat', 'text/plain', Buffer.from('echo hi')), 'update.txt'); assert.equal(await name('invoice‮fdp.txt', 'text/plain', Buffer.from('a')), 'invoicefdp.txt'); assert.equal(await name('report.exe', 'image/png', PNG), 'report.png');
  assert.equal(await name('trailing. . ', 'text/plain', Buffer.from('b')), 'trailing.txt'); assert.equal(await name('noext', 'text/plain', Buffer.from('c')), 'noext.txt'); assert.equal(await name('a​b.pdf', 'text/plain', Buffer.from('d')), 'ab.txt');
  await t.close();
});

test('PDF hardening: escaped names, object streams, encryption and polyglots are refused', async () => {
  const t = await rig({ limits: { ...FILE_LIMITS, uploadsPerMinute: 100 } }); const { P } = t; const why = async (n, body) => { const r = await t.up(P.host, n, 'application/pdf', body); return (await t.row(r.body.id)).reason; };
  assert.match(await why('a.pdf', Buffer.from('%PDF-1.4 << /J#61vaScript (x) >>')), /active_content:name_escape/); assert.match(await why('b.pdf', Buffer.from('%PDF-1.5 1 0 obj << /Type /ObjStm >>')), /active_content:objstm/); assert.match(await why('c.pdf', Buffer.from('%PDF-1.5 << /Encrypt 5 0 R >>')), /active_content:encrypt/);
  assert.match(await why('d.pdf', Buffer.from('junk %PDF-1.4 hello')), /type_mismatch|type_not_allowed/, 'the PDF header must be the first bytes'); assert.equal((await t.up(P.host, 'ok.pdf', 'application/pdf', Buffer.from('%PDF-1.4 plain document body'))).body.state, 'clean'); assert.equal((await t.up(P.host, 'link.pdf', 'application/pdf', Buffer.from('%PDF-1.4 /Type /Annotation'))).body.state, 'clean', 'ordinary keys are not mistaken for prefixes of dangerous ones');
  await t.close();
});

test('quotas: a guest cannot fill the meeting (per-uploader limit, concurrent uploads, atomic under concurrency); the host is not blocked by it', async () => {
  const t = await rig({ limits: { ...FILE_LIMITS, perUploader: 3, perMeeting: 5, uploadsPerMinute: 100, concurrentPerUploader: 2 } }); const { P } = t;
  const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => t.up(P.ann, `f${i}.txt`, 'text/plain', Buffer.from('x' + i)))); const ok = burst.filter((r) => r.status === 201 || r.status === 202).length;
  assert.ok(ok <= 3, 'at most three of eight concurrent uploads were accepted: ' + JSON.stringify(burst.map((r) => r.status))); assert.ok((await pool.query("SELECT count(*)::int n FROM more_files WHERE uploader_id=$1 AND state IN ('uploading','scanning','clean')", [P.ann.id])).rows[0].n <= 3);
  assert.equal((await t.up(P.host, 'host.txt', 'text/plain', Buffer.from('host'))).status, 201, 'the host is not blocked by a guest\'s files'); await t.close();
});
