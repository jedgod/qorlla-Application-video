import {safeAIOutput,PolicyError} from './policy.mjs';
// The worker runs in the trusted Meet network. gateway MUST call the existing Qorlla AI gateway,
// not Ollama directly. Membership, consent and entitlement are rechecked at execution time.
export function createIntelligenceWorker({db,gateway,authorizeJob,quota,publish,featureEnabled}){
 for(const [k,v] of Object.entries({db,gateway,authorizeJob,quota,publish,featureEnabled}))if(!v)throw Error('missing_adapter:'+k);
 return async function runOne(){
  const c=await db.connect();let job;
  try{await c.query('BEGIN');const q=await c.query(`SELECT * FROM meet_more.intelligence_jobs WHERE state='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`);job=q.rows[0];if(!job){await c.query('COMMIT');return false;}
   await c.query("UPDATE meet_more.intelligence_jobs SET state='running',attempts=attempts+1,updated_at=now() WHERE id=$1",[job.id]);await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  try{
   if(await authorizeJob(job)!==true)throw new PolicyError('authorization_revoked');
   if(await featureEnabled('ai',job.occurrence_id)!==true)throw new PolicyError('feature_disabled');
   if(await quota.isReserved({jobId:job.id})!==true)throw new PolicyError('quota_not_reserved');
   const consent=await db.query("SELECT granted FROM meet_more.intelligence_consent WHERE occurrence_id=$1 AND actor_id=$2 AND kind='ai'",[job.occurrence_id,job.actor_id]);
   if(consent.rows[0]?.granted!==true)throw new PolicyError('consent_revoked');
   const transcript=await db.query('SELECT speaker_id,body,start_ms FROM meet_more.transcript_segments WHERE occurrence_id=$1 ORDER BY id DESC LIMIT 300',[job.occurrence_id]);
   const context=transcript.rows.reverse().map(x=>({speaker:x.speaker_id,text:x.body,at:x.start_ms}));
   if(!context.length)throw new PolicyError('no_authorized_transcript',409);
   const result=safeAIOutput(await gateway.generate({occurrenceId:job.occurrence_id,actorId:job.actor_id,kind:job.kind,question:job.prompt_question,context,requestId:job.id}));
   // Recheck after model processing to prevent publishing content following revocation.
   if(await authorizeJob(job)!==true)throw new PolicyError('authorization_revoked');
   const tx=await db.connect();try{await tx.query('BEGIN');const a=await tx.query('INSERT INTO meet_more.ai_artifacts(occurrence_id,kind,created_by,body,gateway_request_id) VALUES($1,$2,$3,$4,$5) RETURNING id',[job.occurrence_id,job.kind,job.actor_id,result,job.id]);await tx.query("UPDATE meet_more.intelligence_jobs SET state='completed',result_id=$2,updated_at=now() WHERE id=$1",[job.id,a.rows[0].id]);await tx.query('COMMIT');}catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
   await quota.commit({jobId:job.id});await publish(job.occurrence_id,{type:'intelligence.job.completed',jobId:job.id});
  }catch(e){await db.query("UPDATE meet_more.intelligence_jobs SET state='failed',error_code=$2,updated_at=now() WHERE id=$1",[job.id,e instanceof PolicyError?e.code:'processing_failed']);await quota.release({jobId:job.id});await publish(job.occurrence_id,{type:'intelligence.job.failed',jobId:job.id});}
  return true;
 };
}
