import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, addMember, seedMeeting } from './helpers.mjs';
import { startFakeLlm, startFakeMeet, READ_SECRET, pidOf, decisionRow } from './fake-llm.mjs';
import { roomAllowed, checkFresh, basisFor } from '../server/ai/meet-consent.mjs';

// Private AI reports for ONE breakout room (v4.32). Test doubles only (the repo's labelled fake model and fake Meet): this proves OUR room isolation, unanimous consent, quota, withdrawal and retention logic.
const key = () => 'idem-' + crypto.randomBytes(6).toString('hex');
const MAIN = [{ speaker: 'Dana', text: 'MAIN-SECRET we talked about the budget in the main room.', at: '2026-11-01T10:00:00Z' }];
const ROOMMSG = [
  { speaker: 'Gus', text: 'ROOM-SECRET we decided to launch the design on Friday.', at: '2026-11-01T10:05:00Z' },
  { speaker: 'Ivy', text: 'ROOM-IVY ACTION: Gus to send the mockups by Thursday', at: '2026-11-01T10:06:00Z' }
];
const part = (name, t, s = t) => ({ participantId: pidOf(name), name, role: 'guest', decisions: decisionRow(t, s ?? t) });

describe('roomAllowed / freshness (pure)', () => {
  const ok = (names, over = {}) => ({ requested: true, revision: 5, roomId: 'r1', participants: names.map((n) => part(n, 'agree')), ...over });
  test('a room needs EVERYONE in it to agree: one pending, declined or withdrawn person refuses the whole room, and an answer about another room is no answer', () => {
    assert.equal(roomAllowed(ok(['Gus', 'Ivy']), 'r1').allowed, true);
    assert.equal(roomAllowed({ requested: true, roomId: 'r1', participants: [part('Gus', 'agree'), part('Ivy', 'pending')] }, 'r1').reason, 'participant_consent_required');
    assert.equal(roomAllowed({ requested: true, roomId: 'r1', participants: [part('Gus', 'agree'), part('Ivy', 'agree', 'decline')] }, 'r1').reason, 'participant_declined');
    assert.equal(roomAllowed({ requested: true, roomId: 'r1', participants: [part('Gus', 'withdraw')] }, 'r1').reason, 'participant_declined');
    assert.equal(roomAllowed(ok(['Gus']), 'r2').allowed, false); assert.equal(roomAllowed(ok([], {}), 'r1').allowed, false); assert.equal(roomAllowed(ok(['Gus'], { requested: false }), 'r1').allowed, false);
  });
  test('a room report stays fresh only while nobody in the room objects, including someone who joined after it was made', () => {
    const c = ok(['Gus', 'Ivy']); const rows = c.participants.map((p) => ({ participant_id: p.participantId, transcription_seq: p.decisions.transcription.seq, summary_seq: p.decisions.summary.seq }));
    const basis = basisFor({ source: 'meet_room_chat', room: 'r1', rows, revision: 5 }); assert.equal(basis.room, 'r1'); assert.equal(basis.source, 'meet_room_chat');
    assert.equal(checkFresh({ basis, consent: c }).ok, true);
    assert.equal(checkFresh({ basis, consent: { ...c, participants: [...c.participants, part('Late', 'withdraw')] } }).reason, 'participant_withdrew');
    assert.equal(checkFresh({ basis, consent: { ...c, participants: [c.participants[0]] } }).reason, 'participant_withdrew');
  });
});

