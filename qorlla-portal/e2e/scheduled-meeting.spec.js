const { test, expect: baseExpect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { io } = require('socket.io-client');
const { BASE, dbq, signUpWithWorkspace } = require('./helpers');
const expect = baseExpect.configure({ timeout: 60000 });          // this scenario runs on a shared Windows host whose CPU is often saturated by unrelated services (OneDrive, antivirus, WSL): waits are generous, assertions are not weakened

// FULL SCHEDULED-MEETING SEQUENCE on the isolated stack, with every real component: the main app's scheduling route, the PostgreSQL sync worker, Meet (real server, real database, real socket),
// Workplace's portal UI in a browser, the portal's REAL AI worker, and both databases. Synthetic people and chat only; the model is the labelled deterministic TEST ADAPTER (needs E2E_AI_TEST_PROVIDER=1).
//
// Who is real: the host enters Meet in a browser through the same URL-fragment hand-off the real launch uses; the portal is driven through its own pages. The four participants are real Meet sessions
// (joined through the proxy, held in the waiting room, admitted by the host, answering consent and chatting over Meet's real API and socket) rather than four more browsers: the consent PROMPTS are
// verified in a real browser by e2e/meet-ai-consent.spec.js, and six browsers saturate the shared test machine. Harness stand-in, stated plainly: in this topology the main app's direct hand-off to
// Meet is switched off (the sync worker owns the host credential), so the host credential is read back from the sync worker's vault inside its own container.
const MEET = '/meet/', PROJECT = process.env.E2E_COMPOSE_PROJECT || 'qiso', API = `${BASE}${MEET}api`;
const sh = (args, o = {}) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000, ...o }).trim();
const meetSql = (sql) => sh(['exec', PROJECT + '-meet-db-1', 'psql', '-U', 'qorlla', '-d', 'qorlla_meet', '-tAc', sql]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { ms = 180000, every = 1000, what = 'condition' } = {}) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await sleep(every); } }
const hostSecretOf = (sourceId) => sh(['exec', PROJECT + '-meet-sync-worker-1', 'node', '--input-type=module', '-e', `import pg from 'pg'; import { openHostSecret } from '/usr/src/app/meet-sync/src/store.mjs'; const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); process.stdout.write(String(await openHostSecret(pool, ${JSON.stringify(sourceId)}))); await pool.end();`]);
const needsAi = () => test.skip(!process.env.E2E_AI_TEST_PROVIDER, 'needs the AI test project (E2E_AI_TEST_PROVIDER=1)');
const EVIDENCE = { steps: {} };

async function meetApi(path, method = 'GET', body, token) { const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90000) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }
/** A real Meet participant session: joins through the proxy exactly as the page does (name + meeting code). */
async function joinAs(name, code) { const j = await meetApi(`/meetings/${code}/join`, 'POST', { name }); expect(j.status).toBe(200); return { name, token: j.body.token, pid: j.body.participantId, meetingId: j.body.meetingId, admission: j.body.admission, events: [] }; }
async function connectSocket(g) {
  g.socket = io(BASE, { path: MEET + 'socket.io', auth: { token: g.token }, transports: ['websocket'], reconnection: false }); g.socket.on('ai-consent-request', (p) => g.events.push(p));
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('socket connect timeout for ' + g.name)), 90000); g.socket.on('connect', () => { clearTimeout(t); res(); }); g.socket.on('connect_error', (e) => { clearTimeout(t); rej(e); }); });
}
const say = (g, text) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('chat ack timeout')), 60000); g.socket.emit('chat', text, (a) => { clearTimeout(t); a && a.ok ? res() : rej(new Error('chat refused')); }); });
const answer = (g, purpose, decision) => meetApi(`/v1/meetings/${g.meetingId}/ai-consent`, 'POST', { purpose, decision }, g.token);
async function admitAll(host, guests) {
  if (guests.some((g) => g.admission === 'waiting')) expect((await meetApi(`/meetings/${host.meetingId}/admit`, 'POST', { all: true, allow: true }, host.token)).status).toBe(200);
  for (const g of guests) await until(async () => (await meetApi(`/meetings/${g.meetingId}/admission`, 'GET', null, g.token)).body.status === 'admitted', { what: g.name + ' to be admitted' });
  for (const g of guests) await connectSocket(g);
}
const auditSnapshot = (ws, meeting) => dbq(`select coalesce(json_agg(json_build_object('id',id,'event',event,'at',at,'detail',detail) order by id),'[]') from portal.meeting_ai_consent_audit where workspace_id='${ws}' and meet_meeting_id='${meeting}'`);

