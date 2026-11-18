import test from 'node:test';import assert from 'node:assert/strict';
import {createDb} from '../src/db.js';import {createService} from '../src/service.js';
const T='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',U='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id=i=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0');
const person=(i,extra={})=>({id:id(i),tenantId:T,email:`u${i}@example.com`,emailVerified:true,displayName:'User '+i,countryIso:i%2?'US':'GH',...extra});
const fresh=()=>{const db=createDb({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});return {db,s:createService(db)}};

test('simultaneous registrations never produce a duplicate number',async()=>{
 const {db,s}=fresh();
 const r=await Promise.allSettled(Array.from({length:60},(_,i)=>s.provision(person(i))));
 const bad=r.filter(x=>x.status==='rejected').map(x=>x.reason.message);
 assert.deepEqual(bad,[]);
 assert.equal(new Set(r.map(x=>x.value.number)).size,60);
 await db.close();
});

test('the same user registering twice at once gets one number and one record',async()=>{
 const {db,s}=fresh();
 const r=await Promise.all(Array.from({length:10},()=>s.provision(person(1))));
 assert.equal(new Set(r.map(x=>x.number)).size,1);
 assert.equal(db.raw.prepare('SELECT COUNT(*) c FROM numbers').get().c,1);
 assert.equal(db.raw.prepare('SELECT COUNT(*) c FROM users').get().c,1);
 await db.close();
});

test('an existing account keeps its identity: a different email or tenant is refused, not re-numbered',async()=>{
 const {db,s}=fresh();
 const a=await s.provision(person(1));
 await assert.rejects(s.provision(person(1,{email:'other@example.com'})),/identity_conflict/);
 await assert.rejects(s.provision(person(1,{tenantId:U})),/identity_conflict/);
 await assert.rejects(s.provision({...person(2),email:'U1@EXAMPLE.com'}),/identity_conflict/);   // another account cannot take an existing email
 assert.equal(db.raw.prepare('SELECT COUNT(*) c FROM users').get().c,1);
 assert.equal((await s.provision(person(1))).number,a.number);
 await db.close();
});

test('email and number lookups resolve to the same recipient; names are tenant-scoped',async()=>{
 const {db,s}=fresh();const a=await s.provision(person(1)),b=await s.provision(person(2));
 const me={userId:id(1),tenantId:T};
 const byEmail=await s.resolve(me,{email:'U2@Example.com'}),byNumber=await s.resolve(me,{number:b.number});
 assert.deepEqual(byEmail,byNumber);assert.equal(byEmail[0].id,id(2));
 const other=await s.provision({id:id(3),tenantId:U,email:'u3@example.com',emailVerified:true,displayName:'User 3',countryIso:'US'});
 assert.deepEqual(await s.resolve(me,{name:'User 3'}),[]);              // another tenant is invisible by name,
 assert.deepEqual(await s.resolve(me,{email:'u3@example.com'}),[]);      // by email,
 assert.deepEqual(await s.resolve(me,{number:other.number}),[]);         // and by its real number
 await assert.rejects(s.resolve(me,{email:'u2@example.com',name:'User 2'}),/one_lookup_required/);
 assert.ok(a.number);await db.close();
});

test('suspended accounts cannot call, be called, look anyone up or read their number',async()=>{
 const {db,s}=fresh();await s.provision(person(1));await s.provision(person(2));
 const a={userId:id(1),tenantId:T};
 db.raw.prepare("UPDATE users SET status='suspended' WHERE id=?").run(id(2));
 await assert.rejects(s.initiate(a,{recipientId:id(2)}),/forbidden/);
 await assert.rejects(s.initiate({userId:id(2),tenantId:T},{recipientId:id(1)}),/forbidden/);
 await assert.rejects(s.resolve({userId:id(2),tenantId:T},{email:'u1@example.com'}),/forbidden/);
 await assert.rejects(s.myNumber({userId:id(2),tenantId:T}),/forbidden/);
 assert.deepEqual(await s.resolve(a,{email:'u2@example.com'}),[]);  // and they are not discoverable
 await db.close();
});

test('call state machine: only the callee answers or rejects, either side ends, nothing moves twice, a failed signal ends the call',async()=>{
 const {db,s}=fresh();await s.provision(person(1));await s.provision(person(2));await s.provision(person(3));
 const a={userId:id(1),tenantId:T},b={userId:id(2),tenantId:T},c={userId:id(3),tenantId:T};
 const call=await s.initiate(a,{recipientId:id(2)});
 await assert.rejects(s.transition(a,call.callId,'answer'),/invalid_transition/);   // the caller cannot answer
 await assert.rejects(s.transition(c,call.callId,'end'),/forbidden/);               // a third party cannot touch it
 await s.transition(b,call.callId,'answer');
 await assert.rejects(s.transition(b,call.callId,'answer'),/invalid_transition/);
 await s.transition(b,call.callId,'end');
 await assert.rejects(s.transition(a,call.callId,'end'),/invalid_transition/);
 await assert.rejects(s.initiate(a,{recipientId:id(1)}),/self_call/);
 const down=createService(db,{onCallEvent:async()=>{throw new Error('boom')}});
 await assert.rejects(down.initiate(a,{recipientId:id(2)}),/signalling_unavailable/);
 assert.equal(db.raw.prepare("SELECT COUNT(*) c FROM calls WHERE status='ringing'").get().c,0);
 await db.close();
});

test('numbers are private identifiers, never PSTN routes',async()=>{
 const {db,s}=fresh();const a=await s.provision(person(1));
 assert.match(a.number,/^\+\d{13,15}$/);
 const src=(await import('node:fs')).readFileSync(new URL('../src/service.js',import.meta.url),'utf8');
 assert.doesNotMatch(src,/twilio|telnyx|sip:|pstn\s*\(/i);
 await db.close();
});
