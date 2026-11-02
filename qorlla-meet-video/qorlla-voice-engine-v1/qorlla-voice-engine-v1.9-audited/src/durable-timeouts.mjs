import {pool} from './store.mjs';
import {appendEvent} from './reliability.mjs';
export async function expireOneCall(db=pool){
 const c=await db.connect();try{
  await c.query('BEGIN');
  const {rows}=await c.query(`SELECT * FROM voice_calls WHERE status='ringing'
   AND created_at < now()-interval '60 seconds' ORDER BY created_at
   FOR UPDATE SKIP LOCKED LIMIT 1`);
  const call=rows[0];if(!call){await c.query('COMMIT');return false;}
  const {rows:updated}=await c.query(`UPDATE voice_calls SET status='missed',ended_at=now(),
   end_reason='ring_timeout',version=version+1 WHERE id=$1 RETURNING *`,[call.id]);
  await c.query(`INSERT INTO voice_call_events(call_id,actor_id,kind) VALUES($1,'system','missed')`,[call.id]);
  for(const account of new Set([call.caller_id,call.callee_id]))
   await appendEvent(c,{account,callId:call.id,kind:'state',payload:{type:'state',call:updated[0]}});
  await c.query('COMMIT');return true;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release()}
}
export function startDurableTimeouts(db=pool){let running=false;const timer=setInterval(async()=>{
 if(running)return;running=true;try{for(let n=0;n<50;n++)if(!await expireOneCall(db))break}
 catch(e){console.error('durable_timeout_failed',e.message)}finally{running=false}
},5000);timer.unref?.();return()=>clearInterval(timer)}
