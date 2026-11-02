import { createClient } from 'redis';
import { makeDb } from './db.js';
// Redis Pub/Sub is notification only. PostgreSQL outbox is durable source of truth.
// Subscribers MUST recheck tenant/account/call state in PostgreSQL before acting.
const db=makeDb(process.env.DATABASE_URL);
if(!process.env.REDIS_URL) throw new Error('REDIS_URL required');
const redis=createClient({url:process.env.REDIS_URL,socket:{reconnectStrategy:retries=>Math.min(retries*100,2000)}});
redis.on('error',err=>console.error('redis',err.message));
await redis.connect();
let running=true;
process.on('SIGTERM',()=>{running=false;});
while(running){
  let rows=[];
  try {
    rows=await db.withTransaction(async tx=>{
      const items=await tx.query("SELECT event_id,event_type,payload FROM voice_outbox WHERE delivered_at IS NULL AND (locked_until IS NULL OR locked_until < now()) ORDER BY created_at LIMIT 30 FOR UPDATE SKIP LOCKED");
      for(const e of items) await tx.exec("UPDATE voice_outbox SET locked_until=now()+interval '30 seconds',attempts=attempts+1 WHERE event_id=$1",[e.event_id]);
      return items;
    });
    for(const e of rows){
      try {
        const tenant=e.payload.tenantId;
        if(typeof tenant!=='string') throw new Error('Missing tenant');
        await redis.publish(`qorlla:voice:${tenant}`,JSON.stringify({id:e.event_id,type:e.event_type,payload:e.payload}));
        await db.withTransaction(tx=>tx.exec('UPDATE voice_outbox SET delivered_at=now(),locked_until=NULL WHERE event_id=$1',[e.event_id]));
      } catch(err) {console.error('outbox delivery failure',e.event_id,err.message);}
    }
  } catch(err) {console.error('worker failure',err.message);}
  await new Promise(resolve=>setTimeout(resolve,500));
}
await redis.quit();await db.pool.end();