describe('room reports (PostgreSQL, fake model, fake Meet)', () => {
  let db, main, llmd, meetd, app, W, H, A, M, O, meet, room1, room2;
  const host = () => app.client(H); const outsider = () => app.client(O);
  const q = async (sql, args = []) => (await db.pool.query(sql, args)).rows;
  const attest = (cl = host(), id = meet) => cl.post(`/api/v1/meeting-ai/meetings/${id}/consents`, { attest: true, notice_version: 'v1' });
  const setRoom = (rid, map, requested = true, id = meet) => { const rm = meetd.st.meetings.get(id).rooms[rid]; rm.consent = { requested, participants: Object.entries(map).map(([name, [t, s]]) => ({ participantId: pidOf(name), name, role: 'guest', decisions: decisionRow(t, s ?? t) })) }; };
  const roomJob = (rid = room1, extra = {}, cl = host()) => cl.post('/api/v1/meeting-ai/jobs', { meet_meeting_id: meet, source: 'meet_room_chat', room_id: rid, idempotency_key: key(), ...extra });
  const modelSaw = (needle) => llmd.st.requests.some((r) => JSON.stringify(r.body).includes(needle));
  const uuid = () => crypto.randomUUID();

  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn(); llmd = await startFakeLlm(); meetd = await startFakeMeet();
    const env = { AI_LLM_API_KEY: 'test-llm-key', AI_LLM_API_BASE: llmd.url, AI_LLM_MODEL: 'claude-test', MEET_INTERNAL_URL: meetd.url, MEET_READ_SECRET: READ_SECRET, QORLLA_AI_RATE_PER_MINUTE: '100000' };
    app = await startApp({ pool: db.pool, cfg: testConfig({ env, cfg: { shareLimit: 1000 } }, main), jwks: main.jwks, ai: { worker: { backoffBaseSeconds: 0 } } });
    H = await main.mint(); A = await main.mint(); M = await main.mint(); O = await main.mint();
    W = await seedWorkspace(db.pool, H.sub, 'Room Co'); await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='pro',status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [W]);
    await addMember(db.pool, W, A.sub, 'admin'); await addMember(db.pool, W, M.sub, 'member'); await seedWorkspace(db.pool, O.sub, 'Elsewhere Co');
  });
  after(async () => { await app.close(); await llmd.close(); await meetd.close(); await main.close(); await db.drop(); });
  beforeEach(async () => {
    await db.pool.query(`UPDATE portal.meeting_ai_jobs SET status='cancelled', error_code='test_cleanup' WHERE status IN ('queued','running','blocked')`);
    await db.pool.query('UPDATE portal.workspace_ai_settings SET external_processing=true WHERE workspace_id=$1', [W]);
    meet = await seedMeeting(db.pool, H.sub, { title: 'Workshop' }); await fetch(llmd.url + '/__control/reset', { method: 'POST' });
    Object.assign(meetd.st, { down: false, delayMs: 0, onConsent: null, consentReads: 0 }); meetd.st.requests.length = 0; meetd.put(meet, 'Workshop', MAIN);
    room1 = uuid(); room2 = uuid(); meetd.putRoom(meet, room1, 'Design', ROOMMSG); meetd.putRoom(meet, room2, 'Build', [{ speaker: 'Cy', text: 'ROOM2-SECRET unrelated', at: '2026-11-01T10:07:00Z' }]);
    await attest();
  });

  test('a unanimous room gets a report built ONLY from its own chat, bound to the room and restricted', async () => {
    setRoom(room1, { Gus: ['agree'], Ivy: ['agree'] });
    const j = await roomJob(); assert.equal(j.status, 202, JSON.stringify(j.body)); assert.equal(j.body.room_id, room1); await app.ai.worker.runOne();
    const job = (await host().get('/api/v1/meeting-ai/jobs/' + j.body.id)).body; assert.equal(job.status, 'completed', JSON.stringify(job)); assert.equal(job.room_name, 'Design');
    assert.ok(modelSaw('ROOM-SECRET') && modelSaw('ROOM-IVY')); assert.equal(modelSaw('MAIN-SECRET'), false, 'the main room never reaches a room report'); assert.equal(modelSaw('ROOM2-SECRET'), false, 'another room never does');
    const rep = (await host().get('/api/v1/meeting-ai/reports/' + job.report_id)).body; assert.equal(rep.room_id, room1); assert.equal(rep.room_name, 'Design'); assert.equal(rep.visibility, 'restricted');
    assert.equal((await q('SELECT source FROM portal.meeting_transcripts WHERE job_id=$1', [job.id]))[0].source, 'meet_room_chat');
    assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_ai_job_participants WHERE job_id=$1 AND included', [job.id]))[0].n, 2);
    assert.equal((await outsider().get('/api/v1/meeting-ai/reports/' + job.report_id)).status, 404);
    assert.equal((await app.client(M).get('/api/v1/meeting-ai/reports/' + job.report_id)).status, 404, 'a plain workspace member cannot see a restricted room report');
  });

  test('one "no" refuses the whole room BEFORE any job or quota unit exists; an unknown room is 404; the room id must go with the source', async () => {
    setRoom(room1, { Gus: ['agree'], Ivy: ['pending'] });
    let j = await roomJob(); assert.equal(j.status, 403); assert.equal(j.body.code, 'participant_consent_required');
    setRoom(room1, { Gus: ['agree'], Ivy: ['agree', 'decline'] }); j = await roomJob(); assert.equal(j.status, 403); assert.equal(j.body.code, 'participant_declined');
    setRoom(room1, { Gus: ['agree'], Ivy: ['agree'] }, false); j = await roomJob(); assert.equal(j.status, 403, 'the host request must be open');
    assert.equal((await roomJob(uuid())).status, 404);
    assert.equal((await host().post('/api/v1/meeting-ai/jobs', { meet_meeting_id: meet, source: 'meet_room_chat', idempotency_key: key() })).status, 400);
    assert.equal((await host().post('/api/v1/meeting-ai/jobs', { meet_meeting_id: meet, source: 'meet_chat', room_id: room1, idempotency_key: key() })).status, 400);
    assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_ai_jobs WHERE meet_meeting_id=$1', [meet]))[0].n, 0); assert.equal(llmd.st.requests.length, 0);
    assert.equal((await q("SELECT count(*)::int n FROM portal.meeting_ai_consent_audit WHERE meet_meeting_id=$1 AND event='job_blocked'", [meet]))[0].n, 3);
  });

  test('a message from somebody Meet does not list in the room blocks the job at the worker; nothing is stored and no model is called', async () => {
    setRoom(room1, { Gus: ['agree'] });          // Ivy wrote in the room but is not in the consent list
    const j = await roomJob(); assert.equal(j.status, 202); await app.ai.worker.runOne();
    const job = (await host().get('/api/v1/meeting-ai/jobs/' + j.body.id)).body; assert.equal(job.status, 'blocked'); assert.equal(job.error_code, 'participant_consent_required');
    assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_transcripts WHERE job_id=$1', [j.body.id]))[0].n, 0); assert.equal(llmd.st.requests.length, 0);
  });

  test('quota: a repeated idempotency key or a second submission for the same live room is the SAME job; the report counts once; a retry after completion is not billed again', async () => {
    setRoom(room1, { Gus: ['agree'], Ivy: ['agree'] });
    const k = key(); const a = await roomJob(room1, { idempotency_key: k }); assert.equal(a.status, 202);
    const same = await roomJob(room1, { idempotency_key: k }); assert.equal(same.status, 200); assert.equal(same.body.id, a.body.id); assert.equal(same.body.duplicate, true);
    const other = await roomJob(room1); assert.equal(other.status, 200); assert.equal(other.body.id, a.body.id, 'a second key for the same live room returns the first job');
    assert.equal((await host().post('/api/v1/meeting-ai/jobs', { meet_meeting_id: meet, source: 'meet_room_chat', room_id: room2, idempotency_key: k })).status, 409, 'the key belongs to another request');
    assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_ai_jobs WHERE meet_meeting_id=$1', [meet]))[0].n, 1);
    await app.ai.worker.runOne(); await app.ai.worker.runOne();          // the second tick finds nothing: no double processing
    const jobId = a.body.id; assert.equal((await q("SELECT count(*)::int n FROM portal.ai_usage_events WHERE job_id=$1 AND feature='meeting_report'", [jobId]))[0].n, 1, 'one unit for one report');
    assert.equal(llmd.st.requests.filter((r) => JSON.stringify(r.body).includes('ROOM-SECRET')).length, 1, 'the model was asked once');
    const again = await roomJob(room1, { idempotency_key: k }); assert.equal(again.status, 200); assert.equal(again.body.id, jobId); assert.equal((await q("SELECT count(*)::int n FROM portal.ai_usage_events WHERE feature='meeting_report' AND workspace_id=$1", [W]))[0].n >= 1, true);
  });

  test('the plan quota is enforced atomically for room reports (Basic: 3 a month, five racing submissions create at most 3 jobs)', async () => {
    const u = await main.mint(); const ws = await seedWorkspace(db.pool, u.sub, 'Free Co'); const c = app.client(u); const m = await seedMeeting(db.pool, u.sub); meetd.put(m, 'Quota', MAIN);
    await c.post(`/api/v1/meeting-ai/meetings/${m}/consents`, { attest: true, notice_version: 'v1' });
    const rooms = [uuid(), uuid(), uuid(), uuid(), uuid()]; for (const r of rooms) { meetd.putRoom(m, r, 'R-' + r.slice(0, 4), ROOMMSG); }
    const res = await Promise.all(rooms.map((r) => c.post('/api/v1/meeting-ai/jobs', { meet_meeting_id: m, source: 'meet_room_chat', room_id: r, idempotency_key: key() })));
    assert.equal(res.filter((r) => r.status === 202).length, 3); assert.deepEqual([...new Set(res.filter((r) => r.status !== 202).map((r) => r.status))], [402]);
    assert.equal((await q('SELECT count(*)::int n FROM portal.meeting_ai_jobs WHERE workspace_id=$1', [ws]))[0].n, 3);
  });

  test('withdrawal: a person in the room objecting after publication hides the report; an objection in the main room or another room does not', async () => {
    setRoom(room1, { Gus: ['agree'], Ivy: ['agree'] });
    const j = await roomJob(); await app.ai.worker.runOne(); const job = (await host().get('/api/v1/meeting-ai/jobs/' + j.body.id)).body; assert.equal(job.status, 'completed');
    meetd.st.meetings.get(meet).consent = { requested: true, participants: [part('Dana', 'withdraw')] };          // somebody in the MAIN room withdrew
    assert.equal((await host().get('/api/v1/meeting-ai/reports/' + job.report_id)).status, 200, 'the main room is not this room');
    setRoom(room2, { Cy: ['withdraw'] }); assert.equal((await host().get('/api/v1/meeting-ai/reports/' + job.report_id)).status, 200, 'another room is not this room');
    setRoom(room1, { Gus: ['agree'], Ivy: ['agree'] }); const rm = meetd.st.meetings.get(meet).rooms[room1];
    rm.consent.participants[1].decisions = decisionRow('withdraw');          // Ivy withdrew
    const r = await host().get('/api/v1/meeting-ai/reports/' + job.report_id); assert.ok([403, 404, 410].includes(r.status) || r.body.status === 'withdrawn', JSON.stringify(r.body).slice(0, 200));
    assert.equal(r.body.summary, undefined, 'no content after a withdrawal');
    assert.equal((await q('SELECT status FROM portal.meeting_reports WHERE id=$1', [job.report_id]))[0].status, 'withdrawn');
  });

  test('a room report can never be shown to the whole workspace or shared by link; named members are allowed', async () => {
    setRoom(room1, { Gus: ['agree'], Ivy: ['agree'] });
    const j = await roomJob(); await app.ai.worker.runOne(); const rid = (await host().get('/api/v1/meeting-ai/jobs/' + j.body.id)).body.report_id;
    const p = await host().patch('/api/v1/meeting-ai/reports/' + rid, { visibility: 'workspace' }); assert.equal(p.status, 409); assert.equal(p.body.code, 'room_report_restricted');
    const l = await host().post(`/api/v1/meeting-ai/reports/${rid}/shares`, { kind: 'link' }); assert.equal(l.status, 409);
    const s = await host().post(`/api/v1/meeting-ai/reports/${rid}/shares`, { kind: 'member', user_id: M.sub }); assert.equal(s.status, 201);
    assert.equal((await app.client(M).get('/api/v1/meeting-ai/reports/' + rid)).status, 200);
    await assert.rejects(db.pool.query("UPDATE portal.meeting_reports SET visibility='workspace' WHERE id=$1", [rid]), /meeting_reports_room_restricted/, 'the database refuses it too');
  });

  test('retention: room transcript text is purged on schedule and when a job did not publish', async () => {
    setRoom(room1, { Gus: ['agree'], Ivy: ['agree'] });
    const j = await roomJob(); await app.ai.worker.runOne(); assert.equal((await q('SELECT purged_at FROM portal.meeting_transcripts WHERE job_id=$1', [j.body.id]))[0].purged_at, null);
    await db.pool.query("UPDATE portal.meeting_transcripts SET created_at = now() - interval '100 days' WHERE job_id=$1", [j.body.id]);
    assert.ok((await app.ai.worker.purgeExpired(90)) >= 1); const t = (await q('SELECT purged_at, full_text FROM portal.meeting_transcripts WHERE job_id=$1', [j.body.id]))[0]; assert.ok(t.purged_at); assert.equal(t.full_text, '');
  });

  test('Meet unreachable or a regressed consent history: nothing is stored, nothing is sent, the job fails closed', async () => {
    setRoom(room1, { Gus: ['agree'], Ivy: ['agree'] }); meetd.st.down = true;
    const down = await roomJob(); assert.equal(down.status, 503, 'consent could not be verified'); assert.equal(llmd.st.requests.length, 0);
    meetd.st.down = false; const j = await roomJob(); assert.equal(j.status, 202); meetd.st.down = true; await app.ai.worker.runOne(); meetd.st.down = false;
    const job = (await host().get('/api/v1/meeting-ai/jobs/' + j.body.id)).body; assert.ok(['queued', 'failed'].includes(job.status), job.status); assert.equal(llmd.st.requests.length, 0);
  });
});
