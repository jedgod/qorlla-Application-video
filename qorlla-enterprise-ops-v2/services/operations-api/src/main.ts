import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import pg from 'pg';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

const required=['DATABASE_URL','JWT_ISSUER','JWT_AUDIENCE','JWKS_URI'] as const;
for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}`);
const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:10});
const jwks=createRemoteJWKSet(new URL(process.env.JWKS_URI!));
const app=express(); app.disable('x-powered-by'); app.use(helmet()); app.use(express.json({limit:'32kb'}));
type Actor={id:string;roles:string[];tenantId:string};
type Authed=Request & {actor?:Actor};
const roles=new Set(['super_admin','ops_admin','supervisor','support_agent','billing_agent','technical_agent']);
async function authenticate(req:Authed,res:Response,next:NextFunction){
 try{
  const m=/^Bearer (.+)$/.exec(req.headers.authorization||''); if(!m){res.sendStatus(401);return;}
  const {payload}=await jwtVerify(m[1],jwks,{issuer:process.env.JWT_ISSUER,audience:process.env.JWT_AUDIENCE});
  if(!payload.sub||typeof payload.tenant_id!=='string'||!Array.isArray(payload.roles)){res.sendStatus(403);return;}
  req.actor={id:payload.sub,tenantId:payload.tenant_id,roles:payload.roles.filter((r):r is string=>typeof r==='string'&&roles.has(r))}; next();
 }catch{res.sendStatus(401);}
}
const allow=(...permitted:string[])=>(req:Authed,res:Response,next:NextFunction)=>req.actor?.roles.some(r=>permitted.includes(r))?next():res.sendStatus(403);
const ticket=z.object({customer_id:z.string().uuid(),category:z.enum(['meeting','audio','video','chat','billing','number','external_call','account','abuse','other']),subject:z.string().trim().min(3).max(200),description:z.string().trim().min(3).max(10000),priority:z.enum(['low','normal','high','critical']).default('normal')}).strict();
app.get('/healthz',(_req,res)=>res.json({status:'up'}));
app.get('/readyz',async(_req,res)=>{try{await db.query('SELECT 1');res.json({status:'ready'});}catch{res.status(503).json({status:'unavailable'});}});
app.get('/api/ops/tickets',authenticate,allow('super_admin','ops_admin','supervisor','support_agent','billing_agent','technical_agent'),async(req:Authed,res,next)=>{
 try{const {rows}=await db.query('SELECT id,customer_id,category,subject,priority,status,assignee_id,created_at FROM ops_tickets WHERE tenant_id=$1 AND ($2::boolean OR assignee_id=$3) ORDER BY created_at DESC LIMIT 100',[req.actor!.tenantId,req.actor!.roles.some(r=>['super_admin','ops_admin','supervisor'].includes(r)),req.actor!.id]);res.json({items:rows});}catch(e){next(e);}
});
app.post('/api/ops/tickets',authenticate,allow('super_admin','ops_admin','supervisor','support_agent','billing_agent','technical_agent'),async(req:Authed,res,next)=>{
 const p=ticket.safeParse(req.body);if(!p.success){res.status(400).json({error:'invalid_input'});return;}
 const client=await db.connect();try{await client.query('BEGIN');
 const {rows:[row]}=await client.query('INSERT INTO ops_tickets(tenant_id,customer_id,category,subject,description,priority,assignee_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,category,subject,priority,status,created_at',[req.actor!.tenantId,p.data.customer_id,p.data.category,p.data.subject,p.data.description,p.data.priority,req.actor!.id]);
 await client.query('INSERT INTO ops_ticket_events(tenant_id,ticket_id,actor_id,event_type) VALUES($1,$2,$3,$4)',[req.actor!.tenantId,row.id,req.actor!.id,'created']);await client.query('COMMIT');res.status(201).json(row);
 }catch(e){await client.query('ROLLBACK');next(e);}finally{client.release();}
});
app.post('/api/ops/tickets/:id/assign',authenticate,allow('super_admin','ops_admin','supervisor'),async(req:Authed,res,next)=>{
 const p=z.object({assignee_id:z.string().min(1).max(200)}).strict().safeParse(req.body);
 const id=z.string().uuid().safeParse(req.params.id);if(!p.success||!id.success){res.status(400).json({error:'invalid_input'});return;}
 const client=await db.connect();try{await client.query('BEGIN');
 const {rows:[row]}=await client.query('UPDATE ops_tickets SET assignee_id=$1,updated_at=now() WHERE id=$2 AND tenant_id=$3 RETURNING id,assignee_id',[p.data.assignee_id,id.data,req.actor!.tenantId]);
 if(!row){await client.query('ROLLBACK');res.sendStatus(404);return;}
 await client.query('INSERT INTO ops_ticket_events(tenant_id,ticket_id,actor_id,event_type,details) VALUES($1,$2,$3,$4,$5)',[req.actor!.tenantId,row.id,req.actor!.id,'assigned',JSON.stringify({assignee_id:row.assignee_id})]);await client.query('COMMIT');res.json(row);
 }catch(e){await client.query('ROLLBACK');next(e);}finally{client.release();}
});
app.post('/api/ops/external-call-requests',authenticate,allow('super_admin','ops_admin','billing_agent'),async(req:Authed,res,next)=>{
 const p=z.object({customer_id:z.string().uuid(),plan_code:z.string().regex(/^[A-Z0-9_-]{2,40}$/)}).strict().safeParse(req.body);
 if(!p.success){res.status(400).json({error:'invalid_input'});return;}
 try{const {rows:[row]}=await db.query('INSERT INTO ops_external_call_requests(tenant_id,customer_id,plan_code,requested_by) VALUES($1,$2,$3,$4) RETURNING id,status,created_at',[req.actor!.tenantId,p.data.customer_id,p.data.plan_code,req.actor!.id]);res.status(202).json(row);}catch(e){next(e);}
});
app.use((err:unknown,_req:Request,res:Response,_next:NextFunction)=>{console.error('ops_error',err instanceof Error?err.name:'unknown');res.status(500).json({error:'internal_error'});});
app.listen(Number(process.env.PORT||6080),'127.0.0.1',()=>console.log('Qorlla operations API ready'));
