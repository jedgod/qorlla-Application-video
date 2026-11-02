import { randomUUID } from 'node:crypto';
import { requirePrincipal } from './policy.js';
const fail=(code,statusCode=403)=>{throw Object.assign(new Error(code),{statusCode});};
export class RoomService {
  constructor(db){this.db=db;}
  async create(p){requirePrincipal(p);return this.db.withTransaction(async tx=>{
    const roomId=randomUUID();
    await tx.exec('INSERT INTO voice_rooms(room_id,tenant_id,created_by) VALUES($1,$2,$3)',[roomId,p.tenantId,p.accountId]);
    await tx.exec('INSERT INTO voice_room_members(room_id,tenant_id,account_id) VALUES($1,$2,$3)',[roomId,p.tenantId,p.accountId]);
    return {roomId};
  });}
  async join(p,roomId){requirePrincipal(p);return this.db.withTransaction(async tx=>{
    const room=await tx.one('SELECT room_id,disabled FROM voice_rooms WHERE room_id=$1 AND tenant_id=$2 FOR UPDATE',[roomId,p.tenantId]);
    if(!room||room.disabled)fail('ROOM_NOT_FOUND',404);
    const member=await tx.one('SELECT account_id FROM voice_room_members WHERE room_id=$1 AND tenant_id=$2 AND account_id=$3',[roomId,p.tenantId,p.accountId]);
    if(!member)fail('ROOM_MEMBERSHIP_REQUIRED');
    const eligible=await tx.one('SELECT verified,suspended FROM voice_principals WHERE account_id=$1 AND tenant_id=$2 FOR UPDATE',[p.accountId,p.tenantId]);
    if(!eligible?.verified||eligible.suspended)fail('VOICE_FORBIDDEN');
    return {roomId,joined:true};
  });}
  async disable(p,roomId){requirePrincipal(p);return this.db.withTransaction(async tx=>{
    const room=await tx.one('SELECT created_by FROM voice_rooms WHERE room_id=$1 AND tenant_id=$2 FOR UPDATE',[roomId,p.tenantId]);
    if(!room)fail('ROOM_NOT_FOUND',404);
    if(room.created_by!==p.accountId&&!p.scopes?.includes('voice.room.disable'))fail('ROOM_FORBIDDEN');
    await tx.exec('UPDATE voice_rooms SET disabled=true WHERE room_id=$1 AND tenant_id=$2',[roomId,p.tenantId]);
    await tx.event('voice.room.disabled',{roomId,tenantId:p.tenantId});
    return {roomId,disabled:true,mediaTermination:'not_confirmed'};
  });}
}
