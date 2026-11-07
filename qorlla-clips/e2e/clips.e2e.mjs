// End-to-end check of the real Clips UI in Chromium: the production Next.js build, the Express API, SQLite, and a real S3-compatible
// object store (MinIO). Chromium's fake camera supplies the video, so no real hardware is used.
//
//   1. cd ../web && NEXT_PUBLIC_DEV_USER=casey@clips.test NEXT_PUBLIC_DEV_ORG=e2e NEXT_PUBLIC_DEV_ROLE=admin npm run build
//   2. node e2e/clips.e2e.mjs
//
// Object store: set S3_TEST_ENDPOINT (+ S3_TEST_ACCESS_KEY / S3_TEST_SECRET_KEY), or leave unset and the script starts a throwaway
// MinIO container itself (docker is required) and removes it afterwards. Without either, the recording steps are skipped, loudly.
// playwright-core comes from PLAYWRIGHT_CORE, web/node_modules, or the parent project's node_modules.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pwCandidates = [process.env.PLAYWRIGHT_CORE, path.join(root, 'web', 'node_modules', 'playwright-core'), path.resolve(root, '..', 'node_modules', 'playwright-core')].filter(Boolean);
const pwDir = pwCandidates.find((d) => existsSync(path.join(d, 'index.mjs')));
if (!pwDir) throw new Error('playwright-core not found (set PLAYWRIGHT_CORE)');
const { chromium } = await import(pathToFileURL(path.join(pwDir, 'index.mjs')).href);
const shots = process.env.SHOTS_DIR; if (shots) mkdirSync(shots, { recursive: true });

const API_PORT = 5400, WEB_PORT = 3411;            // the web build forwards /api to :5400 (see web/next.config.mjs)
const API = `http://127.0.0.1:${API_PORT}`, WEB = `http://127.0.0.1:${WEB_PORT}`;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'clips-e2e-'));
const dbUrl = 'file:' + path.join(tmp, 'e2e.db').replace(/\\/g, '/');
const children = []; let ownMinio = null;
const log = (m) => console.log(m);
let failures = 0, skipped = 0;
const step = async (name, fn) => { try { await fn(); log('ok   ' + name); } catch (e) { failures++; log('FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 5).join('\n     ')); } };
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg || 'values differ'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const until = async (fn, msg, ms = 15000) => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* keep trying */ } if (Date.now() - t > ms) throw new Error('timed out: ' + msg); await new Promise((r) => setTimeout(r, 100)); } };

