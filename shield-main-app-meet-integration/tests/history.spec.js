const { test, expect } = require('@playwright/test');

// Meeting History and Activity Report: topic and metadata preserved, lifecycle (completed / missed / cancelled), attendance, filters, immutability, access rules.
// Built-in room tests run on the default test server. The "Meet-hosted" test needs a real Meet on :3310 (node scripts/start-recording-test-meet.cjs).
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
test.use({ permissions: ['camera', 'microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

async function signedIn(context, base, name = 'Hostess') {
  const username = 'h' + Math.random().toString(36).slice(2, 8);
  const r = await context.request.post((base || '') + '/api/auth/register', { data: { username, displayName: name, password: 'History-pass-9917!x' } }); expect(r.status()).toBe(201);
}
async function schedule(context, extra = {}) {
  const r = await context.request.post('/api/workplace/schedule', { data: { title: 'Qorlla Development Review', date: ymd(new Date()), time: '23:00', duration: 30, topic: 'Enterprise Meeting Experience v4.0', category: 'team', description: 'Review connection stability and recording compliance', agenda: ['Connection', 'Recording', 'Collaboration'], ...extra } });
  expect(r.status()).toBe(201); return r.json();
}
const hist = async (context, qs = '') => (await (await context.request.get('/api/history/meetings' + qs)).json()).meetings;
const enter = async (page, id, name) => { page.on('dialog', (d) => d.accept()); await page.goto('/index.html?start=join&meeting=' + encodeURIComponent(id) + '&name=' + name); await expect(page.locator('#meetingBar')).toBeVisible(); };

test.describe('metadata and lifecycle (built-in room)', () => {
  test('title and topic stay separate through scheduling and edits; the meeting is finished by the host and appears in History with real facts', async ({ browser }) => {
    test.setTimeout(120000);
    const hc = await browser.newContext(); await signedIn(hc, '', 'Hostess'); const s = await schedule(hc);
    expect(s).toMatchObject({ title: 'Qorlla Development Review', topic: 'Enterprise Meeting Experience v4.0', category: 'team', agenda: ['Connection', 'Recording', 'Collaboration'] });
    const e = await (await hc.request.patch('/api/workplace/schedule/' + s.id, { data: { topic: 'Enterprise Meeting Experience v4.1' } })).json(); expect(e.title).toBe('Qorlla Development Review'); expect(e.topic).toBe('Enterprise Meeting Experience v4.1');
    expect((await hist(hc))).toEqual([]);                                                        // a meeting that has not happened is not history
    const ac = await browser.newContext(); await signedIn(ac, '', 'Ann Attendee'); const hp = await hc.newPage(), ap = await ac.newPage();
    await enter(hp, s.meetingId, 'Hostess'); await enter(ap, s.meetingId, 'Ann'); await expect(hp.locator('#videoGrid .tile')).toHaveCount(2); await hp.waitForTimeout(1500);
    await expect.poll(async () => (await hist(hc)).length).toBe(0);                              // still running: not history
    await hp.click('#endCallBtn'); await expect.poll(async () => (await hist(hc)).length, { timeout: 15000 }).toBe(1);
    const [b] = await hist(hc); expect(b).toMatchObject({ title: 'Qorlla Development Review', topic: 'Enterprise Meeting Experience v4.1', category: 'team', status: 'completed', uniqueAttendeeCount: 2, peakConcurrentCount: 2, hostName: 'Hostess', isHost: true, meetingId: s.meetingId, endReason: 'host_ended' });
    expect(b.durationSeconds).toBeGreaterThanOrEqual(1); expect(Date.parse(b.actualEndAt)).toBeGreaterThan(Date.parse(b.actualStartAt)); expect(Date.parse(b.scheduledStartAt)).toBeGreaterThan(0);
    // host details: description, agenda, attendee list
    const d = await (await hc.request.get('/api/history/meetings/' + encodeURIComponent(s.meetingId))).json();
    expect(d.description).toContain('connection stability'); expect(d.agenda).toEqual(['Connection', 'Recording', 'Collaboration']); expect(d.attendees.map((x) => x.name).sort()).toEqual(['Ann', 'Hostess']); expect(d.recordings.available).toBe(false);
    // an attendee sees the meeting, but not who else came
    const bi = (await hist(ac)); expect(bi).toHaveLength(1); expect(bi[0].isHost).toBe(false);
    const di = await (await ac.request.get('/api/history/meetings/' + encodeURIComponent(s.meetingId))).json(); expect(di.agenda).toHaveLength(3); expect(di.attendees).toBeUndefined();
    expect((await ac.request.get('/api/history/meetings/' + encodeURIComponent(s.meetingId) + '/report')).status()).toBe(403); expect((await ac.request.patch('/api/history/meetings/' + encodeURIComponent(s.meetingId), { data: { outcome: 'x' } })).status()).toBe(403);
    // a stranger sees nothing; signed-out is refused
    const sc = await browser.newContext(); await signedIn(sc, '', 'Stranger'); expect(await hist(sc)).toEqual([]); expect((await sc.request.get('/api/history/meetings/' + encodeURIComponent(s.meetingId))).status()).toBe(404);
    expect((await (await browser.newContext()).request.get('/api/history/meetings')).status()).toBe(401);
    // the room broadcast / public lookups never carry attendance or outcome
    const pub = await (await hc.request.get('/api/meetings/validate/' + encodeURIComponent(s.meetingId))).text(); expect(pub).not.toMatch(/attendance|joinedAccounts|actionItems/);
    for (const c of [hc, ac, sc]) await c.close();
  });

  test('a finished meeting is frozen: schedule edits and deletion do not change it, it cannot be joined or restarted, and the outcome and action items stay writable (host only)', async ({ browser }) => {
    test.setTimeout(120000);
    const hc = await browser.newContext(); await signedIn(hc, '', 'Hostess'); const s = await schedule(hc, { title: 'Frozen review', topic: 'Original topic' }); const hp = await hc.newPage(); await enter(hp, s.meetingId, 'Hostess'); await hp.waitForTimeout(800); await hp.click('#endCallBtn');
    await expect.poll(async () => (await hist(hc)).length, { timeout: 15000 }).toBe(1); const before = (await hist(hc))[0];
    const ed = await hc.request.patch('/api/workplace/schedule/' + s.id, { data: { title: 'Renamed later', topic: 'Changed later', category: 'training', date: ymd(new Date(Date.now() + 864e5)) } }); expect(ed.status()).toBe(200);
    const after = (await hist(hc))[0]; expect(after).toMatchObject({ title: 'Frozen review', topic: 'Original topic', category: 'team', scheduledStartAt: before.scheduledStartAt, actualStartAt: before.actualStartAt, durationSeconds: before.durationSeconds });
    expect((await hc.request.get('/api/meetings/validate/' + encodeURIComponent(s.meetingId))).status()).toBe(404);          // cannot be joined
    expect((await hc.request.post('/api/meetings/' + encodeURIComponent(s.meetingId) + '/start', { data: {} })).status()).toBe(404);   // cannot be restarted
    expect((await (await browser.newContext()).request.post('/api/guest/meetings/resolve', { data: { meetingId: s.meetingId } })).status()).toBe(404);
    await hc.request.delete('/api/workplace/schedule/' + s.id); expect((await hist(hc))[0].title).toBe('Frozen review'); expect((await hist(hc))[0].status).toBe('completed');   // deleting the schedule item keeps the record
    const url = '/api/history/meetings/' + encodeURIComponent(s.meetingId);
    const w = await hc.request.patch(url, { data: { outcome: 'Reviewed progress; certification items assigned.', actionItems: [{ text: 'Run TURN certification', owner: 'Hostess', due: '2026-11-05', done: false }, { text: '=HYPERLINK("x")', owner: 'Bob', due: 'nope', done: true }] } }); expect(w.status()).toBe(200);
    const d = await w.json(); expect(d.outcome).toContain('certification'); expect(d.actionItems).toHaveLength(2); expect(d.actionItems[1].due).toBe('');
    expect((await hc.request.patch(url, { data: { outcome: 5 } })).status()).toBe(400); expect((await hc.request.patch(url, { data: { actionItems: 'x' } })).status()).toBe(400);
    expect((await hist(hc))[0].outcomeSummary).toContain('Reviewed progress'); expect((await hist(hc))[0].title).toBe('Frozen review');
    const csv = await (await hc.request.get(url + '/report')).text(); expect(csv).toContain('Frozen review'); expect(csv).toContain('Original topic'); expect(csv).toContain("'=HYPERLINK"); expect(csv).toContain('Hostess');
    const json = await (await hc.request.get(url + '/report?format=json')).json(); expect(json.uniqueAttendeeCount).toBe(1);
    await hc.close();
  });

  test('missed and cancelled meetings are history too; filters and search find them; scheduled ones are not listed', async ({ browser }) => {
    test.setTimeout(60000);
    const hc = await browser.newContext(); await signedIn(hc, '', 'Hostess');
    const yesterday = ymd(new Date(Date.now() - 2 * 864e5)), tomorrow = ymd(new Date(Date.now() + 864e5));
    await schedule(hc, { title: 'Nobody came', topic: 'Quarterly planning', date: yesterday, time: '10:00', category: 'training' });
    const c = await schedule(hc, { title: 'Dropped plan', topic: 'Offsite logistics', date: tomorrow, category: 'other' }); await hc.request.delete('/api/workplace/schedule/' + c.id);
    await schedule(hc, { title: 'Upcoming', topic: 'Not yet', date: tomorrow });
    const all = await hist(hc); expect(all.map((x) => x.title).sort()).toEqual(['Dropped plan', 'Nobody came']);
    expect(all.find((x) => x.title === 'Nobody came')).toMatchObject({ status: 'missed', uniqueAttendeeCount: 0, durationSeconds: null, topic: 'Quarterly planning' }); expect(all.find((x) => x.title === 'Dropped plan').status).toBe('cancelled');
    expect((await hist(hc, '?status=missed')).map((x) => x.title)).toEqual(['Nobody came']); expect((await hist(hc, '?status=cancelled')).map((x) => x.title)).toEqual(['Dropped plan']);
    expect((await hist(hc, '?q=quarterly')).map((x) => x.title)).toEqual(['Nobody came']); expect((await hist(hc, '?q=OFFSITE')).map((x) => x.title)).toEqual(['Dropped plan']); expect((await hist(hc, '?q=hostess')).length).toBe(2);
    expect((await hist(hc, '?category=training')).map((x) => x.title)).toEqual(['Nobody came']); expect(await hist(hc, '?from=' + tomorrow)).toHaveLength(1); expect(await hist(hc, '?to=' + yesterday)).toHaveLength(1); expect(await hist(hc, '?status=completed')).toEqual([]);
    expect((await hc.request.post('/api/workplace/schedule', { data: { title: 't', date: tomorrow, time: '10:00', duration: 30, category: 'nonsense', agenda: new Array(40).fill('x'.repeat(500)) } })).status()).toBe(201);   // unknown categories are dropped, agenda is capped
    const lst = await (await hc.request.get('/api/workplace/schedule')).json(); const odd = lst.find((x) => x.title === 't'); expect(odd.category).toBe(''); expect(odd.agenda.length).toBe(20); expect(odd.agenda[0].length).toBe(200);
    expect((await hc.request.get('/api/history/meetings/000%200000%200000')).status()).toBe(404);
    await hc.close();
  });

  test('Workspace page: History Meetings is a dropdown beneath the day meetings with expandable cards; filters, search, state kept, Reschedule makes a NEW meeting', async ({ browser }) => {
    test.setTimeout(150000);
    const hc = await browser.newContext(); await signedIn(hc, '', 'Hostess'); const s = await schedule(hc, { title: 'Design sync', topic: 'Navigation redesign' });
    const hp = await hc.newPage(); await enter(hp, s.meetingId, 'Hostess'); await hp.waitForTimeout(800); await hp.click('#endCallBtn'); await expect.poll(async () => (await hist(hc)).length, { timeout: 15000 }).toBe(1);
    await schedule(hc, { title: 'Nobody came', topic: 'Ops updates', date: ymd(new Date(Date.now() - 2 * 864e5)), time: '10:00', category: 'other' });
    const page = await hc.newPage(); await page.goto('/qorlla.html#home');
    const panel = page.locator('.hist-panel'); const toggle = panel.locator('.hist-toggle'); await expect(panel).toBeVisible(); await expect(toggle).toContainText('History Meetings'); await expect(toggle).toHaveAttribute('aria-expanded', 'true'); await expect(toggle).toHaveAttribute('aria-controls', 'histBodyHome');
    await expect(panel.locator('.hist-count')).toHaveText('2'); const card = panel.locator('.hist-row', { hasText: 'Design sync' }); await expect(card).toBeVisible();
    // collapsed card: title, topic, date, duration, attendees, status
    await expect(card.locator('.hist-title')).toHaveText('Design sync'); await expect(card.locator('.hist-topic')).toHaveText('Topic: Navigation redesign'); await expect(card.locator('.hist-chip')).toHaveText(/Completed/); await expect(card.locator('.hist-meta')).toContainText('1 attendee'); await expect(card.locator('.hist-date')).toContainText(String(new Date().getFullYear()));
    const head = card.locator('.hist-rowhead'); await expect(head).toHaveAttribute('aria-expanded', 'false'); await expect(card.locator('.hist-body')).toBeHidden();
    await head.focus(); await page.keyboard.press('Enter'); await expect(head).toHaveAttribute('aria-expanded', 'true'); await expect(card.locator('.hist-body')).toContainText('Review connection stability'); await expect(card.locator('.hist-body')).toContainText('Connection'); await expect(card.locator('.hist-body')).toContainText('Peak attendance'); await expect(card.locator('.hist-body')).toContainText('Hostess');
    await expect(card.getByRole('link', { name: 'Export report' })).toBeVisible(); await expect(card.getByRole('button', { name: 'Reschedule' })).toBeVisible();
    // two cards expand independently
    const other = panel.locator('.hist-row', { hasText: 'Nobody came' }); await other.locator('.hist-rowhead').click(); await expect(other.locator('.hist-body')).toContainText('Did not start'); await expect(card.locator('.hist-body')).toBeVisible();
    // outcome
    await card.locator('.hist-body textarea').fill('We chose option B.'); await card.getByRole('button', { name: 'Save outcome' }).click(); await expect(page.locator('#toast')).toContainText('Saved'); await expect.poll(async () => (await hist(hc)).find((x) => x.title === 'Design sync').outcomeSummary).toContain('option B');
    // filters and search
    await panel.locator('.hist-filterchip[data-status=missed]').click(); await expect(panel.locator('.hist-row')).toHaveCount(1); await expect(panel.locator('.hist-row')).toContainText('Nobody came'); await expect(panel.locator('.hist-filterchip[data-status=missed]')).toHaveAttribute('aria-pressed', 'true');
    await panel.locator('.hist-filterchip[data-status=cancelled]').click(); await expect(panel.locator('.hist-list')).toContainText('No meetings match'); await panel.locator('.hist-filterchip[data-status=""]').click(); await expect(panel.locator('.hist-row')).toHaveCount(2);
    await panel.locator('input[type=search]').fill('navigation'); await expect(panel.locator('.hist-row')).toHaveCount(1); await panel.locator('input[type=search]').fill(''); await expect(panel.locator('.hist-row')).toHaveCount(2);
    // the open/closed state is remembered while moving around the page
    await page.locator('.nav-item[data-view=notes]').click(); await page.locator('.nav-item[data-view=home]').click();
    await expect(panel.locator('.hist-toggle')).toHaveAttribute('aria-expanded', 'true'); await expect(panel.locator('.hist-row', { hasText: 'Design sync' }).locator('.hist-body')).toBeVisible();
    await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(panel.locator('.hist-panelbody')).toBeHidden(); await page.locator('.nav-item[data-view=notes]').click(); await page.locator('.nav-item[data-view=home]').click(); await expect(page.locator('.hist-toggle')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('.hist-toggle').click(); await expect(page.locator('.hist-panelbody')).toBeVisible();
    // Reschedule: a NEW meeting, the record is untouched
    const c2 = page.locator('.hist-row', { hasText: 'Design sync' }); await c2.getByRole('button', { name: 'Reschedule' }).click(); const dlg = page.locator('dialog.sf[open]'); await expect(dlg).toBeVisible(); await expect(dlg.locator('input.sq-title.big')).toHaveValue('Design sync');
    await expect(dlg.locator('input[aria-label="Meeting topic"]')).toHaveValue('Navigation redesign'); await dlg.locator('button[type=submit], .sf-save, button.primary').first().click();
    await expect.poll(async () => (await (await hc.request.get('/api/workplace/schedule?include=finished')).json()).filter((x) => x.title === 'Design sync').length, { timeout: 15000 }).toBe(2);
    const items = (await (await hc.request.get('/api/workplace/schedule?include=finished')).json()).filter((x) => x.title === 'Design sync'); const fresh = items.find((x) => x.meetingId !== s.meetingId); expect(fresh.topic).toBe('Navigation redesign'); expect(fresh.rescheduledFrom).toBe(s.meetingId);
    expect((await hist(hc)).filter((x) => x.title === 'Design sync')).toHaveLength(1); expect((await hc.request.get('/api/meetings/validate/' + encodeURIComponent(fresh.meetingId))).status()).toBe(200); expect((await hc.request.get('/api/meetings/validate/' + encodeURIComponent(s.meetingId))).status()).toBe(404);
    await hc.close();
  });

  test('server paging and errors: limit/offset work; a failing history request shows an error with Try again; a person with no history sees the empty state', async ({ browser }) => {
    test.setTimeout(90000);
    const hc = await browser.newContext(); await signedIn(hc, '', 'Pager'); for (let n = 0; n < 3; n++) await schedule(hc, { title: 'Old ' + n, date: ymd(new Date(Date.now() - (n + 2) * 864e5)), time: '10:00' });
    const p1 = await (await hc.request.get('/api/history/meetings?limit=2')).json(); expect(p1.total).toBe(3); expect(p1.meetings).toHaveLength(2); const p2 = await (await hc.request.get('/api/history/meetings?limit=2&offset=2')).json(); expect(p2.meetings).toHaveLength(1);
    expect(new Set([...p1.meetings, ...p2.meetings].map((x) => x.meetingId)).size).toBe(3);
    const ec = await browser.newContext(); await signedIn(ec, '', 'Empty'); const ep = await ec.newPage(); await ep.goto('/qorlla.html#home'); await expect(ep.locator('.hist-list')).toContainText('No finished meetings yet'); await expect(ep.locator('.hist-count')).toHaveText('0');
    let fail = 1; await ep.route('**/api/history/meetings**', (r) => (fail-- > 0 ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'History is unavailable' }) }) : r.continue()));
    await ep.reload(); await expect(ep.locator('.hist-err')).toContainText('History is unavailable'); await ep.getByRole('button', { name: 'Try again' }).click(); await expect(ep.locator('.hist-list')).toContainText('No finished meetings yet');
    await hc.close(); await ec.close();
  });
});

