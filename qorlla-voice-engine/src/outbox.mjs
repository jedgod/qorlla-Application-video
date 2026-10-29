// Outbox worker (v1.4, rewritten for throughput in v1.11): publishes committed events at least once. Several workers (one per replica) can run at once: rows are claimed with FOR UPDATE SKIP LOCKED and a
// 30 s lock, so a worker that dies mid-publish only delays the event. Delivery can repeat, so receivers deduplicate by event id (DR-04). When publishing fails the event stays and is retried with backoff (DR-02).
// Throughput: a batch is claimed AND read in one statement, accounts are delivered concurrently (events of one account stay in order), and the batch is marked in one statement. The first version did three
// sequential round trips per event, which the load test (scripts/load-test.mjs) showed as seconds of ringing delay at 100 simultaneous calls.
import { randomUUID } from 'node:crypto';

export class OutboxWorker {
  constructor({ db, publish, workerId = randomUUID(), batchSize = 100, concurrency = 32, intervalMs = 500, logger = console }) {
    Object.assign(this, { db, publish, workerId, batchSize, concurrency, intervalMs, logger }); this.timer = null; this.running = false; this.again = false; this.stats = { published: 0, failed: 0 };
  }
  /** Claims up to batchSize events and returns them with their payloads, oldest first. */
  async claim() {
    const { rows } = await this.db.query(`WITH picked AS (
        SELECT event_id FROM voice_outbox WHERE delivered_at IS NULL AND available_at <= now() AND (locked_until IS NULL OR locked_until < now()) ORDER BY event_id FOR UPDATE SKIP LOCKED LIMIT $1)
      UPDATE voice_outbox o SET locked_by = $2, locked_until = now() + interval '30 seconds' FROM picked JOIN voice_reliable_events e ON e.id = picked.event_id
      WHERE o.event_id = picked.event_id RETURNING o.event_id, e.account_id, e.kind, e.payload`, [this.batchSize, this.workerId]);
    return rows.map((r) => ({ ...r, event_id: Number(r.event_id) })).sort((a, b) => a.event_id - b.event_id);
  }
  async runOnce() {
    const events = await this.claim(); if (!events.length) return 0;
    const byAccount = new Map(); for (const e of events) { if (!byAccount.has(e.account_id)) byAccount.set(e.account_id, []); byAccount.get(e.account_id).push(e); }
    const ok = [], failed = []; const queue = [...byAccount.values()];
    const lane = async () => {
      for (let list = queue.shift(); list; list = queue.shift()) {
        for (const e of list) {                                                                      // one account's events go out in order; a failure holds back that account's later events in this batch
          try { await this.publish(e.account_id, { ...e.payload, eventId: e.event_id, kind: e.kind }); ok.push(e.event_id); }
          catch (error) { failed.push({ id: e.event_id, message: String(error.message || error) }); this.stats.failed++; this.logger.error('voice_outbox_publish_failed', String(error.message || error)); for (const later of list.slice(list.indexOf(e) + 1)) failed.push({ id: later.event_id, message: 'earlier event for this account failed' }); break; }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, lane));
    try {
      if (ok.length) { await this.db.query('UPDATE voice_outbox SET delivered_at = now(), locked_by = NULL, locked_until = NULL, last_error = NULL WHERE event_id = ANY($1::bigint[]) AND locked_by = $2', [ok, this.workerId]); this.stats.published += ok.length; }
      if (failed.length) await this.db.query(`UPDATE voice_outbox o SET attempts = o.attempts + 1, available_at = now() + LEAST(60000, 500 * power(2, LEAST(7, o.attempts))) * interval '1 millisecond', locked_by = NULL, locked_until = NULL, last_error = left(f.message, 250)
        FROM unnest($1::bigint[], $2::text[]) AS f(id, message) WHERE o.event_id = f.id AND o.locked_by = $3`, [failed.map((f) => f.id), failed.map((f) => f.message), this.workerId]);
    } catch { /* the database is down too: the 30 s lock expires and the events are claimed again (and delivered again: receivers deduplicate) */ }
    return events.length;
  }
  /** Drain until empty. kick() after a commit gives immediate delivery; the interval is the safety net. */
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
