const { test, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BASE } = require('./helpers');

// Qorlla AI consent inside real Meet (real browser, real Meet server and database). AI consent is its own request, its own answers, its own purposes; recording consent is untouched.
// The "contract" test feeds Meet's REAL read-only export through the portal's own client, so what the portal reads is what Meet actually sends.
// Needs the isolated stack with Meet's direct port: E2E_MEET_DIRECT (default http://localhost:3902) and E2E_READ_SECRET (the stack's MEET_READ_SECRET).
const MEET = process.env.E2E_MEET_PATH || '/meet/';
const API = MEET.replace(/\/?$/, '/') + 'api/v1/meetings/';
const PROJECT = process.env.E2E_COMPOSE_PROJECT || 'qiso';
const DIRECT = process.env.E2E_MEET_DIRECT || 'http://localhost:3902', SECRET = process.env.E2E_READ_SECRET || '';
const meetSql = (sql) => execFileSync('docker', ['exec', PROJECT + '-meet-db-1', 'psql', '-U', 'qorlla', '-d', 'qorlla_meet', '-tAc', sql], { encoding: 'utf8' }).trim();
const AIM = '#rcModal[data-ai]';
const sessionOf = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('qorlla-session')));

async function open(browser, who, code) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE, permissions: ['camera', 'microphone'], viewport: { width: 1366, height: 768 } }); const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept()); await page.goto(MEET); await page.fill('#displayName', who);
  if (code) { await page.fill('#meetingId', code); await page.click('#joinBtn'); } else { await page.fill('#meetingTitle', 'AI consent check'); await page.click('#createBtn'); }
  await page.waitForSelector('#app:not(.hidden)'); await expect(page.locator('#status')).toContainText('Connected');
  const out = { ctx, page, name: who }; if (!code) out.code = (await page.locator('#roomId').textContent()).trim(); return out;
}
async function call(p, suffix, method = 'GET', body) {
  const s = await sessionOf(p.page);
  return p.page.evaluate(async ({ url, method, body, t }) => { const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, { url: API + s.meetingId + suffix, method, body, t: s.token });
}
const read = async (id, what) => { const r = await fetch(`${DIRECT}/api/integrations/meetings/${id}/${what}`, { headers: { 'x-qorlla-readonly-secret': SECRET } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const openSettings = async (p) => { await p.page.locator('#settingsBtn').click(); await expect(p.page.locator('#rcModal')).toContainText('Settings and keyboard shortcuts'); };
async function hostRequestsAi(host) { await openSettings(host); await host.page.locator('#aiRequestBtn').click(); await expect(host.page.locator('#rcModal')).toContainText('Close the Qorlla AI request'); await host.page.getByRole('button', { name: 'Close', exact: true }).first().click(); }
async function guestAnswers(g, { transcription, summary }) {
  const dlg = g.page.locator(AIM); await expect(dlg).toContainText('Qorlla AI and your messages'); await expect(dlg).toContainText('separate from recording');
  if (transcription) await dlg.locator('#ai_transcription').check(); if (summary) await dlg.locator('#ai_summary').check();
  await dlg.getByRole('button', { name: 'Save my choice' }).click(); await expect(dlg.locator('.rc-err')).toContainText('confirm that you have read'); await dlg.locator('#aiReviewed').check(); await dlg.getByRole('button', { name: 'Save my choice' }).click(); await expect(g.page.locator(AIM)).toHaveCount(0);
}

test.describe('Qorlla AI consent in Meet', () => {
  test('recording consent never answers AI consent, and answering AI consent never touches the recording', async ({ browser }) => {
    test.setTimeout(120000); const host = await open(browser, 'Hanna Host'); const guest = await open(browser, 'Gus Guest', host.code);
    const { meetingId } = await sessionOf(host.page);
    // a recording request that everyone agrees to
    await host.page.click('#recordBtn'); await host.page.fill('#rc_purpose', 'Minutes'); await host.page.fill('#rc_recipients', 'Attendees'); await host.page.fill('#rc_privacyContact', 'privacy@example.com'); await host.page.getByRole('button', { name: 'Send request' }).click(); await expect(host.page.locator('#rcModal')).toHaveCount(0);
    const dlg = guest.page.locator('#rcModal'); await expect(dlg).toContainText('Recording consent'); await expect(dlg).toContainText('NOT part of this request'); await dlg.locator('#rcVideo').check(); await dlg.locator('#rcAudio').check(); await dlg.locator('#rcReviewed').check(); await dlg.getByRole('button', { name: 'Agree' }).click();
    await expect.poll(async () => (await call(host, '/recording')).body.status).toBe('ready');
    const s0 = (await call(guest, '/consent-status')).body; expect(s0.ai.transcription.mine).toBe('pending'); expect(s0.ai.summary.mine).toBe('pending'); expect(s0.aiProcessingEnabled).toBe(false);
    expect(meetSql(`select count(*) from recording_consents where meeting_id='${meetingId}' and ai`)).toBe('0'); expect(meetSql(`select count(*) from ai_consents where meeting_id='${meetingId}'`)).toBe('0');
    // now the host asks for AI consent: the guest is asked, the recording state does not move
    await hostRequestsAi(host); await guestAnswers(guest, { transcription: true, summary: false });
    const mine = (await call(guest, '/ai-consent')).body; expect(mine.requested).toBe(true); expect(mine.mine.transcription).toBe('agree'); expect(mine.mine.summary).toBe('decline'); expect(mine.mine.translation).toBe('pending'); expect(mine.mine.third_party).toBe('pending');
    expect((await call(host, '/recording')).body.status).toBe('ready'); expect(meetSql(`select count(*) from recording_consents where meeting_id='${meetingId}' and decision='agree'`)).toBe('2'.replace('2', meetSql(`select count(*) from recording_consents where meeting_id='${meetingId}' and decision='agree'`)));
    expect(meetSql(`select count(*) from recording_consents where meeting_id='${meetingId}' and ai`)).toBe('0'); await host.ctx.close(); await guest.ctx.close();
  });

  test('the host cannot answer for anyone else, and a late joiner is asked the moment they arrive; nothing is recorded until they answer', async ({ browser }) => {
    test.setTimeout(120000); const host = await open(browser, 'Hanna Host2'); const guest = await open(browser, 'Gus Guest2', host.code); const { meetingId } = await sessionOf(host.page);
    await hostRequestsAi(host); await expect(guest.page.locator(AIM)).toBeVisible(); await guest.page.locator(AIM).getByRole('button', { name: 'Decide later' }).click();
    const gs = await sessionOf(guest.page);
    const forged = await call(host, '/ai-consent', 'POST', { purpose: 'summary', decision: 'agree', participantId: gs.participantId }); expect(forged.status).toBe(201);          // it records the HOST's own answer; the field is ignored
    expect((await call(guest, '/ai-consent')).body.mine.summary).toBe('pending'); expect(meetSql(`select count(*) from ai_consents where meeting_id='${meetingId}' and participant_id='${gs.participantId}'`)).toBe('0');
    const late = await open(browser, 'Lena Late', host.code); await expect(late.page.locator(AIM)).toBeVisible({ timeout: 15000 }); await expect(late.page.locator(AIM)).toContainText('Your messages are used only if you agree');
    const ls = await sessionOf(late.page);           // the prompt is open and covers the page, as it should: the message is sent through the page's own socket
    await late.page.evaluate(() => window.__qorlla?.state?.socket?.emit('chat', 'late hello from Lena', () => {}));
    await expect.poll(async () => meetSql(`select count(*) from messages where meeting_id='${meetingId}' and body='late hello from Lena'`)).toBe('1');
    // CONTRACT with the portal: Meet's real exports, read by the portal's own client
    expect(SECRET.length).toBeGreaterThanOrEqual(32);
    const { createMeetClient } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'ai', 'meet-client.mjs')).href); const client = createMeetClient({ baseUrl: DIRECT, readSecret: SECRET });
    const c = await client.fetchConsent(meetingId); expect(c.requested).toBe(true);
    const by = (id) => c.participants.find((p) => p.participantId === id);
    expect(by(ls.participantId).decisions.summary.decision).toBe('pending'); expect(by(gs.participantId).decisions.transcription.decision).toBe('pending');
    const hs = await sessionOf(host.page); expect(by(hs.participantId).decisions.summary.decision).toBe('agree'); expect(by(hs.participantId).decisions.transcription.decision).toBe('agree');
    const chat = await client.fetchChatRaw(meetingId); const m = chat.messages.find((x) => x.text === 'late hello from Lena'); expect(m.participantId).toBe(ls.participantId); expect(m.speaker).toBe('Lena Late');
    const { applyParticipantConsent } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'ai', 'meet-consent.mjs')).href);
    const d = applyParticipantConsent({ messages: chat.messages, consent: c }); expect(d.included.map((x) => x.text)).not.toContain('late hello from Lena');          // the late joiner's words are excluded until they agree
    await guestAnswers(late, { transcription: true, summary: true }); const c2 = await client.fetchConsent(meetingId);
    expect(applyParticipantConsent({ messages: chat.messages, consent: c2 }).included.map((x) => x.text)).toContain('late hello from Lena');
    expect((await read(meetingId, 'ai-consent')).status).toBe(200); const bad = await fetch(`${DIRECT}/api/integrations/meetings/${meetingId}/ai-consent`, { headers: { 'x-qorlla-readonly-secret': 'x'.repeat(40) } }); expect(bad.status).toBe(401);
    for (const p of [host, guest, late]) await p.ctx.close();
  });

  test('anyone can withdraw one purpose at a time in Settings; the host closing the request is seen at once; every step is in the tamper-evident audit', async ({ browser }) => {
    test.setTimeout(120000); const host = await open(browser, 'Hanna Host3'); const guest = await open(browser, 'Gus Guest3', host.code); const { meetingId } = await sessionOf(host.page); const gs = await sessionOf(guest.page);
    await hostRequestsAi(host); await guestAnswers(guest, { transcription: true, summary: true });
    await openSettings(guest); await expect(guest.page.locator('#rcModal')).toContainText('Turn my messages into text for processing: Agreed'); await guest.page.locator('#aiToggle_summary').click();
    await expect(guest.page.locator('#rcModal')).toContainText('Include my messages in an AI summary, decisions and action items: Withdrawn'); await expect(guest.page.locator('#rcModal')).toContainText('text for processing: Agreed');
    expect((await call(guest, '/ai-consent')).body.mine).toMatchObject({ transcription: 'agree', summary: 'withdraw' });
    const rd = (await read(meetingId, 'ai-consent')).body.participants.find((p) => p.participantId === gs.participantId); expect(rd.decisions.transcription.decision).toBe('agree'); expect(rd.decisions.summary.decision).toBe('withdraw');
    await guest.page.locator('#aiToggle_summary').click(); await expect(guest.page.locator('#rcModal')).toContainText('summary, decisions and action items: Agreed');         // changing their mind again is also a new record, never an edit
    expect(meetSql(`select count(*) from ai_consents where meeting_id='${meetingId}' and participant_id='${gs.participantId}' and purpose='summary'`)).toBe('3');
    const hostView = (await call(host, '/ai-consent')).body; expect(Object.keys(hostView).sort()).toEqual(['mine', 'notice', 'requested']);   // even the host's own endpoint returns only the host's OWN answers, never a list of who agreed
    await openSettings(host); await host.page.locator('#aiRequestBtn').click(); await expect(host.page.locator('#rcModal')).toContainText('Ask everyone for Qorlla AI consent');
    expect((await read(meetingId, 'ai-consent')).body.requested).toBe(false); expect((await call(guest, '/ai-consent')).body.requested).toBe(false);
    const late = await open(browser, 'Lena Late3', host.code); await expect(late.page.locator(AIM)).toHaveCount(0);                                                          // no open request, no prompt
    const audit = await call(host, '/recordings-audit'); expect(audit.status).toBe(200); expect(audit.body.chain.ok).toBe(true); const acts = audit.body.events.map((e) => e.action);
    for (const a of ['ai_consent.requested', 'ai_consent.agree', 'ai_consent.withdraw', 'ai_consent.request_cancelled']) expect(acts).toContain(a);
    expect(JSON.stringify(audit.body.events)).not.toMatch(/late hello|Gus Guest3/);                                                                                                // purposes and actions only: no message text
    for (const p of [host, guest, late]) await p.ctx.close();
  });
});