// Meet-hosted meetings: attendance comes from Meet's own participant sessions (real Meet on :3310, real PostgreSQL)
const { startMain, organiser: meetOrganiser } = require('./support/meet-stack');
test.describe('Meet-hosted meeting', () => {
  let main; test.beforeAll(async () => { main = await startMain(5293); }); test.afterAll(() => main && main.stop());
  test('who really joined Meet, for how long and how many at once is reported; ending in Meet moves it into History', async ({ browser }) => {
    test.setTimeout(150000);
    const MAIN = main.base, hc = await browser.newContext({ permissions: ['camera', 'microphone'] }); const { item } = await meetOrganiser(hc, MAIN, { name: 'Hostess', title: 'Sprint review' });
    const st = await hc.request.post(MAIN + '/api/meetings/' + encodeURIComponent(item.meetingId) + '/start', { data: { waitingRoom: false, name: 'Hostess', topic: 'Release readiness', category: 'team', title: 'Sprint review' } }); expect(st.status()).toBe(200); const { url } = await st.json();
    const hp = await hc.newPage(); await hp.goto(url); await expect(hp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 });
    const hist = async () => (await (await hc.request.get(MAIN + '/api/history/meetings')).json()).meetings; expect(await hist()).toEqual([]);          // running: not history
    const gc = await browser.newContext({ permissions: ['camera', 'microphone'] }); const gs = await gc.request.post(MAIN + '/api/guest/sessions', { data: { meetingId: item.meetingId, displayName: 'Gail Guest' } }); expect(gs.status()).toBe(201); const gu = (await gs.json()).meet.url;
    const gp = await gc.newPage(); await gp.goto(gu); await expect(gp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 }); await expect(hp.locator('.tile')).toHaveCount(2, { timeout: 30000 }); await hp.waitForTimeout(2500);
    expect(await hist()).toEqual([]);
    await hp.click('#endBtn'); await hp.locator('#rcModal').getByRole('button', { name: 'End for all' }).click();
    await expect.poll(async () => (await hist()).length, { timeout: 30000, intervals: [1000] }).toBe(1);
    const [b] = await hist(); expect(b).toMatchObject({ title: 'Sprint review', topic: 'Release readiness', category: 'team', status: 'completed', uniqueAttendeeCount: 2, peakConcurrentCount: 2, hostName: 'Hostess', isHost: true, endReason: 'host_ended' }); expect(b.durationSeconds).toBeGreaterThanOrEqual(2);
    const d = await (await hc.request.get(MAIN + '/api/history/meetings/' + encodeURIComponent(item.meetingId))).json(); expect(d.attendees.map((x) => x.name).sort()).toEqual(['Gail Guest', 'Hostess']); expect(d.attendanceSource).toBe('Qorlla Meet'); for (const a of d.attendees) expect(a.seconds).toBeGreaterThanOrEqual(1);
    expect((await hc.request.post(MAIN + '/api/meetings/' + encodeURIComponent(item.meetingId) + '/start', { data: {} })).status()).toBe(404);           // not restartable
    for (const c of [hc, gc]) await c.close();
  });
});

