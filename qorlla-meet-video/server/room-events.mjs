// Shared room events (v4.32): a durable, replayable event log with a transactional outbox, so several Meet instances agree about breakout rooms.
//
//  producer  : publish() writes the event AND its outbox row in ONE statement (or inside the caller's transaction), then delivers to the sockets of THIS instance at once.
//  worker    : tick() leases outbox rows (FOR UPDATE SKIP LOCKED, fenced by a lease token), tells the bus "event N exists", retries with backoff, and moves an event to 'dead' after maxAttempts.
//  consumer  : every OTHER instance learns of event N from the bus (or, if the bus is down, from its catch-up poll), reads the event from PostgreSQL, records it in the inbox (idempotent: handled once
//              even if the bus delivers it twice), and delivers to its own sockets using ITS OWN current view of who is in which room (authorization is decided at delivery, never copied from the producer).
//  replay    : a page that reconnects asks for what it missed; the server returns the replayable events after its cursor that the page is allowed to see NOW.
// The bus is only a doorbell. PostgreSQL is the source of truth, so a lost, late, duplicated or reordered bus message cannot change what happened. Two buses ship: PostgreSQL LISTEN/NOTIFY (default,
// no extra service) and Redis Streams (optional, needs the `redis` package). Events carry only routing data and small flags: never chat text, notes or answers.
import { randomUUID } from 'node:crypto';

export const DISTRIBUTED = new Set(['breakouts-changed', 'breakout-ended', 'breakout-help', 'breakout-help-resolved', 'breakout-announcement', 'classroom-changed', 'room-board', 'polls-changed', 'files-changed', 'transcript-state', 'scope-sync', 'state-sync']);
export const REPLAYABLE = new Set(['breakouts-changed', 'breakout-ended', 'breakout-help', 'breakout-help-resolved', 'breakout-announcement', 'classroom-changed', 'polls-changed', 'files-changed', 'transcript-state']);
export const INTERNAL = new Set(['scope-sync', 'state-sync']);          // never shown to a page: they keep the instances' view of the rooms in step
const backoff = (attempts) => Math.min(300, 2 ** Math.min(attempts, 8));

