const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { BASE, dbq, signUp, signUpWithWorkspace } = require('./helpers');

// Controlled-restart persistence on the ISOLATED compose project. Creates documents, a sheet, slides, sharing, a native and a scheduled Meet meeting and a consented recording with known bytes,
// restarts the applications one at a time, verifies everything, then restarts the databases WITHOUT touching the applications, and verifies again. Active calls are not expected to survive a restart.
// Needs the stack up (E2E_BASE, E2E_DB_CONTAINER, E2E_COMPOSE_PROJECT, E2E_ADMIN_SECRET, E2E_RECORDING_DIR as for meet-recording-storage.spec.js). Never run it against another stack.
async function addMember(ownerCtx, ownerCsrf, ws, userId) {
  const r = await ownerCtx.request.post('/api/v1/members', { data: { user_id: String(userId).replace(/^u_/, ''), role: 'member' }, headers: { 'x-csrf-token': ownerCsrf, origin: BASE, 'x-workspace-id': ws } });
  if (r.status() !== 201) throw new Error('add member failed ' + r.status() + ' ' + (await r.text()));
}
const MEET = process.env.E2E_MEET_PATH || '/meet/';
const ROOT = MEET.replace(/\/?$/, '/');
const API = ROOT + 'api/v1/meetings/', RAPI = ROOT + 'api/v1/recordings/';
const STORE = process.env.E2E_RECORDING_DIR || path.resolve(__dirname, '../../.dev-stack/recordings');
const ADMIN = process.env.E2E_ADMIN_SECRET || 'test-admin-secret';
const HDR = '1a45dfa3';                                                        // EBML header of a WebM file

