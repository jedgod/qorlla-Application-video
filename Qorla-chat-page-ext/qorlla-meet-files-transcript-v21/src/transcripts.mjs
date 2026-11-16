import {randomUUID} from 'node:crypto';
import {assertActor,isHost} from './policy.mjs';
const fail=(s)=>{throw new Error(s)};
export function transcriptService({pool,authority,mediaControl,stt}){
 if(!pool||!authority||!mediaControl||!stt)throw new Error('missing_dependency');
 async function auth(token,occ){const a=await authority.verify(token,occ);assertActor(a,a?.tenantId,occ);return a;}
 async function members(client,a,roomId){return (await authority.listActiveRoomMembers(client,a.tenantId,a.occurrenceId,roomId)).map(x=>x.participantId).sort();}
 async function lockSession(c,a,id){const r=await c.query(`SELECT * FROM meet_collab.transcript_sessions WHERE id=$1 AND tenant_id=$2 AND occurrence_id=$3 FOR UPDATE`,[id,a.tenantId,a.occurrenceId]);if(!r.rows[0])fail('not_found');return r.rows[0];}
 async function halt(id){await mediaControl.stopCapture(id);await stt.stop(id);}
 return {
  async create(token,occ,roomId,language='en'){
   const a=await auth(token,occ);if(!isHost(a))fail('host_required');if(!/^[a-z]{2}(-[A-Z]{2})?$/.test(language))fail('invalid_language');
   const c=await pool.connect(),id=randomUUID();try{await c.query('BEGIN');const list=await members(c,a,roomId);
    if(!list.length)fail('empty_room');await c.query(`INSERT INTO meet_collab.transcript_sessions(id,tenant_id,occurrence_id,room_id,created_by,language) VALUES($1,$2,$3,$4,$5,$6)`,[id,a.tenantId,occ,roomId,a.participantId,language]);
    for(const participant of list)await c.query(`INSERT INTO meet_collab.transcript_participants(session_id,participant_id) VALUES($1,$2)`,[id,participant]);
    await c.query('COMMIT');return {id,status:'awaiting_consent',required:list.length};
   }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  },
  async consent(token,occ,id,yes){
   const a=await auth(token,occ),c=await pool.connect();let start=false,stop=false,epoch;
   try{await c.query('BEGIN');const s=await lockSession(c,a,id);if(s.status==='stopped')fail('stopped');
    const member=await c.query(`SELECT 1 FROM meet_collab.transcript_participants WHERE session_id=$1 AND participant_id=$2`,[id,a.participantId]);if(!member.rowCount)fail('not_participant');
    await c.query(`UPDATE meet_collab.transcript_participants SET consent=$3,consent_at=CASE WHEN $3 THEN now() ELSE NULL END,revoked_at=CASE WHEN $3 THEN NULL ELSE now() END WHERE session_id=$1 AND participant_id=$2`,[id,a.participantId,yes===true]);
    const current=await members(c,a,s.room_id),rows=(await c.query(`SELECT participant_id,consent FROM meet_collab.transcript_participants WHERE session_id=$1`,[id])).rows;
    const all=current.length>0&&current.length===rows.length&&current.every(m=>rows.some(r=>r.participant_id===m&&r.consent));
    const newStatus=all?'active':'paused';start=all&&s.status!=='active';stop=!all&&s.status==='active';epoch=Number(s.consent_epoch)+1;
    await c.query(`UPDATE meet_collab.transcript_sessions SET status=$2,consent_epoch=$3 WHERE id=$1`,[id,newStatus,epoch]);await c.query('COMMIT');
   }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
   // Fail closed: capture service MUST check epoch with DB before accepting audio; revoke invalidates old epoch.
   if(stop||!yes)await halt(id);
   if(start){try{await stt.start(id,epoch);await mediaControl.startCapture(id,epoch);}catch(e){await halt(id);await pool.query(`UPDATE meet_collab.transcript_sessions SET status='paused',consent_epoch=consent_epoch+1 WHERE id=$1`,[id]);throw e}}
   return {id,status:start?'active':'paused',consentEpoch:epoch};
  },
  async membershipChanged(tenant,occ,roomId){
   const r=await pool.query(`UPDATE meet_collab.transcript_sessions SET status='paused',consent_epoch=consent_epoch+1 WHERE tenant_id=$1 AND occurrence_id=$2 AND room_id IS NOT DISTINCT FROM $3 AND status='active' RETURNING id`,[tenant,occ,roomId]);await Promise.all(r.rows.map(x=>halt(x.id)));return r.rowCount;
  },
  async ingestFromTrustedWorker({sessionId,epoch,speakerId,startMs,endMs,text,confidence}){
   if(!Number.isSafeInteger(startMs)||!Number.isSafeInteger(endMs)||endMs<startMs||typeof text!=='string'||text.length>10000)fail('invalid_segment');
   const c=await pool.connect();try{await c.query('BEGIN');const r=await c.query(`SELECT * FROM meet_collab.transcript_sessions WHERE id=$1 FOR UPDATE`,[sessionId]);const s=r.rows[0];if(!s||s.status!=='active'||Number(s.consent_epoch)!==epoch)fail('stale_or_paused');
    const a={tenantId:s.tenant_id,occurrenceId:s.occurrence_id};const current=await members(c,a,s.room_id);
    const rows=(await c.query(`SELECT participant_id,consent FROM meet_collab.transcript_participants WHERE session_id=$1`,[sessionId])).rows;
    if(current.length!==rows.length||!current.every(m=>rows.some(r=>r.participant_id===m&&r.consent))||!current.includes(speakerId))fail('consent_invalid');
    const id=randomUUID();await c.query(`INSERT INTO meet_collab.transcript_segments(id,session_id,tenant_id,speaker_id,consent_epoch,start_ms,end_ms,text,confidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[id,sessionId,s.tenant_id,speakerId,epoch,startMs,endMs,text,confidence??null]);await c.query('COMMIT');return {accepted:true};
   }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  },
  async list(token,occ,id){const a=await auth(token,occ);const r=await pool.query(`SELECT * FROM meet_collab.transcript_sessions WHERE id=$1 AND tenant_id=$2 AND occurrence_id=$3`,[id,a.tenantId,occ]);const s=r.rows[0];if(!s)fail('not_found');if(!isHost(a)&&a.roomId!==s.room_id)fail('forbidden');
   const rows=await pool.query(`SELECT speaker_id,start_ms,end_ms,text,confidence FROM meet_collab.transcript_segments WHERE session_id=$1 ORDER BY start_ms LIMIT 5000`,[id]);return {session:{id,status:s.status,roomId:s.room_id},segments:rows.rows};},
  async stop(token,occ,id){const a=await auth(token,occ);if(!isHost(a))fail('host_required');await pool.query(`UPDATE meet_collab.transcript_sessions SET status='stopped',stopped_at=now(),consent_epoch=consent_epoch+1 WHERE id=$1 AND tenant_id=$2 AND occurrence_id=$3`,[id,a.tenantId,occ]);await halt(id);return {stopped:true};}
 };
}
