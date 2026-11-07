/**
 * Operations alerting (runs with the qorlla_sub_ops database role).
 *
 *  raise()      stores the alert FIRST (deduplicated: a repeat of a live condition increments `occurrences`, it does not re-notify)
 *  dispatch()   delivers from a durable outbox: retry with exponential backoff, safe from many workers (SKIP LOCKED), and the
 *               destination's acknowledgement is recorded. A destination that is down loses nothing; it is retried until it answers.
 *  acknowledge()/resolve()   a human takes responsibility / the condition is over (a recurrence then opens a NEW alert)
 *  Monitor      turns the signals the platform already records (critical security events, failing webhooks, a stuck outbox, a sweeper
 *               that stopped, brute-force patterns) into alerts, and resolves them when the condition clears.
 *
 * No external paging system, address or credential is built in: destinations are plain objects with deliver(alert). The reference
 * destination posts to an internal HTTP endpoint you configure.
 */

import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { createPool, ensureSearchPath } from './schema.js';
import { withTx } from './db.js';

const RANK = { info: 0, warning: 1, critical: 2 };

export class OpsAlerts {
  constructor({ pool, connectionString, destinations = [], baseBackoffMs = 5_000, maxBackoffMs = 15 * 60_000, deliverTimeoutMs = 10_000, logger = console } = {}) {
    this.ownsPool = !pool;
    this.pool = pool || createPool(connectionString || process.env.DATABASE_URL, { max: 4 });
    this.destinations = new Map(destinations.map((d) => [d.name, d]));
    this.baseBackoffMs = baseBackoffMs; this.maxBackoffMs = maxBackoffMs; this.deliverTimeoutMs = deliverTimeoutMs; this.logger = logger;
  }

