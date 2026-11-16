
import { randomUUID } from 'node:crypto';

export class RoomAccessError extends Error {
 constructor(status,message){super(message);this.status=status;}
}
const deny=(status,message)=>{throw new RoomAccessError(status,message)};
const privileged=a=>['host','cohost'].includes(a.role);

export function createRoomCollaboration({pool,meetAuthority,mediaCoordinator,eventHub}) {
 if(!pool?.connect || !meetAuthority?.verifyActor || !mediaCoordinator?.transition || !eventHub?.publish)
   throw new Error('Meet authority, database, media coordinator and event hub required');
 async function actorFor(token,occurrence) {
   let actor;
   try { actor=await meetAuthority.verifyActor(token,occurrence); } catch { deny(503,'Meeting authority unavailable'); }
   if(!actor?.active || !actor.participantId) deny(403,'Not an active meeting participant');
   return actor;
 }
 async function location(db,occurrence,participantId){
   const r=await db.query(`SELECT s.state,a.room_id,a.revision FROM meet_breakouts.sessions s
     LEFT JOIN meet_breakouts.assignments a ON a.occurrence_id=s.occurrence_id AND a.participant_id=$2
     WHERE s.occurrence_id=$1`,[occurrence,participantId]);
   if(!r.rowCount) deny(404,'Breakout session missing');
   return {room:r.rows[0].state==='active' ? r.rows[0].room_id??null : null,
           revision:Number(r.rows[0].revision??0),state:r.rows[0].state};
 }
 async function transaction(fn){
   const db=await pool.connect();
   try{await db.query('BEGIN');const v=await fn(db);await db.query('COMMIT');return v;}
   catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 async function publish(occurrence,event){try{await eventHub.publish(occurrence,event);}catch{/* persisted state remains authoritative */}}
 return {
  // Call at EVERY Notes/Polls HTTP and websocket read/write and subscription.
  // An omitted ACL row is denied while breakouts are active, not treated as meeting-wide.
  async authorizeContent(token,occurrence,kind,contentId,{write=false}={}){
   if(!['note','poll'].includes(kind)) deny(400,'Invalid content kind');
   const actor=await actorFor(token,occurrence);
   const db=await pool.connect();
   try {
    const loc=await location(db,occurrence,actor.participantId);
    const r=await db.query(`SELECT room_id,created_by FROM meet_breakouts.room_content_acl
      WHERE occurrence_id=$1 AND content_kind=$2 AND content_id=$3`,
      [occurrence,kind,contentId]);
    if(!r.rowCount) {
      if(loc.state==='active') deny(403,'Content has no room scope');
      // Outside breakout sessions, caller still must enforce legacy Notes/Polls ACL.
      return {actor,roomId:null,legacyAuthorizationRequired:true};
    }
    const target=r.rows[0].room_id??null;
    if(!privileged(actor) && target!==loc.room) deny(403,'Content belongs to another room');
    if(write && !privileged(actor) && r.rows[0].created_by!==actor.participantId)
      deny(403,'Cannot modify content');
    return {actor,roomId:target,legacyAuthorizationRequired:true};
   } finally {db.release();}
  },
  async listScope(token,occurrence,kind){
   if(!['note','poll'].includes(kind)) deny(400,'Invalid kind');
   const actor=await actorFor(token,occurrence);
   const db=await pool.connect();
   try{
    const loc=await location(db,occurrence,actor.participantId);
    if(loc.state!=='active') return {actor,scope:'legacy',legacyAuthorizationRequired:true};
    // Host visibility is explicit; do not expose private rooms to ordinary participants.
    return {actor,scope:privileged(actor)?'host': 'room',roomId:loc.room,
      legacyAuthorizationRequired:true};
   }finally{db.release();}
  },
  async registerContent(token,occurrence,kind,contentId,roomId){
   if(!['note','poll'].includes(kind)||typeof contentId!=='string'||!contentId) deny(400,'Invalid content');
   const actor=await actorFor(token,occurrence);
   return transaction(async db=>{
     const loc=await location(db,occurrence,actor.participantId);
     if(loc.state==='active' && !privileged(actor) && roomId!==loc.room) deny(403,'Wrong room');
     if(loc.state==='active' && roomId===undefined) deny(400,'Explicit room required');
     if(roomId!==null && roomId!==undefined){
       const check=await db.query('SELECT 1 FROM meet_breakouts.rooms WHERE id=$1 AND occurrence_id=$2 AND state=$3',[roomId,occurrence,'open']);
       if(!check.rowCount) deny(404,'Room unavailable');
     }
     await db.query(`INSERT INTO meet_breakouts.room_content_acl
       (occurrence_id,content_kind,content_id,room_id,created_by)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
       [occurrence,kind,contentId,roomId??null,actor.participantId]);
     const r=await db.query(`SELECT room_id FROM meet_breakouts.room_content_acl
       WHERE occurrence_id=$1 AND content_kind=$2 AND content_id=$3`,[occurrence,kind,contentId]);
     if((r.rows[0]?.room_id??null)!==(roomId??null)) deny(409,'Content scope conflict');
     return {contentId,roomId:roomId??null};
   });
  },
  async returnToMain(token,occurrence){
   const actor=await actorFor(token,occurrence);
   const request=await transaction(async db=>{
     const loc=await location(db,occurrence,actor.participantId);
     if(loc.state!=='active'||!loc.room) deny(409,'Not currently in a breakout room');
     // Serialize against host reassignment and recall.
     await db.query('SELECT revision FROM meet_breakouts.sessions WHERE occurrence_id=$1 FOR UPDATE',[occurrence]);
     const latest=await location(db,occurrence,actor.participantId);
     if(latest.room!==loc.room) deny(409,'Room changed; reconnect');
     const id=randomUUID();
     await db.query(`UPDATE meet_breakouts.assignments SET room_id=NULL,role='member',
       revision=revision+1,updated_at=now() WHERE occurrence_id=$1 AND participant_id=$2`,
       [occurrence,actor.participantId]);
     await db.query(`INSERT INTO meet_breakouts.transition_requests
       (id,occurrence_id,participant_id,from_room,to_room,state)
       VALUES($1,$2,$3,$4,NULL,'pending')`,[id,occurrence,actor.participantId,loc.room]);
     await db.query(`INSERT INTO meet_breakouts.events(occurrence_id,event_type,payload)
       VALUES($1,'participant.return.requested',$2)`,[occurrence,{id,participantId:actor.participantId}]);
     return {id,fromRoom:loc.room};
   });
   await publish(occurrence,{type:'participant.return.requested',participantId:actor.participantId,transitionId:request.id});
   // A real adapter must close previous peers and establish main-room media.
   // Do not report success until an ACK is verified.
   try {
     await mediaCoordinator.transition({occurrence,participantId:actor.participantId,
       targetRoom:null,transitionId:request.id});
   } catch { await pool.query(`UPDATE meet_breakouts.transition_requests SET state='failed'
     WHERE id=$1 AND state='pending'`,[request.id]);deny(503,'Media transition failed; reconnect required'); }
   return {transitionId:request.id,status:'pending_media_ack'};
  },
  async acknowledgeReturn(token,occurrence,transitionId){
   const actor=await actorFor(token,occurrence);
   // Caller must also verify media readiness with the trusted coordinator.
   if(typeof mediaCoordinator.verifyReady!=='function') deny(503,'Media ACK verifier unavailable');
   const ready=await mediaCoordinator.verifyReady({occurrence,participantId:actor.participantId,transitionId,targetRoom:null});
   if(!ready) deny(409,'Main-room media not ready');
   const r=await pool.query(`UPDATE meet_breakouts.transition_requests SET state='acknowledged',acknowledged_at=now()
     WHERE id=$1 AND occurrence_id=$2 AND participant_id=$3 AND state='pending'
     RETURNING id`,[transitionId,occurrence,actor.participantId]);
   if(!r.rowCount) deny(409,'Transition not pending');
   return {status:'main_room_connected'};
  },
  async askForHelp(token,occurrence){
   const actor=await actorFor(token,occurrence);
   const result=await transaction(async db=>{
     const loc=await location(db,occurrence,actor.participantId);
     if(loc.state!=='active'||!loc.room) deny(409,'Help requests require a breakout room');
     const recent=await db.query(`SELECT created_at FROM meet_breakouts.help_requests
       WHERE occurrence_id=$1 AND requester_id=$2 ORDER BY created_at DESC LIMIT 1`,
       [occurrence,actor.participantId]);
     if(recent.rowCount && Date.now()-new Date(recent.rows[0].created_at).getTime()<30000)
       deny(429,'Please wait before requesting help again');
     const id=randomUUID();
     await db.query(`INSERT INTO meet_breakouts.help_requests(id,occurrence_id,room_id,requester_id)
       VALUES($1,$2,$3,$4)`,[id,occurrence,loc.room,actor.participantId]);
     await db.query(`INSERT INTO meet_breakouts.events(occurrence_id,event_type,payload)
       VALUES($1,'room.help.requested',$2)`,[occurrence,{id,roomId:loc.room}]);
     return {id,roomId:loc.room,status:'open'};
   });
   // Event hub must route to authorized hosts/cohosts, not the whole meeting.
   await publish(occurrence,{type:'room.help.requested',audience:'hosts',requestId:result.id,roomId:result.roomId});
   return result;
  },
  async resolveHelp(token,occurrence,id){
   const actor=await actorFor(token,occurrence);
   if(!privileged(actor)) deny(403,'Host permission required');
   const r=await pool.query(`UPDATE meet_breakouts.help_requests SET status='resolved',resolved_at=now()
     WHERE id=$1 AND occurrence_id=$2 AND status IN ('open','acknowledged') RETURNING id`,[id,occurrence]);
   if(!r.rowCount) deny(404,'Open help request not found');
   await publish(occurrence,{type:'room.help.resolved',audience:'hosts',requestId:id});
   return {id,status:'resolved'};
  }
 };
}