async function api(user, method, p, body) {
  const r = await fetch(API + '/api' + p, { method, headers: { 'x-requested-with': 'qorlla-clips', 'x-dev-user': user, 'x-dev-org': 'e2e', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Finds or starts an S3-compatible store. Returns { endpoint, key, secret } or null. */
async function objectStore() {
  if (process.env.S3_TEST_ENDPOINT) return { endpoint: process.env.S3_TEST_ENDPOINT, key: process.env.S3_TEST_ACCESS_KEY, secret: process.env.S3_TEST_SECRET_KEY };
  if (spawnSync('docker', ['version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status !== 0) return null;
  const name = 'clips-e2e-minio-' + randomBytes(3).toString('hex'), key = 'e2e' + randomBytes(5).toString('hex'), secret = randomBytes(18).toString('hex');
  const r = spawnSync('docker', ['run', '-d', '--name', name, '-p', '127.0.0.1:9191:9000', '-e', `MINIO_ROOT_USER=${key}`, '-e', `MINIO_ROOT_PASSWORD=${secret}`, '-e', `MINIO_API_CORS_ALLOW_ORIGIN=${WEB}`, process.env.MINIO_IMAGE || 'minio/minio:latest', 'server', '/data'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) { log('     (could not start MinIO: ' + String(r.stderr).split('\n')[0] + ')'); return null; }
  ownMinio = name;
  await until(async () => (await fetch('http://127.0.0.1:9191/minio/health/ready')).ok, 'MinIO ready', 60000);
  return { endpoint: 'http://127.0.0.1:9191', key, secret };
}

try {
  const store = await objectStore();
  const env = { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: 'test', AUTH_MODE: 'dev', TRUST_PROXY: '1', PORT: String(API_PORT), NEXT_TELEMETRY_DISABLED: '1' };
  if (store) Object.assign(env, { S3_ENDPOINT: store.endpoint, S3_PUBLIC_ENDPOINT: store.endpoint, S3_BUCKET: 'clips-e2e', S3_ACCESS_KEY_ID: store.key, S3_SECRET_ACCESS_KEY: store.secret, S3_FORCE_PATH_STYLE: '1', S3_AUTO_CREATE_BUCKET: '1', UPLOAD_PART_MB: '5' });
  else log('NOTE: no object store available: the recording steps will be skipped');
  const r = spawnSync(process.execPath, ['scripts/db.mjs', 'push'], { cwd: path.join(root, 'api'), env, stdio: 'ignore' });
  if (r.status !== 0) throw new Error('db push failed');
  children.push(spawn(process.execPath, ['src/server.js'], { cwd: path.join(root, 'api'), env, stdio: 'ignore' }));
  const nextBin = path.join(root, 'web', 'node_modules', 'next', 'dist', 'bin', 'next');
  children.push(spawn(process.execPath, [nextBin, 'start', '-p', String(WEB_PORT)], { cwd: path.join(root, 'web'), env: { ...env, PORT: String(WEB_PORT) }, stdio: 'ignore' }));
  await until(async () => (await fetch(API + '/healthz')).ok, 'API up', 30000);
  await until(async () => (await fetch(WEB + '/')).ok, 'web up', 30000);

  const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('response', async (resp) => { if (resp.url().includes('/api/') && resp.status() >= 400) log(`     [api ${resp.status()}] ${resp.request().method()} ${new URL(resp.url()).pathname} ${(await resp.text().catch(() => '')).slice(0, 110)}`); });
  const shot = async (n) => { if (shots) await page.screenshot({ path: path.join(shots, n + '.png') }); };
  const title = () => page.getByTestId('view-title').innerText();
  const nav = (n) => page.locator(`a[data-nav="${n}"]`);
  const count = (n) => nav(n).locator('span[aria-label]').first().innerText().catch(() => '0');
  const go = async (n, expectTitle) => { await nav(n).click(); await until(async () => (await title()) === expectTitle, `navigated to ${expectTitle}`); };
  const toast = () => page.getByRole('status');
  const row = (name) => page.locator('li[data-clip-id]', { hasText: name });
  const rowMenu = async (name, item) => { await row(name).getByRole('button', { name: /More actions for/ }).click(); await page.getByRole('menuitem', { name: item }).click(); };

  await step('routes: / redirects to My playlists; every sidebar item is a real link to its own page', async () => {
    await page.goto(WEB + '/', { waitUntil: 'domcontentloaded' });
    await until(async () => page.url().endsWith('/dashboard/my-playlists'), 'redirect');
    eq(await title(), 'My playlists');
    const expected = { notifications: 'Notifications', recent: 'Recent', 'my-clips': 'My clips', 'my-playlists': 'My playlists', 'shared-with-me': 'Shared with me', starred: 'Starred', organization: 'Organization playlists', trash: 'Trash', 'creation/avatars': 'Avatars', 'creation/projects': 'Projects' };
    for (const [n, label] of Object.entries(expected)) { eq(await nav(n).getAttribute('href'), '/dashboard/' + n, 'href of ' + n); eq((await nav(n).innerText()).startsWith(label), true, 'label of ' + n); }
    eq(await nav('my-playlists').getAttribute('aria-current'), 'page', 'active link');
    eq((await page.locator('body').innerText()).toLowerCase().includes('zoom'), false, 'no third-party brand');
    await shot('1-empty');
  });

  await step('the shell stays mounted: navigating swaps only the page (no reload, same sidebar element), and the highlight follows the URL', async () => {
    await page.evaluate(() => { window.__marker = document.querySelector('nav[aria-label="Clips navigation"]'); window.__alive = 42; });
    for (const [n, t] of [['recent', 'Recent'], ['starred', 'Starred'], ['trash', 'Trash'], ['creation/projects', 'Projects'], ['notifications', 'Notifications'], ['my-playlists', 'My playlists']]) {
      await go(n, t);
      eq(await nav(n).getAttribute('aria-current'), 'page', 'current after going to ' + n);
      eq(await page.locator('a[aria-current=page]').count(), 1, 'exactly one active link');
    }
    eq(await page.evaluate(() => window.__alive === 42 && document.querySelector('nav[aria-label="Clips navigation"]') === window.__marker), true, 'no page reload, same element');
    await go('creation/projects', 'Projects'); await page.getByText('Projects are not available yet').waitFor();
  });

  await step('deep links work after a reload, and an unknown page is a 404', async () => {
    await page.goto(WEB + '/dashboard/starred', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('view-title').waitFor();
    eq(await title(), 'Starred'); eq(await nav('starred').getAttribute('aria-current'), 'page');
    const nf = await page.goto(WEB + '/dashboard/nope', { waitUntil: 'domcontentloaded' });
    eq(nf.status(), 404);
    await page.goto(WEB + '/dashboard/my-playlists', { waitUntil: 'domcontentloaded' }); await page.getByTestId('view-title').waitFor();
  });

  await step('the blue + opens a menu with four creation actions; Upload video is locked on the free plan', async () => {
    await page.getByRole('button', { name: 'Create a clip' }).click();
    eq((await page.getByRole('menuitem').allInnerTexts()).join('|'), 'Record a clip|Create with avatars|Create from slides|Upload video', 'menu items');
    eq((await page.getByRole('menuitem', { name: 'Upload video' }).getAttribute('data-disabled')) !== null, true, 'Upload is disabled');
    await page.getByLabel('Locked').waitFor();
    await shot('2-create-menu');
    await page.keyboard.press('Escape');
  });

  await step('"Create with avatars" makes a Processing clip (no pipeline yet, and it says so); it shows under My clips and Avatars', async () => {
    await page.getByRole('button', { name: 'Create a clip' }).click();
    await page.getByRole('menuitem', { name: 'Create with avatars' }).click();
    await until(async () => (await title()) === 'My clips', 'went to My clips');
    await row('Untitled clip').getByText('Processing').waitFor();
    await until(async () => (await count('my-clips')) === '1', 'counter 1');
    await go('creation/avatars', 'Avatars'); await row('Untitled clip').waitFor();
  });

  let recordedBytes = null;
  if (store) {
    await step('RECORD: camera preview -> record -> review -> save; the upload runs in the background and retries a failed part by itself', async () => {
      await go('my-clips', 'My clips');
      await page.getByRole('button', { name: 'Create a clip' }).click();
      await page.getByRole('menuitem', { name: 'Record a clip' }).click();
      const rec = page.locator('[data-recorder-state]');
      await until(async () => (await rec.getAttribute('data-recorder-state')) === 'ready', 'camera ready');
      await until(() => page.evaluate(() => { const v = document.querySelector('video[aria-label="Camera preview"]'); return !!v && v.videoWidth > 0; }), 'live preview has frames');
      await shot('3-recorder-ready');
      await page.getByRole('button', { name: 'Start recording' }).click();
      await page.getByText(/REC \d\d:\d\d/).waitFor();
      await page.waitForTimeout(2600);
      await page.getByRole('button', { name: 'Stop' }).click();
      await until(async () => (await rec.getAttribute('data-recorder-state')) === 'recorded', 'recorded');
      await page.getByLabel('Preview of your recording').waitFor();
      await shot('4-recorded');

      let puts = 0;                                                                // fail the FIRST storage PUT: the client must retry it
      await page.route((u) => u.href.includes('X-Amz-Signature') && u.href.startsWith(store.endpoint), (route) => (route.request().method() === 'PUT' && puts++ === 0 ? route.abort('failed') : route.continue()));
      await page.locator('#rec-title').fill('E2E recording');
      await page.getByRole('button', { name: 'Save to library' }).click();
      await until(async () => (await page.getByRole('dialog').count()) === 0, 'dialog closed');
      const job = page.locator('section[aria-label=Uploads] li[data-upload-id]').first();
      await job.waitFor();
      await until(async () => (await job.getAttribute('data-phase')) === 'SUCCESS', 'upload succeeded', 60000);
      eq(await job.getByRole('progressbar').getAttribute('aria-valuenow'), '100');
      eq(puts >= 2, true, 'the failed part was retried (PUT attempts: ' + puts + ')');
      await shot('5-uploaded');
      await row('E2E recording').waitFor(); await row('E2E recording').getByText('Ready').waitFor();
      await until(async () => (await count('my-clips')) === '2', 'My clips counter 2');
    });

    await step('PLAY: the clip plays from a signed link, and the stored bytes are a real video of the announced size', async () => {
      await row('E2E recording').getByRole('button', { name: /^Play / }).click();
      const dlg = page.getByRole('dialog');
      await until(() => page.evaluate(() => { const v = document.querySelector('[role=dialog] video'); return !!v && v.readyState >= 2 && v.videoWidth > 0; }), 'video has decoded frames', 30000);
      await shot('6-playing');
      await page.keyboard.press('Escape'); await until(async () => (await dlg.count()) === 0, 'player closed');
      const clips = (await api('casey@clips.test', 'GET', '/clips?view=mine&q=E2E')).body.clips;
      const c = clips.find((x) => x.title === 'E2E recording');
      eq(c.status, 'READY'); eq(c.playable, true); eq(c.sizeBytes > 1000, true, 'size recorded'); eq(c.mimeType.startsWith('video/'), true, 'mime');
      eq(JSON.stringify(c).includes('storageKey'), false, 'no storage internals in the API');
      const play = (await api('casey@clips.test', 'GET', `/clips/${c.id}/playback`)).body;
      const bytes = Buffer.from(await (await fetch(play.url)).arrayBuffer());
      recordedBytes = bytes;
      eq(bytes.length, c.sizeBytes, 'downloaded size equals the announced size');
      const magic = bytes.subarray(0, 4).toString('hex'); const mp4 = bytes.subarray(4, 8).toString('ascii') === 'ftyp';
      eq(magic === '1a45dfa3' || mp4, true, 'it is a WebM/MP4 file (header ' + magic + ')');
      eq((await fetch(play.url.replace(/X-Amz-Signature=[0-9a-f]+/, 'X-Amz-Signature=' + '0'.repeat(64)))).status, 403, 'a tampered link is refused');
      eq((await api('bob@clips.test', 'GET', `/clips/${c.id}/playback`)).status, 404, 'a teammate it was not shared with gets nothing');
    });

    await step('GRID view: the same clips as cards with source and length badges, the same actions, and the choice survives a reload', async () => {
      await go('my-clips', 'My clips');
      await page.getByRole('button', { name: 'Grid view' }).click();
      eq(await page.getByRole('button', { name: 'Grid view' }).getAttribute('aria-pressed'), 'true');
      const card = row('E2E recording');
      await card.waitFor();
      await card.getByText('Recording', { exact: true }).waitFor();                                  // source badge
      await card.getByLabel(/^Length \d\d:\d\d$/).waitFor();                                         // length badge from the recording
      await card.getByText('Ready').waitFor();
      await shot('6b-grid');
      await card.hover(); await card.getByRole('button', { name: /^Play / }).click();                // play from a card
      await until(() => page.evaluate(() => { const v = document.querySelector('[role=dialog] video'); return !!v && v.readyState >= 2 && v.videoWidth > 0; }), 'video plays from the grid', 30000);
      await page.keyboard.press('Escape'); await until(async () => (await page.getByRole('dialog').count()) === 0, 'player closed');
      await card.getByRole('button', { name: /^Star / }).click(); await until(async () => (await count('starred')) !== '0', 'starred from a card');
      await card.getByRole('button', { name: /^Unstar / }).click(); await until(async () => (await count('starred')) === '0', 'unstarred');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await row('E2E recording').waitFor();
      eq(await page.getByRole('button', { name: 'Grid view' }).getAttribute('aria-pressed'), 'true', 'grid remembered after reload');
      await page.getByRole('button', { name: 'List view' }).click();
      eq(await page.getByRole('button', { name: 'List view' }).getAttribute('aria-pressed'), 'true');
    });

    await step('UPLOAD (paid plan): "Upload video" unlocks, refuses non-video files, and uploads a real file through the same pipeline', async () => {
      const flip = spawnSync(process.execPath, ['--input-type=module', '-e', "import { PrismaClient } from '@prisma/client'; const p = new PrismaClient(); await p.organization.update({ where: { slug: 'e2e' }, data: { plan: 'pro' } }); await p.$disconnect();"], { cwd: path.join(root, 'api'), env, encoding: 'utf8' });
      eq(flip.status, 0, 'plan change: ' + flip.stderr);
      await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByTestId('view-title').waitFor();
      await go('my-clips', 'My clips');
      await page.getByRole('button', { name: 'Create a clip' }).click();
      eq((await page.getByRole('menuitem', { name: 'Upload video' }).getAttribute('data-disabled')), null, 'Upload is enabled on a paid plan');
      await page.keyboard.press('Escape');
      const input = page.getByTestId('upload-input');
      await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a video') });
      await toast().getByText('Only WebM and MP4 videos can be uploaded.').waitFor();
      await input.setInputFiles({ name: 'holiday.webm', mimeType: 'video/webm', buffer: recordedBytes });
      const job = page.locator('section[aria-label=Uploads] li[data-upload-id]', { hasText: 'holiday.webm' });
      await job.waitFor();
      await until(async () => (await job.getAttribute('data-phase')) === 'SUCCESS', 'file upload succeeded', 60000);
      await row('holiday').waitFor(); await row('holiday').getByText('Ready').waitFor(); await row('holiday').getByText('Upload', { exact: true }).waitFor();
      const c = (await api('casey@clips.test', 'GET', '/clips?view=mine&q=holiday')).body.clips[0];
      eq(c.source, 'UPLOAD'); eq(c.sizeBytes, recordedBytes.length);
      const got = Buffer.from(await (await fetch((await api('casey@clips.test', 'GET', `/clips/${c.id}/playback`)).body.url)).arrayBuffer());
      eq(got.equals(recordedBytes), true, 'the stored file is byte-for-byte the file that was picked');
    });

    await step('DISCARD: a recording that is discarded is never uploaded and leaves nothing behind', async () => {
      const before = (await api('casey@clips.test', 'GET', '/navigation/summary')).body.myClipsCount;
      await page.getByRole('button', { name: 'Create a clip' }).click();
      await page.getByRole('menuitem', { name: 'Record a clip' }).click();
      const rec = page.locator('[data-recorder-state]');
      await until(async () => (await rec.getAttribute('data-recorder-state')) === 'ready', 'camera ready');
      await page.getByRole('button', { name: 'Start recording' }).click(); await page.waitForTimeout(1200); await page.getByRole('button', { name: 'Stop' }).click();
      await until(async () => (await rec.getAttribute('data-recorder-state')) === 'recorded', 'recorded');
      await page.getByRole('button', { name: 'Discard' }).click();
      await until(async () => (await page.getByRole('dialog').count()) === 0, 'dialog closed');
      await page.waitForTimeout(500);
      eq((await api('casey@clips.test', 'GET', '/navigation/summary')).body.myClipsCount, before, 'no clip was created');
      eq(await page.locator('section[aria-label=Uploads] li[data-phase=INITIALIZING], section[aria-label=Uploads] li[data-phase=UPLOADING]').count(), 0, 'no upload running');
    });
  } else {
    skipped += 5; log('SKIP RECORD / PLAY / GRID / UPLOAD / DISCARD: no object store (set S3_TEST_ENDPOINT or install docker)');
  }

  await step('star, rename (with validation), and the Starred page', async () => {
    await go('my-clips', 'My clips');
    await row('Untitled clip').getByRole('button', { name: /^Star / }).click();
    await until(async () => (await count('starred')) === '1', 'Starred counter');
    await rowMenu('Untitled clip', 'Rename');
    await page.getByLabel('Clip name').fill('');                                      // the dialog opens pre-filled
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('alert').getByText('Clip name is required.').waitFor();
    await page.getByLabel('Clip name').fill('Demo reel');
    await page.getByRole('button', { name: 'Save' }).click();
    await row('Demo reel').waitFor();
    await go('starred', 'Starred'); await row('Demo reel').waitFor();
  });

  await step('playlists: create, add a clip from its menu, open it (its own URL), remove the clip', async () => {
    await go('my-playlists', 'My playlists');
    await page.getByRole('button', { name: 'New playlist' }).click();
    await page.getByLabel('Playlist name').fill('Launch');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.locator('[data-playlist-id]', { hasText: 'Launch' }).getByText('0 clips').waitFor();
    await go('my-clips', 'My clips');
    await rowMenu('Demo reel', 'Add to playlist');
    await page.getByRole('button', { name: /^Launch/ }).click();
    await toast().getByText('Added to playlist.').waitFor();
    await go('my-playlists', 'My playlists');
    await page.locator('[data-playlist-id]', { hasText: 'Launch' }).getByText('1 clip').waitFor();
    await page.locator('[data-playlist-id]', { hasText: 'Launch' }).click();
    await until(async () => (await title()) === 'Launch', 'opened the playlist');
    eq(/\/dashboard\/my-playlists\/[0-9a-f-]{36}$/.test(page.url()), true, 'playlist has its own URL');
    eq(await nav('my-playlists').getAttribute('aria-current'), 'page', 'My playlists stays highlighted for its playlists');
    await row('Demo reel').waitFor(); await shot('7-playlist');
    const here = page.url();
    await page.reload({ waitUntil: 'domcontentloaded' }); await row('Demo reel').waitFor(); eq(page.url(), here, 'reload keeps the URL');
    await rowMenu('Demo reel', 'Remove from playlist');
    await until(async () => (await row('Demo reel').count()) === 0, 'clip left the playlist');
    await page.getByText('This playlist has no clips yet').waitFor();
    await page.getByRole('link', { name: /My playlists/ }).first().click();
    await until(async () => (await title()) === 'My playlists', 'back to the list');
  });

  await step('sharing: an unknown email is refused inside the dialog; a teammate is notified', async () => {
    await api('bob@clips.test', 'GET', '/me');
    await go('my-clips', 'My clips');
    await rowMenu('Demo reel', 'Share');
    await page.getByLabel('Email address').fill('nobody@clips.test');
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await page.getByRole('alert').getByText(/No one in your organization/).waitFor();
    await page.getByLabel('Email address').fill('bob@clips.test');
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await toast().getByText('Clip shared.').waitFor();
    const bob = (await api('bob@clips.test', 'GET', '/navigation/summary')).body;
    eq(bob.sharedCount, 1, "bob's Shared with me"); eq(bob.unreadNotifications, 1, "bob's notification");
  });

  await step('being shared with: Notifications shows the message, the badge clears, and the clip is read-only', async () => {
    const mk = (await api('bob@clips.test', 'POST', '/clips', { source: 'AVATAR_GENERATION', title: 'From Bob' })).body;
    eq((await api('bob@clips.test', 'POST', `/clips/${mk.id}/share`, { email: 'casey@clips.test' })).status, 201);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await until(async () => (await count('notifications')) === '1', 'unread badge');
    await go('notifications', 'Notifications');
    await page.getByText(/bob shared "From Bob" with you/).waitFor();
    await until(async () => (await count('notifications')) === '0', 'badge cleared after reading');
    await go('shared-with-me', 'Shared with me');
    await row('From Bob').getByText(/Shared by bob/).waitFor();
    // not yours: the only thing in its menu is Report (no rename, share, trash)
    await row('From Bob').getByRole('button', { name: /More actions/ }).click();
    eq(await page.getByRole('menuitem').count(), 1, 'one action on a clip you do not own');
    await page.getByRole('menuitem', { name: 'Report' }).waitFor();
    await page.keyboard.press('Escape');
  });

  await step('trash: move, restore, move again, delete forever (with confirmation)', async () => {
    await go('my-clips', 'My clips');
    await rowMenu('Demo reel', 'Move to trash');
    await until(async () => (await row('Demo reel').count()) === 0, 'left My clips');
    await until(async () => (await count('trash')) === '1', 'Trash counter');
    await go('trash', 'Trash');
    await rowMenu('Demo reel', 'Restore');
    await until(async () => (await row('Demo reel').count()) === 0, 'left Trash');
    await go('my-clips', 'My clips'); await row('Demo reel').waitFor();
    await rowMenu('Demo reel', 'Move to trash');
    await go('trash', 'Trash');
    await rowMenu('Demo reel', 'Delete forever');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await row('Demo reel').waitFor();                                                   // cancel keeps it
    await rowMenu('Demo reel', 'Delete forever');
    await page.getByRole('button', { name: 'Delete forever' }).click();
    await until(async () => (await row('Demo reel').count()) === 0, 'deleted');
    await page.getByText('Trash is empty').waitFor();
  });

  await step('search narrows the list', async () => {
    for (const t of ['Alpha one', 'Beta two']) await api('casey@clips.test', 'POST', '/clips', { source: 'AVATAR_GENERATION', title: t });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await go('my-clips', 'My clips');
    await row('Alpha one').waitFor(); await row('Beta two').waitFor();
    await page.getByPlaceholder('Search clips').fill('alpha');
    await until(async () => (await row('Beta two').count()) === 0, 'filtered');
    await page.getByPlaceholder('Search clips').fill('zzz');
    await page.getByText('No clips match your search.').waitFor();
  });

  await step('organization playlists: an admin creates one (and opens it); a member sees it but cannot create', async () => {
    await go('organization', 'Organization playlists');
    await page.getByRole('button', { name: 'New playlist' }).click();
    await page.getByLabel('Playlist name').fill('Company updates');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.locator('[data-playlist-id]', { hasText: 'Company updates' }).click();
    await until(async () => (await title()) === 'Company updates', 'opened');
    eq(/\/dashboard\/organization\/[0-9a-f-]{36}$/.test(page.url()), true, 'organization playlist URL');
    eq(await nav('organization').getAttribute('aria-current'), 'page');
    const bob = (await api('bob@clips.test', 'GET', '/navigation/summary')).body;
    eq(bob.organizationPlaylists.map((p) => p.title).join(), 'Company updates');
    eq((await api('bob@clips.test', 'POST', '/playlists', { title: 'x', isOrganization: true })).status, 403);
    const other = await (await fetch(API + '/api/navigation/summary', { headers: { 'x-dev-user': 'eve@other.test', 'x-dev-org': 'other-org' } })).json();
    eq(JSON.stringify(other).includes('Company updates'), false, 'another organization never sees it');
    await shot('8-org-playlist');
  });

  await step('keyboard: the create menu opens with Enter and closes with Escape; the sidebar collapses and expands', async () => {
    const plus = page.getByRole('button', { name: 'Create a clip' });
    await plus.focus(); await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Record a clip' }).waitFor();
    await page.keyboard.press('Escape');
    await until(async () => (await page.getByRole('menuitem').count()) === 0, 'menu closed');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await until(async () => (await nav('my-clips').count()) === 0, 'sidebar hidden');
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await nav('my-clips').waitFor();
  });

  await step('analytics: real numbers on the page, a downloadable PDF; and a reported clip reaches the admin queue, where trashing it is audited', async () => {
    const days = 30;
    await go('analytics', 'Analytics');
    await page.locator('[data-stat="Clips"]').waitFor();
    const apiNums = (await api('casey@clips.test', 'GET', `/analytics/overview?days=${days}`)).body;
    eq(await page.locator('[data-stat="Clips"]').innerText(), String(apiNums.totals.clips), 'clips total matches the API');
    eq((await page.getByTestId('scope').innerText()).startsWith('Everyone in your organization'), true, 'an admin sees the whole organization');
    eq(await page.locator('svg[role="img"]').count(), 2, 'two charts');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PDF' }).click()]);
    eq(dl.suggestedFilename(), 'clips-report.pdf');
    const pdf = readFileSync(await dl.path()); eq(pdf.subarray(0, 5).toString(), '%PDF-', 'a real PDF');
    // a member reports a clip that casey owns; the admin (casey) reviews it in the browser
    const victim = (await api('casey@clips.test', 'POST', '/clips', { source: 'AVATAR_GENERATION', title: 'Needs review' })).body;
    eq((await api('casey@clips.test', 'POST', `/clips/${victim.id}/share`, { email: 'bob@clips.test' })).status, 201);
    eq((await api('bob@clips.test', 'POST', `/clips/${victim.id}/report`, { reason: 'looks wrong to me' })).status, 201);
    eq((await api('bob@clips.test', 'GET', '/admin/reports')).status, 403, 'a member cannot read the queue');
    await go('admin', 'Moderation');
    await page.locator('li[data-report-id]', { hasText: 'Needs review' }).getByText('looks wrong to me').waitFor();
    await page.locator('li[data-report-id]', { hasText: 'Needs review' }).getByRole('button', { name: 'Move to trash' }).click();
    await toast().getByText('Clip moved to the trash.').waitFor();
    await page.getByText('No open reports.').waitFor();
    await page.getByRole('list', { name: 'Audit log' }).getByText(/moved a clip to the trash/).waitFor();
    eq((await api('casey@clips.test', 'GET', `/clips?view=trash`)).body.clips.some((c) => c.id === victim.id), true, 'the clip is in the trash');
  });

  await step('no script errors in the browser', async () => { eq(errors.length, 0, errors.join(' | ')); });
  await browser.close();
} catch (e) {
  failures++; log('ABORTED: ' + (e && e.message));
} finally {
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  if (ownMinio) spawnSync('docker', ['rm', '-f', ownMinio], { stdio: 'ignore', shell: process.platform === 'win32' });
  await new Promise((r) => setTimeout(r, 800));
  rmSync(tmp, { recursive: true, force: true });
}
log(failures ? `\n${failures} FAILED${skipped ? `, ${skipped} skipped` : ''}` : `\nALL E2E STEPS PASSED${skipped ? ` (${skipped} skipped)` : ''}`);
process.exit(failures ? 1 : 0);
