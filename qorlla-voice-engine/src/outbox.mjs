// Outbox worker (v1.4; rewritten for throughput in v1.11 and for ordering and recovery in v1.11.1). It publishes committed events at least once, and ONE ACCOUNT'S EVENTS IN ORDER, even with a worker on every replica.
//
// Ordering: an event is claimable only when no EARLIER event of the same account is still undelivered (and not set aside). So each claim takes at most the head of each account's queue; a worker that holds
// the head, a retry waiting out its delay, or a lock that has not expired all hold back that account's later events, and nobody else's. (The first rewrite claimed batches by event id alone, which let two
// replicas deliver one account's events out of order; a reproduction with five workers misordered all twelve accounts.)
//
// Failure recovery:
//   * a failed publish is retried with a short, capped backoff (250 ms doubling to 5 s), so a recovered Redis is noticed within seconds;
//   * a publish that hangs times out (publishTimeoutMs) instead of stalling the batch;
//   * a bus outage ("distributed_bus_unavailable") is retried for as long as it lasts: it never counts towards the retry limit;
//   * an event that fails maxAttempts times for any OTHER reason is a poison event: it is set aside (dead_at) so it cannot block its account for ever. It stays replayable by resume, and it is counted (metrics, alert);
//   * a worker that dies holding a claim only delays its accounts until the 30 s lock expires;
//   * a failure while marking events delivered is retried; if it keeps failing the lock expires and the events are delivered again (receivers deduplicate by event id).
import { randomUUID } from 'node:crypto';

const withTimeout = (promise, ms) => { let timer; return Promise.race([promise, new Promise((_r, rej) => { timer = setTimeout(() => rej(Error('publish_timeout')), ms); })]).finally(() => clearTimeout(timer)); };

export class OutboxWorker {
  constructor({ db, publish, workerId = randomUUID(), batchSize = 100, concurrency = 32, intervalMs = 500, publishTimeoutMs = 5000, maxAttempts = 25, logger = console }) {
    Object.assign(this, { db, publish, workerId, batchSize, concurrency, intervalMs, publishTimeoutMs, maxAttempts, logger }); this.timer = null; this.running = false; this.again = false; this.stats = { published: 0, failed: 0, dead: 0 };
  }
  /** Claims the head of each account's queue (up to batchSize accounts) and returns the events with their payloads. */
  async claim() {
    const { rows } = await this.db.query(`WITH picked AS (
        SELECT o.event_id FROM voice_outbox o
        WHERE o.delivered_at IS NULL AND o.dead_at IS NULL AND o.available_at <= now() AND (o.locked_until IS NULL OR o.locked_until < now())
          AND NOT EXISTS (SELECT 1 FROM voice_outbox p WHERE p.account_id = o.account_id AND p.event_id < o.event_id AND p.delivered_at IS NULL AND p.dead_at IS NULL)
        ORDER BY o.event_id FOR UPDATE OF o SKIP LOCKED LIMIT $1)
      UPDATE voice_outbox o SET locked_by = $2, locked_until = now() + interval '30 seconds' FROM picked JOIN voice_reliable_events e ON e.id = picked.event_id
      WHERE o.event_id = picked.event_id RETURNING o.event_id, e.account_id, e.kind, e.payload`, [this.batchSize, this.workerId]);
    return rows.map((r) => ({ ...r, event_id: Number(r.event_id) })).sort((a, b) => a.event_id - b.event_id);
  }
  async retry(fn, times = 3) { for (let i = 1; ; i++) { try { return await fn(); } catch (e) { if (i >= times) throw e; await new Promise((r) => setTimeout(r, 40 * i)); } } }
  async runOnce() {
    const events = await this.claim(); if (!events.length) return 0;
    const ok = [], failed = [], queue = [...events];
    const lane = async () => {
      for (let e = queue.shift(); e; e = queue.shift()) {
        try { await withTimeout(Promise.resolve(this.publish(e.account_id, { ...e.payload, eventId: e.event_id, kind: e.kind })), this.publishTimeoutMs); ok.push(e.event_id); }
        catch (error) { const message = String(error.message || error); failed.push({ id: e.event_id, message }); this.stats.failed++; this.logger.error('voice_outbox_publish_failed', message); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, events.length) }, lane));
    try {
      if (ok.length) { await this.retry(() => this.db.query('UPDATE voice_outbox SET delivered_at = now(), locked_by = NULL, locked_until = NULL, last_error = NULL WHERE event_id = ANY($1::bigint[]) AND locked_by = $2', [ok, this.workerId])); this.stats.published += ok.length; }
      if (failed.length) {
        const r = await this.retry(() => this.db.query(`UPDATE voice_outbox o SET attempts = o.attempts + 1,
            dead_at = CASE WHEN o.attempts + 1 >= $4 AND f.message NOT LIKE 'distributed_bus_unavailable%' THEN now() END,
            available_at = now() + LEAST(5000, 250 * power(2, LEAST(5, o.attempts))) * interval '1 millisecond', locked_by = NULL, locked_until = NULL, last_error = left(f.message, 250)
          FROM unnest($1::bigint[], $2::text[]) AS f(id, message) WHERE o.event_id = f.id AND o.locked_by = $3 RETURNING o.event_id, o.dead_at`, [failed.map((f) => f.id), failed.map((f) => f.message), this.workerId, this.maxAttempts]));
        for (const row of r.rows) if (row.dead_at) { this.stats.dead++; this.logger.error('voice_outbox_event_set_aside', 'event ' + row.event_id + ' failed ' + this.maxAttempts + ' times; it stays replayable'); }
      }
    } catch { /* the database is unreachable: the 30 s lock expires and the events are claimed again (and delivered again: receivers deduplicate) */ }
    return events.length;
  }
  /** Drain until nothing more is claimable. kick() after a commit gives immediate delivery; the interval is the safety net. */
  async drain() {
    if (this.running) { this.again = true; return; }
    this.running = true;
    try { do { this.again = false; while ((await this.runOnce()) > 0); } while (this.again); }
    catch (e) { this.logger.error('voice_outbox_worker_error', String(e.code || e.message)); }
    finally { this.running = false; }
  }
  kick() { this.drain(); }
  start() { if (!this.timer) { this.timer = setInterval(() => this.drain(), this.intervalMs); this.timer.unref?.(); } return this; }
  stop() { clearInterval(this.timer); this.timer = null; }
}
