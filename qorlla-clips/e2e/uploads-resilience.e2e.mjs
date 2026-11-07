// Browser resilience of the upload pipeline against a MOCKED network (no API, no database, no object store needed).
// Every /api call and every storage request is answered by this script, so slow handshakes, outages, dropped parts and rate limits can be
// produced on demand. What is verified is the real UI and the real upload code in a real browser.
//
//   cd web && npm run build            (any build works: the API is never contacted)
//   node e2e/uploads-resilience.e2e.mjs                       # Chromium
//   BROWSERS=chromium,firefox,webkit node e2e/uploads-resilience.e2e.mjs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pwCandidates = [process.env.PLAYWRIGHT_CORE, path.join(root, 'web', 'node_modules', 'playwright-core'), path.resolve(root, '..', 'node_modules', 'playwright-core')].filter(Boolean);
const pwDir = pwCandidates.find((d) => existsSync(path.join(d, 'index.mjs')));
if (!pwDir) throw new Error('playwright-core not found (set PLAYWRIGHT_CORE)');
const pw = await import(pathToFileURL(path.join(pwDir, 'index.mjs')).href);

const WEB_PORT = 3412, WEB = `http://127.0.0.1:${WEB_PORT}`;
const MiB = 1048576, PART = 5 * MiB;
const STORE = 'https://mock-storage.test';
const log = (m) => console.log(m);
const until = async (fn, msg, ms = 20000) => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* keep trying */ } if (Date.now() - t > ms) throw new Error('timed out: ' + msg); await new Promise((r) => setTimeout(r, 80)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg || 'values differ'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const subsequence = (seen, want) => { let i = 0; for (const s of seen) if (s === want[i]) i++; return i === want.length; };

/** One scenario's fake server. Behaviour is changed by assigning to its fields while a test runs. */
function newMock(size) {
  const total = Math.ceil(size / PART);
  const m = {
    size, total, clips: [], stored: new Set(), putAttempts: {}, signCalls: [], aborts: 0, completes: 0, starts: 0,
    startDelay: 0, signDelay: 0, putDelay: 0, completeDelay: 0,
    start: null,                                   // (n) => {status, body, headers} | null for the default
    sign: null,                                    // (callNumber) => {status, body} | null
    put: null,                                     // (part, attempt) => status | 'drop' | null for 200
  };
  return m;
}
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'PUT, OPTIONS', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'ETag' };
const json = (route, status, body, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });

