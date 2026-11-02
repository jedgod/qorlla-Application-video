import {randomUUID} from 'node:crypto';
import {pool} from './store.mjs';
import {backoff} from './reliability.mjs';
// At-least-once delivery. Consumers MUST deduplicate by durable event ID.
export class OutboxWorker{
 constructor({publish,db=pool,workerId=randomUUID(),batchSize=50,logger=console}){
 this.publish=publish;this.db=db;this.workerId=workerId;this.batchSize=batchSize;this.logger=logger;
 }
 async claim(){
 const c=await this.db.connect();try{
 await c.query('BEGIN');
 const {rows}=await c.query(`SELECT o.event_id FROM voice_outbox o
 WHERE o.delivered_at IS NULL AND o.available_at<=now()
 AND (o.locked_until IS NULL OR o.locked_until<now())
 ORDER BY o.event_id FOR UPDATE SKIP LOCKED LIMIT $1`,[this.batchSize]);
 if(rows.length)await c.query(`UPDATE voice_outbox SET locked_by=$1,locked_until=now()+interval '30 seconds'
 WHERE event_id=ANY($2::bigint[])`,[this.workerId,rows.map(r=>r.event_id)]);
 await c.query('COMMIT');return rows.map(r=>r.event_id);
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 async runOnce(){
 const ids=await this.claim();for(const id of ids){
 try{
 const {rows}=await this.db.query(`SELECT e.id,e.account_id,e.kind,e.payload FROM voice_reliable_events e
 JOIN voice_outbox o ON o.event_id=e.id WHERE e.id=$1 AND o.locked_by=$2 AND o.delivered_at IS NULL`,[id,this.workerId]);
 if(!rows[0])continue;
 const e=rows[0];await this.publish(e.account_id,{type:'reliable',eventId:Number(e.id),kind:e.kind,payload:e.payload});
 await this.db.query(`UPDATE voice_outbox SET delivered_at=now(),locked_by=NULL,locked_until=NULL
 WHERE event_id=$1 AND locked_by=$2 AND locked_until>now()`,[id,this.workerId]);
 }catch(error){
 const {rows}=await this.db.query(`SELECT attempts FROM voice_outbox WHERE event_id=$1`,[id]);
 const wait=backoff((rows[0]?.attempts??0)+1);
 await this.db.query(`UPDATE voice_outbox SET attempts=attempts+1,available_at=now()+($3::int*interval '1 millisecond'),
 locked_by=NULL,locked_until=NULL,last_error=left($4,250)
 WHERE event_id=$1 AND locked_by=$2`,[id,this.workerId,wait,String(error.message||error)]);
 this.logger.error('voice_outbox_publish_failed',String(error.message||error));
 }
 }return ids.length;
 }
}
