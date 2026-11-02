import {OutboxWorker} from './outbox-worker.mjs';
import {pool} from './store.mjs';
export function startOutbox({publish,db=pool,intervalMs=250,logger=console}) {
 if(!Number.isInteger(intervalMs)||intervalMs<100)throw Error('invalid_interval');
 const worker=new OutboxWorker({publish,db,logger});let stopped=false,running=false;
 const timer=setInterval(async()=>{
  if(stopped||running)return;running=true;
  try {await worker.runOnce();}catch(e){logger.error('outbox_tick_failed',e.message)}
  finally{running=false}
 },intervalMs);
 timer.unref?.();return async()=>{stopped=true;clearInterval(timer);while(running)await new Promise(r=>setTimeout(r,25));};
}
export async function checkDatabase(db=pool){await db.query('SELECT 1');return true;}
export async function outboxLag(db=pool){
 const {rows}=await db.query(`SELECT count(*)::int AS pending,
 COALESCE(extract(epoch from (now()-min(available_at))),0)::int AS oldest_seconds
 FROM voice_outbox WHERE delivered_at IS NULL`);
 return rows[0];
}