test.describe('scheduled meeting: consent, real worker, citations, revocation, crash recovery', () => {
  test.describe.configure({ mode: 'serial' });
  let me, m = {}, host = {}, people = {}, rid1, jobs = {}, hostCtx, portal;
  // ONE browser context for the host across the whole serial scenario (Playwright closes per-test fixtures, and the host must stay signed in)
  test.beforeAll(async ({ browser }) => { hostCtx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE, permissions: [], viewport: { width: 1280, height: 800 } }); portal = await hostCtx.newPage(); portal.on('dialog', (d) => d.accept()); });
  test.afterAll(async () => { for (const g of Object.values(people)) g.socket?.close(); await hostCtx?.close().catch(() => {}); });      // always: a failed step must not leave anything open

  test('1 schedule through the normal route and start it: sync worker registers it, the portal sees it, the host enters Meet with the real hand-off', async () => {
    needsAi(); test.setTimeout(900000); const context = hostCtx; me = await signUpWithWorkspace(context, 'sched'); const title = 'Scheduled AI review ' + Date.now();
    const sch = await context.request.post('/api/workplace/schedule', { data: { title, date: new Date().toISOString().slice(0, 10), time: '23:50', duration: 30 }, headers: { origin: BASE, 'x-csrf-token': me.csrf } }); expect(sch.status()).toBeLessThan(300);
    const row = await until(() => { const r = dbq(`select source_id||'|'||coalesce(meet_uuid::text,'')||'|'||coalesce(meet_code,'')||'|'||status||'|'||coalesce(owner_user_id::text,'') from qorlla_schedules where title='${title}'`); return r.split('|')[3] === 'synced' && r.split('|')[1] ? r : null; }, { what: 'the sync worker to register the meeting with Meet' });
    const [sourceId, uuid, code, , owner] = row.split('|'); m = { title, sourceId, uuid, code, owner }; expect(owner).toBeTruthy();
    expect(dbq(`select count(*) from public.portal_meeting_directory where meet_uuid='${uuid}' and owner_user_id='${owner}'`)).toBe('1');
    const listed = await context.request.get('/api/v1/meeting-ai/meetings', { headers: { origin: BASE, 'x-workspace-id': me.workspaceId } }); expect((await listed.json()).some((x) => x.meet_uuid === uuid && x.i_am_host)).toBe(true);
    meetSql(`update meetings set waiting_room=true where id='${uuid}'`);                                 // admission settings are pushed to Meet by the real launch; here the harness sets the same switch
    const secret = hostSecretOf(sourceId); expect(secret.length).toBeGreaterThan(20);
    const jr = await meetApi(`/meetings/${code}/join`, 'POST', { name: 'Hanna Host', hostSecret: secret }); expect(jr.status).toBe(200); expect(jr.body.admission).toBe('admitted'); host = { token: jr.body.token, pid: jr.body.participantId, meetingId: jr.body.meetingId };
    const page = await hostCtx.newPage(); const qs = Buffer.from(JSON.stringify({ token: host.token, meetingId: host.meetingId, participantId: host.pid })).toString('base64url'); await page.goto(`${MEET}#qs=${qs}`);          // the real hand-off: the session in the URL fragment
    await page.waitForSelector('#app:not(.hidden)', { timeout: 180000 }); await expect(page.locator('#status')).toContainText('Connected'); expect(meetSql(`select role from participants where id='${host.pid}'`)).toBe('host');
    expect(meetSql(`select count(*) from external_meeting_links where meeting_id='${uuid}'`)).toBe('1'); EVIDENCE.steps.scheduled = { sourceId, meetUuid: uuid, syncedBy: 'sync-worker', hostAdmission: jr.body.admission };
  });

  test('2 participants wait in the waiting room and are admitted by the host; the host opens the AI consent request; transcription and summary are answered SEPARATELY; a late joiner and a same-name impostor stay unanswered', async () => {
    needsAi(); test.setTimeout(900000);
    people.dana = await joinAs('Dana', m.code); people.sam = await joinAs('Sam', m.code); expect([people.dana.admission, people.sam.admission]).toEqual(['waiting', 'waiting']);
    await admitAll(host, [people.dana, people.sam]); expect(meetSql(`select count(*) from participants where meeting_id='${m.uuid}' and admission='admitted' and role='guest'`)).toBe('2');
    const req = await meetApi(`/v1/meetings/${m.uuid}/ai-consent/request`, 'POST', {}, host.token); expect(req.status).toBe(201);
    await until(() => people.dana.events.length === 1 && people.sam.events.length === 1, { what: 'the live consent prompt to reach everyone present' });
    expect((await answer(people.dana, 'transcription', 'agree')).status).toBe(201); expect((await answer(people.dana, 'summary', 'agree')).status).toBe(201);
    expect((await answer(people.sam, 'transcription', 'agree')).status).toBe(201); expect((await answer(people.sam, 'summary', 'decline')).status).toBe(201);                       // a SEPARATE answer for each purpose
    people.lee = await joinAs('Lee', m.code); people.imp = await joinAs('Dana', m.code); await admitAll(host, [people.lee, people.imp]);                                             // late joiners; the second "Dana" is a different person
    await until(() => people.lee.events.length === 1 && people.imp.events.length === 1, { what: 'late joiners to be asked on arrival' }); expect(people.lee.events[0].late).toBe(true);
    const d = (k, purpose) => meetSql(`select decision from ai_consents where meeting_id='${m.uuid}' and participant_id='${people[k].pid}' and purpose='${purpose}' order by seq desc limit 1`);
    expect([d('dana', 'transcription'), d('dana', 'summary'), d('sam', 'transcription'), d('sam', 'summary'), d('lee', 'summary'), d('imp', 'summary')]).toEqual(['agree', 'agree', 'agree', 'decline', '', '']);
    expect(meetSql(`select count(*) from recording_consents where meeting_id='${m.uuid}'`)).toBe('0'); expect(meetSql(`select count(*) from recording_sessions where meeting_id='${m.uuid}'`)).toBe('0');         // recording was never asked and never answered
    EVIDENCE.steps.consent = { participants: Object.keys(people).length, answers: { dana: 'agree/agree', sam: 'agree/decline', lee: 'pending', impostorSameName: 'pending' }, promptsDeliveredLive: 4 };
  });

  test('3 everyone chats; Workplace host consent and the report job go through the real portal UI and the real worker', async () => {
    needsAi(); test.setTimeout(900000); const page = portal;
    await say(people.dana, 'We decided to ship the release on Monday morning. ACTION: Dana to order stickers by Wednesday'); await say(people.sam, 'SECRET-SAM I only agreed to transcription'); await say(people.lee, 'SECRET-LEE I have not answered yet'); await say(people.imp, 'SECRET-IMPOSTOR I am also called Dana');
    await until(() => meetSql(`select count(*) from messages where meeting_id='${m.uuid}'`) === '4', { what: 'four chat messages' });
    await page.goto('/app/ai'); const row = page.locator(`tr[data-meeting="${m.uuid}"]`); await expect(row).toBeVisible(); await row.getByRole('button', { name: 'Give consent…' }).click(); await page.locator('#consent-ok').check(); await page.locator('#consent-go').click(); await expect(page.locator('#notice')).toContainText('Consent recorded');
    await expect(row.getByRole('button', { name: 'Summarize meeting chat' })).toBeVisible(); await row.getByRole('button', { name: 'Summarize meeting chat' }).click(); await expect(page.locator('#notice')).toContainText('Reading the meeting chat');
    const jobId = await until(() => dbq(`select id from portal.meeting_ai_jobs where meet_meeting_id='${m.uuid}' order by created_at desc limit 1`), { what: 'a job row' }); jobs.one = jobId;
    await until(() => ['completed', 'failed', 'blocked', 'cancelled'].includes(dbq(`select status from portal.meeting_ai_jobs where id='${jobId}'`)), { ms: 300000, what: 'the real worker to finish the job' }); expect(dbq(`select status from portal.meeting_ai_jobs where id='${jobId}'`)).toBe('completed');
    rid1 = dbq(`select report_id from portal.meeting_ai_jobs where id='${jobId}'`);
    // only the person who agreed to BOTH purposes was used; nobody else's words reached the transcript or the model
    const t = dbq(`select full_text from portal.meeting_transcripts where job_id='${jobId}'`); expect(t).toContain('decided to ship the release'); expect(t).not.toMatch(/SECRET/);
    const rows = Object.fromEntries(dbq(`select string_agg(participant_id||'='||included||':'||coalesce(reason,''), ',') from portal.meeting_ai_job_participants where job_id='${jobId}'`).split(',').map((x) => x.split('=')));
    expect(rows[people.dana.pid]).toBe('true:'); expect(rows[people.sam.pid]).toBe('false:declined'); expect(rows[people.lee.pid]).toBe('false:pending'); expect(rows[people.imp.pid]).toBe('false:pending');
    // the report is bound to Meet's own numbers: the basis holds Dana's agreement numbers exactly as Meet recorded them
    const basis = JSON.parse(dbq(`select consent_basis from portal.meeting_reports where id='${rid1}'`)); const tSeq = meetSql(`select seq from ai_consents where meeting_id='${m.uuid}' and participant_id='${people.dana.pid}' and purpose='transcription' order by seq desc limit 1`), sSeq = meetSql(`select seq from ai_consents where meeting_id='${m.uuid}' and participant_id='${people.dana.pid}' and purpose='summary' order by seq desc limit 1`);
    expect(basis.participants).toEqual([{ id: people.dana.pid, t: Number(tSeq), s: Number(sSeq) }]);
    const ev = dbq(`select string_agg(event, ',' order by id) from portal.meeting_ai_consent_audit where job_id='${jobId}'`).split(','); expect(ev.filter((e) => e === 'job_snapshot').length).toBe(1); expect(ev.filter((e) => e === 'result_published').length).toBe(1);
    expect(dbq(`select count(*) from portal.meeting_reports where job_id='${jobId}'`)).toBe('1'); EVIDENCE.steps.firstReport = { job: jobId, report: rid1, basisParticipants: basis.participants.length, publishedEvents: 1, includedMessages: 1, excludedAuthors: 3 };
  });

  test('4 open citations through the normal portal UI; an import cannot bypass the participant who declined', async () => {
    needsAi(); test.setTimeout(600000); const page = portal, context = hostCtx; await page.goto('/app/ai/reports/' + rid1); await expect(page.locator('body')).toContainText('AI-generated meeting report'); await expect(page.locator('body')).toContainText('TEST-DOUBLE SUMMARY');
    const chip = page.locator('li .cite').first(); await expect(chip).toBeVisible(); await chip.click(); await expect(page.locator('[data-cite-passage]')).toContainText('decided to ship the release on Monday morning'); await expect(page.locator('[data-cite-meta]')).toContainText('Dana'); expect(await page.locator('body').innerText()).not.toMatch(/SECRET/);
    const imp = await context.request.post('/api/v1/meeting-ai/jobs', { data: { meet_meeting_id: m.uuid, source: 'transcript_import', idempotency_key: 'imp-' + Date.now() + '-aaaa', transcript: { format: 'txt', text: 'Dana: pasted transcript' } }, headers: { origin: BASE, 'x-csrf-token': me.csrf, 'x-workspace-id': me.workspaceId } });
    expect(imp.status()).toBe(403); expect((await imp.json()).code).toBe('participant_declined'); expect(dbq(`select count(*) from portal.meeting_transcripts where source='transcript_import' and meet_meeting_id='${m.uuid}'`)).toBe('0');
  });

  test('5 the worker is killed in the middle of a model call; after restart the interrupted job recovers by itself and publishes exactly once', async () => {
    needsAi(); test.setTimeout(1200000); const page = portal; await say(people.dana, 'QORLLA-TEST-SLOW we also decided to hold a retrospective on Friday afternoon');
    await until(() => meetSql(`select count(*) from messages where meeting_id='${m.uuid}'`) === '5', { what: 'the fifth chat message' });
    await page.goto('/app/ai'); const row = page.locator(`tr[data-meeting="${m.uuid}"]`); await row.getByRole('button', { name: 'Summarize meeting chat' }).click();
    const jobId = await until(() => dbq(`select id from portal.meeting_ai_jobs where meet_meeting_id='${m.uuid}' and id<>'${jobs.one}' order by created_at desc limit 1`) || null, { what: 'a second job' }); jobs.two = jobId;
    await until(() => dbq(`select status||':'||stage from portal.meeting_ai_jobs where id='${jobId}'`) === 'running:summarize', { ms: 120000, every: 300, what: 'the job to be inside the model call' }); await sleep(2500);
    const started = sh(['inspect', '--format', '{{.State.StartedAt}}', PROJECT + '-qorlla-portal-1']); const before = dbq(`select attempts||'|'||status||'|'||coalesce(lease_token::text,'') from portal.meeting_ai_jobs where id='${jobId}'`).split('|');
    expect(before[1]).toBe('running'); expect(dbq(`select count(*) from portal.meeting_reports where job_id='${jobId}'`)).toBe('0');
    sh(['kill', PROJECT + '-qorlla-portal-1']); sh(['start', PROJECT + '-qorlla-portal-1']);                 // SIGKILL: a crash, not a tidy shutdown
    await until(() => sh(['inspect', '--format', '{{.State.Health.Status}}', PROJECT + '-qorlla-portal-1']) === 'healthy', { ms: 240000, what: 'the portal to be healthy again' }); sh(['restart', PROJECT + '_proxy']); await sleep(4000);
    const restarted = sh(['inspect', '--format', '{{.State.StartedAt}}', PROJECT + '-qorlla-portal-1']); expect(restarted).not.toBe(started);
    expect(dbq(`select status from portal.meeting_ai_jobs where id='${jobId}'`)).toMatch(/running|queued|completed/);      // the restart itself can take longer than the lease, so recovery may already have happened: all three are valid; what must never happen is a second report
    expect(Number(dbq(`select count(*) from portal.meeting_reports where job_id='${jobId}'`))).toBeLessThanOrEqual(1);
    await until(() => dbq(`select status from portal.meeting_ai_jobs where id='${jobId}'`) === 'completed', { ms: 600000, every: 2000, what: 'the restarted worker to take over the interrupted job (lease expiry, then the model call)' });
    const after = dbq(`select attempts||'|'||status||'|'||coalesce(report_id::text,'') from portal.meeting_ai_jobs where id='${jobId}'`).split('|'); expect(Number(after[0])).toBe(Number(before[0]) + 1);
    expect(dbq(`select count(*) from portal.meeting_reports where job_id='${jobId}'`)).toBe('1'); expect(dbq(`select count(*) from portal.ai_usage_events where job_id='${jobId}' and feature='meeting_report'`)).toBe('1');
    expect(dbq(`select count(*) from portal.meeting_ai_consent_audit where job_id='${jobId}' and event='result_published'`)).toBe('1'); expect(dbq(`select count(*) from portal.meeting_transcripts where job_id='${jobId}'`)).toBe('1'); expect(dbq(`select count(*) from portal.meeting_ai_jobs where meet_meeting_id='${m.uuid}' and status in ('queued','running')`)).toBe('0');
    EVIDENCE.steps.crashRecovery = { job: jobId, killedWith: 'SIGKILL', portalStartedBefore: started, portalStartedAfter: restarted, attemptsBefore: Number(before[0]), attemptsAfter: Number(after[0]), reportsForJob: 1, usageEventsForJob: 1, publishedEventsForJob: 1 };
  });

  test('6 a participant withdraws in Meet: both published reports and their citations become inaccessible everywhere, and audit history is only ever appended to', async () => {
    needsAi(); test.setTimeout(900000); const page = portal, context = hostCtx; const rid2 = dbq(`select report_id from portal.meeting_ai_jobs where id='${jobs.two}'`);
    const cite = (await (await context.request.get(`/api/v1/meeting-ai/reports/${rid2}`, { headers: { 'x-workspace-id': me.workspaceId } })).json()).citations.decisions.flat()[0].ref;
    const before = JSON.parse(auditSnapshot(me.workspaceId, m.uuid)); expect((await (await context.request.get(`/api/v1/meeting-ai/reports/${rid2}`, { headers: { 'x-workspace-id': me.workspaceId } })).json()).status).toBe('final');
    expect((await answer(people.dana, 'summary', 'withdraw')).status).toBe(201); expect(meetSql(`select decision from ai_consents where meeting_id='${m.uuid}' and participant_id='${people.dana.pid}' and purpose='summary' order by seq desc limit 1`)).toBe('withdraw');
    await page.goto('/app/ai/reports/' + rid1); await expect(page.locator('body')).toContainText('Consent for this meeting was revoked'); await expect(page.locator('body')).not.toContainText('TEST-DOUBLE SUMMARY');
    for (const rid of [rid1, rid2]) { const r = await (await context.request.get(`/api/v1/meeting-ai/reports/${rid}`, { headers: { 'x-workspace-id': me.workspaceId } })).json(); expect(r.status).toBe('withdrawn'); expect(JSON.stringify(r)).not.toMatch(/ship the release|TEST-DOUBLE/); expect(dbq(`select summary||'|'||(select count(*) from portal.meeting_action_items where report_id='${rid}') from portal.meeting_reports where id='${rid}'`)).toBe('|0'); }
    const c = await context.request.get('/api/v1/ai/citations/' + encodeURIComponent(cite), { headers: { 'x-workspace-id': me.workspaceId } }); expect([403, 410]).toContain(c.status()); expect(await c.text()).not.toMatch(/ship the release|retrospective/);
    expect(dbq(`select count(*) from portal.meeting_transcripts where meet_meeting_id='${m.uuid}' and (full_text<>'' or purged_at is null)`)).toBe('0');
    await page.goto('/app/ai'); await expect(page.locator('body')).toContainText('Withdrawn after consent was revoked');
    const after = JSON.parse(auditSnapshot(me.workspaceId, m.uuid)); expect(after.slice(0, before.length)).toEqual(before); expect(after.length).toBeGreaterThan(before.length); expect(after.filter((e) => e.event === 'report_withdrawn').length).toBe(2);
    expect(JSON.stringify(after)).not.toMatch(/SECRET|ship the release|stickers|Dana/);
    EVIDENCE.steps.participantWithdrawal = { reportsWithdrawn: 2, auditRowsBefore: before.length, auditRowsAfter: after.length, earlierRowsUnchanged: true };
  });

  test('7 the host revokes Workplace consent from the UI: a fresh report is withdrawn, its citations are refused, and no further job or retry is accepted', async () => {
    needsAi(); test.setTimeout(900000); const page = portal, context = hostCtx; expect((await answer(people.dana, 'summary', 'agree')).status).toBe(201);      // a NEW agreement, with a new number
    await page.goto('/app/ai'); const row = page.locator(`tr[data-meeting="${m.uuid}"]`); await row.getByRole('button', { name: 'Summarize meeting chat' }).click();
    const jobId = await until(() => dbq(`select id from portal.meeting_ai_jobs where meet_meeting_id='${m.uuid}' and id not in ('${jobs.one}','${jobs.two}') order by created_at desc limit 1`) || null, { what: 'a third job' });
    await until(() => dbq(`select status from portal.meeting_ai_jobs where id='${jobId}'`) === 'completed', { ms: 600000, every: 2000, what: 'the third job' }); const rid3 = dbq(`select report_id from portal.meeting_ai_jobs where id='${jobId}'`);
    await page.goto('/app/ai/reports/' + rid3); const cite = page.locator('li .cite').first(); await expect(cite).toBeVisible(); await cite.click(); await expect(page.locator('[data-cite-passage]')).toContainText('Dana');
    const ref = await cite.getAttribute('data-cite'); await page.goto('/app/ai'); await row.getByRole('button', { name: 'Revoke consent' }).click(); await expect(page.locator('#notice')).toContainText('Consent revoked');
    expect(dbq(`select status from portal.meeting_reports where id='${rid3}'`)).toBe('withdrawn'); const c = await context.request.get('/api/v1/ai/citations/' + encodeURIComponent(ref), { headers: { 'x-workspace-id': me.workspaceId } }); expect([403, 410]).toContain(c.status());
    const again = await context.request.post('/api/v1/meeting-ai/jobs', { data: { meet_meeting_id: m.uuid, source: 'meet_chat', idempotency_key: 'again-' + Date.now() + '-bbbb' }, headers: { origin: BASE, 'x-csrf-token': me.csrf, 'x-workspace-id': me.workspaceId } }); expect(again.status()).toBe(403); expect((await again.json()).code).toBe('consent_required');
    const retry = await context.request.post(`/api/v1/meeting-ai/jobs/${jobId}/retry`, { data: {}, headers: { origin: BASE, 'x-csrf-token': me.csrf, 'x-workspace-id': me.workspaceId } }); expect([403, 409]).toContain(retry.status());          // 403: the host's consent is no longer active (checked first); 409: not a retryable job. Either way: refused
    EVIDENCE.steps.hostRevocation = { report: rid3, withdrawn: true, newJob: again.status(), retry: retry.status() };
    const out = process.env.E2E_EVIDENCE_FILE; if (out) fs.writeFileSync(out, JSON.stringify({ ...EVIDENCE, stack: PROJECT, finishedAt: new Date().toISOString() }, null, 2));
  });
});