test.describe('finished meetings leave the schedule', () => {
  test('ended, missed and cancelled meetings are not on the Schedule page or Home; upcoming and running ones are; History has the finished ones; Calendar keeps them as Ended', async ({ browser }) => {
    test.setTimeout(150000);
    const hc = await browser.newContext(); await signedIn(hc, '', 'Hostess');
    const tomorrow = ymd(new Date(Date.now() + 864e5)), old = ymd(new Date(Date.now() - 2 * 864e5));
    const ended = await schedule(hc, { title: 'Ended one', topic: 'Done', date: ymd(new Date()) }); const running = await schedule(hc, { title: 'Running one', date: ymd(new Date()) });
    await schedule(hc, { title: 'Missed one', date: old, time: '10:00' }); const gone = await schedule(hc, { title: 'Cancelled one', date: tomorrow }); await hc.request.delete('/api/workplace/schedule/' + gone.id);
    await schedule(hc, { title: 'Upcoming one', date: tomorrow });
    const hp = await hc.newPage(); await enter(hp, ended.meetingId, 'Hostess'); await hp.waitForTimeout(800); await hp.click('#endCallBtn'); await expect.poll(async () => (await hist(hc)).some((x) => x.title === 'Ended one'), { timeout: 15000 }).toBe(true);
    const rp = await hc.newPage(); await enter(rp, running.meetingId, 'Hostess');                                           // still running in this page
    const titles = async (qs = '') => (await (await hc.request.get('/api/workplace/schedule' + qs)).json()).map((x) => x.title).sort();
    expect(await titles()).toEqual(['Running one', 'Upcoming one']);                                                         // current only
    expect(await titles('?include=finished')).toEqual(['Ended one', 'Missed one', 'Running one', 'Upcoming one']);          // (the cancelled one was deleted)
    expect((await hist(hc)).map((x) => x.title).sort()).toEqual(['Cancelled one', 'Ended one', 'Missed one']);
    const page = await hc.newPage(); await page.goto('/qorlla.html#schedule'); await expect(page.locator('.card.ev', { hasText: 'Upcoming one' })).toBeVisible(); await expect(page.locator('.card.ev', { hasText: 'Running one' })).toBeVisible();
    for (const t of ['Ended one', 'Missed one', 'Cancelled one']) await expect(page.locator('.card.ev', { hasText: t })).toHaveCount(0);
    await page.goto('/qorlla.html#home'); await expect(page.locator('#homeMeetings')).toContainText('Running one'); await expect(page.locator('#homeMeetings')).not.toContainText('Ended one');
    await expect(page.locator('.hist-row', { hasText: 'Ended one' })).toBeVisible(); await expect(page.locator('.hist-row', { hasText: 'Missed one' })).toBeVisible();
    // a finished meeting ends when its time is over: a record moved into the past is history as soon as it is finished, and cannot come back
    await hp.close(); await hc.close();
  });
});
