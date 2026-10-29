// Delivery to a person's connected devices: local sockets first, then the other replicas through the bus. A message for one device (SDP/ICE) goes only to the socket whose device id matches.
import { WebSocket } from 'ws';

const MAX_BUFFER = 1024 * 1024;
export class VoiceRouter {
  constructor({ bus = null } = {}) { this.bus = bus; this.sockets = new Map(); this.slowClosed = 0; }
  attach(ws) { const s = this.sockets.get(ws.account) || new Set(); s.add(ws); this.sockets.set(ws.account, s); }
  detach(ws) { const s = this.sockets.get(ws.account); s?.delete(ws); if (s && !s.size) this.sockets.delete(ws.account); }
  count(account) { return (this.sockets.get(account) || new Set()).size; }
  total() { let n = 0; for (const s of this.sockets.values()) n += s.size; return n; }
  /** Local delivery. A socket that cannot keep up is closed rather than letting memory grow (backpressure). */
  local(account, device, payload) {
    if (payload && payload.type === '__close') { for (const ws of this.sockets.get(account) || []) { try { ws.close(payload.code || 4001, payload.reason || 'closed'); } catch { /* gone */ } } return; }
    const msg = JSON.stringify(payload);
    for (const ws of this.sockets.get(account) || []) {
      if (ws.readyState !== WebSocket.OPEN || (device && ws.deviceId !== device)) continue;
      if (ws.bufferedAmount > MAX_BUFFER) { this.slowClosed++; try { ws.close(1013, 'slow_consumer'); } catch { /* gone */ } continue; }
      ws.send(msg);
    }
  }
  /** Transient signaling: local plus a best-effort publish. Never throws. */
  send(account, payload, device = null) {
    this.local(account, device, payload);
    if (this.bus?.up) this.bus.publish(account, device, payload).catch(() => {});
  }
  /** A durable event: local delivery, then the bus. If the bus is configured but unavailable this THROWS, so the outbox keeps the event and retries (the local copy is deduplicated by event id). */
  async deliverDurable(account, payload) {
    this.local(account, null, payload);
    if (this.bus) await this.bus.publish(account, null, payload);
  }
  onRemote(msg) { this.local(msg.account, msg.device, msg.payload); }
}
