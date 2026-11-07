import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createA49Accounting } from '../server/telephony/a49-accounting.mjs';
import { createAccountingOutbox, PermanentDeliveryError } from '../server/telephony/a410-outbox.mjs';
import { createSimulatedBilling } from '../server/telephony/a410-simulated-billing.mjs';
import { createWorkspaceBindings } from '../server/telephony/a412-workspace-bindings.mjs';

const url = process.env.A49_TEST_DATABASE_URL;
const skip = url ? false : 'A49_TEST_DATABASE_URL must point to a dedicated disposable database';
let pool;
const workspaceId = randomUUID(), meetCallId = randomUUID(), principal = { id: 'test' };
const allowed = async () => true;
const cdr = (overrides = {}) => Buffer.from(JSON.stringify({
  carrierId: 'carrier-test', cdrId: 'cdr-test', meetCallId, seconds: 60, amountMinor: 10, currency: 'USD', ...overrides
}));

test.before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: url });
  const found = await pool.query("SELECT 1 FROM pg_namespace WHERE nspname='portal'");
  if (found.rowCount) throw new Error('Tests require an empty disposable database with no portal schema');
  for (const file of ['001.sql', '006_meeting_directory.sql'])
    await pool.query(await readFile(new URL('../../meet-sync/sql/' + file, import.meta.url), 'utf8'));
  for (const file of ['001_portal.sql', '002_billing.sql', '004_meeting_ai.sql', '005_phone.sql',
    '006_workspace_tools.sql', '007_billing_launch.sql', '008_ai_gateway.sql', '009_meet_ai_consent.sql',
    '010_consent_fence.sql', '011_consent_hardening.sql', '012_a49_accounting.sql', '013_a410_accounting_outbox.sql',
    '014_a410_simulated_billing.sql', '015_a412_workspace_bindings.sql'])
    await pool.query(await readFile(new URL('../sql/' + file, import.meta.url), 'utf8'));
  await pool.query('INSERT INTO portal.workspaces(id,name) VALUES($1,$2)', [workspaceId, 'Test']);
});
test.after(async () => { if (pool) await pool.end(); });

test('requires all authoritative adapters even before any network surface is mounted', () => {
  assert.throws(() => createA49Accounting({ pool: {} }), /authorizers/);
  assert.throws(() => createWorkspaceBindings({ pool: {} }), /authoritative/);
});

test('workspace bindings enforce injected authorization, isolation, audit and idempotency', { skip }, async () => {
  const meetingId = randomUUID(), requestId = randomUUID(), actor = 'svc:workspace-provisioner';
  const service = createWorkspaceBindings({ pool, authorize: async ({ principal, workspaceId: ws }) => principal === actor && ws === workspaceId, verifyMeeting: allowed });
  const request = { principal: actor, requestId, workspaceId, meetingId, action: 'bind' };
  const results = await Promise.all([service.apply(request), service.apply(request)]);
  assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM portal.a412_binding_audit WHERE meeting_id=$1', [meetingId])).rows[0].n, 1);
  await assert.rejects(service.apply({ ...request, action: 'revoke' }), { code: 'BINDING_IDEMPOTENCY_CONFLICT' });
  await assert.rejects(service.apply({ ...request, requestId: randomUUID(), principal: 'svc:other' }), { code: 'BINDING_DENIED' });
  const otherWorkspace = randomUUID();
  await pool.query('INSERT INTO portal.workspaces(id,name) VALUES($1,$2)', [otherWorkspace, 'Other']);
  const broad = createWorkspaceBindings({ pool, authorize: allowed, verifyMeeting: allowed });
  await assert.rejects(broad.apply({ ...request, requestId: randomUUID(), workspaceId: otherWorkspace }), { code: 'BINDING_CONFLICT' });
  assert.equal((await service.apply({ ...request, requestId: randomUUID(), action: 'suspend' })).status, 'suspended');
  await assert.rejects(service.apply({ ...request, requestId: randomUUID() }), { code: 'BINDING_SUSPENDED' });
  assert.equal((await service.apply({ ...request, requestId: randomUUID(), action: 'resume' })).status, 'active');
  assert.equal((await service.apply({ ...request, requestId: randomUUID(), action: 'revoke' })).status, 'revoked');
  await assert.rejects(service.apply({ ...request, requestId: randomUUID(), action: 'resume' }), { code: 'BINDING_REVOKED' });
  await assert.rejects(pool.query("UPDATE portal.a412_workspace_meetings SET status='active' WHERE meeting_id=$1", [meetingId]), /cannot be restored/);
  await assert.rejects(pool.query('DELETE FROM portal.a412_workspace_meetings WHERE meeting_id=$1', [meetingId]), /immutable/);
});

