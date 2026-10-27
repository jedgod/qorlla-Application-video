const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const { BASE } = require('./helpers');

// Qorlla Meet v4.0.2 collaboration sidebar: structured notes (autosave, history, edit access, post-meeting read) and server-authoritative polls.
// Through the unified origin: /meet/. Local Meet: E2E_BASE=http://localhost:3310 E2E_MEET_PATH=/.
const MEET = process.env.E2E_MEET_PATH || '/meet/';
const API = MEET.replace(/\/?$/, '/') + 'api/v1/meetings/';

async function open(browser, who, code) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE, permissions: ['camera', 'microphone'], viewport: { width: 1366, height: 768 }, acceptDownloads: true }); const page = await ctx.newPage();
  await page.goto(MEET); await page.fill('#displayName', who);
  if (code) { await page.fill('#meetingId', code); await page.click('#joinBtn'); } else { await page.fill('#meetingTitle', 'Collab check'); await page.click('#createBtn'); }
  await page.waitForSelector('#app:not(.hidden)'); await expect(page.locator('#liveBadge')).toHaveAttribute('data-state', 'live'); await page.waitForFunction(() => window.__qorlla.state.stream);
  const out = { ctx, page }; if (!code) out.code = (await page.locator('#roomId').textContent()).trim(); return out;
}
async function call(page, path, method = 'GET', body) {
  const s = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qorlla-session')));
  return page.evaluate(async ({ url, method, body, t }) => { const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch {} return { status: r.status, body: json, text }; },
    { url: API + s.meetingId + path, method, body, t: s.token });
}
const tab = (p, name) => p.click('[data-tab=' + name + ']');
const saved = (p) => expect(p.locator('#notesStatus')).toContainText('Saved', { timeout: 15000 });

