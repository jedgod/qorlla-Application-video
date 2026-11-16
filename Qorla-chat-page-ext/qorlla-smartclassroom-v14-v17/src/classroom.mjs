import {randomUUID,createHash} from 'node:crypto';
export class ClassroomError extends Error {constructor(status,message){super(message);this.status=status;}}
const fail=(status,message)=>{throw new ClassroomError(status,message)};
const host=a=>['host','cohost'].includes(a.role);
const valid=(s,max)=>typeof s==='string'&&s.trim().length>0&&s.length<=max;
export function createClassroom({pool,verifyActor,moveParticipant,privateAI,consentAuthority,entitlements}) {
 if(!pool?.connect||typeof verifyActor!=='function') throw Error('Database and Meet identity authority required');
 const auth=async(token,occ)=>{let a;try{a=await verifyActor(token,occ)}catch{fail(503,'Meet identity unavailable')};if(!a?.active||!a.participantId)fail(403,'Meeting membership required');return a};
 const tx=async fn=>{const db=await pool.connect();try{await db.query('BEGIN');const x=await fn(db);await db.query('COMMIT');return x}catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}};
 async function room(db,occ,actor,roomId,{lead=false}={}){
  const q=await db.query(`SELECT r.id,a.role AS assignment_role FROM meet_breakouts.rooms r
   JOIN meet_breakouts.sessions s ON s.occurrence_id=r.occurrence_id AND s.state='active'
   LEFT JOIN meet_breakouts.assignments a ON a.occurrence_id=r.occurrence_id AND a.room_id=r.id AND a.participant_id=$3
   WHERE r.occurrence_id=$1 AND r.id=$2 AND r.state='open'`,[occ,roomId,actor.participantId]);
  if(!q.rowCount)fail(404,'Room not available');if(!host(actor)&&!q.rows[0].assignment_role)fail(403,'Room access denied');
  if(lead&&!host(actor)&&q.rows[0].assignment_role!=='lead')fail(403,'Lead or host required');
 }
 async function event(db,occ,roomId,kind,data,actor){
  await db.query('INSERT INTO meet_breakouts.outbox(occurrence_id,event_kind,audience,payload) VALUES($1,$2,$3,$4)',[occ,kind,'room:'+roomId,JSON.stringify(data)]);
  await db.query('INSERT INTO meet_breakouts.classroom_audit(occurrence_id,actor_id,action,resource_id) VALUES($1,$2,$3,$4)',[occ,actor,kind,String(data.id??roomId)]);
 }
 return {
  async planAssignments(token,occ,participants,roomIds,maxPerRoom=8){
   const a=await auth(token,occ);if(!host(a))fail(403,'Host required');
   if(!Array.isArray(participants)||!Array.isArray(roomIds)||!roomIds.length||!Number.isInteger(maxPerRoom)||maxPerRoom<1||maxPerRoom>30)fail(400,'Invalid plan');
   if(new Set(participants).size!==participants.length||new Set(roomIds).size!==roomIds.length||participants.length>roomIds.length*maxPerRoom)fail(409,'Duplicate or insufficient capacity');
   return participants.map((participantId,i)=>({participantId,roomId:roomIds[i%roomIds.length]}));
  },
  async applyAssignments(token,occ,plan){
   const a=await auth(token,occ);if(!host(a))fail(403,'Host required');
   if(typeof moveParticipant!=='function')fail(503,'Media movement service unavailable');
   if(!Array.isArray(plan)||plan.length>300||new Set(plan.map(x=>x.participantId)).size!==plan.length)fail(400,'Invalid plan');
   // Never modify assignment tables directly; use V1.2 epoch-fenced movement.
   const results=[];for(const p of plan){try{results.push({participantId:p.participantId,result:await moveParticipant({actor:a,occurrence:occ,participantId:p.participantId,targetRoom:p.roomId})})}catch(e){results.push({participantId:p.participantId,error:'movement_rejected'})}}
   return {results};
  },
  async createExercise(token,occ,roomId,{title,prompt,durationSeconds=900,missionId=null}){
   const a=await auth(token,occ);if(!valid(title,180)||typeof prompt!=='string'||prompt.length>12000||!Number.isInteger(durationSeconds)||durationSeconds<30||durationSeconds>14400)fail(400,'Invalid exercise');
   return tx(async db=>{await room(db,occ,a,roomId,{lead:true});const id=randomUUID();
    await db.query(`INSERT INTO meet_breakouts.classroom_exercises(id,occurrence_id,room_id,mission_id,title,prompt,ends_at,created_by)
     VALUES($1,$2,$3,$4,$5,$6,now()+($7 * interval '1 second'),$8)`,[id,occ,roomId,missionId,title.trim(),prompt,durationSeconds,a.participantId]);
    await event(db,occ,roomId,'classroom.exercise.created',{id,roomId},a.participantId);return {id,roomId,title,durationSeconds,state:'draft'};
   });
  },
  async startExercise(token,occ,id){const a=await auth(token,occ);return tx(async db=>{
   const q=await db.query('SELECT room_id,state,ends_at FROM meet_breakouts.classroom_exercises WHERE id=$1 AND occurrence_id=$2 FOR UPDATE',[id,occ]);if(!q.rowCount)fail(404,'Exercise missing');
   await room(db,occ,a,q.rows[0].room_id,{lead:true});if(q.rows[0].state!=='draft'||new Date(q.rows[0].ends_at)<=new Date())fail(409,'Exercise unavailable');
   await db.query("UPDATE meet_breakouts.classroom_exercises SET state='running',version=version+1 WHERE id=$1",[id]);
   await event(db,occ,q.rows[0].room_id,'classroom.exercise.started',{id},a.participantId);return {id,state:'running'};
  })},
  async submitExercise(token,occ,id,answer){const a=await auth(token,occ);if(!valid(answer,12000))fail(400,'Invalid answer');return tx(async db=>{
   const q=await db.query('SELECT room_id,state,ends_at FROM meet_breakouts.classroom_exercises WHERE id=$1 AND occurrence_id=$2 FOR UPDATE',[id,occ]);if(!q.rowCount)fail(404,'Exercise missing');await room(db,occ,a,q.rows[0].room_id);
   if(q.rows[0].state!=='running'||new Date(q.rows[0].ends_at)<=new Date())fail(409,'Exercise expired');
   const submissionId=randomUUID();await db.query('INSERT INTO meet_breakouts.exercise_submissions(id,exercise_id,participant_id,answer) VALUES($1,$2,$3,$4)',[submissionId,id,a.participantId,answer]);
   await event(db,occ,q.rows[0].room_id,'classroom.exercise.submitted',{id,submissionId},a.participantId);return {submissionId};
  })},
  async createBoard(token,occ,roomId){const a=await auth(token,occ);return tx(async db=>{await room(db,occ,a,roomId,{lead:true});const id=randomUUID();
   const q=await db.query(`INSERT INTO meet_breakouts.classroom_boards(id,occurrence_id,room_id,created_by) VALUES($1,$2,$3,$4)
    ON CONFLICT(occurrence_id,room_id) DO UPDATE SET room_id=EXCLUDED.room_id RETURNING id`,[id,occ,roomId,a.participantId]);return {id:q.rows[0].id,roomId};
  })},
  async appendBoardOp(token,occ,boardId,{opId,kind,points,color='#222222',width=2,text=''}){
   const a=await auth(token,occ);if(!/^[0-9a-f-]{36}$/i.test(opId??'')||!['stroke','erase','text','clear'].includes(kind)||!Array.isArray(points)||points.length>1000||!points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1)||!/^#[0-9a-f]{6}$/i.test(color)||!Number.isFinite(width)||width<1||width>24||typeof text!=='string'||text.length>500)fail(400,'Invalid board operation');
   return tx(async db=>{const b=await db.query('SELECT room_id FROM meet_breakouts.classroom_boards WHERE id=$1 AND occurrence_id=$2',[boardId,occ]);if(!b.rowCount)fail(404,'Board missing');await room(db,occ,a,b.rows[0].room_id);if(kind==='clear'&&!host(a))fail(403,'Host required to clear');
    const op={kind,points,color,width,text};const r=await db.query(`INSERT INTO meet_breakouts.classroom_board_ops(board_id,op_id,actor_id,op)
     VALUES($1,$2,$3,$4) ON CONFLICT(op_id) DO NOTHING RETURNING id`,[boardId,opId,a.participantId,JSON.stringify(op)]);
    if(r.rowCount)await event(db,occ,b.rows[0].room_id,'classroom.board.operation',{id:r.rows[0].id,boardId,opId},a.participantId);
    return {accepted:!!r.rowCount,cursor:r.rows[0]?.id??null};
   });
  },
  async boardOps(token,occ,boardId,cursor=0){const a=await auth(token,occ);if(!Number.isSafeInteger(cursor)||cursor<0)fail(400,'Invalid cursor');const db=await pool.connect();try{
   const b=await db.query('SELECT room_id FROM meet_breakouts.classroom_boards WHERE id=$1 AND occurrence_id=$2',[boardId,occ]);if(!b.rowCount)fail(404,'Board missing');await room(db,occ,a,b.rows[0].room_id);
   const r=await db.query('SELECT id,op_id,actor_id,op FROM meet_breakouts.classroom_board_ops WHERE board_id=$1 AND id>$2 ORDER BY id LIMIT 500',[boardId,cursor]);return {ops:r.rows,nextCursor:r.rows.at(-1)?.id??cursor};
  }finally{db.release()}},
  async requestAIReport(token,occ,roomId,{sourceText,consentRecordId}){
   const a=await auth(token,occ);if(!valid(sourceText,30000)||!valid(consentRecordId,200))fail(400,'Invalid report input');
   if(!privateAI?.enqueue||!consentAuthority?.verify||!entitlements?.reserve)fail(503,'Private AI unavailable');
   const db=await pool.connect();try{await room(db,occ,a,roomId,{lead:true})}finally{db.release()}
   if(!await consentAuthority.verify({occurrence:occ,roomId,recordId:consentRecordId,actor:a}))fail(403,'Consent required');
   const entitlement=await entitlements.reserve({actor:a,feature:'classroom.ai_report',occurrence:occ});if(!entitlement?.approved)fail(402,'AI quota unavailable');
   const id=randomUUID(),sourceHash=createHash('sha256').update(sourceText).digest('hex');
   try{await tx(async db=>{await db.query(`INSERT INTO meet_breakouts.classroom_ai_jobs(id,occurrence_id,room_id,requested_by,consent_record_id,source_hash)
    VALUES($1,$2,$3,$4,$5,$6)`,[id,occ,roomId,a.participantId,consentRecordId,sourceHash]);
    await event(db,occ,roomId,'classroom.ai.queued',{id},a.participantId)});
    // This MUST be the existing authenticated Portal AI gateway, never a direct third-party provider.
    await privateAI.enqueue({jobId:id,occurrence:occ,roomId,sourceText,consentRecordId});return {id,state:'queued'};
   }catch(e){await pool.query("UPDATE meet_breakouts.classroom_ai_jobs SET state='failed' WHERE id=$1",[id]);await entitlements.release?.(entitlement);throw e}
  },
  async saveReport(token,occ,roomId,{title,content,missionId=null}){
   const a=await auth(token,occ);if(!valid(title,180)||!content||typeof content!=='object'||Array.isArray(content)||JSON.stringify(content).length>20000)fail(400,'Invalid report');
   return tx(async db=>{await room(db,occ,a,roomId,{lead:true});const id=randomUUID();await db.query(`INSERT INTO meet_breakouts.classroom_reports(id,occurrence_id,room_id,mission_id,title,content,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,occ,roomId,missionId,title,JSON.stringify(content),a.participantId]);await event(db,occ,roomId,'classroom.report.saved',{id},a.participantId);return {id,roomId};});
  },
  async teacherDashboard(token,occ){const a=await auth(token,occ);if(!host(a))fail(403,'Host required');const r=await pool.query(`SELECT r.id,r.name,COUNT(DISTINCT a.participant_id)::int AS members,COUNT(DISTINCT e.id) FILTER (WHERE e.state='running' AND e.ends_at>now())::int AS active_exercises,COUNT(DISTINCT h.id) FILTER (WHERE h.status='open')::int AS help_requests,COUNT(DISTINCT cr.id)::int AS reports FROM meet_breakouts.rooms r LEFT JOIN meet_breakouts.assignments a ON a.occurrence_id=r.occurrence_id AND a.room_id=r.id LEFT JOIN meet_breakouts.classroom_exercises e ON e.occurrence_id=r.occurrence_id AND e.room_id=r.id LEFT JOIN meet_breakouts.help_requests h ON h.occurrence_id=r.occurrence_id AND h.room_id=r.id LEFT JOIN meet_breakouts.classroom_reports cr ON cr.occurrence_id=r.occurrence_id AND cr.room_id=r.id WHERE r.occurrence_id=$1 GROUP BY r.id,r.name ORDER BY r.name`,[occ]);return {rooms:r.rows};}
 };
}
