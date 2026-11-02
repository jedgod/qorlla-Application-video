import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {SignJWT} from 'jose';

export type GuestRequest={meetingId:string;passcode:string;displayName:string;clientKey:string};
export type GuestResult={status:'DENIED'|'WAITING'|'ADMITTED';reason:string;admissionId?:string;token?:string};
const hash=(s:string)=>createHash('sha256').update(s).digest();
const safeEqual=(a:Buffer,b:Buffer)=>a.length===b.length&&timingSafeEqual(a,b);
// Never log passcodes, clientKey, or meeting-scoped bearer tokens.
export async function requestGuestAdmission(pool:Pool,req:GuestRequest):Promise<GuestResult>{
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  // Use a random clientKey assigned by trusted edge middleware; never raw IP as a unique identity.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[req.clientKey]);
  const attempts=await client.query(`INSERT INTO shield.guest_attempts(client_key,window_start,attempts)
   VALUES($1,date_trunc('minute',now()),1)
   ON CONFLICT(client_key,window_start) DO UPDATE SET attempts=shield.guest_attempts.attempts+1
   WHERE shield.guest_attempts.attempts<5 RETURNING attempts`,[req.clientKey]);
  if(!attempts.rowCount){await client.query('COMMIT');return {status:'DENIED',reason:'RATE_LIMIT'};}
  const found=await client.query(`SELECT meeting_id,passcode_salt,passcode_digest,guest_enabled,requires_lobby,ends_at
    FROM shield.meeting_guest_config WHERE meeting_id=$1 FOR SHARE`,[req.meetingId]);
  const row=found.rows[0];
  // Compare a dummy hash even for nonexistent meetings to reduce enumeration timing.
  const actual=hash((row?.passcode_salt??'dummy')+req.passcode);
  const expected=row?.passcode_digest??hash('dummy-passcode');
  const valid=safeEqual(actual,expected)&&row?.guest_enabled&&new Date(row.ends_at)>new Date();
  if(!valid){await client.query('COMMIT');return {status:'DENIED',reason:'INVALID_MEETING_OR_PASSCODE'};}
  const id=randomUUID();
  await client.query(`INSERT INTO shield.guest_admissions(id,meeting_id,display_name,state,expires_at)
    VALUES($1,$2,$3,$4,least($5,now()+interval '15 minutes'))`,
    [id,req.meetingId,req.displayName,'WAITING',row.ends_at]);
  await client.query('COMMIT');
  return {status:'WAITING',reason:'HOST_APPROVAL_REQUIRED',admissionId:id};
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}

// Only a trusted meeting service should invoke this after checking host approval.
// Token audience is *only* the meeting media gateway, never the general Qorlla API.
export async function approveGuest(pool:Pool,admissionId:string,meetingId:string,signingKey:Uint8Array,issuer:string){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const r=await client.query(`UPDATE shield.guest_admissions SET state='ADMITTED',approved_at=now()
    WHERE id=$1 AND meeting_id=$2 AND state='WAITING' AND expires_at>now()
    RETURNING id,meeting_id`,[admissionId,meetingId]);
  if(!r.rowCount){await client.query('ROLLBACK');return null;}
  await client.query('COMMIT');
  const token=await new SignJWT({account_type:'guest',meeting_id:meetingId,admission_id:admissionId,
    capabilities:['meeting.media.join']}).setProtectedHeader({alg:'HS256'})
    .setIssuer(issuer).setAudience('qorlla-meeting-media').setSubject('guest:'+admissionId)
    .setJti(randomUUID()).setIssuedAt().setExpirationTime('2m').sign(signingKey);
  return {token,expiresInSeconds:120};
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
