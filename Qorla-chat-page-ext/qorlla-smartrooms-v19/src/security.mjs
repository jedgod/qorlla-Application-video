import { createHmac, timingSafeEqual } from 'node:crypto';
export function signBody(secret, timestamp, body){return createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex')}
export function verifySignature(secret,timestamp,body,signature,now=Date.now()){
 if(!secret || !/^\d+$/.test(String(timestamp)) || !/^[0-9a-f]{64}$/i.test(String(signature)))return false;
 if(Math.abs(now-Number(timestamp))>60_000)return false;
 const a=Buffer.from(signBody(secret,timestamp,body),'hex'), b=Buffer.from(signature,'hex');
 return timingSafeEqual(a,b);
}
export function safeRoomEvent(actor,event){
 if(!actor?.active || actor.occurrenceId!==event.occurrence_id)return false;
 if(actor.role==='host'||actor.role==='cohost')return true;
 return event.room_id===null || (actor.roomId===event.room_id && actor.epoch===event.payload?.epoch);
}
export function mediaVerdict(evidence){
 const types=new Set(evidence.map(x=>x.source));
 return {clientReported:types.has('client'),relayObserved:types.has('turn'),gatewayObserved:types.has('gateway'),
  serverVerifiedMedia:types.has('gateway') && evidence.some(x=>x.source==='gateway'&&x.evidence?.authenticatedMediaPath===true),
  warning:'TURN allocation or browser connection reports do not prove end-to-end media delivery'};
}
