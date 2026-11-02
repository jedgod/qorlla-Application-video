import { randomUUID } from 'node:crypto';

// Redis Pub/Sub is at-most-once. Persistent call state remains authoritative in PostgreSQL.
// When Redis is down, cross-node signaling fails closed; callers must renegotiate after reconnect.
export const CHANNEL = 'qorlla:voice:v1:signals';
export function validateEnvelope(m) {
  return !!m && typeof m === 'object' && m.version === 1 &&
    typeof m.id === 'string' && /^[0-9a-f-]{36}$/i.test(m.id) &&
    typeof m.source === 'string' && m.source.length <= 128 &&
    typeof m.account === 'string' && m.account.length <= 256 &&
    (m.device === null || (typeof m.device === 'string' && m.device.length <= 64)) &&
    Number.isFinite(m.ts) && Math.abs(Date.now() - m.ts) < 30000 &&
    JSON.stringify(m.payload ?? null).length <= 70000;
}
export function envelope(source, account, device, payload) {
  return {version:1,id:randomUUID(),source,account,device,ts:Date.now(),payload};
}
export class DistributedBus {
  constructor({url, onDelivery, logger=console, clientFactory=null, instanceId=randomUUID()}) {
    if(!url) throw Error('REDIS_URL required for distributed voice');
    this.url=url;this.onDelivery=onDelivery;this.logger=logger;
    this.clientFactory=clientFactory;this.instanceId=instanceId;
    this.ready=false;
  }
  async start() {
    if(!this.clientFactory) { const {createClient}=await import('redis'); this.clientFactory=createClient; }
    this.publisher=this.clientFactory({url:this.url});
    this.subscriber=this.publisher.duplicate();
    for(const c of [this.publisher,this.subscriber]) c.on('error',e=>this.logger.error('redis_error',e.message));
    try {
      await Promise.all([this.publisher.connect(),this.subscriber.connect()]);
      await this.subscriber.subscribe(CHANNEL, async raw=>{
        try {
          const msg=JSON.parse(raw);
          if(!validateEnvelope(msg)||msg.source===this.instanceId) return;
          await this.onDelivery(msg);
        } catch(e) {this.logger.error('voice_delivery_error',e.message);}
      });
      this.ready=true;
    } catch(e) {await this.close();throw e;}
  }
  async publish(account, device, payload) {
    if(!this.ready || !this.publisher?.isReady) throw Error('distributed_bus_unavailable');
    const msg=envelope(this.instanceId,account,device,payload);
    await this.publisher.publish(CHANNEL,JSON.stringify(msg));
    return msg;
  }
  async close() {
    this.ready=false;
    await Promise.allSettled([this.subscriber?.quit(),this.publisher?.quit()].filter(Boolean));
  }
}
