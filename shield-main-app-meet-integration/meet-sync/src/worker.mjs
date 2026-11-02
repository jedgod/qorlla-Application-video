import crypto from 'node:crypto';
import pg from 'pg';
import {registerSchedule,getSchedule,updateSchedule,cancelSchedule,recoverHost,ackHost} from './bridge.mjs';
import {saveHostSecret,openHostSecret} from './store.mjs';
// ---- Host recovery acknowledgment (v3.9.2) -------------------------------------------------------
// Durable and independent of schedule jobs: every ack_pending row is retried with bounded exponential backoff
// until Meet confirms. Meet keeps the encrypted escrow until a verified ack, so retrying is always safe.
// Claimed with a lease (FOR UPDATE SKIP LOCKED) so concurrent workers never ack the same row twice at once.
const safeMsg = (e) => String(e?.message || e).replace(/(secret|token|password)\s*[:=]\s*\S+/ig, '$1=[REDACTED]').slice(0, 250);
export async function ackSweep(pool, bridge) {
  const c = await pool.connect();
  let row;
  try {
    await c.query('BEGIN');
    row = (await c.query(`SELECT source_id,request_id,generation,ack_attempts FROM qorlla_host_recovery
      WHERE ack_pending AND next_ack_at<=now() AND (ack_lease_until IS NULL OR ack_lease_until<now())
      ORDER BY next_ack_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
    if (row) await c.query(`UPDATE qorlla_host_recovery SET ack_lease_until=now()+($2::float8 * interval '1 second'),ack_attempts=ack_attempts+1 WHERE source_id=$1`, [row.source_id, LEASE_S]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  if (!row) return false;
  try {
    if (typeof bridge.ackHost !== 'function') throw Error('ack bridge unavailable');
    const secret = await openHostSecret(pool, row.source_id); // vault-before-ack: never ack what is not vaulted
    if (!secret) throw Error('vaulted host secret missing');
    try { await bridge.ackHost(row.source_id, row.request_id, Number(row.generation), secret); }
    catch (e) { if (!(e.status === 409 && /not pending/i.test(e.message || ''))) throw e; /* already acknowledged: idempotent */ }
    await pool.query(`UPDATE qorlla_host_recovery SET ack_pending=false,ack_lease_until=NULL,ack_last_error=NULL,ack_attempts=0,
      request_id=gen_random_uuid()::text,updated_at=now() WHERE source_id=$1 AND request_id=$2`, [row.source_id, row.request_id]);
  } catch (e) {
    const attempts = Number(row.ack_attempts) + 1;
    if (attempts >= ACK_ALERT_ATTEMPTS) console.error(`ALERT host recovery ack stuck source=${row.source_id} attempts=${attempts}: ${safeMsg(e)}`);
    await pool.query(`UPDATE qorlla_host_recovery SET ack_lease_until=NULL,ack_last_error=$2,
      next_ack_at=now()+(LEAST(900,POWER(2,LEAST($3::int,10))*$4::float8)*interval '1 second') WHERE source_id=$1`, [row.source_id, safeMsg(e), attempts, ACK_BACKOFF_S]);
  }
  return true;
}

// Timing is configurable so certification can exercise real lease expiry and backoff in seconds, not hours.
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
export const LEASE_S = num(process.env.MEET_SYNC_LEASE_SECONDS, 90);
export const BACKOFF_S = num(process.env.MEET_SYNC_BACKOFF_BASE_SECONDS, 5);
export const ACK_BACKOFF_S = num(process.env.MEET_SYNC_ACK_BACKOFF_BASE_SECONDS, 5);
export const ACK_ALERT_ATTEMPTS = 12;
export async function runOne(pool,bridge={registerSchedule,getSchedule,updateSchedule,cancelSchedule,recoverHost,ackHost}){
 const c=await pool.connect();let j;const token=crypto.randomUUID();
 try{await c.query('BEGIN');const r=await c.query(`SELECT o.*,s.title,s.owner_name,s.legacy_code,s.scheduled_at,s.status AS schedule_status,s.version AS current_version FROM qorlla_outbox o JOIN qorlla_schedules s USING(source_id) WHERE (o.status='pending' AND o.next_attempt_at<=now()) OR (o.status='leased' AND o.lease_until<now()) ORDER BY o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1`);j=r.rows[0];if(j)await c.query(`UPDATE qorlla_outbox SET status='leased',lease_token=$2,lease_until=now()+($3::float8 * interval '1 second'),attempts=attempts+1 WHERE id=$1`,[j.id,token,LEASE_S]);await c.query('COMMIT')}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
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
 await db.query(`UPDATE qorlla_outbox SET status='done',lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2`,[j.id,token]);await db.query('COMMIT');return true;
 }catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}
 }catch(e){const message=String(e.message||e).replace(/(secret|token|password)\s*[:=]\s*\S+/ig,'$1=[REDACTED]').slice(0,250);await pool.query(`UPDATE qorlla_outbox SET status=CASE WHEN attempts>=12 THEN 'dead' ELSE 'pending' END,lease_until=NULL,next_attempt_at=now()+(LEAST(3600,POWER(2,LEAST(attempts,10))*$4::float8)*interval '1 second'),last_error=$3 WHERE id=$1 AND lease_token=$2`,[j.id,token,message,BACKOFF_S]);return true}
}
if(/[\\/]worker\.mjs$/.test(process.argv[1]||'')){if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required');const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});while(true){let worked=false;try{worked=await runOne(pool)}catch(e){console.error('runOne failed:',safeMsg(e))}try{worked=(await ackSweep(pool,{ackHost}))||worked}catch(e){console.error('ackSweep failed:',safeMsg(e))}if(!worked)await new Promise(r=>setTimeout(r,Math.min(3000,Math.max(250,BACKOFF_S*200))))}}
