const { test, expect, request: pwRequest } = require('@playwright/test');

// Scheduled-meeting actions on Home and Schedule: chat button + "..." menu (Start meeting / Copy meeting link / Edit / Delete).
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
async function signedIn(context, label = 'ma') {
  const username = label + Math.random().toString(36).slice(2, 8);
  const r = await context.request.post('/api/auth/register', { data: { username, displayName: 'Stryker', password: 'Actions-pass-9917!x' } }); expect(r.status()).toBe(201);
  return username;
}
async function schedule(context, extra = {}) {
  const r = await context.request.post('/api/workplace/schedule', { data: { title: 'Weekly sync', date: ymd(new Date()), time: '23:00', duration: 30, ...extra } }); expect(r.status()).toBe(201); return r.json();
}
const card = (page, title) => page.locator('.meeting', { hasText: title });
const menu = (page) => page.locator('.mtg-menu');
const items = (page) => menu(page).getByRole('menuitem');

test.use({ permissions: ['clipboard-read', 'clipboard-write', 'camera', 'microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test.describe('menu and chat button', () => {
  test('Home shows a chat button and a "..." menu with the four actions in order; Delete is red', async ({ page, context }) => {
    await signedIn(context); const s = await schedule(context);
    await page.goto('/qorlla.html#home'); const c = card(page, 'Weekly sync'); await expect(c).toBeVisible();
    await expect(c.getByRole('button', { name: 'Meeting chat' })).toBeVisible(); await expect(c.getByRole('button', { name: 'Meeting chat' }).locator('svg path').first()).toHaveAttribute('d', /M21 12/);   // the icon really draws
    const more = c.getByRole('button', { name: 'More actions' }); await expect(more).toHaveAttribute('aria-haspopup', 'menu');
    await more.click(); await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(items(page)).toHaveText(['Start meeting', 'Copy meeting link', 'Edit', 'Delete']);
    expect(await items(page).nth(3).evaluate((e) => getComputedStyle(e).color)).toBe('rgb(225, 29, 72)');
    expect(await menu(page).evaluate((m) => { const r = m.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })).toBe(true);
    await expect(page.locator('#joinDialog')).not.toBeVisible();                                              // opening the menu did not trigger the card's own Join
    void s;
  });

  test('keyboard and pointer behaviour: arrows move, Escape closes and returns focus, an outside click closes, one menu at a time', async ({ page, context }) => {
    await signedIn(context); await schedule(context); await schedule(context, { title: 'Second one', time: '23:30' });
    await page.goto('/qorlla.html#home'); await expect(card(page, 'Weekly sync')).toBeVisible();
    const more = card(page, 'Weekly sync').getByRole('button', { name: 'More actions' }); await more.focus(); await page.keyboard.press('Enter');
    await expect(items(page).first()).toBeFocused(); await page.keyboard.press('ArrowDown'); await expect(items(page).nth(1)).toBeFocused(); await page.keyboard.press('End'); await expect(items(page).nth(3)).toBeFocused();
    await page.keyboard.press('ArrowDown'); await expect(items(page).first()).toBeFocused();
    await page.keyboard.press('Escape'); await expect(menu(page)).toHaveCount(0); await expect(more).toBeFocused();
    await more.click(); await expect(menu(page)).toHaveCount(1); await card(page, 'Second one').getByRole('button', { name: 'More actions' }).click(); await expect(menu(page)).toHaveCount(1);
    await page.mouse.click(5, 400); await expect(menu(page)).toHaveCount(0);
  });

  test('the Schedule page has the same chat button and menu (and no stray delete icon)', async ({ page, context }) => {
    await signedIn(context); await schedule(context, { title: 'Planning' });
    await page.goto('/qorlla.html#schedule'); const c = page.locator('.card.ev', { hasText: 'Planning' }); await expect(c.getByRole('button', { name: 'Meeting chat' })).toBeVisible();
    await expect(c.getByRole('button', { name: 'Delete meeting' })).toHaveCount(0);
    await c.getByRole('button', { name: 'More actions' }).click(); await expect(items(page)).toHaveText(['Start meeting', 'Copy meeting link', 'Edit', 'Delete']);
  });

  test('calendar events (not meetings) have no meeting menu', async ({ page, context }) => {
    await signedIn(context); const r = await context.request.post('/api/workplace/calendar', { data: { title: 'Dentist', date: ymd(new Date()), start: '22:00', end: '22:30' } }); expect(r.ok()).toBe(true);
    await page.goto('/qorlla.html#home'); await expect(page.locator('.meeting', { hasText: 'Dentist' })).toBeVisible(); await expect(page.locator('.meeting', { hasText: 'Dentist' }).locator('.mtg-acts')).toHaveCount(0);
  });
});

test.describe('actions', () => {
  test('Copy meeting link puts a working guest link on the clipboard', async ({ page, context, baseURL }) => {
    await signedIn(context); const s = await schedule(context);
    await page.goto('/qorlla.html#home'); await card(page, 'Weekly sync').getByRole('button', { name: 'More actions' }).click(); await items(page).nth(1).click();
    await expect(page.locator('#toast')).toContainText('Meeting link copied'); await expect(menu(page)).toHaveCount(0);
    const link = await page.evaluate(() => navigator.clipboard.readText()); expect(link).toBe(`${baseURL}/guest/meeting/${encodeURIComponent(s.meetingId)}/prejoin`);
    const g = await context.newPage(); await g.goto(link); await expect(g.locator('#pjTopic')).toContainText('Weekly sync');
  });

  test('Start meeting enters the meeting with its ID in the built-in room; it is disabled while Meet has not synced the meeting', async ({ page, context }) => {
    await signedIn(context); const s = await schedule(context);
    await page.goto('/qorlla.html#home'); await card(page, 'Weekly sync').getByRole('button', { name: 'More actions' }).click(); await items(page).first().click();
    await expect(page.locator('#dlgTitle')).toContainText('Start meeting'); await expect(page.locator('#siId')).toHaveText(s.meetingId); await page.click('#dlgGo');     // the organiser's start screen (ID and password) first; no Meet here, so the built-in room
    await expect(page).toHaveURL(/\/index\.html\?start=join/); const u = new URL(page.url()); expect(u.searchParams.get('meeting')).toBe(s.meetingId); expect(u.searchParams.get('name')).toBe('Stryker');
    await expect(page.locator('#meetingBar')).toBeVisible(); await expect(page.locator('#meetingIdLabel')).toHaveText(s.meetingId); await expect(page.locator('#endCallBtn')).toHaveText('End for Everyone');   // the owner is the host
    // pending sync: the item is disabled and says why
    await page.route('**/api/workplace/schedule', async (route) => { const r = await route.fetch(); const j = await r.json(); await route.fulfill({ response: r, json: j.map((x) => ({ ...x, syncStatus: 'pending_sync' })) }); });
    await page.goto('/qorlla.html#home'); await card(page, 'Weekly sync').getByRole('button', { name: 'More actions' }).click();
    await expect(items(page).first()).toBeDisabled(); await expect(items(page).nth(1)).toBeEnabled();
  });

  test('Edit opens the full dialog prefilled; saving updates the meeting, its live record and keeps the ID; invitations are not re-sent', async ({ page, context }) => {
    await signedIn(context); const s = await schedule(context, { title: 'Old title', location: 'Room A', invitees: ['x@example.com'] });
    await page.goto('/qorlla.html#home'); await card(page, 'Old title').getByRole('button', { name: 'More actions' }).click(); await items(page).nth(2).click();
    const d = page.locator('dialog.sf[open]'); await expect(d).toBeVisible(); await expect(d).toContainText('Edit event');
    await expect(d.locator('.sq-title')).toHaveValue('Old title'); await expect(d.locator('input[placeholder="Add a location"]')).toHaveValue('Room A'); await expect(d.locator('.chip-x')).toHaveText([/x@example\.com/]);
    await expect(d.locator('select[aria-label="Repeat"]')).toBeHidden(); await expect(d).toContainText('Edits do not re-send invitations');
    await d.locator('.sq-title').fill('New title'); await d.locator('input[placeholder="Add a location"]').fill('Room B');
    const target = ymd(new Date(Date.now() + 40 * 86400000)); await d.locator('input[type=date]').fill(target); await d.locator('select[aria-label="Time"]').first().selectOption('09:00'); await d.locator('select[aria-label="Time"]').nth(1).selectOption('10:15');
    await d.getByRole('button', { name: 'Save' }).click(); await expect(page.locator('#toast')).toContainText('Meeting updated'); await expect(page.locator('dialog.sf')).toHaveCount(0);
    const list = await (await context.request.get('/api/workplace/schedule')).json(); expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: s.id, title: 'New title', location: 'Room B', date: target, time: '09:00', duration: 75, meetingId: s.meetingId });
    const v = await (await context.request.get('/api/meetings/validate/' + encodeURIComponent(s.meetingId))).json(); expect(v.topic).toBe('New title');   // the live meeting follows the edit
    expect((await context.request.post('/api/guest/meetings/resolve', { data: { meetingId: s.meetingId } })).status()).toBe(200);
    await page.goto('/qorlla.html#schedule'); await expect(page.locator('.card.ev', { hasText: 'New title' })).toContainText('Room B');
  });

  test('Edit validates like create and leaves the meeting unchanged on error', async ({ page, context }) => {
    await signedIn(context); await schedule(context, { title: 'Keep me' });
    await page.goto('/qorlla.html#home'); await card(page, 'Keep me').getByRole('button', { name: 'More actions' }).click(); await items(page).nth(2).click();
    const d = page.locator('dialog.sf[open]'); await d.locator('.sq-title').fill('  '); await d.getByRole('button', { name: 'Save' }).click(); await expect(d.locator('.sq-err')).toContainText('title is required');
    await d.locator('.sq-title').fill('Keep me'); await d.locator('select[aria-label="Time"]').first().selectOption('10:00'); await d.locator('select[aria-label="Time"]').nth(1).selectOption('09:00');
    await d.getByRole('button', { name: 'Save' }).click(); await expect(d.locator('.sq-err')).toContainText('end time must be after');
    await d.getByRole('button', { name: 'Cancel' }).click(); const [s] = await (await context.request.get('/api/workplace/schedule')).json(); expect(s).toMatchObject({ title: 'Keep me', time: '23:00' });
  });

  test('Delete asks first, removes the meeting, and its ID stops working (guests are refused)', async ({ page, context }) => {
    await signedIn(context); const s = await schedule(context, { title: 'Doomed' }); const keep = await schedule(context, { title: 'Survivor', time: '23:30' });
    await page.goto('/qorlla.html#home'); await card(page, 'Doomed').getByRole('button', { name: 'More actions' }).click();
    page.once('dialog', (dl) => dl.dismiss()); await items(page).nth(3).click(); await expect(card(page, 'Doomed')).toBeVisible();                       // cancel keeps it
    await card(page, 'Doomed').getByRole('button', { name: 'More actions' }).click(); page.once('dialog', (dl) => { expect(dl.message()).toContain('Doomed'); dl.accept(); }); await items(page).nth(3).click();
    await expect(page.locator('#toast')).toContainText('Meeting deleted'); await expect(card(page, 'Doomed')).toHaveCount(0); await expect(card(page, 'Survivor')).toBeVisible();
    const list = await (await context.request.get('/api/workplace/schedule')).json(); expect(list.map((x) => x.title)).toEqual(['Survivor']);
    expect((await context.request.get('/api/meetings/validate/' + encodeURIComponent(s.meetingId))).status()).toBe(404);
    expect((await (await pwRequest.newContext({ baseURL: page.url().split('/qorlla')[0] })).post('/api/guest/meetings/resolve', { data: { meetingId: s.meetingId } })).status()).toBe(404);
    expect((await context.request.get('/api/meetings/validate/' + encodeURIComponent(keep.meetingId))).status()).toBe(200);
  });

  test('the chat button opens a chat space named after the meeting; the second click reuses it', async ({ page, context }) => {
    await signedIn(context); const s = await schedule(context, { title: 'Roadmap' });
    await page.goto('/qorlla.html#home'); await card(page, 'Roadmap').getByRole('button', { name: 'Meeting chat' }).click(); await expect(page).toHaveURL(/\/chat\.html#[0-9a-f-]{36}$/);
    const first = page.url().split('#')[1]; const chats = (await (await context.request.get('/api/workplace/chat')).json()).chats; const space = chats.find((c) => c.id === first);
    expect(space).toBeTruthy(); expect(space.name).toContain('Roadmap'); expect(space.type).toBe('space');
    expect((await (await context.request.get('/api/workplace/schedule')).json())[0].chatId).toBe(first);
    await page.goto('/qorlla.html#schedule'); await page.locator('.card.ev', { hasText: 'Roadmap' }).getByRole('button', { name: 'Meeting chat' }).click(); await expect(page).toHaveURL(new RegExp('/chat\\.html#' + first + '$'));
    expect((await (await context.request.get('/api/workplace/chat')).json()).chats.filter((c) => c.name.includes('Roadmap')).length).toBe(1);
    void s;
  });
});

