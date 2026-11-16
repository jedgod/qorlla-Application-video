// Internal-only call request API. Qorlla portal identity/tenant is authoritative.
// No Twilio, SIP dial, carrier provisioning, or PSTN behavior is reachable here.
import crypto from 'node:crypto';
import {TelephonyError, uuid, transaction} from './core.mjs';
const EXT = /^[1-9][0-9]{1,7}$/;
const fail = (res, e) => res.status(e instanceof TelephonyError ? e.status : 503)
  .set('Cache-Control','no-store').json({code:e instanceof TelephonyError?e.code:'INTERNAL_CALL_UNAVAILABLE'});

export function createInternalCallService({pool, gatewayId, shieldAuthorize, gateEnvironment=()=>false}) {
  if (!/^[a-zA-Z0-9_-]{3,100}$/.test(gatewayId || '') || typeof shieldAuthorize !== 'function')
    throw new Error('A49 gateway and authoritative Shield integration required');
  return {async request({workspaceId,actorId,destinationUserId,meetingId=null,requestId}) {
    if(!uuid(workspaceId)||!uuid(actorId)||!uuid(destinationUserId)||!uuid(requestId)||
       (meetingId !== null && !uuid(meetingId))) throw new TelephonyError('INVALID_CALL_REQUEST',422);
    if(!gateEnvironment()) throw new TelephonyError('INTERNAL_CALLS_DISABLED',503);
    if(await shieldAuthorize({workspaceId,actorId,destinationUserId,meetingId,action:'voice.originate'})!==true)
      throw new TelephonyError('SHIELD_DENIED',403);
    return transaction(pool,async db=>{
      // Serialize parallel requests with the same idempotency key across replicas.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[requestId]);
      const gate=(await db.query("SELECT enabled FROM portal.a49_gates WHERE kind='internal' FOR SHARE")).rows[0];
      if(gate?.enabled !== true)throw new TelephonyError('INTERNAL_CALLS_DISABLED',503);
      const principal=(await db.query('SELECT active FROM portal.a49_gateway_principals WHERE id=$1 FOR SHARE',[gatewayId])).rows[0];
      if(principal?.active!==true)throw new TelephonyError('GATEWAY_NOT_ACTIVE',503);
      // Both participants must currently belong to the same workspace. This is NOT an external phone destination.
      const users=await db.query('SELECT user_id FROM portal.members WHERE workspace_id=$1 AND user_id=ANY($2::uuid[])',[workspaceId,[actorId,destinationUserId]]);
      if(new Set(users.rows.map(x=>x.user_id)).size!==new Set([actorId,destinationUserId]).size)
        throw new TelephonyError('DESTINATION_NOT_AUTHORIZED',403);
      const previous=(await db.query('SELECT id,workspace_id,requested_by,destination,meeting_id FROM portal.a49_calls WHERE request_id=$1 FOR UPDATE',[requestId])).rows[0];
      if(previous){
        if(previous.workspace_id!==workspaceId||previous.requested_by!==actorId||previous.destination!==destinationUserId||
           (previous.meeting_id??null)!==meetingId)throw new TelephonyError('IDEMPOTENCY_CONFLICT',409);
        return {callId:previous.id,replayed:true,status:'accepted'};
      }
      const callId=crypto.randomUUID(), sessionId=crypto.randomUUID();
      await db.query(`INSERT INTO portal.a49_calls(id,request_id,workspace_id,requested_by,kind,destination,meeting_id,gateway_id,gateway_session_id)
        VALUES($1,$2,$3,$4,'internal',$5,$6,$7,$8)`,[callId,requestId,workspaceId,actorId,destinationUserId,meetingId,gatewayId,sessionId]);
      if(meetingId){
        await db.query('INSERT INTO portal.a49_outbox(event_id,call_id,topic,payload) VALUES($1,$2,$3,$4::jsonb)',[
          crypto.randomUUID(),callId,'meet.waiting',JSON.stringify({callId,meetingId})]);
      }
      // Executor must be a separately authenticated, certified A4 endpoint; no embedded SIP implementation.
      await db.query('INSERT INTO portal.a49_outbox(event_id,call_id,topic,payload) VALUES($1,$2,$3,$4::jsonb)',[
        crypto.randomUUID(),callId,'gateway.originate',JSON.stringify({callId,sessionId,gatewayId,workspaceId,destinationUserId,meetingId})]);
      return {callId,replayed:false,status:'accepted'};
    });
  }};
}

export function registerA49CallApi(app,{pool,auth,gatewayId,shieldAuthorize,gateEnvironment,log}){
  const service=createInternalCallService({pool,gatewayId,shieldAuthorize,gateEnvironment});
  app.post('/api/v1/a49/internal/calls',auth.member,async(req,res)=>{
    try{
      const p=req.body||{};
      const result=await service.request({workspaceId:req.workspace,actorId:req.actor,
        destinationUserId:p.destinationUserId,meetingId:p.meetingId??null,requestId:req.get('idempotency-key')});
      res.set('Cache-Control','no-store').status(202).json(result);
    }catch(e){if(!(e instanceof TelephonyError)) log?.error('A49 call request failed',{code:e?.code||'unknown'});fail(res,e);}
  });
}
