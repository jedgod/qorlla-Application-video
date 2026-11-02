/** Must run inside a SERIALIZABLE transaction or under row-level locks for spend/concurrency reservations. */
export async function authorizeOutbound({principal,call,db,provider,flags}) {
 if(!flags?.pstn) return {allow:false,reason:'PSTN_DISABLED'};
 if(!/^\+[1-9]\d{7,14}$/.test(call?.destination??'')) return {allow:false,reason:'INVALID_DESTINATION'};
 if(!call?.idempotencyKey || !/^[a-zA-Z0-9_-]{16,128}$/.test(call.idempotencyKey)) return {allow:false,reason:'INVALID_IDEMPOTENCY_KEY'};
 const reservation=await db.transaction(async tx=>{
  const user=await tx.lockPrincipal(principal.id);
  if(!user?.verified || user.suspended || !user.recentMfa || !user.deviceTrusted || user.risk>=50 || user.risk==null) return {allow:false,reason:'IDENTITY_DENIED'};
  const number=await tx.lockActiveCallerId(call.callerId,user.id);
  if(!number?.providerConfirmed) return {allow:false,reason:'CALLER_ID_UNVERIFIED'};
  if(!await tx.destinationPermitted(user.id,call.destination))return {allow:false,reason:'DESTINATION_DENIED'};
  if(!await tx.reserveBudgetAndSlot(user.id,call.idempotencyKey,call.destination))return {allow:false,reason:'LIMIT_EXCEEDED'};
  return {allow:true,reservationId:call.idempotencyKey};
 });
 if(!reservation.allow)return reservation;
 try { const result=await provider.dial({to:call.destination,from:call.callerId,idempotencyKey:call.idempotencyKey}); return {allow:true,reservationId:reservation.reservationId,providerCallId:result.id}; }
 catch(e){await db.markDialOutcomeUncertain(reservation.reservationId);return {allow:false,reason:'PROVIDER_OUTCOME_UNCERTAIN'};}
}
