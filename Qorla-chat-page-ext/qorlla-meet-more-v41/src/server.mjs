import express from 'express';
import helmet from 'helmet';
import pg from 'pg';
import {z} from 'zod';

// This module deliberately does NOT invent Meet authentication or membership contracts.
// The host Meet process MUST mount the router with its real verified adapter.
export function createMoreRouter({db, authorize, publish, featureEnabled, services={}}) {
 if(typeof authorize!=='function'||typeof publish!=='function'||typeof featureEnabled!=='function') throw Error('Meet adapters required');
 const r=express.Router();
 r.use(express.json({limit:'32kb'}));
 r.use(async(req,res,next)=>{
  try {
   const occurrenceId=z.string().min(1).max(200).parse(req.params.occurrenceId);
   const principal=await authorize(req,{occurrenceId,action:'read'});
   if(!principal?.actorId || !principal?.occurrenceId || principal.occurrenceId!==occurrenceId) return res.sendStatus(403);
   req.more={occurrenceId,principal}; next();
  } catch(e){res.status(403).json({error:'unauthorized'});}
 });
 const requireAction=action=>async(req,res,next)=>{
  try{const p=await authorize(req,{occurrenceId:req.more.occurrenceId,action});
   if(!p?.actorId||p.actorId!==req.more.principal.actorId||p.occurrenceId!==req.more.occurrenceId) return res.sendStatus(403);
   next();}catch{res.sendStatus(403);}
 };
 const enabled=key=>(req,res,next)=>featureEnabled(key,req.more.occurrenceId)?next():res.status(503).json({error:'feature_unavailable'});
 async function emit(client,occurrenceId,actorId,kind,payload){
  const {rows}=await client.query('INSERT INTO meet_more.events(occurrence_id,actor_id,kind,payload) VALUES($1,$2,$3,$4) RETURNING id,created_at',[occurrenceId,actorId,kind,JSON.stringify(payload)]);
  return rows[0];
 }
 async function transact(req,kind,work){
  const c=await db.connect();let event,result;
  try{await c.query('BEGIN');result=await work(c);event=await emit(c,req.more.occurrenceId,req.more.principal.actorId,kind,result);await c.query('COMMIT');}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  // Publish only after commit. Consumers MUST replay from durable events; publication may fail.
  try{await publish(req.more.occurrenceId,{...event,kind,payload:result});}catch(e){console.error('More publish failed',e.message);}
  return result;
 }
 const handler=fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(e=>{console.error('More route error',e.message);res.status(500).json({error:'internal_error'});});
 r.get('/state',handler(async(req,res)=>{
  const {rows}=await db.query('SELECT locked,recording_state,settings FROM meet_more.occurrence_state WHERE occurrence_id=$1',[req.more.occurrenceId]);
  res.json({state:rows[0]??{locked:false,recording_state:'off',settings:{}},features:Object.fromEntries(['reactions','whiteboard','breakouts','files','qa','transcript','ai','recording'].map(k=>[k,!!featureEnabled(k,req.more.occurrenceId)]))});
 }));
 r.get('/events',handler(async(req,res)=>{
  const after=z.coerce.number().int().nonnegative().parse(req.query.after??0);
  const {rows}=await db.query('SELECT id,kind,payload,created_at FROM meet_more.events WHERE occurrence_id=$1 AND id>$2 ORDER BY id LIMIT 200',[req.more.occurrenceId,after]);res.json({events:rows});
 }));
 r.post('/reactions',enabled('reactions'),requireAction('react'),handler(async(req,res)=>{
  const {emoji}=z.object({emoji:z.enum(['👍','👏','❤️','🎉','😂'])}).parse(req.body);
  const out=await transact(req,'reaction',async c=>{await c.query('INSERT INTO meet_more.reactions(occurrence_id,actor_id,emoji) VALUES($1,$2,$3)',[req.more.occurrenceId,req.more.principal.actorId,emoji]);return {emoji,actorId:req.more.principal.actorId};});res.status(201).json(out);
 }));
 r.get('/questions',enabled('qa'),handler(async(req,res)=>{const {rows}=await db.query('SELECT id,question,state,answer,created_at FROM meet_more.questions WHERE occurrence_id=$1 AND state<>\'hidden\' ORDER BY created_at DESC LIMIT 100',[req.more.occurrenceId]);res.json({questions:rows});}));
 r.post('/questions',enabled('qa'),requireAction('ask'),handler(async(req,res)=>{
  const {question}=z.object({question:z.string().trim().min(1).max(2000)}).parse(req.body);
  const out=await transact(req,'question.created',async c=>{const {rows}=await c.query('INSERT INTO meet_more.questions(occurrence_id,author_id,question) VALUES($1,$2,$3) RETURNING id,question,state',[req.more.occurrenceId,req.more.principal.actorId,question]);return rows[0];});res.status(201).json(out);
 }));
 r.post('/questions/:id/answer',enabled('qa'),requireAction('moderate_qa'),handler(async(req,res)=>{
  const id=z.string().uuid().parse(req.params.id);const {answer}=z.object({answer:z.string().trim().min(1).max(4000)}).parse(req.body);
  const out=await transact(req,'question.answered',async c=>{const {rows}=await c.query("UPDATE meet_more.questions SET answer=$3,answered_by=$4,answered_at=now(),state='answered' WHERE id=$1 AND occurrence_id=$2 RETURNING id,state,answer",[id,req.more.occurrenceId,answer,req.more.principal.actorId]);if(!rows[0]) throw Error('not_found');return rows[0];});res.json(out);
 }));
 r.post('/lock',requireAction('manage_security'),handler(async(req,res)=>{
  const {locked}=z.object({locked:z.boolean()}).parse(req.body);
  if(typeof services.setMeetLock!=='function') return res.status(503).json({error:'meet_lock_adapter_missing'});
  // Meet authority must update admission policy before local state is mirrored.
  await services.setMeetLock({occurrenceId:req.more.occurrenceId,actorId:req.more.principal.actorId,locked});
  const out=await transact(req,'meeting.lock',async c=>{await c.query('INSERT INTO meet_more.occurrence_state(occurrence_id,locked) VALUES($1,$2) ON CONFLICT(occurrence_id) DO UPDATE SET locked=EXCLUDED.locked,updated_at=now()',[req.more.occurrenceId,locked]);return {locked};});res.json(out);
 }));
 r.post('/recording',enabled('recording'),requireAction('manage_recording'),handler(async(req,res)=>{
  const {command}=z.object({command:z.enum(['start','stop'])}).parse(req.body);
  if(typeof services.recordingCommand!=='function') return res.status(503).json({error:'recording_adapter_missing'});
  const state=await services.recordingCommand({occurrenceId:req.more.occurrenceId,actorId:req.more.principal.actorId,command});
  const status=z.enum(['off','requested','active','stopping','failed']).parse(state);
  const out=await transact(req,'recording.state',async c=>{await c.query('INSERT INTO meet_more.occurrence_state(occurrence_id,recording_state) VALUES($1,$2) ON CONFLICT(occurrence_id) DO UPDATE SET recording_state=EXCLUDED.recording_state,updated_at=now()',[req.more.occurrenceId,status]);return {state:status};});res.json(out);
 }));
 r.put('/preferences',requireAction('preferences'),handler(async(req,res)=>{
  const data=z.object({focusMode:z.boolean(),layout:z.enum(['gallery','speaker','side-by-side']),background:z.string().max(100)}).strict().parse(req.body);
  const out=await transact(req,'preferences.updated',async c=>{await c.query(`INSERT INTO meet_more.preferences(occurrence_id,actor_id,focus_mode,layout,background) VALUES($1,$2,$3,$4,$5) ON CONFLICT(occurrence_id,actor_id) DO UPDATE SET focus_mode=EXCLUDED.focus_mode,layout=EXCLUDED.layout,background=EXCLUDED.background,updated_at=now()`,[req.more.occurrenceId,req.more.principal.actorId,data.focusMode,data.layout,data.background]);return {actorId:req.more.principal.actorId,...data};});res.json(out);
 }));
 r.get('/attendance',requireAction('view_attendance'),handler(async(req,res)=>{const {rows}=await db.query('SELECT participant_id,joined_at,left_at FROM meet_more.attendance WHERE occurrence_id=$1 ORDER BY joined_at',[req.more.occurrenceId]);res.json({attendance:rows});}));
 // Infrastructure-backed capabilities are explicit adapters; never report success without a backend.
 for(const [path,key,method] of [['whiteboards','whiteboard','whiteboards'],['breakouts','breakouts','breakouts'],['files','files','files'],['transcript','transcript','transcript'],['ai','ai','ai'],['invites','invites','invites'],['timer','timer','timer']]){
  r.all('/'+path+'/*',enabled(key),requireAction(key),handler(async(req,res)=>{
   if(typeof services[method]!=='function') return res.status(503).json({error:'adapter_unavailable',feature:key});
   const result=await services[method]({req,occurrenceId:req.more.occurrenceId,actorId:req.more.principal.actorId});res.json(result);
  }));
 }
 r.use((err,req,res,next)=>{if(err instanceof z.ZodError)return res.status(400).json({error:'invalid_input',details:err.issues});next(err);});
 return r;
}

// Standalone process is intentionally not offered: Meet must provide the real authorization adapter.