test('concurrent workspace claims cannot assign one meeting to two tenants', { skip }, async () => {
  const otherWorkspace = randomUUID(), meetingId = randomUUID();
  await pool.query('INSERT INTO portal.workspaces(id,name) VALUES($1,$2)', [otherWorkspace, 'Concurrent']);
  const service = createWorkspaceBindings({ pool, authorize: allowed, verifyMeeting: allowed });
  const requests = [workspaceId, otherWorkspace].map(ws => ({
    principal: 'svc:workspace-provisioner', requestId: randomUUID(), workspaceId: ws, meetingId, action: 'bind'
  }));
  const results = await Promise.allSettled(requests.map(request => service.apply(request)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'BINDING_CONFLICT');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM portal.a412_binding_audit WHERE meeting_id=$1', [meetingId])).rows[0].n, 1);
});

test('workspace binding verification and audit failure roll back the entire request', { skip }, async () => {
  const meetingId = randomUUID(), requestId = randomUUID();
  const request = { principal: 'svc:workspace-provisioner', requestId, workspaceId, meetingId, action: 'bind' };
  const unverified = createWorkspaceBindings({ pool, authorize: allowed, verifyMeeting: async () => false });
  await assert.rejects(unverified.apply(request), { code: 'MEETING_UNVERIFIED' });
  const service = createWorkspaceBindings({ pool, authorize: allowed, verifyMeeting: allowed });
  await pool.query("ALTER TABLE portal.a412_binding_audit ADD CONSTRAINT test_reject_bind CHECK (action <> 'bind') NOT VALID");
  try {
    await assert.rejects(service.apply(request), { code: '23514' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM portal.a412_workspace_meetings WHERE meeting_id=$1', [meetingId])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM portal.a412_binding_requests WHERE request_id=$1', [requestId])).rows[0].n, 0);
  } finally { await pool.query('ALTER TABLE portal.a412_binding_audit DROP CONSTRAINT test_reject_bind'); }
  assert.equal((await service.apply(request)).status, 'active');
});

test('A5 call binding, rating and CDR are idempotent and do not write call state', { skip }, async () => {
  const service = createA49Accounting({ pool, authorizeMeetCall: allowed, authorizeCarrier: allowed, authorizeRating: allowed });
  const binding = { principal, meetCallId, workspaceId, sourceKey: 'a5-call-test' };
  assert.deepEqual(await service.bindCall(binding), { replayed: false });
  assert.deepEqual(await service.bindCall(binding), { replayed: true });
  await assert.rejects(service.bindCall({ ...binding, sourceKey: 'another-key' }), { code: 'CALL_REFERENCE_CONFLICT' });
  assert.deepEqual(await service.ingestCdr({ principal, rawBody: cdr() }), { replayed: false, status: 'pending' });
  assert.deepEqual(await service.ingestCdr({ principal, rawBody: cdr() }), { replayed: true, status: 'pending' });
  await assert.rejects(service.ingestCdr({ principal, rawBody: cdr({ amountMinor: 11 }) }), { code: 'CDR_CONFLICT' });
  const rating = { principal, meetCallId, workspaceId, seconds: 60, amountMinor: 10, currency: 'USD', tariffVersion: 'tariff-1' };
  assert.deepEqual(await service.recordRating(rating), { replayed: false });
  assert.deepEqual(await service.recordRating(rating), { replayed: true });
  await assert.rejects(service.recordRating({ ...rating, seconds: 61 }), { code: 'RATING_CONFLICT' });
  assert.deepEqual(await service.ingestCdr({ principal, rawBody: cdr() }), { replayed: true, status: 'matched' });
  assert.deepEqual(await service.ingestCdr({ principal, rawBody: cdr({ cdrId: 'cdr-second', seconds: 61 }) }), { replayed: false, status: 'disputed' });
});

