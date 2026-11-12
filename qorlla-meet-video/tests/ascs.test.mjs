import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerAscs } from '../server/ascs.mjs';
import { registerHostControls } from '../server/host-controls.mjs';

// ASCS v1-v2 against a REAL PostgreSQL (TEST_PG_URL, a scratch server; a database is created and dropped per test file). The real host-controls module is mounted, so the
// "permission withdrawn -> share revoked" path runs through the same routes the browser uses.
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
const SQL = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];

// The whole migration chain runs ONCE into a template database; every test clones it (a clone takes milliseconds, the chain takes many seconds).
const TPL = 'ascs_tpl_' + Math.random().toString(36).slice(2, 10);
let tplReady = null;
const dbUrl = (name) => URL.replace(/\/[^/]*$/, '/' + name);
async function template() {
  tplReady ||= (async () => {
    const admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${TPL}`); await admin.end();
    const pool = new pg.Pool({ connectionString: dbUrl(TPL), max: 1 });
    for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8'));
    await pool.end();
  })();
  return tplReady;
}
test.after(async () => { if (!tplReady) return; const admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`DROP DATABASE IF EXISTS ${TPL} WITH (FORCE)`).catch(() => {}); await admin.end(); });
async function scratch() {
  await template();
  const admin = new pg.Pool({ connectionString: URL, max: 2 }); const name = 'ascs_' + Math.random().toString(36).slice(2, 10);
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TPL}`);
  const pool = new pg.Pool({ connectionString: dbUrl(name), max: 30 }); pool.on('error', () => {});
  return { pool, drop: async () => { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); } };
}

