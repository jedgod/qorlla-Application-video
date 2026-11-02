import pg from 'pg';
import {newId,allowedTransition} from './core.mjs';
export const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:10,ssl:process.env.PG_SSL==='true'?{rejectUnauthorized:true}:undefined});
export async function identity(account){const {rows}=await pool.query('SELECT account_id,extension,enabled FROM voice_identities WHERE account_id=$1',[account]);return rows[0]||null;}
export async function createCall(caller,extension,key){
 const c=await pool.connect();try{
  await c.query('BEGIN');
  // Serialize per caller and recipient to avoid concurrent duplicate live calls.
  const {rows:targets}=await c.query('SELECT account_id FROM voice_identities WHERE extension=$1 AND enabled=true',[extension]);
  const callee=targets[0]?.account_id;
  if(!callee||callee===caller) throw new Error('invalid_recipient');
  const ids=[caller,callee].sort();for(const id of ids) await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[id]);
  const old=await c.query('SELECT call_id FROM voice_idempotency WHERE account_id=$1 AND request_key=$2',[caller,key]);
  if(old.rows[0]) {const call=await c.query('SELECT * FROM voice_calls WHERE id=$1',[old.rows[0].call_id]);await c.query('COMMIT');return {call:call.rows[0],reused:true};}
  const permitted=await c.query('SELECT enabled FROM voice_identities WHERE account_id=$1',[caller]);
  if(!permitted.rows[0]?.enabled) throw new Error('caller_disabled');
  const blocked=await c.query('SELECT 1 FROM voice_blocks WHERE (owner_id=$1 AND blocked_id=$2) OR (owner_id=$2 AND blocked_id=$1)',[caller,callee]);
  if(blocked.rowCount) throw new Error('blocked');
  const busy=await c.query("SELECT 1 FROM voice_calls WHERE status IN ('ringing','active') AND (caller_id=ANY($1::text[]) OR callee_id=ANY($1::text[])) LIMIT 1",[ids]);
  if(busy.rowCount) throw new Error('busy');
  const id=newId();
  const inserted=await c.query("INSERT INTO voice_calls(id,caller_id,callee_id,status) VALUES($1,$2,$3,'ringing') RETURNING *",[id,caller,callee]);
  await c.query('INSERT INTO voice_idempotency(account_id,request_key,call_id) VALUES($1,$2,$3)',[caller,key,id]);
  await c.query('INSERT INTO voice_call_events(call_id,actor_id,kind) VALUES($1,$2,$3)',[id,caller,'created']);
  await c.query('COMMIT');return {call:inserted.rows[0],reused:false};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function getCall(id){const r=await pool.query('SELECT * FROM voice_calls WHERE id=$1',[id]);return r.rows[0]||null;}
export async function transition(id,actor,to){
 const c=await pool.connect();try{
  await c.query('BEGIN');const r=await c.query('SELECT * FROM voice_calls WHERE id=$1 FOR UPDATE',[id]);const call=r.rows[0];
  if(!call||![call.caller_id,call.callee_id].includes(actor)) throw new Error('not_found');
  if(!allowedTransition(call.status,to)) throw new Error('invalid_transition');
  if(to==='active'&&actor!==call.callee_id) throw new Error('forbidden');
  if(to==='rejected'&&actor!==call.callee_id) throw new Error('forbidden');
  const next=await c.query(`UPDATE voice_calls SET status=$2,version=version+1,answered_at=CASE WHEN $2='active' THEN now() ELSE answered_at END,ended_at=CASE WHEN $2 IN ('ended','failed','rejected','missed') THEN now() ELSE ended_at END WHERE id=$1 RETURNING *`,[id,to]);
  await c.query('INSERT INTO voice_call_events(call_id,actor_id,kind) VALUES($1,$2,$3)',[id,actor,to]);
  await c.query('COMMIT');return next.rows[0];
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
