import {randomUUID} from 'node:crypto';
import {assert,hash,requireDependencies,safeText,Forbidden} from './security.mjs';
import {appendEvent} from './outbox.mjs';

// No AI model endpoints or secrets in browser code. All AI calls go through the existing Portal gateway.
export function createPrivateReports(deps){
 requireDependencies(deps,['pool','meetAuth','roomAuthority','portalBridge','entitlements','quota']);
 const {pool,meetAuth,roomAuthority,portalBridge,entitlements,quota}=deps;
 async function consentSnapshot(db,occurrenceId,roomId){
  const {rows}=await db.query(`SELECT participant_id,granted,revision FROM smartrooms_v18.room_consent
    WHERE occurrence_id=$1 AND room_id=$2 AND purpose='ai_report' ORDER BY participant_id`,[occurrenceId,roomId]);
  return rows;
 }
 async function validateConsent(db,occurrenceId,roomId){
  // Actual roster comes from trusted Meet membership service; never trust browser-supplied roster.
  const roster=await roomAuthority.listActiveParticipants({occurrenceId,roomId});
  assert(Array.isArray(roster)&&roster.length>0,'No active participants');
  const consent=await consentSnapshot(db,occurrenceId,roomId);
  const allowed=new Set(consent.filter(x=>x.granted).map(x=>x.participant_id));
  assert(roster.every(p=>allowed.has(p.participantId)),'Every active room participant must consent');
  return hash({roster:roster.map(p=>p.participantId).sort(),consent});
 }
 return {
  async setConsent({session,occurrenceId,roomId,granted}){
   const actor=await meetAuth.verify(session,occurrenceId);assert(actor?.active);
   await roomAuthority.requireRoomMember({actor,occurrenceId,roomId});
   const db=await pool.connect();try{await db.query('BEGIN');
    await db.query(`INSERT INTO smartrooms_v18.room_consent(occurrence_id,room_id,participant_id,purpose,granted)
    VALUES($1,$2,$3,'ai_report',$4) ON CONFLICT(occurrence_id,room_id,participant_id,purpose)
    DO UPDATE SET granted=EXCLUDED.granted,revision=room_consent.revision+1,updated_at=now()`,[occurrenceId,roomId,actor.participantId,!!granted]);
    await appendEvent(db,{occurrenceId,roomId,kind:'room.ai.consent_changed',payload:{participantId:actor.participantId,granted:!!granted}});
    if(!granted)await db.query(`UPDATE smartrooms_v18.ai_jobs SET state='cancelled',updated_at=now()
      WHERE occurrence_id=$1 AND room_id=$2 AND state IN ('queued','processing')`,[occurrenceId,roomId]);
    await db.query(`INSERT INTO smartrooms_v18.audit(occurrence_id,actor_id,action,target_id) VALUES($1,$2,'ai.consent_changed',$3)`,[occurrenceId,actor.participantId,roomId]);
    await db.query('COMMIT');return {granted:!!granted};
   }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  },
  async requestReport({session,occurrenceId,roomId,source}){
   const actor=await meetAuth.verify(session,occurrenceId);assert(actor?.active);
   await roomAuthority.requireHostOrRoomLead({actor,occurrenceId,roomId});
   const policy=await entitlements.get({actor,feature:'smartrooms.ai_report'});
   assert(policy?.allowed,'AI reports not included in plan');
   const normalized=safeText(source);
   assert(normalized.length>0,'Empty report source');
   const id=randomUUID();const reservation=`smartroom-report:${id}`;
   const db=await pool.connect();let reserved=false;
   try{await db.query('BEGIN');
    // Lock a stable room-level row in the actual Meet DB via trusted authority before checking roster.
    await roomAuthority.lockRoomForConsent(db,{occurrenceId,roomId});
    const fingerprint=await validateConsent(db,occurrenceId,roomId);
    // Quota adapter must use durable, idempotent reservation; not in-memory counters.
    const result=await quota.reserve({actor,feature:'smartrooms.ai_report',idempotencyKey:reservation,units:1});
    assert(result?.reserved,'AI quota exhausted');reserved=true;
    await db.query(`INSERT INTO smartrooms_v18.ai_jobs(id,occurrence_id,room_id,requested_by,state,quota_reservation,consent_fingerprint,source_digest)
      VALUES($1,$2,$3,$4,'queued',$5,$6,$7)`,[id,occurrenceId,roomId,actor.participantId,reservation,fingerprint,hash(normalized)]);
    // DO NOT persist raw transcript or send it in the outbox. A trusted short-lived encrypted source store is required.
    await portalBridge.stageEncryptedSource({jobId:id,occurrenceId,roomId,source:normalized,ttlSeconds:900});
    await appendEvent(db,{occurrenceId,roomId,kind:'room.ai.report_queued',payload:{jobId:id}});
    await db.query('COMMIT');return {jobId:id,status:'queued'};
   }catch(e){await db.query('ROLLBACK');if(reserved)await quota.release({idempotencyKey:reservation}).catch(()=>{});await portalBridge.deleteStagedSource?.({jobId:id}).catch(()=>{});throw e;}
   finally{db.release();}
  },
  async processJob(jobId){
   // A distributed worker must lease jobs; this method is intended to be called only under an external exclusive lease.
   const {rows:[job]}=await pool.query(`SELECT * FROM smartrooms_v18.ai_jobs WHERE id=$1`,[jobId]);
   if(!job||job.state!=='queued')return {status:'skipped'};
   const db=await pool.connect();try{
    await db.query('BEGIN');await roomAuthority.lockRoomForConsent(db,{occurrenceId:job.occurrence_id,roomId:job.room_id});
    const current=await validateConsent(db,job.occurrence_id,job.room_id);
    assert(current===job.consent_fingerprint,'Consent or room membership changed');
    await db.query(`UPDATE smartrooms_v18.ai_jobs SET state='processing',updated_at=now() WHERE id=$1 AND state='queued'`,[jobId]);
    await db.query('COMMIT');
   }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
   // Portal gateway owns private model selection, quota policy, tenant boundary, and logging minimization.
   const report=await portalBridge.generateRoomReport({jobId,occurrenceId:job.occurrence_id,roomId:job.room_id});
   const final=await pool.connect();try{await final.query('BEGIN');
    await roomAuthority.lockRoomForConsent(final,{occurrenceId:job.occurrence_id,roomId:job.room_id});
    const current=await validateConsent(final,job.occurrence_id,job.room_id);
    if(current!==job.consent_fingerprint){await final.query(`UPDATE smartrooms_v18.ai_jobs SET state='cancelled',updated_at=now() WHERE id=$1`,[jobId]);await final.query('COMMIT');return {status:'cancelled'};}
    const r=await final.query(`UPDATE smartrooms_v18.ai_jobs SET state='complete',report=$2,updated_at=now() WHERE id=$1 AND state='processing' RETURNING id`,[jobId,report]);
    if(r.rowCount)await appendEvent(final,{occurrenceId:job.occurrence_id,roomId:job.room_id,kind:'room.ai.report_ready',payload:{jobId}});
    await final.query('COMMIT');if(r.rowCount)await quota.commit({idempotencyKey:job.quota_reservation});
    return {status:r.rowCount?'complete':'cancelled'};
   }catch(e){await final.query('ROLLBACK');throw e;}finally{final.release();await portalBridge.deleteStagedSource?.({jobId}).catch(()=>{});}
  },
  async getReport({session,occurrenceId,jobId}){
   const actor=await meetAuth.verify(session,occurrenceId);assert(actor?.active);
   const {rows:[job]}=await pool.query(`SELECT * FROM smartrooms_v18.ai_jobs WHERE id=$1 AND occurrence_id=$2`,[jobId,occurrenceId]);
   if(!job)throw new Forbidden('Report not found',404);
   await roomAuthority.requireHostOrRoomMember({actor,occurrenceId,roomId:job.room_id});
   return {state:job.state,report:job.state==='complete'?job.report:null};
  }
 };
}
