import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, addMember, seedMeeting } from './helpers.mjs';
import { startFakeLlm, startFakeMeet, READ_SECRET, pidOf, decisionRow } from './fake-llm.mjs';
import { checkFresh, basisFor, stillConsented } from '../server/ai/meet-consent.mjs';
import { createMeetClient } from '../server/ai/meet-client.mjs';

// THE CONSENT FENCE. Meet and the portal have separate databases, so no check can be atomic with a portal commit. The protocol: every Meet answer is numbered; a report records the numbers of the agreements
// it rests on; every read asks Meet again and shows the report only while nobody included has objected AFTER those numbers; when Meet cannot be asked, nothing is shown. These tests try to break that
// with revocations in the gaps, outages, failed commits, retries and cancellation. Test doubles only (labelled fake model and fake Meet).
const key = () => 'idem-' + crypto.randomBytes(6).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MSGS = [
  { speaker: 'Dana', text: 'We decided to ship the release on Monday morning.', at: '2026-11-01T10:00:00Z' },
  { speaker: 'Sam', text: 'SECRET-SAM ACTION: Dana to order stickers by Wednesday', at: '2026-11-01T10:01:00Z' }
];
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nDana: We decided to hire two engineers.\n';
const SUMMARY = /TEST-DOUBLE SUMMARY/;

describe('pure fence rules', () => {
  const dana = (t, s = t) => ({ participantId: 'p-dana', decisions: decisionRow(t, s) });
  test('objection numbering: a person who objected after their agreement invalidates the basis, even if they agree again; missing or empty bases are never fresh', () => {
    const agreed = dana('agree'); const basis = basisFor({ source: 'meet_chat', rows: [{ participant_id: 'p-dana', transcription_seq: agreed.decisions.transcription.seq, summary_seq: agreed.decisions.summary.seq }], revision: 1 });
    assert.equal(checkFresh({ basis, consent: { participants: [agreed] } }).ok, true);
    const withdrew = { ...agreed, decisions: { ...agreed.decisions, summary: { decision: 'withdraw', seq: agreed.decisions.summary.seq + 50, objectionSeq: agreed.decisions.summary.seq + 50 } } };
    assert.equal(checkFresh({ basis, consent: { participants: [withdrew] } }).reason, 'participant_withdrew');
    const reAgreed = { ...agreed, decisions: { ...agreed.decisions, summary: { decision: 'agree', seq: agreed.decisions.summary.seq + 90, objectionSeq: agreed.decisions.summary.seq + 50 } } };
    assert.equal(checkFresh({ basis, consent: { participants: [reAgreed] } }).ok, false, 'agreeing again does not undo that the content was used before they changed their mind');
    assert.equal(checkFresh({ basis, consent: { participants: [] } }).reason, 'participant_withdrew', 'not reported any more = not covered');
    for (const bad of [null, undefined, {}, { source: 'meet_chat', participants: [] }]) assert.equal(checkFresh({ basis: bad, consent: { participants: [agreed] } }).ok, false);
    assert.equal(checkFresh({ basis, consent: null }).ok, false); assert.equal(checkFresh({ basis, consent: { participants: [agreed] } }).ok, true);
    const impBasis = { v: 1, source: 'transcript_import', revision: 2000 }; assert.equal(checkFresh({ basis: impBasis, consent: { participants: [{ participantId: 'x', decisions: { transcription: { decision: 'withdraw', seq: 2001, objectionSeq: 2001 }, summary: { decision: 'agree', seq: 1, objectionSeq: 0 } } }] } }).ok, false);
    assert.equal(stillConsented({ consent: { requested: false, participants: [agreed] }, rows: [] }).reason, 'request_closed');
  });
  test('the portal client carries identity as participantId only: typed display names never reach a decision', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ requested: true, revision: '77', participants: [{ participantId: 'abc', name: 'Dana', role: 'guest', decisions: { transcription: { decision: 'agree', seq: '5', objectionSeq: '0' }, summary: { decision: 'agree', seq: '6', objectionSeq: '0' } } }] }) });
    const c = await createMeetClient({ baseUrl: 'http://meet', readSecret: 'r'.repeat(40), fetchImpl }).fetchConsent('11111111-1111-1111-1111-111111111111');
    assert.equal(c.revision, 77); assert.equal(c.participants[0].decisions.summary.seq, 6); assert.ok(!('name' in c.participants[0]) && !JSON.stringify(c).includes('Dana'));
    await assert.rejects(createMeetClient({ baseUrl: 'http://meet', readSecret: 'r'.repeat(40), fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ requested: true, participants: [] }) }) }).fetchConsent('11111111-1111-1111-1111-111111111111'), /unreadable/, 'an answer with no order number is unusable');
  });
});