export function createRoomEvents({ db, instanceId = randomUUID(), deliver, onInternal = async () => {}, bus = null, leaseSeconds = 30, maxAttempts = 8, batch = 50, pollMs = 1000, logger = console }) {
  if (!db?.query || typeof deliver !== 'function') throw new Error('database and a local deliver function are required');
  const seen = new Set();          // event ids this instance already handled (a small in-memory front for the inbox table)
  const remember = (id) => { seen.add(id); if (seen.size > 5000) for (const k of [...seen].slice(0, 1000)) seen.delete(k); };
  let lastSeen = 0, floor = 0, timer = null, stopped = false, busUp = false, ticking = false;
  const stats = { published: 0, retried: 0, dead: 0, handled: 0, duplicates: 0, failures: 0 };

  /** append an event + its outbox row atomically (pass `client` to make it part of the caller's own transaction), then deliver locally. Resolves with the event id. */
  let chain = Promise.resolve();          // events of this instance are stored and delivered in the order they were made
  function publish(meetingId, audience, type, payload = {}, opts = {}) {
    if (opts.client) return append(meetingId, audience, type, payload, opts);          // inside the caller's transaction: the caller decides when it commits
    const run = chain.then(() => append(meetingId, audience, type, payload, opts)); chain = run.catch(() => {}); return run;
  }
  async function append(meetingId, audience, type, payload, { client = null, replay = REPLAYABLE.has(type) } = {}) {
    const q = client || db;
    const { rows } = await q.query(`WITH e AS (INSERT INTO more_room_events(meeting_id, origin, audience, type, payload, replay) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id)
      INSERT INTO more_room_outbox(event_id) SELECT id FROM e RETURNING event_id`, [meetingId, instanceId, JSON.stringify(audience), type, JSON.stringify(payload), replay]);
    const id = Number(rows[0].event_id); remember(id); lastSeen = Math.max(lastSeen, id);
    if (!INTERNAL.has(type)) deliver(meetingId, audience, type, payload, id);          // this instance's own sockets hear it now; the others hear it through the bus
    bus?.notify?.(id).catch(() => {});          // a hint only: the outbox worker is what guarantees it
    return id;
  }

  // ---- worker: outbox -> bus ----
  async function claim() {
    await db.query("UPDATE more_room_outbox SET state='dead', last_error=COALESCE(last_error,'lease expired too many times'), lease_token=NULL WHERE state='leased' AND leased_until < now() AND attempts >= $1", [maxAttempts]);
    const { rows } = await db.query(`UPDATE more_room_outbox o SET state='leased', attempts=o.attempts+1, lease_owner=$1, lease_token=gen_random_uuid(), leased_until=now() + make_interval(secs => $2)
      WHERE o.event_id IN (SELECT event_id FROM more_room_outbox WHERE (state='pending' AND next_attempt <= now()) OR (state='leased' AND leased_until < now() AND attempts < $4) ORDER BY event_id FOR UPDATE SKIP LOCKED LIMIT $3)
      RETURNING o.event_id, o.attempts, o.lease_token`, [instanceId, leaseSeconds, batch, maxAttempts]);
    return rows.sort((a, b) => Number(a.event_id) - Number(b.event_id));
  }
  async function tick() {
    if (ticking) return 0; ticking = true; let n = 0;
    try {
      for (const row of await claim()) {
        try {
          if (bus) await bus.publish(Number(row.event_id));
          const r = await db.query("UPDATE more_room_outbox SET state='published', published_at=now(), lease_token=NULL, leased_until=NULL, last_error=NULL WHERE event_id=$1 AND lease_token=$2 AND state='leased'", [row.event_id, row.lease_token]);          // fenced: a worker whose lease expired cannot overwrite the new owner
          if (r.rowCount) { stats.published++; n++; }
        } catch (e) {
          const dead = row.attempts >= maxAttempts; stats[dead ? 'dead' : 'retried']++;
          await db.query(`UPDATE more_room_outbox SET state=$3, next_attempt=now() + make_interval(secs => $4), last_error=$5, lease_token=NULL, leased_until=NULL WHERE event_id=$1 AND lease_token=$2 AND state='leased'`,
            [row.event_id, row.lease_token, dead ? 'dead' : 'pending', backoff(row.attempts), String(e.message).slice(0, 200)]);
          if (dead) logger.error?.('[room-events] event dead-lettered', row.event_id, e.message);
        }
      }
    } finally { ticking = false; }
    return n;
  }
  /** an operator puts dead events back in the queue (after fixing the bus) */
  const requeueDead = async () => (await db.query("UPDATE more_room_outbox SET state='pending', attempts=0, next_attempt=now(), last_error=NULL WHERE state='dead'")).rowCount;

  // ---- consumer: bus / catch-up -> this instance ----
  /** handle event `id` once. Returns 'handled' | 'duplicate' | 'own' | 'missing'. Events from the bus and from the catch-up go through ONE queue, so they are applied in the order they arrive here and never two at a time. */
  let hchain = Promise.resolve();
  function handle(id) { const p = hchain.then(() => handleNow(id)); hchain = p.catch(() => {}); return p; }
  async function handleNow(id) {
    id = Number(id); lastSeen = Math.max(lastSeen, id);          // statistics only: the catch-up never trusts a high-water mark (the bus may deliver 10 before 9)
    if (seen.has(id)) { stats.duplicates++; return 'duplicate'; }
    const { rows } = await db.query('SELECT id, meeting_id, origin, audience, type, payload FROM more_room_events WHERE id=$1', [id]);
    const e = rows[0]; if (!e) return 'missing';
    if (e.origin === instanceId) { remember(id); return 'own'; }          // this instance delivered it when it was made
    const first = await db.query('INSERT INTO more_room_inbox(consumer, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_id', [instanceId, id]);
    if (!first.rowCount) { remember(id); stats.duplicates++; return 'duplicate'; }
    try {
      if (INTERNAL.has(e.type)) await onInternal(e.meeting_id, e.type, e.payload, id); else deliver(e.meeting_id, e.audience, e.type, e.payload, id);
      remember(id); stats.handled++; return 'handled';
    } catch (err) { await db.query('DELETE FROM more_room_inbox WHERE consumer=$1 AND event_id=$2', [instanceId, id]).catch(() => {}); stats.failures++; throw err; }          // not recorded as handled: the next catch-up tries again
  }
  /** everything other instances made that this one has not handled (after a bus outage, a restart, or simply every poll) */
  async function catchUp(limit = 500) {
    const { rows } = await db.query(`SELECT e.id FROM more_room_events e WHERE e.id > $1 AND e.created_at > now() - interval '10 minutes' AND e.origin <> $2 AND NOT EXISTS (SELECT 1 FROM more_room_inbox i WHERE i.consumer=$2 AND i.event_id=e.id) ORDER BY e.id LIMIT $3`, [floor, instanceId, limit]);          // the inbox is the memory of what was handled, so an event the bus delivered out of order or that failed once is still found
    let n = 0; for (const r of rows) { try { if ((await handle(r.id)) === 'handled') n++; } catch (e) { logger.error?.('[room-events] could not handle event', r.id, e.message); break; } }          // stop at the first failure: order matters (a scope change before the message that depends on it)
    return n;
  }
  /** what a reconnecting page missed: replayable events after its cursor. `canSee(audience)` is decided by the caller from the page's CURRENT room. */
  async function replay(meetingId, afterId, canSee, limit = 200) {
    const after = Number.isSafeInteger(Number(afterId)) && Number(afterId) >= 0 ? Number(afterId) : 0;
    const { rows } = await db.query('SELECT id, audience, type, payload FROM more_room_events WHERE meeting_id=$1 AND id > $2 AND replay ORDER BY id LIMIT $3', [meetingId, after, limit * 3]);
    return rows.filter((r) => canSee(r.audience)).slice(0, limit).map((r) => ({ id: Number(r.id), type: r.type, payload: r.payload }));
  }
  const latestId = async (meetingId) => Number((await db.query('SELECT COALESCE(max(id),0) AS m FROM more_room_events WHERE meeting_id=$1', [meetingId])).rows[0].m);
  /** old events are history nobody needs: published/dead ones past `hours` go (replay only ever needs a short window) */
  async function purge(hours = 24) { return (await db.query("DELETE FROM more_room_events e USING more_room_outbox o WHERE o.event_id=e.id AND o.state IN ('published','dead') AND e.created_at < now() - make_interval(hours => $1)", [hours])).rowCount; }

  async function start({ loop: autoloop = true } = {}) {          // loop:false = subscribe only (tests drive tick()/catchUp() by hand)
    stopped = false;
    floor = lastSeen = Number((await db.query('SELECT COALESCE(max(id),0) AS m FROM more_room_events')).rows[0].m);          // a fresh process has no sockets: it only needs what happens from now on
    if (bus) { try { await bus.start({ onEvent: (id) => handle(id).catch((e) => logger.error?.('[room-events] bus event failed', e.message)), onUp: () => { busUp = true; catchUp().catch(() => {}); }, onDown: () => { busUp = false; } }); busUp = true; } catch (e) { busUp = false; logger.error?.('[room-events] bus unavailable, polling only:', e.message); } }
    if (!autoloop) return;
    const loop = async () => { if (stopped) return; try { await tick(); await catchUp(); } catch (e) { logger.error?.('[room-events] loop failed', e.message); } timer = setTimeout(loop, pollMs); timer.unref?.(); };
    timer = setTimeout(loop, 50); timer.unref?.();
  }
  async function stop() { stopped = true; clearTimeout(timer); await bus?.stop?.(); }
  return { instanceId, publish, flush: () => chain, tick, handle, catchUp, replay, latestId, purge, requeueDead, start, stop, stats: () => ({ ...stats, busUp, lastSeen }) };
}

