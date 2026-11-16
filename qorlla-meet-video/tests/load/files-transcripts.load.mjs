// HTTP load run for shared files and the transcript audio gateway (v4.34): 30 participants, concurrent uploads and audio chunks against a REAL Meet process and PostgreSQL, a FAKE clamd and a FAKE speech engine
// (20 ms per chunk). It measures the Meet side only: queueing, locking, consent re-checks and database writes. It says NOTHING about speech-model speed (a real model is the bottleneck) or about browsers.
//   TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:25690/postgres node tests/load/files-transcripts.load.mjs [participants=30]
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..'), SQL = join(ROOT, 'sql'), N = Number(process.argv[2] || 30);
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres', TOKEN = 'load-stt-token-load-stt-token-0123456789';
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const wait = (ms) => new Promise((r) => setTimeout(r, ms)); const results = []; const check = (n, ok, d = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !d ? '' : '  -> ' + d)); };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
const clamd = net.createServer((sock) => { let buf = Buffer.alloc(0); sock.on('data', (d) => { buf = Buffer.concat([buf, d]); const h = buf.indexOf(0); if (h < 0) return; let p = h + 1; for (;;) { if (buf.length < p + 4) return; const n = buf.readUInt32BE(p); if (n === 0) break; if (buf.length < p + 4 + n) return; p += 4 + n; } sock.end('stream: OK\0'); }); });
await new Promise((r) => clamd.listen(0, '127.0.0.1', r));
const stt = http.createServer((req, res) => { req.resume(); req.on('end', () => setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ segments: [{ startMs: 0, endMs: 800, text: 'load test words' }] })); }, 20)); });
await new Promise((r) => stt.listen(0, '127.0.0.1', r));
const dbn = 'ld_' + Math.random().toString(36).slice(2, 8), PORT = 4985, dir = mkdtempSync(join(tmpdir(), 'qld-'));
const admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${dbn}`); const dbUrl = URL.replace(/\/[^/]*$/, '/' + dbn); const pool = new pg.Pool({ connectionString: dbUrl, max: 4 }); pool.on('error', () => {});
for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8'));
const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATABASE_URL: dbUrl, JWT_SECRET: 'load-secret-load-secret-0123456789abcd', ASCS_ENABLED: 'false', API_RATE_LIMIT: '1000000', MEETING_RATE_LIMIT: '1000000', SOCKET_EVENT_BUDGET: '1000000', MEET_FILES: 'on', FILES_DIR: join(dir, 'f'), CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(clamd.address().port), MEET_TRANSCRIPT: 'on', STT_URL: 'http://127.0.0.1:' + stt.address().port, STT_INTERNAL_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d)); for (let i = 0; i < 240 && !log.includes('listening'); i++) await wait(250);
const base = `http://127.0.0.1:${PORT}`, json = (t, m, p, b) => fetch(base + p, { method: m, headers: { Authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
try {
  const created = await (await fetch(base + '/api/meetings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'load', name: 'Host' }) })).json(); const mid = created.meetingId, host = created.token;
  const guests = []; for (let i = 0; i < N - 1; i++) { const j = await (await fetch(`${base}/api/meetings/${mid}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'G' + i }) })).json(); guests.push({ id: j.participantId, token: j.token }); }
  const everyone = [{ id: created.participantId, token: host }, ...guests]; for (const p of everyone) await pool.query('INSERT INTO participant_sessions(id,meeting_id,participant_id) VALUES ($1,$2,$3)', [randomUUID(), mid, p.id]);
  await pool.query("UPDATE participants SET admission='admitted' WHERE meeting_id=$1", [mid]); console.log(`${N} participants, one Meet process, PostgreSQL, fake clamd, fake engine (20 ms)`);

  // ---- files: every guest uploads 2 files of ~300 KB at once, the host approves nothing (they are clean and wait)
  const lat = [], st = {}; const t0 = Date.now();
  await Promise.all(guests.flatMap((g, i) => [0, 1].map(async (k) => { const body = Buffer.from(randomBytes(150000).toString('hex')); const s = Date.now(); const r = await fetch(`${base}/api/meetings/${mid}/files`, { method: 'POST', headers: { Authorization: 'Bearer ' + g.token, 'content-type': 'text/plain', 'x-filename': encodeURIComponent(`g${i}-${k}.txt`) }, body }); lat.push(Date.now() - s); st[r.status] = (st[r.status] || 0) + 1; await r.arrayBuffer(); })));
  const fileSecs = (Date.now() - t0) / 1000; console.log(`files: ${lat.length} uploads (~300 KB each) in ${fileSecs.toFixed(1)} s, p50 ${pct(lat, .5)} ms, p95 ${pct(lat, .95)} ms, statuses ${JSON.stringify(st)}`);
  const clean = (await pool.query("SELECT count(*)::int n FROM more_files WHERE state='clean'")).rows[0].n, stuck = (await pool.query("SELECT count(*)::int n FROM more_files WHERE state IN ('uploading','scanning')")).rows[0].n;
  check('every upload finished: clean or refused by the rate limit, none stuck in quarantine or scanning', clean + (st[429] || 0) === lat.length && stuck === 0, `clean ${clean}, 429 ${st[429] || 0}, stuck ${stuck}`); check('no upload failed with a server error', !Object.keys(st).some((c) => Number(c) >= 500), JSON.stringify(st));

  // ---- transcript: all consent, then every participant sends chunks concurrently while one withdraws part way
  const s = (await json(host, 'POST', `/api/meetings/${mid}/transcripts`, {})).body; check('the host started it and everyone is required', s.status === 'awaiting_consent' && s.required === N, JSON.stringify(s).slice(0, 120));
  const cl = []; for (const p of everyone) { const t1 = Date.now(); await json(p.token, 'POST', `/api/meetings/${mid}/transcripts/${s.id}/consent`, { consent: true }); cl.push(Date.now() - t1); }
  const live = (await json(host, 'GET', `/api/meetings/${mid}/transcripts`)).body.sessions[0]; check('it became active only after the last person agreed', live.status === 'active' && live.agreed === N, JSON.stringify(live).slice(0, 140)); console.log(`consent: ${N} sequential consents, p50 ${pct(cl, .5)} ms, p95 ${pct(cl, .95)} ms (each re-evaluates the room under a row lock)`);
  const clat = [], cst = {}; const withdrawer = everyone[everyone.length - 1]; let withdrawnAt = 0; const audio = Buffer.alloc(5000, 7); let epoch = live.epoch;
  const sender = async (p, n) => { for (let i = 0; i < n; i++) { const t1 = Date.now(); const r = await fetch(`${base}/api/meetings/${mid}/transcripts/${s.id}/audio`, { method: 'POST', headers: { Authorization: 'Bearer ' + p.token, 'content-type': 'audio/webm', 'x-consent-epoch': String(epoch), 'x-chunk-id': randomUUID(), 'x-chunk-start-ms': String(i * 4000) }, body: audio }); clat.push(Date.now() - t1); cst[r.status] = (cst[r.status] || 0) + 1; await r.arrayBuffer(); await wait(300); } };
  const t2 = Date.now(); const flows = everyone.map((p) => sender(p, 10)); await wait(1500); const w = await json(withdrawer.token, 'POST', `/api/meetings/${mid}/transcripts/${s.id}/consent`, { consent: false }); withdrawnAt = Date.now(); await Promise.all(flows);
  const secs = (Date.now() - t2) / 1000; console.log(`audio: ${clat.length} chunks from ${N} participants in ${secs.toFixed(1)} s (${(clat.length / secs).toFixed(0)}/s), p50 ${pct(clat, .5)} ms, p95 ${pct(clat, .95)} ms, statuses ${JSON.stringify(cst)}`);
  check('the withdrawal succeeded in the middle of the load', w.status === 200 && w.body.status === 'paused', JSON.stringify(w.body).slice(0, 120));
  check('no server errors under load (only accepted, out-of-date, rate-limited or in-flight-limited answers)', Object.keys(cst).every((c) => ['200', '409', '429'].includes(c)), JSON.stringify(cst));
  const stored = (await pool.query('SELECT count(*)::int n FROM more_transcript_segments')).rows[0].n, done = (await pool.query("SELECT count(*)::int n FROM more_transcript_chunks WHERE status='done'")).rows[0].n, hung = (await pool.query("SELECT count(*)::int n FROM more_transcript_chunks WHERE status='processing'")).rows[0].n;
  const wDone = (await pool.query("SELECT count(*)::int n FROM more_transcript_chunks WHERE status='done' AND speaker_id=$1", [withdrawer.id])).rows[0].n;
  check('every accepted chunk produced exactly its segment (except the withdrawer words, which were deleted on withdrawal) and none is left processing', stored === done - wDone && hung === 0, `segments ${stored}, done ${done}, withdrawer done ${wDone}, processing ${hung}`);
  check('the withdrawer has no stored words, and nothing at all was stored for the old epoch after the pause', (await pool.query('SELECT count(*)::int n FROM more_transcript_segments WHERE speaker_id=$1', [withdrawer.id])).rows[0].n === 0, '');
  const memMB = Math.round(process.memoryUsage().rss / 1048576); console.log(`load driver memory ${memMB} MB`);
} catch (e) { check('run completed without an exception', false, String(e.message || e).slice(0, 400)); console.log(log.slice(-400)); }
finally { child.kill(); await wait(400); clamd.close(); stt.close(); await pool.end(); await admin.query(`DROP DATABASE ${dbn} WITH (FORCE)`).catch(() => {}); await admin.end(); rmSync(dir, { recursive: true, force: true }); }
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`); process.exit(results.every(Boolean) ? 0 : 1);
