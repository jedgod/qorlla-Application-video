import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {createRemoteJWKSet,jwtVerify} from 'jose';
import {Pool} from 'pg';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {ACTIONS,evaluate,type Context} from './policy.js';
const required=['DATABASE_URL','JWKS_URL','JWT_ISSUER','JWT_AUDIENCE','SHIELD_SERVICE_TOKEN'] as const;
for(const key of required)if(!process.env[key])throw new Error(`Missing ${key}`);
if(process.env.SHIELD_SERVICE_TOKEN!.length<32)throw new Error('Service token too short');
const pool=new Pool({connectionString:process.env.DATABASE_URL, max:15,ssl:process.env.PGSSL==='require'?{rejectUnauthorized:true}:undefined});
const jwks=createRemoteJWKSet(new URL(process.env.JWKS_URL!));
const app=Fastify({logger:true,bodyLimit:32*1024,trustProxy:false});
await app.register(helmet);await app.register(rateLimit,{max:60,timeWindow:'1 minute'});
const schema=z.object({requestId:z.string().uuid(),action:z.enum(ACTIONS),resourceId:z.string().min(1).max(200),deviceId:z.string().uuid().optional(),international:z.boolean().default(false),externalInvite:z.boolean().default(false),destinationAllowed:z.boolean().default(false)}).strict();
const audit=async (client:any,actor:string|null,org:string|null,action:string,decision:string,reason:string,requestId:string)=>client.query('INSERT INTO shield.security_events(principal_id,organization_id,action,decision,reason,request_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(request_id) DO NOTHING',[actor,org,action,decision,reason,requestId]);
app.get('/health',async()=>({status:'up'}));
app.post('/v2/shield/authorize',async(req,reply)=>{
 const parsed=schema.safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'INVALID_REQUEST'});
 const input=parsed.data;
 const bearer=req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];if(!bearer)return reply.code(401).send({error:'UNAUTHORIZED'});
 let claims:any;try{claims=(await jwtVerify(bearer,jwks,{issuer:process.env.JWT_ISSUER,audience:process.env.JWT_AUDIENCE,algorithms:['RS256','ES256']})).payload;}catch{return reply.code(401).send({error:'UNAUTHORIZED'});}
 const actor=claims.sub;if(typeof actor!=='string'||!z.string().uuid().safeParse(actor).success)return reply.code(401).send({error:'UNAUTHORIZED'});
 const scopes=typeof claims.scope==='string'?claims.scope.split(' '):[];
 const client=await pool.connect();
 try{
 await client.query('BEGIN');
 // One principal-level transaction lock serializes counters, call concurrency and state changes.
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[actor]);
 const prior=await client.query('SELECT id,action,resource_id,expires_at FROM shield.authorizations WHERE request_id=$1',[input.requestId]);
 if(prior.rowCount){await client.query('COMMIT');return {allow:true,reason:'ALREADY_AUTHORIZED',authorizationId:prior.rows[0].id,expiresAt:prior.rows[0].expires_at};}
 const used=await client.query('SELECT decision,reason FROM shield.security_events WHERE request_id=$1',[input.requestId]);
 if(used.rowCount){await client.query('COMMIT');return {allow:false,reason:used.rows[0].reason};}
 const identity=await client.query('SELECT principal_id,organization_id,suspended,verified,mfa_enrolled FROM shield.principal_state WHERE principal_id=$1',[actor]);
 const p=identity.rows[0];
 const org=p?.organization_id? (await client.query('SELECT * FROM shield.organization_policy WHERE organization_id=$1',[p.organization_id])).rows[0]:null;
 const device=input.deviceId?(await client.query('SELECT trusted,revoked FROM shield.devices WHERE principal_id=$1 AND device_id=$2',[actor,input.deviceId])).rows[0]:null;
 const risk=(await client.query('SELECT COALESCE(MAX(score),0)::int AS risk FROM shield.risk_signals WHERE principal_id=$1 AND expires_at>now()',[actor])).rows[0].risk;
 // Never trust user-supplied organization, identity, risk, MFA, or device trust flags.
 const ctx:Context={action:input.action,verified:!!p?.verified,mfa:!!p?.mfa_enrolled,trustedDevice:!!device?.trusted&&!device?.revoked,suspended:!p||p.suspended,orgSuspended:!!org?.suspended,isGuest:claims.account_type==='guest',scopes,risk,pstnEnabled:!!org?.pstn_enabled,internationalEnabled:!!org?.international_enabled,international:input.international,externalInvite:input.externalInvite,destinationAllowed:input.destinationAllowed};
 let decision=evaluate(ctx);
 // Deny-by-default: external PSTN destination classification must be performed by a trusted gateway.
 if(input.action==='voice.pstn.outbound'&&!scopes.includes('voice:gateway:validated'))decision={allow:false,reason:'GATEWAY_VALIDATION_REQUIRED',stepUp:false};
 if(decision.allow){
 const hour=new Date();hour.setUTCMinutes(0,0,0);
 const limit=input.action==='voice.pstn.outbound'?(org?.max_calls_hour??0):input.action==='message.send'?120:input.action==='meeting.invite'?30:60;
 const count=await client.query(`INSERT INTO shield.usage_counters(principal_id,bucket,window_start,used) VALUES($1,$2,$3,1) ON CONFLICT(principal_id,bucket,window_start) DO UPDATE SET used=shield.usage_counters.used+1 WHERE shield.usage_counters.used<$4 RETURNING used`,[actor,input.action,hour,limit]);
 if(!count.rowCount)decision={allow:false,reason:'RATE_LIMIT',stepUp:false};
 }
 const id=randomUUID();
 if(decision.allow)await client.query('INSERT INTO shield.authorizations(id,principal_id,action,resource_id,expires_at,request_id) VALUES($1,$2,$3,$4,now()+interval \'30 seconds\',$5)',[id,actor,input.action,input.resourceId,input.requestId]);
 await audit(client,actor,p?.organization_id??null,input.action,decision.allow?'ALLOW':'DENY',decision.reason,input.requestId);
 await client.query('COMMIT');
 return {allow:decision.allow,reason:decision.reason,stepUp:decision.stepUp,...decision.allow?{authorizationId:id,expiresInSeconds:30}:{}};
 }catch(e){await client.query('ROLLBACK').catch(()=>{});req.log.error(e);return reply.code(503).send({allow:false,reason:'SECURITY_UNAVAILABLE'});}finally{client.release();}
});
// Consume exactly once; gateway must also verify action, resource, actor, and expiry.
app.post('/v2/shield/consume',async(req,reply)=>{
 const token=req.headers['x-shield-service-token'];const a=Buffer.from(typeof token==='string'?token:'');const b=Buffer.from(process.env.SHIELD_SERVICE_TOKEN!);
 if(a.length!==b.length||!timingSafeEqual(a,b))return reply.code(401).send({error:'UNAUTHORIZED'});
 const input=z.object({authorizationId:z.string().uuid(),principalId:z.string().uuid(),action:z.enum(ACTIONS),resourceId:z.string().min(1).max(200)}).strict().safeParse(req.body);
 if(!input.success)return reply.code(400).send({error:'INVALID_REQUEST'});
 const x=input.data;
 const result=await pool.query('UPDATE shield.authorizations SET consumed_at=now() WHERE id=$1 AND principal_id=$2 AND action=$3 AND resource_id=$4 AND consumed_at IS NULL AND expires_at>now() RETURNING id',[x.authorizationId,x.principalId,x.action,x.resourceId]);
 return {valid:result.rowCount===1};
});
app.setErrorHandler((err,req,reply)=>{req.log.error(err);reply.code(503).send({error:'SERVICE_UNAVAILABLE'});});
await app.listen({port:Number(process.env.PORT||8089),host:'0.0.0.0'});
