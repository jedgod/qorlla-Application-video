export const MAX_PAGE_SIZE=100;
export function pageSize(value){const n=Number(value??25);if(!Number.isSafeInteger(n)||n<1||n>MAX_PAGE_SIZE)throw Object.assign(new Error('Invalid limit'),{status:400});return n;}
export function decodeCursor(value){if(!value)return null;try{if(typeof value!=='string'||value.length>1024)throw Error();const raw=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));if(typeof raw.at!=='string'||!Number.isFinite(Date.parse(raw.at))||typeof raw.id!=='string'||!/^[a-f\d-]{36}$/i.test(raw.id))throw Error();return raw;}catch{throw Object.assign(new Error('Invalid cursor'),{status:400});}}
export function encodeCursor(at,id){return Buffer.from(JSON.stringify({at,id})).toString('base64url');}
export function statusFor(p,c){if(p.kick_at)return 'kicked';if(p.decline_at&&!p.joined_at)return 'declined';if(p.joined_at)return 'completed';if(p.invited_at&&c.ended_at)return 'missed';return p.final_status??'ringing';}
export function durationSeconds(segments,asOf=new Date()){return segments.reduce((sum,s)=>sum+Math.max(0,Math.floor((new Date(s.left_at??asOf)-new Date(s.joined_at))/1000)),0);}
export async function listRecent(pool,accountId,{limit=25,cursor=null}={}){
 const size=pageSize(limit),c=decodeCursor(cursor);
 const {rows}=await pool.query(`SELECT p.call_id,p.account_id,p.invited_at,p.answered_at,p.joined_at,p.left_at,p.decline_at,p.kick_at,p.role,p.final_status,p.updated_at,c.room_id,c.room_name,c.started_at,c.ended_at,c.ended_reason,c.created_at,
 COALESCE((SELECT SUM(GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(s.left_at,now())-s.joined_at))))::bigint FROM qve_history_participation_segments s WHERE s.call_id=p.call_id AND s.account_id=p.account_id),0) AS duration_seconds
 FROM qve_history_participants p JOIN qve_history_calls c USING(call_id)
 WHERE p.account_id=$1 AND ($2::timestamptz IS NULL OR (p.updated_at,p.call_id)<($2::timestamptz,$3::uuid))
 ORDER BY p.updated_at DESC,p.call_id DESC LIMIT $4`,[accountId,c?.at??null,c?.id??null,size+1]);
 const more=rows.length>size;const items=rows.slice(0,size).map(r=>({...r,status:statusFor(r,r),duration_seconds:Number(r.duration_seconds)}));
 return {items,nextCursor:more?encodeCursor(items.at(-1).updated_at,items.at(-1).call_id):null};
}
export async function detail(pool,accountId,callId){
 const {rows:[self]}=await pool.query('SELECT p.*,c.room_id,c.room_name,c.started_at,c.ended_at,c.ended_reason FROM qve_history_participants p JOIN qve_history_calls c USING(call_id) WHERE p.account_id=$1 AND p.call_id=$2',[accountId,callId]);
 if(!self)return null;
 const [segments,events]=await Promise.all([
  pool.query('SELECT segment_id,joined_at,left_at FROM qve_history_participation_segments WHERE call_id=$1 AND account_id=$2 ORDER BY joined_at,segment_id',[callId,accountId]),
  pool.query(`SELECT event_type,occurred_at,CASE WHEN subject_account_id=$2 THEN 'self' ELSE 'other' END AS subject_scope FROM qve_history_membership_events WHERE call_id=$1 AND (subject_account_id=$2 OR event_type='host_transferred') ORDER BY occurred_at,event_id LIMIT 200`,[callId,accountId])
 ]);
 return {call_id:callId,room_id:self.room_id,room_name:self.room_name,started_at:self.started_at,ended_at:self.ended_at,ended_reason:self.ended_reason,status:statusFor(self,self),role:self.role,duration_seconds:durationSeconds(segments.rows),segments:segments.rows,events:events.rows};
}
