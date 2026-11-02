// Consume committed, authenticated QVE events from the engine's durable outbox.
// NEVER accept this endpoint directly from a browser or public request.
const TYPES=new Set(['call_created','call_started','call_ended','invited','joined','left','kicked','host_transferred','declined','device_claimed']);
function requireString(x,name,max=256){if(typeof x!=='string'||!x||x.length>max)throw new Error(`Invalid ${name}`);return x;}
function instant(x){const d=new Date(x);if(!x||!Number.isFinite(d.getTime()))throw new Error('Invalid occurred_at');return d;}
export function validateEvent(e){if(!e||typeof e!=='object'||!TYPES.has(e.type))throw new Error('Unknown event type');return {source:requireString(e.source,'source'),event_id:requireString(e.event_id,'event_id'),call_id:requireString(e.call_id,'call_id',36),type:e.type,occurred_at:instant(e.occurred_at),room_id:e.room_id?requireString(e.room_id,'room_id'):null,room_name:e.room_name?requireString(e.room_name,'room_name'):null,account_id:e.account_id?requireString(e.account_id,'account_id'):null,actor_account_id:e.actor_account_id?requireString(e.actor_account_id,'actor_account_id'):null,segment_id:e.segment_id?requireString(e.segment_id,'segment_id'):null};}
export async function projectEvent(pool,raw){const e=validateEvent(raw);const client=await pool.connect();try{await client.query('BEGIN');
 // A per-call advisory lock prevents late concurrent projectors from racing.
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[e.call_id]);
 const receipt=await client.query('INSERT INTO qve_history_event_receipts(source,event_id,call_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id',[e.source,e.event_id,e.call_id]);
 if(!receipt.rowCount){await client.query('COMMIT');return {duplicate:true};}
 await client.query(`INSERT INTO qve_history_calls(call_id,room_id,room_name,created_at,last_event_at) VALUES($1,COALESCE($2,$1),$3,$4,$4) ON CONFLICT(call_id) DO UPDATE SET room_name=COALESCE(qve_history_calls.room_name,EXCLUDED.room_name),last_event_at=GREATEST(qve_history_calls.last_event_at,EXCLUDED.last_event_at)`,[e.call_id,e.room_id,e.room_name,e.occurred_at]);
 if(e.type==='call_started')await client.query('UPDATE qve_history_calls SET started_at=COALESCE(started_at,$2) WHERE call_id=$1',[e.call_id,e.occurred_at]);
 if(e.type==='call_ended')await client.query('UPDATE qve_history_calls SET ended_at=COALESCE(ended_at,$2) WHERE call_id=$1',[e.call_id,e.occurred_at]);
 if(['invited','joined','left','kicked','host_transferred','declined'].includes(e.type)){
  if(!e.account_id)throw Error('Missing subject account_id');
  await client.query('INSERT INTO qve_history_participants(call_id,account_id,updated_at) VALUES($1,$2,$3) ON CONFLICT(call_id,account_id) DO UPDATE SET updated_at=GREATEST(qve_history_participants.updated_at,EXCLUDED.updated_at)',[e.call_id,e.account_id,e.occurred_at]);
  const field={invited:'invited_at',joined:'joined_at',left:'left_at',kicked:'kick_at',declined:'decline_at'}[e.type];
  if(field)await client.query(`UPDATE qve_history_participants SET ${field}=COALESCE(${field},$3) WHERE call_id=$1 AND account_id=$2`,[e.call_id,e.account_id,e.occurred_at]);
  if(e.type==='host_transferred')await client.query(`UPDATE qve_history_participants SET role=CASE WHEN account_id=$2 THEN 'host' ELSE 'member' END WHERE call_id=$1`,[e.call_id,e.account_id]);
  if(e.type==='joined')await client.query(`INSERT INTO qve_history_participation_segments(call_id,account_id,segment_id,joined_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[e.call_id,e.account_id,e.segment_id??e.event_id,e.occurred_at]);
  if(e.type==='left'||e.type==='kicked')await client.query(`UPDATE qve_history_participation_segments SET left_at=$3 WHERE call_id=$1 AND account_id=$2 AND left_at IS NULL AND joined_at<=$3`,[e.call_id,e.account_id,e.occurred_at]);
  await client.query('INSERT INTO qve_history_membership_events(source,event_id,call_id,subject_account_id,actor_account_id,event_type,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[e.source,e.event_id,e.call_id,e.account_id,e.actor_account_id,e.type,e.occurred_at]);
 }
 await client.query('COMMIT');return {duplicate:false};
 }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}}
