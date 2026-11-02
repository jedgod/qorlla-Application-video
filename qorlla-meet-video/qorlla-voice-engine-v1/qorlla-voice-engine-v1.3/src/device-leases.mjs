import {randomUUID} from 'node:crypto';
import {pool} from './store.mjs';
export function validDeviceId(id){return typeof id==='string' && /^[0-9a-f-]{36}$/i.test(id) && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);}
/** Atomic ownership claim; a call participant has exactly one current media device. */
export async function claimDevice(callId,account,deviceId,db=pool){
 if(!validDeviceId(deviceId))throw Error('invalid_device');
 const c=await db.connect();try{
  await c.query('BEGIN');
  const {rows}=await c.query('SELECT id,caller_id,callee_id,status FROM voice_calls WHERE id=$1 FOR UPDATE',[callId]);
  const call=rows[0];if(!call||![call.caller_id,call.callee_id].includes(account))throw Error('not_found');
  if(!['ringing','active'].includes(call.status))throw Error('call_not_active');
  const token=randomUUID();
  const q=await c.query(`INSERT INTO voice_media_leases(call_id,account_id,device_id,lease_token,expires_at)
   VALUES($1,$2,$3,$4,now()+interval '90 seconds')
   ON CONFLICT(call_id,account_id) DO UPDATE SET device_id=EXCLUDED.device_id,lease_token=EXCLUDED.lease_token,expires_at=EXCLUDED.expires_at
   RETURNING call_id,account_id,device_id,lease_token,expires_at`,[callId,account,deviceId,token]);
  await c.query('COMMIT');return q.rows[0];
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function refreshDevice(callId,account,deviceId,token,db=pool){
 const {rows}=await db.query(`UPDATE voice_media_leases SET expires_at=now()+interval '90 seconds'
 WHERE call_id=$1 AND account_id=$2 AND device_id=$3 AND lease_token=$4 AND expires_at>now()
 RETURNING call_id,account_id,device_id,expires_at`,[callId,account,deviceId,token]);
 return rows[0]||null;
}
export async function getLease(callId,account,db=pool){
 const {rows}=await db.query('SELECT * FROM voice_media_leases WHERE call_id=$1 AND account_id=$2',[callId,account]);return rows[0]||null;
}
