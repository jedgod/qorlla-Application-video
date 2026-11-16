import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {eventSchema,transition,verifyHmac,TelephonyError} from '../server/telephony/a49/core.mjs';
import {createA4OriginateAdapter} from '../server/telephony/a49/a4-adapter.mjs';
import {createDeliveryRouter} from '../server/telephony/a49/delivery-router.mjs';
import {validateCdr,reconcileCdr} from '../server/telephony/a49/carrier.mjs';
import {createInternalCallService} from '../server/telephony/a49/call-api.mjs';
import {createAdmissionSync} from '../server/telephony/a49/admission-sync.mjs';
const id=()=>crypto.randomUUID();
const callId=id(), meetingId=id();
const event={eventId:id(),callId,gatewayId:'qorlla-a4-1',gatewaySessionId:'session-durable-123',sequence:7,
  type:'MEDIA_VERIFIED',meetingId,evidence:{encrypted:true,inboundAudio:true,outboundAudio:true,gatewayVerified:true,sampleWindowMs:1000}};
test('gateway media proof requires inbound, outbound, encryption, and sample window',()=>{
  assert.equal(eventSchema(event),'connected');
  assert.throws(()=>eventSchema({...event,evidence:{...event.evidence,inboundAudio:false}}),{code:'MEDIA_NOT_VERIFIED'});
  assert.throws(()=>eventSchema({...event,evidence:{...event.evidence,sampleWindowMs:500}}),{code:'MEDIA_NOT_VERIFIED'});
});
test('a media event cannot bypass admission',()=>{
  assert.throws(()=>transition('media_verifying','connected',event,false),{code:'ADMISSION_NOT_CONFIRMED'});
  assert.equal(transition('media_verifying','connected',event,true),'connected');
});
test('state machine rejects phantom connected and revival',()=>{
  assert.throws(()=>transition('authorized','connected',event,true),{code:'INVALID_TRANSITION'});
  assert.throws(()=>transition('ended','ringing',event,true),{code:'INVALID_TRANSITION'});
});
test('HMAC verification rejects replay-window expiry and wrong body',()=>{
  const body=Buffer.from(JSON.stringify(event)),ts=Date.now(),nonce='abcdefghijklmnop1234',secret='1234567890abcdefghijklmnopqrstuvwxyz';
  const sig=crypto.createHmac('sha256',secret).update(`POST\n/api/v1/a49/gateway/events\n${ts}.${nonce}.`).update(body).digest('hex');
  assert.equal(verifyHmac({body,signature:sig,timestamp:ts,nonce,secret}),true);
  assert.throws(()=>verifyHmac({body:Buffer.from('tampered'),signature:sig,timestamp:ts,nonce,secret}),{code:'INVALID_GATEWAY_AUTH'});
  assert.throws(()=>verifyHmac({body,signature:sig,timestamp:ts-120000,nonce,secret}),{code:'INVALID_GATEWAY_AUTH'});
});
test('disabled A4 adapter never calls the network',async()=>{
 const a=createA4OriginateAdapter({enabled:false});
 await assert.rejects(()=>a({}),/A4_ADAPTER_DISABLED/);
});
test('enabled A4 adapter requires secure transport and service identity',()=>{
 assert.throws(()=>createA4OriginateAdapter({enabled:true,baseUrl:'http://public',token:'x'.repeat(40)}),/HTTPS/);
});
test('A4 response cannot be treated as connected, only accepted',async()=>{
 const callId=id(),sessionId=id();
 const adapter=createA4OriginateAdapter({enabled:true,baseUrl:'https://gateway.example',token:'x'.repeat(40),
   fetchImpl:async()=>({ok:true,json:async()=>({accepted:true,callId,sessionId})})});
 assert.deepEqual(await adapter({idempotencyKey:id(),payload:{callId,sessionId,gatewayId:'qorlla-a4-1'}}),{accepted:true,callId,sessionId});
});
test('internal call request is disabled before contacting DB',async()=>{
 const service=createInternalCallService({pool:{connect(){throw Error('DB must not be accessed');}},gatewayId:'qorlla-a4-1',
   shieldAuthorize:async()=>true,gateEnvironment:()=>false});
 await assert.rejects(()=>service.request({workspaceId:id(),actorId:id(),destinationUserId:id(),requestId:id()}),{code:'INTERNAL_CALLS_DISABLED'});
});
test('Shield denies before any call database transaction',async()=>{
 const service=createInternalCallService({pool:{connect(){throw Error('DB must not be accessed');}},gatewayId:'qorlla-a4-1',
   shieldAuthorize:async()=>false,gateEnvironment:()=>true});
 await assert.rejects(()=>service.request({workspaceId:id(),actorId:id(),destinationUserId:id(),requestId:id()}),{code:'SHIELD_DENIED'});
});
test('carrier CDR validation and reconciliation never invoke PSTN',()=>{
 const cdr={carrierId:'wholesale-a',cdrId:'cdr-123',callId:id(),seconds:61,amountMinor:10,currency:'USD'};
 assert.equal(validateCdr(cdr),cdr);
 assert.equal(reconcileCdr({carrierAmount:10,carrierCurrency:'USD',ratedAmount:10,ratedCurrency:'USD'}),'matched');
 assert.equal(reconcileCdr({carrierAmount:11,carrierCurrency:'USD',ratedAmount:10,ratedCurrency:'USD'}),'disputed');
 assert.throws(()=>validateCdr({...cdr,amountMinor:-1}),{code:'INVALID_CDR'});
});
test('delivery route refuses unknown topics and unavailable A4 executor',async()=>{
 const send=createDeliveryRouter({meetBaseUrl:'https://meet.example',meetSecret:'x'.repeat(40)});
 await assert.rejects(()=>send({topic:'unknown'}),/UNREGISTERED_DELIVERY_TOPIC/);
 await assert.rejects(()=>send({topic:'gateway.originate',payload:{callId:id()}}),/A4_ORIGINATE_ADAPTER_UNAVAILABLE/);
});
test('admission sync refuses non-HTTPS Meet URL',()=>{
 assert.throws(()=>createAdmissionSync({pool:{},meetBaseUrl:'http://meet',meetSecret:'x'.repeat(40),shieldAuthorize:async()=>true}),/Secure Meet/);
});
test('admission status cannot bypass host approval',async()=>{
 const callId=id();const sync=createAdmissionSync({pool:{connect(){throw Error('DB must not be accessed');}},
 meetBaseUrl:'https://meet.example',meetSecret:'x'.repeat(40),shieldAuthorize:async()=>true,
 fetchImpl:async()=>({ok:true,json:async()=>({callId,meetingId:id(),decision:'pending',hostParticipantId:null})})});
 assert.deepEqual(await sync.sync(callId),{queued:false,reason:'pending'});
});
