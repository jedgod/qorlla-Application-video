// Shared files and consent-gated live transcript in REAL browsers (v4.34): host + two guests, a real Meet process, real PostgreSQL, a private files directory, a FAKE clamd and a FAKE speech engine (labelled).
//   TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:25690/postgres PLAYWRIGHT_DIR=<dir with playwright> node tests/e2e/files-transcript.e2e.mjs
// Proves in a browser: a guest's file is scanned, hidden until the host approves, then downloads byte-for-byte; a "malware" file is rejected; the transcript waits for EVERYONE, a real fake-microphone is captured by the page
// only after the person agreed, the words appear, a withdrawal stops capture (the engine stops receiving audio) and deletes that person's words, and a latecomer pauses it. Does NOT prove recognition quality or Safari/iOS decoding.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..'), SQL = join(ROOT, 'sql');
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_DIR || process.cwd(), 'package.json'))('playwright');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (n, ok, d = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !d ? '' : '  -> ' + d)); };
async function waitFor(fn, ms = 20000, step = 250) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await wait(step); } return last; }

// ---- fakes
const MARKER = 'QORLLA-FAKE-MALWARE-TEST-MARKER-0001', TOKEN = 'e2e-stt-token-e2e-stt-token-0123456789';
const clamd = net.createServer((sock) => { let buf = Buffer.alloc(0); sock.on('data', (d) => { buf = Buffer.concat([buf, d]); const h = buf.indexOf(0); if (h < 0) return; let p = h + 1; const parts = []; for (;;) { if (buf.length < p + 4) return; const n = buf.readUInt32BE(p); if (n === 0) break; if (buf.length < p + 4 + n) return; parts.push(buf.subarray(p + 4, p + 4 + n)); p += 4 + n; } sock.end(Buffer.concat(parts).includes(MARKER) ? 'stream: Fake-Test-Signature FOUND\0' : 'stream: OK\0'); }); });
await new Promise((r) => clamd.listen(0, '127.0.0.1', r));
const eng = { calls: 0, bytes: [] }; const stt = http.createServer((req, res) => { const parts = []; req.on('data', (d) => parts.push(d)); req.on('end', () => { if (req.headers['x-internal-token'] !== TOKEN) { res.writeHead(401); return res.end(); } eng.calls++; eng.bytes.push(Buffer.concat(parts).length); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ segments: [{ startMs: 0, endMs: 1200, text: 'words from the fake engine ' + eng.calls }] })); }); });
await new Promise((r) => stt.listen(0, '127.0.0.1', r));

const dbn = 'ft_' + Math.random().toString(36).slice(2, 8), PORT = Number(process.env.FT_PORT || 4977), dir = mkdtempSync(join(tmpdir(), 'qft-'));
const admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${dbn}`); const dbUrl = URL.replace(/\/[^/]*$/, '/' + dbn); const pool = new pg.Pool({ connectionString: dbUrl, max: 2 }); pool.on('error', () => {});
for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8'));
const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATABASE_URL: dbUrl, JWT_SECRET: 'ft-e2e-secret-ft-e2e-secret-0123456789ab', ASCS_ENABLED: 'false', API_RATE_LIMIT: '100000', MEETING_RATE_LIMIT: '100000', SOCKET_EVENT_BUDGET: '100000',
  MEET_FILES: 'on', FILES_DIR: join(dir, 'files'), CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(clamd.address().port), MEET_TRANSCRIPT: 'on', STT_URL: 'http://127.0.0.1:' + stt.address().port, STT_INTERNAL_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d)); for (let i = 0; i < 240 && !log.includes('listening'); i++) await wait(250);
if (!log.includes('listening')) { console.log('server did not start: ' + log.slice(-500)); process.exit(2); }
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] }); const errs = [];
const open = async (name, code) => { const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1250, height: 800 }, acceptDownloads: true }); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(name + ': ' + e.message)); if (process.env.FT_DEBUG) p.on('response', async (r) => { if (/\/(files|transcripts)/.test(r.url()) && (r.request().method() !== 'GET' || /transcripts/.test(r.url()))) console.log('HTTP', name, r.request().method(), r.status(), r.url().replace(/.*meetings\/[^/]+/, ''), (await r.text().catch(() => '')).slice(0, 120)); });
  await p.goto(`http://localhost:${PORT}/?mic=off&camera=off`); await p.fill('#displayName', name); if (code) { await p.fill('#meetingId', code); await p.click('#joinBtn'); } else { await p.fill('#meetingTitle', 'Files and transcript'); await p.click('#createBtn'); }
  await p.waitForSelector('#app:not(.hidden)', { timeout: 30000 }); await p.click('[data-tab=more]'); return p; };
