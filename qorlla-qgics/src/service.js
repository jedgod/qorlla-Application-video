import {randomUUID} from 'node:crypto';
import {COUNTRY_CODES,issueNumber,normalizeEmail,normalizeNumber} from './countries.js';
const q=(db,sql)=>db.driver==='postgres'?sql.replaceAll(/\b(users|numbers|number_counters|extensions|calls|audit)\b/g,'qgics.$1'):sql;
function assert(condition,code){if(!condition)throw new Error(code)}
export function createService(db,{onCallEvent=async()=>{}}={}){
 const pg=db.driver==='postgres';
 let lock=Promise.resolve();
 async function query(sql,args=[],client=null){
  if(pg){let i=0;const converted=q(db,sql).replace(/\?/g,()=>'$'+(++i));return (await (client||db.raw).query(converted,args)).rows;}
  const stmt=db.raw.prepare(sql);return (/^\s*SELECT/i.test(sql)||/\bRETURNING\b/i.test(sql))?stmt.all(...args):stmt.run(...args);
 }
 async function transaction(fn){
  // SQLite has ONE connection: transactions must not interleave across awaits, so they run strictly one after another.
  if(!pg){const run=lock.then(async()=>{db.raw.exec('BEGIN IMMEDIATE');try{const out=await fn(null);db.raw.exec('COMMIT');return out;}catch(e){db.raw.exec('ROLLBACK');throw e;}});lock=run.catch(()=>{});return run;}
  const client=await db.raw.connect();try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }
 async function user(id,client){return (await query('SELECT * FROM users WHERE id=?',[id],client))[0]}
 async function audit(actor,action,subject,client){await query('INSERT INTO audit(actor_id,action,subject_id) VALUES(?,?,?)',[actor,action,subject],client)}
 async function provision({id,tenantId,email,emailVerified,displayName,countryIso}){
  assert(id&&tenantId&&displayName&&emailVerified===true,'invalid_verified_user');
  const country=String(countryIso||'').toUpperCase();assert(COUNTRY_CODES[country],'unsupported_country');
  const normalized=normalizeEmail(email);
  return transaction(async client=>{
   // Insert-or-ignore (any unique clash: same id, or the email already belongs to another account), then lock our own row; a missing row means the email is taken: simultaneous registrations of the same account queue up behind each other instead of colliding.
   await query('INSERT INTO users(id,tenant_id,email,email_verified,display_name) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',[id,tenantId,normalized,pg?true:1,displayName],client);
   const existing=(await query('SELECT * FROM users WHERE id=?'+(pg?' FOR UPDATE':''),[id],client))[0];
   assert(existing&&existing.tenant_id===tenantId&&existing.email===normalized,'identity_conflict');
   const current=(await query('SELECT * FROM numbers WHERE user_id=?',[id],client))[0];
   if(current)return {userId:id,number:current.issued_number,countryIso:current.country_iso,existing:true};
   await query('INSERT INTO number_counters(country_iso,next_serial) VALUES(?,?) ON CONFLICT(country_iso) DO NOTHING',[country,1],client);
   // UPDATE ... RETURNING atomically reserves the next serial on both databases.
   const rows=await query('UPDATE number_counters SET next_serial=next_serial+1 WHERE country_iso=? RETURNING next_serial',[country],client);
   const serial=Number(rows[0].next_serial)-1;
   const number=issueNumber(country,serial);
   await query('INSERT INTO numbers(user_id,country_iso,country_code,serial,issued_number) VALUES(?,?,?,?,?)',[id,country,COUNTRY_CODES[country],serial,number],client);
   await audit(id,'number.allocated',id,client);
   return {userId:id,number,countryIso:country,existing:false};
  });
 }
 async function myNumber(actor){const u=await user(actor.userId);assert(u&&u.status==='active','forbidden');return (await query('SELECT issued_number,country_iso,assigned_at FROM numbers WHERE user_id=?',[actor.userId]))[0]||null}
 async function resolve(actor,{email,number,extension,name}){
  const keys=[email,number,extension,name].filter(v=>typeof v==='string'&&v.trim());assert(keys.length===1,'one_lookup_required');
  const me=await user(actor.userId);assert(me&&me.status==='active'&&me.tenant_id===actor.tenantId,'forbidden');
  let rows=[];
  if(email){rows=await query('SELECT * FROM users WHERE email=? AND status=? AND email_verified=?',[normalizeEmail(email),'active',pg?true:1]);}
  if(number){rows=await query('SELECT u.* FROM users u JOIN numbers n ON n.user_id=u.id WHERE n.issued_number=? AND u.status=?',[normalizeNumber(number),'active']);}
  if(extension){assert(/^\d{2,12}$/.test(extension),'invalid_extension');rows=await query('SELECT u.* FROM users u JOIN extensions e ON e.user_id=u.id WHERE e.tenant_id=? AND e.extension=? AND u.status=?',[actor.tenantId,extension,'active']);}
  if(name){assert(name.trim().length>=3,'name_too_short');rows=await query('SELECT * FROM users WHERE tenant_id=? AND lower(display_name) LIKE ? AND status=? LIMIT 10',[actor.tenantId,'%'+name.trim().toLowerCase().replace(/[%_]/g,'')+'%','active']);}
  // Cross-tenant discovery is not enabled by default. Consent/contacts policy must be integrated first.
  return rows.filter(u=>u.tenant_id===actor.tenantId).map(u=>({id:u.id,displayName:u.display_name}));
 }
 async function initiate(actor,{recipientId,mediaType='audio'}){
  assert(['audio','video'].includes(mediaType),'invalid_media_type');
  const caller=await user(actor.userId),callee=await user(recipientId);
  assert(caller&&callee&&caller.status==='active'&&callee.status==='active'&&caller.tenant_id===actor.tenantId&&callee.tenant_id===actor.tenantId,'forbidden');
  assert(caller.id!==callee.id,'self_call');
  const callId=randomUUID();
  await query('INSERT INTO calls(id,tenant_id,caller_id,callee_id,media_type,status) VALUES(?,?,?,?,?,?)',[callId,actor.tenantId,actor.userId,recipientId,mediaType,'ringing']);
  await audit(actor.userId,'call.initiated',recipientId);
  // Adapter must implement authenticated durable delivery in Qorlla Voice/Meet; this is only the signalling hook.
  try{await onCallEvent({type:'call.ringing',callId,callerId:actor.userId,calleeId:recipientId,mediaType});}
  catch{await query('UPDATE calls SET status=? WHERE id=?',['ended',callId]);throw new Error('signalling_unavailable');}
  return {callId,status:'ringing',mediaType};
 }
 async function transition(actor,callId,action){
  const statuses={answer:'accepted',reject:'rejected',end:'ended'};
  assert(statuses[action],'invalid_action');
  const call=(await query('SELECT * FROM calls WHERE id=?',[callId]))[0];
  assert(call&&call.tenant_id===actor.tenantId,'not_found');
  const isCaller=call.caller_id===actor.userId,isCallee=call.callee_id===actor.userId;
  assert(isCaller||isCallee,'forbidden');
  assert(action==='end'?['ringing','accepted'].includes(call.status):call.status==='ringing'&&isCallee,'invalid_transition');
  const updated=await query('UPDATE calls SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=? RETURNING id',[statuses[action],callId,call.status]);
  if(updated.length!==1)throw new Error('concurrent_transition');
  await audit(actor.userId,'call.'+action,call.callee_id);
  await onCallEvent({type:'call.'+action,callId,actorId:actor.userId});
  return {callId,status:statuses[action]};
 }
 async function history(actor){const me=await user(actor.userId);assert(me&&me.tenant_id===actor.tenantId,'forbidden');return query('SELECT id,caller_id,callee_id,media_type,status,created_at FROM calls WHERE tenant_id=? AND (caller_id=? OR callee_id=?) ORDER BY created_at DESC LIMIT 100',[actor.tenantId,actor.userId,actor.userId]);}
 return {provision,myNumber,resolve,initiate,transition,history};
}
