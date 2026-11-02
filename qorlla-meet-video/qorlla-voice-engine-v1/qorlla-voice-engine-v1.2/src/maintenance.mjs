import {pool} from './store.mjs';
import {pruneTickets} from './tickets.mjs';
export async function expireRinging(db=pool,minutes=1){
 if(!Number.isInteger(minutes)||minutes<1||minutes>10) throw Error('invalid_timeout');
 const {rows}=await db.query(`WITH expired AS (
 UPDATE voice_calls SET status='missed', ended_at=now(), end_reason='ring_timeout',version=version+1
 WHERE status='ringing' AND created_at<now()-($1::int*interval '1 minute')
 RETURNING id,caller_id,callee_id,status,created_at,answered_at,ended_at,version
 ), audit AS (
 INSERT INTO voice_call_events(call_id,actor_id,kind)
 SELECT id,'system','missed' FROM expired RETURNING call_id
 ) SELECT expired.* FROM expired JOIN audit ON audit.call_id=expired.id`,[minutes]);
 return rows;
}
export function startMaintenance(onExpired,{intervalMs=15000,timeoutMinutes=1}={}){
 let busy=false;
 const timer=setInterval(async()=>{
 if(busy)return;busy=true;
 try{for(const call of await expireRinging(pool,timeoutMinutes))onExpired(call);await pruneTickets();}
 catch(e){console.error('voice maintenance failed',e?.code||'unknown');}
 finally{busy=false;}
 },intervalMs);timer.unref?.();return ()=>clearInterval(timer);
}