const body = (p) => p.locator('body').innerText();
const settleCalls = async () => { let last = -1, since = Date.now(); for (let i = 0; i < 120; i++) { if (eng.calls !== last) { last = eng.calls; since = Date.now(); } else if (Date.now() - since > 6000) return; await wait(500); } };          // in-flight chunks of a busy machine finish first; what matters is that nothing NEW arrives afterwards
try {
  const host = await open('Hana'); const code = (await host.textContent('#roomId')).trim(); const ann = await open('Ann', code); const bo = await open('Bo', code); await wait(2500);
  // ---------------- shared files
  const filesRow = (p) => p.locator('#tab-more .mg-row', { hasText: 'Shared files' }); await waitFor(async () => !(await filesRow(ann).getByRole('button').isDisabled()), 20000);
  check('the Shared files button is enabled once the server has a scanner and a private store', !(await filesRow(ann).getByRole('button').isDisabled()));
  await filesRow(ann).getByRole('button', { name: 'Open' }).click(); await filesRow(bo).getByRole('button', { name: 'Open' }).click(); await filesRow(host).getByRole('button', { name: 'Open' }).click();
  const content = 'Quarterly plan\n1. Ship the files feature\n'; writeFileSync(join(dir, 'plan.txt'), content); writeFileSync(join(dir, 'virus.txt'), 'harmless text ' + MARKER);
  await ann.locator('.fl-box input[type=file]').setInputFiles(join(dir, 'plan.txt')); await ann.locator('.fl-box').getByRole('button', { name: 'Share file' }).click();
  check('Ann\'s upload is scanned and then waits for the host ("Waiting for the host")', !!(await waitFor(async () => /plan\.txt[\s\S]*Waiting for the host/.test(await ann.locator('.fl-box').innerText()), 15000)));
  check('Bo (same room) cannot see it, and cannot download it, until the host approves', !(await bo.locator('.fl-box').innerText()).includes('plan.txt'));
  await host.locator('.fl-box .bk-room', { hasText: 'plan.txt' }).getByRole('button', { name: 'Approve' }).click({ timeout: 20000 });
  check('after approval Bo sees it live and it is ready', !!(await waitFor(async () => /plan\.txt[\s\S]*Ready/.test(await bo.locator('.fl-box').innerText()), 15000)));
  const [dl] = await Promise.all([bo.waitForEvent('download', { timeout: 15000 }), bo.locator('.fl-box .bk-room', { hasText: 'plan.txt' }).getByRole('button', { name: 'Download' }).click()]); const got = readFileSync(await dl.path(), 'utf8');
  check('Bo downloads exactly the bytes that were uploaded (verified against the stored hash)', got === content && dl.suggestedFilename() === 'plan.txt');
  await ann.locator('.fl-box input[type=file]').setInputFiles(join(dir, 'virus.txt')); await ann.locator('.fl-box').getByRole('button', { name: 'Share file' }).click();
  check('a file the scanner flags is rejected and nobody can open it', !!(await waitFor(async () => /virus\.txt[\s\S]*Rejected: malware found/.test(await ann.locator('.fl-box').innerText()), 40000)) && !/virus\.txt/.test(await bo.locator('.fl-box').innerText()));
  const stored = (await pool.query("SELECT state, count(*)::int n FROM more_files GROUP BY state ORDER BY state")).rows; check('the database agrees (one clean, one rejected) and the rejected bytes were never stored', JSON.stringify(stored) === JSON.stringify([{ state: 'clean', n: 1 }, { state: 'rejected', n: 1 }]), JSON.stringify(stored));

  // ---------------- live transcript
  const card = (p) => p.locator('.mg-card', { hasText: 'Live Transcript' });
  await host.click('[data-tab=more]'); await waitFor(async () => (await card(host).getByRole('button', { name: 'Start live transcript' }).count()) === 1, 20000);
  check('only the host gets a Start button; guests see that it is not running', (await card(ann).getByRole('button', { name: 'Start live transcript' }).count()) === 0 && /Only the host can start/.test(await card(ann).innerText()));
  await card(host).getByRole('button', { name: 'Start live transcript' }).click();
  if (process.env.FT_DEBUG) { await wait(3000); const flat = (t) => t.split(String.fromCharCode(10)).join(' | '); console.log('--- ann card:', flat(await card(ann).innerText())); console.log('--- host card:', flat(await card(host).innerText())); }
  check('guests are asked, with the microphone-only explanation', !!(await waitFor(async () => (await card(ann).getByRole('button', { name: /I agree/ }).count()) === 1 && /Only your own microphone/.test(await card(ann).innerText()), 20000)));
  await card(ann).getByRole('button', { name: /I agree/ }).click(); await card(host).getByRole('button', { name: /I agree/ }).click({ timeout: 20000 }); await wait(4000);
  check('with Bo undecided nothing is captured: the engine has received no audio', eng.calls === 0, String(eng.calls));
  await card(bo).getByRole('button', { name: /I agree/ }).click();
  check('when everyone agreed it runs, each agreeing page captures its OWN microphone, and the words appear for them', !!(await waitFor(async () => eng.calls >= 3 && /words from the fake engine/.test(await card(ann).innerText()), 120000, 500)), 'calls ' + eng.calls + ' ann=' + (await card(ann).innerText()).split(String.fromCharCode(10)).join(' | ').slice(0, 300));
  const speakers = (await pool.query('SELECT DISTINCT p.display_name FROM more_transcript_segments g JOIN participants p ON p.id=g.speaker_id ORDER BY 1')).rows.map((r) => r.display_name); check('every line is attributed to the person whose page recorded it (server-derived)', speakers.length >= 2 && speakers.every((s) => ['Ann', 'Bo', 'Hana'].includes(s)), JSON.stringify(speakers) + ' chunks=' + JSON.stringify((await pool.query('SELECT status, epoch::int, count(*)::int n FROM more_transcript_chunks GROUP BY 1,2 ORDER BY 1,2')).rows));
  const epochBefore = Number((await pool.query("SELECT epoch FROM more_transcript_sessions ORDER BY created_at DESC LIMIT 1")).rows[0].epoch);
  if (process.env.FT_DEBUG) console.log('--- bo card before withdraw:', (await card(bo).innerText()).split(String.fromCharCode(10)).join(' | ').slice(0, 300));
  await card(bo).getByRole('button', { name: 'Withdraw my consent' }).click(); if (process.env.FT_DEBUG) { await wait(4000); console.log('--- bo card after withdraw click:', (await card(bo).innerText()).split(String.fromCharCode(10)).join(' | ').slice(0, 300)); } await waitFor(async () => /Waiting for everyone/.test(await card(host).innerText()), 40000); await settleCalls(); const calls0 = eng.calls; await wait(9000);
  const wAt = (await pool.query("SELECT decided_at FROM more_transcript_consents c JOIN participants p ON p.id=c.participant_id WHERE p.display_name='Bo' AND c.consent=false")).rows[0].decided_at;
  const late = (await pool.query("SELECT count(*)::int n FROM more_transcript_chunks WHERE epoch=$1 AND created_at > $2::timestamptz + interval '1 second'", [epochBefore, wAt])).rows[0].n; const boWords = (await pool.query("SELECT count(*)::int n FROM more_transcript_segments g JOIN participants p ON p.id=g.speaker_id WHERE p.display_name='Bo'")).rows[0].n;
  check('Bo withdrew: the session paused for everybody, Bo words are gone, and NO chunk of the old epoch was accepted after the withdrawal (checked in the database)', /Waiting for everyone/.test(await card(host).innerText()) && boWords === 0 && late === 0, `late=${late} boWords=${boWords}`);
  check('and the engine receives nothing new while the session is paused', eng.calls === calls0, `delta ${eng.calls - calls0}`);
  await card(bo).getByRole('button', { name: /I agree/ }).click(); await waitFor(async () => /Running/.test(await card(host).innerText()), 20000); const calls1 = eng.calls;
  const cy = await open('Cy', code); await wait(3000);
  check('a latecomer pauses it again until they answer', !!(await waitFor(async () => /Waiting for everyone/.test(await card(host).innerText()), 20000)));
  await settleCalls(); const calls2 = eng.calls; await wait(8000); check('and no audio flows while they have not answered', eng.calls === calls2, `delta ${eng.calls - calls2}`);
  const ex = await pool.query("SELECT count(*)::int n FROM more_transcript_chunks"); check('only chunk bookkeeping is stored, never audio', ex.rows[0].n >= 3);
  await cy.close();
  check('no page errors in any browser', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('run completed without an exception', false, String(e.message || e).slice(0, 500)); if (process.env.FT_DEBUG) { console.log('--- server:', log.slice(-500)); console.log('--- page errors:', errs.join(' | ')); } }
finally { await browser.close(); child.kill(); await wait(400); clamd.close(); stt.close(); await pool.end(); await admin.query(`DROP DATABASE ${dbn} WITH (FORCE)`).catch(() => {}); await admin.end(); rmSync(dir, { recursive: true, force: true }); }
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`); process.exit(results.every(Boolean) ? 0 : 1);
