import pg from 'pg';import {createClient} from 'redis';import {randomUUID} from 'node:crypto';
import {claimBatch,markPublished,markRetry} from './events.mjs';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const redis=createClient({url:process.env.REDIS_URL});
redis.on('error',e=>console.error('Redis error',e.message));await redis.connect();
const workerId=randomUUID();
while(true){
 const events=await claimBatch(pool,workerId);
 for(const e of events){
  try{
   await redis.xAdd('qorlla:meet:events','*',{eventId:String(e.event_id),occurrenceId:e.occurrence_id,
    roomId:e.room_id??'',kind:e.kind,payload:JSON.stringify(e.payload)},{TRIM:{strategy:'MAXLEN',strategyModifier:'~',threshold:100000}});
   await markPublished(pool,e.event_id,workerId);
  }catch(err){console.error('Event publish failed',err.message);await markRetry(pool,e.event_id,workerId)}
 }
 await new Promise(r=>setTimeout(r,events.length?100:1000));
}