async function open(browser, who, code, { holdUploads = true } = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE, permissions: ['camera', 'microphone'], viewport: { width: 1366, height: 768 } }); const page = await ctx.newPage();
  // the page's own recorder uploads are held back so the test's bytes are the only media; requests marked x-test-manual go through
  if (holdUploads) await page.route('**/recordings/*/chunks*', (r) => (r.request().headers()['x-test-manual'] ? r.continue() : r.abort()));
  if (holdUploads) await page.route('**/recordings/*/complete', (r) => (r.request().headers()['x-test-manual'] ? r.continue() : r.abort()));
  await page.goto(MEET); await page.fill('#displayName', who);
  if (code) { await page.fill('#meetingId', code); await page.click('#joinBtn'); } else { await page.fill('#meetingTitle', 'Storage check'); await page.click('#createBtn'); }
  await page.waitForSelector('#app:not(.hidden)'); await expect(page.locator('#liveBadge')).toHaveAttribute('data-state', 'live'); await page.waitForFunction(() => window.__qorlla.state.stream);
  const out = { ctx, page }; if (!code) out.code = (await page.locator('#roomId').textContent()).trim(); out.session = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qorlla-session'))); return out;
}
// authenticated call (as person p) to a path under the meeting, or an absolute API path when it starts with /api
async function call(p, pathStr, method = 'GET', body, extraHeaders = {}) {
  const url = pathStr.startsWith('/api') ? ROOT + pathStr.slice(1) : API + p.session.meetingId + pathStr;
  const res = await p.page.evaluate(async ({ url, method, body, t, h }) => { const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...h }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch {} return { status: r.status, body: json, text }; },
    { url, method, body, t: p.session.token, h: extraHeaders });
  // Meet returns root-relative links (/api/recordings/...); its own page adds its base path (BASE + url). Behind the /meet/ proxy prefix the same must be done here.
  if (res && res.body && typeof res.body.url === 'string' && res.body.url.startsWith('/api/')) res.body.url = ROOT + res.body.url.slice(1);
  return res;
}
// upload a chunk with exact bytes (array of numbers); returns status
const upload = (p, rid, seq, bytes) => p.page.evaluate(async ({ url, t, bytes }) => { const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/octet-stream', 'x-test-manual': '1' }, body: new Uint8Array(bytes) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, { url: API + p.session.meetingId + '/recordings/' + rid + '/chunks?seq=' + seq, t: p.session.token, bytes });
const complete = (p, rid, chunks) => p.page.evaluate(async ({ url, t, chunks }) => { const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', 'x-test-manual': '1' }, body: JSON.stringify({ chunks }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, { url: API + p.session.meetingId + '/recordings/' + rid + '/complete', t: p.session.token, chunks });
const fileBytes = (...strs) => strs.flatMap((s) => [...Buffer.from(s, 'latin1')]);
const webm = (marker) => [...Buffer.from(HDR, 'hex'), ...Buffer.from(marker, 'latin1')];
// fetch the decrypted media through a fresh single-use link; returns { status, hex(utf8-safe base64) }
async function download(p, rid) {
  const acc = await call(p, '/api/v1/recordings/' + rid + '/access'); if (acc.status !== 200) return { status: acc.status, body: acc.body };
  const r = await p.page.evaluate(async (u) => { try { const x = await fetch(u); const b = new Uint8Array(await x.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 30000) s += String.fromCharCode.apply(null, b.subarray(i, i + 30000)); return { status: x.status, b64: btoa(s) }; } catch (e) { return { status: 0, error: String(e) }; } }, acc.body.url);
  return { ...r, bytes: r.b64 ? Buffer.from(r.b64, 'base64') : null, link: acc.body.url };
}
async function request(host, extra = {}) {
  await host.page.click('#recordBtn'); await host.page.fill('#rc_purpose', extra.purpose || 'Storage test'); await host.page.fill('#rc_recipients', 'The team'); await host.page.selectOption('#rc_days', extra.days || '30'); await host.page.fill('#rc_privacyContact', 'privacy@example.com');
  await host.page.getByRole('button', { name: 'Send request' }).click(); await expect(host.page.locator('#rcModal')).toHaveCount(0);
}
async function agree(p) { const d = p.page.locator('#rcModal'); await d.locator('#rcVideo').check(); await d.locator('#rcAudio').check(); await d.locator('#rcReviewed').check(); await d.getByRole('button', { name: 'Agree' }).click(); await expect(p.page.locator('#rcModal')).toHaveCount(0); }
// meeting with a host and one consenting guest, recording started; the page's own recorder is held back
async function started(browser, extra = {}) {
  const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code); await request(a, extra); await agree(b);
  await expect(async () => { expect((await call(a, '/recording')).body.status).toBe('ready'); }).toPass();
  const st = await call(a, '/recording/start', 'POST'); expect(st.status).toBe(200); return { a, b, rid: st.body.recordingId, sid: st.body.sessionId };
}
const objectDir = (rid) => path.join(STORE, rid);
const list = async (p) => (await call(p, '/recordings')).body.recordings || [];
const statusOf = async (p, rid) => (await list(p)).find((r) => r.id === rid)?.status;
const closeAll = async (...ps) => { for (const p of ps) await p.ctx.close().catch(() => {}); };

// ============================================================ persistence across controlled container restarts
const { execFileSync } = require('node:child_process');
const PROJECT = process.env.E2E_COMPOSE_PROJECT || 'qiso';
const dc = (...a) => execFileSync('docker', a, { encoding: 'utf8' }).trim();
const meetDb = (sql) => dc('exec', PROJECT + '-meet-db-1', 'psql', '-U', 'qorlla', '-d', 'qorlla_meet', '-tAc', sql);
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const healthy = (name) => { try { return dc('inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', name); } catch { return 'missing'; } };
async function waitHealthy(names, ms = 180000) { const t0 = Date.now(); for (;;) { const s = names.map((n) => [n, healthy(n)]); if (s.every(([, v]) => v === 'healthy' || v === 'running')) return s; if (Date.now() - t0 > ms) throw new Error('not healthy in time: ' + JSON.stringify(s)); await sleepMs(3000); } }
const APPS = [PROJECT + '_proxy', PROJECT + '-qorlla-portal-1', PROJECT + '-meet-1', PROJECT + '_main', PROJECT + '-meet-sync-worker-1'];
const DBS = [PROJECT + '-main-db-1', PROJECT + '-meet-db-1'];
const evidence = { restarts: [] };
const SCHED_TITLE = 'Persist scheduled ' + Date.now();   // unique per run: earlier runs leave their meetings in the persistent database

test.describe('persistence across controlled restarts', () => {
  test('documents, sheets, slides, sharing, sessions, meetings and a consented recording survive an application restart and then a database restart', async ({ browser }) => {
    test.setTimeout(900000);
    // ---------------------------------------------------------------- state before any restart
    const ctx = await browser.newContext({ baseURL: BASE }); const page = await ctx.newPage(); const owner = await signUpWithWorkspace(ctx, 'persist');
    const H = { 'x-csrf-token': owner.csrf, origin: BASE, 'x-workspace-id': owner.workspaceId };
    const create = async (kind, title) => { await page.goto('/app/suite'); await page.selectOption('#doc-form [name=kind]', kind); await page.fill('#doc-form [name=title]', title); await page.getByRole('button', { name: 'Create', exact: true }).click(); await page.waitForURL(/\/app\/suite\?doc=/); return page.url().split('=')[1]; };
    const docId = await create('doc', 'Persist doc'); await page.fill('#doc-text', 'First draft about giraffes'); await page.locator('#save-doc').click(); await expect(page.locator('#doc-version')).toHaveText('version 2'); await page.fill('#doc-text', 'Second draft about pelicans'); await page.locator('#save-doc').click(); await expect(page.locator('#doc-version')).toHaveText('version 3');
    const sheetId = await create('sheet', 'Persist sheet'); await page.locator('#add-row').click(); await page.locator('[data-cell="0:0"]').fill('Giraffes'); await page.locator('[data-cell="0:1"]').fill('12'); await page.locator('#save-doc').click(); await expect(page.locator('#doc-version')).toHaveText('version 2');
    const slidesId = await create('slides', 'Persist slides'); await page.locator('[data-slide="0"] [data-f=title]').fill('Why now'); await page.locator('[data-slide="0"] [data-f=bullets]').fill('Market\nTiming'); await page.locator('#save-doc').click(); await expect(page.locator('#doc-version')).toHaveText('version 2');
    // sharing: a colleague in the workspace gets the doc read-only; the sheet stays private
    const ctx2 = await browser.newContext({ baseURL: BASE }); const p2 = await ctx2.newPage(); const reader = await signUp(ctx2, 'persistreader'); await addMember(ctx, owner.csrf, owner.workspaceId, reader.user.id);
    await page.goto('/app/suite?doc=' + docId); await page.locator('#share-form [data-user]').first().selectOption('viewer'); await page.getByRole('button', { name: 'Save sharing' }).click(); await expect(page.locator('#notice')).toContainText('Sharing updated');
    const readDoc = async (c, id, wsId) => { const r = await c.request.get('/api/v1/documents/' + id, { headers: { 'x-workspace-id': wsId, origin: BASE } }); return { status: r.status(), body: await r.json().catch(() => ({})) }; };
    const before = { doc: await readDoc(ctx, docId, owner.workspaceId), sheet: await readDoc(ctx, sheetId, owner.workspaceId), slides: await readDoc(ctx, slidesId, owner.workspaceId), readerDoc: await readDoc(ctx2, docId, owner.workspaceId), readerSheet: await readDoc(ctx2, sheetId, owner.workspaceId) };
    expect(before.doc.status).toBe(200); expect(before.readerDoc.status).toBe(200); expect(before.readerDoc.body.my_role || before.readerDoc.body.role).toMatch(/viewer/); expect(before.readerSheet.status).not.toBe(200);
    // Meet: a native meeting, and a scheduled one registered by the sync worker
    const hostM = await open(browser, 'Persist Host'); const guestM = await open(browser, 'Persist Guest', hostM.code);
    const meetingId = hostM.session.meetingId; const sched = await (await ctx.request.post('/api/workplace/schedule', { data: { title: SCHED_TITLE, date: new Date().toISOString().slice(0, 10), time: '23:40', duration: 30 }, headers: { origin: BASE } })).json();
    for (let i = 0; i < 20 && meetDb(`select count(*) from meetings where title='${SCHED_TITLE}'`) === '0'; i += 1) await sleepMs(2000);
    // a consented recording with known bytes
    await request(hostM); await agree(guestM); await expect(async () => { expect((await call(hostM, '/recording')).body.status).toBe('ready'); }).toPass();
    const st = await call(hostM, '/recording/start', 'POST'); expect(st.status).toBe(200); const rid = st.body.recordingId;
    const c0 = webm('persist-one'), c1 = fileBytes('persist-two'); expect((await upload(hostM, rid, 0, c0)).status).toBe(201); expect((await upload(hostM, rid, 1, c1)).status).toBe(201); expect((await complete(hostM, rid, 2)).body.status).toBe('available');
    const expectedBytes = Buffer.from([...c0, ...c1]); const dl0 = await download(hostM, rid); expect(dl0.status).toBe(200); expect(Buffer.compare(dl0.bytes, expectedBytes)).toBe(0);
    const counts = () => ({ docs: dbq(`select count(*) from portal.documents where workspace_id='${owner.workspaceId}'`), versions: dbq(`select count(*) from portal.document_versions v join portal.documents d on d.id=v.document_id where d.workspace_id='${owner.workspaceId}'`), meetings: meetDb('select count(*) from meetings'), recordings: meetDb('select count(*) from recordings'), chunks: meetDb('select count(*) from recording_chunks'), audit: meetDb('select count(*) from recording_audit') });
    const c = { before: counts() }; evidence.beforeRestart = c.before; const diskBefore = fs.readdirSync(objectDir(rid)).sort();
    // ---------------------------------------------------------------- the checks, run after every restart
    const verify = async (label) => {
      const out = { label };
      const me = await ctx.request.get('/api/auth/me'); out.ownerSession = me.status(); expect(me.status(), label + ': the owner is still signed in (sessions survive a restart)').toBe(200);
      const d = await readDoc(ctx, docId, owner.workspaceId); out.docVersion = d.body.current_version; expect(d.status).toBe(200); expect(d.body.current_version).toBe(before.doc.body.current_version); expect(JSON.stringify(d.body)).toContain('pelicans');
      const s = await readDoc(ctx, sheetId, owner.workspaceId); expect(JSON.stringify(s.body)).toContain('Giraffes'); expect(JSON.stringify(s.body)).toContain('12');
      const sl = await readDoc(ctx, slidesId, owner.workspaceId); expect(JSON.stringify(sl.body)).toContain('Why now'); expect(JSON.stringify(sl.body)).toContain('Timing');
      const rd = await readDoc(ctx2, docId, owner.workspaceId); out.readerRole = rd.body.my_role || rd.body.role; expect(rd.status).toBe(200); expect(out.readerRole).toMatch(/viewer/); const rs = await readDoc(ctx2, sheetId, owner.workspaceId); expect(rs.status).not.toBe(200);
      const vs = await ctx.request.get('/api/v1/documents/' + docId + '/versions', { headers: { 'x-workspace-id': owner.workspaceId, origin: BASE } }); expect(vs.status()).toBe(200); out.versions = (await vs.json()).length === undefined ? JSON.stringify(await vs.json()).length : (await (await ctx.request.get('/api/v1/documents/' + docId + '/versions', { headers: { 'x-workspace-id': owner.workspaceId, origin: BASE } })).json()).length;
      expect(meetDb(`select count(*) from meetings where id='${meetingId}'`)).toBe('1'); expect(meetDb(`select count(*) from meetings where title='${SCHED_TITLE}'`)).toBe('1'); out.meetMeetings = meetDb('select count(*) from meetings');
      expect(meetDb(`select status from recordings where id='${rid}'`)).toBe('available'); expect(fs.readdirSync(objectDir(rid)).sort()).toEqual(diskBefore);
      const dl = await download(hostM, rid); out.recordingDownload = dl.status; expect(dl.status, label + ': the host can still download the recording').toBe(200); expect(Buffer.compare(dl.bytes, expectedBytes), label + ': the downloaded bytes are identical').toBe(0);
      expect((await call(guestM, '/api/v1/recordings/' + rid + '/access')).status, label + ': a guest still cannot get a link').toBe(403);
      const now = counts(); out.counts = now; for (const k of ['docs', 'versions', 'meetings', 'recordings', 'chunks']) expect(now[k], label + ': ' + k + ' unchanged').toBe(c.before[k]); expect(Number(now.audit)).toBeGreaterThanOrEqual(Number(c.before.audit));
      const bad = await ctx.request.get('/api/v1/documents', { headers: { 'x-workspace-id': owner.workspaceId, origin: BASE, cookie: 'qorlla_portal_session=garbage' } }); out.tamperedCookieStatus = bad.status();
      evidence.restarts.push(out); return out;
    };
    // ---------------------------------------------------------------- stage A: the applications, one at a time, in a controlled order
    for (const n of [PROJECT + '-meet-sync-worker-1', PROJECT + '_proxy', PROJECT + '-qorlla-portal-1', PROJECT + '-meet-1', PROJECT + '_main']) { dc('restart', n); await waitHealthy([n, ...DBS]); }
    await waitHealthy([...APPS, ...DBS]); await sleepMs(5000); await verify('after application restart');
    // ---------------------------------------------------------------- stage B: the databases (their volumes), WITHOUT restarting the applications: they must reconnect on their own
    const restartsOf = () => Object.fromEntries(APPS.map((n) => [n, Number(dc('inspect', '--format', '{{.RestartCount}}', n))])); const rcBefore = restartsOf();
    for (const n of DBS) { dc('restart', n); await waitHealthy([n]); }
    await waitHealthy([...APPS, ...DBS]); await sleepMs(8000);
    evidence.restartCounts = { before: rcBefore, after: restartsOf() }; expect(evidence.restartCounts.after, 'no application crashed and was rescued by Docker when its database restarted').toEqual(rcBefore);
    evidence.appsHealthyAfterDbRestart = Object.fromEntries(APPS.map((n) => [n, healthy(n)]));
    for (let i = 0; i < 20; i += 1) { const h = await fetch(BASE + '/api/health').then((r) => r.status).catch(() => 0); const p = await fetch(BASE + '/api/v1/health').then((r) => r.status).catch(() => 0); if (h === 200 && p === 200) break; await sleepMs(3000); }
    await verify('after database restart');
    // the data lives in named volumes of this project only
    evidence.volumes = dc('volume', 'ls', '--filter', 'name=' + PROJECT + '_', '--format', '{{.Name}}').split('\n').sort();
    fs.writeFileSync(path.join(__dirname, '..', '..', '.dev-stack-iso', 'persistence-evidence.json'), JSON.stringify(evidence, null, 2)); console.log('# evidence ' + JSON.stringify(evidence));
    await closeAll(hostM, guestM); await ctx.close(); await ctx2.close();
  });
});
