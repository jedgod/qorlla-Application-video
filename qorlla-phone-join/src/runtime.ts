import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createSipGateway, type SipGatewayConfig } from './sip-gateway.js';
import { MeetPhoneAuthority, type MeetConfig } from './meet-authority.js';
import { MeetReadiness } from './readiness-meet.js';
import { MeshPeerAudio } from './media/mesh-peer.js';
import { verificationPeerSignaling } from './media/meet-signaling.js';
import { PostgresCallLedger } from './ledger-pg.js';
import { startLeaseKeeper, startReaper, terminateCall } from './compose.js';
import { startMediaKeepAlive } from './meet-media.js';

/** Assembles the real gateway with authoritative readiness; contains no lab readiness override. */
export function createGatewayRuntime(o: { sip: SipGatewayConfig; meet: MeetConfig; db: pg.Pool; instance?: string; signalingTls: { ca: string; cert: string; key: string } }) {
  if (o.sip.labMode) throw new Error('The managed gateway runtime does not permit labMode');
  if (o.meet.auth.kind !== 'workload' || !o.meet.auth.cnfThumbprint || !o.meet.fetchImpl || !o.meet.baseUrl.startsWith('https://')) throw new Error('Managed gateway requires workload identity over certificate-bound mutual TLS');
  const instance = o.instance || 'sip-' + randomUUID();
  if(!/^[A-Za-z0-9_.:-]{1,80}$/.test(instance))throw new Error('Invalid gateway instance ID');
  const authority = new MeetPhoneAuthority(o.meet);
  const readiness = new MeetReadiness({ baseUrl: o.meet.baseUrl, auth: o.meet.auth, fetchImpl: o.meet.fetchImpl });
  const ledger = new PostgresCallLedger(o.db, instance);
  const sessions = new Map<string,string>();
  const wrapped = new Proxy(authority, { get(target, prop) {
    if (prop === 'verifyPhoneJoin') return async (...args: Parameters<MeetPhoneAuthority['verifyPhoneJoin']>) => { const d = await target.verifyPhoneJoin(...args); if(d.meetingSessionId && args[2]?.callId)sessions.set(args[2].callId,d.meetingSessionId);return d; };
    const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
  }});
  let gateway: ReturnType<typeof createSipGateway>;
  const terminate = async (id:string, reason:string) => { await terminateCall({bridge:gateway.bridge,authority:wrapped,ledger})({callId:id,meetingSessionId:sessions.get(id)||''},reason);sessions.delete(id); };
  gateway = createSipGateway(o.sip, { authority:wrapped, reporter:authority, ledger, readiness:()=>readiness.get(),
    meeting:new MeshPeerAudio({signaling:verificationPeerSignaling({baseUrl:o.meet.baseUrl,tls:o.signalingTls,authority})}),
    onEnded:async(id,reason,phase)=>{if(phase!=='ivr')await terminate(id,reason);sessions.delete(id);} });
  let timers: {stop():void}[] = [], beat: ReturnType<typeof setInterval>|undefined, started=false, reporting=false;
  const heartbeat = async () => { if(reporting)return;reporting=true;try{let healthy=started && gateway.health().sip.listening;try{await o.db.query('SELECT 1');}catch{healthy=false;}await authority.heartbeat(instance,healthy,healthy);}finally{reporting=false;} };
  return {
    gateway, authority, readiness,
    async start() {
      if(started)throw new Error('Gateway runtime already started');
      // No schema writes or readiness fabrication: operator applies the documented migrations first.
      await o.db.query('SELECT lease_owner, lease_generation, lease_expires_at FROM phone_join_calls LIMIT 0');
      const address = await gateway.start();started=true;
      try {
        if(!await authority.heartbeat(instance,true,true))throw new Error('Meet refused authenticated gateway heartbeat');
        timers = [startLeaseKeeper({ledger,bridge:gateway.bridge}), startReaper({ledger,bridge:gateway.bridge,authority:wrapped}),
          startMediaKeepAlive({legs:gateway.bridge.legs,measure:async id=>gateway.gateway.measure(id),meet:authority,terminate:(id,r)=>gateway.gateway.stop(id,r),peerJti:id=>gateway.gateway.peerJti(id),intervalMs:2000})];
        beat=setInterval(()=>{heartbeat().catch(()=>undefined);},10_000);beat.unref();return address;
      } catch(e){started=false;await gateway.stop();throw e;}
    },
    async stop() { if(beat)clearInterval(beat);for(const t of timers)t.stop();timers=[];started=false;try{await gateway.stop();}finally{await authority.heartbeat(instance,false,false).catch(()=>false);sessions.clear();} }
  };
}
