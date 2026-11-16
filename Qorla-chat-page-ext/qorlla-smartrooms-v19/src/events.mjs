export async function appendEvent(db,{occurrenceId,roomId=null,kind,payload}){
 const r=await db.query(`INSERT INTO smartrooms_v19.events(occurrence_id,room_id,kind,payload)
 VALUES($1,$2,$3,$4) RETURNING id`,[occurrenceId,roomId,kind,payload]);
 await db.query('INSERT INTO smartrooms_v19.outbox(event_id) VALUES($1)',[r.rows[0].id]);
 return r.rows[0].id;
}
export async function claimBatch(pool,workerId,limit=50){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const r=await db.query(`SELECT o.event_id,e.occurrence_id,e.room_id,e.kind,e.payload
 FROM smartrooms_v19.outbox o JOIN smartrooms_v19.events e ON e.id=o.event_id
 WHERE o.state='pending' AND o.next_attempt<=now() AND (o.leased_until IS NULL OR o.leased_until<now())
 ORDER BY o.event_id FOR UPDATE OF o SKIP LOCKED LIMIT $1`,[limit]);
  for(const x of r.rows)await db.query(`UPDATE smartrooms_v19.outbox SET lease_owner=$2,leased_until=now()+interval '30 seconds',attempts=attempts+1 WHERE event_id=$1`,[x.event_id,workerId]);
  await db.query('COMMIT');return r.rows;
 }catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}
}
export async function markPublished(pool,id,workerId){
 await pool.query(`UPDATE smartrooms_v19.outbox SET state='published',published_at=now(),lease_owner=NULL,leased_until=NULL
 WHERE event_id=$1 AND lease_owner=$2`,[id,workerId]);
}
export async function markRetry(pool,id,workerId){
 await pool.query(`UPDATE smartrooms_v19.outbox SET state=CASE WHEN attempts>=15 THEN 'dead' ELSE 'pending' END,
 next_attempt=now()+make_interval(secs=>LEAST(300,POWER(2,LEAST(attempts,8))::integer)),lease_owner=NULL,leased_until=NULL
 WHERE event_id=$1 AND lease_owner=$2`,[id,workerId]);
}
export async function consumeOnce(pool,consumer,eventId,handler){
 const db=await pool.connect();try{
  await db.query('BEGIN');
  const inserted=await db.query(`INSERT INTO smartrooms_v19.inbox(consumer,event_id) VALUES($1,$2)
 ON CONFLICT DO NOTHING RETURNING event_id`,[consumer,eventId]);
  if(inserted.rowCount)await handler(db);
  await db.query('COMMIT');return Boolean(inserted.rowCount);
 }catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}
}
