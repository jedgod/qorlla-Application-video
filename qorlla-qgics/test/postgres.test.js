// Runs only when TEST_PG_URL points at a scratch PostgreSQL server (e.g. postgres://postgres:postgres@127.0.0.1:25690/postgres).
// It creates its own throwaway database, applies sql/postgres.sql, and drops the database afterwards. It never touches existing databases.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import pg from 'pg';
import {createDb} from '../src/db.js';import {createService} from '../src/service.js';
const base=process.env.TEST_PG_URL;
const T='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',U='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id=i=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0');
const person=(i,extra={})=>({id:id(i),tenantId:T,email:`u${i}@example.com`,emailVerified:true,displayName:'User '+i,countryIso:i%2?'US':'GH',...extra});

test('PostgreSQL: schema, concurrent allocation, idempotency, isolation, state machine, and a restart',{skip:!base&&'set TEST_PG_URL to run'},async()=>{
 const name='qgics_t_'+Math.random().toString(36).slice(2,10);
 const admin=new pg.Client({connectionString:base});await admin.connect();await admin.query(`CREATE DATABASE ${name}`);
 const url=new URL(base);url.pathname='/'+name;
 const pools=[];
 try{
  const setup=new pg.Client({connectionString:url.toString()});await setup.connect();
  await setup.query(fs.readFileSync(new URL('../sql/postgres.sql',import.meta.url),'utf8'));
  await setup.query(fs.readFileSync(new URL('../sql/postgres.sql',import.meta.url),'utf8')); // re-applying the migration is harmless
  await setup.end();
  const open=()=>{const db=createDb({DB_DRIVER:'postgres',DATABASE_URL:url.toString()});pools.push(db);return {db,s:createService(db)}};
  let {db,s}=open();
  const r=await Promise.allSettled(Array.from({length:60},(_,i)=>s.provision(person(i))));
  assert.deepEqual(r.filter(x=>x.status==='rejected').map(x=>x.reason.message),[]);
  assert.equal(new Set(r.map(x=>x.value.number)).size,60);
  const same=await Promise.all(Array.from({length:10},()=>s.provision(person(100))));
  assert.equal(new Set(same.map(x=>x.number)).size,1);
  await assert.rejects(s.provision(person(100,{email:'x@example.com'})),/identity_conflict/);
  // a different account may not take an existing email (unique, case-insensitive)
  await assert.rejects(s.provision({...person(101),email:'U100@EXAMPLE.com'}),/identity_conflict/);
  const other=await s.provision({id:id(200),tenantId:U,email:'o@example.com',emailVerified:true,displayName:'Outsider',countryIso:'US'});
  const me={userId:id(1),tenantId:T};
  assert.deepEqual(await s.resolve(me,{email:'o@example.com'}),[]);
  assert.deepEqual(await s.resolve(me,{number:other.number}),[]);
  const b=await s.provision(person(2));
  assert.deepEqual(await s.resolve(me,{email:'u2@example.com'}),await s.resolve(me,{number:b.number}));
  const call=await s.initiate(me,{recipientId:id(2)});
  await assert.rejects(s.transition(me,call.callId,'answer'),/invalid_transition/);
  const results=await Promise.allSettled([s.transition({userId:id(2),tenantId:T},call.callId,'answer'),s.transition({userId:id(2),tenantId:T},call.callId,'reject')]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1,'exactly one of two racing transitions wins');
  await db.close();
  ({db,s}=open());                                              // "PostgreSQL restart": a brand-new pool sees the same numbers
  assert.equal((await s.provision(person(1))).existing,true);
  assert.equal((await s.myNumber(me)).issued_number,(await s.provision(person(1))).number);
  const after=await s.provision(person(300));                   // and the counter continued, no reuse
  assert.ok(!r.some(x=>x.value.number===after.number));
  await db.close();
 }catch(e){console.error('FIRST ERROR:',e&&e.message,e&&e.code);throw e;}finally{
  for(const d of pools)await d.close().catch(()=>{});
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.end();
 }
});
