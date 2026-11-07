import { randomUUID } from 'node:crypto';

export class OutboxLeaseError extends Error {
  constructor() { super('OUTBOX_LEASE_LOST'); this.code = 'OUTBOX_LEASE_LOST'; }
}

export class PermanentDeliveryError extends Error {
  constructor(message) { super(message); this.code = 'OUTBOX_PERMANENT_DELIVERY'; }
}

export function createAccountingOutbox({ pool, deliver, leaseSeconds = 30, maxAttempts = 12, log, random = Math.random }) {
  if (!pool || typeof deliver !== 'function' || typeof random !== 'function' || !log || typeof log.error !== 'function')
    throw new Error('Outbox requires a pool, idempotent delivery and an error logger');
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600 ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100)
    throw new RangeError('Invalid outbox limits');

  async function transaction(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const value = await fn(c); await c.query('COMMIT'); return value; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  }
  async function lease(workerId, limit = 20) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workerId) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid outbox lease request');
    return transaction(async c => {
      await c.query(`UPDATE portal.a410_accounting_outbox SET dead_lettered_at=now(),
        lease_owner=NULL, lease_token=NULL, lease_until=NULL, last_error='delivery attempts exhausted'
        WHERE id IN (SELECT id FROM portal.a410_accounting_outbox
          WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND attempts >= $1
            AND (lease_until IS NULL OR lease_until <= now())
          ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2)`, [maxAttempts, limit]);
      const rows = await c.query(`SELECT id, event_key, topic, payload FROM portal.a410_accounting_outbox
        WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND attempts < $1
          AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until <= now())
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2`, [maxAttempts, limit]);
      const jobs = [];
      for (const row of rows.rows) {
        const token = randomUUID();
        await c.query(`UPDATE portal.a410_accounting_outbox
          SET lease_owner=$2, lease_token=$3, lease_until=now()+$4 * interval '1 second', attempts=attempts+1
          WHERE id=$1`, [row.id, workerId, token, leaseSeconds]);
        jobs.push({ ...row, workerId, token });
      }
      return jobs;
    });
  }
  async function finish(job, ok, error = '', permanent = false) {
    const result = await pool.query(`UPDATE portal.a410_accounting_outbox
      SET delivered_at=CASE WHEN $4 THEN now() ELSE NULL END,
          dead_lettered_at=CASE WHEN NOT $4 AND (attempts >= $5 OR $8) THEN now() ELSE NULL END,
          next_attempt_at=CASE WHEN NOT $4 THEN now()+(LEAST(3600, power(2,LEAST(attempts,11))) * $7) * interval '1 second' ELSE next_attempt_at END,
          last_error=CASE WHEN $4 THEN NULL ELSE $6 END,
          lease_owner=NULL, lease_token=NULL, lease_until=NULL
      WHERE id=$1 AND lease_owner=$2 AND lease_token=$3 AND lease_until > now()
        AND delivered_at IS NULL AND dead_lettered_at IS NULL RETURNING id`,
    [job.id, job.workerId, job.token, ok, maxAttempts, String(error).slice(0, 400), 0.5 + random() * 0.5, permanent]);
    if (!result.rowCount) throw new OutboxLeaseError();
  }
  async function runOnce(workerId, limit = 1) {
    const jobs = await lease(workerId, limit);
    const results = await Promise.allSettled(jobs.map(async job => {
      let deliveryError, delivered = false;
      try { await deliver({ eventKey: job.event_key, topic: job.topic, payload: job.payload }); delivered = true; }
      catch (e) { deliveryError = e; log.error('A410 accounting delivery failed', { eventKey: job.event_key, error: String(e?.message || e) }); }
      try { await finish(job, delivered, deliveryError?.message || String(deliveryError ?? ''), deliveryError instanceof PermanentDeliveryError); }
      catch (e) { log.error('A410 accounting lease completion failed', { eventKey: job.event_key, error: String(e?.message || e) }); throw e; }
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    return jobs.length;
  }
  async function diagnostics() {
    const result = await pool.query(`SELECT
      count(*) FILTER (WHERE delivered_at IS NULL AND dead_lettered_at IS NULL)::int AS pending,
      count(*) FILTER (WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND lease_until > now())::int AS leased,
      count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered,
      min(created_at) FILTER (WHERE delivered_at IS NULL AND dead_lettered_at IS NULL) AS oldest_pending_at
      FROM portal.a410_accounting_outbox`);
    return result.rows[0];
  }
  return { lease, finish, runOnce, diagnostics };
}
