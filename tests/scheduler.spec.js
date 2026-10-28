const { test, expect, request: pwRequest } = require('@playwright/test');
const { spawn } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { startSmtpSink } = require('./support/smtp-sink');

// Scheduler: compact quick-create card first, full event dialog behind "More Options". Real MAIN, real browser; invitation mail goes to a local SMTP sink.
async function signedIn(context, label = 'sch') {
  const username = label + Math.random().toString(36).slice(2, 8);
  const r = await context.request.post('/api/auth/register', { data: { username, displayName: 'Stryker', password: 'Sched-pass-9917!x' } }); expect(r.status()).toBe(201);
  return username;
}
const quick = (page) => page.locator('dialog.sq[open]'); const full = (page) => page.locator('dialog.sf[open]');
const open = async (page) => { await page.goto('/qorlla.html'); await page.click('.nav-item[data-view="schedule"]'); await expect(quick(page)).toBeVisible(); };
const list = async (context) => (await context.request.get('/api/workplace/schedule')).json();

test.describe('quick card first, full dialog on More Options', () => {
  test('Schedule opens the compact card with sensible defaults', async ({ page, context }) => {
    await signedIn(context); await open(page);
    await expect(page.locator('dialog.sq .sq-title')).toHaveValue("Stryker's Qorlla Meeting"); await expect(page.locator('dialog.sq .sq-title')).toBeFocused();
    await expect(quick(page)).toContainText('Does not repeat'); await expect(quick(page)).toContainText('GMT');
    const [s, e] = await quick(page).locator('select').evaluateAll((els) => els.map((x) => x.value)); const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    expect(mins(e) - mins(s)).toBe(30);
    await expect(page.locator('dialog.sf')).toHaveCount(0);                                                     // the full dialog is NOT shown first
    await page.keyboard.press('Escape'); await expect(page.locator('dialog.sq')).toHaveCount(0);
  });

  test('a refresh, a direct #schedule link and back/forward show the list and do NOT open the card; clicking Schedule or New meeting does', async ({ page, context }) => {
    await signedIn(context); await open(page); await page.keyboard.press('Escape'); await expect(page.locator('dialog.sq')).toHaveCount(0);
    await page.reload(); await expect(page.locator('#newMeetingBtn')).toBeVisible(); await page.waitForTimeout(600); await expect(page.locator('dialog.sq')).toHaveCount(0);
    await page.goto('/qorlla.html#schedule'); await page.waitForTimeout(600); await expect(page.locator('#newMeetingBtn')).toBeVisible(); await expect(page.locator('dialog.sq')).toHaveCount(0);
    await page.goto('/qorlla.html#notes'); await page.goBack(); await page.waitForTimeout(600); await expect(page.locator('dialog.sq')).toHaveCount(0);
    await page.click('#newMeetingBtn'); await expect(quick(page)).toBeVisible(); await page.keyboard.press('Escape');
    await page.goto('/qorlla.html'); await page.focus('.nav-item[data-view="schedule"]'); await page.keyboard.press('Enter'); await expect(quick(page)).toBeVisible();   // keyboard counts as an explicit action
  });

  test('Save on the quick card creates a real meeting with an 11-digit ID that validates', async ({ page, context }) => {
    await signedIn(context); await open(page);
    await page.fill('dialog.sq .sq-title', 'Design review'); await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#toast')).toContainText('ID '); await expect(page.locator('.card.ev', { hasText: 'Design review' })).toBeVisible();
    const items = await list(context); expect(items).toHaveLength(1); expect(items[0].meetingId).toMatch(/^\d{3} \d{4} \d{4}$/); expect(items[0].duration).toBe(30);
    expect((await context.request.get('/api/meetings/validate/' + encodeURIComponent(items[0].meetingId))).status()).toBe(200);
    await expect(page.locator('dialog.sq')).toHaveCount(0);
  });

  test('More Options carries what was typed into the full dialog, which then saves every extra field', async ({ page, context }) => {
    await signedIn(context); await open(page);
    await page.fill('dialog.sq .sq-title', 'Quarterly planning'); await page.fill('dialog.sq input[placeholder="Add invitees"]', 'a@example.com, B@Example.com');
    await page.fill('dialog.sq input[placeholder="Add rooms or locations"]', 'HQ 4th floor');
    await page.getByRole('button', { name: 'More Options' }).first().click();
    await expect(full(page)).toBeVisible(); await expect(page.locator('dialog.sq')).toHaveCount(0);
    await expect(page.locator('dialog.sf .sq-title')).toHaveValue('Quarterly planning'); await expect(page.locator('dialog.sf .chip-x')).toHaveText([/a@example\.com/, /b@example\.com/]);
    await expect(page.locator('dialog.sf input[placeholder="Add a location"]')).toHaveValue('HQ 4th floor');
    await page.fill('dialog.sf input[placeholder="Add a room"]', 'Room 12'); await page.fill('dialog.sf textarea[aria-label="Add description"]', 'Bring the budget.');
    await page.getByRole('button', { name: 'Create agenda' }).click(); await page.fill('dialog.sf textarea[aria-label="Agenda"]', '1. Budget');
    await page.selectOption('dialog.sf select[aria-label="Show as"]', 'free'); await page.selectOption('dialog.sf select[aria-label="Time zone"]', 'Europe/London');
    await page.getByRole('button', { name: 'Save' }).click(); await expect(page.locator('.card.ev', { hasText: 'Quarterly planning' })).toBeVisible();
    const [s] = await list(context);
    expect(s).toMatchObject({ title: 'Quarterly planning', location: 'HQ 4th floor', room: 'Room 12', timezone: 'Europe/London', busy: false, invitees: ['a@example.com', 'b@example.com'] });
    expect(s.agenda).toContain('1. Budget'); expect(s.description).toContain('Bring the budget.'); expect(s.description).not.toContain('1. Budget');   // the agenda is its own field now
    expect(s.inviteResults.map((r) => r.status)).toEqual(['not_configured', 'not_configured']);                  // no SMTP here: stored honestly
    await expect(page.locator('#toast')).toContainText('Invitations not sent'); await expect(page.locator('#toast')).toContainText('email is not set up');
    await expect(page.locator('.card.ev', { hasText: 'Quarterly planning' })).toContainText('not emailed');
  });

  test('the Settings link opens the full dialog at the meeting (passcode) section', async ({ page, context }) => {
    await signedIn(context); await open(page); await page.locator('dialog.sq .linkbtn', { hasText: 'Settings' }).click();
    await expect(full(page)).toBeVisible(); await expect(page.locator('dialog.sf input[type=password]')).toBeFocused();
  });
});

