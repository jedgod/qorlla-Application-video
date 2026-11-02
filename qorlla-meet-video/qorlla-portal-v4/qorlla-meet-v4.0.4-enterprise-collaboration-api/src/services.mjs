import {Pool} from 'pg';
import {S3Client,PutObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
export const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==='true'?{rejectUnauthorized:true}:undefined});
export const s3=new S3Client({region:process.env.S3_REGION||'us-east-1',endpoint:process.env.S3_ENDPOINT||undefined,forcePathStyle:process.env.S3_PATH_STYLE==='true'});
export async function presignPut(key,type){return getSignedUrl(s3,new PutObjectCommand({Bucket:process.env.S3_BUCKET,Key:key,ContentType:type}),{expiresIn:300});}
export async function presignGet(key){return getSignedUrl(s3,new GetObjectCommand({Bucket:process.env.S3_BUCKET,Key:key}),{expiresIn:120});}
export async function audit(db,id,sub,type,details={}){await db.query('INSERT INTO meet_collab_audit(meeting_id,actor_sub,event_type,details) VALUES($1,$2,$3,$4)',[id,sub,type,JSON.stringify(details)]);}
export async function member(db,id,sub){const r=await db.query('SELECT role FROM meet_collab_members WHERE meeting_id=$1 AND sub=$2 AND removed_at IS NULL',[id,sub]);return r.rows[0]?.role;}
export async function allConsent(db,id,scope){const r=await db.query(`SELECT EXISTS(SELECT 1 FROM meet_collab_members m LEFT JOIN meet_collab_consents c ON c.meeting_id=m.meeting_id AND c.sub=m.sub AND c.scope=$2 WHERE m.meeting_id=$1 AND m.removed_at IS NULL AND m.joined_at IS NOT NULL AND (c.granted IS DISTINCT FROM true)) AS missing`,[id,scope]);const count=await db.query("SELECT count(*)::int AS n FROM meet_collab_members WHERE meeting_id=$1 AND removed_at IS NULL AND joined_at IS NOT NULL",[id]);return count.rows[0].n>0&&!r.rows[0].missing;}
export async function tx(fn){const c=await pool.connect();try{await c.query('BEGIN');const v=await fn(c);await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
export const validId=s=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s||'');
