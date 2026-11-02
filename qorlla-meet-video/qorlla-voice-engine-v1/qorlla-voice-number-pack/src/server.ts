import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {z} from 'zod';
import {createHmac,timingSafeEqual,createHash} from 'node:crypto';
import {authenticate} from './auth.js';
import {config} from './config.js';
import {ensureIdentity,getMyNumber,assignNumber,requestRelease,DomainError} from './service.js';
import {pool,transaction} from './db.js';
import {workerLoop} from './worker.js';
const app=Fastify({logger:true,bodyLimit:16384,trustProxy:false});
await app.register(helmet);
await app.register(rateLimit,{max:40,timeWindow:'1 minute'});
app.setErrorHandler((error,request,reply)=>{
 const code=error instanceof DomainError?error.code:'REQUEST_FAILED';
 const status=error instanceof DomainError?error.status:(error.message==='UNAUTHORIZED'?401:500);
 request.log.error(error);reply.code(status).send({error:code});
});
app.get('/health/live',async()=>({ok:true}));
app.get('/health/ready',async()=>{await pool.query('SELECT 1');return {ok:true};});
async function principal(auth?:string){return authenticate(auth);}
app.post('/v1/voice/identity',async(req,reply)=>{
 const user=await principal(req.headers.authorization);
 return reply.code(201).send({extension:await ensureIdentity(user.userId)});
});
app.get('/v1/voice/numbers/me',async(req)=>{
 const user=await principal(req.headers.authorization);return {number:await getMyNumber(user.userId)};
});
app.post('/v1/voice/numbers/assign',async(req,reply)=>{
 const user=await principal(req.headers.authorization);
 const body=z.object({country:z.string().regex(/^[A-Z]{2}$/)}).parse(req.body);
 const key=z.string().uuid().parse(req.headers['idempotency-key']);
 const result=await assignNumber(user.userId,body.country,key);
 return reply.code(202).send(result);
});
app.post('/v1/voice/numbers/release',async(req,reply)=>{
 const user=await principal(req.headers.authorization);
 return reply.code(202).send(await requestRelease(user.userId));
});
// Raw body is necessary for cryptographic webhook verification.
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json',{parseAs:'buffer'},(req,body,done)=>{
 if(req.url.startsWith('/v1/voice/provider/events'))return done(null,body);
 try{done(null,JSON.parse(body.toString('utf8')));}catch(e){done(e as Error,undefined);}
});
app.post('/v1/voice/provider/events',async(req,reply)=>{
 const raw=req.body;
 if(!Buffer.isBuffer(raw))return reply.code(400).send({error:'INVALID_BODY'});
 const header=req.headers['x-qorlla-signature'];
 const received=typeof header==='string'?header:'';
 const expected=createHmac('sha256',config.PROVIDER_WEBHOOK_SECRET).update(raw).digest('hex');
 if(!/^[0-9a-f]{64}$/.test(received)||!timingSafeEqual(Buffer.from(received,'hex'),Buffer.from(expected,'hex')))
  return reply.code(401).send({error:'INVALID_SIGNATURE'});
 const event=z.object({id:z.string().min(8).max(128),type:z.enum(['number.activated','number.released','number.suspended']),assignmentId:z.string().uuid(),providerNumberId:z.string().min(1)}).parse(JSON.parse(raw.toString('utf8')));
 await transaction(async c=>{
  const stored=await c.query(`INSERT INTO voice_provider_events(provider,event_id,payload_hash) VALUES('configured',$1,$2)
   ON CONFLICT DO NOTHING RETURNING event_id`,[event.id,createHash('sha256').update(raw).digest('hex')]);
  if(!stored.rowCount)return;
  const r=await c.query(`SELECT a.id,a.user_id,a.status,a.inventory_id,n.provider_number_id FROM voice_number_assignments a
   JOIN voice_number_inventory n ON n.id=a.inventory_id WHERE a.id=$1 FOR UPDATE OF a`,[event.assignmentId]);
  const a=r.rows[0];if(!a||a.provider_number_id!==event.providerNumberId)throw new DomainError('EVENT_TARGET_MISMATCH',422);
  const transitions:Record<string,[string,string,string]>= {
   'number.activated':['pending','active','assigned'],
   'number.released':['release_pending','released','quarantined'],
   'number.suspended':['active','suspended','assigned']
  };
  const [from,to,inventory]=transitions[event.type]!;
  if(a.status!==from){if(a.status===to)return;throw new DomainError('INVALID_EVENT_TRANSITION',409);}
  await c.query('UPDATE voice_number_assignments SET status=$2,updated_at=now() WHERE id=$1',[a.id,to]);
  await c.query('UPDATE voice_number_inventory SET status=$2 WHERE id=$1',[a.inventory_id,inventory]);
  await c.query('INSERT INTO voice_audit_events(actor,subject_user_id,action,resource_id) VALUES($1,$2,$3,$4)',
   ['provider',a.user_id,event.type,a.id]);
 });
 return {ok:true};
});
const controller=new AbortController();
if(config.WORKER_ENABLED==='true')void workerLoop(controller.signal).catch(e=>{app.log.fatal(e);process.exitCode=1;controller.abort();});
const stop=async()=>{controller.abort();await app.close();await pool.end();};
process.on('SIGTERM',()=>{void stop();});process.on('SIGINT',()=>{void stop();});
await app.listen({host:'0.0.0.0',port:config.PORT});
