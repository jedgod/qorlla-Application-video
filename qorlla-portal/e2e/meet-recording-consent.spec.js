const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const { BASE } = require('./helpers');

// Qorlla Meet recording consent: nothing is captured until every person present has agreed; decline blocks; withdrawal stops; a late joiner pauses it;
// every new request needs fresh consent; only the host can request/start/stop; every step is audited.
// Through the unified HTTPS origin: /meet/. For a local Meet use E2E_BASE=http://localhost:3310 E2E_MEET_PATH=/.
const MEET = process.env.E2E_MEET_PATH || '/meet/';
const API = MEET.replace(/\/?$/, '/') + 'api/v1/meetings/';

async function open(browser, who, code) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE, permissions: ['camera', 'microphone'], viewport: { width: 1366, height: 768 }, acceptDownloads: true }); const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(MEET); await page.fill('#displayName', who);
  if (code) { await page.fill('#meetingId', code); await page.click('#joinBtn'); } else { await page.fill('#meetingTitle', 'Consent check'); await page.click('#createBtn'); }
  await page.waitForSelector('#app:not(.hidden)'); await expect(page.locator('#status')).toContainText('Connected');
  const out = { ctx, page }; if (!code) out.code = (await page.locator('#roomId').textContent()).trim(); return out;
}
const token = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('qorlla-session')));
async function call(page, path, method = 'GET', body) {
  const s = await token(page);
  return page.evaluate(async ({ url, method, body, t }) => { const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; },
    { url: API + s.meetingId + '/recording' + path, method, body, t: s.token });
}
async function request(host, extra = {}) {
  await host.page.click('#recordBtn');
  await host.page.fill('#rc_purpose', extra.purpose || 'Minutes for absent colleagues'); await host.page.fill('#rc_recipients', 'Attendees and project team'); await host.page.fill('#rc_retention', '30 days then deleted');
  await host.page.fill('#rc_privacyContact', 'privacy@example.com'); await host.page.fill('#rc_privacyUrl', 'https://example.com/privacy');
  await host.page.getByRole('button', { name: 'Send request' }).click(); await expect(host.page.locator('#rcModal')).toHaveCount(0);
}
async function agree(p) {
  const dlg = p.page.locator('#rcModal'); await expect(dlg).toContainText('Recording consent'); const ok = dlg.getByRole('button', { name: 'Agree' }); await expect(ok).toBeDisabled();
  await dlg.locator('#rcVideo').check(); await expect(ok).toBeDisabled(); await dlg.locator('#rcAudio').check(); await expect(ok).toBeDisabled(); await dlg.locator('#rcReviewed').check(); await expect(ok).toBeEnabled(); await ok.click(); await expect(p.page.locator('#rcModal')).toHaveCount(0);
}

