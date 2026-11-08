const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { organiser, PASSWORD } = require('./support/meet-stack');
const root = path.join(__dirname, '..');
// Main server only (no Meet needed for invitations), on its own port and temporary data folder.
async function startMain(port, extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qinbox-'));
  const child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ...extraEnv } });
  const base = 'http://localhost:' + port;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/')).ok) break; } catch (e) { /* not yet */ } await new Promise((r) => setTimeout(r, 500)); }
  return { base, dataDir, stop() { try { child.kill(); } catch (e) { /* gone */ } try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* busy */ } } };
}

// Scheduling a meeting with invitees: people who have a Qorlla account get the invitation in their Qorlla inbox (no SMTP needed);
// only the others go to the mail server. Several addresses, separated by commas, semicolons or spaces.
test('invitees with a Qorlla account receive the invitation in their inbox; others are emailed (or reported as not sent)', async ({ browser, context }) => {
  test.setTimeout(90000);
  const main = await startMain(5297, { SMTP_URL: '', SMTP_FROM: '' });          // no mail server at all
  try {
    const reg = async (username, email) => { const c = await browser.newContext(); const r = await c.request.post(main.base + '/api/auth/register', { data: { username, displayName: username, password: PASSWORD, ...(email ? { email } : {}) } }); expect(r.status()).toBe(201); return c; };
    const bob = await reg('bobinbox', 'bob.inbox@example.com'), dan = await reg('daninbox'), eve = await reg('eveinbox', 'eve.inbox@example.com');
    const usersFile = path.join(main.dataDir, 'auth', 'users.json'); const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    users.find((u) => u.username === 'bobinbox').emailVerified = true; fs.writeFileSync(usersFile, JSON.stringify(users));   // bob's email is verified; eve's is not

    const { item } = await organiser(context, main.base, { title: 'Team sync' });
    const s = await context.request.post(main.base + '/api/workplace/schedule', { data: { title: 'Multi invite', date: item.date, time: '22:00', duration: 30, invitees: 'bob.inbox@example.com, daninbox@qorlla.local; eve.inbox@example.com outside@example.com' } });
    expect(s.status()).toBe(201); const made = await s.json(); const by = (a) => (made.inviteResults || []).find((r) => r.to === a);
    expect(by('bob.inbox@example.com').status).toBe('sent'); expect(by('daninbox@qorlla.local').status).toBe('sent');
    expect(by('eve.inbox@example.com').status).toBe('not_configured'); expect(by('outside@example.com').status).toBe('not_configured');

    for (const c of [bob, dan]) { const mail = await (await c.request.get(main.base + '/api/workplace/mail')).json(); const m = (mail.items || mail).find((x) => /invited you: Multi invite/.test(x.subject)); expect(m, 'invitation in inbox').toBeTruthy(); expect(m.folder).toBe('inbox'); expect(m.read).toBe(false); expect(m.body).toContain('Meeting ID: ' + made.meetingId); }
    const eveMail = await (await eve.request.get(main.base + '/api/workplace/mail')).json(); expect((eveMail.items || eveMail).some((x) => /invited you/.test(x.subject))).toBe(false);
    for (const c of [bob, dan, eve]) await c.close();
  } finally { main.stop(); }
});

// A meeting scheduled in the host's own time zone must stay "upcoming" even when the server runs in another zone (the containers run in UTC).
test('a meeting scheduled in America/New_York stays upcoming on a UTC server', async ({ context }) => {
  test.setTimeout(60000);
  const main = await startMain(5298, { TZ: 'UTC', SMTP_URL: '', SMTP_FROM: '' });
  try {
    await organiser(context, main.base, { title: 'warm up' });
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(Date.now() + 60 * 60000)).map((p) => [p.type, p.value]));
    const r = await context.request.post(main.base + '/api/workplace/schedule', { data: { title: 'NY hour ahead', date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, duration: 30, timezone: 'America/New_York' } });
    expect(r.status()).toBe(201); const made = await r.json();
    const list = await (await context.request.get(main.base + '/api/workplace/schedule')).json();
    expect(list.some((i) => i.meetingId === made.meetingId), 'still in the upcoming list').toBe(true);
  } finally { main.stop(); }
});

// The invitation link in an inbox message is a real link (only links to this Qorlla site); the join page asks for a full name.
test('inbox: the invitation link is clickable (other sites are not links); the join page needs a first and last name', async ({ browser, page, context }) => {
  test.setTimeout(90000);
  const main = await startMain(5299, { SMTP_URL: '', SMTP_FROM: '' });
  try {
    const { item } = await organiser(context, main.base, { title: 'Joinable' });          // a real meeting, so the join page enables its button
    const link = main.base + '/guest/meeting/' + encodeURIComponent(item.meetingId) + '/prejoin';
    await page.request.post(main.base + '/api/auth/register', { data: { username: 'linkuser1', displayName: 'Link User', password: PASSWORD } });
    const sc = await browser.newContext(); await sc.request.post(main.base + '/api/auth/register', { data: { username: 'sender1x', displayName: 'Sender', password: PASSWORD } });
    const sent = await sc.request.post(main.base + '/api/workplace/mail', { data: { to: 'linkuser1', subject: 'Link check', body: `Join here: ${link}\nOther: https://evil.example/phish` } }); expect(sent.status()).toBe(201);
    await page.goto(main.base + '/qorlla.html#home'); await page.getByRole('button', { name: /^Mail/ }).click(); await page.getByRole('button', { name: /^Inbox/ }).click(); await page.getByText('Link check').first().click({ timeout: 15000 });
    const a = page.locator('.mail-body a'); await expect(a).toHaveCount(1); await expect(a).toHaveAttribute('href', link); await expect(a).toHaveAttribute('rel', /noopener/);
    const g = await browser.newContext(); const gp = await g.newPage(); await gp.goto(link);
    await expect(gp.locator('label[for="pjName"]')).toHaveText('Your full name'); await gp.fill('#pjName', 'Madonna'); await gp.click('#pjGo');
    await expect(gp.locator('#pjMsg')).toContainText('full name'); await g.close();
  } finally { main.stop(); }
});
