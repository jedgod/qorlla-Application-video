// The OPTIONAL chat features with the server switches ON, in real browsers: the GIF picker (GIPHY_API_KEY; GIPHY itself is replaced by a local stand-in, so nothing leaves this machine and no
// real key is used) and file attachments (CHAT_ATTACHMENTS_ENABLED). Also proves that the Content-Security-Policy only allows GIPHY images when a key is configured.
//   TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:25690/postgres PLAYWRIGHT_DIR=<folder with node_modules/playwright> node tests/e2e/chat-optional.e2e.mjs [screenshot-dir]
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..'), SQL = join(ROOT, 'sql'), OUT = process.argv[2];
if (OUT) mkdirSync(OUT, { recursive: true });
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_DIR || process.cwd(), 'package.json'))('playwright');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (n, ok, d = '') => { results.push({ n, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !d ? '' : '  -> ' + d)); };
async function waitFor(fn, ms = 15000, step = 200) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await wait(step); } return last; }

// a local stand-in for api.giphy.com: it records what it is asked and answers with six GIFs whose addresses have the shape the server accepts
const asked = [];
const giphy = http.createServer((req, res) => {
  asked.push(req.url); res.setHeader('Content-Type', 'application/json');
  const mk = (n) => ({ id: 'g' + n, title: 'gif ' + n, images: { fixed_height: { url: `https://media${n % 4}.giphy.com/media/g${n}/200.gif` }, fixed_width_small: { url: `https://media${n % 4}.giphy.com/media/g${n}/100w.gif` } } });
  res.end(JSON.stringify({ data: [1, 2, 3, 4, 5, 6].map(mk) }));
});
await new Promise((r) => giphy.listen(0, '127.0.0.1', r)); const giphyPort = giphy.address().port;
const GIF_BYTES = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');          // a 1x1 GIF

const db = 'opt_' + Math.random().toString(36).slice(2, 8), PORT = Number(process.env.OPT_E2E_PORT || 4983), files = mkdtempSync(join(tmpdir(), 'chat-opt-'));
const admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${db}`);
const dbUrl = URL.replace(/\/[^/]*$/, '/' + db); const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8'));
const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATABASE_URL: dbUrl, JWT_SECRET: 'opt-e2e-secret-opt-e2e-secret-0123456789', ASCS_ENABLED: 'false', API_RATE_LIMIT: '100000', MEETING_RATE_LIMIT: '100000', SOCKET_EVENT_BUDGET: '100000',
  GIPHY_API_KEY: 'test-key-not-real', GIPHY_API_BASE: `http://127.0.0.1:${giphyPort}`, CHAT_ATTACHMENTS_ENABLED: 'true', CHAT_ATTACHMENTS_DIR: files }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 240 && !log.includes('listening'); i++) await wait(250);
