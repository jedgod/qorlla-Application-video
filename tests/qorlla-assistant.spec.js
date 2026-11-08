const { test, expect: baseExpect } = require('@playwright/test');
const expect = baseExpect.configure({ timeout: 15000 });       // this machine is often busy; answers come from real endpoints

// Workspace overview assistant, PHASE 1: the text box understands a fixed set of requests and answers them from the account's own, authorized
// data (no AI model). Unsupported requests get the guidance sentence. Quick actions keep working (qorlla-overview-panel.spec.js).

const PASSWORD = 'Assistant-test-6603!';
const API = '/api/workplace/ai';
const WP = '/api/workplace';
const GUIDANCE = 'I can help summarize your activities, meetings, tasks, and recent Workspace information. Try asking about a specific period or activity.';
const uname = () => 'as' + Math.random().toString(36).slice(2, 12);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const daysAgo = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return d; };

async function signUp(request) {
  const username = uname();
  expect((await request.post('/api/auth/register', { data: { username, password: PASSWORD } })).status()).toBe(201);
  return username;
}
async function csrf(request) { return { 'X-CSRF-Token': (await (await request.get('/api/auth/csrf')).json()).token }; }
async function seed(request) {
  const h = await csrf(request), today = ymd(new Date());
  expect((await request.post(WP + '/calendar', { data: { title: 'Sprint retro', date: today, start: '09:00', end: '10:00' }, headers: h })).status()).toBe(201);
  expect((await request.post(WP + '/notes', { data: { title: 'Weekly', content: '[x] Send the report\n[ ] Call Sam\nDONE: Book the room' }, headers: h })).status()).toBe(201);
}
const chats = async (request) => (await (await request.get(API + '/chats')).json()).chats;
async function ask(page, text) {
  await page.locator('#aiInput').fill(text);
  await page.locator('#aiInput').press('Enter');
}
const lastAi = (page) => page.locator('#aiThread .bubble.ai:not(.pending)').last();      // an error bubble counts, so a failure shows what the panel said

test.describe('the recogniser (fixed date: Sunday, 8 November 2026)', () => {
  const NOW = [2026, 10, 8];
  const cases = [
    // [text, kind, from, to]
    ['Summarize my week', 'week'], ['summarise my week', 'week'], ['Summarize my week?', 'week'],
    ['Summarize last week', 'period', '2026-10-26', '2026-11-01'], ['summarize previous week', 'period', '2026-10-26', '2026-11-01'],
    ['Summarize my past 30 days', 'period', '2026-10-10', '2026-11-08'], ['last 7 days', 'period', '2026-11-02', '2026-11-08'],
    ['summary for the past 3 months', 'period', '2026-08-09', '2026-11-08'], ['past two weeks', 'period', '2026-10-26', '2026-11-08'],
    ['summarize last month', 'period', '2026-10-01', '2026-10-31'], ['summarize this month', 'period', '2026-11-01', '2026-11-30'],
    ['summarize this year', 'period', '2026-01-01', '2026-11-08'], ['Summarize yesterday', 'period', '2026-11-07', '2026-11-07'],
    ['what is my activities for the week', 'period', '2026-11-02', '2026-11-08'], ['show my completed tasks this week', 'period', '2026-11-02', '2026-11-08'],
    ['summarize from 2026-10-01 to 2026-10-15', 'period', '2026-10-01', '2026-10-15'], ['activities between Nov 1 and Nov 5', 'period', '2026-11-01', '2026-11-05'],
    ['what did I do on 11/3', 'period', '2026-11-03', '2026-11-03'], ['summarize since Oct 20', 'period', '2026-10-20', '2026-11-08'],
    ['activities from October 5th to October 9th 2026', 'period', '2026-10-05', '2026-10-09'],
    ['What meetings do I have this week?', 'meetings', '2026-11-02', '2026-11-08'], ['meetings today', 'meetings', '2026-11-08', '2026-11-08'],
    ['what meetings do I have tomorrow', 'meetings', '2026-11-09', '2026-11-09'], ['meetings next week', 'meetings', '2026-11-09', '2026-11-15'],
    ['upcoming meetings', 'meetings', '2026-11-08', '2026-11-14'],
    ['List my recent action items', 'tasks'], ['Show my outstanding tasks', 'tasks'], ['my to-dos', 'tasks'], ['what do I need to do', 'tasks'],
    ['Summarize my past activities', 'askperiod'], ['summarize my activities', 'askperiod'],
    ['summarize from 2026-02-30 to 2026-03-01', 'baddate'], ['activities from 2026-11-05 to 2026-11-01', 'baddate'],
    ['what is the capital of France', 'unsupported'], ['hello', 'unsupported'], ['schedule a meeting with Sam', 'unsupported'], ['send an email to Sam', 'unsupported'],
    ['', 'empty'], ['   ', 'empty'],
  ];
  test('every phrase means what it should', async ({ page }) => {
    await page.goto('/qorlla.html');
    const out = await page.evaluate(([cs, now]) => cs.map((c) => window.QorllaAssistant.parse(c[0], new Date(now[0], now[1], now[2], 14))), [cases, NOW]);
    cases.forEach((c, i) => {
      expect(out[i].kind, JSON.stringify(c[0])).toBe(c[1]);
      if (c[2]) expect(out[i].range, JSON.stringify(c[0])).toEqual({ from: c[2], to: c[3] });
    });
  });
});

