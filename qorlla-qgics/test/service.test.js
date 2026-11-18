import test from 'node:test';import assert from 'node:assert/strict';
import {createDb} from '../src/db.js';import {createService} from '../src/service.js';
import {issueNumber,normalizeNumber} from '../src/countries.js';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333',T='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',U='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('allocation, idempotency, cross-country uniqueness, lookup and call lifecycle',async()=>{
 const db=createDb({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});const events=[];const s=createService(db,{onCallEvent:async e=>events.push(e)});
 const a=await s.provision({id:A,tenantId:T,email:'A@Example.com',emailVerified:true,displayName:'Alice',countryIso:'US'});
 const b=await s.provision({id:B,tenantId:T,email:'b@example.com',emailVerified:true,displayName:'Bob',countryIso:'CA'});
 const c=await s.provision({id:C,tenantId:U,email:'c@example.com',emailVerified:true,displayName:'Chris',countryIso:'GH'});
 assert.notEqual(a.number,b.number);assert.notEqual(a.number,c.number);
 assert.equal((await s.provision({id:A,tenantId:T,email:'a@example.com',emailVerified:true,displayName:'Alice',countryIso:'US'})).number,a.number);
 assert.equal((await s.resolve({userId:A,tenantId:T},{email:'b@example.com'}))[0].id,B);
 assert.equal((await s.resolve({userId:A,tenantId:T},{number:b.number}))[0].id,B);
 assert.deepEqual(await s.resolve({userId:A,tenantId:T},{email:'c@example.com'}),[]);
 await assert.rejects(s.initiate({userId:A,tenantId:T},{recipientId:C}),/forbidden/);
 const call=await s.initiate({userId:A,tenantId:T},{recipientId:B,mediaType:'video'});
 assert.equal((await s.transition({userId:B,tenantId:T},call.callId,'answer')).status,'accepted');
 assert.equal((await s.transition({userId:A,tenantId:T},call.callId,'end')).status,'ended');
 assert.equal((await s.history({userId:B,tenantId:T})).length,1);
 assert.equal(events.length,3);await db.close();
});
test('private numbering and normalization',()=>{
 assert.notEqual(issueNumber('US',1),issueNumber('CA',1));
 assert.equal(normalizeNumber('+233 000 004 821'),'+233000004821');
 assert.throws(()=>normalizeNumber('Q+233000004821'));
});
