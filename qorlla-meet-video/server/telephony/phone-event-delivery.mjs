import { randomUUID } from 'node:crypto';

const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

export class DeliveryLeaseLost extends Error {
  constructor() { super('DELIVERY_LEASE_LOST'); this.code = 'DELIVERY_LEASE_LOST'; }
}

// The receiver must authenticate the sender and atomically deduplicate eventId.
// deliver(event, signal) is aborted and treated as failed after deliverTimeoutMs, which must stay below the lease.
export function createPhoneEventDelivery({ db, deliver, log, leaseSeconds = 30, maxAttempts = 12, random = Math.random,
  deliverTimeoutMs = Math.floor(leaseSeconds * 800) }) {
  if (!db || typeof deliver !== 'function' || typeof log?.error !== 'function' || typeof random !== 'function')
    throw new Error('Delivery requires a database, authenticated receiver and logger');
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600 ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100)
    throw new RangeError('Invalid delivery limits');
  if (!Number.isSafeInteger(deliverTimeoutMs) || deliverTimeoutMs < 1 || deliverTimeoutMs >= leaseSeconds * 1000)
    throw new RangeError('Delivery timeout must be shorter than the lease');

  async function lease(workerId, limit = 1) {
    if (!uuid(workerId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new RangeError('Invalid lease request');
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE phone_lifecycle_delivery SET dead_lettered_at=now(), lease_owner=NULL,
        lease_token=NULL, lease_until=NULL, last_error='delivery attempts exhausted'
        WHERE event_id IN (SELECT event_id FROM phone_lifecycle_delivery
          WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND attempts >= $1
            AND (lease_until IS NULL OR lease_until <= now())
          FOR UPDATE SKIP LOCKED LIMIT $2)`, [maxAttempts, limit]);
      const { rows } = await c.query(`SELECT e.event_id,e.call_id,e.meeting_id,e.lifecycle_version,
          e.from_state,e.event_type,e.occurred_at
        FROM phone_lifecycle_delivery d JOIN phone_lifecycle_outbox e ON e.event_id=d.event_id
        WHERE d.delivered_at IS NULL AND d.dead_lettered_at IS NULL AND d.attempts < $1
          AND d.next_attempt_at <= now() AND (d.lease_until IS NULL OR d.lease_until <= now())
          AND (SELECT count(*) FROM phone_lifecycle_outbox all_events
               WHERE all_events.call_id=e.call_id AND all_events.lifecycle_version <= e.lifecycle_version) = e.lifecycle_version
          AND NOT EXISTS (SELECT 1 FROM phone_lifecycle_outbox previous
            LEFT JOIN phone_lifecycle_delivery prior ON prior.event_id=previous.event_id
            WHERE previous.call_id=e.call_id AND previous.lifecycle_version < e.lifecycle_version AND prior.delivered_at IS NULL)
        ORDER BY e.created_at,e.event_id FOR UPDATE OF d SKIP LOCKED LIMIT $2`, [maxAttempts, limit]);
      const jobs = [];
      for (const event of rows) {
        const token = randomUUID();
        await c.query(`UPDATE phone_lifecycle_delivery SET lease_owner=$2,lease_token=$3,
          lease_until=now()+$4 * interval '1 second',attempts=attempts+1 WHERE event_id=$1`,
        [event.event_id, workerId, token, leaseSeconds]);
        jobs.push({ event, workerId, token });
      }
      await c.query('COMMIT');
      return jobs;
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  }

  async function finish(job, delivered, error = '') {
    const result = await db.query(`UPDATE phone_lifecycle_delivery
      SET delivered_at=CASE WHEN $4 THEN now() ELSE NULL END,
          dead_lettered_at=CASE WHEN NOT $4 AND attempts >= $5 THEN now() ELSE NULL END,
          next_attempt_at=CASE WHEN NOT $4 THEN now()+
            (LEAST(3600,power(2,LEAST(attempts,11))) * $7) * interval '1 second' ELSE next_attempt_at END,
          last_error=CASE WHEN $4 THEN NULL ELSE $6 END,
          lease_owner=NULL,lease_token=NULL,lease_until=NULL
      WHERE event_id=$1 AND lease_owner=$2 AND lease_token=$3 AND lease_until > now()
        AND delivered_at IS NULL AND dead_lettered_at IS NULL RETURNING event_id`,
    [job.event.event_id, job.workerId, job.token, delivered, maxAttempts, String(error).slice(0, 400), 0.5 + random() * 0.5]);
    if (!result.rowCount) throw new DeliveryLeaseLost();
  }

  async function runOnce(workerId, limit = 1) {
    const jobs = await lease(workerId, limit);
    const results = await Promise.allSettled(jobs.map(async job => {
      let ok = false, failure, timer;
      const abort = new AbortController();
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('DELIVERY_TIMEOUT')); }, deliverTimeoutMs); });
        const ack = await Promise.race([deliver(job.event, abort.signal), timeout]);
        if (!ack || ack.eventId !== job.event.event_id || !['accepted', 'duplicate'].includes(ack.result))
          throw new Error('INVALID_DURABLE_ACK');
        ok = true;
      } catch (e) {
        failure = e;
        log.error('phone lifecycle delivery failed', { eventId: job.event.event_id, error: String(e?.message || e) });
      } finally { clearTimeout(timer); }
      try { await finish(job, ok, failure?.message || String(failure ?? '')); }
      catch (e) {
        // A lost lease means another worker owns the event now; the receiver deduplicates, so this is not a poll failure.
        if (e?.code !== 'DELIVERY_LEASE_LOST') throw e;
        log.error('phone lifecycle delivery lease lost', { eventId: job.event.event_id });
      }
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    return jobs.length;
  }

  async function diagnostics() {
    const { rows } = await db.query(`SELECT
      count(*) FILTER (WHERE d.delivered_at IS NULL AND d.dead_lettered_at IS NULL)::int AS pending,
      count(*) FILTER (WHERE d.lease_until > now() AND d.delivered_at IS NULL AND d.dead_lettered_at IS NULL)::int AS leased,
      count(*) FILTER (WHERE d.dead_lettered_at IS NOT NULL)::int AS dead_lettered,
      coalesce(sum(d.attempts) FILTER (WHERE d.delivered_at IS NULL AND d.dead_lettered_at IS NULL),0)::text AS pending_attempts,
      min(e.created_at) FILTER (WHERE d.delivered_at IS NULL AND d.dead_lettered_at IS NULL) AS oldest_pending_at
      FROM phone_lifecycle_delivery d JOIN phone_lifecycle_outbox e ON e.event_id=d.event_id`);
    return rows[0];
  }
  // Operator recovery. A dead letter blocks every later event of its call until it is requeued here.
  // Requires the reviewed delivery role; the ordinary application role cannot write delivery metadata.
  async function listDeadLetters(limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError('Invalid limit');
    return (await db.query(`SELECT e.event_id,e.call_id,e.lifecycle_version,e.event_type,d.attempts,d.last_error,d.dead_lettered_at
      FROM phone_lifecycle_delivery d JOIN phone_lifecycle_outbox e ON e.event_id=d.event_id
      WHERE d.dead_lettered_at IS NOT NULL AND d.delivered_at IS NULL ORDER BY d.dead_lettered_at,e.event_id LIMIT $1`, [limit])).rows;
  }
  async function requeueDeadLetter(eventId) {
    if (!uuid(eventId)) throw new RangeError('Invalid event id');
    const r = await db.query(`UPDATE phone_lifecycle_delivery SET dead_lettered_at=NULL,attempts=0,next_attempt_at=now(),
        lease_owner=NULL,lease_token=NULL,lease_until=NULL
      WHERE event_id=$1 AND dead_lettered_at IS NOT NULL AND delivered_at IS NULL RETURNING event_id`, [eventId]);
    return r.rowCount === 1;
  }
  // Calls whose stream cannot advance by itself: a dead letter, a missing earlier version, or a stream that
  // starts after version 1 (a call already in progress when the migrations were applied).
  async function blockedStreams() {
    return (await db.query(`SELECT e.call_id,min(e.lifecycle_version)::text AS first_version,max(e.lifecycle_version)::text AS last_version,
        count(*)::int AS captured,(count(*) FILTER (WHERE d.dead_lettered_at IS NOT NULL))::int AS dead_lettered
      FROM phone_lifecycle_outbox e JOIN phone_lifecycle_delivery d ON d.event_id=e.event_id GROUP BY e.call_id
      HAVING min(e.lifecycle_version) > 1 OR max(e.lifecycle_version) <> count(*)
        OR count(*) FILTER (WHERE d.dead_lettered_at IS NOT NULL) > 0 ORDER BY e.call_id`)).rows;
  }
  return { lease, finish, runOnce, diagnostics, listDeadLetters, requeueDeadLetter, blockedStreams };
}
