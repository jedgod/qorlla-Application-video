import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { TRANSITIONS } from '../server/phone-lifecycle.mjs';

const url = process.env.PHONE_TEST_DATABASE_URL;
const skip = url ? false : 'PHONE_TEST_DATABASE_URL must point to a disposable database';
let admin, db, schema, legacyCall, unrecordedCall;

test.before(async () => {
  if (skip) return;
  schema = 'batch_' + randomUUID().replaceAll('-', '');
  admin = new pg.Pool({ connectionString: url });
  await admin.query('CREATE SCHEMA ' + schema);
  db = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema });
  await db.query(`CREATE TABLE phone_calls(id uuid PRIMARY KEY,meeting_id uuid NOT NULL,state text NOT NULL DEFAULT 'REQUESTED');
    CREATE TABLE phone_call_events(id bigserial PRIMARY KEY,call_id uuid NOT NULL REFERENCES phone_calls(id),
    from_state text,to_state text NOT NULL,reason text,at timestamptz NOT NULL DEFAULT now())`);
  legacyCall = randomUUID();
  await db.query('INSERT INTO phone_calls(id,meeting_id) VALUES($1,$2)', [legacyCall, randomUUID()]);
  await db.query(`INSERT INTO phone_call_events(call_id,from_state,to_state) VALUES
    ($1,NULL,'REQUESTED'),($1,'REQUESTED','VERIFIED')`, [legacyCall]);
  unrecordedCall = randomUUID();
  await db.query("INSERT INTO phone_calls(id,meeting_id,state) VALUES($1,$2,'TIMED_OUT')", [unrecordedCall, randomUUID()]);
  for (const file of ['v4_26_phone_event_outbox.sql', 'v4_27_phone_event_delivery.sql', 'v4_28_phone_event_batches.sql'])
    await db.query(await readFile(new URL('../sql/' + file, import.meta.url), 'utf8'));
});
test.after(async () => {
  if (db) await db.end();
  if (admin) { await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); }
});
async function newCall() {
  const id = randomUUID();
  await db.query('INSERT INTO phone_calls(id,meeting_id) VALUES($1,$2)', [id, randomUUID()]);
  return id;
}

test('one statement captures a valid ordered batch with immutable unique versions', { skip }, async () => {
  const call = await newCall();
  await db.query(`INSERT INTO phone_call_events(call_id,from_state,to_state) VALUES
    ($1,NULL,'REQUESTED'),($1,'REQUESTED','VERIFIED'),($1,'VERIFIED','APPROVED')`, [call]);
  const rows = (await db.query('SELECT source_event_id,lifecycle_version,event_type FROM phone_lifecycle_outbox WHERE call_id=$1 ORDER BY lifecycle_version', [call])).rows;
  assert.deepEqual(rows.map(row => row.lifecycle_version), ['1', '2', '3']);
  assert.deepEqual(rows.map(row => row.event_type), ['REQUESTED', 'VERIFIED', 'APPROVED']);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM phone_lifecycle_delivery d JOIN phone_lifecycle_outbox o USING(event_id) WHERE o.call_id=$1', [call])).rows[0].n, 3);
  await assert.rejects(db.query(`INSERT INTO phone_lifecycle_outbox(source_event_id,call_id,meeting_id,lifecycle_version,event_type,occurred_at)
    SELECT 999999,call_id,meeting_id,1,'REQUESTED',now() FROM phone_lifecycle_outbox WHERE call_id=$1 LIMIT 1`, [call]), { code: '23505' });
  await assert.rejects(db.query('UPDATE phone_lifecycle_outbox SET event_type=$2 WHERE call_id=$1', [call, 'VERIFIED']), /immutable/);
});

test('an invalid transition rolls back the whole batch and delivery rows', { skip }, async () => {
  const call = await newCall();
  await assert.rejects(db.query(`INSERT INTO phone_call_events(call_id,from_state,to_state) VALUES
    ($1,NULL,'REQUESTED'),($1,'REQUESTED','MEDIA_CONNECTED')`, [call]), { code: '23514' });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM phone_call_events WHERE call_id=$1', [call])).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM phone_lifecycle_outbox WHERE call_id=$1', [call])).rows[0].n, 0);
});

test('pre-snapshot history retains its offset and is not presented as a complete stream', { skip }, async () => {
  await db.query("INSERT INTO phone_call_events(call_id,from_state,to_state) VALUES($1,'VERIFIED','APPROVED')", [legacyCall]);
  const rows = (await db.query('SELECT lifecycle_version,event_type FROM phone_lifecycle_outbox WHERE call_id=$1', [legacyCall])).rows;
  assert.deepEqual(rows.map(row => [row.lifecycle_version, row.event_type]), [['3', 'APPROVED']]);
});

