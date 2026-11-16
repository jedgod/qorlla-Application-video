export const ALLOWED_TYPES = new Set(['application/pdf','text/plain','image/png','image/jpeg','application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
export const MAX_BYTES = 25*1024*1024;
export function assertFileMetadata({filename,type,bytes}) {
 if(typeof filename!=='string'||filename.length<1||filename.length>180||/[\\/\x00-\x1f]/.test(filename)) throw new Error('invalid_filename');
 if(!ALLOWED_TYPES.has(type)) throw new Error('unsupported_type');
 if(!Number.isSafeInteger(bytes)||bytes<1||bytes>MAX_BYTES) throw new Error('invalid_size');
}
export function assertActor(actor,tenant,occ){
 if(!actor||actor.tenantId!==tenant||actor.occurrenceId!==occ||!actor.participantId||!actor.authenticated) throw new Error('unauthorized');
}
export function isHost(actor){return actor.role==='host'||actor.role==='cohost';}
export function canReadFile(actor,file){
 if(file.tenant_id!==actor.tenantId||file.occurrence_id!==actor.occurrenceId||file.state!=='clean'||!file.host_approved) return false;
 if(isHost(actor))return true;
 if(file.visibility==='host_only')return false;
 return file.visibility==='meeting'||(file.room_id===actor.roomId&&file.visibility==='room');
}
export function canUpload(actor,roomId){return isHost(actor)||actor.roomId===roomId;}