/** A tiny Meet: meeting + host + two admitted guests, the real routes, a recording stand-in for socket.io. */
async function room({ enabled = true, leaseMs = 30_000, sweepMs = 0 } = {}) {
  const db = await scratch();
  const meetingId = randomUUID(), host = randomUUID(), g1 = randomUUID(), g2 = randomUUID(), outsider = randomUUID();
  await db.pool.query("INSERT INTO meetings(id,title,host_secret_hash) VALUES($1,'t','x')", [meetingId]);
  for (const [id, role, n] of [[host, 'host', 'Host'], [g1, 'guest', 'Ann'], [g2, 'guest', 'Bo']]) await db.pool.query("INSERT INTO participants(id,meeting_id,display_name,role,admission) VALUES($1,$2,$3,$4,'admitted')", [id, meetingId, n, role]);
  const events = []; const sockets = new Map();
  const io = { to: (target) => ({ emit: (type, payload) => events.push({ target, type, ...payload, payload }) }) };
  const roomOf = (id) => 'meeting:' + id;
  const fail = (res, status, error) => res.status(status).json({ error });
  const app = express(); app.use(express.json());
  // test stand-ins for Meet's auth (a header instead of a signed token) and member (same SQL as the real one)
  const auth = (req, res, next) => { try { req.user = JSON.parse(req.get('x-user')); next(); } catch { fail(res, 401, 'Authentication required'); } };
  const member = async (req, res, next) => {
    if (req.user.meetingId !== req.params.id) return fail(res, 403, 'Wrong meeting');
    const { rows } = await db.pool.query("SELECT m.ended_at, p.id FROM meetings m JOIN participants p ON p.meeting_id=m.id WHERE m.id=$1 AND p.id=$2 AND p.admission='admitted'", [req.params.id, req.user.participantId]);
    if (!rows.length || rows[0].ended_at) return fail(res, 403, 'Meeting unavailable'); next();
  };
  let ascs; const socketOf = (m, p) => sockets.get(p);
  const hostControls = registerHostControls({ app, io, db: db.pool, auth, member, fail, room: roomOf, audit: () => {}, socketOf, ascsEnabled: enabled, onPermissionChange: (m) => ascs?.reconcile(m) });
  ascs = registerAscs({ app, io, db: db.pool, auth, member, room: roomOf, socketOf, mayShare: (m, p, r) => hostControls.mayUse(m, p, r, 'share'), enabled, leaseMs, sweepMs });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const as = (pid, role) => async (method, path, body) => {
    const r = await fetch(base + '/api/meetings/' + meetingId + path, { method, headers: { 'content-type': 'application/json', 'x-user': JSON.stringify({ meetingId, participantId: pid, role }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await r.json(); } catch { /* empty */ } return { status: r.status, body: json };
  };
  const api = { host: as(host, 'host'), g1: as(g1, 'guest'), g2: as(g2, 'guest'), outsider: as(outsider, 'guest') };
  // a signed-in person of ANOTHER meeting (the token names a different meeting) who claims host and uses a real participant id of this one
  const foreign = async (method, path, body) => (await fetch(base + '/api/meetings/' + meetingId + path, { method, headers: { 'content-type': 'application/json', 'x-user': JSON.stringify({ meetingId: randomUUID(), participantId: host, role: 'host' }) }, body: body === undefined ? undefined : JSON.stringify(body) })).status;
  const start = (who, extra = {}) => api[who]('POST', '/shares', { kind: 'screen', mode: 'content', clientRequestId: randomUUID(), ...extra });
  const grant = (pid, allow = true) => api.host('POST', '/participants/' + pid + '/share', { allow });
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const rows = async (sql, args = []) => (await db.pool.query(sql, args)).rows;
  return { db, ids: { meetingId, host, g1, g2, outsider }, api, foreign, events, start, grant, settle, rows, ascs, sockets, close: async () => { ascs.close(); await new Promise((r) => server.close(r)); await db.drop(); } };
}
const withRoom = (opts, fn) => async () => { const r = await room(opts); try { await fn(r); } finally { await r.close(); } };

test('feature flag OFF: every share route answers 404 and no state is touched', withRoom({ enabled: false }, async (r) => {
  assert.equal((await r.start('host')).status, 404);
  assert.equal((await r.api.host('GET', '/shares/current')).status, 404);
  assert.equal((await r.api.host('POST', '/shares/handoff', { to: r.ids.g1 })).status, 404);
  assert.equal((await r.rows('SELECT count(*)::int n FROM meeting_shares'))[0].n, 0);
  assert.equal((await r.api.host('GET', '/tools')).body.ascs, false, 'the page is told the feature is off, so it keeps the old Share flow');
}));

test('the migration is idempotent and the schema enforces one active share per meeting', withRoom({}, async (r) => {
  await r.db.pool.query(readFileSync(join(SQL, 'v4_23_ascs_shares.sql'), 'utf8'));            // running it again changes nothing and does not fail
  await r.db.pool.query("INSERT INTO meeting_shares(id,meeting_id,owner_id,kind,request_id,state,revision,lease_expires_at) VALUES($1,$2,$3,'screen','a','active',1,now()+interval '1 minute')", [randomUUID(), r.ids.meetingId, r.ids.host]);
  await assert.rejects(r.db.pool.query("INSERT INTO meeting_shares(id,meeting_id,owner_id,kind,request_id,state,revision,lease_expires_at) VALUES($1,$2,$3,'screen','b','active',2,now()+interval '1 minute')", [randomUUID(), r.ids.meetingId, r.ids.g1]), /one_active_share_per_meeting/);
}));

test('who may start: the host; a guest only with permission; validation; an outsider never', withRoom({}, async (r) => {
  assert.equal((await r.start('g1')).status, 403, 'a guest the host has not allowed');
  assert.equal((await r.start('outsider')).status, 403, 'not a participant of the meeting at all');
  assert.equal((await r.start('host', { kind: 'monitor' })).status, 400);
  assert.equal((await r.start('host', { mode: 'standout' })).status, 400, 'presenter modes are not part of v1-v2');
  assert.equal((await r.start('host', { clientRequestId: '' })).status, 400);
  assert.equal((await r.start('host', { clientRequestId: 'x'.repeat(129) })).status, 400);
  assert.equal((await r.grant(r.ids.g1)).status, 200);
  const ok = await r.start('g1'); assert.equal(ok.status, 201); assert.equal(ok.body.state, 'active'); assert.equal(ok.body.ownerId, r.ids.g1); assert.equal(ok.body.kind, 'screen');
  assert.equal((await r.rows("SELECT event_type FROM audit_events WHERE event_type='share.started'")).length, 1, 'the audit row is written with the share');
}));

test('one presenter at a time: a second start gets 409, from the host or from another allowed guest', withRoom({}, async (r) => {
  await r.grant(r.ids.g1); await r.grant(r.ids.g2);
  const a = await r.start('g1'); assert.equal(a.status, 201);
  const b = await r.start('host'); assert.equal(b.status, 409); assert.equal(b.body.error, 'Another presenter is active'); assert.equal(b.body.shareId, a.body.id);
  assert.equal((await r.start('g2')).status, 409);
  // the SAME person starting again (a reloaded page lost its capture) takes over their own share: the old one ends as 'replaced', and there is still exactly ONE active share
  const again = await r.start('g1'); assert.equal(again.status, 201); assert.notEqual(again.body.id, a.body.id);
  assert.equal((await r.rows('SELECT state,end_reason FROM meeting_shares WHERE id=$1', [a.body.id]))[0].end_reason, 'replaced');
  assert.equal((await r.rows("SELECT count(*)::int n FROM meeting_shares WHERE state='active'"))[0].n, 1);
  assert.equal((await r.start('host')).status, 409, 'someone else is still refused');
}));

test('RACE: three different people start at the same instant: exactly one share, two refusals', withRoom({}, async (r) => {
  await r.grant(r.ids.g1); await r.grant(r.ids.g2);
  const results = await Promise.all(['host', 'g1', 'g2'].map((who) => r.start(who)));
  assert.deepEqual(results.map((x) => x.status).sort(), [201, 409, 409], JSON.stringify(results.map((x) => x.status)));
  assert.equal((await r.rows("SELECT count(*)::int n FROM meeting_shares WHERE state='active'"))[0].n, 1);
}));

test('RACE: twelve starts (four each, new ids) never leave two active shares; only a person\'s OWN earlier share is ever replaced', withRoom({}, async (r) => {
  await r.grant(r.ids.g1); await r.grant(r.ids.g2);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => r.start(['host', 'g1', 'g2'][i % 3])));
  assert.ok(results.every((x) => x.status === 201 || x.status === 409), JSON.stringify(results.map((x) => x.status)));
  assert.equal((await r.rows("SELECT count(*)::int n FROM meeting_shares WHERE state='active'"))[0].n, 1, 'exactly one share is live at the end');
  // a share ended as 'replaced' always has a LATER share by the same person: nobody ever displaced somebody else
  const bad = await r.rows("SELECT a.id FROM meeting_shares a WHERE a.end_reason='replaced' AND NOT EXISTS (SELECT 1 FROM meeting_shares b WHERE b.owner_id=a.owner_id AND b.meeting_id=a.meeting_id AND b.revision>a.revision)");
  assert.equal(bad.length, 0);
  const revs = (await r.rows('SELECT revision FROM meeting_shares')).map((x) => Number(x.revision)); assert.equal(new Set(revs).size, revs.length, 'no revision is shared by two shares');
}));

test('idempotency: the same clientRequestId returns the same outcome, even after the share has stopped, and never starts a second share', withRoom({}, async (r) => {
  const rid = randomUUID();
  const first = await r.start('host', { clientRequestId: rid }); assert.equal(first.status, 201);
  const retry = await r.start('host', { clientRequestId: rid }); assert.equal(retry.status, 200); assert.equal(retry.body.id, first.body.id);
  assert.equal((await r.api.host('DELETE', '/shares/' + first.body.id)).body.stopped, true);
  const late = await r.start('host', { clientRequestId: rid }); assert.equal(late.status, 200); assert.equal(late.body.id, first.body.id); assert.equal(late.body.state, 'stopped', 'a delayed retry does not resurrect the share');
  assert.equal((await r.rows("SELECT count(*)::int n FROM meeting_shares WHERE state='active'"))[0].n, 0);
  const fresh = await r.start('host'); assert.equal(fresh.status, 201, 'a NEW request id is a new share'); assert.notEqual(fresh.body.id, first.body.id);
}));

test('revisions only go up, and every event carries the revision of its change', withRoom({}, async (r) => {
  await r.grant(r.ids.g1);
  const s = await r.start('g1'); await r.api.g1('POST', '/shares/' + s.body.id + '/heartbeat');
  await r.api.host('POST', '/shares/' + s.body.id + '/revoke'); const t = await r.start('host'); await r.api.host('DELETE', '/shares/' + t.body.id);
  const revs = r.events.filter((e) => e.type.startsWith('share.')).map((e) => e.revision);
  assert.deepEqual(revs, [...revs].sort((a, b) => a - b)); assert.equal(new Set(revs).size, revs.length, 'no revision is reused');
  assert.deepEqual(r.events.filter((e) => e.type.startsWith('share.')).map((e) => e.type), ['share.started', 'share.revoked', 'share.started', 'share.stopped']);
  const cur = await r.api.host('GET', '/shares/current'); assert.equal(cur.body.revision, revs.at(-1)); assert.equal(cur.body.share, null);
}));

test('stop: the presenter or the host; nobody else; stopping twice is harmless', withRoom({}, async (r) => {
  await r.grant(r.ids.g1); await r.grant(r.ids.g2);
  const s = await r.start('g1');
  assert.equal((await r.api.g2('DELETE', '/shares/' + s.body.id)).status, 403, 'another guest cannot stop it');
  assert.deepEqual((await r.api.g1('DELETE', '/shares/' + s.body.id)).body.stopped, true);
  const again = await r.api.g1('DELETE', '/shares/' + s.body.id); assert.equal(again.status, 200); assert.equal(again.body.stopped, false);
  const t = await r.start('g2'); assert.equal((await r.api.host('DELETE', '/shares/' + t.body.id)).body.stopped, true);
  assert.equal((await r.rows("SELECT end_reason FROM meeting_shares WHERE id=$1", [t.body.id]))[0].end_reason, 'stopped_by_host');
  assert.equal((await r.api.g1('DELETE', '/shares/not-a-uuid')).status, 400);
}));

test('heartbeat: only the presenter renews, and only while the share is live', withRoom({}, async (r) => {
  await r.grant(r.ids.g1); const s = await r.start('g1');
  const before = new Date(s.body.leaseExpiresAt).getTime(); await r.settle(30);
  const hb = await r.api.g1('POST', '/shares/' + s.body.id + '/heartbeat'); assert.equal(hb.status, 200); assert.ok(new Date(hb.body.leaseExpiresAt).getTime() > before);
  assert.equal((await r.api.g2('POST', '/shares/' + s.body.id + '/heartbeat')).status, 404, 'someone else learns nothing about the share');
  await r.api.g1('DELETE', '/shares/' + s.body.id);
  const dead = await r.api.g1('POST', '/shares/' + s.body.id + '/heartbeat'); assert.equal(dead.status, 409); assert.equal(dead.body.state, 'stopped');
}));

test('lease: a share whose page vanished expires, is announced, and no longer blocks the next presenter', withRoom({ leaseMs: 250 }, async (r) => {
  await r.grant(r.ids.g1); const s = await r.start('g1'); assert.equal(s.status, 201);
  await r.settle(450);
  const late = await r.api.g1('POST', '/shares/' + s.body.id + '/heartbeat'); assert.equal(late.status, 409); assert.equal(late.body.state, 'expired', 'a heartbeat after the lease cannot revive the share');
  assert.ok(r.events.some((e) => e.type === 'share.stopped' && e.reason === 'lease_expired' && e.share.id === s.body.id));
  assert.equal((await r.start('host')).status, 201);
}));

test('lease: a stale share is also cleared by the next start request itself (no sweeper needed), and the sweeper clears an ended meeting', withRoom({ leaseMs: 200 }, async (r) => {
  const s = await r.start('host'); await r.settle(400);
  const next = await r.start('host'); assert.equal(next.status, 201, 'the expired lease did not block'); assert.equal((await r.rows('SELECT state FROM meeting_shares WHERE id=$1', [s.body.id]))[0].state, 'expired');
  await r.db.pool.query('UPDATE meetings SET ended_at=now() WHERE id=$1', [r.ids.meetingId]);
  assert.equal(await r.ascs.sweepMeeting(r.ids.meetingId), 1);
  assert.equal((await r.rows('SELECT end_reason FROM meeting_shares WHERE id=$1', [next.body.id]))[0].end_reason, 'meeting_ended');
}));

test('revoke: host only; it ends the share and the presenter cannot bring it back', withRoom({}, async (r) => {
  await r.grant(r.ids.g1); const s = await r.start('g1');
  assert.equal((await r.api.g1('POST', '/shares/' + s.body.id + '/revoke')).status, 403);
  assert.equal((await r.api.g2('POST', '/shares/' + s.body.id + '/revoke')).status, 403);
  const rev = await r.api.host('POST', '/shares/' + s.body.id + '/revoke'); assert.equal(rev.body.revoked, true);
  assert.ok(r.events.some((e) => e.type === 'share.revoked' && e.share.ownerId === r.ids.g1 && e.reason === 'host_revoked'));
  assert.equal((await r.api.g1('POST', '/shares/' + s.body.id + '/heartbeat')).status, 409);
  assert.equal((await r.api.host('POST', '/shares/' + s.body.id + '/revoke')).body.revoked, false, 'revoking twice does nothing');
  assert.equal((await r.start('g1', { clientRequestId: s.body.requestId })).body?.state ?? 'revoked', 'revoked');
}));

test('permission withdrawn: taking back a person\'s grant, or switching sharing off for everyone, ends a share that is no longer allowed', withRoom({}, async (r) => {
  await r.grant(r.ids.g1); let s = await r.start('g1');
  await r.grant(r.ids.g1, false);
  assert.equal((await r.rows('SELECT state,end_reason FROM meeting_shares WHERE id=$1', [s.body.id]))[0].end_reason, 'permission_withdrawn');
  assert.ok(r.events.some((e) => e.type === 'share.revoked' && e.reason === 'permission_withdrawn'));
  // sharing on for everyone: withdrawing ONE grant must not end the share (the person is still allowed through the room setting)
  await r.api.host('PATCH', '/tools', { share: true }); await r.grant(r.ids.g1); s = await r.start('g1'); assert.equal(s.status, 201);
  await r.grant(r.ids.g1, false); assert.equal((await r.rows('SELECT state FROM meeting_shares WHERE id=$1', [s.body.id]))[0].state, 'active');
  // ... but switching the room setting off does, because no grant is left
  await r.api.host('PATCH', '/tools', { share: false });
  assert.equal((await r.rows('SELECT end_reason FROM meeting_shares WHERE id=$1', [s.body.id]))[0].end_reason, 'permission_withdrawn');
}));

test('the host\'s own share is never ended by permission changes', withRoom({}, async (r) => {
  const s = await r.start('host'); await r.api.host('PATCH', '/tools', { share: false });
  assert.equal((await r.rows('SELECT state FROM meeting_shares WHERE id=$1', [s.body.id]))[0].state, 'active');
}));

test('handoff: ends the current share, gives exactly one person the floor, takes it from the previous presenter, and refuses nonsense', withRoom({}, async (r) => {
  await r.grant(r.ids.g1); const s = await r.start('g1');
  assert.equal((await r.api.g1('POST', '/shares/handoff', { to: r.ids.g2 })).status, 403, 'only the host');
  assert.equal((await r.api.host('POST', '/shares/handoff', { to: r.ids.outsider })).status, 404);
  assert.equal((await r.api.host('POST', '/shares/handoff', { to: r.ids.host })).status, 400);
  assert.equal((await r.api.host('POST', '/shares/handoff', { to: 'nope' })).status, 400);
  r.sockets.set(r.ids.g2, 'sock-g2');
  const h = await r.api.host('POST', '/shares/handoff', { to: r.ids.g2 }); assert.equal(h.status, 200); assert.equal(h.body.revoked, s.body.id); assert.equal(h.body.next, r.ids.g2);
  assert.equal((await r.rows('SELECT end_reason FROM meeting_shares WHERE id=$1', [s.body.id]))[0].end_reason, 'handoff');
  assert.ok(r.events.some((e) => e.target === 'sock-g2' && e.type === 'tools-changed'), 'the next presenter\'s page is told to refresh its tools');
  assert.ok(r.events.some((e) => e.type === 'share.updated' && e.nextPresenter === r.ids.g2));
  assert.equal((await r.start('g1')).status, 403, 'the previous presenter no longer has a personal grant');
  assert.equal((await r.start('g2')).status, 201, 'the next presenter can start at once');
}));

test('late joiners and reconnecting pages reconcile from /shares/current', withRoom({}, async (r) => {
  assert.deepEqual((await r.api.g1('GET', '/shares/current')).body.share, null);
  const s = await r.start('host'); const cur = await r.api.g1('GET', '/shares/current');
  assert.equal(cur.body.share.id, s.body.id); assert.equal(cur.body.share.ownerId, r.ids.host); assert.equal(cur.body.revision, s.body.revision);
  assert.equal((await r.api.outsider('GET', '/shares/current')).status, 403);
}));

test('a person who is waiting (not admitted) cannot start or read anything', withRoom({}, async (r) => {
  await r.db.pool.query("UPDATE participants SET admission='waiting' WHERE id=$1", [r.ids.g1]); await r.grant(r.ids.g1);
  assert.equal((await r.start('g1')).status, 403); assert.equal((await r.api.g1('GET', '/shares/current')).status, 403);
}));

test('meeting isolation: a token for ANOTHER meeting is refused on every share route, whatever role it claims', withRoom({}, async (r) => {
  const s = await r.start('host'); const sid = s.body.id;
  const body = { kind: 'screen', mode: 'content', clientRequestId: randomUUID() };
  for (const [m, p, b] of [['POST', '/shares', body], ['GET', '/shares/current'], ['POST', '/shares/handoff', { to: r.ids.g1 }], ['POST', '/shares/' + sid + '/heartbeat', {}], ['POST', '/shares/' + sid + '/revoke', {}], ['DELETE', '/shares/' + sid]]) {
    assert.equal(await r.foreign(m, p, b), 403, m + ' ' + p);
  }
  assert.equal((await r.rows("SELECT count(*)::int n FROM meeting_shares WHERE state='active'"))[0].n, 1, 'the real share was not touched');
}));

test('after a page reload the same person can start at once (no waiting for the old lease), and the old share is ended as replaced', withRoom({}, async (r) => {
  const old = await r.start('host'); assert.equal(old.status, 201);
  const fresh = await r.start('host'); assert.equal(fresh.status, 201);
  assert.ok(r.events.some((e) => e.type === 'share.stopped' && e.reason === 'replaced' && e.share.id === old.body.id));
  assert.equal((await r.api.host('GET', '/shares/current')).body.share.id, fresh.body.id);
}));