  /** @returns {{ id: string, created: boolean }} created=false means a live alert for this condition already existed. */
  async raise({ dedupeKey, severity = 'warning', source, summary, details = {} }) {
    await ensureSearchPath(this.pool);
    if (!(severity in RANK)) throw new Error('invalid severity');
    return withTx(this.pool, async (c) => {
      const r = await c.query(
        `INSERT INTO ops_alerts (dedupe_key, severity, source, summary, details) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (dedupe_key) WHERE status <> 'resolved' DO UPDATE SET
           occurrences = ops_alerts.occurrences + 1, last_seen_at = now(), summary = EXCLUDED.summary, details = EXCLUDED.details,
           severity = CASE WHEN $6 > (CASE ops_alerts.severity WHEN 'critical' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END) THEN EXCLUDED.severity ELSE ops_alerts.severity END
         RETURNING id, (xmax = 0) AS created, severity`, [dedupeKey, severity, source, String(summary).slice(0, 500), JSON.stringify(details), RANK[severity]]);
      const { id, created } = r.rows[0];
      if (created) {
        for (const name of this.destinations.keys()) await c.query(`INSERT INTO ops_alert_deliveries (alert_id, destination) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, name]);
      }                                                          // a repeat of a live condition is NOT re-notified (it would flood the destination)
      return { id, created };
    });
  }

  /** Delivers due notifications. Returns counts. Safe to run from several workers at once. */
  async dispatch({ batch = 25, now = Date.now() } = {}) {
    await ensureSearchPath(this.pool);
    const out = { delivered: 0, failed: 0, acknowledged: 0 };
    const due = await this.pool.query(
      `SELECT d.id, d.destination, d.attempts, a.id AS alert_id, a.dedupe_key, a.severity, a.source, a.summary, a.details, a.occurrences, a.first_seen_at, a.status
         FROM ops_alert_deliveries d JOIN ops_alerts a ON a.id = d.alert_id
        WHERE d.delivered_at IS NULL AND d.next_attempt_at <= now() AND a.status = 'open' ORDER BY d.next_attempt_at LIMIT $1`, [batch]);
    for (const row of due.rows) {
      // claim one delivery at a time so two workers never send the same notification
      const claimed = await this.pool.query(
        `UPDATE ops_alert_deliveries SET next_attempt_at = now() + make_interval(secs => $2::double precision)
          WHERE id = $1 AND delivered_at IS NULL AND next_attempt_at <= now() RETURNING id`, [row.id, (this.deliverTimeoutMs * 2) / 1000]);
      if (!claimed.rowCount) continue;
      const dest = this.destinations.get(row.destination);
      try {
        if (!dest) throw new Error('destination not configured');
        const ack = await Promise.race([
          dest.deliver({ id: row.alert_id, dedupeKey: row.dedupe_key, severity: row.severity, source: row.source, summary: row.summary, details: row.details,
            occurrences: row.occurrences, firstSeenAt: row.first_seen_at, idempotencyKey: `alert:${row.alert_id}:${row.destination}` }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('delivery timed out')), this.deliverTimeoutMs)),
        ]);
        await this.pool.query(`UPDATE ops_alert_deliveries SET delivered_at = now(), attempts = attempts + 1, last_error = NULL, acknowledged_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1`, [row.id, !!ack?.acknowledged]);
        out.delivered++; if (ack?.acknowledged) out.acknowledged++;
      } catch (e) {
        const wait = Math.min(this.baseBackoffMs * 2 ** row.attempts, this.maxBackoffMs);
        await this.pool.query(`UPDATE ops_alert_deliveries SET attempts = attempts + 1, last_error = $2, next_attempt_at = now() + make_interval(secs => $3::double precision) WHERE id = $1`,
          [row.id, String(e.message).slice(0, 300), wait / 1000]);
        out.failed++;
      }
    }
    return out;
  }

  async acknowledge(alertId, by) {
    await ensureSearchPath(this.pool);
    if (!by || typeof by !== 'string') throw new Error('acknowledge requires who');
    const r = await this.pool.query(`UPDATE ops_alerts SET status='acknowledged', acknowledged_by=$2, acknowledged_at=now() WHERE id=$1 AND status='open' RETURNING id`, [alertId, by]);
    return { ok: r.rowCount > 0 };
  }

  async resolve(alertId) {
    await ensureSearchPath(this.pool);
    const r = await this.pool.query(`UPDATE ops_alerts SET status='resolved', resolved_at=now() WHERE id=$1 AND status <> 'resolved' RETURNING id`, [alertId]);
    return { ok: r.rowCount > 0 };
  }

  async list({ status } = {}) {
    await ensureSearchPath(this.pool);
    return (await this.pool.query(`SELECT * FROM ops_alerts WHERE ($1::text IS NULL OR status = $1) ORDER BY last_seen_at DESC LIMIT 200`, [status ?? null])).rows;
  }

  async close() { if (this.ownsPool) await this.pool.end(); }
}

/** The checks. Each returns [{ key, severity, summary, details }] for conditions that are true right now. */
export const CHECKS = Object.freeze([
  { name: 'critical_security_events', sql: `SELECT event_type, count(*)::int AS n FROM security_events WHERE severity='critical' AND occurred_at > now() - interval '5 minutes' GROUP BY 1`,
    map: (r) => ({ key: `sec:${r.event_type}`, severity: 'critical', summary: `${r.n} critical security event(s): ${r.event_type} in the last 5 minutes`, details: r }) },
  { name: 'billing_events_failing', sql: `SELECT status, count(*)::int AS n FROM billing_inbox WHERE status IN ('failed','dead') AND received_at > now() - interval '1 hour' GROUP BY 1`,
    map: (r) => ({ key: `billing:inbox:${r.status}`, severity: r.status === 'dead' ? 'critical' : 'warning', summary: `${r.n} billing event(s) ${r.status} in the last hour`, details: r }) },
  { name: 'billing_outbox_stuck', sql: `SELECT count(*)::int AS n FROM billing_outbox WHERE published_at IS NULL AND created_at < now() - interval '10 minutes' HAVING count(*) > 0`,
    map: (r) => ({ key: 'billing:outbox_stuck', severity: 'warning', summary: `${r.n} billing notification(s) unpublished for over 10 minutes`, details: r }) },
  { name: 'reservation_sweeper_stopped', sql: `SELECT count(*)::int AS n FROM quota_reservations WHERE status='reserved' AND expires_at < now() - interval '10 minutes' HAVING count(*) > 0`,
    map: (r) => ({ key: 'quota:sweeper_stopped', severity: 'warning', summary: `${r.n} expired reservation(s) not swept: the sweeper may have stopped`, details: r }) },
  { name: 'admin_refusal_spike', sql: `SELECT count(*)::int AS n FROM admin_requests WHERE outcome IN ('denied','invalid','replay') AND occurred_at > now() - interval '5 minutes' HAVING count(*) >= 20`,
    map: (r) => ({ key: 'admin:refusal_spike', severity: 'warning', summary: `${r.n} refused administration requests in 5 minutes`, details: r }) },
  { name: 'stepup_bruteforce', sql: `SELECT user_id, count(*)::int AS n FROM stepup_audit WHERE ok = false AND occurred_at > now() - interval '10 minutes' GROUP BY 1 HAVING count(*) >= 5`,
    map: (r) => ({ key: `stepup:failures:${r.user_id}`, severity: 'critical', summary: `${r.n} failed step-up attempts for ${r.user_id} in 10 minutes`, details: r }) },
]);

export class Monitor {
  constructor({ alerts, pool, checks = CHECKS }) { this.alerts = alerts; this.pool = pool || alerts.pool; this.checks = checks; }

  /** Runs every check, raises what is true, resolves monitor alerts whose condition has cleared. */
  async run() {
    await ensureSearchPath(this.pool);
    const active = new Set(); const raised = [];
    for (const check of this.checks) {
      const rows = (await this.pool.query(check.sql)).rows;
      for (const r of rows) {
        const a = check.map(r); active.add(a.key);
        raised.push((await this.alerts.raise({ dedupeKey: a.key, severity: a.severity, source: 'monitor', summary: a.summary, details: a.details })).id);
      }
    }
    const open = (await this.pool.query(`SELECT id, dedupe_key FROM ops_alerts WHERE source='monitor' AND status <> 'resolved'`)).rows;
    let resolved = 0;
    for (const o of open) if (!active.has(o.dedupe_key)) { await this.alerts.resolve(o.id); resolved++; }
    return { raised: raised.length, resolved };
  }
}

/** Destination: POST to an internal HTTP endpoint. 2xx = delivered; `{ "acknowledged": true }` in the body = the endpoint took responsibility. */
export function httpDestination({ name = 'ops-endpoint', url, token, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  if (!url || !token || token.length < 24) throw new Error('httpDestination needs a url and a token of 24+ characters');
  return {
    name,
    async deliver(alert) {
      const res = await fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': alert.idempotencyKey }, body: JSON.stringify(alert) });
      if (!res.ok) throw new Error(`endpoint answered ${res.status}`);
      const body = await res.json().catch(() => ({}));
      return { acknowledged: body?.acknowledged === true };
    },
  };
}

/**
 * Reference internal operations endpoint (what httpDestination talks to). Authenticated by a bearer token, idempotent on the
 * Idempotency-Key, and it acknowledges only AFTER the alert has been handed to `store`. Run your own implementation in production.
 */
export function createAlertEndpoint({ token, store }) {
  if (typeof token !== 'string' || token.length < 24) throw new Error('token of 24+ characters required');
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  const ok = (given) => { const a = Buffer.from(String(given || '')), b = Buffer.from(`Bearer ${token}`); return a.length === b.length && timingSafeEqual(a, b); };
  app.post('/alerts', async (req, res) => {
    if (!ok(req.get('authorization'))) return res.status(401).json({ error: 'unauthorized' });
    const key = req.get('idempotency-key');
    if (!key) return res.status(400).json({ error: 'idempotency_key_required' });
    try { const fresh = await store.put(key, req.body); return res.status(200).json({ acknowledged: true, duplicate: !fresh }); }
    catch { return res.status(503).json({ error: 'store_unavailable' }); }                      // not stored -> no acknowledgement -> the sender retries
  });
  return app;
}
