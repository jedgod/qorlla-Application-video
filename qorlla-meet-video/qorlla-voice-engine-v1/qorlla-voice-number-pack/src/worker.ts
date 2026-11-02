import {pool,transaction} from './db.js';
import {provider} from './provider.js';
import {config} from './config.js';
export async function runWorkerOnce(){
 // The lease is persisted so worker restarts cannot lose jobs. External operations MUST be idempotent.
 const jobs=await transaction(async c=>{
  const r=await c.query(`SELECT id FROM voice_outbox WHERE (status='queued' AND next_attempt_at<=now())
   OR (status='processing' AND lease_until<now()) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 10`);
  if(r.rowCount){await c.query(`UPDATE voice_outbox SET status='processing',attempts=attempts+1,lease_until=now()+interval '2 minutes' WHERE id=ANY($1::bigint[])`,[r.rows.map(x=>x.id)]);}
  return r.rows;
 });
 for(const job of jobs){
  const data=await pool.query(`SELECT o.id,o.action,o.attempts,a.id AS assignment_id,a.user_id,a.status,n.provider_number_id,n.id AS inventory_id
   FROM voice_outbox o JOIN voice_number_assignments a ON a.id=o.assignment_id
   JOIN voice_number_inventory n ON n.id=a.inventory_id WHERE o.id=$1`,[job.id]);
  const x=data.rows[0]; if(!x)continue;
  try{
   if(x.action==='provision'){
    if(x.status!=='pending')throw new Error('INVALID_PROVISION_STATE');
    await provider.provision({operationId:`qorlla-provision-${x.assignment_id}`,providerNumberId:x.provider_number_id,userId:x.user_id});
   } else {
    if(x.status!=='release_pending')throw new Error('INVALID_RELEASE_STATE');
    await provider.release({operationId:`qorlla-release-${x.assignment_id}`,providerNumberId:x.provider_number_id});
   }
   await transaction(async c=>{
    const lock=await c.query('SELECT status FROM voice_number_assignments WHERE id=$1 FOR UPDATE',[x.assignment_id]);
    if(lock.rows[0]?.status!==x.status)throw new Error('STALE_ASSIGNMENT_STATE');
    // Provider acknowledgement is insufficient to claim PSTN activation. Await a verified event/reconciliation.
    await c.query("UPDATE voice_outbox SET status='done',lease_until=NULL WHERE id=$1",[x.id]);
    await c.query('INSERT INTO voice_audit_events(actor,subject_user_id,action,resource_id) VALUES($1,$2,$3,$4)',
     ['worker',x.user_id,`number.${x.action}.submitted`,x.assignment_id]);
   });
  }catch(e){
   const msg=e instanceof Error?e.message:'UNKNOWN';
   await pool.query(`UPDATE voice_outbox SET status=CASE WHEN attempts>=10 THEN 'dead' ELSE 'queued' END,
    next_attempt_at=now()+make_interval(secs=>LEAST(3600,POWER(2,LEAST(attempts,10))::int)),lease_until=NULL,last_error=$2 WHERE id=$1`,[x.id,msg.slice(0,250)]);
  }
 }
 return jobs.length;
}
export async function workerLoop(signal:AbortSignal){while(!signal.aborted){await runWorkerOnce();await new Promise(r=>setTimeout(r,1500));}}
