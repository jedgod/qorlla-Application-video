import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createGatewayService} from '../server/telephony/a49/core.mjs';
const id=()=>crypto.randomUUID();
function fakePool({gate=true,admitted=true}={}){
 const callId=id(),meetingId=id(),principalId='a4-staging',sessionId='session-12345678';
 const data={call:{id:callId,meeting_id:meetingId,gateway_id:principalId,gateway_session_id:sessionId,
   kind:'internal',state:'authorized',sequence_no:-1,admitted,version:0},nonces:new Set(),events:new Map(),outbox:[]};
 const pool={async connect(){let snapshot;
  return {async query(sql,params=[]){
    if(sql==='BEGIN'){snapshot={call:{...data.call},nonces:new Set(data.nonces),events:new Map(data.events),outbox:[...data.outbox]};return {rows:[],rowCount:0};}
    if(sql==='ROLLBACK'){data.call=snapshot.call;data.nonces=snapshot.nonces;data.events=snapshot.events;data.outbox=snapshot.outbox;return {rows:[],rowCount:0};}
    if(sql==='COMMIT')return {rows:[],rowCount:0};
    if(sql.includes('a49_gateway_principals'))return {rowCount:1,rows:[{active:true}]};
    if(sql.includes('INSERT INTO portal.a49_gateway_nonces')){if(data.nonces.has(params[1]))return {rowCount:0,rows:[]};data.nonces.add(params[1]);return {rowCount:1,rows:[{nonce:params[1]}]};}
    if(sql.includes('SELECT * FROM portal.a49_calls'))return {rowCount:1,rows:[{...data.call}]};
    if(sql.includes('SELECT enabled FROM portal.a49_gates'))return {rowCount:1,rows:[{enabled:gate}]};
    if(sql.includes('SELECT payload_sha256 FROM portal.a49_events'))return {rowCount:data.events.has(params[0])?1:0,rows:data.events.has(params[0])?[{payload_sha256:data.events.get(params[0])}]:[]};
    if(sql.includes('INSERT INTO portal.a49_events')){data.events.set(params[0],params[5]);return {rowCount:1,rows:[]};}
    if(sql.includes('UPDATE portal.a49_calls')){data.call.state=params[1];data.call.sequence_no=params[2];data.call.version++;return {rowCount:1,rows:[]};}
    if(sql.includes('INSERT INTO portal.a49_outbox')){data.outbox.push(params);return {rowCount:1,rows:[]};}
    throw Error('Unexpected SQL: '+sql);
  },release(){}};
 }};
 return {pool,data,callId,meetingId,principalId,sessionId};
}
function signed(event,secret='gateway-test-secret-1234567890abcdef'){
 const body=Buffer.from(JSON.stringify(event)),timestamp=Date.now(),nonce=crypto.randomBytes(18).toString('hex');
 const signature=crypto.createHmac('sha256',secret).update(`POST\n/api/v1/a49/gateway/events\n${timestamp}.${nonce}.`).update(body).digest('hex');
 return {principalId:event.gatewayId,body,signature,timestamp,nonce};
}
function ev(f,type,sequence,extra={}){return {eventId:id(),callId:f.callId,gatewayId:f.principalId,
 gatewaySessionId:f.sessionId,meetingId:f.meetingId,type,sequence,...extra};}
const setup=f=>createGatewayService({pool:f.pool,secretFor:async()=> 'gateway-test-secret-1234567890abcdef',
 shieldAuthorize:async()=>true});
test('atomic gateway event commits nonce, state, and outbox together',async()=>{
 const f=fakePool(),service=setup(f),e=ev(f,'RINGING',0);
 assert.deepEqual(await service.receive(signed(e)),{replayed:false,state:'ringing'});
 assert.equal(f.data.nonces.size,1);assert.equal(f.data.events.size,1);
 assert.equal(f.data.outbox.length,1);assert.equal(f.data.call.state,'ringing');
});
test('replayed nonce is rejected without duplicate transition',async()=>{
 const f=fakePool(),service=setup(f),s=signed(ev(f,'RINGING',0));
 await service.receive(s);
 await assert.rejects(()=>service.receive(s),{code:'REPLAY_DETECTED'});
 assert.equal(f.data.events.size,1);assert.equal(f.data.outbox.length,1);
});
test('invalid transition rolls back nonce/event/outbox atomically',async()=>{
 const f=fakePool(),service=setup(f);
 await assert.rejects(()=>service.receive(signed(ev(f,'MEDIA_VERIFIED',0,{evidence:{encrypted:true,
 inboundAudio:true,outboundAudio:true,gatewayVerified:true,sampleWindowMs:2000}}))),{code:'INVALID_TRANSITION'});
 assert.equal(f.data.nonces.size,0);assert.equal(f.data.events.size,0);
 assert.equal(f.data.outbox.length,0);assert.equal(f.data.call.state,'authorized');
});
test('gateway session mismatches are refused before mutation',async()=>{
 const f=fakePool(),service=setup(f);
 await assert.rejects(()=>service.receive(signed({...ev(f,'RINGING',0),gatewaySessionId:'different-session-123'})),{code:'UNBOUND_GATEWAY'});
 assert.equal(f.data.nonces.size,0);
});
test('closed gate blocks connection but accepts hangup cleanup',async()=>{
 const f=fakePool({gate:false}),service=setup(f);
 await assert.rejects(()=>service.receive(signed(ev(f,'RINGING',0))),{code:'CALLING_DISABLED'});
 assert.equal(f.data.call.state,'authorized');
 assert.deepEqual(await service.receive(signed(ev(f,'HANGUP',1))),{replayed:false,state:'ended'});
});
test('Shield denial cannot touch the DB',async()=>{
 const f=fakePool(),service=createGatewayService({pool:f.pool,secretFor:async()=> 'gateway-test-secret-1234567890abcdef',
 shieldAuthorize:async()=>false});
 await assert.rejects(()=>service.receive(signed(ev(f,'RINGING',0))),{code:'SHIELD_DENIED'});
 assert.equal(f.data.nonces.size,0);
});
