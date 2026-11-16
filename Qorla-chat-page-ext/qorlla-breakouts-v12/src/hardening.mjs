import { randomUUID } from 'node:crypto';
export class AccessError extends Error { constructor(status,message){super(message);this.status=status;} }
const fail=(status,message)=>{throw new AccessError(status,message)};
const admin=a=>['host','cohost'].includes(a.role);
const capabilities=new Set(['help_triage','room_announcement','room_notes','room_polls']);
export function createHardening({pool,verifyActor,emitToAuthorizedRecipients}) {
 if(!pool?.connect||!verifyActor||!emitToAuthorizedRecipients) throw Error('Verified Meet adapters required');
 async function actor(token,occ){let a;try{a=await verifyActor(token,occ)}catch{fail(503,'Meet authority unavailable')};if(!a?.active||!a.participantId)fail(403,'Not a participant');return a;}
 async function tx(fn){const db=await pool.connect();try{await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result}catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}}
 async function queue(db,occ,kind,audience,payload){await db.query('INSERT INTO meet_breakouts.outbox(occurrence_id,event_kind,audience,payload) VALUES($1,$2,$3,$4)',[occ,kind,audience,JSON.stringify(payload)])}
 async function move(token,occ,participantId,toRoom){
  const a=await actor(token,occ);
  if(!admin(a)&&a.participantId!==participantId) fail(403,'Cannot move other participants');
  if(!admin(a)&&toRoom!==null) fail(403,'Participants may only return to main');
  return tx(async db=>{
   // One per-meeting lock serializes moves with host recall and room closure.
   const s=await db.query('SELECT state FROM meet_breakouts.sessions WHERE occurrence_id=$1 FOR UPDATE',[occ]);
   if(s.rows[0]?.state!=='active')fail(409,'Breakouts inactive');
   if(toRoom!==null){const r=await db.query("SELECT 1 FROM meet_breakouts.rooms WHERE occurrence_id=$1 AND id=$2 AND state='open'",[occ,toRoom]);if(!r.rowCount)fail(404,'Room not open')}
   const current=await db.query('SELECT room_id,move_epoch FROM meet_breakouts.assignments WHERE occurrence_id=$1 AND participant_id=$2 FOR UPDATE',[occ,participantId]);
   if(!current.rowCount)fail(404,'Assignment missing');
   const previous=current.rows[0].room_id??null;
   if(previous===toRoom)fail(409,'Already assigned to destination');
   const epoch=Number(current.rows[0].move_epoch)+1,id=randomUUID();
   await db.query("UPDATE meet_breakouts.move_commands SET state='superseded' WHERE occurrence_id=$1 AND participant_id=$2 AND state='pending'",[occ,participantId]);
   await db.query("UPDATE meet_breakouts.assignments SET room_id=$3,role='member',move_epoch=$4,revision=revision+1,media_status='switching',media_reported_at=NULL,updated_at=now() WHERE occurrence_id=$1 AND participant_id=$2",[occ,participantId,toRoom,epoch]);
   await db.query('INSERT INTO meet_breakouts.move_commands(id,occurrence_id,participant_id,from_room,to_room,epoch,state) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,occ,participantId,previous,toRoom,epoch,'pending']);
   await queue(db,occ,'room.move','participant:'+participantId,{id,participantId,fromRoom:previous,toRoom,epoch});
   return {id,epoch,status:'switching',verification:'client_unverified'};
  });
 }
 return {
  move,
  async reportMedia(token,occ,id,epoch,report){
   const a=await actor(token,occ);
   if(!Number.isSafeInteger(epoch)||epoch<1||!['connected','failed'].includes(report))fail(400,'Invalid report');
   return tx(async db=>{
    const s=await db.query('SELECT state FROM meet_breakouts.sessions WHERE occurrence_id=$1 FOR UPDATE',[occ]);if(s.rows[0]?.state!=='active')fail(409,'Inactive session');
    const q=await db.query("SELECT state FROM meet_breakouts.move_commands WHERE id=$1 AND occurrence_id=$2 AND participant_id=$3 AND epoch=$4 FOR UPDATE",[id,occ,a.participantId,epoch]);
    if(q.rows[0]?.state!=='pending')fail(409,'Stale or unknown move');
    const status=report==='connected'?'client_reported':'failed';
    await db.query('UPDATE meet_breakouts.move_commands SET state=$2,reported_at=now() WHERE id=$1',[id,status]);
    await db.query('UPDATE meet_breakouts.assignments SET media_status=$4,media_reported_at=now() WHERE occurrence_id=$1 AND participant_id=$2 AND move_epoch=$3',[occ,a.participantId,epoch,status]);
    await queue(db,occ,'room.media_report','hosts',{participantId:a.participantId,epoch,status});
    return {status,verification:'client_unverified'};
   });
  },
  async grantLead(token,occ,roomId,participantId,grants){
   const a=await actor(token,occ);if(!admin(a))fail(403,'Host only');
   if(!Array.isArray(grants)||grants.some(x=>!capabilities.has(x)))fail(400,'Invalid capabilities');
   return tx(async db=>{
    await db.query('SELECT state FROM meet_breakouts.sessions WHERE occurrence_id=$1 FOR UPDATE',[occ]);
    const r=await db.query('SELECT room_id FROM meet_breakouts.assignments WHERE occurrence_id=$1 AND participant_id=$2 FOR UPDATE',[occ,participantId]);
    if(!r.rowCount||r.rows[0].room_id!==roomId)fail(409,'Lead must be assigned to room');
    await db.query('DELETE FROM meet_breakouts.room_lead_grants WHERE occurrence_id=$1 AND room_id=$2 AND participant_id=$3',[occ,roomId,participantId]);
    for(const c of new Set(grants)) await db.query('INSERT INTO meet_breakouts.room_lead_grants(occurrence_id,room_id,participant_id,capability,granted_by) VALUES($1,$2,$3,$4,$5)',[occ,roomId,participantId,c,a.participantId]);
    await db.query("UPDATE meet_breakouts.assignments SET role='lead' WHERE occurrence_id=$1 AND participant_id=$2",[occ,participantId]);
    await queue(db,occ,'room.lead.updated','room:'+roomId,{participantId,roomId,capabilities:grants});return {participantId,roomId,capabilities:grants};
   });
  },
  async canLead(token,occ,roomId,capability){
   if(!capabilities.has(capability))fail(400,'Invalid capability');
   const a=await actor(token,occ);if(admin(a))return true;
   const q=await pool.query(`SELECT 1 FROM meet_breakouts.room_lead_grants g JOIN meet_breakouts.assignments a
    ON a.occurrence_id=g.occurrence_id AND a.participant_id=g.participant_id AND a.room_id=g.room_id
    WHERE g.occurrence_id=$1 AND g.room_id=$2 AND g.participant_id=$3 AND g.capability=$4 AND a.role='lead'`,[occ,roomId,a.participantId,capability]);
   return q.rowCount>0;
  },
  // Multi-server worker: claim with SKIP LOCKED; consumers must be idempotent.
  async drainOutbox(workerId,limit=25){
   if(!workerId||!Number.isInteger(limit)||limit<1||limit>100)fail(400,'Invalid worker');
   const claimed=await tx(async db=>{
    const q=await db.query(`SELECT id,occurrence_id,event_kind,audience,payload FROM meet_breakouts.outbox
      WHERE delivered_at IS NULL AND (lease_until IS NULL OR lease_until<now())
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1`,[limit]);
    for(const e of q.rows)await db.query("UPDATE meet_breakouts.outbox SET lease_owner=$2,lease_until=now()+interval '30 seconds',attempts=attempts+1 WHERE id=$1",[e.id,workerId]);
    return q.rows;
   });
   for(const e of claimed){
    try{await emitToAuthorizedRecipients(e.occurrence_id,e.audience,{id:e.id,type:e.event_kind,payload:e.payload});
      await pool.query('UPDATE meet_breakouts.outbox SET delivered_at=now(),lease_until=NULL WHERE id=$1 AND lease_owner=$2 AND delivered_at IS NULL',[e.id,workerId]);
    }catch{/* lease expires and event is retried */}
   }
   return {claimed:claimed.length};
  }
 };
}
