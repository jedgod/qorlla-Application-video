import {VoiceError,classifyDial,requireExternalEnabled,requireEligible,requireCorridor,requireDestination,requireAuthorizedCallerId} from './policy.mjs';
// Dependency-injected into the existing engine. No independent HTTP listener or account authority.
// store.transaction(fn) supplies a transaction implementing the documented adapter contract.
export function createA38({env,store,identity,metadata,rateProvider,carrier,clock=()=>new Date()}){
 const gate=(principal)=>{requireExternalEnabled(env);requireEligible(principal);};
 const resolve=async(principal,raw)=>{
  const dial=classifyDial(raw);
  if(dial.kind==='internal')return {kind:'internal',number:dial.number};
  gate(principal);
  const account=await identity.getVerifiedCountry(principal.accountId);
  if(!account?.confirmedCountry)throw new VoiceError('country_not_confirmed');
  const dest=requireDestination(dial.number,metadata);
  const corridors=await store.getCorridors();requireCorridor(account.confirmedCountry,dest.country,corridors);
  return {kind:'external',number:dial.number,origin:account.confirmedCountry,destination:dest.country};
 };
 return {
  resolve,
  async quote(principal,raw){
   const route=await resolve(principal,raw);
   if(route.kind==='internal')return route; // existing engine handles internal calls
   const rate=await rateProvider.quote({origin:route.origin,destination:route.destination,number:route.number});
   if(!Number.isSafeInteger(rate.pricePerMinuteMinor)||rate.pricePerMinuteMinor<=0||!rate.currency||!Number.isSafeInteger(rate.connectionFeeMinor)||rate.connectionFeeMinor<0)throw new VoiceError('rate_unavailable',503);
   const expiresAt=new Date(clock().getTime()+60_000);
   const record=await store.createQuote({accountId:principal.accountId,tenantId:principal.tenantId,number:route.number,origin:route.origin,destination:route.destination,pricePerMinuteMinor:rate.pricePerMinuteMinor,connectionFeeMinor:rate.connectionFeeMinor,currency:rate.currency,expiresAt});
   return {kind:'external',quoteId:record.id,expiresAt:expiresAt.toISOString(),currency:rate.currency,pricePerMinuteMinor:rate.pricePerMinuteMinor,connectionFeeMinor:rate.connectionFeeMinor};
  },
  async confirm(principal,{quoteId,idempotencyKey,callerId=null}){
   gate(principal);
   if(!/^[a-zA-Z0-9_-]{16,100}$/.test(idempotencyKey||''))throw new VoiceError('invalid_idempotency_key',400);
   if(typeof quoteId!=='string')throw new VoiceError('invalid_quote',400);
   // The carrier must not be called inside a DB transaction. An outbox worker handles dispatch.
   return store.transaction(async tx=>{
    const prior=await tx.findRequest(principal.accountId,idempotencyKey);
    if(prior)return prior; // DB unique(account_id,idempotency_key) is authoritative
    const q=await tx.lockQuote(quoteId);
    if(!q||q.accountId!==principal.accountId||q.tenantId!==principal.tenantId||q.used||new Date(q.expiresAt)<=clock())throw new VoiceError('quote_unavailable',409);
    const country=await identity.getVerifiedCountry(principal.accountId);
    if(!country?.confirmedCountry||country.confirmedCountry!==q.origin)throw new VoiceError('country_changed',409);
    const destination=requireDestination(q.number,metadata);
    requireCorridor(q.origin,destination.country,await tx.getCorridors());
    const callerIds=await identity.getAuthorizedCallerIds(principal.accountId);
    requireAuthorizedCallerId(callerId,callerIds);
    const reserve=q.connectionFeeMinor+q.pricePerMinuteMinor; // 1-minute minimum reservation; policy can require more
    if(!Number.isSafeInteger(reserve))throw new VoiceError('invalid_reservation',500);
    const wallet=await tx.lockWallet(principal.accountId,q.currency);
    if(!wallet||wallet.availableMinor<reserve)throw new VoiceError('insufficient_credit',402);
    await tx.reserveWallet(wallet.id,reserve);
    const call=await tx.createCall({accountId:principal.accountId,tenantId:principal.tenantId,quoteId:q.id,number:q.number,currency:q.currency,reservedMinor:reserve,callerId,idempotencyKey,status:'queued'});
    await tx.markQuoteUsed(q.id);
    await tx.insertOutbox({type:'pstn.call.requested',callId:call.id});
    return {callId:call.id,status:'queued',reservedMinor:reserve,currency:q.currency};
   });
  },
  // Only an authenticated provider webhook adapter may invoke this. Signature verification,
  // replay prevention, event ordering, and carrier event normalization belong in that adapter.
  async recordCarrierEvent(event){
   if(!event?.authenticated||!event.providerEventId||!event.callId)throw new VoiceError('unauthorized_event',401);
   return store.transaction(async tx=>{
    if(await tx.hasCarrierEvent(event.providerEventId))return {duplicate:true};
    const call=await tx.lockCall(event.callId);
    if(!call)throw new VoiceError('unknown_call',404);
    if(!['completed','failed'].includes(event.status))throw new VoiceError('invalid_event',400);
    if(call.status==='settled')return {alreadySettled:true};
    let charge=0;
    if(event.status==='completed'){
     if(!Number.isSafeInteger(event.billableSeconds)||event.billableSeconds<0)throw new VoiceError('invalid_duration',400);
     const q=await tx.getQuote(call.quoteId);
     charge=q.connectionFeeMinor+Math.ceil(event.billableSeconds/60)*q.pricePerMinuteMinor;
    }
    if(!Number.isSafeInteger(charge))throw new VoiceError('invalid_charge',400);
    if(charge>call.reservedMinor)throw new VoiceError('reservation_exceeded_requires_reconciliation',409);
    await tx.settleWallet(call.accountId,call.currency,call.reservedMinor,charge); // atomic debit/release; never overdraw reservation
    await tx.settleCall(call.id,charge,event.status);
    await tx.insertCarrierEvent(event.providerEventId,call.id);
    await tx.insertOutbox({type:'pstn.call.settled',callId:call.id});
    return {chargeMinor:charge,currency:call.currency};
   });
  }
 };
}
