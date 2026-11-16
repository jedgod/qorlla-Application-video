import express from 'express';
import helmet from 'helmet';
import pg from 'pg';
import {WebSocketServer} from 'ws';
import {randomUUID} from 'node:crypto';
import {reactionSchema,questionSchema,roomSchema,boardOpSchema,requireRole,featureGate} from './core.mjs';

// All authority adapters are REQUIRED; fail closed until wired to the real Meet runtime.
const adapter=await import(process.env.MEET_ADAPTER_MODULE || './unconfigured-adapter.mjs');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PG_SSL==='true'?{rejectUnauthorized:true}:undefined});
const app=express();app.disable('x-powered-by');app.use(helmet());app.use(express.json({limit:'64kb'}));
const flags={reactions:true,whiteboard:false,breakouts:false,files:false,qa:true,transcription:false};
const channels=new Map();
async function event(client,occurrenceId,actorId,kind,payload){
 const result=await client.query('INSERT INTO meet_collab.events(occurrence_id,kind,actor_id,payload) VALUES($1,$2,$3,$4) RETURNING id,created_at',[occurrenceId,kind,actorId,payload]);
 return {seq:String(result.rows[0].id),kind,payload,createdAt:result.rows[0].created_at};
}
async function inTx(fn){const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
function broadcast(id,evt){for(const ws of channels.get(id)||[])if(ws.readyState===1)ws.send(JSON.stringify(evt));}
async function auth(req,res,next){try{
 const actor=await adapter.authenticateMeetRequest(req); // must validate actual Meet token/cookie
 if(!actor?.participantId) return res.status(401).json({error:'unauthorized'});
 const occurrenceId=req.params.occurrenceId;
 if(!/^[0-9a-f-]{36}$/i.test(occurrenceId))return res.status(400).json({error:'invalid occurrence'});
 const allowed=await adapter.authorizeOccurrence(actor,occurrenceId);
 if(!allowed)return res.status(403).json({error:'forbidden'});
 req.actor=actor;next();
 }catch(e){res.status(503).json({error:'authorization_unavailable'});}}
const router=express.Router({mergeParams:true});router.use(auth);
router.get('/capabilities',async(req,res)=>res.json({features:flags,role:req.actor.role}));
router.get('/events',async(req,res,next)=>{try{const since=String(req.query.since||'0');if(!/^\d+$/.test(since))return res.status(400).json({error:'invalid cursor'});
 const r=await pool.query('SELECT id,kind,payload,created_at FROM meet_collab.events WHERE occurrence_id=$1 AND id>$2 ORDER BY id LIMIT 500',[req.params.occurrenceId,since]);res.json(r.rows.map(x=>({seq:String(x.id),kind:x.kind,payload:x.payload,createdAt:x.created_at})));}catch(e){next(e);}});
router.post('/reactions',async(req,res,next)=>{try{featureGate(flags,'reactions');const {emoji}=reactionSchema.parse(req.body);const id=req.params.occurrenceId;const actor=req.actor.participantId;
 const out=await inTx(async c=>{const count=await c.query("SELECT count(*)::int AS n FROM meet_collab.reactions WHERE occurrence_id=$1 AND actor_id=$2 AND created_at>now()-interval '10 seconds'",[id,actor]);if(count.rows[0].n>=8){const e=new Error('rate_limited');e.status=429;throw e;}
 await c.query('INSERT INTO meet_collab.reactions(id,occurrence_id,actor_id,emoji) VALUES($1,$2,$3,$4)',[randomUUID(),id,actor,emoji]);return event(c,id,actor,'reaction',{actor,emoji});});broadcast(id,out);res.status(201).json(out);}catch(e){next(e);}});
router.post('/questions',async(req,res,next)=>{try{featureGate(flags,'qa');const {body,anonymous}=questionSchema.parse(req.body);const id=req.params.occurrenceId,actor=req.actor.participantId,qid=randomUUID();const evt=await inTx(async c=>{await c.query('INSERT INTO meet_collab.questions(id,occurrence_id,actor_id,body,anonymous) VALUES($1,$2,$3,$4,$5)',[qid,id,actor,body,anonymous]);return event(c,id,actor,'question.created',{id:qid,body,anonymous,actor:anonymous?null:actor});});broadcast(id,evt);res.status(201).json({id:qid});}catch(e){next(e);}});
router.get('/questions',async(req,res,next)=>{try{featureGate(flags,'qa');const r=await pool.query("SELECT id,body,anonymous,state,answer,created_at FROM meet_collab.questions WHERE occurrence_id=$1 AND state<>'hidden' ORDER BY created_at DESC LIMIT 100",[req.params.occurrenceId]);res.json(r.rows);}catch(e){next(e);}});
router.post('/questions/:questionId/answer',async(req,res,next)=>{try{requireRole(req.actor,['host','cohost']);const answer=String(req.body?.answer||'').trim();if(!answer||answer.length>4000)return res.status(400).json({error:'invalid answer'});const id=req.params.occurrenceId;const evt=await inTx(async c=>{const r=await c.query("UPDATE meet_collab.questions SET answer=$1,answered_by=$2,state='answered' WHERE id=$3 AND occurrence_id=$4 RETURNING id",[answer,req.actor.participantId,req.params.questionId,id]);if(!r.rowCount){const e=new Error('not_found');e.status=404;throw e;}return event(c,id,req.actor.participantId,'question.answered',{id:req.params.questionId,answer});});broadcast(id,evt);res.json({ok:true});}catch(e){next(e);}});
router.post('/boards',async(req,res,next)=>{try{featureGate(flags,'whiteboard');const title=String(req.body?.title||'').trim().slice(0,100);if(!title)return res.status(400).json({error:'title required'});const id=randomUUID();await pool.query('INSERT INTO meet_collab.boards(id,occurrence_id,title,created_by) VALUES($1,$2,$3,$4)',[id,req.params.occurrenceId,title,req.actor.participantId]);res.status(201).json({id});}catch(e){next(e);}});
router.post('/boards/:boardId/ops',async(req,res,next)=>{try{featureGate(flags,'whiteboard');const {operation}=boardOpSchema.parse(req.body);const id=req.params.occurrenceId;const evt=await inTx(async c=>{const r=await c.query('INSERT INTO meet_collab.board_ops(board_id,actor_id,operation) SELECT id,$1,$2 FROM meet_collab.boards WHERE id=$3 AND occurrence_id=$4 RETURNING id',[req.actor.participantId,operation,req.params.boardId,id]);if(!r.rowCount){const e=new Error('not_found');e.status=404;throw e;}return event(c,id,req.actor.participantId,'board.operation',{boardId:req.params.boardId,opId:String(r.rows[0].id),operation});});broadcast(id,evt);res.status(201).json(evt);}catch(e){next(e);}});
router.post('/rooms',async(req,res,next)=>{try{featureGate(flags,'breakouts');requireRole(req.actor,['host','cohost']);const {title,leadParticipantId}=roomSchema.parse(req.body);if(leadParticipantId&&!await adapter.authorizeParticipant(req.params.occurrenceId,leadParticipantId))return res.status(400).json({error:'invalid leader'});const id=randomUUID();await pool.query('INSERT INTO meet_collab.breakout_rooms(id,occurrence_id,title,lead_participant_id) VALUES($1,$2,$3,$4)',[id,req.params.occurrenceId,title,leadParticipantId||null]);res.status(201).json({id});}catch(e){next(e);}});
router.post('/rooms/:roomId/assign',async(req,res,next)=>{try{featureGate(flags,'breakouts');requireRole(req.actor,['host','cohost']);const id=req.params.occurrenceId,pid=String(req.body?.participantId||'');if(!pid||!await adapter.authorizeParticipant(id,pid))return res.status(400).json({error:'invalid participant'});
 // Move media first through Meet's authoritative breakout coordinator; no DB-only assignment.
 const token=await adapter.prepareBreakoutMove({occurrenceId:id,roomId:req.params.roomId,participantId:pid,actor:req.actor});
 if(!token) return res.status(503).json({error:'media_move_unavailable'});
 try{await inTx(async c=>{const r=await c.query('SELECT id FROM meet_collab.breakout_rooms WHERE id=$1 AND occurrence_id=$2 FOR UPDATE',[req.params.roomId,id]);if(!r.rowCount)throw Object.assign(new Error('not_found'),{status:404});await c.query('INSERT INTO meet_collab.breakout_assignments(occurrence_id,participant_id,room_id) VALUES($1,$2,$3) ON CONFLICT(occurrence_id,participant_id) DO UPDATE SET room_id=EXCLUDED.room_id,assigned_at=now()',[id,pid,req.params.roomId]);await event(c,id,req.actor.participantId,'breakout.assigned',{roomId:req.params.roomId,participantId:pid});});await adapter.commitBreakoutMove(token);res.json({ok:true});}catch(e){await adapter.cancelBreakoutMove(token).catch(()=>{});throw e;}
 }catch(e){next(e);}});
router.post('/transcription/start',async(req,res,next)=>{try{featureGate(flags,'transcription');requireRole(req.actor,['host','cohost']);const id=req.params.occurrenceId;
 if(!await adapter.hasTranscriptionConsent(id))return res.status(409).json({error:'consent_required'});
 const capture=await adapter.startPrivateAudioCapture(id);if(!capture)return res.status(503).json({error:'capture_unavailable'});
 const sessionId=randomUUID();await pool.query("INSERT INTO meet_collab.transcript_sessions(id,occurrence_id,requested_by,state,started_at) VALUES($1,$2,$3,'active',now())",[sessionId,id,req.actor.participantId]);res.status(201).json({sessionId});}catch(e){next(e);}});
app.use('/api/meet/occurrences/:occurrenceId/collaboration',router);
app.use((err,req,res,next)=>{const status=err?.name==='ZodError'?400:err.status||500;res.status(status).json({error:status===500?'internal_error':err.message});});
const server=app.listen(Number(process.env.PORT||4815));
const wss=new WebSocketServer({server,path:'/collaboration/events'});
wss.on('connection',async(ws,req)=>{try{const url=new URL(req.url,'http://localhost');const occurrenceId=url.searchParams.get('occurrenceId');if(!occurrenceId||!/^[0-9a-f-]{36}$/i.test(occurrenceId))return ws.close(1008);
 const actor=await adapter.authenticateMeetWebSocket(req);if(!actor||!await adapter.authorizeOccurrence(actor,occurrenceId))return ws.close(1008);
 if(!channels.has(occurrenceId))channels.set(occurrenceId,new Set());channels.get(occurrenceId).add(ws);
 ws.on('close',()=>channels.get(occurrenceId)?.delete(ws));ws.on('message',()=>{});
 // In production, reauthorize periodically and on Meet revocation events.
 }catch{ws.close(1011);}});
