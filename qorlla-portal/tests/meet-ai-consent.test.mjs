import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, addMember, seedMeeting } from './helpers.mjs';
import { startFakeLlm, startFakeMeet, READ_SECRET, pidOf, decisionRow } from './fake-llm.mjs';
import { applyParticipantConsent, importAllowed, stillConsented } from '../server/ai/meet-consent.mjs';

// Meet AI consent and citations. Test doubles only (the repo's labelled fake model and fake Meet): this proves OUR consent, fencing, audit and citation logic.
// It says nothing about a real provider or a real Meet. A "model request" below means a request that reached the fake external model server: the number of unauthorised ones must be ZERO.
const key = () => 'idem-' + crypto.randomBytes(6).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MSGS = [
  { speaker: 'Dana', text: 'We decided to ship the release on Monday morning.', at: '2026-11-01T10:00:00Z' },
  { speaker: 'Sam', text: 'SECRET-SAM ACTION: Dana to order stickers by Wednesday', at: '2026-11-01T10:01:00Z' },
  { speaker: 'Lee', text: 'SECRET-LEE I joined late and wrote this private remark', at: '2026-11-01T10:02:00Z' }
];
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nDana: We decided to hire two engineers.\n';

describe('pure consent decisions', () => {
  const part = (name, t, s = t) => ({ participantId: pidOf(name), name, decisions: decisionRow(t, s) });
  const msgs = (...names) => names.map((n) => ({ participantId: pidOf(n), speaker: n, text: 'hello from ' + n }));
  test('only authors who agreed to BOTH purposes are included; pending, declined and withdrawn are excluded; nobody is excluded silently', () => {
    const d = applyParticipantConsent({ messages: [...msgs('Dana', 'Sam', 'Lee', 'Max'), { speaker: 'Ghost', text: 'no id' }], consent: { requested: true, participants: [part('Dana', 'agree'), part('Sam', 'agree', 'decline'), part('Lee', 'pending'), part('Max', 'withdraw')] } });
    assert.deepEqual(d.included.map((m) => m.speaker), ['Dana']); assert.deepEqual(d.excluded, { pending: 1, declined: 1, withdrawn: 1, unknown: 1 });
    assert.deepEqual(d.participants.map((p) => [p.participant_id, p.included, p.reason]), [['p-dana', true, null], ['p-sam', false, 'declined'], ['p-lee', false, 'pending'], ['p-max', false, 'withdrawn']]);
  });
  test('a closed host request excludes everyone; imports need an open request and no objector; the publish re-check fails closed on any gap', () => {
    assert.equal(applyParticipantConsent({ messages: msgs('Dana'), consent: { requested: false, participants: [part('Dana', 'agree')] } }).included.length, 0);
    assert.deepEqual(importAllowed({ requested: true, revision: 1005, participants: [part('Dana', 'agree')] }), { allowed: true, revision: 1005 }); assert.equal(importAllowed({ requested: false, participants: [] }).reason, 'participant_consent_required');
    assert.equal(importAllowed({ requested: true, participants: [part('Sam', 'agree', 'decline')] }).reason, 'participant_declined'); assert.equal(importAllowed({ requested: true, participants: [part('Max', 'withdraw')] }).reason, 'participant_declined');
    const dana = part('Dana', 'agree'); const ok = { requested: true, participants: [dana] }; const rows = [{ participant_id: 'p-dana', transcription_seq: dana.decisions.transcription.seq, summary_seq: dana.decisions.summary.seq }];
    assert.equal(stillConsented({ consent: ok, rows }).ok, true); assert.equal(stillConsented({ consent: ok, rows: [...rows, { participant_id: 'p-unknown', transcription_seq: 5, summary_seq: 5 }] }).reason, 'participant_withdrew', 'a participant Meet no longer reports counts as NOT agreeing');
    assert.equal(stillConsented({ consent: { ...ok, requested: false }, rows }).reason, 'request_closed');
  });
});