test('authorization and workspace checks fail closed', { skip }, async () => {
  const denied = async () => false;
  const service = createA49Accounting({ pool, authorizeMeetCall: denied, authorizeCarrier: denied, authorizeRating: denied });
  await assert.rejects(service.bindCall({ principal, meetCallId, workspaceId, sourceKey: 'a5-call-test' }), { code: 'MEET_CALL_DENIED' });
  await assert.rejects(service.ingestCdr({ principal, rawBody: cdr() }), { code: 'CARRIER_DENIED' });
  await assert.rejects(service.recordRating({ principal, meetCallId, workspaceId, seconds: 60, amountMinor: 10, currency: 'USD', tariffVersion: 'tariff-1' }), { code: 'RATING_DENIED' });
  const authorized = createA49Accounting({ pool, authorizeMeetCall: allowed, authorizeCarrier: allowed, authorizeRating: allowed });
  await assert.rejects(authorized.recordRating({ principal, meetCallId, workspaceId: randomUUID(), seconds: 60, amountMinor: 10, currency: 'USD', tariffVersion: 'tariff-1' }), { code: 'CALL_REFERENCE_NOT_FOUND' });
});

test('concurrent CDR retries write exactly one record', { skip }, async () => {
  const service = createA49Accounting({ pool, authorizeMeetCall: allowed, authorizeCarrier: allowed, authorizeRating: allowed });
  const rawBody = cdr({ cdrId: 'cdr-concurrent' });
  const results = await Promise.all([service.ingestCdr({ principal, rawBody }), service.ingestCdr({ principal, rawBody })]);
  assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]);
});

test('outbox records each new rating and CDR exactly once', { skip }, async () => {
  const rows = await pool.query('SELECT topic,count(*)::int AS n FROM portal.a410_accounting_outbox GROUP BY topic ORDER BY topic');
  assert.deepEqual(rows.rows, [
    { topic: 'accounting.cdr_recorded', n: 3 },
    { topic: 'accounting.rating_recorded', n: 1 }
  ]);
});

test('workers use exclusive leases, fencing, retries, and crash recovery', { skip }, async () => {
  const log = { error() {} }, deliver = async () => {};
  const first = createAccountingOutbox({ pool, deliver, log, maxAttempts: 2 });
  const second = createAccountingOutbox({ pool, deliver, log, maxAttempts: 2 });
  const [a, b] = await Promise.all([first.lease(randomUUID(), 2), second.lease(randomUUID(), 2)]);
  assert.equal(a.length + b.length, 4);
  assert.equal(new Set([...a, ...b].map(x => x.id)).size, 4);
  const old = a[0], done = b[0];
  await second.finish(done, true);
  await first.finish(old, false, 'unavailable');
  await assert.rejects(first.finish(old, true), { code: 'OUTBOX_LEASE_LOST' });
  let state = await pool.query('SELECT attempts,delivered_at,next_attempt_at > now() AS delayed FROM portal.a410_accounting_outbox WHERE id=$1', [old.id]);
  assert.equal(state.rows[0].attempts, 1); assert.equal(state.rows[0].delivered_at, null); assert.equal(state.rows[0].delayed, true);
  await pool.query("UPDATE portal.a410_accounting_outbox SET lease_until=now()-interval '1 second' WHERE id=$1", [a[1].id]);
  const recovered = await second.lease(randomUUID(), 1);
  assert.equal(recovered[0].id, a[1].id);
  await assert.rejects(first.finish(a[1], true), { code: 'OUTBOX_LEASE_LOST' });
  await second.finish(recovered[0], true);
  await pool.query("UPDATE portal.a410_accounting_outbox SET next_attempt_at=now()-interval '1 second' WHERE id=$1", [old.id]);
  const retry = await first.lease(randomUUID(), 1);
  assert.equal(retry[0].id, old.id);
  await first.finish(retry[0], false, 'still unavailable');
  state = await pool.query('SELECT attempts,dead_lettered_at FROM portal.a410_accounting_outbox WHERE id=$1', [old.id]);
  assert.equal(state.rows[0].attempts, 2); assert.ok(state.rows[0].dead_lettered_at);
});

