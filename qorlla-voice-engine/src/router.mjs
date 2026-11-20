// Delivery to a person's connected devices: local sockets first, then the other replicas through the bus. A message for one device (SDP/ICE) goes only to the socket whose device id matches.
import { WebSocket } from 'ws';

const MAX_BUFFER = 1024 * 1024;
const MAX_HELD = 100, REPAIR_TRIES = 3;
/** Delivery to a person's connected devices: local sockets first, then the other replicas through the bus.
 *
 * ORDERING GUARANTEE (R8). Redis orders nothing between independent publishers, and a replica hands an event it claimed itself straight to its sockets while an earlier event of the same account that
 * ANOTHER replica claimed is still on its way through the bus. So the receiver decides, per socket, from the durable event ids (one account's ids increase in commit order):
 *   - an id at or below the last one this socket was sent is dropped (duplicate, replay, or a stale event that lost the race);
 *   - an event whose predecessor (`prev`, the account's previous event id, carried by the outbox) is the last one sent, or older, is sent at once;
 *   - otherwise there is a GAP: the event is held for a short grace period (the late one may still arrive), then the missing events are read from PostgreSQL, the source of truth, and sent in order
 *     before it. If that fails repeatedly the socket is closed so the client reconnects and resumes from its cursor. A socket therefore never sees an id go down, never sees one twice, never skips one.
 * Transient signaling (SDP/ICE, no event id) is not ordered by this and is unchanged. A message without `prev` (an older replica) is only checked for monotonic order. */
export class VoiceRouter {
  constructor({ bus = null, replay = null, gapMs = 100 } = {}) { this.bus = bus; this.replay = replay; this.gapMs = gapMs; this.sockets = new Map(); this.slowClosed = 0; this.order = { dropped: 0, held: 0, repaired: 0, resynced: 0 }; }
  attach(ws) { const s = this.sockets.get(ws.account) || new Set(); s.add(ws); this.sockets.set(ws.account, s); }
  detach(ws) { const s = this.sockets.get(ws.account); s?.delete(ws); if (s && !s.size) this.sockets.delete(ws.account); if (ws.ord) { clearTimeout(ws.ord.timer); ws.ord.held.clear(); ws.ord.closed = true; } }
  count(account) { return (this.sockets.get(account) || new Set()).size; }
  total() { let n = 0; for (const s of this.sockets.values()) n += s.size; return n; }
  write(ws, msg) {
    if (ws.bufferedAmount > MAX_BUFFER) { this.slowClosed++; try { ws.close(1013, 'slow_consumer'); } catch { /* gone */ } return false; }
    ws.send(msg); return true;
  }
  /** Local delivery. A socket that cannot keep up is closed rather than letting memory grow (backpressure). Durable events (they carry an event id) are ordered per socket. */
  local(account, device, payload, meta = {}) {
    if (payload && payload.type === '__close') { for (const ws of this.sockets.get(account) || []) { try { ws.close(payload.code || 4001, payload.reason || 'closed'); } catch { /* gone */ } } return; }
    const durable = payload && Number.isSafeInteger(payload.eventId), msg = durable ? null : JSON.stringify(payload);
    for (const ws of [...(this.sockets.get(account) || [])]) {
      if (ws.readyState !== WebSocket.OPEN || (device && ws.deviceId !== device)) continue;
      if (durable) this.offer(ws, payload, meta.prev); else this.write(ws, msg);
    }
  }
  state(ws) { return ws.ord || (ws.ord = { last: undefined, base: undefined, held: new Map(), timer: null, busy: false, fails: 0, closed: false }); }
  /** The cursor the client was given in `ready`: everything after it that is missing live is the client's to resume, everything between it and an event that arrives is a gap to repair. */
  baseline(ws, cursor) { const o = this.state(ws); if (o.base === undefined || cursor > o.base) o.base = cursor; }
  emit(ws, o, payload) { o.last = payload.eventId; this.write(ws, JSON.stringify(payload)); }
  offer(ws, payload, prev) {
    const o = this.state(ws), id = payload.eventId;
    if (o.closed) return;
    if (o.last !== undefined && id <= o.last) { this.order.dropped++; return; }
    const floor = o.last ?? o.base;                                                  // nothing to compare with yet (the socket has just opened): send it, as before
    if (floor === undefined || !Number.isSafeInteger(prev) || prev <= floor) { this.emit(ws, o, payload); this.drain(ws, o); return; }
    if (o.held.size >= MAX_HELD && !o.held.has(id)) return this.resync(ws, o);
    if (!o.held.has(id)) { o.held.set(id, { payload, prev }); this.order.held++; }
    if (!o.timer && !o.busy) o.timer = setTimeout(() => { o.timer = null; this.repair(ws, o); }, this.gapMs);
  }
  /** Sends every held event that is now next in line (and forgets the ones that were overtaken). */
  drain(ws, o, force = false) {
    for (;;) {
      let next = null;
      for (const [id, h] of o.held) { if (o.last !== undefined && id <= o.last) { o.held.delete(id); continue; } if (!next || id < next.id) next = { id, ...h }; }
      if (!next || (!force && next.prev > (o.last ?? o.base ?? 0))) return;
      o.held.delete(next.id); this.emit(ws, o, next.payload);
    }
  }
  /** The late event did not arrive in time: read what this socket is missing from PostgreSQL and send it in order. */
  async repair(ws, o) {
    if (o.busy || o.closed || !o.held.size) return;
    o.busy = true;
    try {
      if (!this.replay) throw Error('no_replay');
      for (;;) {
        const top = Math.max(...o.held.keys()), floor = o.last ?? o.base ?? 0; if (floor >= top) break;
        const { events, hasMore } = await this.replay(ws.account, floor); if (o.closed) return;
        for (const e of events) { if (o.last !== undefined && e.id <= o.last) continue; this.emit(ws, o, { ...e.payload, eventId: e.id, kind: e.kind }); this.order.repaired++; if (e.id >= top) break; }
        if (!hasMore || !events.length) break;
      }
      o.fails = 0; this.drain(ws, o, true);                                       // PostgreSQL has been read through to the held events: a predecessor that is still missing no longer exists (retention), so the rest go out in id order
    } catch (e) {
      if (++o.fails >= REPAIR_TRIES) { this.resync(ws, o); return; }
      o.timer = setTimeout(() => { o.timer = null; this.repair(ws, o); }, 100 * 2 ** o.fails);
    } finally {
      o.busy = false;
      if (!o.closed && o.held.size && !o.timer) { this.drain(ws, o); if (o.held.size) o.timer = setTimeout(() => { o.timer = null; this.repair(ws, o); }, this.gapMs); }   // new events were held while the read was in flight
    }
  }
  /** Cannot repair here: drop the held events and make the client reconnect, which resumes from its own cursor (the durable path). */
  resync(ws, o) { this.order.resynced++; o.closed = true; clearTimeout(o.timer); o.held.clear(); try { ws.close(1013, 'resync'); } catch { /* gone */ } }
  /** Transient signaling: local plus a best-effort publish. Never throws. */
  send(account, payload, device = null) {
    this.local(account, device, payload);
    if (this.bus?.up) this.bus.publish(account, device, payload).catch(() => {});
  }
  /** A durable event: local delivery, then the bus. If the bus is configured but unavailable this THROWS, so the outbox keeps the event and retries (the local copy is deduplicated by event id). */
  async deliverDurable(account, payload, meta = {}) {
    this.local(account, null, payload, meta);
    if (this.bus) await this.bus.publish(account, null, payload, meta);
  }
  onRemote(msg) { this.local(msg.account, msg.device, msg.payload, { prev: msg.prev }); }
}