test.describe('validation and series', () => {
  test('clear messages for a missing title, an end before the start and a bad invitee; nothing is created', async ({ page, context }) => {
    await signedIn(context); await open(page);
    await page.fill('dialog.sq .sq-title', '   '); await page.getByRole('button', { name: 'Save' }).click(); await expect(page.locator('dialog.sq .sq-err')).toContainText('title is required');
    await page.fill('dialog.sq .sq-title', 'X'); await page.selectOption('dialog.sq select >> nth=0', '10:00'); await page.selectOption('dialog.sq select >> nth=1', '09:00');
    await page.getByRole('button', { name: 'Save' }).click(); await expect(page.locator('dialog.sq .sq-err')).toContainText('end time must be after');
    await page.selectOption('dialog.sq select >> nth=1', '10:30'); await page.fill('dialog.sq input[placeholder="Add invitees"]', 'not-an-address');
    await page.getByRole('button', { name: 'Save' }).click(); await expect(page.locator('dialog.sq .sq-err')).toContainText('Not a valid email');
    expect(await list(context)).toHaveLength(0); await expect(quick(page)).toBeVisible();                       // the card stays open with the input intact
  });

  test('a weekly repeat creates separate meetings a week apart, each with its own ID; All Day is 24 hours from midnight', async ({ page, context }) => {
    await signedIn(context); await open(page); await page.fill('dialog.sq .sq-title', 'Stand-up'); await page.getByRole('button', { name: 'More Options' }).first().click();
    await page.selectOption('dialog.sf select[aria-label="Repeat"]', 'weekly'); await page.fill('dialog.sf input[aria-label="Occurrences"]', '3');
    await expect(page.locator('dialog.sf')).toContainText('This creates 3 separate meetings'); await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.card.ev', { hasText: 'Stand-up' })).toHaveCount(3);
    const items = (await list(context)).filter((x) => x.title === 'Stand-up'); expect(new Set(items.map((x) => x.meetingId)).size).toBe(3);
    const dates = items.map((x) => x.date).sort(); const gap = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000; expect([gap(dates[0], dates[1]), gap(dates[1], dates[2])]).toEqual([7, 7]);
    expect(new Set(items.map((x) => x.seriesId)).size).toBe(1); expect(items[0].seriesId).toBeTruthy();
    await page.click('#newMeetingBtn'); await expect(quick(page)).toBeVisible(); await page.fill('dialog.sq .sq-title', 'Offsite'); await page.getByRole('button', { name: 'More Options' }).first().click();
    await page.check('dialog.sf input[type=checkbox]'); await page.getByRole('button', { name: 'Save' }).click(); await expect(page.locator('.card.ev', { hasText: 'Offsite' })).toBeVisible();
    const off = (await list(context)).find((x) => x.title === 'Offsite'); expect(off).toMatchObject({ time: '00:00', duration: 1440, allDay: true });
  });

  test('the API refuses bad event details', async ({ context }) => {
    await signedIn(context); const post = (data) => context.request.post('/api/workplace/schedule', { data: { title: 'T', date: '2030-01-07', time: '10:00', duration: 30, ...data } });
    expect((await post({ timezone: 'Not A Zone!' })).status()).toBe(400);
    expect((await post({ invitees: ['ok@example.com', 'broken'] })).status()).toBe(400);
    expect((await post({ invitees: Array.from({ length: 51 }, (_, i) => `u${i}@example.com`) })).status()).toBe(400);
    expect((await post({ seriesId: '../../x' })).status()).toBe(400);
    const ok = await post({ description: 'x'.repeat(5000), location: 'y'.repeat(500) }); expect(ok.status()).toBe(201); const s = await ok.json(); expect(s.description.length).toBe(2000); expect(s.location.length).toBe(200);
  });
});