if (!log.includes('listening')) { console.log('server did not start: ' + log.slice(-500)); process.exit(2); }
const base = `http://localhost:${PORT}`;
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const pageErrors = [];
const open = async (name, code) => {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  await ctx.route(/^https:\/\/(media\d*|i)\.giphy\.com\//, (route) => route.fulfill({ status: 200, contentType: 'image/gif', body: GIF_BYTES }));          // the stand-in for the picture servers
  const p = await ctx.newPage(); p.__auth = null; p.on('request', (r) => { const h = r.headers()['authorization']; if (h) p.__auth = h; });
  p.on('pageerror', (e) => pageErrors.push(name + ': ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) pageErrors.push(name + ' console: ' + m.text()); });
  await p.goto(base); await p.fill('#displayName', name);
  if (code) { await p.fill('#meetingId', code); await p.click('#joinBtn'); } else { await p.fill('#meetingTitle', 'Optional features'); await p.click('#createBtn'); }
  await p.waitForSelector('#app:not(.hidden)', { timeout: 30000 }); return { ctx, p };
};
try {
  const csp = (await fetch(base + '/')).headers.get('content-security-policy') || '';
  check('with a GIPHY key configured the Content-Security-Policy allows GIPHY images (and only them)', /img-src[^;]*https:\/\/media\.giphy\.com/.test(csp) && !/img-src[^;]*\*/.test(csp), csp.slice(0, 300));
  const host = await open('Hana'); const code = (await host.p.textContent('#roomId')).trim(); const guest = await open('Gus', code);
  await waitFor(async () => (await host.p.locator('#peopleList .person').count()) >= 2);
  const mid = (await pool.query('SELECT id FROM meetings LIMIT 1')).rows[0].id;

  // ---------------- GIF picker
  check('GIF is enabled (no longer disabled) when the server has a GIPHY key', !(await guest.p.locator('#chatGifBtn').isDisabled()));
  await guest.p.click('#chatGifBtn');
  check('the picker shows a "Search GIPHY" box, "Powered by GIPHY" and the privacy note', (await guest.p.locator('#chatGifQuery').getAttribute('placeholder')) === 'Search GIPHY' && /powered by giphy/i.test(await guest.p.locator('#chatGifPanel').innerText()) && /search words are sent to GIPHY through this meeting/.test(await guest.p.locator('#chatGifPanel').innerText()));
  await guest.p.fill('#chatGifQuery', 'celebrate');
  check('typing a search shows a grid of previews (loaded through the policy)', !!(await waitFor(async () => (await guest.p.locator('#chatGifGrid img').count()) === 6)) && !!(await waitFor(async () => guest.p.locator('#chatGifGrid img').first().evaluate((i) => i.complete && i.naturalWidth > 0))));
  check('the grid is a two-column masonry layout', (await guest.p.locator('#chatGifGrid').evaluate((g) => getComputedStyle(g).columnCount)) === '2');
  check('the search words went to the (stand-in) GIPHY from the SERVER, with the key, and the page never saw the key', asked.some((u) => /\/v1\/gifs\/search\?api_key=test-key-not-real&q=celebrate/.test(u)) && !(await guest.p.content()).includes('test-key-not-real'));
  if (OUT) await guest.p.screenshot({ path: join(OUT, 'gif-picker.png') });
  await guest.p.locator('#chatGifGrid button').first().click();
  check('choosing a GIF sends it: both people see the picture and the picker closes', !!(await waitFor(async () => (await host.p.locator('.chat-gif').count()) === 1 && (await guest.p.locator('.chat-gif').count()) === 1)) && (await guest.p.locator('#chatGifPanel.hidden').count()) === 1);
  const gifRow = (await pool.query("SELECT kind, body FROM messages WHERE kind='gif'")).rows[0];
  check('it is stored as a GIF message holding only the GIPHY address', gifRow?.kind === 'gif' && /^https:\/\/media\d\.giphy\.com\/media\/g\d\/200\.gif$/.test(gifRow.body), JSON.stringify(gifRow));
  const bad = await guest.p.evaluate(async ({ mid, tok }) => (await fetch('/api/meetings/' + mid + '/chat', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'gif', body: 'https://evil.example/x.gif' }) })).status, { mid, tok: (guest.p.__auth || '').replace(/^Bearer /, '') });
  check('a GIF address that is not GIPHY is refused by the server', bad === 400, String(bad));

  // ---------------- files
  await guest.p.click('#chatAttachBtn');
  check('"Your computer" is enabled when attachments are on; the five cloud sources are STILL disabled (no connector exists)', !(await guest.p.locator('#chatFilePc').isDisabled()) && (await guest.p.locator('#chatFileMenu [data-cloud]:disabled').count()) === 5);
  const chooser = guest.p.waitForEvent('filechooser'); await guest.p.click('#chatFilePc'); const fc = await chooser;
  await fc.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello from the file') });
  check('the chosen file is sent: both people see a file chip with its name and size', !!(await waitFor(async () => (await host.p.locator('.chat-file', { hasText: 'notes.txt' }).count()) === 1 && (await guest.p.locator('.chat-file', { hasText: 'notes.txt' }).count()) === 1)));
  const dl = host.p.waitForEvent('download'); await host.p.locator('.chat-file', { hasText: 'notes.txt' }).click(); const file = await dl;
  let got = ''; for await (const c of await file.createReadStream()) got += c;
  check('the other person downloads exactly what was sent, as a download (not opened in the page)', file.suggestedFilename() === 'notes.txt' && got === 'hello from the file');
  const before = Number((await pool.query('SELECT count(*) FROM chat_attachments')).rows[0].count);
  const chooser2 = guest.p.waitForEvent('filechooser'); await guest.p.click('#chatAttachBtn'); await guest.p.click('#chatFilePc'); const fc2 = await chooser2;
  await fc2.setFiles({ name: 'program.exe', mimeType: 'application/octet-stream', buffer: Buffer.concat([Buffer.from('MZ'), Buffer.from([0x90, 0, 3, 0]), Buffer.alloc(64)]) });
  await wait(1500);
  check('a program file is refused by the server (type decided by its bytes): nothing is stored or shown', Number((await pool.query('SELECT count(*) FROM chat_attachments')).rows[0].count) === before && (await host.p.locator('.chat-file', { hasText: 'program.exe' }).count()) === 0);
  if (OUT) await guest.p.screenshot({ path: join(OUT, 'files.png') });
  check('no JavaScript errors on any page', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) { check('run completed without an exception', false, String(e.message || e).slice(0, 400)); }
finally { await browser.close(); child.kill(); giphy.close(); await wait(300); await pool.end(); await admin.query(`DROP DATABASE ${db} WITH (FORCE)`).catch(() => {}); await admin.end(); rmSync(files, { recursive: true, force: true }); }
const bad = results.filter((r) => !r.ok); console.log(`\n${results.length - bad.length}/${results.length} passed`); process.exit(bad.length ? 1 : 0);