test.describe('Qorlla Meet notes', () => {
  test('structured notes autosave; others see them live as read-only; the host grants edit access; different sections merge', async ({ browser }) => {
    test.setTimeout(120000);
    const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code); await tab(a.page, 'notes'); await tab(b.page, 'notes');
    await expect(a.page.locator('#notesRole')).toHaveText('Host editor'); await expect(b.page.locator('#notesRole')).toHaveText('Read-only');
    await a.page.fill('#nAgenda .nt-add input', 'Project status review'); await a.page.click('#nAgenda .nt-add button');
    await a.page.fill('#nNotes textarea', 'We reviewed the plan.'); await a.page.fill('#nDecisions .nt-add input', 'Ship v4.0 in November'); await a.page.click('#nDecisions .nt-add button');
    await a.page.fill('#nTasks .nt-add input', 'Prepare release report'); await a.page.click('#nTasks .nt-add button'); await a.page.fill('#nTasks .nt-owner', 'Bob'); await a.page.fill('#nTasks .nt-due', '2026-11-05'); await a.page.locator('#nAgenda input[type=checkbox]').check();
    await saved(a.page);
    // others see it without refreshing, and cannot edit (no add forms, read-only fields); the server refuses too
    await expect(b.page.locator('#nAgenda .nt-in')).toHaveValue('Project status review'); await expect(b.page.locator('#nNotes textarea')).toHaveValue('We reviewed the plan.'); await expect(b.page.locator('#nDecisions .nt-in')).toHaveValue('Ship v4.0 in November'); await expect(b.page.locator('#nTasks .nt-owner')).toHaveValue('Bob');
    await expect(b.page.locator('.nt-add')).toHaveCount(0); await expect(b.page.locator('#nNotes textarea')).toHaveJSProperty('readOnly', true);
    expect((await call(b.page, '/notes', 'PATCH', { baseVersion: 0, sections: ['notes'], doc: { notes: 'hacked' } })).status).toBe(403);
    expect((await call(b.page, '/notes/editors', 'POST', { participantId: 'x', allow: true })).status).toBe(403); expect((await call(b.page, '/notes/restore', 'POST', { version: 1 })).status).toBe(403);
    // a late joiner gets the saved notes from the server
    const c = await open(browser, 'Carol', a.code); await tab(c.page, 'notes'); await expect(c.page.locator('#nNotes textarea')).toHaveValue('We reviewed the plan.'); await expect(c.page.locator('#nTasks .nt-in')).toHaveValue('Prepare release report');
    // host grants Bob edit access
    await a.page.click('#notesShare'); await a.page.locator('#rcModal label', { hasText: 'Bob' }).locator('input').check(); await a.page.locator('#rcModal').getByRole('button', { name: 'Done' }).click();
    await expect(b.page.locator('#notesRole')).toHaveText('You can edit'); await expect(b.page.locator('#nNotes textarea')).toHaveJSProperty('readOnly', false); await expect(c.page.locator('#notesRole')).toHaveText('Read-only');
    // two editors in different sections at the same time: both survive
    await Promise.all([a.page.fill('#nNotes textarea', 'We reviewed the plan. Alice added this.'), b.page.fill('#nDecisions .nt-add input', 'Bob decision')]);
    await b.page.click('#nDecisions .nt-add button'); await saved(a.page); await saved(b.page);
    await expect.poll(async () => (await call(c.page, '/notes')).body.doc.notes).toContain('Alice added this'); const doc = (await call(c.page, '/notes')).body.doc; expect(doc.decisions.map((d) => d.text)).toEqual(['Ship v4.0 in November', 'Bob decision']); expect(doc.decisions[1].at).toBeGreaterThanOrEqual(0);
    // revoke
    await a.page.click('#notesShare'); await a.page.locator('#rcModal label', { hasText: 'Bob' }).locator('input').uncheck(); await a.page.locator('#rcModal').getByRole('button', { name: 'Done' }).click(); await expect(b.page.locator('#notesRole')).toHaveText('Read-only');
    for (const p of [a, b, c]) await p.ctx.close();
  });

  test('offline edits are kept and saved when the connection returns; version history, restore, template and export work', async ({ browser }) => {
    test.setTimeout(120000);
    const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code); await tab(a.page, 'notes'); await tab(b.page, 'notes');
    await a.page.fill('#nNotes textarea', 'first draft'); await saved(a.page); await a.page.click('#notesSnap'); await expect(a.page.locator('#toast')).toContainText('Version saved');
    await a.page.route('**/api/v1/meetings/*/notes', (r) => (r.request().method() === 'PATCH' ? r.abort() : r.continue()));
    await a.page.fill('#nNotes textarea', 'second draft written offline'); await expect(a.page.locator('#notesStatus')).toContainText('Offline', { timeout: 15000 }); await expect(a.page.locator('#announcer')).toContainText('Notes are offline');
    await a.page.unroute('**/api/v1/meetings/*/notes'); await saved(a.page); await expect(b.page.locator('#nNotes textarea')).toHaveValue('second draft written offline', { timeout: 15000 });
    // history lists versions; preview shows an older one; restore brings it back for everyone (host only)
    await a.page.click('#notesHistory'); const dlg = a.page.locator('#rcModal'); await expect(dlg).toContainText('version history'); await dlg.getByRole('button', { name: 'Preview' }).last().click(); await expect(dlg.locator('.nt-preview')).toContainText('first draft');
    await dlg.getByRole('button', { name: 'Restore' }).last().click(); await a.page.locator('#rcModal').getByRole('button', { name: 'Restore' }).last().click();
    await expect(a.page.locator('#nNotes textarea')).toHaveValue('first draft', { timeout: 15000 }); await expect(b.page.locator('#nNotes textarea')).toHaveValue('first draft', { timeout: 15000 });
    await b.page.click('#notesHistory'); await expect(b.page.locator('#rcModal').getByRole('button', { name: 'Restore' })).toHaveCount(0); await b.page.keyboard.press('Escape');                    // guests cannot restore
    // template
    await a.page.selectOption('#notesTemplate', 'project'); await a.page.locator('#rcModal').getByRole('button', { name: 'Apply template' }).click(); await expect(a.page.locator('#nAgenda .nt-in').first()).toHaveValue('Project status review'); await saved(a.page);
    // export
    await a.page.fill('#nTasks .nt-add input', 'Send minutes'); await a.page.click('#nTasks .nt-add button'); await saved(a.page);
    const [dl] = await Promise.all([a.page.waitForEvent('download'), a.page.selectOption('#notesExport', 'md')]); expect(dl.suggestedFilename()).toMatch(/\.md$/); const md = fs.readFileSync(await dl.path(), 'utf8'); expect(md).toContain('## Agenda'); expect(md).toContain('- [ ] Project status review'); expect(md).toContain('Send minutes');
    for (const p of [a, b]) await p.ctx.close();
  });

  test('after the meeting ends, participants can still read the notes but nobody can change them', async ({ browser }) => {
    const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code); await tab(a.page, 'notes'); await a.page.fill('#nNotes textarea', 'Minutes to keep'); await saved(a.page);
    const tokenB = await b.page.evaluate(() => JSON.parse(sessionStorage.getItem('qorlla-session'))); const tokenA = await a.page.evaluate(() => JSON.parse(sessionStorage.getItem('qorlla-session')));
    await a.page.click('#endBtn'); await a.page.locator('#rcModal').getByRole('button', { name: 'End for all' }).click(); await expect(b.page.locator('#landing')).toBeVisible({ timeout: 15000 });
    const get = (t) => b.page.evaluate(async ({ url, t, method, body }) => { const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, { url: API + t.meetingId + '/notes', t: t.token });
    const read = await get(tokenB); expect(read.status).toBe(200); expect(read.body.doc.notes).toBe('Minutes to keep'); expect(read.body.canEdit).toBe(false); expect(read.body.ended).toBe(true);
    const write = await b.page.evaluate(async ({ url, t }) => (await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify({ sections: ['notes'], doc: { notes: 'late edit' } }) })).status, { url: API + tokenA.meetingId + '/notes', t: tokenA.token }); expect(write).toBe(403);   // even the host
    for (const p of [a, b]) await p.ctx.close();
  });
});

