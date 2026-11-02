import {randomUUID, createHmac, timingSafeEqual} from 'node:crypto';
export const STATES={ringing:['active','rejected','missed','ended','failed'],active:['ended','failed'],rejected:[],missed:[],ended:[],failed:[]};
export function allowedTransition(from,to){return STATES[from]?.includes(to)===true;}
export function validExtension(v){return typeof v==='string'&&/^[0-9]{3,8}$/.test(v);}
export function validCallId(v){return typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);}
export function newId(){return randomUUID();}
export function turnCredentials(accountId,ttl=600,now=Math.floor(Date.now()/1000)){
 const secret=process.env.TURN_SHARED_SECRET;
 if(!secret) throw new Error('turn_not_configured');
 const username=`${now+ttl}:${accountId}`;
 return {username,credential:createHmac('sha1',secret).update(username).digest('base64'),ttl};
}
export function safeSignal(msg){
 if(!msg||typeof msg!=='object'||!['offer','answer','ice'].includes(msg.type)||!validCallId(msg.callId)) return false;
 if(msg.type==='ice') return msg.candidate===null||(typeof msg.candidate==='object'&&typeof msg.candidate.candidate==='string'&&msg.candidate.candidate.length<4096);
 return typeof msg.sdp==='string'&&msg.sdp.length>0&&msg.sdp.length<=65536;
}
