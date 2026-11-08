import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { createPhoneEventDelivery } from '../server/telephony/phone-event-delivery.mjs';

const url = process.env.PHONE_TEST_DATABASE_URL;
const skip = url ? false : 'PHONE_TEST_DATABASE_URL must point to a disposable database';
const log = { error() {} };
let admin, db, schema, call, other, incomplete, meeting;

test.before(async () => {
  if (skip) return;
  schema = 'delivery_' + randomUUID().replaceAll('-', '');
  admin = new pg.Pool({ connectionString: url });
  await admin.query('CREATE SCHEMA ' + schema);
  db = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema });
  await db.query(`CREATE TABLE phone_calls(id uuid PRIMARY KEY, meeting_id uuid NOT NULL);
    CREATE TABLE phone_call_events(id bigserial PRIMARY KEY,call_id uuid NOT NULL REFERENCES phone_calls(id),
      from_state text,to_state text NOT NULL,reason text,at timestamptz NOT NULL DEFAULT now())`);
  call = randomUUID(); other = randomUUID(); incomplete = randomUUID(); meeting = randomUUID();
  for (const id of [call, other, incomplete]) await db.query('INSERT INTO phone_calls VALUES($1,$2)', [id, meeting]);
  await db.query("INSERT INTO phone_call_events(call_id,to_state) VALUES($1,'REQUESTED')", [incomplete]);
  for (const file of ['v4_26_phone_event_outbox.sql', 'v4_27_phone_event_delivery.sql'])
    await db.query(await readFile(new URL('../sql/' + file, import.meta.url), 'utf8'));
  for (const [id, from, to] of [[call, null, 'REQUESTED'], [call, 'REQUESTED', 'VERIFIED'],
    [call, 'VERIFIED', 'APPROVED'], [other, null, 'REQUESTED'], [incomplete, 'REQUESTED', 'VERIFIED']])
    await db.query('INSERT INTO phone_call_events(call_id,from_state,to_state) VALUES($1,$2,$3)', [id, from, to]);
});
test.after(async () => {
  if (db) await db.end();
  if (admin) { await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); }
});

test('ordered leases are exclusive across workers and incomplete history stays blocked', { skip }, async () => {
  const outbox = createPhoneEventDelivery({ db, deliver: async () => {}, log });
  const [a, b] = await Promise.all([outbox.lease(randomUUID(), 2), outbox.lease(randomUUID(), 2)]);
  const jobs = [...a, ...b];
  assert.equal(jobs.length, 2);
  assert.deepEqual(new Set(jobs.map(j => j.event.call_id)), new Set([call, other]));
  assert.ok(jobs.every(j => j.event.lifecycle_version === '1'));
  await outbox.finish(jobs.find(j => j.event.call_id === other), true);
  const old = jobs.find(j => j.event.call_id === call);
  await db.query("UPDATE phone_lifecycle_delivery SET lease_until=now()-interval '1 second' WHERE event_id=$1", [old.event.event_id]);
  const [recovered] = await outbox.lease(randomUUID(), 1);
  assert.equal(recovered.event.event_id, old.event.event_id);
  await assert.rejects(outbox.finish(old, true), { code: 'DELIVERY_LEASE_LOST' });
  await outbox.finish(recovered, true);
  const [next] = await outbox.lease(randomUUID(), 1);
  assert.equal(next.event.call_id, call); assert.equal(next.event.lifecycle_version, '2');
  await outbox.finish(next, false, 'retry');
  const state = (await db.query('SELECT attempts,next_attempt_at > now() AS delayed FROM phone_lifecycle_delivery WHERE event_id=$1', [next.event.event_id])).rows[0];
  assert.equal(state.attempts, 1); assert.equal(state.delayed, true);
});

