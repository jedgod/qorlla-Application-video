import http from 'node:http';
import {Pool} from 'pg';
import {TelephonyStore} from './store.mjs';
import {decideCall,PolicyError} from './policy.mjs';
const required=['DATABASE_URL','QORLLA_IDENTITY_URL','QORLLA_SHIELD_URL','QORLLA_ENTITLEMENTS_URL'];
for(const k of required)if(!process.env[k])throw new Error(`Missing ${k}`);
const config={internalEnabled:process.env.INTERNAL_CALLS_ENABLED==='true',externalEnabled:false};
// This reference intentionally refuses PSTN activation until a certified adapter is wired.
if(process.env.EXTERNAL_CALLS_ENABLED==='true')throw new Error('PSTN activation refused: certified carrier integration missing');
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DB_CA_FILE?{ca:(await import('node:fs')).readFileSync(process.env.DB_CA_FILE,'utf8'),rejectUnauthorized:true}:undefined,max:10});
const store=new TelephonyStore(pool);
async function trustedJson(url,token,body){
 const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(body),signal:AbortSignal.timeout(3000)});
 if(!r.ok)throw new PolicyError('DEPENDENCY_UNAVAILABLE',503);
 return r.json();
}
async function handler(req,res){
 const reply=(code,data)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
 try{
  if(req.url==='/health/live' && req.method==='GET')return reply(200,{alive:true});
  if(req.url!=='/v1/calls' || req.method!=='POST')return reply(404,{error:'NOT_FOUND'});
  const bearer=/^Bearer (\S+)$/.exec(req.headers.authorization||'');
  if(!bearer)throw new PolicyError('UNAUTHENTICATED',401);
  let raw='';for await(const part of req){raw+=part;if(raw.length>8192)throw new PolicyError('REQUEST_TOO_LARGE',413);}
  const body=JSON.parse(raw);
  const identity=await trustedJson(process.env.QORLLA_IDENTITY_URL,process.env.SERVICE_TOKEN,{userToken:bearer[1]});
  const [shield,entitlements]=await Promise.all([
   trustedJson(process.env.QORLLA_SHIELD_URL,process.env.SERVICE_TOKEN,{identity,kind:body.kind,destination:body.destination}),
   trustedJson(process.env.QORLLA_ENTITLEMENTS_URL,process.env.SERVICE_TOKEN,{tenantId:identity.tenantId,userId:identity.userId})
  ]);
  const decision=decideCall({kind:body.kind,destination:body.destination,config,identity,shield,entitlements,carrier:null});
  const created=await store.create({identity,decision,idempotencyKey:req.headers['idempotency-key']});
  return reply(created.replayed?200:202,created);
 }catch(e){return reply(e instanceof PolicyError?e.status:500,{error:e instanceof PolicyError?e.code:'INTERNAL_ERROR'});}
}
const server=http.createServer((req,res)=>void handler(req,res));
server.listen(Number(process.env.PORT||8080),'0.0.0.0');
process.on('SIGTERM',()=>server.close(()=>pool.end()));
