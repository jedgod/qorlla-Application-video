const { test, expect } = require('@playwright/test');

// Workspace overview: the two pinned summaries in the history drawer (My Week's Summary, Past Week's Summary), the third quick action
// ("Summarize my past activities") and the endpoint behind them (GET /ai/context/activity). Existing behaviour is covered by
// qorlla-overview-panel.spec.js and qorlla-sources.spec.js, which must keep passing unchanged.

const PASSWORD = 'Summaries-test-4417!';
const API = '/api/workplace/ai';
const WP = '/api/workplace';
const uname = () => 'sm' + Math.random().toString(36).slice(2, 12);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const daysAgo = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return d; };

async function signUp(request) {
  const username = uname();
  const r = await request.post('/api/auth/register', { data: { username, password: PASSWORD } });
  expect(r.status()).toBe(201);
  return username;
}
async function csrf(request) { return { 'X-CSRF-Token': (await (await request.get('/api/auth/csrf')).json()).token }; }
const activity = (request, from, to) => request.get(API + '/context/activity?from=' + from + '&to=' + to);
const chats = async (request) => (await (await request.get(API + '/chats')).json()).chats;
const drawerRows = (page) => page.locator('#aiDrawer .sum-row');

async function seed(request) {
  const h = await csrf(request);
  const today = ymd(new Date());
  expect((await request.post(WP + '/calendar', { data: { title: 'Sprint retro', date: today, start: '09:00', end: '10:00' }, headers: h })).status()).toBe(201);
  expect((await request.post(WP + '/notes', { data: { title: 'Weekly', content: '[x] Send the report\n[ ] Call Sam\nDONE: Book the room' }, headers: h })).status()).toBe(201);
}

test.describe('API: GET /ai/context/activity', () => {
  test('needs sign-in, and refuses bad periods', async ({ request }) => {
    expect((await activity(request, '2026-01-01', '2026-01-02')).status()).toBe(401);
    await signUp(request);
    const today = ymd(new Date()), tomorrow = ymd(daysAgo(-1));
    for (const [from, to, why] of [
      ['', '', 'missing'], ['2026-1-1', '2026-01-02', 'not YYYY-MM-DD'], ['2026-02-30', '2026-03-01', 'not a real date'],
      [today, ymd(daysAgo(3)), 'end before start'], [ymd(daysAgo(400)), today, 'over a year'], [tomorrow, tomorrow, 'starts in the future'],
    ]) {
      const r = await activity(request, from, to);
      expect(r.status(), why).toBe(400);
      expect(typeof (await r.json()).error, why).toBe('string');
    }
    expect((await activity(request, ymd(daysAgo(365)), today)).status(), 'exactly 366 days is allowed').toBe(200);
  });

  test('returns this account\'s own meetings, notes and completed tasks for the period, and nothing outside it', async ({ request }) => {
    await signUp(request); await seed(request);
    const today = ymd(new Date());
    const d = await (await activity(request, today, today)).json();
    expect(d.used.sort()).toEqual(['canvas', 'chat', 'mail', 'meetings', 'my_notes']); expect(d.off).toEqual([]);
    expect(d.days).toBe(1);
    expect(d.sources.meetings.total).toBe(1); expect(d.sources.meetings.items[0]).toMatchObject({ title: 'Sprint retro', date: today, start: '09:00' });
    expect(d.sources.my_notes.updated).toBe(1);
    expect(d.sources.my_notes.completedTotal).toBe(2);
    expect(d.sources.my_notes.completed.map((x) => x.text)).toEqual(['Send the report', 'Book the room']);
    expect(d.sources.my_notes.completed[0].note).toBe('Weekly');
    const old = await (await activity(request, ymd(daysAgo(60)), ymd(daysAgo(30)))).json();
    expect(old.sources.meetings.total).toBe(0); expect(old.sources.my_notes.updated).toBe(0); expect(old.sources.my_notes.completedTotal).toBe(0);
  });

  test('another account never sees these records', async ({ request, playwright, baseURL }) => {
    await signUp(request); await seed(request);
    const other = await playwright.request.newContext({ baseURL });
    await signUp(other);
    const today = ymd(new Date());
    const d = await (await activity(other, today, today)).json();
    expect(d.sources.meetings.total).toBe(0); expect(d.sources.my_notes.updated).toBe(0);
    await other.dispose();
  });

  test('a source that is switched off is left out and named; all of them off is refused', async ({ request }) => {
    await signUp(request); await seed(request);
    const h = await csrf(request), today = ymd(new Date());
    expect((await request.patch(API + '/sources/my_notes', { data: { enabled: false }, headers: h })).status()).toBe(200);
    let d = await (await activity(request, today, today)).json();
    expect(d.off).toEqual(['my_notes']); expect(d.used).not.toContain('my_notes'); expect(d.sources.my_notes).toBeUndefined(); expect(d.sources.meetings.total).toBe(1);
    expect((await request.patch(API + '/sources', { data: { enabled: false }, headers: h })).status()).toBe(200);
    const r = await activity(request, today, today);
    expect(r.status()).toBe(403); expect((await r.json()).source).toBe('all');
  });
});

