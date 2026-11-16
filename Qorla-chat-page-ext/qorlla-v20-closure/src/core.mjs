import {randomUUID} from 'node:crypto';
export const topic = meetingId => `meet:${meetingId}`;
export const validId = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(x);
export function requireId(x){if(!validId(x))throw Object.assign(new Error('invalid identifier'),{status:400});return x;}
export async function transaction(pool,fn){const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
export async function currentMembership(db,meetingId,participantId){const {rows}=await db.query('SELECT room_id,epoch FROM meet_dist.memberships WHERE meeting_id=$1 AND participant_id=$2',[meetingId,participantId]);return rows[0]??null;}
export async function authorize(db,identity,meetingId,roomId,epoch){if(identity.meetingId!==meetingId)throw Object.assign(new Error('meeting denied'),{status:403});const m=await currentMembership(db,meetingId,identity.participantId);if(!m||m.room_id!==roomId||BigInt(m.epoch)!==BigInt(epoch))throw Object.assign(new Error('room/epoch denied'),{status:403});return m;}
export async function appendEvent(pool,identity,{meetingId,roomId,epoch,kind,payload}){
 requireId(meetingId);requireId(roomId);if(!['chat','signal','presence','whiteboard','report_status'].includes(kind))throw Object.assign(new Error('kind denied'),{status:400});
 if(typeof payload!=='object'||payload===null||Array.isArray(payload)||JSON.stringify(payload).length>16000)throw Object.assign(new Error('payload denied'),{status:400});
 return transaction(pool,async c=>{await authorize(c,identity,meetingId,roomId,epoch);const id=randomUUID();await c.query('INSERT INTO meet_dist.events(id,meeting_id,room_id,epoch,kind,payload,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,meetingId,roomId,epoch,kind,payload,identity.participantId]);await c.query('INSERT INTO meet_dist.outbox(event_id) VALUES($1)',[id]);return id;});
}
export async function roomHistory(db,identity,{meetingId,roomId,epoch,after,limit=100}){
 await authorize(db,identity,meetingId,roomId,epoch);const cap=Math.min(100,Math.max(1,Number(limit)||100));const {rows}=await db.query(`SELECT id,kind,payload,actor_id,created_at,epoch FROM meet_dist.events WHERE meeting_id=$1 AND room_id=$2 AND epoch=$3 AND ($4::timestamptz IS NULL OR created_at>$4::timestamptz) ORDER BY created_at,id LIMIT $5`,[meetingId,roomId,epoch,after??null,cap]);return rows;
}
export function isDeliverable(event,membership,identity){return !!membership&&identity.meetingId===event.meeting_id&&membership.room_id===event.room_id&&BigInt(membership.epoch)===BigInt(event.epoch);}
