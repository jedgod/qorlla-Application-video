const { test, expect } = require('@playwright/test');
const { BASE, dbq, signUp, signUpWithWorkspace, fakeJson } = require('./helpers');

// Full meeting -> report journey on the REAL stack: MAIN schedules the meeting, Meet hosts it and stores the chat, the portal reads that
// chat (read-only) and the report worker builds the report. The only stand-in is the language model itself (labelled TEST DOUBLE).
const csrfOf = async (ctx) => (await ctx.cookies()).find((c) => c.name === 'qorlla_csrf').value;

async function scheduleMeeting(ctx, title) {
  const r = await ctx.request.post('/api/workplace/schedule', { data: { title, date: '2026-12-20', time: '10:00', duration: 30 } });
  expect(r.status()).toBe(201);
  const id = (await r.json()).id;
  let item;
  for (let i = 0; i < 60 && !(item && item.syncStatus === 'synced' && item.meetCode); i++) { await new Promise((x) => setTimeout(x, 1000)); item = (await (await ctx.request.get('/api/workplace/schedule')).json()).find((s) => s.id === id); }
  expect(item && item.syncStatus, 'the schedule must sync to Meet').toBe('synced');
  const resolved = await (await ctx.request.get('/meet/api/resolve/' + item.meetCode)).json();
  return { code: item.meetCode, uuid: resolved.meetingId };
}
async function joinAndChat(browser, code, name, lines) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE, permissions: ['camera', 'microphone'] }); const p = await ctx.newPage();
  await p.goto('/meet/'); await p.fill('#displayName', name); await p.fill('#meetingId', code); await p.click('#joinBtn'); await p.waitForSelector('#app:not(.hidden)');
  await expect(p.locator('#status')).toContainText('Connected');
  for (const l of lines) { await p.fill('#chatText', l); await p.press('#chatText', 'Enter'); await expect(p.locator('#messages')).toContainText(l.slice(0, 20)); }
  return { ctx, page: p };
}