test('pre-migration calls without history retain their state and expose an incomplete stream', { skip }, async () => {
  await db.query("INSERT INTO phone_call_events(call_id,from_state,to_state) VALUES($1,'TIMED_OUT','ORPHANED')", [unrecordedCall]);
  await db.query("INSERT INTO phone_call_events(call_id,from_state,to_state) VALUES($1,'ORPHANED','TERMINATED')", [unrecordedCall]);
  const rows = (await db.query('SELECT lifecycle_version,event_type FROM phone_lifecycle_outbox WHERE call_id=$1 ORDER BY lifecycle_version', [unrecordedCall])).rows;
  assert.deepEqual(rows.map(row => [row.lifecycle_version, row.event_type]), [['2', 'ORPHANED'], ['3', 'TERMINATED']]);
  await assert.rejects(db.query('UPDATE phone_lifecycle_legacy_baseline SET state=$2 WHERE call_id=$1', [unrecordedCall, 'REQUESTED']), /immutable/);
});

test('commit order, not sequence allocation order, determines the previous captured state', { skip }, async () => {
  const call = await newCall();
  await db.query("INSERT INTO phone_call_events(call_id,to_state) VALUES($1,'REQUESTED')", [call]);
  const early = (await db.query("SELECT nextval('phone_call_events_id_seq') AS id")).rows[0].id;
  await db.query("INSERT INTO phone_call_events(call_id,from_state,to_state) VALUES($1,'REQUESTED','VERIFIED')", [call]);
  await db.query("INSERT INTO phone_call_events(id,call_id,from_state,to_state) VALUES($1,$2,'VERIFIED','APPROVED')", [early, call]);
  await db.query("INSERT INTO phone_call_events(call_id,from_state,to_state) VALUES($1,'APPROVED','MEDIA_CONNECTING')", [call]);
  const rows = (await db.query('SELECT event_type FROM phone_lifecycle_outbox WHERE call_id=$1 ORDER BY lifecycle_version', [call])).rows;
  assert.deepEqual(rows.map(row => row.event_type), ['REQUESTED', 'VERIFIED', 'APPROVED', 'MEDIA_CONNECTING']);
});

test('concurrent conflicting transitions serialize and exactly one commits', { skip }, async () => {
  const call = await newCall();
  await db.query("INSERT INTO phone_call_events(call_id,to_state) VALUES($1,'REQUESTED')", [call]);
  const first = await db.connect(), second = await db.connect();
  try {
    await first.query('BEGIN'); await second.query('BEGIN');
    await first.query("INSERT INTO phone_call_events(call_id,from_state,to_state) VALUES($1,'REQUESTED','VERIFIED')", [call]);
    const competing = second.query("INSERT INTO phone_call_events(call_id,from_state,to_state) VALUES($1,'REQUESTED','REFUSED')", [call]);
    await first.query('COMMIT');
    await assert.rejects(competing, { code: '23514' });
    await second.query('ROLLBACK');
    const rows = (await db.query('SELECT lifecycle_version,event_type FROM phone_lifecycle_outbox WHERE call_id=$1 ORDER BY lifecycle_version', [call])).rows;
    assert.deepEqual(rows.map(row => row.event_type), ['REQUESTED', 'VERIFIED']);
  } finally { first.release(); second.release(); }
});

test('database transition rules match the Meet lifecycle table', { skip }, async () => {
  const paths = new Map([['REQUESTED', ['REQUESTED']]]);
  const queue = ['REQUESTED'];
  while (queue.length) {
    const state = queue.shift();
    for (const next of TRANSITIONS[state]) if (!paths.has(next)) {
      paths.set(next, [...paths.get(state), next]); queue.push(next);
    }
  }
  assert.equal(paths.size, Object.keys(TRANSITIONS).length);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const [from, allowed] of Object.entries(TRANSITIONS)) {
      const call = randomUUID();
      await client.query('INSERT INTO phone_calls(id,meeting_id) VALUES($1,$2)', [call, randomUUID()]);
      let prior = null;
      for (const state of paths.get(from)) {
        await client.query('INSERT INTO phone_call_events(call_id,from_state,to_state) VALUES($1,$2,$3)', [call, prior, state]);
        prior = state;
      }
      for (const to of Object.keys(TRANSITIONS)) {
        await client.query('SAVEPOINT candidate');
        const insert = client.query('INSERT INTO phone_call_events(call_id,from_state,to_state) VALUES($1,$2,$3)', [call, from, to]);
        if (allowed.includes(to)) await insert;
        else await assert.rejects(insert, { code: '23514' }, `${from} -> ${to}`);
        await client.query('ROLLBACK TO SAVEPOINT candidate');
      }
    }
    await client.query('ROLLBACK');
  } finally { client.release(); }
});
