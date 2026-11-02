// Redis Pub/Sub between replicas (v1.3). It carries two kinds of traffic: committed durable events (retried from the outbox until published) and transient SDP/ICE (at most once: a lost
// signal means the media layer renegotiates). Redis is NEVER the source of truth; PostgreSQL is. With no REDIS_URL the engine is a single instance and delivery is local only.
import { randomUUID } from 'node:crypto';

export const CHANNEL = 'qorlla:voice:v1:signals';
export function validateEnvelope(m, now = Date.now()) {
  return !!m && typeof m === 'object' && m.version === 1 && typeof m.id === 'string' && /^[0-9a-f-]{36}$/i.test(m.id) && typeof m.source === 'string' && m.source.length <= 128
    && typeof m.account === 'string' && m.account.length <= 256 && (m.device === null || (typeof m.device === 'string' && m.device.length <= 64)) && Number.isFinite(m.ts) && Math.abs(now - m.ts) < 30000 && JSON.stringify(m.payload ?? null).length <= 70000;
}
export class RedisBus {
  constructor({ url, onDelivery, logger = console, instanceId = randomUUID(), clientFactory = null }) {
    if (!url) throw Error('REDIS_URL required'); Object.assign(this, { url, onDelivery, logger, instanceId, clientFactory }); this.ready = false;
  }
  async start() {
    if (!this.clientFactory) this.clientFactory = (await import('redis')).createClient;
    this.publisher = this.clientFactory({ url: this.url, socket: { reconnectStrategy: (n) => Math.min(2000, 100 * n) } }); this.subscriber = this.publisher.duplicate();
    for (const c of [this.publisher, this.subscriber]) c.on('error', (e) => { if (this.ready) this.logger.error('redis_error', e.message); });
    this.publisher.on('ready', () => { this.ready = true; }); this.publisher.on('end', () => { this.ready = false; }); this.publisher.on('reconnecting', () => { this.ready = false; });
    // connect() keeps retrying in the background when Redis is down; the subscription is made as soon as it is reachable, so a late Redis still works.
    this.connecting = Promise.all([this.publisher.connect(), this.subscriber.connect()]).then(() => this.subscriber.subscribe(CHANNEL, async (raw) => {
      try { const msg = JSON.parse(raw); if (!validateEnvelope(msg) || msg.source === this.instanceId) return; await this.onDelivery(msg); } catch (e) { this.logger.error('voice_delivery_error', e.message); }
    })).then(() => { this.ready = true; });
    this.connecting.catch(() => {});
    await this.connecting; return this;
  }
  get up() { return this.ready && !!this.publisher?.isReady; }
  async publish(account, device, payload) {
    if (!this.up) throw Error('distributed_bus_unavailable');
    const msg = { version: 1, id: randomUUID(), source: this.instanceId, account, device, ts: Date.now(), payload };
    await this.publisher.publish(CHANNEL, JSON.stringify(msg)); return msg;
  }
  async close() { this.ready = false; await Promise.allSettled([this.subscriber?.quit(), this.publisher?.quit()].filter(Boolean)); }
}
