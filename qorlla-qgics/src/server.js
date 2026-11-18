import express from 'express';
import helmet from 'helmet';
import {z} from 'zod';
import {createDb} from './db.js';
import {createService} from './service.js';
const app=express();app.disable('x-powered-by');app.use(helmet());app.use(express.json({limit:'16kb'}));
const db=createDb();const svc=createService(db);
const uuid=z.string().uuid();
const actorMiddleware=(req,res,next)=>{
 // PRODUCTION INTEGRATION: replace with Qorlla Portal JWT/session validation and Shield authorization.
 // Never trust caller-controlled identity headers on an internet-facing server.
 if(process.env.NODE_ENV==='production'||process.env.DEV_AUTH!=='true')return res.status(503).json({error:'auth_adapter_required'});
 const userId=req.header('x-dev-user-id'),tenantId=req.header('x-dev-tenant-id');
 if(!uuid.safeParse(userId).success||!uuid.safeParse(tenantId).success)return res.status(401).json({error:'unauthorized'});
 req.actor={userId,tenantId};next();
};
app.get('/health',(_req,res)=>res.json({ok:true,service:'qgics'}));
app.use('/api/qgics',actorMiddleware);
function route(method,path,schema,handler){app[method]('/api/qgics'+path,async(req,res)=>{try{const data=schema?schema.parse(req.body):undefined;const result=await handler(req,data);res.json(result);}catch(e){const known=['forbidden','not_found','invalid_transition','identity_conflict','self_call','invalid_verified_user','unsupported_country','one_lookup_required','name_too_short','invalid_extension','invalid_media_type','invalid_number','invalid_email','invalid_allocation','allocation_exhausted','signalling_unavailable'];const error=e instanceof z.ZodError?'invalid_request':known.includes(e.message)?e.message:'internal_error';res.status(error==='forbidden'?403:error==='not_found'?404:error==='internal_error'?500:error==='signalling_unavailable'?503:400).json({error});}})}
route('post','/provision',z.object({id:uuid,tenantId:uuid,email:z.string(),emailVerified:z.literal(true),displayName:z.string().min(1).max(120),countryIso:z.string().length(2)}),async(req,data)=>{if(req.actor.userId!==data.id||req.actor.tenantId!==data.tenantId)throw new Error('forbidden');return svc.provision(data)});
route('get','/number/me',null,req=>svc.myNumber(req.actor));
route('post','/resolve',z.object({email:z.string().optional(),number:z.string().optional(),extension:z.string().optional(),name:z.string().optional()}).strict(),(req,data)=>svc.resolve(req.actor,data));
route('post','/calls',z.object({recipientId:uuid,mediaType:z.enum(['audio','video']).default('audio')}),(req,data)=>svc.initiate(req.actor,data));
for(const action of ['answer','reject','end'])route('post','/calls/:id/'+action,null,req=>svc.transition(req.actor,req.params.id,action));
route('get','/calls/history',null,req=>svc.history(req.actor));
const server=app.listen(Number(process.env.PORT||4088),()=>console.log('QGICS listening'));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(async()=>{await db.close();process.exit(0)}));