test.describe('API: saved summaries are chats with a kind and a period', () => {
  test('kind and range are stored and returned; bad ones are refused; a deleted summary can be made again but an ordinary deleted chat cannot', async ({ request }) => {
    await signUp(request);
    const h = await csrf(request), range = { from: '2026-11-02', to: '2026-11-08' };
    const msgs = [{ role: 'me', text: 'Past Week' }, { role: 'ai', text: 'summary' }];
    expect((await request.put(API + '/chats/cpastweek', { data: { messages: msgs, kind: 'bogus' }, headers: h })).status()).toBe(400);
    expect((await request.put(API + '/chats/cpastweek', { data: { messages: msgs, kind: 'pastweek', range: { from: '2026-11-08', to: '2026-11-02' } }, headers: h })).status()).toBe(400);
    expect((await request.put(API + '/chats/cpastweek', { data: { messages: msgs, kind: 'pastweek', range: { from: 'x', to: 'y' } }, headers: h })).status()).toBe(400);
    expect((await request.put(API + '/chats/cpastweek', { data: { messages: msgs, kind: 'pastweek', range }, headers: h })).status()).toBe(200);
    expect((await chats(request))[0]).toMatchObject({ id: 'cpastweek', kind: 'pastweek', range });

    expect((await request.patch(API + '/chats/cpastweek', { data: { title: 'Mine' }, headers: h })).status()).toBe(200);
    expect((await chats(request))[0]).toMatchObject({ title: 'Mine', kind: 'pastweek' }); // renaming keeps the kind

    expect((await request.delete(API + '/chats/cpastweek', { headers: h })).status()).toBe(200);
    expect(await chats(request)).toEqual([]);
    const again = await request.put(API + '/chats/cpastweek', { data: { messages: msgs, kind: 'pastweek', range }, headers: h });
    expect(again.status()).toBe(200); expect((await again.json()).title).toBe('');
    expect((await chats(request)).map((c) => c.id)).toEqual(['cpastweek']);

    await request.put(API + '/chats/cplain1', { data: { messages: msgs }, headers: h });
    await request.delete(API + '/chats/cplain1', { headers: h });
    expect((await request.put(API + '/chats/cplain1', { data: { messages: msgs }, headers: h })).status(), 'an ordinary deleted chat stays deleted').toBe(404);
  });
});

