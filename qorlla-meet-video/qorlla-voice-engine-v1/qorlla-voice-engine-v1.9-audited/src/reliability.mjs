import {randomUUID} from 'node:crypto';
import {pool} from './store.mjs';
import {MAX_REPLAY,safeCursor,backoff,safeEvent} from './reliability-core.mjs';
export {MAX_REPLAY,safeCursor,backoff,safeEvent} from './reliability-core.mjs';
// Call this *inside the same transaction* that mutates voice_calls.
export async function appendEvent(tx,{account,callId,kind,payload}){
 if(!safeEvent(kind,payload))throw Error('invalid_reliable_event');
 const {rows}=await tx.query(`INSERT INTO voice_reliable_events(account_id,call_id,kind,payload)
 VALUES($1,$2,$3,$4::jsonb) RETURNING id`,[account,callId,kind,JSON.stringify(payload)]);
 await tx.query('INSERT INTO voice_outbox(event_id) VALUES($1)',[rows[0].id]);
 return Number(rows[0].id);
}
// Atomically commits a call transition and events for both participants.
export async function transitionReliable(callId,account,next,db=pool){
 const client=await db.connect();try{
  await client.query('BEGIN');
  const {rows}=await client.query('SELECT * FROM voice_calls WHERE id=$1 FOR UPDATE',[callId]);
  const call=rows[0];if(!call||![call.caller_id,call.callee_id].includes(account))throw Error('not_found');
  const allowed={ringing:['active','rejected','ended','missed'],active:['ended'],rejected:[],ended:[],missed:[]};
  if(!allowed[call.status]?.includes(next))throw Error('invalid_transition');
  if(next==='active'&&account!==call.callee_id)throw Error('forbidden');
  const result=await client.query(`UPDATE voice_calls SET status=$2,
  answered_at=CASE WHEN $2='active' THEN now() ELSE answered_at END,
  ended_at=CASE WHEN $2 IN ('ended','rejected','missed') THEN now() ELSE ended_at END
  WHERE id=$1 RETURNING *`,[callId,next]);
  for(const a of new Set([call.caller_id,call.callee_id]))await appendEvent(client,{account:a,callId,kind:'state',payload:{type:'state',call:result.rows[0]}});
  await client.query('COMMIT');return result.rows[0];
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export async function claimFencedDevice(callId,account,deviceId,db=pool){
 const client=await db.connect();try{
  await client.query('BEGIN');
  const {rows}=await client.query('SELECT * FROM voice_calls WHERE id=$1 FOR UPDATE',[callId]);
  const call=rows[0];if(!call||![call.caller_id,call.callee_id].includes(account))throw Error('not_found');
  if(!['ringing','active'].includes(call.status))throw Error('call_not_active');
  const token=randomUUID();
  const result=await client.query(`INSERT INTO voice_media_leases(call_id,account_id,device_id,lease_token,expires_at,generation)
 VALUES($1,$2,$3,$4,now()+interval '90 seconds',1)
 ON CONFLICT(call_id,account_id) DO UPDATE SET device_id=EXCLUDED.device_id,
 lease_token=EXCLUDED.lease_token,expires_at=EXCLUDED.expires_at,
 generation=voice_media_leases.generation+1 RETURNING *`,[callId,account,deviceId,token]);
  await appendEvent(client,{account,callId,kind:'device_claimed',payload:{type:'device_claimed',callId,deviceId,generation:Number(result.rows[0].generation)}});
  await client.query('COMMIT');return result.rows[0];
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export {ownsGeneration} from './lease-fencing.mjs';
export async function replay(account,after,db=pool){
 if(!safeCursor(after))throw Error('invalid_cursor');
 const {rows}=await db.query(`SELECT id,kind,payload,created_at FROM voice_reliable_events
 WHERE account_id=$1 AND id>$2 ORDER BY id LIMIT $3`,[account,after,MAX_REPLAY+1]);
 return {events:rows.slice(0,MAX_REPLAY).map(r=>({...r,id:Number(r.id)})),hasMore:rows.length>MAX_REPLAY};
}
export async function acknowledge(account,deviceId,cursor,db=pool){
 if(!safeCursor(cursor))throw Error('invalid_cursor');
 // Do not allow clients to acknowledge another account's events or arbitrary future IDs.
 const {rows}=await db.query(`SELECT EXISTS(SELECT 1 FROM voice_reliable_events WHERE account_id=$1 AND id=$2) AS owned`,[account,cursor]);
 if(cursor!==0&&!rows[0].owned)throw Error('invalid_cursor');
 const result=await db.query(`INSERT INTO voice_resume_cursors(account_id,device_id,last_ack)
 VALUES($1,$2,$3) ON CONFLICT(account_id,device_id) DO UPDATE
 SET last_ack=GREATEST(voice_resume_cursors.last_ack,EXCLUDED.last_ack),updated_at=now()
 RETURNING last_ack`,[account,deviceId,cursor]);return Number(result.rows[0].last_ack);
}