// ------------------------------------------------------------------ buses (a doorbell: "event N exists")
/** PostgreSQL LISTEN/NOTIFY: no extra service. A dedicated connection listens; if it drops it reconnects and the catch-up poll covers the gap. */
export class PgNotifyBus {
  constructor({ pool, channel = 'qorlla_room_events', logger = console }) { Object.assign(this, { pool, channel, logger }); }
  async start({ onEvent, onUp, onDown }) {
    Object.assign(this, { onEvent, onUp, onDown }); this.stopped = false; await this.listen();
  }
  async listen() {
    if (this.stopped) return;
    try {
      const c = await this.pool.connect(); this.client = c; let gone = false;
      const drop = (why) => { if (gone) return; gone = true; if (this.stopped) return; this.onDown?.(); try { c.release(true); } catch { /* gone */ } this.client = null; if (!this.stopped) { this.retry = setTimeout(() => this.listen(), 1000); this.retry.unref?.(); } this.logger.error?.('[room-events] listener lost:', why); };
      c.on('error', (e) => drop(e.message)); c.on('end', () => drop('ended'));
      c.on('notification', (m) => { if (m.channel === this.channel) { const id = Number(m.payload); if (Number.isSafeInteger(id)) this.onEvent(id); } });
      await c.query(`LISTEN ${this.channel}`); this.onUp?.();
    } catch (e) { this.onDown?.(); this.logger.error?.('[room-events] cannot listen:', e.message); if (!this.stopped) { this.retry = setTimeout(() => this.listen(), 1000); this.retry.unref?.(); } }
  }
  async notify(id) { await this.pool.query('SELECT pg_notify($1, $2)', [this.channel, String(id)]); }
  publish(id) { return this.notify(id); }
  async stop() { this.stopped = true; clearTimeout(this.retry); try { this.client?.release(true); } catch { /* gone */ } this.client = null; }
}