test.describe('Qorlla Meet polls', () => {
  test('host launches a poll from the UI; one vote each; results stay hidden until published; closing and publishing show everyone', async ({ browser }) => {
    test.setTimeout(120000);
    const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code); await tab(a.page, 'polls'); await tab(b.page, 'polls');
    await expect(b.page.locator('#pollNew')).toBeHidden(); await expect(a.page.locator('#pollNew')).toBeVisible();
    await a.page.click('#pollNew'); await a.page.fill('#pq', 'Which feature next?'); await a.page.fill('#po', 'Recording compliance\nAI meeting notes\nBreakout rooms'); await a.page.getByRole('button', { name: 'Launch now' }).click();
    await expect(a.page.locator('.pl-card')).toContainText('Which feature next?'); await expect(b.page.locator('.pl-card')).toContainText('Which feature next?'); await expect(b.page.locator('.pl-card .chip')).toHaveText('Open');
    await b.page.getByLabel('AI meeting notes').check(); await b.page.getByRole('button', { name: 'Submit vote' }).click(); await expect(b.page.locator('.pl-card')).toContainText('Your vote is recorded'); await expect(a.page.locator('.pl-card')).toContainText('1 of 2 responded');
    await expect(b.page.locator('.pl-bar')).toHaveCount(0);                                                                                                                  // live results are off: no early peeking
    const pid = (await call(a.page, '/polls')).body.polls[0].id;
    expect((await call(b.page, '/polls/' + pid + '/votes', 'POST', { choices: [0] })).status).toBe(409);                                                                 // one ballot each
    expect((await call(a.page, '/polls/' + pid + '/votes', 'POST', { choices: [9] })).status).toBe(400);                                                                 // out-of-range answer
    expect((await call(b.page, '/polls', 'POST', { question: 'x', kind: 'single', options: ['a', 'b'] })).status).toBe(403); expect((await call(b.page, '/polls/' + pid + '/close', 'POST')).status).toBe(403); expect((await call(b.page, '/polls/' + pid + '/results')).status).toBe(403);
    await a.page.getByRole('button', { name: 'Close poll' }).click(); await expect(b.page.locator('.pl-card')).toHaveCount(0); await b.page.click('[data-pv=results]'); await expect(b.page.locator('.pl-card')).toContainText('has not published');
    await a.page.click('[data-pv=results]'); await expect(a.page.locator('.pl-bar')).toHaveCount(3); await a.page.getByRole('button', { name: 'Publish results to everyone' }).click();
    await expect(b.page.locator('.pl-bar')).toHaveCount(3); await expect(b.page.locator('.pl-card')).toContainText('1 response'); await expect(b.page.locator('.pl-row', { hasText: 'AI meeting notes' })).toContainText('1 (100%)');
    expect((await call(b.page, '/polls/' + pid + '/votes', 'POST', { choices: [0] })).status).toBe(409);                                                                 // closed
    for (const p of [a, b]) await p.ctx.close();
  });

  test('every poll type validates on the server; anonymous ballots are not tied to names; quiz feedback; drafts are private; timed polls close by themselves; CSV export is host-only and safe', async ({ browser }) => {
    test.setTimeout(150000);
    const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code); const mk = async (o) => (await call(a.page, '/polls', 'POST', { launch: true, ...o })).body;
    // bad definitions
    expect((await call(a.page, '/polls', 'POST', { question: '', kind: 'single', options: ['a', 'b'] })).status).toBe(400); expect((await call(a.page, '/polls', 'POST', { question: 'q', kind: 'single', options: ['a'] })).status).toBe(400); expect((await call(a.page, '/polls', 'POST', { question: 'q', kind: 'single', options: ['a', 'A'] })).status).toBe(400);
    expect((await call(a.page, '/polls', 'POST', { question: 'q', kind: 'rating', scale: 7 })).status).toBe(400); expect((await call(a.page, '/polls', 'POST', { question: 'q', kind: 'single', options: ['a', 'b'], quiz: true })).status).toBe(400);
    // types and ballots
    const multi = await mk({ question: 'Pick some', kind: 'multiple', options: ['a', 'b', 'c'] }); expect((await call(b.page, '/polls/' + multi.id + '/votes', 'POST', { choices: [0, 0] })).status).toBe(400); expect((await call(b.page, '/polls/' + multi.id + '/votes', 'POST', { choices: [] })).status).toBe(400); expect((await call(b.page, '/polls/' + multi.id + '/votes', 'POST', { choices: [0, 2] })).status).toBe(201);
    const yn = await mk({ question: 'Agree?', kind: 'yesno' }); expect(yn.options).toEqual(['Yes', 'No']); expect((await call(b.page, '/polls/' + yn.id + '/votes', 'POST', { choices: [0] })).status).toBe(201);
    const rate = await mk({ question: 'Rate it', kind: 'rating', scale: 5, liveResults: true }); expect((await call(b.page, '/polls/' + rate.id + '/votes', 'POST', { choices: [6] })).status).toBe(400); expect((await call(b.page, '/polls/' + rate.id + '/votes', 'POST', { choices: [4] })).status).toBe(201); expect((await call(a.page, '/polls/' + rate.id + '/votes', 'POST', { choices: [2] })).status).toBe(201);
    expect((await call(b.page, '/polls/' + rate.id + '/results')).body.results.average).toBe(3);                                                                            // live results allowed for this poll
    const rank = await mk({ question: 'Rank', kind: 'ranking', options: ['x', 'y', 'z'] }); expect((await call(b.page, '/polls/' + rank.id + '/votes', 'POST', { choices: [0, 1] })).status).toBe(400); expect((await call(b.page, '/polls/' + rank.id + '/votes', 'POST', { choices: [2, 0, 1] })).status).toBe(201);
    // quiz: voter learns right/wrong; correct answers are not leaked while open
    const quiz = await mk({ question: '2+2?', kind: 'single', options: ['3', '4', '5'], quiz: true, correct: [1], explanation: 'Basic maths' }); const lst = (await call(b.page, '/polls')).body.polls.find((p) => p.id === quiz.id); expect(lst.correct).toBeUndefined(); expect(lst.quiz).toBe(true);
    expect((await call(b.page, '/polls/' + quiz.id + '/votes', 'POST', { choices: [1] })).body.correct).toBe(true);
    // anonymous vs named ballots in the export
    const anon = await mk({ question: 'Anon?', kind: 'single', options: ['yes', 'no'], anonymous: true }); await call(b.page, '/polls/' + anon.id + '/votes', 'POST', { choices: [0] });
    const named = await mk({ question: '=cmd()', kind: 'single', options: ['yes', 'no'] }); await call(b.page, '/polls/' + named.id + '/votes', 'POST', { choices: [1] });
    const csvAnon = (await call(a.page, '/polls/' + anon.id + '/export.csv')).text; expect(csvAnon).toContain('Responses,1'); expect(csvAnon).not.toContain('Bob'); expect(csvAnon).toContain('Anonymous poll');
    const csvNamed = (await call(a.page, '/polls/' + named.id + '/export.csv')).text; expect(csvNamed).toContain('Bob,no'); expect(csvNamed).toContain("'=cmd()"); expect((await call(b.page, '/polls/' + named.id + '/export.csv')).status).toBe(403);
    // drafts are invisible to guests and cannot be voted on; only drafts can be deleted
    const draft = await call(a.page, '/polls', 'POST', { question: 'Later', kind: 'yesno' }); expect(draft.body.status).toBe('draft'); expect((await call(b.page, '/polls')).body.polls.map((p) => p.id)).not.toContain(draft.body.id); expect((await call(b.page, '/polls/' + draft.body.id + '/votes', 'POST', { choices: [0] })).status).toBe(404);
    expect((await call(a.page, '/polls/' + yn.id, 'DELETE')).status).toBe(409); expect((await call(a.page, '/polls/' + draft.body.id, 'DELETE')).status).toBe(200);
    // timed poll closes by itself
    const timed = await mk({ question: 'Quick', kind: 'yesno', durationSec: 15 }); expect(timed.closesAt).toBeTruthy(); await expect.poll(async () => (await call(b.page, '/polls')).body.polls.find((p) => p.id === timed.id).status, { timeout: 40000, intervals: [2000] }).toBe('closed');
    expect((await call(b.page, '/polls/' + timed.id + '/votes', 'POST', { choices: [0] })).status).toBe(409);
    for (const p of [a, b]) await p.ctx.close();
  });

  test('the poll form works by keyboard and shows only the fields the chosen type needs', async ({ browser }) => {
    const a = await open(browser, 'Alice'); await tab(a.page, 'polls'); await a.page.click('#pollNew'); await expect(a.page.locator('#po')).toBeVisible(); await expect(a.page.locator('#ps')).toBeHidden();
    await a.page.selectOption('#pk', 'rating'); await expect(a.page.locator('#po')).toBeHidden(); await expect(a.page.locator('#ps')).toBeVisible(); await a.page.selectOption('#pk', 'single'); await a.page.check('#pz'); await expect(a.page.locator('#pc')).toBeVisible();
    await a.page.fill('#pq', 'Which one?'); await a.page.fill('#po', 'one\ntwo'); await a.page.fill('#pc', '2'); await a.page.getByRole('button', { name: 'Save draft' }).click(); await a.page.click('[data-pv=drafts]'); await expect(a.page.locator('.pl-card')).toContainText('Which one?'); await expect(a.page.locator('.pl-card .chip')).toHaveText('Draft');
    await a.page.getByRole('button', { name: 'Launch', exact: true }).click(); await a.page.click('[data-pv=active]'); await expect(a.page.locator('.pl-card .chip')).toHaveText('Open'); await a.ctx.close();
  });
});

