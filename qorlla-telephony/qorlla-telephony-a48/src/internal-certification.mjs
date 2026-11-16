import {PolicyError} from './policy.mjs';
import {validateGatewayEvent} from './integration.mjs';

// Execute all methods with a pg Pool. Never accept gatewayId or tenantId from browser identity.
export class InternalCertification {
 constructor(pool,{shieldAuthorize,meetAuthorize}={}) {
  this.pool=pool; this.shieldAuthorize=shieldAuthorize; this.meetAuthorize=meetAuthorize;
 }
 async tx(fn) {
  const c=await this.pool.connect();
  try {await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 async registerNonce({principalId,nonce,timestampMs}) {
  if(typeof principalId!=='string'||!principalId||typeof nonce!=='string'||!Number.isSafeInteger(timestampMs)||Math.abs(Date.now()-timestampMs)>60000)throw new PolicyError('INVALID_NONCE',401);
  return this.tx(async c=>{
   const r=await c.query(`INSERT INTO telephony_auth_nonces(principal_id,nonce,expires_at) VALUES($1,$2,to_timestamp($3 / 1000.0)+interval '2 minutes') ON CONFLICT DO NOTHING RETURNING nonce`,[principalId,nonce,timestampMs]);
   if(r.rowCount!==1)throw new PolicyError('REPLAY_DETECTED',409);
   return true;
  });
 }
 async bindGateway({callId,gatewayId,gatewaySessionId,meetingId=null,tenantId}) {
  if(!callId||!gatewayId||!gatewaySessionId||!tenantId)throw new PolicyError('INVALID_BINDING',422);
  return this.tx(async c=>{
   const call=await c.query('SELECT kind,state FROM telephony_calls WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[callId,tenantId]);
   if(call.rowCount!==1||call.rows[0].kind!=='internal'||['ended','failed'].includes(call.rows[0].state))throw new PolicyError('CALL_NOT_ELIGIBLE',403);
   const r=await c.query('INSERT INTO telephony_gateway_bindings(call_id,gateway_id,gateway_session_id,meeting_id) VALUES($1,$2,$3,$4) ON CONFLICT(call_id) DO NOTHING RETURNING call_id',[callId,gatewayId,gatewaySessionId,meetingId]);
   if(r.rowCount!==1)throw new PolicyError('GATEWAY_ALREADY_BOUND',409);
   return {bound:true};
  });
 }
 async acceptEvent({event,principalId}) {
  validateGatewayEvent(event);
  if(event.gatewayId!==principalId||typeof event.gatewaySessionId!=='string'||!event.gatewaySessionId)throw new PolicyError('GATEWAY_IDENTITY_MISMATCH',403);
  // Shield and Meet are authoritative. Deny on outage; never trust client-supplied approval.
  if(typeof this.shieldAuthorize!=='function'||!(await this.shieldAuthorize({callId:event.callId,gatewayId:principalId,type:event.type})))throw new PolicyError('SHIELD_DENIED',403);
  if(event.meetingId && (typeof this.meetAuthorize!=='function'||!(await this.meetAuthorize({callId:event.callId,meetingId:event.meetingId,type:event.type}))))throw new PolicyError('MEET_DENIED',403);
  return this.tx(async c=>{
   const binding=await c.query(`SELECT b.gateway_id,b.gateway_session_id,b.meeting_id,b.revoked_at,t.kind,t.state FROM telephony_gateway_bindings b JOIN telephony_calls t ON t.id=b.call_id WHERE b.call_id=$1 FOR UPDATE OF b,t`,[event.callId]);
   if(binding.rowCount!==1)throw new PolicyError('UNBOUND_GATEWAY',403);
   const b=binding.rows[0];
   if(b.kind!=='internal'||b.revoked_at||b.gateway_id!==principalId||b.gateway_session_id!==event.gatewaySessionId||b.meeting_id!==(event.meetingId??null))throw new PolicyError('GATEWAY_BINDING_MISMATCH',403);
   const gate=await c.query("SELECT enabled FROM telephony_release_gates WHERE gate='internal'");
   if(gate.rowCount!==1||gate.rows[0].enabled!==true)throw new PolicyError('INTERNAL_CALLS_DISABLED',403);
   return {authorized:true};
  });
 }
 async queueMeetCommand({commandId,callId,meetingId,action,actorId}) {
  if(!['admit','deny','mute','remove','end'].includes(action)||!commandId||!callId||!meetingId||!actorId)throw new PolicyError('INVALID_MEET_COMMAND',422);
  if(typeof this.shieldAuthorize!=='function'||!(await this.shieldAuthorize({callId,actorId,action})))throw new PolicyError('SHIELD_DENIED',403);
  if(typeof this.meetAuthorize!=='function'||!(await this.meetAuthorize({callId,meetingId,actorId,action})))throw new PolicyError('MEET_DENIED',403);
  return this.tx(async c=>{
   const call=await c.query('SELECT kind FROM telephony_calls WHERE id=$1 FOR UPDATE',[callId]);
   if(call.rowCount!==1||call.rows[0].kind!=='internal')throw new PolicyError('CALL_NOT_ELIGIBLE',403);
   const r=await c.query('INSERT INTO telephony_meet_commands(command_id,call_id,meeting_id,action) VALUES($1,$2,$3,$4) ON CONFLICT(command_id) DO NOTHING RETURNING command_id',[commandId,callId,meetingId,action]);
   if(r.rowCount!==1)return {replayed:true};
   await c.query('INSERT INTO telephony_outbox(call_id,topic,payload) VALUES($1,$2,$3)',[callId,'meet.command',JSON.stringify({commandId,callId,meetingId,action})]);
   return {queued:true};
  });
 }
}
