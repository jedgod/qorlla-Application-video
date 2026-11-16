import {validateGatewayEvent,reconcileAmounts} from './integration.mjs';
import {PolicyError,canTransition} from './policy.mjs';
import {digest} from './gateway-auth.mjs';
export class PostgresIntegration {
 constructor(pool){this.pool=pool;}
 async transaction(fn){const c=await this.pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async gatewayEvent(event){const to=validateGatewayEvent(event);return this.transaction(async c=>{
  const call=await c.query('SELECT state,tenant_id FROM telephony_calls WHERE id=$1 FOR UPDATE',[event.callId]);
  if(!call.rowCount)throw new PolicyError('CALL_NOT_FOUND',404);
  const seen=await c.query('SELECT 1 FROM telephony_gateway_events WHERE event_id=$1 OR (gateway_id=$2 AND call_id=$3 AND sequence_no=$4)',[event.eventId,event.gatewayId,event.callId,event.sequence]);
  if(seen.rowCount)return {replayed:true,state:call.rows[0].state};
  const latest=await c.query('SELECT max(sequence_no) AS seq FROM telephony_gateway_events WHERE gateway_id=$1 AND call_id=$2',[event.gatewayId,event.callId]);
  if(latest.rows[0].seq!==null && event.sequence<=Number(latest.rows[0].seq))throw new PolicyError('STALE_GATEWAY_EVENT',409);
  if(to==='connected'){
   const admission=await c.query('SELECT approval_state FROM telephony_meet_admissions WHERE call_id=$1',[event.callId]);
   if(event.meetingId && (!admission.rowCount||admission.rows[0].approval_state!=='approved'))throw new PolicyError('MEET_ADMISSION_DENIED',403);
  }
  if(!canTransition(call.rows[0].state,to,event.evidence))throw new PolicyError('INVALID_CALL_TRANSITION',409);
  await c.query('INSERT INTO telephony_gateway_events(event_id,call_id,gateway_id,sequence_no,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[event.eventId,event.callId,event.gatewayId,event.sequence,event.type,JSON.stringify(event)]);
  await c.query("UPDATE telephony_calls SET state=$2,version=version+1,connected_at=CASE WHEN $2='connected' THEN now() ELSE connected_at END,ended_at=CASE WHEN $2 IN ('ended','failed') THEN now() ELSE ended_at END WHERE id=$1",[event.callId,to]);
  await c.query('INSERT INTO telephony_events(call_id,event_type,payload,event_key) VALUES($1,$2,$3,$4)',[event.callId,to,JSON.stringify(event.evidence||{}),event.eventId]);
  await c.query('INSERT INTO telephony_outbox(call_id,topic,payload) VALUES($1,$2,$3)',[event.callId,'call.'+to,JSON.stringify({callId:event.callId,state:to})]);
  return {replayed:false,state:to};
 });}
 async admit({callId,meetingId,approved,actorId}){return this.transaction(async c=>{
  const call=await c.query('SELECT id FROM telephony_calls WHERE id=$1 FOR UPDATE',[callId]);if(!call.rowCount)throw new PolicyError('CALL_NOT_FOUND',404);
  const state=approved?'approved':'denied';
  await c.query('INSERT INTO telephony_meet_admissions(call_id,meeting_id,approval_state,approved_by) VALUES($1,$2,$3,$4) ON CONFLICT(call_id) DO UPDATE SET approval_state=excluded.approval_state,approved_by=excluded.approved_by,updated_at=now()',[callId,meetingId,state,actorId]);
  await c.query('INSERT INTO telephony_outbox(call_id,topic,payload) VALUES($1,$2,$3)',[callId,'meet.admission',JSON.stringify({callId,meetingId,state})]);return {state};
 });}
 async reconcile({carrierId,cdrId,callId,seconds,amountMinor,currency,raw}){if(!Number.isSafeInteger(seconds)||seconds<0||!Number.isSafeInteger(amountMinor)||amountMinor<0||!/^[A-Z]{3}$/.test(currency))throw new PolicyError('INVALID_CDR',422);
 return this.transaction(async c=>{
  const call=await c.query('SELECT id FROM telephony_calls WHERE id=$1 FOR UPDATE',[callId]);if(!call.rowCount)throw new PolicyError('CALL_NOT_FOUND',404);
  const existing=await c.query('SELECT raw_hash FROM telephony_carrier_cdr WHERE carrier_id=$1 AND external_cdr_id=$2',[carrierId,cdrId]);const rawHash=digest(raw);
  if(existing.rowCount){if(existing.rows[0].raw_hash!==rawHash)throw new PolicyError('CDR_CONFLICT',409);return {replayed:true};}
  await c.query('INSERT INTO telephony_carrier_cdr(carrier_id,external_cdr_id,call_id,seconds,amount_minor,currency,raw_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[carrierId,cdrId,callId,seconds,amountMinor,currency,rawHash]);
  const usage=await c.query('SELECT amount_minor,currency FROM telephony_usage WHERE call_id=$1',[callId]);
  const result=usage.rowCount?reconcileAmounts({localMinor:Number(usage.rows[0].amount_minor),carrierMinor:amountMinor,currency:usage.rows[0].currency.trim(),carrierCurrency:currency}):{status:'pending',differenceMinor:0};
  await c.query('INSERT INTO telephony_reconciliation(call_id,status,difference_minor) VALUES($1,$2,$3) ON CONFLICT(call_id) DO UPDATE SET status=excluded.status,difference_minor=excluded.difference_minor,updated_at=now()',[callId,result.status,result.differenceMinor]);return result;
 });}
 async leaseOutbox({workerId,limit=20}){return this.transaction(async c=>{
  const rows=await c.query(`SELECT o.id,o.call_id,o.topic,o.payload,o.attempts FROM telephony_outbox o LEFT JOIN telephony_outbox_delivery d ON d.outbox_id=o.id WHERE o.delivered_at IS NULL AND COALESCE(d.next_attempt_at,now())<=now() AND (d.lease_until IS NULL OR d.lease_until<now()) AND d.dead_lettered_at IS NULL ORDER BY o.id LIMIT $1 FOR UPDATE OF o SKIP LOCKED`,[limit]);
  for(const row of rows.rows)await c.query("INSERT INTO telephony_outbox_delivery(outbox_id,lease_owner,lease_until) VALUES($1,$2,now()+interval '30 seconds') ON CONFLICT(outbox_id) DO UPDATE SET lease_owner=excluded.lease_owner,lease_until=excluded.lease_until",[row.id,workerId]);return rows.rows;
 });}
 async finishOutbox({id,workerId,ok,error}){return this.transaction(async c=>{
  const owned=await c.query('SELECT lease_owner FROM telephony_outbox_delivery WHERE outbox_id=$1 FOR UPDATE',[id]);if(!owned.rowCount||owned.rows[0].lease_owner!==workerId)throw new PolicyError('OUTBOX_LEASE_LOST',409);
  if(ok)await c.query('UPDATE telephony_outbox SET delivered_at=now(),attempts=attempts+1 WHERE id=$1',[id]);
  else {await c.query('UPDATE telephony_outbox SET attempts=attempts+1 WHERE id=$1',[id]);await c.query("UPDATE telephony_outbox_delivery SET next_attempt_at=now()+make_interval(secs=>LEAST(3600,POWER(2,LEAST(10,(SELECT attempts FROM telephony_outbox WHERE id=$1)))::int)),last_error=$2,dead_lettered_at=CASE WHEN (SELECT attempts FROM telephony_outbox WHERE id=$1)>=12 THEN now() ELSE NULL END WHERE outbox_id=$1",[id,String(error).slice(0,500)]);}
  await c.query('UPDATE telephony_outbox_delivery SET lease_owner=NULL,lease_until=NULL WHERE outbox_id=$1',[id]);
 });}
}
