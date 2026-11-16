import crypto from 'node:crypto';
import {transaction,TelephonyError,uuid} from './core.mjs';
const ACTIONS=new Set(['admit','deny','mute','remove','end']);
export function createMeetQueue({pool,shieldAuthorize,hostAuthorize}) {
 if(typeof shieldAuthorize!=='function'||typeof hostAuthorize!=='function')throw new Error('Shield and host checks required');
 return {
   async queue({commandId=crypto.randomUUID(),callId,meetingId,actorId,action}) {
     if(!uuid(commandId)||!uuid(callId)||!uuid(meetingId)||!uuid(actorId)||!ACTIONS.has(action))throw new TelephonyError('BAD_MEET_COMMAND',422);
     if(await shieldAuthorize({callId,meetingId,actorId,action})!==true ||
       await hostAuthorize({callId,meetingId,actorId,action})!==true)throw new TelephonyError('NOT_AUTHORIZED',403);
     return transaction(pool,async c=>{
       const call=(await c.query('SELECT id,kind,meeting_id,state FROM portal.a49_calls WHERE id=$1 FOR UPDATE',[callId])).rows[0];
       if(!call||call.kind!=='internal'||call.meeting_id!==meetingId||['ended','failed'].includes(call.state))throw new TelephonyError('CALL_NOT_ELIGIBLE',409);
       const existing=await c.query('SELECT call_id,meeting_id,action,actor_id FROM portal.a49_meet_commands WHERE command_id=$1',[commandId]);
       if(existing.rowCount){const x=existing.rows[0];if(x.call_id!==callId||x.meeting_id!==meetingId||x.action!==action||x.actor_id!==actorId)throw new TelephonyError('COMMAND_CONFLICT',409);return {replayed:true};}
       await c.query('INSERT INTO portal.a49_meet_commands(command_id,call_id,meeting_id,action,actor_id) VALUES($1,$2,$3,$4,$5)',[commandId,callId,meetingId,action,actorId]);
       await c.query('INSERT INTO portal.a49_outbox(event_id,call_id,topic,payload) VALUES($1,$2,$3,$4::jsonb)',
         [commandId,callId,'meet.command',JSON.stringify({commandId,callId,meetingId,actorId,action})]);
       return {queued:true,commandId};
     });
   }
 };
}
