import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, seedMeeting } from './helpers.mjs';
import { startFakeLlm, startFakeMeet, READ_SECRET } from './fake-llm.mjs';
import { createMeetClient } from '../server/ai/meet-client.mjs';
import { withWatermark } from '../server/ai/consent-source.mjs';

// Regression tests for the findings of the independent consent-fence review (docs/CONSENT_FENCE_REVIEW.md). Test doubles only.
const key = () => 'idem-' + crypto.randomBytes(6).toString('hex');
const ID = '11111111-1111-1111-1111-111111111111';
const answer = (over = {}) => ({ requested: true, revision: '10', participants: [{ participantId: 'p1', role: 'guest', decisions: { transcription: { decision: 'agree', seq: '5', objectionSeq: '0' }, summary: { decision: 'agree', seq: '6', objectionSeq: '0' } } }], ...over });
const clientFor = (body) => createMeetClient({ baseUrl: 'http://meet', readSecret: 'r'.repeat(40), fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }) });

describe('Meet answers are validated strictly (a gap must never read as "no objection")', () => {
  test('a missing, negative, fractional or non-numeric number is an unreadable answer, not zero', async () => {
    assert.equal((await clientFor(answer()).fetchConsent(ID)).participants[0].decisions.summary.objectionSeq, 0);
    for (const bad of [undefined, null, '', '-1', '1.5', 'abc', {}]) {
      const a = answer(); a.participants[0].decisions.summary.objectionSeq = bad; if (bad === undefined) delete a.participants[0].decisions.summary.objectionSeq;
      await assert.rejects(clientFor(a).fetchConsent(ID), /unreadable/, 'objectionSeq=' + String(bad));
    }
    const noDecision = answer(); delete noDecision.participants[0].decisions.transcription; await assert.rejects(clientFor(noDecision).fetchConsent(ID), /unreadable/);
    await assert.rejects(clientFor(answer({ revision: undefined })).fetchConsent(ID), /unreadable/);
  });
});

