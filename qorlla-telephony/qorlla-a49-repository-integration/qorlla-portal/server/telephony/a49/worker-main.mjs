// Optional A4.9 worker. Does not run in the portal process by default.
// Run in a dedicated deployment, never until migrations and real adapters are configured.
import 'dotenv/config';
import pg from 'pg';
import crypto from 'node:crypto';
import {createOutbox} from './outbox.mjs';
import {createA4OriginateAdapter} from './a4-adapter.mjs';
import {createDeliveryRouter} from './delivery-router.mjs';
import {createAdmissionSync} from './admission-sync.mjs';

const env=process.env;
if(env.A49_OUTBOX_WORKER_ENABLED!=='true'){
  console.log('A49 outbox worker disabled');process.exit(0);
}
if(env.A49_INTERNAL_CALLS_ENABLED!=='true'||env.A49_EVENT_INGRESS_ENABLED!=='true')
  throw Error('A49 worker requires both configured internal-call and event-ingress gates');
for(const key of ['DATABASE_URL','A49_MEET_URL','A49_MEET_CONTROL_SECRET','A49_SHIELD_AUTHZ_URL','A49_SHIELD_SERVICE_TOKEN'])
  if(!env[key])throw Error(`Missing ${key}`);
for(const key of ['A49_MEET_URL','A49_SHIELD_AUTHZ_URL'])
  if(!env[key].startsWith('https://'))throw Error(key+' must be HTTPS');
for(const key of ['A49_MEET_CONTROL_SECRET','A49_SHIELD_SERVICE_TOKEN'])
  if(env[key].length<32)throw Error(key+' must be >=32 characters');
const db=new pg.Pool({connectionString:env.DATABASE_URL,max:3});
const workerId=crypto.randomUUID();
let quitting=false;
const shieldAuthorize=async ctx=>{
  try{
    const r=await fetch(env.A49_SHIELD_AUTHZ_URL,{method:'POST',redirect:'error',
      headers:{'content-type':'application/json',authorization:`Bearer ${env.A49_SHIELD_SERVICE_TOKEN}`},
      body:JSON.stringify(ctx),signal:AbortSignal.timeout(4000)});
    if(!r.ok)return false;
    const x=await r.json();return x?.allow===true&&x?.callId===ctx.callId&&x?.action===ctx.action&&x?.actorId===ctx.actorId;
  }catch{return false;}
};
const a4=createA4OriginateAdapter({enabled:env.A49_A4_ENABLED==='true',
  baseUrl:env.A49_A4_URL,token:env.A49_A4_SERVICE_TOKEN});
const send=createDeliveryRouter({meetBaseUrl:env.A49_MEET_URL,meetSecret:env.A49_MEET_CONTROL_SECRET,a4Originate:a4});
const deliver=async m=>{
  const gate=(await db.query("SELECT enabled FROM portal.a49_gates WHERE kind='internal'")).rows[0];
  const cleanup=m.topic==='meet.command'&&['deny','mute','remove','end'].includes(m.payload?.action);
  if(gate?.enabled!==true&&!cleanup)throw Error('A49_INTERNAL_GATE_CLOSED');
  return send(m);
};
const outbox=createOutbox({pool:db,deliver});
const admissions=createAdmissionSync({pool:db,meetBaseUrl:env.A49_MEET_URL,
  meetSecret:env.A49_MEET_CONTROL_SECRET,shieldAuthorize});
const topics=['meet.waiting','meet.command'];
if(env.A49_A4_ENABLED==='true')topics.push('gateway.originate');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
process.on('SIGTERM',()=>{quitting=true;});process.on('SIGINT',()=>{quitting=true;});
async function tick(){
  const gated=(await db.query("SELECT enabled FROM portal.a49_gates WHERE kind='internal'")).rows[0]?.enabled===true;
  if(gated){
    const candidates=await db.query(`SELECT c.id FROM portal.a49_calls c
      WHERE c.kind='internal' AND c.meeting_id IS NOT NULL AND c.state NOT IN ('ended','failed')
      AND EXISTS (SELECT 1 FROM portal.a49_outbox o WHERE o.call_id=c.id AND o.topic='meet.waiting' AND o.delivered_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM portal.a49_meet_commands mc WHERE mc.call_id=c.id)
      ORDER BY c.created_at LIMIT 20`);
    for(const c of candidates.rows){try{await admissions.sync(c.id);}catch(e){console.error('admission-sync',e.code||e.message);}}
  }
  await outbox.runOnce(workerId,topics);
}
try{
  while(!quitting){try{await tick();}catch(e){console.error('A49 worker failed',e.code||e.message);}if(!quitting)await delay(1000);}
}finally{await db.end();}
