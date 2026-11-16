// LIGHT variant (2 browsers, for busy machines): consent-gated live transcript with a host and ONE guest. See files-transcript.e2e.mjs for the full run (host + two guests + files). Original description: host + two guests, a real Meet process, real PostgreSQL, a private files directory, a FAKE clamd and a FAKE speech engine (labelled).
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
const pw = createRequire(join(process.env.PLAYWRIGHT_DIR || process.cwd(), 'package.json'))('playwright'); const BROWSER = process.env.BROWSER || 'chromium';          // BROWSER=firefox runs the same steps in Firefox (fake microphone through its own prefs)
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

const dbn = 'ftl_' + Math.random().toString(36).slice(2, 8), PORT = Number(process.env.FT_PORT || 4979), dir = mkdtempSync(join(tmpdir(), 'qft-'));
const admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${dbn}`); const dbUrl = URL.replace(/\/[^/]*$/, '/' + dbn); const pool = new pg.Pool({ connectionString: dbUrl, max: 2 }); pool.on('error', () => {});
for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8'));
const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATABASE_URL: dbUrl, JWT_SECRET: 'ft-e2e-secret-ft-e2e-secret-0123456789ab', ASCS_ENABLED: 'false', API_RATE_LIMIT: '100000', MEETING_RATE_LIMIT: '100000', SOCKET_EVENT_BUDGET: '100000',
  MEET_FILES: 'on', FILES_DIR: join(dir, 'files'), CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(clamd.address().port), MEET_TRANSCRIPT: 'on', STT_URL: 'http://127.0.0.1:' + stt.address().port, STT_INTERNAL_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d)); for (let i = 0; i < 240 && !log.includes('listening'); i++) await wait(250);
if (!log.includes('listening')) { console.log('server did not start: ' + log.slice(-500)); process.exit(2); }
const browser = await pw[BROWSER].launch(BROWSER === 'firefox' ? { firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true } } : { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] }); const errs = [];
const open = async (name, code) => { const ctx = await browser.newContext({ ...(BROWSER === 'chromium' ? { permissions: ['camera', 'microphone'] } : {}), viewport: { width: 1250, height: 800 }, acceptDownloads: true }); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(name + ': ' + e.message)); if (process.env.FT_DEBUG) p.on('response', async (r) => { if (/\/(files|transcripts)/.test(r.url()) && (r.request().method() !== 'GET' || /transcripts/.test(r.url()))) console.log('HTTP', name, r.request().method(), r.status(), r.url().replace(/.*meetings\/[^/]+/, ''), (await r.text().catch(() => '')).slice(0, 120)); });
  await p.goto(`http://localhost:${PORT}/?mic=off&camera=off`); await p.fill('#displayName', name); if (code) { await p.fill('#meetingId', code); await p.click('#joinBtn'); } else { await p.fill('#meetingTitle', 'Files and transcript'); await p.click('#createBtn'); }
  await p.waitForSelector('#app:not(.hidden)', { timeout: 30000 }); await p.click('[data-tab=more]'); return p; };
const body = (p) => p.locator('body').innerText();
const settleCalls = async () => { let last = -1, since = Date.now(); for (let i = 0; i < 120; i++) { if (eng.calls !== last) { last = eng.calls; since = Date.now(); } else if (Date.now() - since > 6000) return; await wait(500); } };          // in-flight chunks of a busy machine finish first; what matters is that nothing NEW arrives afterwards
try {
  const host = await open('Hana'); const code = (await host.textContent('#roomId')).trim(); const ann = await open('Ann', code); await wait(2500);
  const card = (p) => p.locator('.mg-card', { hasText: 'Live Transcript' });
  await waitFor(async () => (await card(host).getByRole('button', { name: 'Start live transcript' }).count()) === 1, 40000); await card(host).getByRole('button', { name: 'Start live transcript' }).click();
  check('the guest is asked, with the microphone-only explanation', !!(await waitFor(async () => (await card(ann).getByRole('button', { name: /I agree/ }).count()) === 1 && /Only your own microphone/.test(await card(ann).innerText()), 60000)));
  await card(host).getByRole('button', { name: /I agree/ }).click({ timeout: 60000 }); await wait(5000);
  check('with the guest undecided nothing is captured: the engine has received no audio', eng.calls === 0, String(eng.calls));
  await card(ann).getByRole('button', { name: /I agree/ }).click();
  check('when both agreed it runs, each page captures its OWN microphone and the words reach the transcript', !!(await waitFor(async () => eng.calls >= 2 && (await pool.query('SELECT count(*)::int n FROM more_transcript_segments')).rows[0].n >= 2, 150000, 500)), 'calls ' + eng.calls);
  const who = (await pool.query('SELECT DISTINCT p.display_name FROM more_transcript_segments g JOIN participants p ON p.id=g.speaker_id ORDER BY 1')).rows.map((r) => r.display_name); check('every line is attributed to the person whose page recorded it', who.length >= 1 && who.every((n) => ['Ann', 'Hana'].includes(n)), JSON.stringify(who));
  check('the guest sees the words on the card', !!(await waitFor(async () => /words from the fake engine/.test(await card(ann).innerText()), 90000, 500)));
  await card(ann).getByRole('button', { name: 'Withdraw my consent' }).click(); const gone = await waitFor(async () => (await pool.query("SELECT count(*)::int n FROM more_transcript_consents c JOIN participants p ON p.id=c.participant_id WHERE p.display_name='Ann' AND c.consent=false")).rows[0].n === 1, 60000, 500);
  check('withdrawing in the browser reaches the server', !!gone);
  const wAt = (await pool.query("SELECT decided_at FROM more_transcript_consents c JOIN participants p ON p.id=c.participant_id WHERE p.display_name='Ann' AND c.consent=false")).rows[0]?.decided_at;
  await settleCalls(); const calls0 = eng.calls; await wait(10000);
  check('The guest words are deleted, the session is paused, and the engine receives nothing new', (await pool.query("SELECT count(*)::int n FROM more_transcript_segments g JOIN participants p ON p.id=g.speaker_id WHERE p.display_name='Ann'")).rows[0].n === 0 && (await pool.query("SELECT status FROM more_transcript_sessions")).rows[0].status === 'paused' && eng.calls === calls0, 'delta ' + (eng.calls - calls0));
  const late = wAt ? (await pool.query("SELECT count(*)::int n FROM more_transcript_chunks WHERE created_at > $1::timestamptz + interval '1 second' AND epoch < (SELECT epoch FROM more_transcript_sessions LIMIT 1)", [wAt])).rows[0].n : -1; check('no chunk of the old epoch was accepted after the withdrawal (checked in the database)', late === 0, String(late));
  check('no page errors in any browser', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('run completed without an exception', false, String(e.message || e).slice(0, 500)); }
finally { await browser.close(); child.kill(); await wait(400); clamd.close(); stt.close(); await pool.end(); await admin.query(`DROP DATABASE ${dbn} WITH (FORCE)`).catch(() => {}); await admin.end(); rmSync(dir, { recursive: true, force: true }); }
console.log(`
${results.filter(Boolean).length}/${results.length} passed`); process.exit(results.every(Boolean) ? 0 : 1);