test.describe('Workspace overview page', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('a third quick action sits with the other two, with the same size and style', async ({ page }) => {
    await signUp(page.request);
    await page.goto('/qorlla.html');
    const btns = page.locator('#aiIntro .suggestion');
    await expect(btns).toHaveText(['Summarize my week', 'List my recent action items', 'Summarize my past activities']);
    const boxes = [];
    for (let i = 0; i < 3; i++) boxes.push(await btns.nth(i).boundingBox());
    expect(Math.round(boxes[2].width)).toBe(Math.round(boxes[0].width)); expect(Math.round(boxes[2].height)).toBe(Math.round(boxes[0].height));
    const style = (loc) => loc.evaluate((e) => { const c = getComputedStyle(e); return [c.backgroundColor, c.borderRadius, c.fontSize, c.fontWeight, c.padding].join('|'); });
    expect(await style(btns.nth(2))).toBe(await style(btns.nth(0)));
    await expect(btns.nth(2).locator('svg')).toBeVisible();
  });

  test('the drawer always lists My Week\'s Summary and Past Week\'s Summary, each with a "..." button; nothing is created until one is selected', async ({ page }) => {
    await signUp(page.request);
    await page.goto('/qorlla.html');
    await page.locator('#aiMenu').click();
    await expect(drawerRows(page)).toHaveCount(2);
    await expect(drawerRows(page).nth(0).locator('.n')).toHaveText("My Week's Summary");
    await expect(drawerRows(page).nth(1).locator('.n')).toHaveText("Past Week's Summary");
    for (let i = 0; i < 2; i++) {
      await expect(drawerRows(page).nth(i).locator('.s')).toContainText('Not created yet');
      await expect(drawerRows(page).nth(i).locator('.more')).toBeVisible();
      await expect(drawerRows(page).nth(i).locator('.more')).toBeDisabled();
    }
    expect(await chats(page.request)).toEqual([]);                                   // opening the drawer saved nothing
    await expect(page.locator('#aiDrawer').getByText('No chats yet.')).toBeVisible(); // ordinary chats are unchanged
  });

  test('My Week\'s Summary: select it, then Rename / Open in browser / Delete work, and it can be created again', async ({ page, context }) => {
    await signUp(page.request); await seed(page.request);
    await page.goto('/qorlla.html');
    await page.locator('#aiMenu').click();
    await drawerRows(page).nth(0).locator('.t').click();
    await expect(page.locator('#aiDrawer')).toBeHidden();
    await expect(page.locator('#aiThread .bubble.me').first()).toHaveText("My Week's Summary");
    await expect(page.locator('#aiThread .bubble.ai').first()).toContainText('Based on:');
    await expect.poll(async () => (await chats(page.request)).map((c) => [c.id, c.kind])).toEqual([['cweek', 'week']]);

    await page.locator('#aiMenu').click();
    const row = drawerRows(page).nth(0);
    await expect(row.locator('.s')).toContainText('Updated');
    await expect(row.locator('.more')).toBeEnabled();
    await row.locator('.more').click();
    const pop = page.locator('#aiRowPop');
    await expect(pop.getByRole('menuitem')).toHaveText(['Rename', 'Open in browser', 'Delete']);

    await pop.getByRole('menuitem', { name: 'Rename' }).click();
    const input = page.locator('.sum-row input.rename');
    await expect(input).toBeFocused(); await expect(input).toHaveValue("My Week's Summary");
    await input.fill('Monday recap'); await input.press('Enter');
    await expect(drawerRows(page).nth(0).locator('.n')).toHaveText('Monday recap');
    await expect.poll(async () => (await chats(page.request)).map((c) => c.title)).toEqual(['Monday recap']);

    await drawerRows(page).nth(0).locator('.more').click();
    const [tab] = await Promise.all([context.waitForEvent('page'), page.locator('#aiRowPop').getByRole('menuitem', { name: 'Open in browser' }).click()]);
    await tab.waitForLoadState('domcontentloaded');
    expect(tab.url()).toMatch(/[?&]aichat=cweek/);
    await expect(tab.locator('#aiThread .bubble.ai').first()).toContainText('Based on:');
    await tab.close();

    await drawerRows(page).nth(0).locator('.more').click();
    await page.locator('#aiRowPop').getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Delete summary?');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(drawerRows(page).nth(0).locator('.s')).toContainText('Not created yet');
    await expect.poll(async () => (await chats(page.request)).length).toBe(0);

    await drawerRows(page).nth(0).locator('.t').click();                              // select it again: it is made again
    await expect(page.locator('#aiThread .bubble.ai').first()).toContainText('Based on:');
    await expect.poll(async () => (await chats(page.request)).map((c) => c.id)).toEqual(['cweek']);
  });

  test('Past Week\'s Summary covers the calendar week that just ended (Monday to Sunday)', async ({ page }) => {
    await signUp(page.request);
    await page.goto('/qorlla.html');
    await page.locator('#aiMenu').click();
    await drawerRows(page).nth(1).locator('.t').click();
    const bubble = page.locator('#aiThread .bubble.ai').first();
    await expect(bubble).toContainText("Past week's summary:");
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const mon = new Date(now); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7) - 7);
    const sun = new Date(mon); sun.setDate(sun.getDate() + 6);
    await expect.poll(async () => (await chats(page.request)).find((c) => c.id === 'cpastweek')?.range).toEqual({ from: ymd(mon), to: ymd(sun) });
    await expect(bubble).toContainText('(7 days)');
    await page.locator('#aiMenu').click();
    await expect(drawerRows(page).nth(1).locator('.s')).toContainText(' – ');   // the row shows the week it covers
  });

  test('Summarize my past activities: choose a period, get a summary of meetings, completed tasks and more, saved in history', async ({ page }) => {
    await signUp(page.request); await seed(page.request);
    await page.goto('/qorlla.html');
    await page.locator('#sugPast').click();
    const card = page.locator('#aiPeriod');
    await expect(card).toBeVisible(); await expect(card.locator('select')).toBeFocused();
    await expect(card.locator('select option')).toHaveText(['Last 30 days', 'Last 90 days', 'Previous month', 'This year so far', 'Choose dates…']);
    await expect(card.locator('.range-dates')).toBeHidden();
    await card.getByRole('button', { name: 'Summarize' }).click();
    await expect(card).toHaveCount(0);
    await expect(page.locator('#aiThread .bubble.me').first()).toContainText('Summarize my past activities (');
    const out = page.locator('#aiThread .bubble.ai').first();
    await expect(out).toContainText('Past activities:');
    await expect(out).toContainText('Meetings and events: 1.'); await expect(out).toContainText('Sprint retro');
    await expect(out).toContainText('Completed tasks: 2.'); await expect(out).toContainText('Send the report');
    await expect(out).toContainText('Based on:');
    await expect.poll(async () => (await chats(page.request)).find((c) => c.kind === 'activity')).toBeTruthy();
    const c = (await chats(page.request)).find((x) => x.kind === 'activity');
    expect(c.range).toEqual({ from: ymd(daysAgo(29)), to: ymd(new Date()) });
    await page.locator('#aiMenu').click();                                            // an ordinary history entry, not one of the two pinned ones
    await expect(page.locator('#aiDrawer .hist-row .t').first()).toContainText('Summarize my past activities');
    await expect(drawerRows(page)).toHaveCount(2);
  });

  test('your own dates are checked before anything is sent; Cancel puts the quick actions back', async ({ page }) => {
    await signUp(page.request);
    await page.goto('/qorlla.html');
    await page.locator('#sugPast').click();
    const card = page.locator('#aiPeriod');
    await card.locator('select').selectOption('custom');
    await expect(card.locator('.range-dates')).toBeVisible();
    await card.getByRole('button', { name: 'Summarize' }).click();
    await expect(card.locator('.range-err')).toHaveText('Choose both dates.');
    await card.locator('#aiPeriodFrom').fill(ymd(daysAgo(2))); await card.locator('#aiPeriodTo').fill(ymd(daysAgo(9)));
    await card.getByRole('button', { name: 'Summarize' }).click();
    await expect(card.locator('.range-err')).toHaveText('The end date is before the start date.');
    await card.locator('#aiPeriodFrom').fill(ymd(daysAgo(500))); await card.locator('#aiPeriodTo').fill(ymd(daysAgo(1)));
    await card.getByRole('button', { name: 'Summarize' }).click();
    await expect(card.locator('.range-err')).toHaveText('Choose a period of at most one year.');
    expect(await chats(page.request)).toEqual([]);                                   // nothing was asked of the server

    await card.locator('#aiPeriodFrom').fill(ymd(daysAgo(10))); await card.locator('#aiPeriodTo').fill(ymd(daysAgo(3)));
    await card.getByRole('button', { name: 'Summarize' }).click();
    await expect(page.locator('#aiThread .bubble.ai').first()).toContainText('(8 days)');

    await page.locator('#aiNew').click();                                            // new chat, then Cancel
    await page.locator('#sugPast').click();
    await page.locator('#aiPeriod').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#aiPeriod')).toHaveCount(0);
    await expect(page.locator('#aiIntro')).toBeVisible();
  });

  test('with every source switched off the summary says so instead of inventing one', async ({ page }) => {
    await signUp(page.request);
    await page.request.patch(API + '/sources', { data: { enabled: false }, headers: await csrf(page.request) });
    await page.goto('/qorlla.html');
    await page.locator('#sugPast').click();
    await page.locator('#aiPeriod').getByRole('button', { name: 'Summarize' }).click();
    await expect(page.locator('#aiThread .bubble.ai').first()).toHaveText('All sources are switched off in Qorlla Sources.');
  });

  test('the period card fits inside the narrowest overview panel', async ({ page }) => {
    await signUp(page.request);
    await page.goto('/qorlla.html');
    await page.locator('#aiResize').focus(); await page.keyboard.press('End');        // wide first, then the narrowest (Home = 300 px)
    await page.keyboard.press('Home');
    expect(Math.round((await page.locator('#aiPanel').boundingBox()).width)).toBe(300);
    await page.locator('#sugPast').click();
    await page.locator('#aiPeriod select').selectOption('custom');
    const p = await page.locator('#aiPanel').boundingBox(), c = await page.locator('#aiPeriod').boundingBox();
    expect(c.x).toBeGreaterThanOrEqual(p.x); expect(c.x + c.width).toBeLessThanOrEqual(p.x + p.width + 1);
    for (const sel of ['#aiPeriodFrom', '#aiPeriodTo']) {
      const b = await page.locator(sel).boundingBox();
      expect(b.x + b.width).toBeLessThanOrEqual(c.x + c.width + 1);
    }
  });
});