test('worker passes a stable delivery key and records delivery failures', { skip }, async () => {
  const key = 'delivery-test-' + randomUUID();
  await pool.query(`INSERT INTO portal.a410_accounting_outbox(event_key,topic,payload)
    VALUES($1,'accounting.rating_recorded',$2::jsonb)`, [key, JSON.stringify({ meetCallId })]);
  const seen = [], errors = [];
  const worker = createAccountingOutbox({ pool, maxAttempts: 1,
    log: { error: (...args) => errors.push(args) },
    deliver: async message => { seen.push(message); throw new Error('test delivery failed'); } });
  assert.equal(await worker.runOnce(randomUUID(), 1), 1);
  assert.equal(seen[0].eventKey, key); assert.equal(seen[0].payload.meetCallId, meetCallId);
  assert.equal(errors.length, 1);
  const r = await pool.query('SELECT attempts,dead_lettered_at,last_error FROM portal.a410_accounting_outbox WHERE event_key=$1', [key]);
  assert.equal(r.rows[0].attempts, 1); assert.ok(r.rows[0].dead_lettered_at); assert.equal(r.rows[0].last_error, 'test delivery failed');
});

test('permanent delivery errors dead-letter immediately and diagnostics expose queue counts', { skip }, async () => {
  const key = 'permanent-' + randomUUID();
  await pool.query(`INSERT INTO portal.a410_accounting_outbox(event_key,topic,payload)
    VALUES($1,'accounting.rating_recorded','{}')`, [key]);
  const outbox = createAccountingOutbox({ pool, maxAttempts: 5, log: { error() {} },
    deliver: async () => { throw new PermanentDeliveryError('consumer rejected event'); } });
  const before = await outbox.diagnostics();
  assert.equal(await outbox.runOnce(randomUUID(), 1), 1);
  const row = (await pool.query('SELECT attempts,dead_lettered_at,last_error FROM portal.a410_accounting_outbox WHERE event_key=$1', [key])).rows[0];
  assert.equal(row.attempts, 1); assert.ok(row.dead_lettered_at); assert.equal(row.last_error, 'consumer rejected event');
  const after = await outbox.diagnostics();
  assert.equal(after.dead_lettered, before.dead_lettered + 1);
  assert.equal(after.pending, before.pending - 1);
});

test('accounting transaction rolls back when its outbox cannot persist', { skip }, async () => {
  const service = createA49Accounting({ pool, authorizeMeetCall: allowed, authorizeCarrier: allowed, authorizeRating: allowed });
  const rawBody = cdr({ cdrId: 'cdr-rollback' });
  await pool.query(`ALTER TABLE portal.a410_accounting_outbox ADD CONSTRAINT test_reject_cdr CHECK (topic <> 'accounting.cdr_recorded') NOT VALID`);
  try {
    await assert.rejects(service.ingestCdr({ principal, rawBody }), { code: '23514' });
    const r = await pool.query("SELECT count(*)::int AS n FROM portal.a49_carrier_cdr WHERE cdr_id='cdr-rollback'");
    assert.equal(r.rows[0].n, 0);
  } finally { await pool.query('ALTER TABLE portal.a410_accounting_outbox DROP CONSTRAINT test_reject_cdr'); }
});

test('simulated billing rates verified milliseconds and posts one balanced immutable journal', { skip }, async () => {
  await pool.query(`INSERT INTO portal.a410_simulated_tariffs(version,currency,destination,rate_micro_minor_per_second,minimum_minor,connection_minor,approved_by)
    VALUES('test-rate','USD','test-only',250000,2,1,'test-operator')`);
  const service = createSimulatedBilling({ pool, enabled: true, environment: 'test', authorize: allowed,
    verifyDuration: async () => ({ callId: meetCallId, workspaceId, durationMs: 4100, verified: true, ended: true }) });
  const request = { principal, callId: meetCallId, workspaceId, tariffVersion: 'test-rate', idempotencyKey: 'sim-test-001' };
  const results = await Promise.all([service.rate(request), service.rate(request)]);
  assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]);
  assert.equal(results[0].amountMinor, '3');
  const journalId = results[0].journalId;
  const postings = await pool.query('SELECT count(*)::int AS n,sum(amount_minor)::int AS total FROM portal.a410_simulated_postings WHERE journal_id=$1', [journalId]);
  assert.deepEqual(postings.rows[0], { n: 2, total: 0 });
  await assert.rejects(service.rate({ ...request, idempotencyKey: 'sim-test-002' }), /CALL_ALREADY_SIMULATED/);
  await assert.rejects(pool.query('UPDATE portal.a410_simulated_journal SET amount_minor=0 WHERE id=$1', [journalId]), /immutable/);
  await assert.rejects(pool.query("DELETE FROM portal.a410_simulated_postings WHERE journal_id=$1", [journalId]), /immutable/);
});