describe('Meet AI consent and citations (PostgreSQL, fake model, fake Meet)', () => {
  let db, main, llmd, meetd, app, W, H, A, M, O, meet;
  const host = () => app.client(H); const admin = () => app.client(A); const member = () => app.client(M); const outsider = () => app.client(O);
  const q = async (sql, args = []) => (await db.pool.query(sql, args)).rows;
  const consent = (cl = host()) => cl.post(`/api/v1/meeting-ai/meetings/${meet}/consents`, { attest: true, notice_version: 'v1' });
  const setC = (id, map, requested = true) => { const mt = meetd.st.meetings.get(id); mt.consent = { requested, participants: Object.entries(map).map(([name, [t, s]]) => ({ participantId: pidOf(name), name, role: 'guest', decisions: decisionRow(t, s ?? t) })) }; };
  const modelSaw = (needle) => llmd.st.requests.some((r) => JSON.stringify(r.body).includes(needle));
  async function chatJob(extra = {}) { const j = await host().post('/api/v1/meeting-ai/jobs', { meet_meeting_id: meet, source: 'meet_chat', idempotency_key: key(), ...extra }); assert.equal(j.status, 202, JSON.stringify(j.body)); await app.ai.worker.runOne(); return (await host().get('/api/v1/meeting-ai/jobs/' + j.body.id)).body; }
  const modelCalls = () => llmd.st.requests.length;
  const audit = async (event) => (await q(`SELECT * FROM portal.meeting_ai_consent_audit WHERE workspace_id=$1 AND meet_meeting_id=$2 ${event ? 'AND event=$3' : ''} ORDER BY id`, event ? [W, meet, event] : [W, meet]));

  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn(); llmd = await startFakeLlm(); meetd = await startFakeMeet();
    const env = { AI_LLM_API_KEY: 'test-llm-key', AI_LLM_API_BASE: llmd.url, AI_LLM_MODEL: 'claude-test', MEET_INTERNAL_URL: meetd.url, MEET_READ_SECRET: READ_SECRET, QORLLA_AI_RATE_PER_MINUTE: '100000' };   // the per-person limit has its own unit tests; the race test below sends 20 jobs
    app = await startApp({ pool: db.pool, cfg: testConfig({ env, cfg: { shareLimit: 1000 } }, main), jwks: main.jwks, ai: { worker: { backoffBaseSeconds: 0 } } });
    H = await main.mint(); A = await main.mint(); M = await main.mint(); O = await main.mint();
    W = await seedWorkspace(db.pool, H.sub, 'Consent Co'); await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='pro',status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [W]);
    await addMember(db.pool, W, A.sub, 'admin'); await addMember(db.pool, W, M.sub, 'member'); await seedWorkspace(db.pool, O.sub, 'Elsewhere Co');
  });
  after(async () => { await app.close(); await llmd.close(); await meetd.close(); await main.close(); await db.drop(); });
  beforeEach(async () => {
    await db.pool.query(`UPDATE portal.meeting_ai_jobs SET status='cancelled', error_code='test_cleanup' WHERE status IN ('queued','running','blocked')`);
    await db.pool.query('UPDATE portal.workspace_ai_settings SET external_processing=true WHERE workspace_id=$1', [W]);
    meet = await seedMeeting(db.pool, H.sub, { title: 'Launch review' }); await fetch(llmd.url + '/__control/reset', { method: 'POST' });
    Object.assign(meetd.st, { down: false, delayMs: 0, onConsent: null, consentReads: 0 }); meetd.st.requests.length = 0; meetd.put(meet, 'Launch review', MSGS);
  });

  describe('separate, per-person consent', () => {
    test('host attestation alone is not enough: with no Qorlla AI request open in Meet (or nobody having answered) nothing is stored and no model is called', async () => {
      await consent(); setC(meet, {}, false);                                   // host attested in Workplace, but Meet shows no open request
      let job = await chatJob(); assert.equal(job.status, 'blocked'); assert.equal(job.error_code, 'participant_consent_required');
      assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_transcripts WHERE meet_meeting_id=$1', [meet]))[0].n, 0, 'nothing was stored'); assert.equal(modelCalls(), 0);
      setC(meet, { Dana: ['pending'], Sam: ['pending'], Lee: ['pending'] });     // request open, but nobody has answered (e.g. they only agreed to a RECORDING, which Meet keeps apart)
      job = await chatJob(); assert.equal(job.status, 'blocked'); assert.equal(job.error_code, 'no_consented_content'); assert.equal(modelCalls(), 0);
      assert.equal((await audit('job_blocked')).length, 2); assert.deepEqual((await audit('job_blocked')).map((r) => r.detail.reason), ['participant_consent_required', 'no_consented_content']);
    });
    test('each purpose is separate: agreeing to transcription but not summary still excludes that person, and the model never sees their words', async () => {
      await consent(); setC(meet, { Dana: ['agree'], Sam: ['agree', 'decline'], Lee: ['decline', 'agree'] });
      const job = await chatJob(); assert.equal(job.status, 'completed', JSON.stringify(job));
      const t = (await q('SELECT full_text, segments FROM portal.meeting_transcripts WHERE job_id=$1', [job.id]))[0]; assert.match(t.full_text, /ship the release/); assert.doesNotMatch(JSON.stringify(t), /SECRET-SAM|SECRET-LEE/);
      assert.equal(modelSaw('SECRET-SAM') || modelSaw('SECRET-LEE'), false, 'no excluded word reached the model'); assert.equal(modelCalls(), 1);
      assert.deepEqual((await q('SELECT participant_id, included, reason FROM portal.meeting_ai_job_participants WHERE job_id=$1 ORDER BY participant_id', [job.id])).map((r) => [r.participant_id, r.included, r.reason]), [['p-dana', true, null], ['p-lee', false, 'declined'], ['p-sam', false, 'declined']]);
    });
    test('a host cannot override a participant: host attestation does not include someone who declined, and an imported transcript is refused while anyone has declined', async () => {
      await consent(); setC(meet, { Dana: ['agree'], Sam: ['decline'], Lee: ['agree'] });
      const job = await chatJob(); assert.equal(job.status, 'completed'); assert.equal(modelSaw('SECRET-SAM'), false);
      const imp = await host().post('/api/v1/meeting-ai/jobs', { meet_meeting_id: meet, source: 'transcript_import', idempotency_key: key(), transcript: { format: 'vtt', text: VTT } });
      assert.equal(imp.status, 403); assert.equal(imp.body.code, 'participant_declined'); assert.equal((await q(`SELECT count(*)::int n FROM portal.meeting_transcripts WHERE source='transcript_import' AND meet_meeting_id=$1`, [meet]))[0].n, 0, 'the import was not even stored');
      setC(meet, { Dana: ['agree'], Sam: ['agree'] }); const ok = await host().post('/api/v1/meeting-ai/jobs', { meet_meeting_id: meet, source: 'transcript_import', idempotency_key: key(), transcript: { format: 'vtt', text: VTT } }); assert.equal(ok.status, 202);
      setC(meet, {}, false); assert.equal((await host().post('/api/v1/meeting-ai/jobs', { meet_meeting_id: meet, source: 'transcript_import', idempotency_key: key(), transcript: { format: 'vtt', text: VTT } })).body.code, 'participant_consent_required');
    });
    test('late joiner: until they answer their messages are excluded and unseen; once they agree they are included in the NEXT job only, and the earlier report is not rewritten', async () => {
      await consent(); setC(meet, { Dana: ['agree'], Sam: ['agree'], Lee: ['pending'] });
      const first = await chatJob(); assert.equal(first.status, 'completed'); assert.equal(modelSaw('SECRET-LEE'), false); assert.equal((await q('SELECT reason FROM portal.meeting_ai_job_participants WHERE job_id=$1 AND participant_id=$2', [first.id, 'p-lee']))[0].reason, 'pending');
      setC(meet, { Dana: ['agree'], Sam: ['agree'], Lee: ['agree'] }); const second = await chatJob(); assert.equal(second.status, 'completed'); assert.equal(modelSaw('SECRET-LEE'), true, 'now they agreed, their words are used');
      assert.doesNotMatch((await q('SELECT full_text FROM portal.meeting_transcripts WHERE job_id=$1', [first.id]))[0].full_text, /SECRET-LEE/); assert.match((await q('SELECT full_text FROM portal.meeting_transcripts WHERE job_id=$1', [second.id]))[0].full_text, /SECRET-LEE/);
    });
    test('withdrawal: a participant who withdrew is excluded from the next job; if everyone withdrew, nothing is processed and the model is not called', async () => {
      await consent(); setC(meet, { Dana: ['agree'], Sam: ['withdraw'], Lee: ['agree'] }); const a = await chatJob(); assert.equal(a.status, 'completed'); assert.equal(modelSaw('SECRET-SAM'), false);
      llmd.st.requests.length = 0; setC(meet, { Dana: ['withdraw'], Sam: ['withdraw'], Lee: ['withdraw'] }); const b = await chatJob(); assert.equal(b.status, 'blocked'); assert.equal(b.error_code, 'no_consented_content'); assert.equal(modelCalls(), 0);
    });
  });

  describe('revocation during a job: nothing further is processed, nothing is published', () => {
    test('withdrawn BEFORE the model is called: the stored transcript is discarded, the model is never called, no report exists', async () => {
      await consent(); setC(meet, { Dana: ['agree'], Sam: ['agree'], Lee: ['agree'] });
      meetd.st.onConsent = async (n) => { if (n === 1) setC(meet, { Dana: ['agree'], Sam: ['withdraw'], Lee: ['agree'] }); };       // after the fetch stage has read consent
      const job = await chatJob(); assert.equal(job.status, 'cancelled'); assert.equal(job.error_code, 'participant_consent_withdrawn'); assert.equal(modelCalls(), 0, 'no content was sent to the model after the withdrawal');
      const t = (await q('SELECT full_text, purged_at, purge_reason FROM portal.meeting_transcripts WHERE job_id=$1', [job.id]))[0]; assert.equal(t.full_text, ''); assert.equal(t.purge_reason, 'participant_consent');
      assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_reports WHERE meet_meeting_id=$1', [meet]))[0].n, 0); assert.equal((await audit('processing_stopped'))[0].detail.stage, 'before_model');
    });
    test('withdrawn WHILE the model is working: the pending result is discarded and never published, and nothing is billed as a report', async () => {
      await consent(); setC(meet, { Dana: ['agree'], Sam: ['agree'], Lee: ['agree'] });
      meetd.st.onConsent = async (n) => { if (n === 2) setC(meet, { Dana: ['agree'], Sam: ['agree'], Lee: ['withdraw'] }); };       // after the pre-model check, i.e. during inference
      const job = await chatJob(); assert.equal(modelCalls(), 1, 'the model did run (consent was fine when it started)'); assert.equal(job.status, 'cancelled'); assert.equal(job.error_code, 'participant_consent_withdrawn');
      assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_reports WHERE meet_meeting_id=$1', [meet]))[0].n, 0, 'the result was discarded'); assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_action_items i JOIN portal.meeting_reports r ON r.id=i.report_id WHERE r.meet_meeting_id=$1', [meet]))[0].n, 0);
      assert.equal((await q(`SELECT count(*)::int n FROM portal.ai_usage_events WHERE job_id=$1 AND feature='meeting_report'`, [job.id]))[0].n, 0); assert.equal((await q('SELECT full_text FROM portal.meeting_transcripts WHERE job_id=$1', [job.id]))[0].full_text, '');
      assert.equal((await audit('result_discarded')).length, 1); assert.equal((await audit('result_published')).length, 0);
    });
    test('the host closing the AI request in Meet stops processing the same way', async () => {
      await consent(); setC(meet, { Dana: ['agree'], Sam: ['agree'], Lee: ['agree'] }); meetd.st.onConsent = async (n) => { if (n === 2) setC(meet, { Dana: ['agree'], Sam: ['agree'], Lee: ['agree'] }, false); };
      const job = await chatJob(); assert.equal(job.status, 'cancelled'); assert.equal(job.error_code, 'participant_consent_required'); assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_reports WHERE meet_meeting_id=$1', [meet]))[0].n, 0);
    });
    test('concurrent changes fail closed: if Meet cannot be asked at the last moment nothing is published, and the job completes later once Meet answers', async () => {
      await consent(); setC(meet, { Dana: ['agree'], Sam: ['agree'], Lee: ['agree'] }); meetd.st.onConsent = async (n) => { if (n === 2) meetd.st.down = true; };       // Meet goes away right before the publish check
      const job = await chatJob(); assert.equal(job.status, 'queued', JSON.stringify(job)); assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_reports WHERE meet_meeting_id=$1', [meet]))[0].n, 0, 'unverifiable = not published');
      meetd.st.down = false; meetd.st.onConsent = null; await app.ai.worker.runOne(); const done = (await host().get('/api/v1/meeting-ai/jobs/' + job.id)).body; assert.equal(done.status, 'completed'); assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_reports WHERE meet_meeting_id=$1', [meet]))[0].n, 1);
    });
    test('Meet unreachable at the start: nothing is stored or sent', async () => {
      await consent(); meetd.st.down = true; const job = await chatJob(); assert.notEqual(job.status, 'completed'); assert.equal(modelCalls(), 0); assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_transcripts WHERE meet_meeting_id=$1', [meet]))[0].n, 0);
    });
    test('host revocation racing a running job (20 interleavings): whichever wins, no final report and no transcript text survive the revocation', async () => {
      for (let i = 0; i < 20; i += 1) {
        meet = await seedMeeting(db.pool, H.sub, { title: 'Race ' + i }); meetd.put(meet, 'Race', MSGS); setC(meet, { Dana: ['agree'], Sam: ['agree'], Lee: ['agree'] });
        const granted = (await consent()).body.active; const summaryId = granted.find((c) => c.scope === 'summary').id;
        const j = await host().post('/api/v1/meeting-ai/jobs', { meet_meeting_id: meet, source: 'meet_chat', idempotency_key: key() }); assert.equal(j.status, 202);
        const [, rv] = await Promise.all([app.ai.worker.runOne(), sleep((i * 7) % 40).then(() => host().post(`/api/v1/meeting-ai/consents/${summaryId}/revoke`, { reason: 'race' }))]);
        assert.equal(rv.status, 200, 'iteration ' + i + ': ' + JSON.stringify(rv.body));
        assert.equal((await q(`SELECT count(*)::int n FROM portal.meeting_reports WHERE meet_meeting_id=$1 AND status='final'`, [meet]))[0].n, 0, 'iteration ' + i + ': a final report survived the revocation');
        assert.equal((await q(`SELECT count(*)::int n FROM portal.meeting_transcripts WHERE meet_meeting_id=$1 AND (purged_at IS NULL OR full_text <> '')`, [meet]))[0].n, 0, 'iteration ' + i + ': transcript text survived');
      }
    });
  });

  describe('the AI gateway still decides who may receive content', () => {
    test('external processing not authorised for the workspace: the job is blocked and ZERO requests reach the external model; authorising lets the retry through', async () => {
      await consent(); setC(meet, { Dana: ['agree'], Sam: ['agree'], Lee: ['agree'] }); await db.pool.query('UPDATE portal.workspace_ai_settings SET external_processing=false WHERE workspace_id=$1', [W]);
      const job = await chatJob(); assert.equal(job.status, 'blocked'); assert.equal(job.error_code, 'consent_required'); assert.equal(modelCalls(), 0, 'no unauthorised request');
      await db.pool.query('UPDATE portal.workspace_ai_settings SET external_processing=true WHERE workspace_id=$1', [W]);
      assert.equal((await host().post(`/api/v1/meeting-ai/jobs/${job.id}/retry`, {})).status, 202); await app.ai.worker.runOne(); assert.equal((await host().get('/api/v1/meeting-ai/jobs/' + job.id)).body.status, 'completed'); assert.equal(modelCalls(), 1);
    });
    test('a provider that is not on the approved list is never used: the job is blocked and nothing is sent', async () => {
      const env = { AI_LLM_API_KEY: 'test-llm-key', AI_LLM_API_BASE: llmd.url, AI_LLM_MODEL: 'claude-test', MEET_INTERNAL_URL: meetd.url, MEET_READ_SECRET: READ_SECRET, QORLLA_AI_APPROVED_PROVIDERS: '', QORLLA_AI_PROVIDER: 'auto' };
      const other = await startApp({ pool: db.pool, cfg: testConfig({ env }, main), jwks: main.jwks, ai: { worker: { backoffBaseSeconds: 0 } } });
      try { await consent(); setC(meet, { Dana: ['agree'] }); const j = await host().post('/api/v1/meeting-ai/jobs', { meet_meeting_id: meet, source: 'meet_chat', idempotency_key: key() }); assert.equal(j.status, 202);
        await other.ai.worker.runOne(); const job = (await host().get('/api/v1/meeting-ai/jobs/' + j.body.id)).body; assert.equal(job.status, 'blocked'); assert.equal(job.error_code, 'no_ai_provider'); assert.equal(modelCalls(), 0);
      } finally { await other.close(); }
    });
    test('the meet_ai kill switch pauses Meet analysis without touching other AI features', async () => {
      await consent(); setC(meet, { Dana: ['agree'] }); await app.flags.set('meet_ai', false, 'incident', H.sub);
      try { const r = await host().post('/api/v1/meeting-ai/jobs', { meet_meeting_id: meet, source: 'meet_chat', idempotency_key: key() }); assert.equal(r.status, 503); assert.equal(r.body.flag, 'meet_ai'); assert.equal(modelCalls(), 0); } finally { await app.flags.set('meet_ai', true, null, H.sub); }
    });
  });

  describe('workspace isolation', () => {
    test('another workspace can neither start AI on this meeting nor read its jobs, reports or consent evidence', async () => {
      await consent(); setC(meet, { Dana: ['agree'], Sam: ['agree'], Lee: ['agree'] }); const job = await chatJob(); assert.equal(job.status, 'completed');
      assert.equal((await outsider().post('/api/v1/meeting-ai/jobs', { meet_meeting_id: meet, source: 'meet_chat', idempotency_key: key() })).status, 404);
      assert.equal((await outsider().get('/api/v1/meeting-ai/jobs/' + job.id)).status, 404); assert.equal((await outsider().get('/api/v1/meeting-ai/reports/' + job.report_id)).status, 404); assert.equal((await outsider().get(`/api/v1/meeting-ai/reports/${job.report_id}/transcript`)).status, 404);
      assert.equal((await outsider().get(`/api/v1/meeting-ai/meetings/${meet}/consents`)).status, 404);
    });
  });

  describe('citations to the meeting transcript', () => {
    async function report() { await consent(); setC(meet, { Dana: ['agree'], Sam: ['agree'], Lee: ['pending'] }); const job = await chatJob(); assert.equal(job.status, 'completed', JSON.stringify(job)); return { job, body: (await host().get('/api/v1/meeting-ai/reports/' + job.report_id)).body }; }
    const open = (cl, ref) => cl.get('/api/v1/ai/citations/' + ref);
    test('every citation is created by the backend and resolves to a real, consented segment with its timestamp; excluded people are never cited', async () => {
      const { body } = await report(); const decisionRefs = body.citations.decisions.flat(), actionRefs = body.citations.action_items.flatMap((x) => x.refs);
      assert.ok(decisionRefs.length >= 1 && actionRefs.length >= 1, JSON.stringify(body.citations)); assert.doesNotMatch(JSON.stringify([decisionRefs, actionRefs]), /SECRET|Dana|Sam|ship the release/, 'a citation holds no transcript text'); assert.equal(body.citations.action_items[0].title, 'order stickers', 'action-item citations are matched to their item by title');
      const d = await open(host(), decisionRefs[0].ref); assert.equal(d.status, 200, JSON.stringify(d.body)); assert.match(d.body.passage, /decided to ship the release on Monday/); assert.equal(d.body.speaker, 'Dana'); assert.equal(d.body.at, '2026-11-01T10:00:00Z'); assert.equal(d.body.kind, 'meet_transcript');
      const a = await open(host(), actionRefs[0].ref); assert.equal(a.status, 200); assert.match(a.body.passage, /order stickers/);
      for (const r of [...decisionRefs, ...actionRefs]) { const x = await open(host(), r.ref); assert.equal(x.status, 200); assert.doesNotMatch(x.body.passage, /SECRET-LEE/, 'the late joiner who never agreed is not citable'); }
      assert.ok((await audit('citation_opened')).length >= 3);
    });
    test('forged, edited, cross-workspace and changed-source citations are refused', async () => {
      const { body } = await report(); const ref = body.citations.decisions.flat()[0].ref;
      assert.equal((await open(host(), ref.slice(0, -3) + 'abc')).status, 400); assert.equal((await open(host(), 'qc1.' + Buffer.from('{"v":1}').toString('base64url') + '.' + 'A'.repeat(43))).status, 400); assert.equal((await open(host(), 'not-a-citation')).status, 400);
      assert.equal((await open(outsider(), ref)).status, 404, 'another workspace cannot tell it exists');
      await db.pool.query(`UPDATE portal.meeting_transcripts SET segments = jsonb_set(segments, '{0,text}', '"edited after the fact"') WHERE meet_meeting_id=$1`, [meet]);
      const x = await open(host(), ref); assert.equal(x.status, 409); assert.equal(x.body.code, 'source_changed'); assert.doesNotMatch(JSON.stringify(x.body), /edited after the fact/, 'a changed source is not shown');
    });
    test('permissions are re-checked when a citation is opened: a member without access, or a host who lost it, is refused', async () => {
      const { body } = await report(); const ref = body.citations.decisions.flat()[0].ref;
      const m = await open(member(), ref); assert.equal(m.status, 403); assert.equal(m.body.code, 'citation_access_revoked'); assert.equal((await open(admin(), ref)).status, 200, 'a workspace admin may');
      await db.pool.query(`UPDATE portal.members SET role='member' WHERE workspace_id=$1 AND user_id=$2`, [W, A.sub]); assert.equal((await open(admin(), ref)).status, 403, 'demoted: refused at once'); await db.pool.query(`UPDATE portal.members SET role='admin' WHERE workspace_id=$1 AND user_id=$2`, [W, A.sub]);
      await db.pool.query(`DELETE FROM portal.members WHERE workspace_id=$1 AND user_id=$2`, [W, M.sub]); assert.equal((await open(member(), ref)).status, 403); await addMember(db.pool, W, M.sub, 'member');
    });
    test('the same consent applies to the citation as to the report: a participant who objected closes it for good, Meet being unreachable shows nothing, and the host revoking closes it too', async () => {
      const { body } = await report(); const ref = body.citations.decisions.flat()[0].ref; assert.equal((await open(host(), ref)).status, 200);
      setC(meet, { Dana: ['withdraw'], Sam: ['agree'], Lee: ['pending'] }); const w = await open(host(), ref); assert.equal(w.status, 403); assert.equal(w.body.code, 'participant_withdrew'); assert.doesNotMatch(JSON.stringify(w.body), /ship the release/);
      setC(meet, { Dana: ['agree'], Sam: ['agree'], Lee: ['pending'] }); const again = await open(host(), ref); assert.ok([403, 410].includes(again.status), 'agreeing again later does not bring a withdrawn report back: it was built on the earlier agreement'); assert.doesNotMatch(JSON.stringify(again.body), /ship the release/); assert.ok(['consent_withdrawn', 'source_expired'].includes(again.body.code));
      assert.equal((await host().get('/api/v1/meeting-ai/reports/' + body.id)).body.status, 'withdrawn');
      // a second report: Meet unreachable = not shown; then the host revoking the meeting's consent
      setC(meet, { Dana: ['agree'], Sam: ['agree'], Lee: ['pending'] }); const job2 = await chatJob(); assert.equal(job2.status, 'completed'); const b2 = (await host().get('/api/v1/meeting-ai/reports/' + job2.report_id)).body; const ref2 = b2.citations.decisions.flat()[0].ref;
      meetd.st.down = true; assert.equal((await open(host(), ref2)).status, 503, 'cannot verify consent = not shown'); meetd.st.down = false; assert.equal((await open(host(), ref2)).status, 200);
      const cid = (await host().get(`/api/v1/meeting-ai/meetings/${meet}/consents`)).body.consents.find((c) => c.scope === 'transcription').id; await host().post(`/api/v1/meeting-ai/consents/${cid}/revoke`, {});
      const gone = await open(host(), ref2); assert.ok([403, 410].includes(gone.status), String(gone.status)); assert.doesNotMatch(JSON.stringify(gone.body), /ship the release/);
      assert.equal((await host().get('/api/v1/meeting-ai/reports/' + b2.id)).body.status, 'withdrawn'); assert.deepEqual((await q('SELECT citations FROM portal.meeting_reports WHERE id=$1', [b2.id]))[0].citations, {}, 'revocation also clears the citations');
    });
    test('retention applies to citations: once the transcript is past retention (even before the sweep) or purged, the source cannot be retrieved', async () => {
      const { body } = await report(); const ref = body.citations.decisions.flat()[0].ref;
      await db.pool.query(`UPDATE portal.meeting_transcripts SET created_at = now() - interval '100 days' WHERE meet_meeting_id=$1`, [meet]);
      const old = await open(host(), ref); assert.equal(old.status, 410); assert.equal(old.body.code, 'source_expired'); assert.doesNotMatch(JSON.stringify(old.body), /ship the release/);
      assert.ok(await app.ai.worker.purgeExpired(90) >= 1); assert.equal((await open(host(), ref)).status, 410);
      assert.match((await host().get('/api/v1/meeting-ai/reports/' + body.id)).body.summary, /TEST-DOUBLE/, 'the report itself stays, as before');
    });
    test('the consent audit trail records decisions, scopes, times and revocations as counts and codes only, and is append-only', async () => {
      const { job, body } = await report(); const cid = (await host().get(`/api/v1/meeting-ai/meetings/${meet}/consents`)).body.consents.find((c) => c.scope === 'summary').id; await host().post(`/api/v1/meeting-ai/consents/${cid}/revoke`, { reason: 'audit test' });
      const rows = await audit(); const events = new Set(rows.map((r) => r.event)); for (const e of ['host_consent_granted', 'job_snapshot', 'result_published', 'host_consent_revoked']) assert.ok(events.has(e), e);
      assert.deepEqual(rows.filter((r) => r.event === 'host_consent_granted').map((r) => r.scope).sort(), ['summary', 'transcription']); assert.ok(rows.every((r) => r.at && r.workspace_id === W));
      const snap = rows.find((r) => r.event === 'job_snapshot'); assert.deepEqual([snap.detail.included_participants, snap.detail.messages_used, snap.detail.excluded.pending], [2, 2, 1]);
      assert.doesNotMatch(JSON.stringify(rows), /SECRET|ship the release|Dana|Sam|Lee|decided|stickers/, 'no transcript text and no names'); assert.ok(job.id && body.id);
      await assert.rejects(db.pool.query("UPDATE portal.meeting_ai_consent_audit SET event='job_blocked'"), /append-only/); await assert.rejects(db.pool.query('DELETE FROM portal.meeting_ai_consent_audit'), /append-only/);
    });
  });
});
