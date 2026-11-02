export function ownsGeneration(lease,{deviceId,generation}){
 return !!lease&&lease.device_id===deviceId&&Number(lease.generation)===generation&&new Date(lease.expires_at).getTime()>Date.now();
}
