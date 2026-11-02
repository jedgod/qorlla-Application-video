/** Read-only projection of Numbers & Plans authority; never purchases/releases numbers. */
export async function applyNumberEvent({event,verify,db}) {
 if(!await verify(event))return {accepted:false,reason:'SIGNATURE_INVALID'};
 if(!event?.id || !event.providerSid || !event.authorityVersion || !['assigned','active','suspended','released'].includes(event.state))return {accepted:false,reason:'INVALID_EVENT'};
 return db.transaction(async tx=>{
  if(!await tx.insertEventOnce(event.id,event))return {accepted:true,duplicate:true};
  const current=await tx.lockNumberByProviderSid(event.providerSid);
  if(current && BigInt(event.authorityVersion)<=BigInt(current.authorityVersion))return {accepted:true,stale:true};
  if(event.state!=='released' && (!event.accountId || !event.e164))throw new Error('MISSING_OWNER');
  await tx.upsertProjection(event);
  return {accepted:true,updated:true};
 });
}
