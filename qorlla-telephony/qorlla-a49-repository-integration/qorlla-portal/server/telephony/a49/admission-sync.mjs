// Poll Meet's authoritative host decision; stage outbox after Shield reauthorization.
import crypto from 'node:crypto';
import {transaction,TelephonyError,uuid} from './core.mjs';
const validUrl=s=>typeof s==='string'&&s.startsWith('https://');
export function createAdmissionSync({pool,meetBaseUrl,meetSecret,shieldAuthorize,fetchImpl=fetch}){
  if(!validUrl(meetBaseUrl)||typeof meetSecret!=='string'||meetSecret.length<32||typeof shieldAuthorize!=='function')
    throw new Error('Secure Meet and Shield clients required');
  async function checkDecision(callId){
    if(!uuid(callId))throw new TelephonyError('INVALID_CALL_ID',422);
    const r=await fetchImpl(`${meetBaseUrl.replace(/\/$/,'')}/api/integrations/a49/decisions/${callId}`,{
      headers:{authorization:`Bearer ${meetSecret}`},redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!r.ok)throw new TelephonyError('MEET_DECISION_UNAVAILABLE',503);
    const decision=await r.json();
    if(decision?.callId!==callId||!uuid(decision.meetingId)||!['pending','approved','denied','removed'].includes(decision.decision))
      throw new TelephonyError('INVALID_MEET_DECISION',503);
    return decision;
  }
  async function sync(callId){
    const d=await checkDecision(callId);
    if(d.decision==='pending')return {queued:false,reason:'pending'};
    if(d.decision==='removed')return {queued:false,reason:'removed'};
    if(!uuid(d.hostParticipantId))throw new TelephonyError('HOST_IDENTITY_NOT_VERIFIED',503);
    const action=d.decision==='approved'?'admit':'deny';
    const permitted=await shieldAuthorize({callId,meetingId:d.meetingId,actorId:d.hostParticipantId,action});
    if(permitted!==true)throw new TelephonyError('SHIELD_DENIED',403);
    return transaction(pool,async c=>{
      const q=await c.query('SELECT id,meeting_id,kind,state FROM portal.a49_calls WHERE id=$1 FOR UPDATE',[callId]);
      const call=q.rows[0];
      if(!call||call.kind!=='internal'||call.meeting_id!==d.meetingId||['ended','failed'].includes(call.state))
        throw new TelephonyError('INVALID_MEET_CALL',409);
      const gate=(await c.query("SELECT enabled FROM portal.a49_gates WHERE kind='internal' FOR SHARE")).rows[0];
      if(gate?.enabled!==true)throw new TelephonyError('INTERNAL_CALLS_DISABLED',503);
      const exists=await c.query('SELECT command_id FROM portal.a49_meet_commands WHERE call_id=$1 AND action=$2',[callId,action]);
      if(exists.rowCount)return {queued:false,replayed:true,commandId:exists.rows[0].command_id};
      const commandId=crypto.randomUUID();
      await c.query('INSERT INTO portal.a49_meet_commands(command_id,call_id,meeting_id,action,actor_id) VALUES($1,$2,$3,$4,$5)',
        [commandId,callId,d.meetingId,action,d.hostParticipantId]);
      await c.query('INSERT INTO portal.a49_outbox(event_id,call_id,topic,payload) VALUES($1,$2,$3,$4::jsonb)',[
        commandId,callId,'meet.command',JSON.stringify({commandId,callId,meetingId:d.meetingId,action})]);
      return {queued:true,commandId};
    });
  }
  return {checkDecision,sync};
}