test.describe('layout', () => {
  for (const [name, vp] of Object.entries({ desktop: { width: 1366, height: 768 }, phone: { width: 390, height: 844 } })) {
    test(`both views fit and stay usable on ${name}`, async ({ page, context }) => {
      await page.setViewportSize(vp); await signedIn(context); await open(page);
      const inView = async (sel) => { const b = await page.locator(sel).boundingBox(); return b && b.y >= 0 && b.y + b.height <= vp.height + 1 && b.x >= 0 && b.x + b.width <= vp.width + 1; };
      expect(await inView('dialog.sq')).toBe(true); expect(await inView('dialog.sq button:has-text("Save")')).toBe(true);
      await page.getByRole('button', { name: 'More Options' }).first().click(); await expect(full(page)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByRole('button', { name: 'Save' })).toBeInViewport(); await expect(page.getByRole('button', { name: 'Cancel' })).toBeInViewport();
      await page.getByRole('button', { name: 'Cancel' }).click(); await expect(page.locator('dialog.sf')).toHaveCount(0);
    });
  }
  test('labels follow the chosen language', async ({ page, context }) => {
    await page.addInitScript(() => { try { localStorage.setItem('qorlla.locale', 'fr'); } catch (e) { /* ignore */ } });
    await signedIn(context); await open(page); await expect(quick(page)).toContainText('Plus d’options'); await expect(quick(page)).toContainText('Enregistrer');
  });
});

test.describe('invitation email (local SMTP sink)', () => {
  let nextPort = 5500 + Math.floor(Math.random() * 140);   // 5500-5639; avoids ports Chromium blocks (e.g. 6000) and the other spec files' ranges
  test('a verified host\'s invitees get one email with the ID and a guest join link; a series sends invitations once', async ({ browser }) => {
    test.setTimeout(120000);
    const sink = await startSmtpSink(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qorlla-sched-')); const port = nextPort++;
    const env = { ...process.env, PORT: String(port), DATA_DIR: dir, SMTP_URL: `smtp://127.0.0.1:${sink.port}`, SMTP_FROM: 'Qorlla <no-reply@test.local>', PUBLIC_URL: `http://127.0.0.1:${port}` }; delete env.DATABASE_URL;
    const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' }); const base = `http://127.0.0.1:${port}`;
    let up = false; for (let i = 0; i < 300 && !up; i++) { try { up = (await fetch(base + '/api/health')).ok; } catch (e) { /* not up yet */ } if (!up) await new Promise((r) => setTimeout(r, 150)); }
  if (!up) throw new Error('test server did not start within 45 s: ' + base);   // fail loudly, never continue against a server that is not there
    try {
      const ctx = await browser.newContext({ baseURL: base }); const page = await ctx.newPage();
      const username = 'host' + Math.random().toString(36).slice(2, 7); const email = username + '@example.test';
      expect((await ctx.request.post('/api/auth/register', { data: { username, displayName: 'Stryker', email, password: 'Sched-pass-9917!x' } })).status()).toBe(201);
      const verify = await sink.waitFor((m) => m.to.includes(email) && /verify=/.test(m.text)); const token = /verify=([0-9a-f]{64})/.exec(verify.text)[1];
      expect((await (await pwRequest.newContext({ baseURL: base })).post('/api/auth/verify', { data: { token } })).status()).toBe(200);
      await page.goto('/qorlla.html'); await page.click('.nav-item[data-view="schedule"]'); await expect(quick(page)).toBeVisible();
      await page.fill('dialog.sq .sq-title', 'Board meeting'); await page.fill('dialog.sq input[placeholder="Add invitees"]', 'guest1@example.test, guest2@example.test');
      await page.getByRole('button', { name: 'More Options' }).first().click(); await page.selectOption('dialog.sf select[aria-label="Repeat"]', 'daily'); await page.fill('dialog.sf input[aria-label="Occurrences"]', '3');
      await page.getByRole('button', { name: 'Save' }).click(); await expect(page.locator('#toast')).toContainText('Invitations sent: 2');
      const items = await (await ctx.request.get('/api/workplace/schedule')).json(); const first = items.filter((x) => x.title === 'Board meeting').sort((a, b) => a.date.localeCompare(b.date))[0];
      for (const to of ['guest1@example.test', 'guest2@example.test']) {
        const mail = await sink.waitFor((m) => m.to.includes(to) && /invited you/.test(m.text)); expect(mail.text).toContain(first.meetingId); expect(mail.text).toContain('/guest/meeting/' + encodeURIComponent(first.meetingId) + '/prejoin');
        expect(mail.text).toContain('Reply'); expect(mail.text).not.toMatch(/hostKey|passcodeHash/);
      }
      await new Promise((r) => setTimeout(r, 800));
      expect(sink.messages.filter((m) => /invited you/.test(m.text)).length).toBe(2);                         // 2 people x 1 email, not x3 occurrences
      await ctx.close();
    } finally { child.kill(); await sink.close(); }
  });
});
