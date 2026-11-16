import {uuid,cleanRichText,transaction} from './core.mjs';
export async function sendMessage(pool,{cid,actor,body,replyTo=null,nonce}){
 const html=cleanRichText(body);if(!/^[0-9a-f-]{36}$/i.test(nonce||''))throw Object.assign(Error('Idempotency UUID required'),{status:400});
 return transaction(pool,async c=>{
  const existing=await c.query('SELECT * FROM qorlla_chat.messages WHERE conversation_id=$1 AND author_id=$2 AND client_nonce=$3',[cid,actor,nonce]);if(existing.rowCount)return existing.rows[0];
  if(replyTo){const ref=await c.query('SELECT id FROM qorlla_chat.messages WHERE id=$1 AND conversation_id=$2 AND deleted_at IS NULL',[replyTo,cid]);if(!ref.rowCount)throw Object.assign(Error('Invalid reply target'),{status:400})}
  await c.query('INSERT INTO qorlla_chat.counters(conversation_id) VALUES($1) ON CONFLICT DO NOTHING',[cid]);
  const counter=await c.query('UPDATE qorlla_chat.counters SET last_seq=last_seq+1 WHERE conversation_id=$1 RETURNING last_seq',[cid]);
  const id=uuid(),seq=counter.rows[0].last_seq;
  const {rows}=await c.query('INSERT INTO qorlla_chat.messages(id,conversation_id,author_id,body_html,reply_to,client_nonce,seq) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[id,cid,actor,html,replyTo,nonce,seq]);
  await c.query('INSERT INTO qorlla_chat.outbox(conversation_id,seq,event_type,payload) VALUES($1,$2,$3,$4)',[cid,seq,'message.created',JSON.stringify({message:rows[0]})]);
  await c.query('INSERT INTO qorlla_chat.audit(actor_id,action,subject_id) VALUES($1,$2,$3)',[actor,'message.created',id]);return rows[0];
 });
}
export async function editMessage(pool,{mid,actor,body}){const html=cleanRichText(body);return transaction(pool,async c=>{
 const r=await c.query('SELECT * FROM qorlla_chat.messages WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[mid]);if(!r.rowCount)throw Object.assign(Error('Not found'),{status:404});const m=r.rows[0];if(m.author_id!==actor)throw Object.assign(Error('Forbidden'),{status:403});
 const rev=await c.query('SELECT coalesce(max(revision),0)+1 AS revision FROM qorlla_chat.message_versions WHERE message_id=$1',[mid]);
 await c.query('INSERT INTO qorlla_chat.message_versions(message_id,revision,body_html,editor_id) VALUES($1,$2,$3,$4)',[mid,rev.rows[0].revision,m.body_html,actor]);
 const u=await c.query('UPDATE qorlla_chat.messages SET body_html=$1,edited_at=now() WHERE id=$2 RETURNING *',[html,mid]);
 await c.query('INSERT INTO qorlla_chat.outbox(conversation_id,seq,event_type,payload) VALUES($1,$2,$3,$4)',[m.conversation_id,m.seq,'message.updated',JSON.stringify({message:u.rows[0]})]);
 await c.query('INSERT INTO qorlla_chat.audit(actor_id,action,subject_id) VALUES($1,$2,$3)',[actor,'message.edited',mid]);return u.rows[0];
})}
export async function markRead(pool,{cid,actor,seq}){if(!Number.isSafeInteger(seq)||seq<0)throw Object.assign(Error('Bad sequence'),{status:400});const r=await pool.query('INSERT INTO qorlla_chat.receipts(conversation_id,user_id,last_read_seq) VALUES($1,$2,$3) ON CONFLICT(conversation_id,user_id) DO UPDATE SET last_read_seq=greatest(qorlla_chat.receipts.last_read_seq,EXCLUDED.last_read_seq),updated_at=now() RETURNING *',[cid,actor,seq]);return r.rows[0]}
export async function softDelete(pool,{mid,actor}){return transaction(pool,async c=>{const r=await c.query('SELECT * FROM qorlla_chat.messages WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[mid]);if(!r.rowCount)throw Object.assign(Error('Not found'),{status:404});const m=r.rows[0];if(m.author_id!==actor)throw Object.assign(Error('Forbidden'),{status:403});await c.query('UPDATE qorlla_chat.messages SET deleted_at=now(),body_html=$2 WHERE id=$1',[mid,'']);await c.query('INSERT INTO qorlla_chat.outbox(conversation_id,seq,event_type,payload) VALUES($1,$2,$3,$4)',[m.conversation_id,m.seq,'message.deleted',JSON.stringify({id:mid})]);await c.query('INSERT INTO qorlla_chat.audit(actor_id,action,subject_id) VALUES($1,$2,$3)',[actor,'message.deleted',mid]);return {ok:true}})}
