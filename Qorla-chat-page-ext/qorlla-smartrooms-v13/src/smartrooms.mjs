import { randomUUID } from 'node:crypto';
export class SmartRoomError extends Error { constructor(status,message){super(message);this.status=status;} }
const fail=(code,message)=>{throw new SmartRoomError(code,message)};
const host=a=>['host','cohost'].includes(a.role);
const checkText=(v,max)=>typeof v==='string' && v.trim().length>0 && v.length<=max;
export function balancedGroups(participantIds,roomIds,{maxPerRoom=6}={}) {
 if(!Array.isArray(participantIds)||!Array.isArray(roomIds)||!roomIds.length || !Number.isSafeInteger(maxPerRoom)||maxPerRoom<1) fail(400,'Invalid groups');
 if(new Set(participantIds).size!==participantIds.length || new Set(roomIds).size!==roomIds.length) fail(400,'Duplicate identifiers');
 if(participantIds.length>roomIds.length*maxPerRoom) fail(409,'Insufficient room capacity');
 return participantIds.map((participantId,i)=>({participantId,roomId:roomIds[i%roomIds.length]}));
}
export function createSmartRooms({pool,verifyActor}) {
 if(!pool?.connect || typeof verifyActor!=='function') throw Error('Meet database and verified authority required');
 async function identity(token,occ){let a;try{a=await verifyActor(token,occ)}catch{fail(503,'Meet authority unavailable')};if(!a?.active||!a.participantId)fail(403,'Meeting access denied');return a;}
 async function tx(fn){const db=await pool.connect();try{await db.query('BEGIN');const r=await fn(db);await db.query('COMMIT');return r;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
 async function scope(db,occ,actor,roomId,{edit=false}={}){
   const s=await db.query('SELECT state FROM meet_breakouts.sessions WHERE occurrence_id=$1 FOR SHARE',[occ]);
   if(s.rows[0]?.state!=='active')fail(409,'Breakout session inactive');
   const r=await db.query("SELECT 1 FROM meet_breakouts.rooms WHERE occurrence_id=$1 AND id=$2 AND state='open'",[occ,roomId]);
   if(!r.rowCount)fail(404,'Room not available');
   if(host(actor))return;
   const q=await db.query('SELECT role FROM meet_breakouts.assignments WHERE occurrence_id=$1 AND participant_id=$2 AND room_id=$3',[occ,actor.participantId,roomId]);
   if(!q.rowCount)fail(403,'Different room');
   if(edit){const grant=await db.query(`SELECT 1 FROM meet_breakouts.room_lead_grants WHERE occurrence_id=$1 AND room_id=$2 AND participant_id=$3 AND capability='room_notes'`,[occ,roomId,actor.participantId]);
     if(!grant.rowCount || q.rows[0].role!=='lead')fail(403,'Lead permission required');}
 }
 async function event(db,occ,room,actor,kind,payload){
  await db.query('INSERT INTO meet_breakouts.room_progress_events(occurrence_id,room_id,actor_id,kind,payload) VALUES($1,$2,$3,$4,$5)',[occ,room,actor,kind,JSON.stringify(payload)]);
  await db.query('INSERT INTO meet_breakouts.outbox(occurrence_id,event_kind,audience,payload) VALUES($1,$2,$3,$4)',[occ,kind,'room:'+room,JSON.stringify(payload)]);
 }
 return {
  async createMission(token,occ,roomId,{title,instructions=''}){
   const a=await identity(token,occ);if(!checkText(title,180)||typeof instructions!=='string'||instructions.length>12000)fail(400,'Invalid mission');
   return tx(async db=>{await scope(db,occ,a,roomId,{edit:true});const id=randomUUID();
    await db.query('INSERT INTO meet_breakouts.room_missions(id,occurrence_id,room_id,title,instructions,created_by) VALUES($1,$2,$3,$4,$5,$6)',[id,occ,roomId,title.trim(),instructions,a.participantId]);
    await event(db,occ,roomId,a.participantId,'mission.created',{id,roomId});return {id,roomId,title};});
  },
  async addTask(token,occ,missionId,{title,assigneeId=null}){
   const a=await identity(token,occ);if(!checkText(title,180))fail(400,'Invalid task');
   return tx(async db=>{const m=await db.query('SELECT room_id,state FROM meet_breakouts.room_missions WHERE id=$1 AND occurrence_id=$2 FOR UPDATE',[missionId,occ]);
    if(!m.rowCount)fail(404,'Mission not found');await scope(db,occ,a,m.rows[0].room_id,{edit:true});if(m.rows[0].state!=='open')fail(409,'Mission closed');
    if(assigneeId){const p=await db.query('SELECT 1 FROM meet_breakouts.assignments WHERE occurrence_id=$1 AND room_id=$2 AND participant_id=$3',[occ,m.rows[0].room_id,assigneeId]);if(!p.rowCount)fail(403,'Assignee outside room');}
    const id=randomUUID();await db.query('INSERT INTO meet_breakouts.mission_tasks(id,mission_id,title,assignee_id) VALUES($1,$2,$3,$4)',[id,missionId,title.trim(),assigneeId]);
    await event(db,occ,m.rows[0].room_id,a.participantId,'mission.task.created',{missionId,id});return {id,missionId,title};});
  },
  async updateTask(token,occ,taskId,{state,expectedVersion}){
   const a=await identity(token,occ);if(!['todo','doing','done'].includes(state)||!Number.isSafeInteger(expectedVersion)||expectedVersion<1)fail(400,'Invalid task update');
   return tx(async db=>{const q=await db.query(`SELECT t.mission_id,t.assignee_id,t.version,m.room_id,m.state AS mission_state FROM meet_breakouts.mission_tasks t JOIN meet_breakouts.room_missions m ON m.id=t.mission_id WHERE t.id=$1 AND m.occurrence_id=$2 FOR UPDATE OF t`,[taskId,occ]);
    if(!q.rowCount)fail(404,'Task missing');const t=q.rows[0];await scope(db,occ,a,t.room_id);
    if(t.mission_state!=='open')fail(409,'Mission closed');if(!host(a)&&t.assignee_id!==a.participantId)fail(403,'Not task assignee');
    if(Number(t.version)!==expectedVersion)fail(409,'Task changed concurrently');
    await db.query('UPDATE meet_breakouts.mission_tasks SET state=$2,version=version+1,updated_at=now() WHERE id=$1',[taskId,state]);
    await event(db,occ,t.room_id,a.participantId,'mission.task.updated',{taskId,state});return {taskId,state,version:expectedVersion+1};});
  },
  async submitReport(token,occ,missionId,report){
   const a=await identity(token,occ);if(!checkText(report,12000))fail(400,'Invalid report');
   return tx(async db=>{const q=await db.query('SELECT room_id,state FROM meet_breakouts.room_missions WHERE id=$1 AND occurrence_id=$2 FOR UPDATE',[missionId,occ]);if(!q.rowCount)fail(404,'Mission missing');
    await scope(db,occ,a,q.rows[0].room_id,{edit:true});if(q.rows[0].state!=='open')fail(409,'Mission not open');
    await db.query('INSERT INTO meet_breakouts.mission_reports(mission_id,submitted_by,report) VALUES($1,$2,$3)',[missionId,a.participantId,report]);
    await db.query("UPDATE meet_breakouts.room_missions SET state='submitted',version=version+1,updated_at=now() WHERE id=$1",[missionId]);
    await event(db,occ,q.rows[0].room_id,a.participantId,'mission.submitted',{missionId});return {missionId,state:'submitted'};});
  },
  async roomDashboard(token,occ,roomId){
   const a=await identity(token,occ);const db=await pool.connect();try{await scope(db,occ,a,roomId);
    const m=await db.query(`SELECT m.id,m.title,m.state,m.version,count(t.id)::int AS task_count,count(t.id) FILTER(WHERE t.state='done')::int AS completed FROM meet_breakouts.room_missions m LEFT JOIN meet_breakouts.mission_tasks t ON t.mission_id=m.id WHERE m.occurrence_id=$1 AND m.room_id=$2 GROUP BY m.id ORDER BY m.created_at`,[occ,roomId]);
    return {roomId,missions:m.rows};}finally{db.release();}
  },
  async hostDashboard(token,occ){
   const a=await identity(token,occ);if(!host(a))fail(403,'Host required');
   const r=await pool.query(`SELECT r.id,r.name,count(DISTINCT a.participant_id)::int AS members,count(DISTINCT h.id) FILTER(WHERE h.status='open')::int AS open_help,count(DISTINCT m.id) FILTER(WHERE m.state='submitted')::int AS submitted_missions FROM meet_breakouts.rooms r LEFT JOIN meet_breakouts.assignments a ON a.occurrence_id=r.occurrence_id AND a.room_id=r.id LEFT JOIN meet_breakouts.help_requests h ON h.occurrence_id=r.occurrence_id AND h.room_id=r.id LEFT JOIN meet_breakouts.room_missions m ON m.occurrence_id=r.occurrence_id AND m.room_id=r.id WHERE r.occurrence_id=$1 GROUP BY r.id,r.name ORDER BY r.name`,[occ]);
   return {rooms:r.rows};
  }
 };
}
