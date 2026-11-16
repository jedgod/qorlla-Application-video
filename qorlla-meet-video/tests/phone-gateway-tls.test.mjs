import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { gatewayTlsListener } from '../server/phone-gateway-tls.mjs';

test('dedicated gateway listener requires a verified client certificate and exposes the actual TLS peer',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qorlla-gateway-tls-'));
 const openssl=process.env.OPENSSL_BIN||'openssl';const run=(...args)=>execFileSync(openssl,args,{cwd:temp,stdio:'ignore'});
 run('req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.crt','-subj','/CN=gateway-test-ca','-days','1');
 for(const n of ['server','gateway']){run('req','-newkey','rsa:2048','-nodes','-keyout',n+'.key','-out',n+'.csr','-subj','/CN='+n);fs.writeFileSync(path.join(temp,n+'.ext'),'subjectAltName=DNS:localhost,IP:127.0.0.1\n');run('x509','-req','-in',n+'.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out',n+'.crt','-days','1','-extfile',n+'.ext');}
 const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
 const rd=n=>fs.readFileSync(path.join(temp,n));
 const server=gatewayTlsListener({env:{PHONE_GATEWAY_TLS_CERT:path.join(temp,'server.crt'),PHONE_GATEWAY_TLS_KEY:path.join(temp,'server.key'),PHONE_GATEWAY_TLS_CA:path.join(temp,'ca.crt'),PHONE_GATEWAY_TLS_PORT:String(port)},io:{attach(){}},app:(req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({authorized:req.socket.authorized,cn:req.socket.getPeerCertificate().subject.CN}));}});
 try{await once(server,'listening');const call=(url,cert=false)=>new Promise((resolve,reject)=>{const req=https.get('https://127.0.0.1:'+port+url,{ca:rd('ca.crt'),...(cert?{cert:rd('gateway.crt'),key:rd('gateway.key')}:{}),agent:false},r=>{let body='';r.on('data',d=>body+=d);r.on('end',()=>resolve({status:r.statusCode,body}));});req.on('error',reject);});
 await assert.rejects(call('/api/phone/ivr/readiness'));
 const r=await call('/api/phone/ivr/readiness',true);assert.equal(r.status,200);assert.deepEqual(JSON.parse(r.body),{authorized:true,cn:'gateway'});
 assert.equal((await call('/api/integrations/meetings',true)).status,404);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});}
});
test('gateway TLS is absent by default and rejects partial configuration',()=>{assert.equal(gatewayTlsListener({env:{}}),null);assert.throws(()=>gatewayTlsListener({env:{PHONE_GATEWAY_TLS_CERT:'some-file'}}),/requires/);});
