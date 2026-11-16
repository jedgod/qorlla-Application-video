import express from 'express';import helmet from 'helmet';import pg from 'pg';
import {PortalBridge} from './bridge.mjs';import {appendEvent} from './events.mjs';import {mediaVerdict} from './security.mjs';
const app=express();app.use(helmet());app.use(express.json({limit:'32kb'}));
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const bridge=process.env.PORTAL_GATEWAY_URL&&process.env.PORTAL_BRIDGE_SECRET?
 new PortalBridge({url:process.env.PORTAL_GATEWAY_URL,secret:process.env.PORTAL_BRIDGE_SECRET}):null;
// This is intentionally fail-closed until wired to Qorlla Meet's real identity authority.
async function requireMeet(req,res,next){
 if(!app.locals.meetAuthority)return res.status(503).json({error:'Meet identity adapter unavailable'});
 try{const actor=await app.locals.meetAuthority(req);if(!actor?.active)return res.sendStatus(403);
 req.actor=actor;next()}catch{return res.sendStatus(403)}
}
app.get('/health/live',(_,res)=>res.json({live:true}));
app.post('/api/v19/rooms/:roomId/ai-reports',requireMeet,async(req,res)=>{
 if(!bridge)return res.status(503).json({error:'Private Portal gateway unavailable'});
 const {occurrenceId}=req.body??{},roomId=req.params.roomId;
 if(!occurrenceId || req.actor.occurrenceId!==occurrenceId || !['host','cohost'].includes(req.actor.role))return res.sendStatus(403);
 const db=await pool.connect();let job;
 try{
  await db.query('BEGIN');
  const members=await db.query(`SELECT participant_id,consent FROM smartrooms_v19.room_consents
 WHERE occurrence_id=$1 AND room_id=$2 FOR SHARE`,[occurrenceId,roomId]);
  // Actual roster must be supplied and validated by the Meet authority; consent rows alone are insufficient.
  const roster=await app.locals.meetAuthority.getRoomRoster(occurrenceId,roomId);
  if(!Array.isArray(roster)||!roster.length||roster.some(p=>!members.rows.some(m=>m.participant_id===p&&m.consent)))
   throw Object.assign(new Error('Room consent incomplete'),{status:403});
  const key=req.get('idempotency-key');if(!key||key.length>128)throw Object.assign(new Error('Idempotency key required'),{status:400});
  const r=await db.query(`INSERT INTO smartrooms_v19.ai_jobs(id,occurrence_id,room_id,requested_by,request_key)
 VALUES(gen_random_uuid(),$1,$2,$3,$4) ON CONFLICT(occurrence_id,request_key) DO UPDATE
 SET updated_at=smartrooms_v19.ai_jobs.updated_at RETURNING id,status,room_id`,[occurrenceId,roomId,req.actor.participantId,key]);
  if(r.rows[0].room_id!==roomId)throw Object.assign(new Error('Idempotency conflict'),{status:409});
  job={...r.rows[0],roster};await appendEvent(db,{occurrenceId,roomId,kind:'ai.report.queued',payload:{jobId:job.id}});
  await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK');return res.status(e.status??500).json({error:e.status?e.message:'Job unavailable'})}finally{db.release()}
 // Portal must independently validate signed identity, live roster, consent, quota and AI policy.
 try{const accepted=await bridge.submitRoomReport({occurrenceId,roomId,jobId:job.id,actorId:req.actor.participantId,
  consentEvidence:{allConsented:true,participants:job.roster}});return res.status(202).json({jobId:job.id,portalStatus:accepted.status});}
 catch{return res.status(503).json({jobId:job.id,error:'Portal submission pending; retry with same idempotency key'})}
});
app.get('/api/v19/media/:occurrenceId/:participantId',requireMeet,async(req,res)=>{
 if(req.actor.occurrenceId!==req.params.occurrenceId || (req.actor.participantId!==req.params.participantId && !['host','cohost'].includes(req.actor.role)))return res.sendStatus(403);
 const r=await pool.query(`SELECT source,evidence FROM smartrooms_v19.media_evidence WHERE occurrence_id=$1 AND participant_id=$2 ORDER BY id DESC LIMIT 50`,[req.params.occurrenceId,req.params.participantId]);
 res.json(mediaVerdict(r.rows));
});
app.listen(Number(process.env.PORT||4098),'0.0.0.0');
