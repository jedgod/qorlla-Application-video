const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { BASE } = require('./helpers');

// Qorlla Meet v4.0.3 acceptance tests R01-R18: consent, authorized capture, encrypted private storage, access control, retention, deletion, legal hold, crash recovery,
// concurrency and audit integrity. They run against a REAL Meet server, REAL PostgreSQL and the REAL private object store (filesystem backend), with real browsers.
//
// Needs a Meet started with short clocks (1 retention "day" = 4 s etc.): see scripts/start-recording-test-meet.cjs. Local: E2E_BASE=http://localhost:3310 E2E_MEET_PATH=/
//   E2E_RECORDING_DIR  the Meet server's RECORDING_STORE_DIR (to inspect what is really on disk)        E2E_ADMIN_SECRET  its RECORDING_ADMIN_SECRET
// Honest scope: the browser that records is the host's; chunk uploads in most tests below are sent by the test itself so the exact bytes are known.
// NOT covered: S3-compatible storage, a hardware/cloud KMS, server-side (SFU) capture, malware scanning, legal review.
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
  return p.page.evaluate(async ({ url, method, body, t, h }) => { const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...h }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch {} return { status: r.status, body: json, text }; },
    { url, method, body, t: p.session.token, h: extraHeaders });
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

test.describe('v4.0.3 recording compliance and secure storage (R01-R18)', () => {
  test('R01-R03: notice with enforced retention, refusal leaves nothing behind, no media accepted before authorization', async ({ browser }) => {
    test.setTimeout(120000);
    const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code); await request(a, { days: '90' });
    const dlg = b.page.locator('#rcModal'); await expect(dlg).toContainText('90 days, then deleted automatically'); await expect(dlg).toContainText('privacy@example.com'); await expect(dlg).toContainText('AI transcription');            // R01
    await expect(async () => { expect((await call(a, '/recording')).body.retentionDays).toBe(90); }).toPass();                                                                     // the disclosed number is the enforced number
    expect((await call(a, '/recordings')).body.recordings).toEqual([]);                                                                                                             // R03: no recording exists before authorization
    expect((await call(a, '/recording/start', 'POST')).status).toBe(409); expect((await upload(a, '00000000-0000-4000-8000-000000000000', 0, webm('x'))).status).toBe(404);
    await b.page.getByRole('button', { name: 'Decline' }).click(); await b.page.getByRole('button', { name: 'Stay in meeting' }).click();                                           // R02
    expect((await call(a, '/recording/start', 'POST')).status).toBe(409); expect((await call(a, '/recordings')).body.recordings).toEqual([]); expect(await a.page.evaluate(() => window.__qorlla.rec().rid)).toBeNull();
    await closeAll(a, b);
  });

  test('R04: a late joiner is neither recorded nor accepted into the recording until they consent', async ({ browser }) => {
    test.setTimeout(120000);
    const { a, b, rid } = await started(browser);
    expect((await upload(a, rid, 0, webm('before-late-joiner'))).status).toBe(201);
    const c = await open(browser, 'Carol', a.code, { holdUploads: true });                                                       // joins mid-recording
    await expect(c.page.locator('#rcModal')).toContainText('Recording consent'); await expect(async () => { expect((await call(a, '/recording')).body.status).toBe('paused'); }).toPass();
    const refused = await upload(a, rid, 1, webm('while-paused')); expect(refused.status).toBe(409); expect(refused.body.state).toBe('paused');                              // the server will not take media while someone is unanswered
    const carolId = c.session.participantId; expect((await call(a, '/recording')).body.consenting).not.toContain(carolId);
    await agree(c); await expect(async () => { expect((await call(a, '/recording')).body.status).toBe('recording'); }).toPass();
    expect((await call(a, '/recording')).body.consenting).toContain(carolId); expect((await upload(a, rid, 1, webm('after-consent'))).status).toBe(201);
    const audit = JSON.stringify((await call(a, '/recordings-audit')).body.events); expect(audit).toContain('recording.chunk_refused'); expect(audit).toContain('recording.paused');
    await closeAll(a, b, c);
  });

  test('R04b: the recorder leaves out anyone who has not consented (picture and sound), whatever the server timing', async ({ browser }) => {
    test.setTimeout(150000);
    const a = await open(browser, 'Alice', undefined, { holdUploads: true }); const b = await open(browser, 'Bob', a.code); await request(a); await agree(b);
    await expect(async () => { expect((await call(a, '/recording')).body.status).toBe('ready'); }).toPass(); expect((await call(a, '/recording/start', 'POST')).status).toBe(200);
    await expect(async () => { const r = await a.page.evaluate(() => window.__qorlla.rec()); expect(r.consent.sort()).toEqual([a.session.participantId, b.session.participantId].sort()); expect(r.audio.length).toBeGreaterThan(0); }).toPass({ timeout: 20000 });
    const c = await open(browser, 'Carol', a.code); await expect(c.page.locator('#rcModal')).toBeVisible();                                                        // Carol has NOT answered
    await a.page.waitForTimeout(2500);
    const r1 = await a.page.evaluate(() => window.__qorlla.rec()); expect(r1.consent).not.toContain(c.session.participantId); expect(r1.audio).not.toContain(c.session.participantId);          // not in the audio graph
    await agree(c); await expect(async () => { expect((await a.page.evaluate(() => window.__qorlla.rec())).consent).toContain(c.session.participantId); }).toPass({ timeout: 15000 });
    await b.page.click('#rcWithdraw'); await expect(async () => { expect((await call(a, '/recording')).body.status).toBe('disabled'); }).toPass();                      // withdrawal ends it for everyone
    await closeAll(a, b, c);
  });

  test('R05: withdrawal stops acceptance at once; what was captured while everyone consented is kept, byte for byte', async ({ browser }) => {
    test.setTimeout(120000);
    const { a, b, rid } = await started(browser); const c0 = webm('consented-part-1'), c1 = fileBytes('consented-part-2');
    expect((await upload(a, rid, 0, c0)).status).toBe(201); expect((await upload(a, rid, 1, c1)).status).toBe(201);
    await b.page.click('#rcWithdraw'); await expect(async () => { expect((await call(a, '/recording')).body.status).toBe('disabled'); }).toPass();
    expect((await upload(a, rid, 2, fileBytes('after-withdrawal'))).status).toBe(409);                                                                                              // no grace window after a withdrawal
    const done = await complete(a, rid, 2); expect(done.body.status).toBe('available'); expect(done.body.partial).toBe(false); expect(done.body.endReason).toBe('consent_withdrawn');
    const f = await download(a, rid); expect(f.status).toBe(200); expect(Buffer.compare(f.bytes, Buffer.from([...c0, ...c1]))).toBe(0); expect(f.bytes.toString('latin1')).not.toContain('after-withdrawal');
    await closeAll(a, b);
  });

  test('R06: AI consent is separate from recording consent, per purpose, append-only and never implied', async ({ browser }) => {
    test.setTimeout(90000);
    const { a, b } = await started(browser);
    const s0 = (await call(b, '/consent-status')).body; expect(s0.aiProcessingEnabled).toBe(false); expect(s0.ai.transcription.mine).toBe('pending'); expect(s0.ai.transcription.agree).toBe(0);              // agreed to recording, but nothing implied for AI
    expect((await call(b, '/ai-consent', 'POST', { purpose: 'transcription', decision: 'agree' })).status).toBe(201);
    const s1 = (await call(a, '/consent-status')).body; expect(s1.ai.transcription).toMatchObject({ agree: 1, mine: 'pending' }); expect(s1.ai.summary.agree).toBe(0); expect(s1.ai.translation.agree).toBe(0); expect(s1.ai.third_party.agree).toBe(0);
    expect((await call(b, '/ai-consent', 'POST', { purpose: 'summary', decision: 'withdraw' })).status).toBe(409); expect((await call(b, '/ai-consent', 'POST', { purpose: 'mind_reading', decision: 'agree' })).status).toBe(400); expect((await call(b, '/ai-consent', 'POST', { purpose: 'summary', decision: 'maybe' })).status).toBe(400);
    expect((await call(b, '/ai-consent', 'POST', { purpose: 'transcription', decision: 'withdraw' })).status).toBe(201); expect((await call(a, '/consent-status')).body.ai.transcription.agree).toBe(0);
    expect((await call(a, '/consent-status')).body.recording.status).toBe('recording');                                                                                           // recording consent untouched
    expect(JSON.stringify((await call(a, '/recordings-audit')).body.events)).toContain('ai_consent.agree');
    await closeAll(a, b);
  });

  test('R07: media is encrypted at rest (no plaintext on disk), authenticated, and tampering is detected and audited', async ({ browser }) => {
    test.setTimeout(120000);
    const { a, b, rid } = await started(browser); const secret = 'QORLLA-PLAINTEXT-MARKER-0123456789', c0 = webm(secret);
    expect((await upload(a, rid, 0, c0)).status).toBe(201); expect((await complete(a, rid, 1)).body.status).toBe('available');
    const files = fs.readdirSync(objectDir(rid)); expect(files).toEqual(['00000000.bin']); const raw = fs.readFileSync(path.join(objectDir(rid), files[0]));
    expect(raw.length).toBe(c0.length + 28); expect(raw.includes(Buffer.from(secret))).toBe(false); expect(raw.subarray(0, 4).toString('hex')).not.toBe(HDR);                          // ciphertext: nonce + data + auth tag
    const ok = await download(a, rid); expect(ok.status).toBe(200); expect(ok.bytes.includes(Buffer.from(secret))).toBe(true);
    const bad = Buffer.from(raw); bad[20] ^= 0xff; fs.writeFileSync(path.join(objectDir(rid), files[0]), bad);                                                                       // flip one bit of the stored object
    const t = await download(a, rid); expect(t.status).not.toBe(200); expect(!!t.bytes && t.bytes.includes(Buffer.from(secret))).toBe(false);   // altered media is never delivered (Chrome retries the reset GET once; the single-use link is already spent)
    expect(JSON.stringify((await call(a, '/recordings-audit')).body.events)).toContain('recording.integrity_failure');
    await closeAll(a, b);
  });

  test('R08-R09: only the host gets short-lived single-use links; guests, other meetings, bad and expired links are refused; every access is audited', async ({ browser }) => {
    test.setTimeout(150000);
    const { a, b, rid } = await started(browser); expect((await upload(a, rid, 0, webm('r08'))).status).toBe(201); expect((await complete(a, rid, 1)).body.status).toBe('available');
    expect((await call(b, '/recordings')).status).toBe(403); expect((await call(b, '/api/v1/recordings/' + rid + '/access')).status).toBe(403); expect((await call(b, '/api/v1/recordings/' + rid, 'DELETE')).status).toBe(403);
    const other = await open(browser, 'Mallory'); expect((await call(other, '/api/v1/recordings/' + rid + '/access')).status).toBe(403); expect((await call(other, '/api/v1/recordings/' + rid, 'DELETE')).status).toBe(403);   // another meeting's host
    expect((await a.page.evaluate(async (u) => (await fetch(u)).status, RAPI + rid + '/access'))).toBe(401);                                                                         // no credentials
    const acc = (await call(a, '/api/v1/recordings/' + rid + '/access')).body; expect(acc.singleUse).toBe(true); expect(acc.expiresInSeconds).toBeLessThanOrEqual(300);
    const get = (u) => a.page.evaluate(async (x) => (await fetch(x)).status, u);
    expect(await get(acc.url.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).toBe(403);                                                                                             // forged signature
    expect(await get(acc.url)).toBe(200); expect(await get(acc.url)).toBe(403);                                                                                                      // single use
    const late = (await call(a, '/api/v1/recordings/' + rid + '/access')).body; await a.page.waitForTimeout(6500); expect(await get(late.url)).toBe(403);                              // expired (5 s in this test server)
    const events = (await call(a, '/recordings-audit')).body.events; const acts = events.map((e) => e.action);
    expect(acts).toEqual(expect.arrayContaining(['recording.access_granted', 'recording.downloaded', 'recording.access_denied']));
    const dl = events.find((e) => e.action === 'recording.downloaded'); expect(dl.actor).toBe(a.session.participantId); expect(dl.detail.bytes).toBeGreaterThan(0);
    await closeAll(a, b, other);
  });

  test('R10: retention expires on schedule - media erased, key shredded, link gone, audited', async ({ browser }) => {
    test.setTimeout(120000);
    const { a, b, rid } = await started(browser, { days: '7' });                                                                             // 7 "days" = 28 s on the test server clock
    expect((await upload(a, rid, 0, webm('retention'))).status).toBe(201); const done = (await complete(a, rid, 1)).body; expect(done.status).toBe('available'); expect(done.retentionDays).toBe(7);
    expect(new Date(done.retentionUntil).getTime() - Date.now()).toBeLessThan(60000); expect(fs.existsSync(objectDir(rid))).toBe(true);
    await expect.poll(() => statusOf(a, rid), { timeout: 60000, intervals: [2000] }).toBe('deleted');
    expect(fs.existsSync(objectDir(rid))).toBe(false); expect((await call(a, '/api/v1/recordings/' + rid + '/access')).status).toBe(410);
    const ev = (await call(a, '/recordings-audit')).body.events.find((e) => e.action === 'recording.deleted'); expect(ev.detail.reason).toBe('retention_expired'); expect(ev.actor_role).toBe('system');
    await closeAll(a, b);
  });

  test('R11: the host can delete: storage is cleaned, the key is gone, others cannot, a running recording cannot be deleted', async ({ browser }) => {
    test.setTimeout(120000);
    const { a, b, rid } = await started(browser); expect((await upload(a, rid, 0, webm('delete-me'))).status).toBe(201);
    expect((await call(a, '/api/v1/recordings/' + rid, 'DELETE')).status).toBe(409);                                                                // still recording
    expect((await complete(a, rid, 1)).body.status).toBe('available'); expect((await call(b, '/api/v1/recordings/' + rid, 'DELETE')).status).toBe(403); expect(fs.existsSync(objectDir(rid))).toBe(true);
    expect((await call(a, '/api/v1/recordings/' + rid, 'DELETE')).status).toBe(200); expect(fs.existsSync(objectDir(rid))).toBe(false);
    expect(await statusOf(a, rid)).toBe('deleted'); expect((await call(a, '/api/v1/recordings/' + rid, 'DELETE')).status).toBe(410); expect((await call(a, '/api/v1/recordings/' + rid + '/access')).status).toBe(410);
    const ev = (await call(a, '/recordings-audit')).body.events.find((e) => e.action === 'recording.deleted'); expect(ev.detail.reason).toBe('host_deleted'); expect(ev.actor).toBe(a.session.participantId);
    await closeAll(a, b);
  });

  test('R12: legal hold blocks deletion and retention expiry until released (admin-only)', async ({ browser }) => {
    test.setTimeout(150000);
    const { a, b, rid } = await started(browser, { days: '7' }); expect((await upload(a, rid, 0, webm('hold'))).status).toBe(201); expect((await complete(a, rid, 1)).body.status).toBe('available');
    const hold = (secret, on) => call(a, '/api/admin/recordings/' + rid + '/hold', 'POST', { hold: on, reason: 'litigation 2026-10' }, secret === null ? {} : { 'x-qorlla-admin': secret });
    expect((await hold(null, true)).status).toBe(403); expect((await hold('wrong', true)).status).toBe(403); expect((await call(a, '/api/admin/recordings/' + rid + '/hold', 'POST', { hold: true })).status).toBe(403);   // a host cannot place or lift it
    expect((await hold(ADMIN, true)).body.legalHold).toBe(true);
    expect((await call(a, '/api/v1/recordings/' + rid, 'DELETE')).status).toBe(409); await a.page.waitForTimeout(34000);                          // past the 28 s retention: still there
    expect(await statusOf(a, rid)).toBe('available'); expect(fs.existsSync(objectDir(rid))).toBe(true); expect((await list(a))[0].legalHold).toBe(true);
    expect((await hold(ADMIN, false)).body.legalHold).toBe(false); await expect.poll(() => statusOf(a, rid), { timeout: 30000, intervals: [2000] }).toBe('deleted');   // released: normal expiry resumes
    const acts = (await call(a, '/recordings-audit')).body.events.map((e) => e.action); expect(acts).toEqual(expect.arrayContaining(['recording.legal_hold_set', 'recording.delete_refused', 'recording.legal_hold_released']));
    await closeAll(a, b);
  });

  test('R13: a recorder that disappears mid-recording is recovered: what was received is finalized, flagged partial, and still decrypts', async ({ browser }) => {
    test.setTimeout(120000);
    const { a, b, rid } = await started(browser); const c0 = webm('before-crash'), c1 = fileBytes('second-chunk');
    expect((await upload(a, rid, 0, c0)).status).toBe(201); expect((await upload(a, rid, 1, c1)).status).toBe(201);
    const hostSession = a.session; await a.ctx.close();                                                                                       // the recorder's browser is gone - no stop, no complete
    const probe = { page: b.page, session: hostSession };                                                                                       // use any page for the host's stored token
    await expect.poll(() => statusOf(probe, rid), { timeout: 60000, intervals: [2000] }).toBe('available');
    const rec = (await list(probe)).find((r) => r.id === rid); expect(rec.partial).toBe(true); expect(rec.endReason).toBe('recorder_lost'); expect(rec.chunks).toBe(2);
    const f = await download(probe, rid); expect(Buffer.compare(f.bytes, Buffer.from([...c0, ...c1]))).toBe(0);
    await closeAll(b);
  });

  test('R14: the real recorder survives an upload outage: queued chunks are retried in order, nothing is lost or duplicated', async ({ browser }) => {
    test.setTimeout(180000);
    const a = await open(browser, 'Alice', undefined, { holdUploads: false }); const b = await open(browser, 'Bob', a.code); await request(a); await agree(b);
    await expect(async () => { expect((await call(a, '/recording')).body.status).toBe('ready'); }).toPass(); expect((await call(a, '/recording/start', 'POST')).status).toBe(200);
    await expect(async () => { expect((await a.page.evaluate(() => window.__qorlla.rec())).accepted).toBeGreaterThanOrEqual(2); }).toPass({ timeout: 30000 });
    let blocked = 0; await a.page.route('**/recordings/*/chunks*', (r) => { blocked++; r.abort(); });                                                   // network down for uploads
    await a.page.waitForTimeout(4000); const mid = await a.page.evaluate(() => window.__qorlla.rec()); expect(mid.queue).toBeGreaterThan(1); expect(blocked).toBeGreaterThan(0);
    await a.page.unroute('**/recordings/*/chunks*'); await expect(async () => { expect((await a.page.evaluate(() => window.__qorlla.rec())).queue).toBe(0); }).toPass({ timeout: 60000 });
    const sent = (await a.page.evaluate(() => window.__qorlla.rec())).accepted;
    await a.page.click('#recordBtn'); await a.page.locator('#rcModal').getByRole('button', { name: 'Stop recording' }).click();
    await expect.poll(async () => (await list(a))[0]?.status, { timeout: 60000 }).toBe('available'); const rec = (await list(a))[0];
    expect(rec.partial).toBe(false); expect(rec.chunks).toBeGreaterThanOrEqual(sent); const f = await download(a, rec.id); expect(f.status).toBe(200); expect(f.bytes.subarray(0, 4).toString('hex')).toBe(HDR); expect(f.bytes.length).toBe(rec.bytes);
    await closeAll(a, b);
  });

  test('R15: finalization that never completes is finished by the server (no stuck recordings)', async ({ browser }) => {
    test.setTimeout(120000);
    const { a, b, rid } = await started(browser); expect((await upload(a, rid, 0, webm('stuck'))).status).toBe(201); expect((await upload(a, rid, 1, fileBytes('tail'))).status).toBe(201);
    expect((await call(a, '/recording/stop', 'POST')).status).toBe(200);                                                                      // host stops; no one ever calls /complete
    const mid = (await list(a))[0]; expect(['finalizing', 'available']).toContain(mid.status);
    await expect.poll(async () => (await list(a))[0].status, { timeout: 40000, intervals: [2000] }).toBe('available'); const rec = (await list(a))[0]; expect(rec.chunks).toBe(2); expect(rec.endReason).toBe('host_stopped');
    expect(Buffer.compare((await download(a, rid)).bytes, Buffer.from([...webm('stuck'), ...fileBytes('tail')]))).toBe(0);
    await closeAll(a, b);
  });

  test('R16: concurrent requests - exactly one recording request and one start win', async ({ browser }) => {
    test.setTimeout(120000);
    const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code); const body = { purpose: 'p', recipients: 'r', retentionDays: 30, privacyContact: 'p@example.com' };
    const rs = await Promise.all(Array.from({ length: 6 }, () => call(a, '/recording/request', 'POST', body))); expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    await agree(b); await expect(async () => { expect((await call(a, '/recording')).body.status).toBe('ready'); }).toPass();
    const ss = await Promise.all([call(a, '/recording/start', 'POST'), call(a, '/recording/start', 'POST'), call(a, '/recording/start', 'POST')]); expect(ss.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect((await list(a)).length).toBe(1);
    // chunk uploads racing on one sequence number store it once
    const rid = ss.find((r) => r.status === 200).body.recordingId; const ups = await Promise.all([0, 1, 2, 3].map(() => upload(a, rid, 0, webm('same')))); expect(ups.every((u) => [200, 201].includes(u.status))).toBe(true);
    expect(fs.readdirSync(objectDir(rid))).toEqual(['00000000.bin']);
    await closeAll(a, b);
  });

  test('R17: unauthorized upload and malformed input are refused', async ({ browser }) => {
    test.setTimeout(120000);
    const { a, b, rid } = await started(browser); const other = await open(browser, 'Mallory');
    expect((await upload(b, rid, 0, webm('x'))).status).toBe(403);                                                                         // a participant who is not the recorder
    expect((await other.page.evaluate(async ({ u, t }) => (await fetch(u, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'x-test-manual': '1' }, body: new Uint8Array([1]) })).status, { u: API + a.session.meetingId + '/recordings/' + rid + '/chunks?seq=0', t: other.session.token }))).toBe(403);                                                                     // someone from another meeting
    expect((await a.page.evaluate(async (u) => (await fetch(u, { method: 'POST', headers: { 'x-test-manual': '1' }, body: new Uint8Array([1, 2, 3]) })).status, API + a.session.meetingId + '/recordings/' + rid + '/chunks?seq=0'))).toBe(401);
    for (const q of ['-1', 'abc', '1.5']) expect((await a.page.evaluate(async ({ u, t }) => (await fetch(u, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'x-test-manual': '1' }, body: new Uint8Array([1]) })).status, { u: API + a.session.meetingId + '/recordings/' + rid + '/chunks?seq=' + q, t: a.session.token }))).toBe(400);
    expect((await upload(a, rid, 0, [])).status).toBe(400); const big = await a.page.evaluate(async ({ u, t }) => { try { return (await fetch(u, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'x-test-manual': '1' }, body: new Uint8Array(9 * 1024 * 1024) })).status; } catch { return 413; } }, { u: API + a.session.meetingId + '/recordings/' + rid + '/chunks?seq=0', t: a.session.token }); expect(big).toBe(413);
    expect((await upload(a, rid, 0, webm('first'))).status).toBe(201); expect((await upload(a, rid, 0, webm('different-content'))).status).toBe(409);       // same slot, different bytes
    expect((await call(b, '/recordings/' + rid + '/status')).status).toBe(403); expect((await complete(b, rid, 1)).status).toBe(403);
    await closeAll(a, b, other);
  });

  test('R18: the audit trail is complete, ordered and hash-chained; guests cannot read it', async ({ browser }) => {
    test.setTimeout(120000);
    const { a, b, rid } = await started(browser); await upload(a, rid, 0, webm('audit')); await complete(a, rid, 1); await download(a, rid);
    expect((await call(b, '/recordings-audit')).status).toBe(403);
    const { events, chain } = (await call(a, '/recordings-audit')).body; expect(chain.ok).toBe(true); expect(chain.checked).toBeGreaterThanOrEqual(8);
    const acts = events.map((e) => e.action).reverse(); const idx = (x) => acts.indexOf(x);
    for (const x of ['recording.requested', 'consent.agree', 'recording.ready', 'recording.started', 'recording.media_created', 'recording.available', 'recording.access_granted', 'recording.downloaded']) expect(idx(x), x).toBeGreaterThanOrEqual(0);
    expect(idx('recording.requested')).toBeLessThan(idx('recording.started')); expect(idx('recording.started')).toBeLessThan(idx('recording.available')); expect(idx('recording.access_granted')).toBeLessThan(idx('recording.downloaded'));
    expect(JSON.stringify(events)).not.toContain('QORLLA-SECRET');                                                                           // no media or secrets in audit detail
    await closeAll(a, b);
  });
});
