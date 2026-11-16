// Contract-compatible A4 command adapter. The deployed gateway MUST implement the
// separately authenticated endpoint and deduplicate requestId persistently.
// Do not set A49_A4_ENABLED before its real implementation is certified.
export function createA4OriginateAdapter({baseUrl,token,fetchImpl=fetch,enabled=false}){
  if(!enabled)return async()=>{throw new Error('A4_ADAPTER_DISABLED');};
  if(!/^https:\/\//.test(baseUrl||'') || typeof token!=='string'||token.length<32)
    throw new Error('A4 requires HTTPS and dedicated service credentials');
  return async ({idempotencyKey,payload})=>{
    if(!payload?.callId||!payload?.sessionId||!payload?.gatewayId)throw Error('A4_INVALID_CALL');
    const r=await fetchImpl(baseUrl.replace(/\/$/,'')+'/internal/v1/calls/originate',{
      method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:`Bearer ${token}`,
        'idempotency-key':idempotencyKey},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
    if(!r.ok)throw Error(`A4_REFUSED_${r.status}`);
    const x=await r.json();
    if(x?.callId!==payload.callId || x?.sessionId!==payload.sessionId || x?.accepted!==true)
      throw Error('A4_RECEIPT_MISMATCH');
    return x; // accepted means queued; never claim connected until MEDIA_VERIFIED event
  };
}
