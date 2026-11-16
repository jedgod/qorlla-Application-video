import { randomUUID } from 'node:crypto';

export class BreakoutError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (status, message) => { throw new BreakoutError(status,message); };
export const scopeKey = (occurrence, room) => `${occurrence}:room:${room ?? 'main'}`;

// Dependencies are mandatory real Meet adapters; no demo authentication fallback.
export function createBreakouts({ pool, meetAuthority, signalHub, mediaCoordinator }) {
  if (!pool || !meetAuthority?.verifyActor || !meetAuthority?.listParticipants || !signalHub?.publish || !mediaCoordinator?.transition) throw new Error('Real Meet adapters required');
  async function authorize(token, occurrence, admin = false) {
    const actor = await meetAuthority.verifyActor(token, occurrence); // must fail closed
    if (!actor?.participantId || !actor.active || (admin && !['host','cohost'].includes(actor.role))) bad(403,'Forbidden');
    return actor;
  }
  async function mutate({ token, occurrence, action, fn }) {
    const actor = await authorize(token,occurrence,true);
    const db = await pool.connect(); let event;
    try {
      await db.query('BEGIN');
      await db.query('INSERT INTO meet_breakouts.sessions(occurrence_id) VALUES ($1) ON CONFLICT DO NOTHING',[occurrence]);
      const lock = await db.query('SELECT * FROM meet_breakouts.sessions WHERE occurrence_id=$1 FOR UPDATE',[occurrence]);
      const result = await fn(db,lock.rows[0],actor);
      const seq = await db.query('UPDATE meet_breakouts.sessions SET revision=revision+1,updated_at=now() WHERE occurrence_id=$1 RETURNING revision',[occurrence]);
      event={occurrence,revision:Number(seq.rows[0].revision),type:action,payload:result};
      await db.query('INSERT INTO meet_breakouts.events(occurrence_id,event_type,payload) VALUES($1,$2,$3)',[occurrence,action,event]);
      await db.query('INSERT INTO meet_breakouts.audit(occurrence_id,actor_id,action,details) VALUES($1,$2,$3,$4)',[occurrence,actor.participantId,action,result]);
      await db.query('COMMIT');
      // Publish is best effort; durable event replay is authoritative.
      try { await signalHub.publish(occurrence,event); } catch { /* replay on reconnect */ }
      return event;
    } catch(e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  return {
    authorize,
    async createRoom(token,occurrence,name) {
      if(typeof name!=='string'||!name.trim()||name.length>100) bad(400,'Invalid room name');
      return mutate({token,occurrence,action:'room.created',fn:async db=>{
        const id=randomUUID(); await db.query('INSERT INTO meet_breakouts.rooms(id,occurrence_id,name) VALUES($1,$2,$3)',[id,occurrence,name.trim()]); return {id,name:name.trim()};
      }});
    },
    async assign(token,occurrence,participantId,roomId,role='member') {
      if(!['member','lead'].includes(role)) bad(400,'Invalid role');
      const people=await meetAuthority.listParticipants(occurrence);
      if(!people.some(p=>p.participantId===participantId&&p.active)) bad(404,'Participant not active');
      return mutate({token,occurrence,action:'participant.assigned',fn:async db=>{
        if(roomId!==null){const r=await db.query('SELECT id FROM meet_breakouts.rooms WHERE occurrence_id=$1 AND id=$2 AND state=$3',[occurrence,roomId,'open']);if(!r.rowCount) bad(404,'Room not found');}
        await db.query(`INSERT INTO meet_breakouts.assignments(occurrence_id,participant_id,room_id,role) VALUES($1,$2,$3,$4)
          ON CONFLICT(occurrence_id,participant_id) DO UPDATE SET room_id=EXCLUDED.room_id,role=EXCLUDED.role,revision=meet_breakouts.assignments.revision+1,updated_at=now()`,[occurrence,participantId,roomId,role]);
        return {participantId,roomId,role};
      }});
    },
    async start(token,occurrence,minutes) {
      if(!Number.isInteger(minutes)||minutes<1||minutes>240) bad(400,'Invalid duration');
      return mutate({token,occurrence,action:'session.started',fn:async db=>{
        const x=await db.query(`UPDATE meet_breakouts.sessions SET state='active',deadline=now()+($2 * interval '1 minute') WHERE occurrence_id=$1 RETURNING deadline`,[occurrence,minutes]);
        return {deadline:x.rows[0].deadline};
      }});
    },
    async recall(token,occurrence) {
      return mutate({token,occurrence,action:'session.recalled',fn:async db=>{
        await db.query("UPDATE meet_breakouts.sessions SET state='closing' WHERE occurrence_id=$1",[occurrence]);
        await db.query('UPDATE meet_breakouts.assignments SET room_id=NULL,role=$2,revision=revision+1 WHERE occurrence_id=$1',[occurrence,'member']);
        return {target:'main'};
      }});
    },
    async snapshot(token,occurrence,since=0) {
      const actor=await authorize(token,occurrence);
      const db=await pool.connect();try{
        const [s,rooms,assignments,events]=await Promise.all([
          db.query('SELECT state,revision,deadline FROM meet_breakouts.sessions WHERE occurrence_id=$1',[occurrence]),
          db.query('SELECT id,name,state FROM meet_breakouts.rooms WHERE occurrence_id=$1',[occurrence]),
          db.query('SELECT participant_id,room_id,role,revision FROM meet_breakouts.assignments WHERE occurrence_id=$1',[occurrence]),
          db.query('SELECT seq,event_type,payload FROM meet_breakouts.events WHERE occurrence_id=$1 AND seq>$2 ORDER BY seq LIMIT 500',[occurrence,since])
        ]);
        const mine=assignments.rows.find(a=>a.participant_id===actor.participantId)?.room_id??null;
        return {session:s.rows[0]??null,rooms:actor.role==='host'||actor.role==='cohost'?rooms.rows:rooms.rows.filter(r=>r.id===mine),assignments:['host','cohost'].includes(actor.role)?assignments.rows:assignments.rows.filter(a=>a.room_id===mine),events:events.rows.filter(e=>['host','cohost'].includes(actor.role)||!['participant.assigned'].includes(e.event_type)||e.payload?.payload?.participantId===actor.participantId)};
      }finally{db.release();}
    },
    // Call after a server-authorized assignment change or reconnect. The coordinator must
    // revoke old peer routes, tear down old RTCPeerConnections, and await new room media.
    async reconcileMedia(token,occurrence,clientRevision) {
      const actor=await authorize(token,occurrence);
      const q=await pool.query('SELECT a.room_id,a.revision,s.revision AS session_revision FROM meet_breakouts.sessions s LEFT JOIN meet_breakouts.assignments a ON a.occurrence_id=s.occurrence_id AND a.participant_id=$2 WHERE s.occurrence_id=$1',[occurrence,actor.participantId]);
      if(!q.rowCount) bad(404,'Session not found');
      const state=q.rows[0];
      await mediaCoordinator.transition({occurrence,participantId:actor.participantId,targetRoom:state.room_id,revision:Number(state.session_revision),previousRevision:clientRevision});
      return {roomId:state.room_id,revision:Number(state.session_revision)};
    },
    async authorizeSignal(token,occurrence,targetParticipantId) {
      const actor=await authorize(token,occurrence);
      const q=await pool.query('SELECT participant_id,room_id FROM meet_breakouts.assignments WHERE occurrence_id=$1 AND participant_id=ANY($2::text[])',[occurrence,[actor.participantId,targetParticipantId]]);
      const room=id=>q.rows.find(x=>x.participant_id===id)?.room_id??null;
      if(room(actor.participantId)!==room(targetParticipantId)) bad(403,'Cross-room signaling denied');
      return {actor,scope:scopeKey(occurrence,room(actor.participantId))};
    }
  };
}