/** Redis Streams (optional). Every instance reads the whole stream (it is a broadcast, not a work queue); it resumes from the last id it saw and the catch-up poll covers anything older than the stream's retention. */
export class RedisStreamsBus {
  constructor({ url, stream = 'qorlla:meet:room-events', maxLen = 100000, clientFactory = null, logger = console }) { if (!url && !clientFactory) throw new Error('REDIS_URL required'); Object.assign(this, { url, stream, maxLen, clientFactory, logger }); }
  async start({ onEvent, onUp, onDown }) {
    if (!this.clientFactory) { try { this.clientFactory = (await import('redis')).createClient; } catch { throw new Error('the "redis" package is not installed (npm install redis) - the PostgreSQL bus is used instead'); } }
    this.writer = this.clientFactory({ url: this.url, disableOfflineQueue: true, socket: { reconnectStrategy: (n) => Math.min(2000, 100 * n) } }); this.reader = this.writer.duplicate();
    for (const c of [this.writer, this.reader]) c.on('error', (e) => this.logger.error?.('[room-events] redis error', e.message));
    this.stopped = false; this.up = false;
    // Redis being down at boot must NOT block this instance: connecting keeps retrying in the background, the reader loop below keeps trying, and the PostgreSQL poll delivers meanwhile.
    const connected = Promise.all([this.writer.connect(), this.reader.connect()]).then(() => { this.up = true; onUp?.(); }).catch((e) => this.logger.error?.('[room-events] redis connect failed:', e.message));
    await Promise.race([connected, new Promise((r) => { const t = setTimeout(r, this.connectWaitMs ?? 3000); t.unref?.(); })]);
    this.loop = (async () => {
      let last = '$';
      while (!this.stopped) {
        try { if (this.reader.isReady === false) { await new Promise((r) => setTimeout(r, 500)); continue; } const res = await this.reader.xRead({ key: this.stream, id: last }, { BLOCK: 2000, COUNT: 100 }); if (!this.up) { this.up = true; onUp?.(); }
          for (const s of res || []) for (const m of s.messages) { last = m.id; const id = Number(m.message.event); if (Number.isSafeInteger(id)) onEvent(id); } }
        catch (e) { if (this.stopped) break; if (this.up) { this.up = false; onDown?.(); } this.logger.error?.('[room-events] redis read failed', e.message); await new Promise((r) => setTimeout(r, 1000)); }
      }
    })();
  }
  /** never waits for an unreachable Redis (an offline queue would stall the outbox worker): fails after 2 s and the outbox retries with backoff */
  async notify(id) { let t; try { await Promise.race([this.writer.xAdd(this.stream, '*', { event: String(id) }, { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: this.maxLen } }), new Promise((_r, no) => { t = setTimeout(() => no(new Error('redis unreachable')), this.publishTimeoutMs ?? 2000); })]); } finally { clearTimeout(t); } }
  publish(id) { return this.notify(id); }
  async stop() {          // a client that never connected cannot quit: give it a second, then cut it
    this.stopped = true;
    await Promise.all([this.reader, this.writer].filter(Boolean).map(async (c) => { await Promise.race([Promise.resolve().then(() => c.quit()).catch(() => {}), new Promise((r) => { const t = setTimeout(r, 1000); t.unref?.(); })]); if (c.isOpen !== false) await Promise.resolve().then(() => c.disconnect?.()).catch(() => {}); }));          // already closed: nothing to cut
  }
}

/** In-process bus for tests: instances share one object. `down` makes publish fail (a bus outage). */
export class MemoryBus {
  constructor(hub = { listeners: new Set(), down: false, sent: [] }) { this.hub = hub; }
  async start({ onEvent }) { this.onEvent = onEvent; this.hub.listeners.add(this); }
  async notify() {}
  async publish(id) { if (this.hub.down) throw new Error('bus down'); this.hub.sent.push(id); for (const l of this.hub.listeners) if (l !== this) l.onEvent(id); }
  async stop() { this.hub.listeners.delete(this); }
}

/** which sockets of THIS instance does an audience reach? `ctx` is this instance's own, CURRENT view: scopeOf(pid), isHost(pid), hasCap(pid, capability). Authorization is decided here, at delivery. */
export function audienceMatches(aud, pid, ctx) {
  if (aud.except && aud.except === pid) return false;
  if (aud.only) return aud.only === pid;
  if (aud.scope === '*') return true;
  if (aud.hosts && ctx.isHost(pid)) return true;
  if (aud.scope === undefined || aud.scope === 'none') return false;
  const sc = ctx.scopeOf(pid) ?? null;
  if (aud.scope === '*rooms') return sc !== null;          // everybody who is inside any room
  if (sc !== aud.scope) return false;
  return aud.cap ? !!ctx.hasCap?.(pid, aud.cap) : true;          // some events go only to people holding a room-lead capability
}
