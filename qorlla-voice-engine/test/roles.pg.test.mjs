// Least privilege (v1.9 hardening requirement): the whole engine runs as a database role that can read and write data but cannot change the schema, truncate, or touch the certification record.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { isolatedDb, identityProvider, testDbUrl, wait } from './helpers.mjs';
import { harness, until, SDP } from './harness.mjs';

let db, idp, h, r, appPool, role, ext;
before(async () => {
  db = await isolatedDb(); if (!db) return; idp = await identityProvider();
  role = 'qv_app_' + randomBytes(4).toString('hex'); const password = randomBytes(12).toString('hex'), owner = (await db.admin.query('SELECT current_user AS u')).rows[0].u;
  const sql = readFileSync(new URL('../deploy/roles.sql', import.meta.url), 'utf8').replaceAll('{{APP_ROLE}}', role).replaceAll('{{APP_PASSWORD}}', password).replaceAll('{{SCHEMA}}', db.schema).replaceAll('{{OWNER}}', owner);
  await db.admin.query(sql);                                                                                       // as the owner: the grants are applied after the migrations, as in a real deployment
  const u = new URL(testDbUrl()); u.username = role; u.password = password;
  appPool = new pg.Pool({ connectionString: u.toString(), options: '-c search_path=' + db.schema, max: 10 }); appPool.on('error', () => {});
  h = harness({ db: { pool: appPool }, idp }); r = await h.replica({ maintenanceMs: 150 }); ext = await h.people(r, ['alice', 'bob']);
});
after(async () => {
  if (h) await h.closeAll(); if (idp) await idp.close(); if (appPool) await appPool.end().catch(() => {});
  if (db) { await db.drop(); await db.admin?.query(`DROP OWNED BY ${role}`).catch(() => {}); }
});
const skip = (t) => !db && t.skip('no PostgreSQL reachable');

test('the engine works end to end as the restricted role: provisioning, calls, rooms, events, replay, outbox, maintenance', async (t) => {
  if (skip(t)) return;
  assert.deepEqual((await appPool.query('SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
  const a = await r.connect('alice'), b = await r.connect('bob'); const d = await r.dial('alice', ext.bob); assert.equal(d.status, 201);
  assert.ok(await until(() => b.of('incoming')[0]), 'the outbox worker delivered as the restricted role'); assert.equal((await r.answer(d.body.call.id, 'bob')).status, 200);
  a.send({ type: 'offer', callId: d.body.call.id, generation: 1, sdp: SDP }); assert.ok(await until(() => b.of('offer')[0]));
  assert.equal((await r.api('alice', 'POST', `/v1/voice/calls/${d.body.call.id}/device`, { deviceId: r.device('alice', 'd2') })).status, 200);
  assert.equal((await r.api('bob', 'GET', '/v1/voice/events?after=0')).status, 200); assert.equal((await r.api('bob', 'POST', `/v1/voice/calls/${d.body.call.id}/end`, {})).status, 200);
  await db.pool.query("UPDATE voice_calls SET created_at = now() - interval '1 hour' WHERE false");              // (maintenance below runs as the restricted role)
  await r.voice.maint.runOnce(); await r.voice.reliability.prune(1);                                             // DELETE on events/tickets is data access, allowed
  assert.equal((await r.api('alice', 'GET', '/v1/voice/history')).status, 200);
  const room = await r.api('alice', 'POST', '/v1/voice/rooms', { extensions: [ext.bob], deviceId: r.device('alice') }); assert.equal(room.status, 201);
  assert.equal((await r.api('bob', 'POST', `/v1/voice/rooms/${room.body.room.id}/join`, { deviceId: r.device('bob') })).status, 200); await r.api('bob', 'POST', `/v1/voice/rooms/${room.body.room.id}/leave`, {}); await r.api('alice', 'POST', `/v1/voice/rooms/${room.body.room.id}/end`, {});
  assert.equal((await r.api('bob', 'DELETE', `/v1/voice/history/${room.body.room.id}`)).body.deleted, 1, 'deletion works with data-access rights only');
  assert.equal((await fetch(r.base + '/v1/voice/admin/history/purge', { method: 'POST', headers: { 'x-voice-admin-secret': 'a'.repeat(40) } })).status, 200, 'and so does the retention cleanup'); a.close(); b.close();
});

test('the restricted role cannot change the schema, truncate, drop, or read the certification record', async (t) => {
  if (skip(t)) return;
  for (const stmt of ['CREATE TABLE voice_evil (a int)', 'DROP TABLE voice_calls', 'TRUNCATE voice_calls', 'TRUNCATE voice_room_segments', 'TRUNCATE voice_room_events', 'TRUNCATE voice_legal_holds', 'TRUNCATE voice_history_ops', 'ALTER TABLE voice_room_events DROP CONSTRAINT voice_room_events_kind_check', 'DROP TABLE voice_legal_holds', 'ALTER TABLE voice_calls ADD COLUMN evil int', 'DROP INDEX voice_one_live_caller', 'CREATE INDEX voice_evil ON voice_calls (status)', 'SELECT * FROM voice_certification_runs', 'INSERT INTO voice_certification_runs(id, revision, environment, evidence, status) VALUES (gen_random_uuid(), \'x\', \'x\', \'{}\', \'PASS\')'])
    await assert.rejects(appPool.query(stmt), (e) => e.code === '42501', stmt + ' must be denied (permission denied), got ' + (t.name && '') );
  assert.equal((await appPool.query('SELECT count(*)::int n FROM voice_calls')).rows[0].n >= 1, true, 'but ordinary data access works');
});
