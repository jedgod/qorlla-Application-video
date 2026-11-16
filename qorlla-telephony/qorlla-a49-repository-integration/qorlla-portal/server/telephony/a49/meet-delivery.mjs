// Delivery to Meet command receipts. Receipt != media/participant admission.
export function createMeetReceiptDelivery({baseUrl,secret,fetchImpl=fetch}) {
 if(!/^https:\/\//.test(baseUrl||'') || (secret||'').length<32)
   throw new Error('Meet service HTTPS and dedicated secret required');
 const endpoint=baseUrl.replace(/\/$/,'')+'/api/integrations/a49/commands';
 return async ({topic,eventId,payload,idempotencyKey})=>{
   if(topic!=='meet.command')throw new Error('No delivery handler for '+topic);
   const r=await fetchImpl(endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',
      'Authorization':`Bearer ${secret}`,'Idempotency-Key':idempotencyKey},
      body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
   if(!r.ok)throw new Error('MEET_COMMAND_REFUSED_'+r.status);
   const response=await r.json();
   if(response?.accepted!==true||response?.commandId!==payload?.commandId)throw new Error('INVALID_MEET_RECEIPT');
   return response;
 };
}