test.describe('AI Meeting Intelligence - meeting to report in the browser', () => {
  test('host consents, builds a report from the real Meet chat, assigns work, shares, exports, and revokes - with permissions enforced throughout', async ({ browser, page, context }) => {
    const host = await signUpWithWorkspace(context, 'aihost');
    // a second account that will be a workspace member (assignee) and a third that never joins
    const ctxX = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE }); const x = await signUpWithWorkspace(ctxX, 'assignee');
    const memberUuid = x.user.id.replace(/^u_/, '');
    const add = await context.request.post('/api/v1/members', { data: { user_id: memberUuid, role: 'member' }, headers: { 'x-csrf-token': await csrfOf(context), origin: BASE, 'x-workspace-id': host.workspaceId } }); expect(add.status()).toBe(201);
    dbq(`DELETE FROM portal.members WHERE user_id='${memberUuid}' AND workspace_id<>'${host.workspaceId}'`);       // the assignee works inside the host's workspace only

    const meeting = await scheduleMeeting(context, 'Launch review (e2e)');
    const dana = await joinAndChat(browser, meeting.code, 'Dana', ['Welcome. We decided to ship on Monday.']);
    const sam = await joinAndChat(browser, meeting.code, 'Sam', ['ACTION: Dana to send the release notes by Friday']);
    await dana.ctx.close(); await sam.ctx.close();

    // ---- dashboard: the meeting is offered; nothing happens without consent
    await page.goto('/app/ai');
    const row = page.locator('tr[data-meeting="' + meeting.uuid + '"]');
    await expect(row).toContainText('Launch review (e2e)');
    await expect(row.getByRole('button', { name: 'Summarize meeting chat' })).toHaveCount(0);
    expect(dbq(`SELECT count(*) FROM portal.meeting_ai_jobs WHERE meet_meeting_id='${meeting.uuid}'`)).toBe('0');
    await row.getByRole('button', { name: /Give consent/ }).click();
    await expect(page.locator('#consent-go')).toBeDisabled(); await page.locator('#consent-ok').check(); await page.locator('#consent-go').click();
    await expect(row).toContainText('active');

    // ---- build the report from the real chat
    await row.getByRole('button', { name: 'Summarize meeting chat' }).click();
    await expect(row.getByRole('link', { name: 'Open report' })).toBeVisible({ timeout: 60000 });
    expect(dbq(`SELECT source FROM portal.meeting_transcripts WHERE meet_meeting_id='${meeting.uuid}'`)).toBe('meet_chat');
    await row.getByRole('link', { name: 'Open report' }).click();
    await expect(page.getByRole('heading', { name: /Launch review/ })).toBeVisible();
    await expect(page.locator('body')).toContainText('TEST-DOUBLE SUMMARY'); await expect(page.locator('body')).toContainText('Dana, Sam');
    await expect(page.locator('body')).toContainText('ship on Monday'); await expect(page.locator('body')).toContainText('send the release notes');
    await expect(page.locator('body')).toContainText('AI can make mistakes');
    const reportId = page.url().split('/').pop();

    // ---- action item: assign + due date (people decide, the AI only suggested)
    const item = page.locator('tr[data-item]').first();
    await expect(item.locator('[data-f=owner]')).toHaveValue('');
    await item.locator('[data-f=owner]').selectOption(memberUuid); await expect(page.locator('#notice')).toContainText('Saved');
    await item.locator('[data-f=due]').fill('2026-12-31'); await expect(page.locator('#notice')).toContainText('Saved');
    expect(dbq(`SELECT owner_id||'|'||to_char(due_at,'YYYY') FROM portal.meeting_action_items WHERE report_id='${reportId}'`)).toBe(memberUuid + '|2026');

    // ---- the assignee sees only their item, not the summary, and cannot see the transcript
    const px = await ctxX.newPage(); await px.goto('/app/ai/reports/' + reportId);
    await expect(px.locator('body')).toContainText('only the action items assigned to you'); await expect(px.locator('body')).not.toContainText('TEST-DOUBLE SUMMARY');
    await px.locator('tr[data-item] [data-f=done]').check(); await expect(px.locator('#notice')).toContainText('Saved');
    expect(dbq(`SELECT status FROM portal.meeting_action_items WHERE report_id='${reportId}'`)).toBe('done');
    expect((await ctxX.request.get(`/api/v1/meeting-ai/reports/${reportId}/transcript`, { headers: { 'x-workspace-id': host.workspaceId } })).status()).toBe(403);
    // ... and a stranger with no relationship to the workspace gets nothing
    const ctxS = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE }); await signUpWithWorkspace(ctxS, 'stranger'); const ps = await ctxS.newPage();
    await ps.goto('/app/ai/reports/' + reportId); await expect(ps.locator('body')).toContainText('does not exist or you do not have access');

    // ---- transcript (manager only) and exports
    await page.reload(); await page.getByRole('button', { name: 'Show transcript' }).click(); await expect(page.locator('.transcript')).toContainText('Dana'); await expect(page.locator('body')).toContainText('not verified');
    const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download PDF' }).click()]);
    const pdfBytes = require('node:fs').readFileSync(await pdf.path()); expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
    const [docx] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download DOCX' }).click()]);
    expect(require('node:fs').readFileSync(await docx.path()).subarray(0, 2).toString()).toBe('PK');

    // ---- secure link sharing and revocation
    await page.locator('#share-kind').selectOption('link'); await page.locator('#share-form button').click();
    await expect(page.locator('#share-url')).toBeVisible(); const link = await page.locator('#share-url').inputValue(); expect(link).toMatch(/\/shared\/report\/[A-Za-z0-9_-]{43}$/);
    const anon = await browser.newContext({ ignoreHTTPSErrors: true }); const pa = await anon.newPage(); await pa.goto(link);
    await expect(pa.locator('body')).toContainText('TEST-DOUBLE SUMMARY'); await expect(pa.locator('body')).not.toContainText('Transcript');
    await page.getByRole('button', { name: 'Revoke' }).first().click(); await expect(page.locator('#notice')).toContainText('Access ended immediately');
    await pa.reload(); await expect(pa.locator('body')).toContainText('This link is not valid');
    await anon.close();

    // ---- usage was accounted once
    expect(dbq(`SELECT count(*) FROM portal.ai_usage_events WHERE workspace_id='${host.workspaceId}' AND feature='meeting_report'`)).toBe('1');

    // ---- revoking consent erases the derived data
    const keepLink = await (async () => { const r = await context.request.post(`/api/v1/meeting-ai/reports/${reportId}/shares`, { data: { kind: 'link' }, headers: { 'x-csrf-token': await csrfOf(context), origin: BASE, 'x-workspace-id': host.workspaceId } }); return (await r.json()).path; })();
    await page.goto('/app/ai'); page.once('dialog', (d) => d.accept()); await page.locator('tr[data-meeting="' + meeting.uuid + '"]').getByRole('button', { name: 'Revoke consent' }).click();
    await expect(page.locator('#notice')).toContainText('Consent revoked');
    expect(dbq(`SELECT status||'|'||(summary='')::text FROM portal.meeting_reports WHERE id='${reportId}'`)).toBe('withdrawn|true');
    expect(dbq(`SELECT (full_text='')::text||'|'||(purged_at IS NOT NULL)::text FROM portal.meeting_transcripts WHERE meet_meeting_id='${meeting.uuid}'`)).toBe('true|true');
    expect(dbq(`SELECT count(*) FROM portal.meeting_action_items WHERE report_id='${reportId}'`)).toBe('0');
    expect((await (await fetch(BASE + keepLink.replace('/shared/report/', '/api/v1/shared/reports/'))).status)).toBe(404);
    await page.goto('/app/ai/reports/' + reportId); await expect(page.locator('body')).toContainText('Consent for this meeting was revoked');
    await ctxX.close(); await ctxS.close();
  });

  test('plan limit: the Basic plan allows 3 AI reports a month and the dashboard explains it', async ({ page, context }) => {
    const u = await signUpWithWorkspace(context, 'freeai'); const meeting = await scheduleMeeting(context, 'Limit check (e2e)');
    await page.goto('/app/ai'); await expect(page.locator('#ai-quota')).toContainText('0 of 3');
    const row = page.locator('tr[data-meeting="' + meeting.uuid + '"]'); await row.getByRole('button', { name: /Give consent/ }).click(); await page.locator('#consent-ok').check(); await page.locator('#consent-go').click();
    for (let i = 0; i < 3; i++) {
      await row.getByRole('button', { name: 'Import transcript…' }).click(); await page.fill('#import-text', `Ann: we decided item ${i}\nBo: ACTION: Ann to do thing ${i}`); await page.getByRole('button', { name: 'Build report' }).click();
      await expect(page.locator('#ai-quota')).toContainText(`${i + 1} of 3`, { timeout: 30000 });
    }
    await row.getByRole('button', { name: 'Import transcript…' }).click(); await page.fill('#import-text', 'Ann: one more'); await page.getByRole('button', { name: 'Build report' }).click();
    await expect(page.locator('#notice')).toContainText('allows 3'); expect(u.workspaceId).toBeTruthy();
  });
});