test('simulated billing rejects production and unverified duration', { skip }, async () => {
  assert.throws(() => createSimulatedBilling({ pool, enabled: true, environment: 'production' }), /disabled/);
  const service = createSimulatedBilling({ pool, enabled: true, environment: 'test', authorize: allowed,
    verifyDuration: async () => ({ callId: meetCallId, workspaceId, durationMs: 1000, verified: false, ended: true }) });
  await assert.rejects(service.rate({ principal, callId: meetCallId, workspaceId, tariffVersion: 'test-rate', idempotencyKey: 'sim-test-003' }), /DURATION_UNVERIFIED/);
});

test('database refuses a simulated journal without balanced postings', { skip }, async () => {
  const secondCall = randomUUID();
  await pool.query("INSERT INTO portal.a49_call_refs(meet_call_id,workspace_id,source_key) VALUES($1,$2,'unbalanced-call')", [secondCall, workspaceId]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO portal.a410_simulated_journal(id,idempotency_key,call_id,workspace_id,tariff_version,duration_ms,seconds,amount_minor,currency)
      VALUES($1,'unbalanced-test',$2,$3,'test-rate',1000,1,1,'USD')`, [randomUUID(), secondCall, workspaceId]);
    await client.query('COMMIT');
    assert.fail('invalid journal should not commit');
  } catch (e) {
    await client.query('ROLLBACK');
    assert.match(e.message, /balanced/);
  } finally { client.release(); }
});

test('database refuses balanced postings that do not match the journal amount', { skip }, async () => {
  const callId = randomUUID(), journalId = randomUUID();
  await pool.query('INSERT INTO portal.a49_call_refs(meet_call_id,workspace_id,source_key) VALUES($1,$2,$3)', [callId, workspaceId, 'mismatch-' + callId]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO portal.a410_simulated_journal(id,idempotency_key,call_id,workspace_id,tariff_version,duration_ms,seconds,amount_minor,currency)
      VALUES($1,$2,$3,$4,'test-rate',1000,1,1,'USD')`, [journalId, 'mismatch-' + callId, callId, workspaceId]);
    await client.query(`INSERT INTO portal.a410_simulated_postings(journal_id,account,amount_minor)
      VALUES($1,'customer',2),($1,'simulated_revenue',-2)`, [journalId]);
    await assert.rejects(client.query('COMMIT'), /matching its amount/);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('outbox delivers a bounded batch concurrently and treats even a null rejection as failure', { skip }, async () => {
  const prefix = 'parallel-' + randomUUID();
  for (let n = 0; n < 2; n++) await pool.query(`INSERT INTO portal.a410_accounting_outbox(event_key,topic,payload)
    VALUES($1,'accounting.rating_recorded','{}')`, [prefix + '-' + n]);
  let active = 0, peak = 0;
  const outbox = createAccountingOutbox({ pool, random: () => 0, log: { error() {} },
    deliver: async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 50)); active--;
      throw null;
    } });
  const before = (await pool.query('SELECT clock_timestamp() AS t')).rows[0].t;
  assert.equal(await outbox.runOnce(randomUUID(), 2), 2);
  assert.equal(peak, 2);
  const rows = await pool.query(`SELECT delivered_at,dead_lettered_at,attempts,next_attempt_at,
    clock_timestamp() AS checked_at FROM portal.a410_accounting_outbox WHERE event_key LIKE $1`, [prefix + '%']);
  assert.equal(rows.rowCount, 2);
  for (const row of rows.rows) {
    assert.equal(row.delivered_at, null); assert.equal(row.dead_lettered_at, null); assert.equal(row.attempts, 1);
    assert.ok(row.next_attempt_at >= new Date(before.getTime() + 1000));
    assert.ok(row.next_attempt_at <= new Date(row.checked_at.getTime() + 1000));
  }
});
