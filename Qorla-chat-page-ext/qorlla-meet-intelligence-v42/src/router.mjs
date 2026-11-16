import express from 'express';
import {z,ZodError} from 'zod';
import {assertPrincipal,assertFeature,assertConsent,PolicyError} from './policy.mjs';
const id=z.string().min(1).max(160);
const jobInput=z.object({kind:z.enum(['summary','takeaways','answer']),question:z.string().trim().min(1).max(1500).optional(),idempotencyKey:z.string().uuid()}).strict();
const consentInput=z.object({kind:z.enum(['transcription','ai']),granted:z.boolean(),policyVersion:z.string().min(1).max(80)}).strict();
const segmentInput=z.object({captureId:z.string().min(1).max(160),speakerId:z.string().max(160).nullable(),text:z.string().trim().min(1).max(5000),startMs:z.number().int().nonnegative(),endMs:z.number().int().nonnegative()}).strict().refine(x=>x.endMs>=x.startMs);
// Integration adapters MUST be backed by Meet's actual session, membership, Shield and Portal quota authorities.
export function createIntelligenceRouter({db,authorize,featureEnabled,entitlement,quota,capture,publish,verifyCapture}){
 for(const [k,v] of Object.entries({db,authorize,featureEnabled,entitlement,quota,capture,publish,verifyCapture}))if(!v)throw Error('missing_adapter:'+k);
 const r=express.Router({mergeParams:true});r.use(express.json({limit:'24kb'}));
 const wrap=f=>(req,res,next)=>Promise.resolve().then(()=>f(req,res)).then(()=>{if(!res.headersSent)next();}).catch(next);
 r.post('/internal/segments',wrap(async(req,res)=>{
  const o=id.parse(req.params.occurrenceId),v=segmentInput.parse(req.body);
  if(await verifyCapture(req,{occurrenceId:o,captureId:v.captureId})!==true)throw new PolicyError('capture_identity_required',403);
  const q=await db.query(`INSERT INTO meet_more.transcript_segments(occurrence_id,speaker_id,body,start_ms,end_ms) SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM meet_more.intelligence_sessions WHERE occurrence_id=$1 AND capture_id=$6 AND transcription_state='active') ON CONFLICT DO NOTHING RETURNING id`,[o,v.speakerId,v.text,v.startMs,v.endMs,v.captureId]);
  if(!q.rows.length) return res.status(409).json({error:'inactive_or_duplicate_segment'});
  await publish(o,{type:'transcript.available',cursor:q.rows[0].id});res.status(201).json({cursor:q.rows[0].id});
 }));
 r.use(wrap(async(req,res)=>{const occurrenceId=id.parse(req.params.occurrenceId);const principal=assertPrincipal(await authorize(req,{occurrenceId,action:'intelligence.read'}),occurrenceId);req.mi={occurrenceId,principal};}));
 const guard=action=>wrap(async(req)=>{const {occurrenceId,principal}=req.mi;assertPrincipal(await authorize(req,{occurrenceId,action}),occurrenceId);if(!principal.actorId)throw new PolicyError('unauthorized');});
 const enabled=feature=>wrap(async(req)=>assertFeature(await featureEnabled(feature,req.mi.occurrenceId)));
 const audit=async(c,req,action,details={})=>c.query('INSERT INTO meet_more.intelligence_audit(occurrence_id,actor_id,action,details) VALUES($1,$2,$3,$4)',[req.mi.occurrenceId,req.mi.principal.actorId,action,JSON.stringify(details)]);
 r.get('/status',wrap(async(req,res)=>{
  const o=req.mi.occurrenceId;
  const [s,features]=await Promise.all([db.query('SELECT transcription_state,updated_at FROM meet_more.intelligence_sessions WHERE occurrence_id=$1',[o]),Promise.all(['transcription','summary','takeaways','ask'].map(async k=>[k,await featureEnabled(k,o)]))]);
  res.json({transcription:s.rows[0]??{transcription_state:'off'},features:Object.fromEntries(features)});
 }));
 r.put('/consent',guard('intelligence.consent'),wrap(async(req,res)=>{
  const v=consentInput.parse(req.body),c=await db.connect();try{await c.query('BEGIN');await c.query(`INSERT INTO meet_more.intelligence_consent(occurrence_id,actor_id,kind,granted,policy_version) VALUES($1,$2,$3,$4,$5) ON CONFLICT(occurrence_id,actor_id,kind) DO UPDATE SET granted=EXCLUDED.granted,policy_version=EXCLUDED.policy_version,updated_at=now()`,[req.mi.occurrenceId,req.mi.principal.actorId,v.kind,v.granted,v.policyVersion]);await audit(c,req,'consent.changed',{kind:v.kind,granted:v.granted});await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}res.json({kind:v.kind,granted:v.granted});
 }));
 r.post('/transcription/start',enabled('transcription'),guard('intelligence.transcription.manage'),wrap(async(req,res)=>{
  const o=req.mi.occurrenceId;
  // The capture adapter must verify the active participant consent policy, inform participants, and fail closed.
  const allowed=await capture.verifyConsentPolicy({occurrenceId:o,actorId:req.mi.principal.actorId});
  if(allowed!==true)throw new PolicyError('participant_consent_incomplete',409);
  const started=await capture.start({occurrenceId:o,actorId:req.mi.principal.actorId});
  if(!started?.captureId)throw new PolicyError('capture_not_started',503);
  await db.query(`INSERT INTO meet_more.intelligence_sessions(occurrence_id,transcription_state,capture_id,updated_by) VALUES($1,'active',$2,$3) ON CONFLICT(occurrence_id) DO UPDATE SET transcription_state='active',capture_id=EXCLUDED.capture_id,updated_by=EXCLUDED.updated_by,updated_at=now()`,[o,started.captureId,req.mi.principal.actorId]);
  await publish(o,{type:'transcription.state',state:'active'});res.status(202).json({state:'active'});
 }));
 r.post('/transcription/stop',guard('intelligence.transcription.manage'),wrap(async(req,res)=>{
  const o=req.mi.occurrenceId;await capture.stop({occurrenceId:o,actorId:req.mi.principal.actorId});await db.query("UPDATE meet_more.intelligence_sessions SET transcription_state='off',capture_id=NULL,updated_at=now() WHERE occurrence_id=$1",[o]);await publish(o,{type:'transcription.state',state:'off'});res.json({state:'off'});
 }));
 // Internal ingest must be mounted behind mTLS/workload identity by the Meet gateway.
 // It deliberately uses a separate capture verifier, not a participant cookie.
 r.get('/transcript',enabled('transcription'),guard('intelligence.transcript.read'),wrap(async(req,res)=>{
  const after=z.coerce.number().int().nonnegative().parse(req.query.after??0);
  const q=await db.query('SELECT id,speaker_id,body,start_ms,end_ms FROM meet_more.transcript_segments WHERE occurrence_id=$1 AND id>$2 ORDER BY id LIMIT 200',[req.mi.occurrenceId,after]);res.json({segments:q.rows});
 }));
 r.post('/jobs',enabled('ai'),guard('intelligence.ai.use'),wrap(async(req,res)=>{
  const v=jobInput.parse(req.body);if(v.kind==='answer'&&!v.question)throw new PolicyError('question_required',400);
  const o=req.mi.occurrenceId,a=req.mi.principal.actorId;
  assertFeature(await featureEnabled(v.kind==='answer'?'ask':v.kind,o));
  const consent=await db.query("SELECT kind,granted FROM meet_more.intelligence_consent WHERE occurrence_id=$1 AND actor_id=$2 AND kind='ai'",[o,a]);assertConsent(consent.rows[0],'ai');
  if(await entitlement({occurrenceId:o,actorId:a,capability:'meet.intelligence.'+v.kind})!==true)throw new PolicyError('entitlement_denied',403);
  // Quota adapter must atomically reserve a request id; retry with same idempotency key must not double charge.
  const c=await db.connect();let job;try{await c.query('BEGIN');const q=await c.query(`INSERT INTO meet_more.intelligence_jobs(occurrence_id,actor_id,kind,prompt_question,idempotency_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(occurrence_id,actor_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id,state`,[o,a,v.kind,v.question??null,v.idempotencyKey]);job=q.rows[0];await audit(c,req,'ai.job.requested',{kind:v.kind,jobId:job.id});await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  // Reservation occurs after durable job creation; worker must refuse unreserved jobs.
  await quota.reserve({occurrenceId:o,actorId:a,jobId:job.id,capability:'meet.intelligence.'+v.kind});
  res.status(202).json({jobId:job.id,state:job.state});
 }));
 r.get('/jobs/:jobId',guard('intelligence.ai.use'),wrap(async(req,res)=>{const jobId=z.string().uuid().parse(req.params.jobId);const q=await db.query('SELECT id,kind,state,result_id,error_code,created_at FROM meet_more.intelligence_jobs WHERE id=$1 AND occurrence_id=$2 AND actor_id=$3',[jobId,req.mi.occurrenceId,req.mi.principal.actorId]);if(!q.rows[0])return res.sendStatus(404);res.json(q.rows[0]);}));
 r.get('/artifacts',guard('intelligence.ai.read'),wrap(async(req,res)=>{const q=await db.query('SELECT id,kind,body,created_at FROM meet_more.ai_artifacts WHERE occurrence_id=$1 ORDER BY created_at DESC LIMIT 50',[req.mi.occurrenceId]);res.json({artifacts:q.rows});}));
 r.use((err,req,res,next)=>{if(res.headersSent)return next(err);if(err instanceof ZodError)return res.status(400).json({error:'invalid_input'});if(err instanceof PolicyError)return res.status(err.status).json({error:err.code});console.error('intelligence_error',err?.message);res.status(503).json({error:'service_unavailable'});});
 return r;
}