test.describe('Qorlla Meet recording consent', () => {
  test('request -> notice -> everyone agrees -> start; a late joiner pauses it until they answer; stop saves a real file; the next request needs fresh consent', async ({ browser }) => {
    test.setTimeout(150000);
    const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code);
    await expect(a.page.locator('#recordBtn')).toHaveText('Record'); await expect(b.page.locator('#recordBtn')).toBeHidden();                       // only the host has the control
    await request(a);
    // Bob sees the full notice and cannot proceed without ticking the boxes; nothing is being recorded
    const dlg = b.page.locator('#rcModal'); await expect(dlg).toContainText('Minutes for absent colleagues'); await expect(dlg).toContainText('Attendees and project team'); await expect(dlg).toContainText('30 days then deleted'); await expect(dlg).toContainText('privacy@example.com');
    await expect(dlg.getByRole('link', { name: 'View Privacy Policy' })).toHaveAttribute('href', 'https://example.com/privacy'); await expect(dlg.locator('#rcVideo')).not.toBeChecked(); await expect(dlg.locator('#rcAudio')).not.toBeChecked(); await expect(dlg).toContainText('AI transcription');
    await expect(b.page.locator('#recBanner')).toContainText('NOTHING is being recorded'); await expect(a.page.locator('#recBanner')).toContainText('waiting for 1 answer');
    // the host cannot start while an answer is missing (the server refuses, not just the button)
    const early = await call(a.page, '/start', 'POST'); expect(early.status).toBe(409);
    await a.page.click('#recordBtn'); await expect(a.page.locator('#rcModal')).toContainText('Bob'); await expect(a.page.locator('#rcModal')).toContainText('Waiting'); await expect(a.page.getByRole('button', { name: 'Start recording' })).toHaveCount(0);
    await agree(b);
    await expect(a.page.locator('#rcModal')).toContainText('Agreed'); await expect(a.page.getByRole('button', { name: 'Start recording' })).toBeEnabled();
    await a.page.getByRole('button', { name: 'Start recording' }).click();
    await expect(a.page.locator('#recordBtn')).toHaveText(/Stop \d\d:\d\d/); await expect(b.page.locator('#recBanner')).toContainText('Alice is recording this meeting (video and audio)'); await expect(b.page.locator('.tile .rec-badge')).toHaveCount(1);
    // a late joiner: capture pauses and the banner says so until they answer
    const c = await open(browser, 'Carol', a.code); await expect(c.page.locator('#rcModal')).toContainText('Recording consent'); await expect(a.page.locator('#recBanner')).toContainText('PAUSED'); await expect(b.page.locator('#recBanner')).toContainText('PAUSED');
    await agree(c); await expect(a.page.locator('#recBanner')).toContainText('You are recording this meeting');
    await a.page.waitForTimeout(3000);
    const [dl] = await Promise.all([a.page.waitForEvent('download'), (async () => { await a.page.click('#recordBtn'); await a.page.locator('#rcModal').getByRole('button', { name: 'Stop recording' }).click(); })()]);
    expect(dl.suggestedFilename()).toMatch(/^qorlla-\d+-\d{8}-\d{4}\.webm$/); const buf = fs.readFileSync(await dl.path()); expect(buf.length).toBeGreaterThan(15000); expect(buf.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
    await expect(b.page.locator('#recBanner')).toBeHidden(); await expect(b.page.locator('.tile .rec-badge')).toHaveCount(0);
    // old consent does not carry over: a second request asks everyone again
    await request(a, { purpose: 'Second recording' }); await expect(b.page.locator('#rcModal')).toContainText('Second recording'); await expect(c.page.locator('#rcModal')).toContainText('Second recording');
    expect((await call(a.page, '/start', 'POST')).status).toBe(409);
    await a.page.click('#recordBtn'); await a.page.getByRole('button', { name: 'Cancel request' }).click(); await expect(b.page.locator('#rcModal')).toHaveCount(0); await expect(b.page.locator('#recBanner')).toBeHidden();
    for (const p of [a, b, c]) await p.ctx.close();
  });

  test('one decline blocks recording and the decliner can stay or leave; withdrawing consent mid-recording stops it and saves what was captured', async ({ browser }) => {
    test.setTimeout(150000);
    const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code); const c = await open(browser, 'Carol', a.code);
    await request(a); await agree(b);
    await c.page.getByRole('button', { name: 'Decline' }).click(); await expect(c.page.locator('#rcModal')).toContainText('You declined recording'); await expect(c.page.getByRole('button', { name: 'Leave meeting' })).toBeVisible();
    await c.page.getByRole('button', { name: 'Stay in meeting' }).click(); await expect(c.page.locator('#app')).toBeVisible();
    await expect(a.page.locator('#recBanner')).toContainText('blocked'); const blocked = await call(a.page, '/start', 'POST'); expect(blocked.status).toBe(409); expect(blocked.body.status).toBe('blocked');
    await a.page.click('#recordBtn'); await expect(a.page.locator('#rcModal')).toContainText('Declined'); await expect(a.page.getByRole('button', { name: 'Start recording' })).toHaveCount(0);
    // the decliner can still change their mind? Not silently: a NEW request is needed. Cancel and ask again; this time both agree.
    await a.page.getByRole('button', { name: 'Cancel request' }).click(); await request(a, { purpose: 'Try again' }); await agree(b); await agree(c);
    await a.page.click('#recordBtn'); await a.page.getByRole('button', { name: 'Start recording' }).click(); await expect(a.page.locator('#recordBtn')).toHaveText(/Stop/);
    await a.page.waitForTimeout(2500);
    const [dl] = await Promise.all([a.page.waitForEvent('download'), b.page.click('#rcWithdraw')]);                                   // Bob withdraws: recording stops for everyone, the host keeps what was captured
    expect(fs.readFileSync(await dl.path()).length).toBeGreaterThan(8000); await expect(a.page.locator('#recordBtn')).toHaveText('Record'); await expect(c.page.locator('#recBanner')).toBeHidden();
    // audit trail: host-only, records the requests, answers, start and the withdrawal
    const audit = await call(a.page, '/audit'); expect(audit.status).toBe(200); const acts = JSON.stringify(audit.body); for (const w of ['recording.requested', 'consent.decline', 'consent.agree', 'recording.started', 'consent.withdraw']) expect(acts, w).toContain(w);
    expect((await call(b.page, '/audit')).status).toBe(403);
    for (const p of [a, b, c]) await p.ctx.close();
  });

  test('only the host can request, start or stop; nothing starts without a request; disclosure and the privacy contact are mandatory', async ({ browser }) => {
    const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code);
    const body = { purpose: 'x', recipients: 'y', retention: 'z', privacyContact: 'p@example.com' };
    expect((await call(b.page, '/request', 'POST', body)).status).toBe(403); expect((await call(b.page, '/start', 'POST')).status).toBe(403); expect((await call(b.page, '/stop', 'POST')).status).toBe(403);
    expect((await call(a.page, '/start', 'POST')).status).toBe(409);                                                                                                  // no request yet
    expect((await call(a.page, '/request', 'POST', { ...body, privacyContact: '' })).status).toBe(400); expect((await call(a.page, '/request', 'POST', { ...body, video: false, audio: false })).status).toBe(400);
    expect((await call(a.page, '/request', 'POST', { ...body, privacyUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await call(a.page, '/request', 'POST', body)).status).toBe(201); expect((await call(a.page, '/request', 'POST', body)).status).toBe(409);               // one live request at a time
    // agreeing needs the notice acknowledged and every requested scope; a participant cannot answer for someone else
    const sid = (await call(b.page, '')).body.sessionId;
    expect((await call(b.page, '/consent', 'POST', { sessionId: sid, decision: 'agree', video: true, audio: true, noticeReviewed: false })).status).toBe(400);
    expect((await call(b.page, '/consent', 'POST', { sessionId: sid, decision: 'agree', video: true, audio: false, noticeReviewed: true })).status).toBe(400);
    const list = await call(b.page, '/consents'); expect(list.body.participants).toBeUndefined();                                                                         // guests do not see others' answers
    for (const p of [a, b]) await p.ctx.close();
  });
});
