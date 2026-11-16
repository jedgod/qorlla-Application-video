import {createHash,randomUUID} from 'node:crypto';
import {PolicyError,canTransition} from './policy.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class TelephonyStore {
 constructor(pool){this.pool=pool;}
 async create({identity,decision,idempotencyKey}) {
  if(!/^[\w-]{8,128}$/.test(idempotencyKey||'')) throw new PolicyError('IDEMPOTENCY_KEY_REQUIRED',422);
  const client=await this.pool.connect();
  const callId=randomUUID(), requestHash=hash(decision);
  try {
   await client.query('BEGIN');
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${identity.tenantId}:${identity.userId}:${idempotencyKey}`]);
   const existing=await client.query('SELECT request_hash,call_id FROM telephony_idempotency WHERE tenant_id=$1 AND actor_id=$2 AND key=$3',[identity.tenantId,identity.userId,idempotencyKey]);
   if(existing.rowCount){
    if(existing.rows[0].request_hash!==requestHash) throw new PolicyError('IDEMPOTENCY_CONFLICT',409);
    await client.query('COMMIT');return {callId:existing.rows[0].call_id,replayed:true};
   }
   await client.query('INSERT INTO telephony_calls(id,tenant_id,actor_id,destination,kind,state,carrier_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[callId,identity.tenantId,identity.userId,decision.target,decision.kind,'authorized',decision.carrierId]);
   await client.query('INSERT INTO telephony_idempotency(tenant_id,actor_id,key,request_hash,call_id) VALUES($1,$2,$3,$4,$5)',[identity.tenantId,identity.userId,idempotencyKey,requestHash,callId]);
   await client.query('INSERT INTO telephony_outbox(call_id,topic,payload) VALUES($1,$2,$3)',[callId,'call.authorized',JSON.stringify({callId,kind:decision.kind})]);
   await client.query('COMMIT');return {callId,replayed:false};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }
 async transition({callId,tenantId,to,evidence,eventKey}){
  const client=await this.pool.connect();
  try{
   await client.query('BEGIN');
   const result=await client.query('SELECT state FROM telephony_calls WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[callId,tenantId]);
   if(!result.rowCount)throw new PolicyError('CALL_NOT_FOUND',404);
   const prior=await client.query('SELECT 1 FROM telephony_events WHERE event_key=$1',[eventKey]);
   if(prior.rowCount){await client.query('COMMIT');return {replayed:true,state:result.rows[0].state};}
   if(!canTransition(result.rows[0].state,to,evidence))throw new PolicyError('INVALID_CALL_TRANSITION',409);
   await client.query("UPDATE telephony_calls SET state=$1,version=version+1,connected_at=CASE WHEN $1='connected' THEN now() ELSE connected_at END,ended_at=CASE WHEN $1 IN ('ended','failed') THEN now() ELSE ended_at END WHERE id=$2",[to,callId]);
   await client.query('INSERT INTO telephony_events(call_id,event_type,payload,event_key) VALUES($1,$2,$3,$4)',[callId,to,JSON.stringify(evidence||{}),eventKey]);
   await client.query('INSERT INTO telephony_outbox(call_id,topic,payload) VALUES($1,$2,$3)',[callId,`call.${to}`,JSON.stringify({callId,state:to})]);
   await client.query('COMMIT');return {replayed:false,state:to};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }
}
