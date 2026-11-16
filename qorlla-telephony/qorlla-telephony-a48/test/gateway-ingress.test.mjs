import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createIntegrationServer } from '../src/integration-api.mjs';
import { signGateway } from '../src/gateway-auth.mjs';

test('gateway ingress requires a separately authenticated principal and forwards signed nonce',async()=>{
 const secret=randomBytes(32).toString('hex'),path='/internal/gateway/events',body=Buffer.from('{}');
 let received;
 const integration={gatewayEvent:async(event,auth)=>{received={event,auth};return {ok:true};}};
 let principal=null;
 const server=createIntegrationServer({integration,secret,authenticateGateway:async()=>principal});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const request=async()=>{
   const timestamp=Date.now(),nonce=randomBytes(16).toString('hex');
   const signature=signGateway({method:'POST',path,timestamp,nonce,body,secret});
   const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',body,headers:{'x-qorlla-timestamp':String(timestamp),'x-qorlla-nonce':nonce,'x-qorlla-signature':signature}});
   return {response,nonce,timestamp};
  };
  assert.equal((await request()).response.status,401);
  assert.equal(received,undefined);
  principal='gateway-a';
  const r=await request();
  assert.equal(r.response.status,202);
  assert.deepEqual(received.auth,{principalId:principal,nonce:r.nonce,timestampMs:r.timestamp});
 }finally{await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