describe('the consent fence (PostgreSQL, fake model, fake Meet)', () => {
  let db, main, llmd, meetd, app, W, H, A, M, meet;
  const host = () => app.client(H); const member = () => app.client(M);
  const q = async (sql, args = []) => (await db.pool.query(sql, args)).rows;
  const consent = () => host().post(`/api/v1/meeting-ai/meetings/${meet}/consents`, { attest: true, notice_version: 'v1' });
  const setC = (id, map, requested = true) => { const mt = meetd.st.meetings.get(id); mt.consent = { requested, participants: Object.entries(map).map(([name, [t, s]]) => ({ participantId: pidOf(name), name, role: 'guest', decisions: decisionRow(t, s ?? t) })) }; };
  const modelCalls = () => llmd.st.requests.length;
  const jobOf = async (id) => (await host().get('/api/v1/meeting-ai/jobs/' + id)).body;
  async function newJob(extra = {}) { const j = await host().post('/api/v1/meeting-ai/jobs', { meet_meeting_id: meet, source: 'meet_chat', idempotency_key: key(), ...extra }); assert.equal(j.status, 202, JSON.stringify(j.body)); return j.body; }
  async function chatJob(extra) { const j = await newJob(extra); await app.ai.worker.runOne(); return jobOf(j.id); }
  async function published() { await consent(); setC(meet, { Dana: ['agree'], Sam: ['agree'] }); const job = await chatJob(); assert.equal(job.status, 'completed', JSON.stringify(job)); return { job, rid: job.report_id }; }
  const reportRow = async (rid) => (await q('SELECT status, summary, decisions, citations, consent_basis FROM portal.meeting_reports WHERE id=$1', [rid]))[0];
  const audit = async () => q('SELECT id, at, event, scope, detail, job_id FROM portal.meeting_ai_consent_audit WHERE workspace_id=$1 AND meet_meeting_id=$2 ORDER BY id', [W, meet]);

  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn(); llmd = await startFakeLlm(); meetd = await startFakeMeet();
    const env = { AI_LLM_API_KEY: 'test-llm-key', AI_LLM_API_BASE: llmd.url, AI_LLM_MODEL: 'claude-test', MEET_INTERNAL_URL: meetd.url, MEET_READ_SECRET: READ_SECRET, QORLLA_AI_RATE_PER_MINUTE: '100000' };
    app = await startApp({ pool: db.pool, cfg: testConfig({ env, cfg: { shareLimit: 1000 } }, main), jwks: main.jwks, ai: { worker: { backoffBaseSeconds: 0 } } });
    H = await main.mint(); A = await main.mint(); M = await main.mint();
    W = await seedWorkspace(db.pool, H.sub, 'Fence Co'); await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='pro',status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [W]);
    await addMember(db.pool, W, A.sub, 'admin'); await addMember(db.pool, W, M.sub, 'member');
  });
  after(async () => { await app.close(); await llmd.close(); await meetd.close(); await main.close(); await db.drop(); });
  beforeEach(async () => {
    await db.pool.query(`UPDATE portal.meeting_ai_jobs SET status='cancelled', error_code='test_cleanup' WHERE status IN ('queued','running','blocked')`); await db.pool.query('DROP TRIGGER IF EXISTS fail_commit ON portal.meeting_reports');
    meet = await seedMeeting(db.pool, H.sub, { title: 'Launch review' }); await fetch(llmd.url + '/__control/reset', { method: 'POST' });
    Object.assign(meetd.st, { down: false, delayMs: 0, onConsent: null, consentReads: 0 }); meetd.st.requests.length = 0; meetd.put(meet, 'Launch review', MSGS);
  });

  describe('a withdrawal AFTER publication closes every way in', () => {
    test('report, transcript, exports, list excerpt, my action items, share links and citations are all refused, nothing is silently restored, and history is only ever appended to', async () => {
      const { rid } = await published(); const before = await host().get('/api/v1/meeting-ai/reports/' + rid); assert.match(before.body.summary, SUMMARY); const cite = before.body.citations.decisions.flat()[0].ref;
      const item = before.body.action_items[0]; assert.equal((await host().patch('/api/v1/meeting-ai/action-items/' + item.id, { owner_id: M.sub })).status, 200);
      const link = (await host().post(`/api/v1/meeting-ai/reports/${rid}/shares`, { kind: 'link', include_transcript: true })).body;
      assert.equal((await fetch(app.base + '/api/v1/shared/reports/' + link.token)).status, 200); assert.equal((await member().get('/api/v1/meeting-ai/action-items')).body.length, 1);
      const rowsBefore = await audit(); assert.ok(rowsBefore.length >= 3);
      setC(meet, { Dana: ['agree'], Sam: ['agree', 'withdraw'] });                                     // Sam withdraws his summary consent: his words are in this report
      const r = await host().get('/api/v1/meeting-ai/reports/' + rid); assert.equal(r.body.status, 'withdrawn'); assert.ok(!r.body.summary && !r.body.decisions); assert.doesNotMatch(JSON.stringify(r.body), /ship the release|SECRET|TEST-DOUBLE/);
      assert.equal((await host().get(`/api/v1/meeting-ai/reports/${rid}/transcript`)).status, 403); assert.notEqual((await host().get(`/api/v1/meeting-ai/reports/${rid}/export.pdf`)).status, 200);
      const list = (await host().get('/api/v1/meeting-ai/reports')).body.find((x) => x.id === rid); assert.equal(list.status, 'withdrawn'); assert.equal(list.excerpt, ''); assert.ok(!('_basis' in list));
      assert.equal((await member().get('/api/v1/meeting-ai/action-items')).body.length, 0); assert.equal((await fetch(app.base + '/api/v1/shared/reports/' + link.token)).status, 404);
      const c = await host().get('/api/v1/ai/citations/' + cite); assert.ok([403, 410].includes(c.status)); assert.doesNotMatch(JSON.stringify(c.body), /ship the release/);
      const row = await reportRow(rid); assert.deepEqual([row.status, row.summary, row.citations], ['withdrawn', '', {}]); assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_action_items WHERE report_id=$1', [rid]))[0].n, 0);
      assert.equal((await q('SELECT full_text FROM portal.meeting_transcripts WHERE id=(SELECT transcript_id FROM portal.meeting_reports WHERE id=$1)', [rid]))[0].full_text, '');
      setC(meet, { Dana: ['agree'], Sam: ['agree'] }); assert.equal((await host().get('/api/v1/meeting-ai/reports/' + rid)).body.status, 'withdrawn', 'he agreeing again later does not bring this report back');
      const after = await audit(); assert.deepEqual(after.slice(0, rowsBefore.length), rowsBefore, 'every earlier audit row is untouched'); assert.ok(after.some((x) => x.event === 'report_withdrawn' && x.detail.reason === 'participant_withdrew' && x.detail.report_id === rid));
      await assert.rejects(db.pool.query("UPDATE portal.meeting_ai_consent_audit SET detail='{}'"), /append-only/); await assert.rejects(db.pool.query('DELETE FROM portal.meeting_ai_consent_audit'), /append-only/);
    });
    test('a withdrawal by someone NOT in the report changes nothing, and nobody can read it through another person\'s withdrawal', async () => {
      const { rid } = await published(); setC(meet, { Dana: ['agree'], Sam: ['agree'], Lee: ['agree', 'withdraw'] });        // Lee never took part in this report
      assert.match((await host().get('/api/v1/meeting-ai/reports/' + rid)).body.summary, SUMMARY);
    });
    test('Meet unreachable: nothing is shown anywhere (503, no content), deleting still works, and when Meet is back the report is shown again', async () => {
      const { rid } = await published(); const cite = (await host().get('/api/v1/meeting-ai/reports/' + rid)).body.citations.decisions.flat()[0].ref; const link = (await host().post(`/api/v1/meeting-ai/reports/${rid}/shares`, { kind: 'link' })).body;
      meetd.st.down = true;
      const r = await host().get('/api/v1/meeting-ai/reports/' + rid); assert.equal(r.status, 503); assert.equal(r.body.code, 'consent_unverifiable'); assert.doesNotMatch(JSON.stringify(r.body), /ship the release|TEST-DOUBLE/);
      assert.equal((await host().get(`/api/v1/meeting-ai/reports/${rid}/transcript`)).status, 503); const list = (await host().get('/api/v1/meeting-ai/reports')).body.find((x) => x.id === rid); assert.equal(list.excerpt, null); assert.equal(list.consent_unverified, true);
      assert.equal((await fetch(app.base + '/api/v1/shared/reports/' + link.token)).status, 404); assert.equal((await host().get('/api/v1/ai/citations/' + cite)).status, 503);
      assert.equal((await reportRow(rid)).status, 'final', 'an outage does not withdraw anything: it only refuses to show');
      meetd.st.down = false; assert.match((await host().get('/api/v1/meeting-ai/reports/' + rid)).body.summary, SUMMARY);
      meetd.st.down = true; assert.equal((await host().del('/api/v1/meeting-ai/reports/' + rid)).status, 204, 'deleting is always possible'); meetd.st.down = false;
    });
    test('a report with no recorded basis (made before the fence existed) is never shown', async () => {
      const { rid } = await published(); await db.pool.query('UPDATE portal.meeting_reports SET consent_basis=NULL WHERE id=$1', [rid]);
      const r = await host().get('/api/v1/meeting-ai/reports/' + rid); assert.equal(r.status, 503); assert.doesNotMatch(JSON.stringify(r.body), /TEST-DOUBLE/);
    });
  });

  describe('revocation in the gap between the last check and the commit', () => {
    test('a withdrawal that lands AFTER the publish-time check is caught immediately after the commit: no reader ever sees the report', async () => {
      await consent(); setC(meet, { Dana: ['agree'], Sam: ['agree'] }); meetd.st.onConsent = async (n) => { if (n === 3) setC(meet, { Dana: ['agree', 'withdraw'], Sam: ['agree'] }); };       // read #3 = the check inside the publishing transaction
      const j = await newJob(); const seen = []; let stop = false;
      const reader = (async () => { while (!stop) { const one = (await q('SELECT id FROM portal.meeting_reports WHERE meet_meeting_id=$1', [meet]))[0]; seen.push(one ? JSON.stringify((await host().get('/api/v1/meeting-ai/reports/' + one.id)).body) : 'none yet'); await sleep(3); } })();      // reads only THIS report, so it adds no Meet reads before it exists
      await app.ai.worker.runOne(); await sleep(150); stop = true; await reader;
      const job = await jobOf(j.id); assert.equal(job.status, 'completed'); const rep = (await q('SELECT id, status, summary FROM portal.meeting_reports WHERE meet_meeting_id=$1', [meet]))[0];
      assert.equal(rep.status, 'withdrawn'); assert.equal(rep.summary, ''); assert.ok(seen.length > 3 && seen.some((x) => x !== 'none yet'), 'readers were really running, including after the report existed'); assert.equal(seen.filter((x) => SUMMARY.test(x) || /ship the release/.test(x)).length, 0, 'no concurrent reader ever got content');
      const ev = (await audit()).map((x) => x.event); assert.ok(ev.includes('result_published') && ev.includes('report_withdrawn') && ev.includes('result_discarded'));
    });
    test('the same gap with Meet failing right after: the report is committed but unverifiable, every read is refused, and the first read once Meet answers withdraws it', async () => {
      await consent(); setC(meet, { Dana: ['agree'], Sam: ['agree'] });
      meetd.st.onConsent = async (n) => { if (n === 3) { setC(meet, { Dana: ['agree', 'withdraw'], Sam: ['agree'] }); meetd.st.down = true; } };                                       // objection, then an outage before the post-commit check
      const job = await chatJob(); assert.equal(job.status, 'completed'); const rep = (await q('SELECT id, status FROM portal.meeting_reports WHERE meet_meeting_id=$1', [meet]))[0]; assert.equal(rep.status, 'final', 'could not be checked yet');
      assert.ok((await audit()).some((x) => x.event === 'consent_unverifiable'), 'the failed check is recorded');
      for (let i = 0; i < 5; i += 1) { const r = await host().get('/api/v1/meeting-ai/reports/' + rep.id); assert.equal(r.status, 503); assert.doesNotMatch(JSON.stringify(r.body), /TEST-DOUBLE|ship the release/); }
      meetd.st.down = false; meetd.st.onConsent = null; const r = await host().get('/api/v1/meeting-ai/reports/' + rep.id); assert.equal(r.body.status, 'withdrawn'); assert.doesNotMatch(JSON.stringify(r.body), /TEST-DOUBLE/);
    });
    test('50 reads racing a withdrawal: every read that STARTED after the withdrawal was recorded in Meet is refused (a total order), earlier reads may have succeeded', async () => {
      const { rid } = await published(); let flippedAt = null; const results = [];
      const readers = Array.from({ length: 50 }, (_, i) => (async () => { await sleep(i * 6); const t0 = Date.now(); const r = await host().get('/api/v1/meeting-ai/reports/' + rid); results.push({ t0, content: SUMMARY.test(JSON.stringify(r.body)) }); })());
      await sleep(120); setC(meet, { Dana: ['agree', 'withdraw'], Sam: ['agree'] }); flippedAt = Date.now(); await Promise.all(readers);
      const late = results.filter((x) => x.t0 > flippedAt); assert.ok(late.length > 5, 'some reads started after the flip'); assert.equal(late.filter((x) => x.content).length, 0, 'no read that began after the withdrawal returned content');
      assert.equal((await reportRow(rid)).status, 'withdrawn');
    });
  });

  describe('failures during publication', () => {
    test('a COMMIT that fails publishes nothing and double-counts nothing: the job retries and the report appears exactly once', async () => {
      await consent(); setC(meet, { Dana: ['agree'], Sam: ['agree'] });
      await db.pool.query(`CREATE OR REPLACE FUNCTION portal.simulated_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated commit failure'; END $$`);
      await db.pool.query('CREATE CONSTRAINT TRIGGER fail_commit AFTER INSERT ON portal.meeting_reports DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION portal.simulated_commit_failure()');      // raises while COMMITTING
      const j = await newJob(); await app.ai.worker.runOne(); const failed = await jobOf(j.id);
      assert.equal(failed.status, 'failed', 'a database error is not retried blindly: a person decides'); assert.match(failed.error_message, /simulated commit failure/); assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_reports WHERE meet_meeting_id=$1', [meet]))[0].n, 0); assert.equal((await q(`SELECT count(*)::int n FROM portal.ai_usage_events WHERE job_id=$1 AND feature='meeting_report'`, [j.id]))[0].n, 0);
      assert.equal((await q(`SELECT count(*)::int n FROM portal.meeting_ai_consent_audit WHERE job_id=$1 AND event='result_published'`, [j.id]))[0].n, 0, 'nothing says it was published');
      await db.pool.query('DROP TRIGGER fail_commit ON portal.meeting_reports'); assert.equal((await host().post(`/api/v1/meeting-ai/jobs/${j.id}/retry`, {})).status, 202); await app.ai.worker.runOne();
      const done = await jobOf(j.id); assert.equal(done.status, 'completed', JSON.stringify(done)); assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_reports WHERE meet_meeting_id=$1', [meet]))[0].n, 1);
      assert.equal((await q(`SELECT count(*)::int n FROM portal.ai_usage_events WHERE job_id=$1 AND feature='meeting_report'`, [j.id]))[0].n, 1); assert.equal((await q(`SELECT count(*)::int n FROM portal.meeting_ai_consent_audit WHERE job_id=$1 AND event='result_published'`, [j.id]))[0].n, 1);
    });
    test('worker retry after a transient model failure re-checks consent: the second attempt does not run if someone withdrew in between', async () => {
      await consent(); setC(meet, { Dana: ['agree'], Sam: ['agree'] }); llmd.st.failTimes = 1;
      const j = await newJob(); await app.ai.worker.runOne(); assert.equal((await jobOf(j.id)).status, 'queued', 'the first attempt failed transiently and was queued again'); assert.equal(modelCalls(), 1);
      setC(meet, { Dana: ['agree'], Sam: ['agree', 'withdraw'] }); await app.ai.worker.runOne(); const job = await jobOf(j.id);
      assert.equal(job.status, 'cancelled'); assert.equal(job.error_code, 'participant_consent_withdrawn'); assert.equal(modelCalls(), 1, 'no second request reached the model'); assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_reports WHERE meet_meeting_id=$1', [meet]))[0].n, 0);
      assert.equal((await q('SELECT full_text FROM portal.meeting_transcripts WHERE job_id=$1', [j.id]))[0].full_text, '');
    });
    test('cancelling a job while the model works prevents publication, and a cancelled or revoked job cannot be retried', async () => {
      await consent(); setC(meet, { Dana: ['agree'], Sam: ['agree'] }); llmd.st.delayMs = 700; const j = await newJob(); const run = app.ai.worker.runOne();
      for (let i = 0; i < 50 && modelCalls() === 0; i += 1) await sleep(20); assert.equal(modelCalls(), 1, 'the model call is in flight');
      assert.equal((await host().post(`/api/v1/meeting-ai/jobs/${j.id}/cancel`, {})).status, 200); await run; const job = await jobOf(j.id);
      assert.equal(job.status, 'cancelled'); assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_reports WHERE meet_meeting_id=$1', [meet]))[0].n, 0, 'the finished model output was discarded'); assert.equal((await q('SELECT full_text FROM portal.meeting_transcripts WHERE job_id=$1', [j.id]))[0].full_text, '', 'and so was the stored transcript');
      const retry = await host().post(`/api/v1/meeting-ai/jobs/${j.id}/retry`, {}); assert.equal(retry.status, 409); assert.equal(retry.body.code, 'not_retryable'); assert.equal(await app.ai.worker.runOne(), false, 'nothing is left to run');
      llmd.st.delayMs = 0; setC(meet, {}, true); const blocked = await chatJob(); assert.equal(blocked.status, 'blocked');
      const cid = (await host().get(`/api/v1/meeting-ai/meetings/${meet}/consents`)).body.consents.find((c) => c.scope === 'summary').id; await host().post(`/api/v1/meeting-ai/consents/${cid}/revoke`, {});
      assert.equal((await host().post(`/api/v1/meeting-ai/jobs/${blocked.id}/retry`, {})).status, 403, 'revoked host consent: no retry');
    });
  });

  describe('imports, typed names and Qorlla AI Private', () => {
    test('an import cannot bypass participant consent: refused while anyone objected; accepted jobs are stopped, and published imports withdrawn, by a LATER objection', async () => {
      await consent(); setC(meet, { Dana: ['agree'], Sam: ['agree', 'decline'] });
      const imp = (extra = {}) => host().post('/api/v1/meeting-ai/jobs', { meet_meeting_id: meet, source: 'transcript_import', idempotency_key: key(), transcript: { format: 'vtt', text: VTT }, ...extra });
      assert.equal((await imp()).body.code, 'participant_declined'); setC(meet, {}, false); assert.equal((await imp()).body.code, 'participant_consent_required');
      setC(meet, { Dana: ['agree'], Sam: ['agree'] }); const a = await imp(); assert.equal(a.status, 202);
      setC(meet, { Dana: ['agree'], Sam: ['agree', 'withdraw'] });                                                   // an objection arrives while the job waits in the queue
      await app.ai.worker.runOne(); const stopped = await jobOf(a.body.id); assert.equal(stopped.status, 'cancelled'); assert.equal(modelCalls(), 0, 'stopped BEFORE the model was called'); assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_reports WHERE meet_meeting_id=$1', [meet]))[0].n, 0);
      setC(meet, { Dana: ['agree'], Sam: ['agree'] }); const mid = await imp(); meetd.st.consentReads = 0; meetd.st.onConsent = async (n) => { if (n === 1) setC(meet, { Dana: ['agree'], Sam: ['agree', 'withdraw'] }); };       // ... or right after the worker's first look, while the model works
      await app.ai.worker.runOne(); const discarded = await jobOf(mid.body.id); assert.equal(discarded.status, 'cancelled'); assert.equal(modelCalls(), 1, 'the model ran (consent held when it started)'); assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_reports WHERE meet_meeting_id=$1', [meet]))[0].n, 0, 'but its output was discarded');
      meetd.st.onConsent = null; setC(meet, { Dana: ['agree'], Sam: ['agree'] }); const b = await imp(); await app.ai.worker.runOne(); const done = await jobOf(b.body.id); assert.equal(done.status, 'completed'); const rid = done.report_id; assert.match((await host().get('/api/v1/meeting-ai/reports/' + rid)).body.summary, SUMMARY);
      setC(meet, { Dana: ['agree'], Sam: ['agree', 'withdraw'] }); assert.equal((await host().get('/api/v1/meeting-ai/reports/' + rid)).body.status, 'withdrawn', 'anyone in the meeting objecting later withdraws an import-based report');
    });
    test('typed display names are never identity: a second person called "Dana" who has not agreed is excluded even though the first Dana agreed', async () => {
      await consent(); const impostor = 'p-dana-impostor';
      meetd.put(meet, 'Launch review', [{ speaker: 'Dana', text: 'We decided to ship the release on Monday morning.', at: '2026-11-01T10:00:00Z' }, { speaker: 'Dana', participantId: impostor, text: 'SECRET-IMPOSTOR I also call myself Dana', at: '2026-11-01T10:01:00Z' }]);
      meetd.st.meetings.get(meet).consent = { requested: true, participants: [{ participantId: pidOf('Dana'), name: 'Dana', role: 'guest', decisions: decisionRow('agree') }, { participantId: impostor, name: 'Dana', role: 'guest', decisions: decisionRow('pending') }] };
      const job = await chatJob(); assert.equal(job.status, 'completed'); const t = (await q('SELECT full_text, speaker_labels FROM portal.meeting_transcripts WHERE job_id=$1', [job.id]))[0];
      assert.doesNotMatch(t.full_text, /SECRET-IMPOSTOR/); assert.equal(t.speaker_labels, 'unverified', 'names stay labelled unverified'); assert.equal(llmd.st.requests.some((r) => JSON.stringify(r.body).includes('SECRET-IMPOSTOR')), false);
      assert.deepEqual((await q('SELECT participant_id, included FROM portal.meeting_ai_job_participants WHERE job_id=$1 ORDER BY participant_id', [job.id])).map((r) => [r.participant_id, r.included]), [['p-dana', true], [impostor, false]]);
    });
  });
});