test.describe('the text box answers from real data', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('"Summarize my week" typed gives the same kind of answer as the button, and nothing says the box is not connected', async ({ page }) => {
    await signUp(page.request); await seed(page.request);
    await page.goto('/qorlla.html');
    await ask(page, 'Summarize my week');
    await expect(page.locator('#aiThread .bubble.me').first()).toHaveText('Summarize my week');
    await expect(lastAi(page)).toContainText('Based on:');
    await expect(lastAi(page)).toContainText('Next 7 days');
    await expect(page.locator('#aiThread')).not.toContainText('not connected');
    expect((await chats(page.request))[0].messages.map((m) => m.role)).toEqual(['me', 'ai']);   // saved to history like any chat
  });

  test('past and historical periods: last week, past 30 days, this week so far, a year-to-date', async ({ page }) => {
    await signUp(page.request); await seed(page.request);
    await page.goto('/qorlla.html');
    await ask(page, 'Summarize last week');
    await expect(lastAi(page)).toContainText('Summary, last week:'); await expect(lastAi(page)).toContainText('(7 days)');
    await page.locator('#aiNew').click();
    await ask(page, 'Summarize my past 30 days');
    const a = lastAi(page);
    await expect(a).toContainText('(30 days)'); await expect(a).toContainText('Meetings and events: 1.'); await expect(a).toContainText('Sprint retro');
    await expect(a).toContainText('Completed tasks: 2.'); await expect(a).toContainText('Send the report');
    await page.locator('#aiNew').click();
    await ask(page, 'what is my activities for the week');
    await expect(lastAi(page)).toContainText('Summary, this week:');                       // the week so far (it stops at today)
    await page.locator('#aiNew').click();
    await ask(page, 'summarize this year');
    await expect(lastAi(page)).toContainText('Summary, this year so far:');
  });

  test('meetings: this week, today, next week (empty is said plainly), upcoming', async ({ page }) => {
    await signUp(page.request); await seed(page.request);
    await page.goto('/qorlla.html');
    await ask(page, 'What meetings do I have this week?');
    await expect(lastAi(page)).toContainText('Meetings and events, this week'); await expect(lastAi(page)).toContainText('Sprint retro');
    await page.locator('#aiNew').click();
    await ask(page, 'meetings today');
    await expect(lastAi(page)).toContainText('Sprint retro'); await expect(lastAi(page)).toContainText('9:00');
    await page.locator('#aiNew').click();
    await ask(page, 'meetings next week');
    await expect(lastAi(page)).toContainText('No meetings or events found for next week');
    await page.locator('#aiNew').click();
    await ask(page, 'upcoming meetings');
    await expect(lastAi(page)).toContainText('the next 7 days');
  });

  test('tasks: outstanding tasks and action items list the unfinished lines only; with none, it says how to add them', async ({ page }) => {
    await signUp(page.request); await seed(page.request);
    await page.goto('/qorlla.html');
    await ask(page, 'Show my outstanding tasks');
    await expect(lastAi(page)).toContainText('Outstanding tasks: 1.'); await expect(lastAi(page)).toContainText('Call Sam');
    await expect(lastAi(page)).not.toContainText('Send the report');
    await page.locator('#aiNew').click();
    await ask(page, 'List my recent action items');
    await expect(lastAi(page)).toContainText('Call Sam');
  });

  test('with nothing to list, the answer says so (empty result)', async ({ page }) => {
    await signUp(page.request);
    await page.goto('/qorlla.html');
    await ask(page, 'my to-dos');
    await expect(lastAi(page)).toContainText('No outstanding tasks found');
    await page.locator('#aiNew').click();
    await ask(page, 'summarize last year');                                                  // before this account existed (new accounts get a welcome email, so "recent" is not empty)
    await expect(lastAi(page)).toContainText('No recorded activity in this period.');
  });

  test('your own dates: ISO, month names, single days; a bad, backwards, future or over-a-year period is explained, not guessed', async ({ page }) => {
    await signUp(page.request);
    await page.goto('/qorlla.html');
    await ask(page, 'summarize from ' + ymd(daysAgo(10)) + ' to ' + ymd(daysAgo(3)));
    await expect(lastAi(page)).toContainText('(8 days)');
    await page.locator('#aiNew').click();
    await ask(page, 'what did I do on ' + ymd(daysAgo(2)));
    await expect(lastAi(page)).toContainText('(1 day)');
    await page.locator('#aiNew').click();
    await ask(page, 'summarize from 2026-02-30 to 2026-03-01');
    await expect(lastAi(page)).toContainText('I could not read that date');
    await ask(page, 'activities from ' + ymd(daysAgo(1)) + ' to ' + ymd(daysAgo(5)));
    await expect(lastAi(page)).toContainText('I could not read that date');
    await ask(page, 'summarize from ' + ymd(daysAgo(500)) + ' to ' + ymd(daysAgo(1)));
    await expect(lastAi(page)).toHaveText('Please choose a period of up to one year.');
    const f = daysAgo(-3);
    await ask(page, 'summarize from ' + ymd(f) + ' to ' + ymd(daysAgo(-5)));
    await expect(lastAi(page)).toContainText('has not happened yet');
  });

  test('unsupported requests get the guidance sentence (exactly), and it is not used for anything that was understood', async ({ page }) => {
    await signUp(page.request);
    await page.goto('/qorlla.html');
    for (const q of ['what is the capital of France', 'hello', 'schedule a meeting with Sam', 'send an email to Sam']) {
      await ask(page, q);
      await expect(lastAi(page)).toHaveText(GUIDANCE);
    }
    await ask(page, 'Summarize my past 30 days');
    await expect(lastAi(page)).not.toHaveText(GUIDANCE);
    await expect(lastAi(page)).toContainText('Based on:');
  });

  test('"Summarize my past activities" typed asks which period, like the button does', async ({ page }) => {
    await signUp(page.request);
    await page.goto('/qorlla.html');
    await ask(page, 'Summarize my past activities');
    await expect(page.locator('#aiPeriod')).toBeVisible();
    await expect(page.locator('#aiThread .bubble.ai')).toHaveCount(0);                   // nothing was made up in the meantime
  });

  test('loading state, then the answer; the send button is off while it works and a second question is ignored', async ({ page }) => {
    await signUp(page.request);
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route('**/ai/context/activity**', async (route) => { await gate; await route.continue(); });
    await page.goto('/qorlla.html');
    await ask(page, 'summarize last week');
    const pending = page.locator('#aiThread .bubble.pending');
    await expect(pending).toBeVisible(); await expect(pending).toHaveText('Looking through your workspace…');
    await expect(page.locator('#aiSend')).toHaveAttribute('aria-disabled', 'true');
    await ask(page, 'summarize this month');                                              // ignored while one is running
    await expect(page.locator('#aiThread .bubble.me')).toHaveCount(1);
    release();
    await expect(pending).toHaveCount(0);
    await expect(lastAi(page)).toContainText('Summary, last week:');
    await expect(page.locator('#aiSend')).toHaveAttribute('aria-disabled', 'false');
  });

  test('an error is shown with Try again, is not saved to history, and Try again works once the server is back', async ({ page }) => {
    await signUp(page.request);
    await page.route('**/ai/context/activity**', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The data service is down.' }) }));
    await page.goto('/qorlla.html');
    await ask(page, 'summarize last week');
    const err = page.locator('#aiThread .bubble.error');
    await expect(err).toBeVisible(); await expect(err).toContainText('The data service is down.');
    await expect(err.getByRole('button', { name: 'Try again' })).toBeFocused();
    expect(JSON.stringify(await chats(page.request))).not.toContain('data service is down');   // errors never become history
    await page.unroute('**/ai/context/activity**');
    await err.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('#aiThread .bubble.error')).toHaveCount(0);
    await expect(lastAi(page)).toContainText('Summary, last week:');
  });

  test('Qorlla Sources is respected: a switched-off source is said to be off, and nothing from it is used', async ({ page }) => {
    await signUp(page.request); await seed(page.request);
    const h = await csrf(page.request);
    await page.request.patch(API + '/sources/my_notes', { data: { enabled: false }, headers: h });
    await page.request.patch(API + '/sources/meetings', { data: { enabled: false }, headers: h });
    await page.goto('/qorlla.html');
    await ask(page, 'show my outstanding tasks');
    await expect(lastAi(page)).toContainText('My Notes is switched off in Qorlla Sources');
    await page.locator('#aiNew').click();
    await ask(page, 'what meetings do I have this week');
    await expect(lastAi(page)).toContainText('Meetings is switched off in Qorlla Sources');
    await page.locator('#aiNew').click();
    await ask(page, 'summarize my past 30 days');
    await expect(lastAi(page)).toContainText('Switched off: Meetings, My Notes.');
    await expect(lastAi(page)).not.toContainText('Sprint retro'); await expect(lastAi(page)).not.toContainText('Send the report');
    await page.request.patch(API + '/sources', { data: { enabled: false }, headers: h });
    await page.locator('#aiNew').click();
    await ask(page, 'summarize last week');
    await expect(lastAi(page)).toHaveText('All sources are switched off in Qorlla Sources.');
  });

  test('the assistant is not offered to a signed-out visitor; if the session ends while the panel is open, the answer is an error with Try again, never invented data', async ({ page }) => {
    await page.goto('/qorlla.html');
    await expect(page.locator('#aiInput')).toBeHidden();                                   // signed out: the sign-in page, no assistant
    await signUp(page.request);
    await page.goto('/qorlla.html');
    await expect(page.locator('#aiInput')).toBeVisible();
    await page.context().clearCookies();                                                   // the session ends (signed out in another tab, expired, revoked)
    await ask(page, 'summarize last week');
    const err = page.locator('#aiThread .bubble.error');
    await expect(err).toContainText(/sign in/i);
    await expect(err.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.locator('#aiThread .bubble.ai:not(.error)')).toHaveCount(0);
  });

  test('a typed question is kept in history under its own words and reopens with its answer', async ({ page }) => {
    await signUp(page.request);
    await page.goto('/qorlla.html');
    await ask(page, 'Summarize my past 30 days');
    await expect(lastAi(page)).toContainText('(30 days)');
    await page.reload();
    await page.locator('#aiMenu').click();
    const row = page.locator('#aiDrawer .hist-row .t').first();
    await expect(row).toHaveText('Summarize my past 30 days');
    await row.click();
    await expect(lastAi(page)).toContainText('(30 days)');
  });
});