describe('review findings (PostgreSQL, fake model, fake Meet)', () => {
  let db, main, llmd, meetd, app, W, H, M, meet;
  const host = () => app.client(H);
  const q = async (sql, args = []) => (await db.pool.query(sql, args)).rows;

  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn(); llmd = await startFakeLlm(); meetd = await startFakeMeet();
    const env = { AI_LLM_API_KEY: 'test-llm-key', AI_LLM_API_BASE: llmd.url, AI_LLM_MODEL: 'claude-test', MEET_INTERNAL_URL: meetd.url, MEET_READ_SECRET: READ_SECRET, QORLLA_AI_RATE_PER_MINUTE: '100000' };
    app = await startApp({ pool: db.pool, cfg: testConfig({ env }, main), jwks: main.jwks, ai: { worker: { backoffBaseSeconds: 0 } } });
    H = await main.mint(); M = await main.mint();
    W = await seedWorkspace(db.pool, H.sub, 'Review Co'); await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='pro',status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [W]);
  });
  after(async () => { await app.close(); await llmd.close(); await meetd.close(); await main.close(); await db.drop(); });
  beforeEach(async () => { meet = await seedMeeting(db.pool, H.sub, { title: 'Review' }); meetd.put(meet, 'Review', [{ speaker: 'Dana', text: 'We decided to ship on Monday.', at: '2026-11-01T10:00:00Z' }]); });

  test('C1: the retired report list returns no report content to anyone, and still requires a login', async () => {
    await host().post(`/api/v1/meeting-ai/meetings/${meet}/consents`, { attest: true, notice_version: 'v1' });
    const j = await host().post('/api/v1/meeting-ai/jobs', { meet_meeting_id: meet, source: 'meet_chat', idempotency_key: key() }); await app.ai.worker.runOne(); assert.equal(j.status, 202);
    const r = await host().get('/api/v1/reports'); assert.equal(r.status, 410); assert.ok(!JSON.stringify(r.body).includes('TEST-DOUBLE'), 'no summary text');
    assert.equal((await app.client().get('/api/v1/reports')).status, 401);
  });

  test('H2: Meet reporting an OLDER history than the portal has seen is refused (restored backup, stale replica, replay)', async () => {
    let rev = 10; const meetStub = { fetchConsent: async () => ({ requested: true, revision: rev, participants: [] }), other: 1 };
    const w = withWatermark(meetStub, db.pool); const id = crypto.randomUUID();
    assert.equal((await w.fetchConsent(id)).revision, 10); rev = 12; assert.equal((await w.fetchConsent(id)).revision, 12);
    rev = 11; await assert.rejects(w.fetchConsent(id), (e) => e.code === 'consent_regressed' && e.retryable === false);
    rev = 12; assert.equal((await w.fetchConsent(id)).revision, 12, 'the same revision is fine'); assert.equal(w.other, 1);
    assert.equal(Number((await q('SELECT revision FROM portal.meet_consent_watermark WHERE meet_meeting_id=$1', [id]))[0].revision), 12, 'the mark never goes down');
  });

  test('the host attestation row can be revoked once but never edited, restored or deleted', async () => {
    await host().post(`/api/v1/meeting-ai/meetings/${meet}/consents`, { attest: true, notice_version: 'v1' });
    const row = (await q(`SELECT id FROM portal.meeting_ai_consents WHERE meet_meeting_id=$1 AND revoked_at IS NULL LIMIT 1`, [meet]))[0];
    await assert.rejects(db.pool.query(`UPDATE portal.meeting_ai_consents SET notice_text='edited' WHERE id=$1`, [row.id]), /only the revocation fields/);
    await assert.rejects(db.pool.query(`DELETE FROM portal.meeting_ai_consents WHERE id=$1`, [row.id]), /cannot be deleted/);
    await db.pool.query(`UPDATE portal.meeting_ai_consents SET revoked_at=now(), revoked_by=$2 WHERE id=$1`, [row.id, H.sub]);
    await assert.rejects(db.pool.query(`UPDATE portal.meeting_ai_consents SET revoked_at=NULL WHERE id=$1`, [row.id]), /cannot be changed or restored/);
  });

  test('M4: text of a job that ended without publishing is purged after a day, whatever the retention setting', async () => {
    await host().post(`/api/v1/meeting-ai/meetings/${meet}/consents`, { attest: true, notice_version: 'v1' });
    const j = await host().post('/api/v1/meeting-ai/jobs', { meet_meeting_id: meet, source: 'transcript_import', idempotency_key: key(), transcript: { format: 'txt', text: 'Dana: we decided to ship' } }); assert.equal(j.status, 202, JSON.stringify(j.body));
    await db.pool.query(`UPDATE portal.meeting_ai_jobs SET status='failed', error_code='test', finished_at=now() - interval '2 days' WHERE id=$1`, [j.body.id]);
    const t = async () => (await q('SELECT purged_at, full_text FROM portal.meeting_transcripts WHERE job_id=$1', [j.body.id]))[0];
    assert.ok((await t()).full_text.length > 0, 'the text is stored while the job exists'); await app.ai.worker.purgeExpired(0); const row = await t(); assert.ok(row.purged_at, 'purged'); assert.equal(row.full_text, '');
  });

  test('L2: a job whose worker keeps dying is failed after the attempt limit instead of being taken over forever', async () => {
    await host().post(`/api/v1/meeting-ai/meetings/${meet}/consents`, { attest: true, notice_version: 'v1' });
    const j = await host().post('/api/v1/meeting-ai/jobs', { meet_meeting_id: meet, source: 'meet_chat', idempotency_key: key() }); assert.equal(j.status, 202);
    await db.pool.query(`UPDATE portal.meeting_ai_jobs SET status='running', attempts=5, lease_token=gen_random_uuid(), lease_until=now() - interval '1 minute' WHERE id=$1`, [j.body.id]);
    const calls = llmd.st.requests.length; await app.ai.worker.runOne();
    const job = (await host().get('/api/v1/meeting-ai/jobs/' + j.body.id)).body; assert.equal(job.status, 'failed'); assert.equal(job.error_code, 'interrupted_too_often');
    assert.equal(llmd.st.requests.length, calls, 'the model was not called again');
  });
});
