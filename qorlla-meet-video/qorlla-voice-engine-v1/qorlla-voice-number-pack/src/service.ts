import {transaction,pool} from './db.js';
import {allowedCountries} from './config.js';
import {randomUUID} from 'node:crypto';
export class DomainError extends Error {constructor(public code:string,public status=409){super(code);}}
export async function ensureIdentity(userId:string){
 return transaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[userId]);
  const found=await c.query('SELECT extension FROM voice_identities WHERE user_id=$1',[userId]);
  if(found.rowCount) return found.rows[0].extension as string;
  const next=await c.query("SELECT nextval('voice_extension_seq') AS n");
  const extension=`QRL-${next.rows[0].n}`;
  await c.query('INSERT INTO voice_identities(user_id,extension) VALUES($1,$2)',[userId,extension]);
  return extension;
 });
}
export async function getMyNumber(userId:string){
 const r=await pool.query(`SELECT i.extension,a.id AS assignment_id,a.status,n.e164,n.country_code,n.capabilities
 FROM voice_identities i LEFT JOIN LATERAL (
 SELECT * FROM voice_number_assignments WHERE user_id=i.user_id AND status IN ('pending','active','suspended','release_pending') ORDER BY created_at DESC LIMIT 1
 ) a ON true LEFT JOIN voice_number_inventory n ON n.id=a.inventory_id WHERE i.user_id=$1`,[userId]);
 return r.rows[0]??null;
}
export async function assignNumber(userId:string,country:string,key:string){
 if(!allowedCountries.has(country))throw new DomainError('COUNTRY_NOT_ENABLED',422);
 return transaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[userId]);
  const existing=await c.query('SELECT id,status FROM voice_number_assignments WHERE user_id=$1 AND request_key=$2',[userId,key]);
  if(existing.rowCount)return existing.rows[0];
  const active=await c.query("SELECT id FROM voice_number_assignments WHERE user_id=$1 AND status IN ('pending','active','suspended','release_pending')",[userId]);
  if(active.rowCount)throw new DomainError('ALREADY_ASSIGNED');
  const proof=await c.query(`SELECT id FROM voice_country_evidence WHERE user_id=$1 AND country_code=$2
   AND kind IN ('verified_residency','verified_business') AND (expires_at IS NULL OR expires_at>now()) LIMIT 1`,[userId,country]);
  if(!proof.rowCount)throw new DomainError('COUNTRY_VERIFICATION_REQUIRED',403);
  const available=await c.query(`SELECT id FROM voice_number_inventory WHERE country_code=$1 AND status='available'
   ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`,[country]);
  if(!available.rowCount)throw new DomainError('NO_NUMBER_INVENTORY',409);
  const inventoryId=available.rows[0].id as string;
  await c.query("UPDATE voice_number_inventory SET status='reserved' WHERE id=$1",[inventoryId]);
  const assignmentId=randomUUID();
  await c.query(`INSERT INTO voice_number_assignments(id,user_id,inventory_id,status,request_key)
    VALUES($1,$2,$3,'pending',$4)`,[assignmentId,userId,inventoryId,key]);
  await c.query("INSERT INTO voice_outbox(assignment_id,action) VALUES($1,'provision')",[assignmentId]);
  await c.query(`INSERT INTO voice_audit_events(actor,subject_user_id,action,resource_id,details)
    VALUES($1,$2,'number.assignment.requested',$3,$4)`,[userId,userId,assignmentId,JSON.stringify({country})]);
  return {id:assignmentId,status:'pending'};
 });
}
export async function requestRelease(userId:string){
 return transaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[userId]);
  const r=await c.query(`SELECT id,status FROM voice_number_assignments WHERE user_id=$1 AND status IN ('active','suspended','release_pending') FOR UPDATE`,[userId]);
  if(!r.rowCount)throw new DomainError('NO_RELEASABLE_NUMBER',404);
  const {id,status}=r.rows[0];
  if(status!=='release_pending'){
   await c.query("UPDATE voice_number_assignments SET status='release_pending',updated_at=now() WHERE id=$1",[id]);
   await c.query("INSERT INTO voice_outbox(assignment_id,action) VALUES($1,'release') ON CONFLICT DO NOTHING",[id]);
   await c.query("INSERT INTO voice_audit_events(actor,subject_user_id,action,resource_id) VALUES($1,$2,'number.release.requested',$3)",[userId,userId,id]);
  }
  return {id,status:'release_pending'};
 });
}