async function install(page, m) {
  await page.addInitScript(() => {
    window.__phases = [];
    const rec = () => { const li = document.querySelector('section[aria-label=Uploads] li[data-upload-id]'); const ph = li && li.getAttribute('data-phase'); if (ph && window.__phases[window.__phases.length - 1] !== ph) window.__phases.push(ph); };
    new MutationObserver(rec).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-phase'] });
  });
  await page.route(`${STORE}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const part = Number(new URL(req.url()).pathname.split('/').pop());
    m.putAttempts[part] = (m.putAttempts[part] || 0) + 1;
    if (m.putDelay) await sleep(m.putDelay);
    const r = m.put ? m.put(part, m.putAttempts[part]) : null;
    if (r === 'drop') return route.abort('failed');
    if (r && r !== 200) return route.fulfill({ status: r, headers: CORS, body: 'nope' });
    m.stored.add(part);
    return route.fulfill({ status: 200, headers: { ...CORS, etag: `"etag-${part}"` } });
  });
  await page.route(/\/api\//, async (route) => {
    const req = route.request(); const url = new URL(req.url()); const p = url.pathname.replace(/^.*\/api/, ''); const method = req.method();
    if (method === 'GET' && p === '/me') return json(route, 200, { id: 'u1', name: 'Casey', email: 'casey@example.test', role: 'ADMIN' });
    if (method === 'GET' && p === '/navigation/summary') return json(route, 200, { myClipsCount: m.clips.length, starredCount: 0, trashCount: 0, sharedCount: 0, unreadNotifications: 0, playlists: [], organizationPlaylists: [], organization: 'Qorlla', features: { upload: true }, role: 'ADMIN' });
    if (method === 'GET' && p === '/clips') return json(route, 200, { clips: m.clips, nextCursor: null });
    if (method === 'GET' && (p === '/playlists' || p === '/notifications')) return json(route, 200, p === '/playlists' ? { playlists: [] } : { notifications: [] });
    if (method === 'POST' && p === '/recordings') {
      m.starts++; if (m.startDelay) await sleep(m.startDelay);
      const custom = m.start && m.start(m.starts); if (custom) return json(route, custom.status, custom.body, custom.headers);
      const clip = { id: 'clip-' + m.starts, title: JSON.parse(req.postData() || '{}').title || 'x', status: 'UPLOADING', source: 'UPLOAD', mimeType: 'video/webm', isStarred: false, isTrashed: false, ownedByMe: true, playable: false, sizeBytes: m.size, durationMs: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      m.current = clip;
      return json(route, 201, { clip, upload: { partSize: PART, totalParts: m.total } });
    }
    let mm;
    if (method === 'GET' && (mm = p.match(/^\/clips\/[^/]+\/upload$/))) return json(route, 200, { status: 'UPLOADING', partSize: PART, totalParts: m.total, uploadedParts: [...m.stored].map((n) => ({ partNumber: n, size: PART })) });
    if (method === 'POST' && (mm = p.match(/^\/clips\/([^/]+)\/upload\/parts$/))) {
      const nums = JSON.parse(req.postData()).partNumbers; m.signCalls.push(nums);
      if (m.signDelay) await sleep(m.signDelay);
      const custom = m.sign && m.sign(m.signCalls.length); if (custom) return json(route, custom.status, custom.body);
      return json(route, 200, { urls: Object.fromEntries(nums.map((n) => [String(n), `${STORE}/put/${mm[1]}/${n}`])), expiresInSeconds: 1800 });
    }
    if (method === 'POST' && p.endsWith('/upload/complete')) {
      m.completes++; if (m.completeDelay) await sleep(m.completeDelay);
      m.current = { ...m.current, status: 'READY', playable: true }; m.clips = [m.current];
      return json(route, 200, { clip: m.current });
    }
    if (method === 'POST' && p.endsWith('/upload/abort')) { m.aborts++; return json(route, 200, { ok: true }); }
    return json(route, 404, { error: 'not_found', message: 'unmocked: ' + method + ' ' + p });
  });
}

const panel = (page) => page.locator('section[aria-label=Uploads]');
const job = (page) => panel(page).locator('li[data-upload-id]').first();
const phase = (page) => job(page).getAttribute('data-phase');
const pickFile = (page, name, bytes, type = 'video/webm') => page.getByTestId('upload-input').setInputFiles({ name, mimeType: type, buffer: Buffer.alloc(bytes, 7) });
async function open(page, m) { await install(page, m); await page.goto(WEB + '/dashboard/my-clips', { waitUntil: 'domcontentloaded' }); await page.getByTestId('upload-input').waitFor({ state: 'attached' }); }

const scenarios = [
  ['slow handshakes: INITIALIZING -> UPLOADING -> ASSEMBLING -> SUCCESS in order, progress reaches 100, the library shows the new clip', async (page) => {
    const m = newMock(12 * MiB); Object.assign(m, { startDelay: 700, signDelay: 150, putDelay: 250, completeDelay: 800 });
    await open(page, m); await pickFile(page, 'workspace_presentation_raw.webm', 12 * MiB);
    await job(page).waitFor();
    await until(async () => (await phase(page)) === 'SUCCESS', 'success', 30000);
    const seen = await page.evaluate(() => window.__phases);
    eq(subsequence(seen, ['INITIALIZING', 'UPLOADING', 'ASSEMBLING', 'SUCCESS']), true, 'phases were ' + seen.join('>'));
    eq(await job(page).getByRole('progressbar').getAttribute('aria-valuenow'), '100');
    eq(m.total, 3); eq(Object.keys(m.putAttempts).length, 3, 'all three parts were sent'); eq(m.completes, 1);
    await page.locator('li[data-clip-id]', { hasText: 'workspace_presentation_raw' }).getByText('Ready').waitFor();
  }],

  ['503 outage at the start: the server\'s message is shown, a Retry button appears, the page stays usable, and Retry works once the service is back', async (page) => {
    const m = newMock(6 * MiB);
    m.start = (n) => (n === 1 ? { status: 503, headers: { 'retry-after': '5' }, body: { error: 'storage_error', message: 'Video storage did not respond. Try again shortly.' } } : null);
    await open(page, m); await pickFile(page, 'architecture_review.webm', 6 * MiB);
    await until(async () => (await phase(page)) === 'FAILED', 'failed', 15000);
    await job(page).getByText('Upload failed').waitFor();
    await job(page).getByText('Video storage did not respond. Try again shortly.').waitFor();
    eq(await m.putAttempts[1], undefined, 'nothing was sent to storage');
    // the rest of the page keeps working: the create menu opens and Upload video is still enabled
    await page.getByRole('button', { name: 'Create a clip' }).click();
    eq(await page.getByRole('menuitem', { name: 'Upload video' }).getAttribute('data-disabled'), null, 'Upload video is enabled');
    await page.keyboard.press('Escape');
    await job(page).getByRole('button', { name: /^Retry/ }).click();
    await until(async () => (await phase(page)) === 'SUCCESS', 'success after retry', 20000);
    eq(m.starts, 2);
  }],

  ['a part that keeps failing: FAILED after the retries; Retry resumes and sends ONLY the missing part', async (page) => {
    const m = newMock(12 * MiB); let healed = false;
    m.put = (part) => (part === 2 && !healed ? 500 : null);
    await open(page, m); await pickFile(page, 'big.webm', 12 * MiB);
    await until(async () => (await phase(page)) === 'FAILED', 'failed after retries', 40000);
    eq(m.putAttempts[2], 4, 'part 2 was tried 4 times');
    eq(m.putAttempts[1], 1); eq(m.putAttempts[3], 1);
    eq(m.completes, 0, 'never completed');
    healed = true; m.current && (m.current.status = 'UPLOADING');
    await job(page).getByRole('button', { name: /^Retry/ }).click();
    await until(async () => (await phase(page)) === 'SUCCESS', 'success after retry', 20000);
    eq(m.putAttempts[1], 1, 'part 1 was not sent again'); eq(m.putAttempts[3], 1, 'part 3 was not sent again'); eq(m.putAttempts[2], 5);
    eq(m.starts, 1, 'the same clip was resumed, not a new one'); eq(m.completes, 1);
  }],

  ['a dropped connection and a 429 while signing are both retried transparently', async (page) => {
    const m = newMock(12 * MiB);
    m.sign = (n) => (n === 1 ? { status: 429, body: { error: 'rate_limited', message: 'Too many requests. Slow down.' } } : null);
    m.put = (part, attempt) => (part === 3 && attempt === 1 ? 'drop' : null);
    await open(page, m); await pickFile(page, 'flaky.webm', 12 * MiB);
    await until(async () => (await phase(page)) === 'SUCCESS', 'success', 30000);
    eq(m.putAttempts[3], 2, 'the dropped part was sent again'); eq(m.signCalls.length >= 4, true, 'the 429 was retried');
    const seen = await page.evaluate(() => window.__phases); eq(seen.includes('FAILED'), false, 'it never showed a failure');
  }],

  ['cancel while uploading: CANCELED, the server is told to abort, nothing is completed', async (page) => {
    const m = newMock(12 * MiB); m.putDelay = 4000;
    await open(page, m); await pickFile(page, 'cancel_me.webm', 12 * MiB);
    await until(async () => (await phase(page)) === 'UPLOADING', 'uploading');
    await job(page).getByRole('button', { name: 'Cancel' }).click();
    await until(async () => (await phase(page)) === 'CANCELED', 'canceled');
    await until(async () => m.aborts === 1, 'abort call reached the server');
    eq(m.completes, 0);
  }],

  ['a file that is not a video is refused with a message, and nothing starts', async (page) => {
    const m = newMock(1000);
    await open(page, m); await pickFile(page, 'notes.txt', 100, 'text/plain');
    await page.getByRole('status').getByText('Only WebM and MP4 videos can be uploaded.').waitFor();
    eq(await panel(page).count(), 0, 'no upload panel'); eq(m.starts, 0);
  }],

  ['closing the tab while an upload is running asks for confirmation (Chromium)', async (page) => {
    const m = newMock(12 * MiB); m.putDelay = 6000; const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.type()); d.dismiss().catch(() => null); });
    await open(page, m); await pickFile(page, 'long.webm', 12 * MiB);
    await until(async () => (await phase(page)) === 'UPLOADING', 'uploading');
    await page.close({ runBeforeUnload: true });
    await until(() => dialogs.includes('beforeunload'), 'a beforeunload prompt was shown', 5000);
  }, ['chromium']],
];

// ---- run ----------------------------------------------------------------------------------------------------------------------------------
const web = spawn(process.execPath, [path.join(root, 'web', 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(WEB_PORT)], { cwd: path.join(root, 'web'), env: { ...process.env, PORT: String(WEB_PORT), NEXT_TELEMETRY_DISABLED: '1' }, stdio: 'ignore' });
let failures = 0, ran = 0, skipped = 0;
try {
  await until(async () => (await fetch(WEB + '/')).status < 500, 'web up', 40000);
  for (const name of (process.env.BROWSERS || 'chromium').split(',').map((s) => s.trim()).filter(Boolean)) {
    const type = pw[name]; if (!type) { log(`SKIP ${name}: unknown browser`); continue; }
    let browser;
    try { browser = await type.launch({ headless: true }); } catch (e) { log(`SKIP ${name}: could not start (${String(e.message).split('\n')[0]})`); skipped++; continue; }
    log(`--- ${name} ${browser.version()}`);
    for (const [title, fn, only] of scenarios) {
      if (only && !only.includes(name)) { log(`skip ${name}: ${title.slice(0, 60)}... (not supported there)`); continue; }
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const page = await ctx.newPage();
      const errors = []; page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
      ran++;
      try { await fn(page); if (errors.length) throw new Error('script errors: ' + errors.join(' | ')); log(`ok   [${name}] ${title}`); }
      catch (e) { failures++; log(`FAIL [${name}] ${title}\n     ${String(e.message).split('\n').slice(0, 4).join('\n     ')}`); }
      await ctx.close().catch(() => null);
    }
    await browser.close();
  }
} catch (e) { failures++; log('ABORTED: ' + (e && e.message)); }
finally { try { web.kill(); } catch { /* gone */ } }
log(failures ? `\n${failures} FAILED of ${ran} runs` : `\nALL ${ran} RUNS PASSED${skipped ? ` (${skipped} browser(s) skipped)` : ''}`);
process.exit(failures ? 1 : 0);
