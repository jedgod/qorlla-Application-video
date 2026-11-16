import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { PostgresIntegration } from '../src/postgres-integration.mjs';

const url=process.env.TELEPHONY_TEST_DATABASE_URL;
const skip=url?false:'TELEPHONY_TEST_DATABASE_URL must point to a disposable PostgreSQL database';
const schema='telephony_test_'+randomBytes(8).toString('hex');
let admin,pool;
const principalId='gateway-a', meeting='meeting-a';
const auth=()=>({principalId,nonce:randomBytes(16).toString('hex'),timestampMs:Date.now()});
const event=(callId,type,sequence,extra={})=>({eventId:randomUUID(),callId,gatewayId:principalId,gatewaySessionId:callId,meetingId:meeting,sequence,type,...extra});
const evidence={encrypted:true,inboundAudio:true,outboundAudio:true,gatewayVerified:true};
const configured=()=>new PostgresIntegration(pool,{shieldAuthorize:async()=>true,meetAuthorize:async()=>true,verifyMedia:async()=>true});

test.before(async()=>{
 if(skip)return;
 admin=new pg.Pool({connectionString:url});
 await admin.query(`CREATE SCHEMA "${schema}"`);
 pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 for(const name of ['001_telephony.sql','002_integrations_postgres.sql','003_internal_certification.sql'])
  await pool.query(await readFile(new URL('../sql/'+name,import.meta.url),'utf8'));
 await pool.query("UPDATE telephony_release_gates SET enabled=true,certified_at=now(),certified_by='test',evidence_digest=$1 WHERE gate='internal'",['a'.repeat(64)]);
});
test.after(async()=>{
 if(pool)await pool.end();
 if(admin){await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}
});
async function seed(state='authorized'){
 const id=randomUUID();
 await pool.query("INSERT INTO telephony_calls(id,tenant_id,actor_id,destination,kind,state) VALUES($1,$2,$3,'ext:test','internal',$4)",[id,randomUUID(),randomUUID(),state]);
 await pool.query('INSERT INTO telephony_gateway_bindings(call_id,gateway_id,gateway_session_id,meeting_id) VALUES($1,$2,$3,$4)',[id,principalId,id,meeting]);
 return id;
}

test('bound events are atomic, replay-protected, ordered and conflict checked',{skip},async()=>{
 const id=await seed(),svc=configured(),first=event(id,'RINGING',1),a=auth();
 assert.deepEqual(await svc.gatewayEvent(first,a),{replayed:false,state:'ringing'});
 await assert.rejects(svc.gatewayEvent(first,a),{code:'REPLAY_OR_EXPIRED_REQUEST'});
 assert.deepEqual(await svc.gatewayEvent(first,auth()),{replayed:true,state:'ringing'});
 await assert.rejects(svc.gatewayEvent({...first,type:'ANSWERED'},auth()),{code:'GATEWAY_EVENT_CONFLICT'});
 await assert.rejects(svc.gatewayEvent(event(id,'ANSWERED',0),auth()),{code:'STALE_GATEWAY_EVENT'});
 await assert.rejects(svc.gatewayEvent(event(id,'ANSWERED',2,{gatewaySessionId:'other'}),auth()),{code:'GATEWAY_BINDING_MISMATCH'});
 const r=await pool.query('SELECT state,(SELECT count(*)::int FROM telephony_gateway_events WHERE call_id=$1) AS events FROM telephony_calls WHERE id=$1',[id]);
 assert.equal(r.rows[0].state,'ringing');assert.equal(r.rows[0].events,1);
});

test('concurrent duplicates transition once and require fresh nonces',{skip},async()=>{
 const id=await seed(),svc=configured(),e=event(id,'RINGING',1);
 const results=await Promise.all([svc.gatewayEvent(e,auth()),svc.gatewayEvent(e,auth())]);
 assert.deepEqual(results.map(r=>r.replayed).sort(),[false,true]);
 const r=await pool.query('SELECT count(*)::int n FROM telephony_outbox WHERE call_id=$1',[id]);
 assert.equal(r.rows[0].n,1);
});

test('conflicting event IDs on different calls cannot mutate both calls',{skip},async()=>{
 const first=await seed(),second=await seed(),svc=configured(),a=event(first,'RINGING',1),b=event(second,'RINGING',1,{eventId:a.eventId});
 const results=await Promise.allSettled([svc.gatewayEvent(a,auth()),svc.gatewayEvent(b,auth())]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.code,'GATEWAY_EVENT_CONFLICT');
 const rows=await pool.query('SELECT state FROM telephony_calls WHERE id=ANY($1::uuid[])',[[first,second]]);
 assert.deepEqual(rows.rows.map(r=>r.state).sort(),['authorized','ringing']);
});

test('principal, revoked binding and authoritative Shield checks fail closed',{skip},async()=>{
 const id=await seed(),e=event(id,'RINGING',1);
 await assert.rejects(configured().gatewayEvent(e,{...auth(),principalId:'other'}),{code:'GATEWAY_IDENTITY_MISMATCH'});
 await assert.rejects(new PostgresIntegration(pool).gatewayEvent(e,auth()),{code:'SHIELD_DENIED'});
 await pool.query('UPDATE telephony_gateway_bindings SET revoked_at=now() WHERE call_id=$1',[id]);
 await assert.rejects(configured().gatewayEvent(e,auth()),{code:'GATEWAY_BINDING_MISMATCH'});
 const r=await pool.query('SELECT state FROM telephony_calls WHERE id=$1',[id]);
 assert.equal(r.rows[0].state,'authorized');
});

test('connection needs bound meeting admission and independently verified media',{skip},async()=>{
 const id=await seed('media_verifying'),e=event(id,'MEDIA_VERIFIED',1,{evidence});
 await assert.rejects(new PostgresIntegration(pool,{shieldAuthorize:async()=>true,meetAuthorize:async()=>true}).gatewayEvent(e,auth()),{code:'MEDIA_NOT_VERIFIED'});
 await assert.rejects(configured().gatewayEvent(e,auth()),{code:'MEET_ADMISSION_DENIED'});
 await pool.query("INSERT INTO telephony_meet_admissions(call_id,meeting_id,approval_state) VALUES($1,$2,'approved')",[id,meeting]);
 assert.equal((await configured().gatewayEvent(e,auth())).state,'connected');
});

test('closed gate blocks admission but authenticated termination remains possible',{skip},async()=>{
 const id=await seed('ringing'),svc=configured();
 await pool.query("UPDATE telephony_release_gates SET enabled=false WHERE gate='internal'");
 try {
  await assert.rejects(svc.gatewayEvent(event(id,'ANSWERED',1),auth()),{code:'INTERNAL_CALLS_DISABLED'});
  const withoutDependencies=new PostgresIntegration(pool);
  assert.equal((await withoutDependencies.gatewayEvent(event(id,'HANGUP',1),auth())).state,'ended');
 } finally {
  await pool.query("UPDATE telephony_release_gates SET enabled=true WHERE gate='internal'");
 }
});
