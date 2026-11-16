import {randomUUID} from 'node:crypto';
import {assertFileMetadata,assertActor,isHost,canReadFile,canUpload} from './policy.mjs';
const fail=(s)=>{throw new Error(s)};
export function fileService({pool,storage,authority,scanner,retentionDays=30}){
 if(!pool||!storage||!authority||!scanner)throw new Error('missing_dependency');
 async function actorFor(token,occ){const actor=await authority.verify(token,occ);assertActor(actor,actor?.tenantId,occ);return actor;}
 return {
  async create(token,occ,input){
   const a=await actorFor(token,occ);assertFileMetadata(input);
   if(!canUpload(a,input.roomId??null))fail('forbidden_room');
   if(!['room','meeting','host_only'].includes(input.visibility||'room'))fail('invalid_visibility');
   if(input.visibility==='meeting'&&!isHost(a))fail('host_required');
   const id=randomUUID(),key=`${a.tenantId}/${occ}/${id}`;
   await pool.query(`INSERT INTO meet_collab.files(id,tenant_id,occurrence_id,room_id,uploader_id,filename,declared_type,bytes,object_key,visibility,host_approved,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()+($12::int * interval '1 day'))`,[id,a.tenantId,occ,input.roomId??null,a.participantId,input.filename,input.type,input.bytes,key,input.visibility||'room',isHost(a),retentionDays]);
   return {id,uploadUrl:await storage.uploadUrl(key,input.type,input.bytes),expiresInSeconds:120};
  },
  async finalize(token,occ,id){
   const a=await actorFor(token,occ);const c=await pool.connect();let file;
   try{await c.query('BEGIN');const r=await c.query(`SELECT * FROM meet_collab.files WHERE id=$1 AND tenant_id=$2 AND occurrence_id=$3 FOR UPDATE`,[id,a.tenantId,occ]);file=r.rows[0];
    if(!file||file.uploader_id!==a.participantId||file.state!=='pending')fail('invalid_upload');
    const head=await storage.head(file.object_key);if(Number(head.ContentLength)!==Number(file.bytes)||head.ContentType!==file.declared_type)fail('upload_mismatch');
    await c.query(`UPDATE meet_collab.files SET state='scanning',version=version+1 WHERE id=$1`,[id]);await c.query('COMMIT');
   }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
   // Scanner reads the object, verifies actual content type, hashes it and returns clean/rejected.
   // Errors fail closed; a separate retry worker can reprocess scanning rows.
   let scan;try{scan=await scanner.inspect(await storage.read(file.object_key),file.declared_type,Number(file.bytes));}catch{scan={clean:false,reason:'scanner_unavailable'};}
   const clean=scan.clean===true&&scan.detectedType===file.declared_type&&/^[a-f0-9]{64}$/.test(scan.sha256||'');
   await pool.query(`UPDATE meet_collab.files SET state=$2,detected_type=$3,sha256=$4,scan_engine=$5,scan_result=$6,version=version+1 WHERE id=$1 AND state='scanning'`,[id,clean?'clean':'rejected',scan.detectedType||null,scan.sha256||null,scan.engine||null,clean?'clean':(scan.reason||'rejected')]);
   if(!clean)await storage.remove(file.object_key);
   return {id,state:clean?'clean':'rejected',approved:file.host_approved};
  },
  async approve(token,occ,id,approved){const a=await actorFor(token,occ);if(!isHost(a))fail('host_required');
   const r=await pool.query(`UPDATE meet_collab.files SET host_approved=$4,version=version+1 WHERE id=$1 AND tenant_id=$2 AND occurrence_id=$3 AND state='clean' RETURNING id`,[id,a.tenantId,occ,approved===true]);if(!r.rowCount)fail('not_found');return {id,approved:approved===true};},
  async list(token,occ){const a=await actorFor(token,occ);const r=await pool.query(`SELECT id,tenant_id,occurrence_id,room_id,filename,declared_type,bytes,state,visibility,host_approved,created_at FROM meet_collab.files WHERE tenant_id=$1 AND occurrence_id=$2 AND deleted_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 200`,[a.tenantId,occ]);return r.rows.filter(f=>canReadFile(a,f));},
  async download(token,occ,id){const a=await actorFor(token,occ);const r=await pool.query(`SELECT * FROM meet_collab.files WHERE id=$1 AND tenant_id=$2 AND occurrence_id=$3 AND deleted_at IS NULL AND expires_at>now()`,[id,a.tenantId,occ]);const f=r.rows[0];if(!f||!canReadFile(a,f))fail('not_found');return {url:await storage.downloadUrl(f.object_key)};},
  async remove(token,occ,id){const a=await actorFor(token,occ);const r=await pool.query(`UPDATE meet_collab.files SET state='deleted',deleted_at=now(),version=version+1 WHERE id=$1 AND tenant_id=$2 AND occurrence_id=$3 AND state!='deleted' AND (uploader_id=$4 OR $5) RETURNING object_key`,[id,a.tenantId,occ,a.participantId,isHost(a)]);if(!r.rowCount)fail('not_found');await storage.remove(r.rows[0].object_key);return {deleted:true};}
 };
}
