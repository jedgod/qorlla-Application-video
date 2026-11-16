import {randomUUID} from 'node:crypto';
export async function appendEvent(db,{occurrenceId,roomId=null,kind,payload}){
 const {rows:[event]}=await db.query(`INSERT INTO smartrooms_v18.events(occurrence_id,room_id,kind,payload) VALUES($1,$2,$3,$4) RETURNING id`,[occurrenceId,roomId,kind,payload]);
 await db.query(`INSERT INTO smartrooms_v18.outbox(event_id) VALUES($1)`,[event.id]);return event.id;
}
export async function leaseBatch(pool,{limit=30,leaseSeconds=30}={}){
 const token=randomUUID();
 const {rows}=await pool.query(`WITH candidate AS (
 SELECT id FROM smartrooms_v18.outbox WHERE
 ((state='pending' AND available_at<=now()) OR (state='leased' AND leased_until<now()))
 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1)
 UPDATE smartrooms_v18.outbox o SET state='leased',attempts=attempts+1,lease_token=$2,
 leased_until=now()+($3::int * interval '1 second') FROM candidate c WHERE o.id=c.id
 RETURNING o.id,o.event_id,o.attempts,o.lease_token`,[limit,token,leaseSeconds]);return rows;
}
export async function deliverBatch(pool,bus,{consumer='qorlla-meet',limit=30}={}){
 if(!bus?.publish)throw new Error('Shared bus adapter required');
 const leases=await leaseBatch(pool,{limit});let done=0;
 for(const lease of leases){
  try{
   const {rows:[event]}=await pool.query('SELECT * FROM smartrooms_v18.events WHERE id=$1',[lease.event_id]);
   // Bus consumer MUST deduplicate by event.id. Publishing twice after worker crash is possible.
   await bus.publish({id:String(event.id),occurrenceId:event.occurrence_id,roomId:event.room_id,kind:event.kind,payload:event.payload});
   const result=await pool.query(`UPDATE smartrooms_v18.outbox SET state='done',leased_until=NULL WHERE id=$1 AND lease_token=$2 AND state='leased'`,[lease.id,lease.lease_token]);done+=result.rowCount;
  }catch(error){
   await pool.query(`UPDATE smartrooms_v18.outbox SET state=CASE WHEN attempts>=12 THEN 'dead' ELSE 'pending' END,
    available_at=now()+(LEAST(300,POWER(2,LEAST(attempts,8)))::int*interval '1 second'),
    leased_until=NULL,last_error=$3 WHERE id=$1 AND lease_token=$2 AND state='leased'`,[lease.id,lease.lease_token,String(error.message).slice(0,200)]);
  }
 }
 return {leased:leases.length,delivered:done};
}
export async function consumeOnce(pool,consumer,event,handler){
 const db=await pool.connect();try{await db.query('BEGIN');
  const {rowCount}=await db.query(`INSERT INTO smartrooms_v18.delivery(event_id,consumer) VALUES($1,$2) ON CONFLICT DO NOTHING`,[event.id,consumer]);
  if(rowCount){await handler(db,event);await db.query(`UPDATE smartrooms_v18.delivery SET delivered_at=now() WHERE event_id=$1 AND consumer=$2`,[event.id,consumer]);}
  await db.query('COMMIT');return !!rowCount;
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
