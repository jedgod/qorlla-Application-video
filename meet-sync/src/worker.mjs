import crypto from 'node:crypto';
import pg from 'pg';
import {registerSchedule,getSchedule,updateSchedule,cancelSchedule,recoverHost,ackHost} from './bridge.mjs';
import {saveHostSecret,openHostSecret} from './store.mjs';
// Acknowledge a vaulted recovery generation (best effort; retried on the source's next job). Meet verifies the
// vaulted credential really claims host before erasing its escrow copy.
async function ackPending(pool,sourceId,bridge){
 try{
  const r=(await pool.query('SELECT request_id,generation FROM qorlla_host_recovery WHERE source_id=$1 AND ack_pending',[sourceId])).rows[0];
  if(!r||typeof bridge.ackHost!=='function')return;
  const secret=await openHostSecret(pool,sourceId);if(!secret)return;
  await bridge.ackHost(sourceId,r.request_id,Number(r.generation),secret);
  await pool.query('UPDATE qorlla_host_recovery SET ack_pending=false,request_id=gen_random_uuid()::text,updated_at=now() WHERE source_id=$1 AND request_id=$2',[sourceId,r.request_id]);
 }catch(e){console.error('Host recovery ack pending:',String(e.message||e).slice(0,120))}
}
export async function runOne(pool,bridge={registerSchedule,getSchedule,updateSchedule,cancelSchedule,recoverHost,ackHost}){
 const c=await pool.connect();let j;const token=crypto.randomUUID();
 try{await c.query('BEGIN');const r=await c.query(`SELECT o.*,s.title,s.owner_name,s.legacy_code,s.scheduled_at,s.status AS schedule_status,s.version AS current_version FROM qorlla_outbox o JOIN qorlla_schedules s USING(source_id) WHERE (o.status='pending' AND o.next_attempt_at<=now()) OR (o.status='leased' AND o.lease_until<now()) ORDER BY o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1`);j=r.rows[0];if(j)await c.query(`UPDATE qorlla_outbox SET status='leased',lease_token=$2,lease_until=now()+interval '90 seconds',attempts=attempts+1 WHERE id=$1`,[j.id,token]);await c.query('COMMIT')}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 if(!j)return false;
 try{
 // Serialize each source across workers; hold a per-source advisory lock during the remote operation.
 const db=await pool.connect();try{await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[j.source_id]);const latest=(await db.query('SELECT * FROM qorlla_schedules WHERE source_id=$1 FOR UPDATE',[j.source_id])).rows[0];
 if(latest.version!==j.version){await db.query(`UPDATE qorlla_outbox SET status='done',lease_until=NULL WHERE id=$1 AND lease_token=$2`,[j.id,token]);await db.query('COMMIT');return true}
 if(j.operation==='cancel'){
  try{await bridge.cancelSchedule(j.source_id)}catch(e){if(e.status!==404)throw e}
  await db.query(`UPDATE qorlla_schedules SET status='cancelled',meet_uuid=NULL,meet_code=NULL WHERE source_id=$1 AND version=$2`,[j.source_id,j.version]);
 }else{
  let existing;try{existing=await bridge.getSchedule(j.source_id)}catch(e){if(e.status!==404)throw e}
  const payload={sourceId:j.source_id,legacyCode:latest.legacy_code,title:latest.title,ownerName:latest.owner_name,scheduledAt:latest.scheduled_at,passcodeHash:latest.passcode_hash||null};
  const result=existing?(await bridge.updateSchedule(j.source_id,{title:latest.title,scheduledAt:latest.scheduled_at,passcodeHash:latest.passcode_hash||null}),existing):await bridge.registerSchedule(payload);
  const uuid=result.meetUuid||result.meetingId,code=result.meetCode||result.meetingCode;if(!uuid||!code)throw Error('Incomplete Meet mapping');
  // v3.9 host recovery: a stable request ID is persisted BEFORE calling Meet, so a lost response or failed
  // vault write replays the same generation instead of rotating again. Ack only after the secret is vaulted.
  const vault=(await db.query('SELECT 1 FROM qorlla_host_vault WHERE source_id=$1',[j.source_id])).rowCount;
  if(result.hostSecret)await saveHostSecret(db,j.source_id,result.hostSecret);
  else if(!vault){
   if(typeof bridge.recoverHost !== 'function')throw Error('Host recovery bridge method unavailable');
   const row=(await db.query(`INSERT INTO qorlla_host_recovery(source_id,request_id) VALUES($1,$2) ON CONFLICT(source_id) DO UPDATE SET updated_at=now() RETURNING request_id`,[j.source_id,crypto.randomUUID()])).rows[0];
   const recovered=await bridge.recoverHost(j.source_id,row.request_id);
   if(!recovered.hostSecret)throw Error('Host recovery returned no credential');
   await saveHostSecret(db,j.source_id,recovered.hostSecret);
   await db.query('UPDATE qorlla_host_recovery SET generation=$2,ack_pending=true,updated_at=now() WHERE source_id=$1',[j.source_id,recovered.generation]);
  }
  await db.query(`UPDATE qorlla_schedules SET status='synced',meet_uuid=$3,meet_code=$4 WHERE source_id=$1 AND version=$2`,[j.source_id,j.version,uuid,code]);
 }
 await db.query(`UPDATE qorlla_outbox SET status='done',lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2`,[j.id,token]);await db.query('COMMIT');await ackPending(pool,j.source_id,bridge);return true;
 }catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}
 }catch(e){const message=String(e.message||e).replace(/(secret|token|password)\s*[:=]\s*\S+/ig,'$1=[REDACTED]').slice(0,250);await pool.query(`UPDATE qorlla_outbox SET status=CASE WHEN attempts>=12 THEN 'dead' ELSE 'pending' END,lease_until=NULL,next_attempt_at=now()+(LEAST(3600,POWER(2,LEAST(attempts,10))*5)::int*interval '1 second'),last_error=$3 WHERE id=$1 AND lease_token=$2`,[j.id,token,message]);return true}
}
if(/[\\/]worker\.mjs$/.test(process.argv[1]||'')){if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required');const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});while(true){const worked=await runOne(pool);if(!worked)await new Promise(r=>setTimeout(r,3000))}}
