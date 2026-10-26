// Node 20+; inject a pg.Pool or compatible pool. Server-side only.
import {registerSchedule, getSchedule, updateSchedule, cancelSchedule} from './bridge.mjs';
const safe = (e) => String(e?.message || e).slice(0,500).replace(/(secret|token|password)=\S+/gi,'$1=[REDACTED]');
export async function enqueue(pool, sourceId, operation, payload={}) {
 if (!sourceId || !['upsert','cancel'].includes(operation)) throw new Error('Invalid job');
 // Upserts supersede older upserts; never put secrets in payload.
 if ('hostSecret' in payload || 'passcode' in payload) throw new Error('Secrets must not enter queue');
 await pool.query(`INSERT INTO qorlla_meet_sync_jobs(source_id,operation,payload) VALUES($1,$2,$3)
 ON CONFLICT(source_id,operation) DO UPDATE SET payload=EXCLUDED.payload,status='pending',next_attempt_at=now(),lease_until=NULL,updated_at=now()`,[sourceId,operation,JSON.stringify(payload)]);
}
export async function processOne(pool, {saveHostSecret, onSynced}={}) {
 const client=await pool.connect(); let job;
 try {
  await client.query('BEGIN');
  const result=await client.query(`SELECT * FROM qorlla_meet_sync_jobs WHERE (status='pending' AND next_attempt_at<=now()) OR (status='leased' AND lease_until<now()) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`);
  job=result.rows[0];
  if (!job) {await client.query('COMMIT');return false;}
  await client.query(`UPDATE qorlla_meet_sync_jobs SET status='leased',attempts=attempts+1,lease_until=now()+interval '45 seconds',updated_at=now() WHERE id=$1`,[job.id]);
  await client.query('COMMIT');
 } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
 try {
  if(job.operation==='cancel') {
   try {await cancelSchedule(job.source_id);} catch(e){if(e.status!==404)throw e;}
  } else {
   const data=job.payload;
   // If already registered, update title/time; if not, register idempotently.
   let existing;
   try {existing=await getSchedule(job.source_id);} catch(e){if(e.status!==404)throw e;}
   let result;
   if(existing) {await updateSchedule(job.source_id,{title:data.title,scheduledAt:data.scheduledAt});result=existing;}
   else result=await registerSchedule(data);
   const uuid=result.meetUuid||result.meetingId||result.meetId;
   const code=result.meetCode||result.meetingCode;
   if(!uuid||!code)throw new Error('Bridge returned no meeting mapping');
   // Host secret is only returned at first creation. Vault write must succeed before marking done.
   if(result.hostSecret) {
    if(!saveHostSecret) throw new Error('Encrypted host secret vault callback required');
    await saveHostSecret(job.source_id,result.hostSecret);
   }
   await pool.query(`INSERT INTO qorlla_meet_mappings(source_id,meet_uuid,meet_code,legacy_code) VALUES($1,$2,$3,$4)
    ON CONFLICT(source_id) DO UPDATE SET meet_uuid=EXCLUDED.meet_uuid,meet_code=EXCLUDED.meet_code,legacy_code=EXCLUDED.legacy_code,synced_at=now()`,[job.source_id,uuid,code,data.legacyCode||null]);
   if(onSynced)await onSynced(job.source_id,{meetUuid:uuid,meetCode:code});
  }
  await pool.query(`UPDATE qorlla_meet_sync_jobs SET status='done',lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND status='leased'`,[job.id]);
 } catch(e) {
  const attempts=job.attempts+1;
  const delay=Math.min(3600,Math.pow(2,Math.min(attempts,10))*5);
  await pool.query(`UPDATE qorlla_meet_sync_jobs SET status=CASE WHEN $2>=12 THEN 'dead' ELSE 'pending' END,lease_until=NULL,next_attempt_at=now()+($3::integer * interval '1 second'),last_error=$4,updated_at=now() WHERE id=$1`,[job.id,attempts,delay,safe(e)]);
 }
 return true;
}
export async function runWorker(pool, options={}, signal) {
 while(!signal?.aborted) {
  const worked=await processOne(pool,options);
  if(!worked) await new Promise(r=>setTimeout(r,1500));
 }
}
