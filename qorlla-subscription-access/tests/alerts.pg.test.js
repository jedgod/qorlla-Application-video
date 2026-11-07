// Durable operations alerting against a real PostgreSQL and a real internal HTTP endpoint: stored first, deduplicated, delivered with
// retry/backoff and acknowledgement, safe from many workers, and fed by the monitor. No external paging system is contacted.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createTestDb, sleep, skip } from './helpers/db.js';
import { OpsAlerts, Monitor, CHECKS, httpDestination, createAlertEndpoint } from '../src/alerts.js';

const TOKEN = 't'.repeat(32);

describe('operations alerting (PostgreSQL + HTTP)', { skip }, () => {
  let db, endpoint, url, received, mode, alerts, dest;
  before(async () => {
    db = await createTestDb();
    received = new Map(); mode = { down: false, hang: false, dropAck: false };
    const store = { async put(key, body) { if (mode.down) throw new Error('store down'); if (mode.hang) await sleep(2000); const fresh = !received.has(key); received.set(key, { body, count: (received.get(key)?.count || 0) + 1 }); return fresh; } };
    endpoint = createServer(createAlertEndpoint({ token: TOKEN, store })); await new Promise((r) => endpoint.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${endpoint.address().port}/alerts`;
    dest = httpDestination({ url, token: TOKEN, timeoutMs: 1500 });
    alerts = new OpsAlerts({ pool: db.poolFor('ops'), destinations: [dest], baseBackoffMs: 250, maxBackoffMs: 1000, deliverTimeoutMs: 600, logger: { error() {} } });
  });
  after(async () => { endpoint.close(); await db.drop(); });

  const key = () => 'test:' + randomBytes(4).toString('hex');
  const row = async (id) => (await db.owner.query(`SELECT a.*, d.attempts, d.delivered_at, d.acknowledged_at AS delivery_ack, d.last_error, d.next_attempt_at FROM ops_alerts a JOIN ops_alert_deliveries d ON d.alert_id = a.id WHERE a.id=$1`, [id])).rows[0];
  const reset = () => { mode.down = false; mode.hang = false; mode.dropAck = false; };

  test('an alert is stored first, delivered to the internal endpoint with an idempotency key, and the endpoint\'s acknowledgement is recorded', async () => {
    const k = key(); const { id, created } = await alerts.raise({ dedupeKey: k, severity: 'critical', source: 'test', summary: 'database is on fire', details: { host: 'db1' } });
    assert.equal(created, true);
    assert.equal((await row(id)).delivered_at, null, 'stored before any delivery');
    const out = await alerts.dispatch();
    assert.ok(out.delivered >= 1 && out.acknowledged >= 1);
    const r = await row(id);
    assert.ok(r.delivered_at && r.delivery_ack, 'delivered and acknowledged');
    const got = received.get(`alert:${id}:ops-endpoint`);
    assert.equal(got.count, 1);
    assert.deepEqual([got.body.severity, got.body.summary, got.body.details.host, got.body.dedupeKey], ['critical', 'database is on fire', 'db1', k]);
  });

  test('a repeat of a live condition is deduplicated (counted, not re-sent); severity only ever escalates; a recurrence after resolve is a NEW alert', async () => {
    const k = key();
    const first = await alerts.raise({ dedupeKey: k, severity: 'warning', source: 'test', summary: 's' });
    for (let i = 0; i < 4; i++) assert.equal((await alerts.raise({ dedupeKey: k, severity: 'warning', source: 'test', summary: 's' })).created, false);
    await alerts.raise({ dedupeKey: k, severity: 'critical', source: 'test', summary: 'worse' });
    await alerts.raise({ dedupeKey: k, severity: 'info', source: 'test', summary: 'better?' });
    let r = await row(first.id);
    assert.equal(r.occurrences, 7); assert.equal(r.severity, 'critical', 'escalated, never downgraded');
    assert.equal(Number((await db.owner.query(`SELECT count(*) AS n FROM ops_alert_deliveries WHERE alert_id=$1`, [first.id])).rows[0].n), 1, 'one notification, not seven');
    await alerts.dispatch(); assert.equal(received.get(`alert:${first.id}:ops-endpoint`).count, 1);
    assert.deepEqual(await alerts.resolve(first.id), { ok: true });
    const again = await alerts.raise({ dedupeKey: k, severity: 'warning', source: 'test', summary: 'back again' });
    assert.equal(again.created, true); assert.notEqual(again.id, first.id);
  });

  test('an endpoint that is DOWN loses nothing: retried with growing backoff, delivered exactly once when it returns', async () => {
    reset(); mode.down = true;
    const { id } = await alerts.raise({ dedupeKey: key(), severity: 'critical', source: 'test', summary: 'must not be lost' });
    assert.ok((await alerts.dispatch()).failed >= 1);
    let r = await row(id);
    assert.equal(r.attempts, 1); assert.equal(r.delivered_at, null); assert.match(r.last_error, /503/);
    assert.equal((await alerts.dispatch()).delivered, 0, 'not due yet: backoff is respected');
    await sleep(300); await alerts.dispatch();
    r = await row(id); assert.equal(r.attempts, 2);
    assert.ok(new Date(r.next_attempt_at) - Date.now() > 250, 'the second wait is longer than the first');
    mode.down = false; await sleep(700);
    assert.ok((await alerts.dispatch()).delivered >= 1);
    r = await row(id); assert.ok(r.delivered_at);
    assert.equal(received.get(`alert:${id}:ops-endpoint`).count, 1, 'stored once');
  });

  test('a lost acknowledgement is safe: the sender retries, the endpoint recognises the idempotency key and does not double-process', async () => {
    reset();
    const lossy = httpDestination({ url, token: TOKEN, fetchImpl: async (u, o) => { const res = await fetch(u, o); if (mode.dropAck) throw new Error('connection reset after the endpoint stored it'); return res; } });
    const a2 = new OpsAlerts({ pool: db.poolFor('ops'), destinations: [lossy], baseBackoffMs: 100, maxBackoffMs: 300, deliverTimeoutMs: 600, logger: { error() {} } });
    const { id } = await a2.raise({ dedupeKey: key(), severity: 'warning', source: 'test', summary: 'ack lost' });
    mode.dropAck = true; await a2.dispatch();
    assert.equal((await row(id)).delivered_at, null, 'the sender cannot know it arrived');
    assert.equal(received.get(`alert:${id}:ops-endpoint`).count, 1);
    mode.dropAck = false; await sleep(400); await a2.dispatch();
    assert.ok((await row(id)).delivered_at);
    assert.equal(received.get(`alert:${id}:ops-endpoint`).count, 2, 'the endpoint saw the retry...');
    assert.equal(received.get(`alert:${id}:ops-endpoint`).body.summary, 'ack lost', '...under the SAME key, so it can de-duplicate');
  });

  test('a destination that hangs is timed out and retried, not allowed to block the dispatcher', async () => {
    reset(); mode.hang = true;
    const { id } = await alerts.raise({ dedupeKey: key(), severity: 'warning', source: 'test', summary: 'slow endpoint' });
    const t0 = Date.now(); const out = await alerts.dispatch();
    assert.ok(Date.now() - t0 < 1500, 'gave up after the delivery timeout');
    assert.ok(out.failed >= 1); assert.match((await row(id)).last_error, /timed out/);
    mode.hang = false; await sleep(700); await alerts.dispatch();
    assert.ok((await row(id)).delivered_at);
  });

  test('the endpoint rejects a wrong token (401, retried, never delivered) and the destination refuses a weak token', async () => {
    reset();
    const bad = new OpsAlerts({ pool: db.poolFor('ops'), destinations: [httpDestination({ url, token: 'w'.repeat(32) })], baseBackoffMs: 100, deliverTimeoutMs: 600, logger: { error() {} } });
    const { id } = await bad.raise({ dedupeKey: key(), severity: 'critical', source: 'test', summary: 'wrong credentials' });
    await bad.dispatch();
    const r = await row(id); assert.equal(r.delivered_at, null); assert.match(r.last_error, /401/);
    assert.equal(received.has(`alert:${id}:ops-endpoint`), false);
    assert.throws(() => httpDestination({ url, token: 'short' }), /24\+/);
    const noKey = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noKey.status, 400);
  });

  test('six workers dispatching at once deliver every alert exactly once', async () => {
    reset();
    const ids = []; for (let i = 0; i < 12; i++) ids.push((await alerts.raise({ dedupeKey: key(), severity: 'warning', source: 'test', summary: 'burst ' + i })).id);
    const workers = Array.from({ length: 6 }, () => new OpsAlerts({ pool: db.poolFor('ops'), destinations: [dest], deliverTimeoutMs: 600, logger: { error() {} } }));
    await Promise.all(workers.map((w) => w.dispatch({ batch: 50 })));
    for (const id of ids) assert.equal(received.get(`alert:${id}:ops-endpoint`)?.count, 1, id);
  });

  test('a human acknowledgement stops further notification; resolve closes the alert', async () => {
    reset(); mode.down = true;
    const { id } = await alerts.raise({ dedupeKey: key(), severity: 'critical', source: 'test', summary: 'someone is on it' });
    await alerts.dispatch();
    assert.deepEqual(await alerts.acknowledge(id, 'oncall-1'), { ok: true });
    assert.deepEqual(await alerts.acknowledge(id, 'oncall-2'), { ok: false }, 'only the first acknowledgement counts');
    mode.down = false; await sleep(600);
    await alerts.dispatch();
    assert.equal((await row(id)).delivered_at, null, 'no more notifications for an acknowledged alert');
    assert.equal((await row(id)).acknowledged_by, 'oncall-1');
    await assert.rejects(alerts.acknowledge(id, ''), /who/);
    assert.equal((await alerts.list({ status: 'acknowledged' })).some((a) => a.id === id), true);
  });

  // ---- the monitor -------------------------------------------------------------------------------------------------------------
  test('the monitor turns recorded signals into alerts, does not repeat them, and resolves them when the condition clears', async () => {
    reset();
    const flag = { name: 'test_flag', sql: `SELECT 1 AS n WHERE EXISTS (SELECT 1 FROM security_events WHERE event_type='flag_x' AND occurred_at > now() - interval '1500 milliseconds')`,
      map: () => ({ key: 'flag:x', severity: 'critical', summary: 'flag is up', details: {} }) };
    const m = new Monitor({ alerts, checks: [...CHECKS, flag] });
    await db.owner.query(`INSERT INTO security_events (event_type, severity, details) VALUES ('audit_write_failed','critical','{}'), ('flag_x','info','{}')`);
    await db.owner.query(`INSERT INTO billing_inbox (provider, event_id, event_type, raw_sha256, payload, status) VALUES ('acme','mon-dead-1','t','x','{}','dead')`);
    await db.owner.query(`INSERT INTO billing_outbox (dedupe_key, topic, payload, created_at) VALUES ('mon-stuck-1','t','{}', now() - interval '1 hour')`);
    const cid = '00000000-0000-4000-8000-0000000000aa';
    await db.owner.query(`INSERT INTO quota_reservations (customer_id, feature_key, quantity, status, reserved_at, expires_at, max_expires_at, period_start, period_end, idempotency_key)
      VALUES ($1,'ai.queries',1,'reserved', now() - interval '2 hours', now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 day', now() + interval '1 day', 'mon-stale')`, [cid]);
    for (let i = 0; i < 5; i++) await db.owner.query(`INSERT INTO stepup_audit (user_id, event, ok) VALUES ('u_attacker','assert_finish',false)`);
    const first = await m.run();
    assert.ok(first.raised >= 6, 'six conditions are true: ' + first.raised);
    const open = (await alerts.list({ status: 'open' })).map((a) => a.dedupe_key);
    for (const k of ['sec:audit_write_failed', 'billing:inbox:dead', 'billing:outbox_stuck', 'quota:sweeper_stopped', 'stepup:failures:u_attacker', 'flag:x']) assert.ok(open.includes(k), k);
    assert.equal((await alerts.list({ status: 'open' })).find((a) => a.dedupe_key === 'stepup:failures:u_attacker').severity, 'critical');
    const second = await m.run();
    assert.equal(second.resolved, 0);
    assert.equal(Number((await db.owner.query(`SELECT count(*) AS n FROM ops_alerts WHERE dedupe_key='sec:audit_write_failed'`)).rows[0].n), 1, 'no duplicate alert for a condition that is still true');
    await alerts.dispatch(); assert.ok([...received.values()].some((v) => v.body.dedupeKey === 'stepup:failures:u_attacker'), 'and it reached the endpoint');
    await sleep(1800);
    const third = await m.run();
    assert.ok(third.resolved >= 1);
    assert.equal((await alerts.list({ status: 'resolved' })).some((a) => a.dedupe_key === 'flag:x'), true, 'the cleared condition was resolved');
  });

  test('the ops role is confined: it reads the signals and manages alerts, and nothing else; no other role can read alerts', async () => {
    const ops = db.poolFor('ops');
    for (const sql of [`INSERT INTO security_events (event_type, severity) VALUES ('x','info')`, 'UPDATE subscriptions SET quantity=1', 'DELETE FROM billing_inbox', `INSERT INTO customers (name, created_by) VALUES ('x','x')`,
      'SELECT 1 FROM entitlement_overrides', 'SELECT 1 FROM webauthn_credentials', 'SELECT 1 FROM stepup_grants', `UPDATE ops_alerts SET dedupe_key='hijack'`, 'DELETE FROM ops_alerts', 'DELETE FROM ops_alert_deliveries', 'DROP TABLE ops_alerts']) {
      await assert.rejects(ops.query(sql), { code: '42501' }, sql);
    }
    for (const kind of ['runtime', 'billing', 'admin']) await assert.rejects(db.poolFor(kind).query('SELECT 1 FROM ops_alerts'), { code: '42501' }, kind);
  });
});
