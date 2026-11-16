import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MeetPhoneAuthority } from '../src/meet-authority.js';
import { createGatewayRuntime } from '../src/runtime.js';

test('heartbeat authenticates its media-bridge evidence and clears bridge status when unhealthy',async()=>{
 const pair=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const calls:any[]=[];
 const f:typeof fetch=async(_url,init)=>{const body=String(init?.body),jwt=String((init?.headers as any).authorization).slice(7),[head,payload,sig]=jwt.split('.');
 assert(crypto.verify('sha256',Buffer.from(head+'.'+payload),{key:pair.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(sig,'base64url')));
 const claims=JSON.parse(Buffer.from(payload,'base64url').toString());assert.equal(claims.aud,'qorlla-phone-gateway');assert.equal(claims.bsh,crypto.createHash('sha256').update(body).digest('base64url'));assert.equal(claims.cnf['x5t#S256'],'certificate');calls.push(JSON.parse(body));return new Response(JSON.stringify({result:'ok'}));};
 const a=new MeetPhoneAuthority({baseUrl:'https://localhost',auth:{kind:'workload',privateKeyPem:pair.privateKey.export({format:'pem',type:'pkcs8'}) as string,issuer:'test',subject:'svc:phone',cnfThumbprint:'certificate'},fetchImpl:f});
 assert(await a.heartbeat('gw-1',true,true));assert(await a.heartbeat('gw-1',false,true));assert.deepEqual(calls,[{instance:'gw-1',healthy:true,mediaBridge:true},{instance:'gw-1',healthy:false,mediaBridge:false}]);
});
test('heartbeat does not interpret a 200 invalid response as successful registration',async()=>{
 const a=new MeetPhoneAuthority({baseUrl:'http://localhost',auth:{kind:'hmac',secret:'x'.repeat(32)},fetchImpl:async()=>new Response(JSON.stringify({result:'invalid'}))});assert.equal(await a.heartbeat('bad',true,true),false);
});
test('managed runtime refuses lab readiness and unbound gateway authentication before opening a socket',()=>{
 assert.throws(()=>createGatewayRuntime({sip:{labMode:true} as any,meet:{} as any,db:{} as any,signalingTls:{} as any}),/labMode/);
 for(const meet of [{baseUrl:'https://localhost',auth:{kind:'hmac'}},{baseUrl:'http://localhost',auth:{kind:'workload',cnfThumbprint:'x'},fetchImpl:fetch}])assert.throws(()=>createGatewayRuntime({sip:{} as any,meet:meet as any,db:{} as any,signalingTls:{} as any}),/mutual TLS/);
});
