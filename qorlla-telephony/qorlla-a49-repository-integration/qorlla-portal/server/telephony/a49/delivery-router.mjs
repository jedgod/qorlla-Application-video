// Dispatches only allowlisted topics. Every receiver must deduplicate by eventId.
import {createMeetReceiptDelivery} from './meet-delivery.mjs';
export function createDeliveryRouter({meetBaseUrl,meetSecret,fetchImpl=fetch,a4Originate}) {
  const meetCommand=createMeetReceiptDelivery({baseUrl:meetBaseUrl,secret:meetSecret,fetchImpl});
  const base=meetBaseUrl.replace(/\/$/,'');
  const meetWaiting=async({payload,idempotencyKey})=>{
    const r=await fetchImpl(base+'/api/integrations/a49/waiting',{method:'POST',redirect:'error',
      headers:{'content-type':'application/json','authorization':`Bearer ${meetSecret}`,'idempotency-key':idempotencyKey},
      body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
    if(!r.ok)throw Error(`MEET_WAITING_REJECTED_${r.status}`);
    const x=await r.json();
    if(x?.accepted!==true||x?.callId!==payload.callId)throw Error('MEET_WAITING_NOT_ACKNOWLEDGED');
    return x;
  };
  return async message=>{
    if(message.topic==='meet.waiting')return meetWaiting(message);
    if(message.topic==='meet.command')return meetCommand(message);
    if(message.topic==='gateway.originate'){
      if(typeof a4Originate!=='function')throw Error('A4_ORIGINATE_ADAPTER_UNAVAILABLE');
      const x=await a4Originate(message);
      if(x?.accepted!==true||x?.callId!==message.payload.callId||x?.sessionId!==message.payload.sessionId)
        throw Error('A4_ORIGINATE_UNCONFIRMED');
      return x;
    }
    throw Error('UNREGISTERED_DELIVERY_TOPIC');
  };
}