test('meetings belong to their owner: another account cannot edit or delete them', async ({ context, baseURL }) => {
  await signedIn(context); const s = await schedule(context, { title: 'Mine' });
  const other = await pwRequest.newContext({ baseURL }); const u = 'ot' + Math.random().toString(36).slice(2, 8);
  await other.post('/api/auth/register', { data: { username: u, displayName: 'Other', password: 'Actions-pass-9917!x' } });
  expect((await other.patch('/api/workplace/schedule/' + s.id, { data: { title: 'Hijack' } })).status()).toBe(404);
  expect((await other.delete('/api/workplace/schedule/' + s.id)).status()).toBe(404);
  expect((await (await context.request.get('/api/workplace/schedule')).json())[0].title).toBe('Mine');
});

test('on a phone the menu stays on screen and the actions are reachable', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await signedIn(context); await schedule(context, { title: 'Phone check' });
  await page.goto('/qorlla.html#home'); const c = card(page, 'Phone check'); await expect(c).toBeVisible(); await c.getByRole('button', { name: 'More actions' }).click();
  expect(await menu(page).evaluate((m) => { const r = m.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test.describe('starting and joining from Home', () => {
  test('a registered user clicks New meeting, presses Start, and is in a new meeting as host with an 11-digit ID', async ({ page, context }) => {
    await signedIn(context, 'nm'); await page.goto('/qorlla.html#home');
    await page.locator('.action-btn[data-act="meet"]').click(); await expect(page.locator('#joinDialog[open]')).toBeVisible(); await page.click('#dlgGo');
    await expect(page).toHaveURL(/\/index\.html\?start=new/); await expect(page.locator('#meetingBar')).toBeVisible();
    const id = (await page.locator('#meetingIdLabel').textContent()).trim(); expect(id).toMatch(/^\d{3} \d{4} \d{4}$/); await expect(page.locator('#endCallBtn')).toHaveText('End for Everyone');
    expect((await context.request.get('/api/meetings/validate/' + encodeURIComponent(id))).status()).toBe(200);
    expect(page.url()).not.toContain(':3000');                                                          // never a guessed Meet port
  });

  test('Join from Home with a meeting ID enters that meeting; the camera and microphone choices carry over', async ({ page, context, browser, baseURL }) => {
    await signedIn(context, 'jn'); const host = await browser.newContext({ baseURL }); const hp = await host.newPage();
    await hp.goto('/index.html'); await hp.fill('#displayName', 'Host Hal'); await hp.click('#startMeetingBtn'); await expect(hp.locator('#meetingBar')).toBeVisible(); const id = (await hp.locator('#meetingIdLabel').textContent()).trim();
    await page.goto('/qorlla.html#home'); await page.locator('.action-btn[data-act="join"]').click(); await page.fill('#mid', id); await page.uncheck('#cam'); await page.click('#dlgGo');
    await expect(page).toHaveURL(/\/index\.html\?start=join/); expect(new URL(page.url()).searchParams.get('cam')).toBe('0');
    await expect(page.locator('#meetingBar')).toBeVisible(); await expect(page.locator('#meetingIdLabel')).toHaveText(id); await expect(hp.locator('#videoGrid .tile')).toHaveCount(2);
    await host.close();
  });

  test('when a Meet service IS configured, New meeting goes there instead (with the parameters Meet expects)', async ({ page, context }) => {
    await signedIn(context, 'mc'); const seen = [];
    await page.route('http://meet.test.invalid/**', (route) => { seen.push(route.request().url()); route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>meet service</h1>' }); });
    await page.addInitScript(() => { try { localStorage.setItem('zw_meet_url', 'http://meet.test.invalid/'); } catch (e) { /* ignore */ } });
    await page.goto('/qorlla.html#home'); await page.locator('.action-btn[data-act="meet"]').click(); await page.click('#dlgGo');
    await expect(page.getByRole('heading', { name: 'meet service' })).toBeVisible(); const u = new URL(seen[0]); expect(u.searchParams.get('start')).toBe('new'); expect(u.searchParams.get('name')).toBe('Stryker'); expect(u.searchParams.get('return')).toContain('/qorlla.html');
  });
});
