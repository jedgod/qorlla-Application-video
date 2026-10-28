const { test, expect } = require('@playwright/test');
const { startSmtpSink } = require('./support/smtp-sink');
const { invitationText } = require('../invitation');
const { startMain, organiser } = require('./support/meet-stack');

// Email invitations: the guest receives the meeting ID, join link and (when the host supplies it) the passcode.
// Proven against a local SMTP sink, which shows what the application sends; it does NOT certify delivery through a real provider.
test.use({ permissions: ['camera', 'microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test('invitation text: ID, link, passcode only when supplied, a protected notice otherwise, agenda, no secrets, consent wording', () => {
  const base = { host: 'Hostess', title: 'Design review', topic: 'Navigation', when: '2026-10-29 14:00 (Eastern), 30 min', meetingId: '920 4304 5426', link: 'https://q.example/guest/meeting/920%204304%205426/prejoin', agenda: ['Intro', 'Demo'] };
  const a = invitationText({ ...base, passcode: 'door-code-1', needsPasscode: true }); for (const s of ['Hostess invited you', 'Meeting: Design review', 'Topic: Navigation', 'When: 2026-10-29', 'Meeting ID: 920 4304 5426', 'Join link: https://q.example', 'Passcode: door-code-1', '1. Intro', '2. Demo', 'not consent to be recorded', 'do not need an account']) expect(a, s).toContain(s);
  const b = invitationText({ ...base, needsPasscode: true }); expect(b).toContain('Ask Hostess for the passcode'); expect(b).not.toContain('door-code'); const c = invitationText({ ...base }); expect(c).not.toMatch(/Passcode/i);
  expect(invitationText({ ...base, link: '', passcode: 'x' })).toContain('Choose Join in Qorlla');
});

test.describe('mail configured (local sink)', () => {
  test.describe.configure({ mode: 'serial' });                  // one shared test server per describe: never split across workers
  let sink, main; test.beforeAll(async () => { sink = await startSmtpSink(); main = await startMain(5295, { SMTP_URL: 'smtp://127.0.0.1:' + sink.port, SMTP_FROM: 'Qorlla <no-reply@test.local>', PUBLIC_URL: 'http://localhost:5295' }); });
  test.afterAll(async () => { main && main.stop(); sink && await sink.close(); });
  const open = async (page, title) => { await page.goto(main.base + '/qorlla.html#home'); await page.locator('.meeting', { hasText: title }).locator('.join-pill').click(); await expect(page.locator('#startDialog')).toBeVisible(); await expect(page.locator('#sdPassNote')).not.toHaveText('Checking…'); };

  test('Start screen: Send by email delivers ID, link, topic and the passcode the host set; the guest can join with exactly what the email says', async ({ page, context, browser }) => {
    test.setTimeout(90000);
    const { item } = await organiser(context, main.base, { title: 'Design review' });
    await context.request.patch(main.base + '/api/workplace/schedule/' + item.id, { data: { topic: 'Navigation redesign', agenda: ['Intro', 'Demo'] } });
    await open(page, 'Design review'); await expect(page.locator('#sdSendInvite')).toBeEnabled(); await expect(page.locator('#sdEmails')).toHaveAttribute('placeholder', /Invite by email/);
    await page.click('#sdPassGen'); const pw = await page.inputValue('#sdPass'); await page.fill('#sdEmails', 'guest@example.com, other@example.com'); await page.click('#sdSendInvite');
    await expect(page.locator('#sdInviteMsg')).toContainText('Sent to guest@example.com, other@example.com'); await expect(page.locator('#sdInviteMsg')).toContainText('with the passcode');
    const m = await sink.waitFor((x) => x.to.includes('guest@example.com')); expect(m.text).toContain('Subject: Stryker invited you: Design review'); expect(m.text).toContain('Topic: Navigation redesign'); expect(m.text).toContain('Meeting ID: ' + item.meetingId); expect(m.text).toContain('Passcode: ' + pw);
    expect(m.text).toContain('http://localhost:5295/guest/meeting/' + encodeURIComponent(item.meetingId) + '/prejoin'); expect(m.text).toContain('1. Intro'); expect(m.text).not.toMatch(/hostKey|token|cookie/i); await sink.waitFor((x) => x.to.includes('other@example.com'));
    // the guest uses ONLY what the email says
    const id = /Meeting ID: (\d{3} \d{4} \d{4})/.exec(m.text)[1], code = /Passcode: (\S+)/.exec(m.text)[1]; const gc = await browser.newContext();
    expect((await gc.request.post(main.base + '/api/guest/sessions', { data: { meetingId: id, displayName: 'Guest', passcode: 'wrong-code-9' } })).status()).toBe(403);
    expect((await gc.request.post(main.base + '/api/guest/sessions', { data: { meetingId: id, displayName: 'Guest', passcode: code } })).status()).toBe(201); await gc.close();
  });

  test('a later invitation without the passcode says the meeting is protected and never contains it; bad addresses and wrong input are refused clearly', async ({ page, context }) => {
    test.setTimeout(60000);
    const { item } = await organiser(context, main.base, { title: 'Second review' });
    expect((await context.request.put(main.base + '/api/meetings/' + encodeURIComponent(item.meetingId) + '/passcode', { data: { passcode: 'stored-secret' } })).status()).toBe(200);
    await open(page, 'Second review'); await page.fill('#sdEmails', 'later@example.com'); await page.click('#sdSendInvite'); await expect(page.locator('#sdInviteMsg')).toContainText('Sent to later@example.com');
    const m = await sink.waitFor((x) => x.to.includes('later@example.com')); expect(m.text).toContain('Meeting ID: ' + item.meetingId); expect(m.text).toContain('protected'); expect(m.text).not.toContain('stored-secret');
    await page.fill('#sdEmails', ''); await page.click('#sdSendInvite'); await expect(page.locator('#sdInviteMsg')).toContainText('at least one email'); await page.fill('#sdEmails', 'not-an-address'); await page.click('#sdSendInvite'); await expect(page.locator('#sdInviteMsg')).toContainText('not valid');
    await page.fill('#sdEmails', 'ok@example.com'); await page.fill('#sdPass', 'abc'); await page.click('#sdSendInvite'); await expect(page.locator('#sdInviteMsg')).toContainText('6 to 32');
    const api = (data) => context.request.post(main.base + '/api/meetings/' + encodeURIComponent(item.meetingId) + '/invite', { data });
    expect((await api({ emails: [] })).status()).toBe(400); expect((await api({ emails: ['x@example.com\r\nBcc: evil@example.com'] })).status()).toBe(400); expect((await api({ emails: ['a@example.com'], passcode: 'x' })).status()).toBe(400);
    const stranger = await page.context().browser().newContext(); expect((await stranger.request.post(main.base + '/api/meetings/' + encodeURIComponent(item.meetingId) + '/invite', { data: { emails: ['a@example.com'] } })).status()).toBe(401); await stranger.close();
  });
});

test('mail not configured: the Start screen says so, Send is disabled, and the API answers plainly', async ({ page, context }) => {
  test.setTimeout(60000);
  const main = await startMain(5296, { SMTP_URL: '', SMTP_FROM: '' });
  try {
    const { item } = await organiser(context, main.base, { title: 'No mail' }); await page.goto(main.base + '/qorlla.html#home'); await page.locator('.meeting', { hasText: 'No mail' }).locator('.join-pill').click(); await expect(page.locator('#sdPassNote')).not.toHaveText('Checking…');
    await expect(page.locator('#sdSendInvite')).toBeDisabled(); await expect(page.locator('#sdInviteMsg')).toContainText('Email is not set up');
    const r = await context.request.post(main.base + '/api/meetings/' + encodeURIComponent(item.meetingId) + '/invite', { data: { emails: ['a@example.com'] } }); expect(r.status()).toBe(503); expect((await r.json()).error).toContain('SMTP_URL');
  } finally { main.stop(); }
});