test.describe('Qorlla Meet More tab', () => {
  test('tools are grouped in expandable sections; unavailable tools are labelled, not faked; real tools work', async ({ browser }) => {
    const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code); await tab(a.page, 'more'); await tab(b.page, 'more');
    const heads = a.page.locator('.mg-h'); await expect(heads).toHaveText([/Collaboration/, /Meeting intelligence/, /Meeting management/, /Security and recording/, /Tools and settings/]);
    await expect(heads.first()).toHaveAttribute('aria-expanded', 'true'); await expect(a.page.locator('#mg-intel')).toBeHidden(); await heads.nth(1).click(); await expect(heads.nth(1)).toHaveAttribute('aria-expanded', 'true'); await expect(a.page.locator('#mg-intel')).toBeVisible(); await heads.first().click(); await expect(a.page.locator('#mg-collab')).toBeHidden();
    await heads.first().click(); await expect(a.page.locator('#mg-collab button:disabled')).toHaveCount(4); await expect(a.page.locator('#mg-collab')).toContainText('Planned for v4.1');
    await a.page.getByRole('button', { name: 'React with 🎉' }).click(); await expect(b.page.locator('#toast')).toContainText('🎉');
    await heads.nth(3).click(); await a.page.getByRole('button', { name: 'Recording and consent…' }).click(); await expect(a.page.locator('#rcModal')).toContainText('Request to record'); await a.page.keyboard.press('Escape');
    await b.page.locator('.mg-h').nth(3).click(); await expect(b.page.locator('#mg-sec')).toContainText('About recording'); await b.page.locator('.mg-h').nth(4).click(); await b.page.getByRole('button', { name: 'Settings and keyboard shortcuts' }).last().click(); await expect(b.page.locator('#rcModal')).toContainText('Settings and keyboard shortcuts');
    for (const p of [a, b]) await p.ctx.close();
  });
});
