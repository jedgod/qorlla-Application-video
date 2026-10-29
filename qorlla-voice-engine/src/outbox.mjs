// Outbox worker (v1.4): publishes committed events at least once. Several workers (one per replica) can run at once: rows are claimed with FOR UPDATE SKIP LOCKED and a 30 s lock, so a
// worker that dies mid-publish only delays the event. Delivery can repeat, so receivers deduplicate by event id (DR-04). When publishing fails the event stays and is retried with backoff (DR-02).
import { randomUUID } from 'node:crypto';
import { backoff } from './reliability.mjs';

export class OutboxWorker {
  constructor({ db, publish, workerId = randomUUID(), batchSize = 50, intervalMs = 500, logger = console }) {
    Object.assign(this, { db, publish, workerId, batchSize, intervalMs, logger }); this.timer = null; this.running = false; this.again = false; this.stats = { published: 0, failed: 0 };
  }
  async claim() {
    const c = await this.db.connect(), onError = () => {}; c.on('error', onError);
    try {
      await c.query('BEGIN');
      const { rows } = await c.query(`SELECT event_id FROM voice_outbox WHERE delivered_at IS NULL AND available_at <= now() AND (locked_until IS NULL OR locked_until < now())
        ORDER BY event_id FOR UPDATE SKIP LOCKED LIMIT $1`, [this.batchSize]);
      if (rows.length) await c.query("UPDATE voice_outbox SET locked_by=$1, locked_until=now()+interval '30 seconds' WHERE event_id = ANY($2::bigint[])", [this.workerId, rows.map((r) => r.event_id)]);
      await c.query('COMMIT'); return rows.map((r) => r.event_id);
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.removeListener('error', onError); c.release(); }
  }
  async runOnce() {
    const ids = await this.claim();
    for (const id of ids) {
      try {
        const { rows } = await this.db.query('SELECT e.id, e.account_id, e.kind, e.payload FROM voice_reliable_events e JOIN voice_outbox o ON o.event_id=e.id WHERE e.id=$1 AND o.locked_by=$2 AND o.delivered_at IS NULL', [id, this.workerId]);
        if (!rows[0]) continue;
        await this.publish(rows[0].account_id, { ...rows[0].payload, eventId: Number(rows[0].id), kind: rows[0].kind });
        await this.db.query('UPDATE voice_outbox SET delivered_at=now(), locked_by=NULL, locked_until=NULL, last_error=NULL WHERE event_id=$1 AND locked_by=$2', [id, this.workerId]); this.stats.published++;
      } catch (error) {
        this.stats.failed++;
        try {
          const wait = backoff(((await this.db.query('SELECT attempts FROM voice_outbox WHERE event_id=$1', [id])).rows[0]?.attempts ?? 0) + 1);
          await this.db.query("UPDATE voice_outbox SET attempts=attempts+1, available_at=now()+($3::int * interval '1 millisecond'), locked_by=NULL, locked_until=NULL, last_error=left($4,250) WHERE event_id=$1 AND locked_by=$2", [id, this.workerId, wait, String(error.message || error)]);
        } catch { /* the database is down too: the 30 s lock expires and the event is claimed again */ }
        this.logger.error('voice_outbox_publish_failed', String(error.message || error));
      }
    }
    return ids.length;
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