test('only an exact durable acknowledgement succeeds and a dead letter blocks later events', { skip }, async () => {
  await db.query("UPDATE phone_lifecycle_delivery SET next_attempt_at=now()-interval '1 second' WHERE delivered_at IS NULL");
  const errors = [];
  const outbox = createPhoneEventDelivery({ db, maxAttempts: 2, log: { error: (...args) => errors.push(args) },
    deliver: async () => ({ result: 'accepted', eventId: randomUUID() }) });
  assert.equal(await outbox.runOnce(randomUUID(), 2), 1);
  const status = (await db.query(`SELECT d.dead_lettered_at,d.delivered_at,d.last_error FROM phone_lifecycle_delivery d
    JOIN phone_lifecycle_outbox e ON e.event_id=d.event_id WHERE e.call_id=$1 AND e.lifecycle_version=2`, [call])).rows[0];
  assert.ok(status.dead_lettered_at); assert.equal(status.delivered_at, null); assert.equal(status.last_error, 'INVALID_DURABLE_ACK');
  assert.equal(errors.length, 1);
  assert.equal((await outbox.lease(randomUUID(), 10)).length, 0);
  const diagnostics = await outbox.diagnostics();
  assert.equal(diagnostics.dead_lettered, 1); assert.equal(diagnostics.pending, 2);
});

test('delivery creation and event capture roll back together', { skip }, async () => {
  const id = randomUUID(); await db.query('INSERT INTO phone_calls VALUES($1,$2)', [id, meeting]);
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const event = (await c.query("INSERT INTO phone_call_events(call_id,to_state) VALUES($1,'REQUESTED') RETURNING id", [id])).rows[0];
    assert.equal((await c.query('SELECT count(*)::int AS n FROM phone_lifecycle_delivery d JOIN phone_lifecycle_outbox e USING(event_id) WHERE e.source_event_id=$1', [event.id])).rows[0].n, 1);
    await c.query('ROLLBACK');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM phone_lifecycle_outbox WHERE call_id=$1', [id])).rows[0].n, 0);
  } finally { c.release(); }
});

test('matching durable duplicate acknowledgements complete delivery', { skip }, async () => {
  const id = randomUUID(); await db.query('INSERT INTO phone_calls VALUES($1,$2)', [id, meeting]);
  await db.query("INSERT INTO phone_call_events(call_id,to_state) VALUES($1,'REQUESTED')", [id]);
  const seen = [];
  const outbox = createPhoneEventDelivery({ db, log, deliver: async event => {
    seen.push(event); return { eventId: event.event_id, result: 'duplicate' };
  } });
  assert.equal(await outbox.runOnce(randomUUID(), 1), 1);
  assert.equal(seen[0].call_id, id);
  const row = (await db.query('SELECT delivered_at FROM phone_lifecycle_delivery WHERE event_id=$1', [seen[0].event_id])).rows[0];
  assert.ok(row.delivered_at);
});

test('a terminated worker loses its lease and a new process can recover the same event', { skip, timeout: 30000 }, async () => {
  const id = randomUUID(); await db.query('INSERT INTO phone_calls VALUES($1,$2)', [id, meeting]);
  await db.query("INSERT INTO phone_call_events(call_id,to_state) VALUES($1,'REQUESTED')", [id]);
  const moduleUrl = new URL('../server/telephony/phone-event-delivery.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import pg from 'pg';
    import { createPhoneEventDelivery } from ${JSON.stringify(moduleUrl)};
    import { randomUUID } from 'node:crypto';
    const db = new pg.Pool({ connectionString: process.env.PHONE_TEST_DATABASE_URL, options: '-c search_path=' + process.env.TEST_SCHEMA });
    const outbox = createPhoneEventDelivery({ db, deliver: async () => {}, log: console, leaseSeconds: 3 });
    const jobs = await outbox.lease(randomUUID());
    if (jobs.length !== 1) throw new Error('expected one leased event');
    console.log(jobs[0].event.event_id);
    setInterval(() => {}, 1000);
  `], { cwd: new URL('..', import.meta.url), env: { ...process.env, TEST_SCHEMA: schema }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', data => { errors += data.toString(); });
  try {
    const eventId = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker did not lease event: ' + errors)), 12000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('worker exited before leasing: ' + code + ' ' + errors)); });
      child.stdout.once('data', data => { clearTimeout(timer); resolve(data.toString().trim()); });
    });
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill(); await exited;
    await new Promise(resolve => setTimeout(resolve, 3500));
    const outbox = createPhoneEventDelivery({ db, deliver: async () => {}, log });
    const [recovered] = await outbox.lease(randomUUID());
    assert.equal(recovered.event.event_id, eventId); assert.equal(recovered.event.call_id, id);
    await outbox.finish(recovered, true);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
});
