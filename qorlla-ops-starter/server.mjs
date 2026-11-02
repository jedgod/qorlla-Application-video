import express from 'express';
import helmet from 'helmet';
import pg from 'pg';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

for (const key of ['DATABASE_URL','JWT_ISSUER','JWT_AUDIENCE','JWKS_URI']) if (!process.env[key]) throw new Error(`Missing ${key}`);
const db = new pg.Pool({connectionString:process.env.DATABASE_URL, max:10});
const jwks = createRemoteJWKSet(new URL(process.env.JWKS_URI));
const app = express(); app.disable('x-powered-by'); app.use(helmet()); app.use(express.json({limit:'32kb'}));
const roles = new Set(['super_admin','ops_admin','supervisor','support_agent','billing_agent','technical_agent']);
async function auth(req,res,next) {
 try {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization||''); if(!m) return res.sendStatus(401);
  const {payload} = await jwtVerify(m[1],jwks,{issuer:process.env.JWT_ISSUER,audience:process.env.JWT_AUDIENCE});
  if(!payload.sub || !Array.isArray(payload.roles)) return res.sendStatus(403);
  req.actor={id:payload.sub,roles:payload.roles.filter(r=>roles.has(r))}; next();
 } catch {res.sendStatus(401);}
}
const allow=(...permitted)=>(req,res,next)=>req.actor.roles.some(r=>permitted.includes(r))?next():res.sendStatus(403);
const ticketSchema=z.object({customer_id:z.string().uuid(),category:z.enum(['meeting','audio','video','chat','billing','number','external_call','account','abuse','other']),subject:z.string().trim().min(3).max(200),description:z.string().trim().min(3).max(10000),priority:z.enum(['low','normal','high','critical']).default('normal')}).strict();
app.get('/healthz',(_req,res)=>res.json({status:'up'}));
app.post('/api/ops/tickets',auth,allow('super_admin','ops_admin','supervisor','support_agent','billing_agent','technical_agent'),async(req,res,next)=>{
 const parsed=ticketSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'invalid_input'});
 const client=await db.connect();try {await client.query('BEGIN');
 const {rows:[ticket]}=await client.query('INSERT INTO ops_tickets(customer_id,category,subject,description,priority) VALUES($1,$2,$3,$4,$5) RETURNING *',Object.values(parsed.data));
 await client.query('INSERT INTO ops_ticket_events(ticket_id,actor_id,event_type) VALUES($1,$2,$3)',[ticket.id,req.actor.id,'created']);
 await client.query('COMMIT');res.status(201).json(ticket);
 }catch(e){await client.query('ROLLBACK');next(e);}finally{client.release();}
});
app.get('/api/ops/tickets',auth,allow('super_admin','ops_admin','supervisor','support_agent','billing_agent','technical_agent'),async(req,res,next)=>{
 try{const {rows}=await db.query('SELECT id,customer_id,category,subject,priority,status,assignee_id,created_at FROM ops_tickets ORDER BY created_at DESC LIMIT 100');res.json({items:rows});}catch(e){next(e);}
});
app.post('/api/ops/external-call-requests',auth,allow('super_admin','ops_admin','billing_agent'),async(req,res,next)=>{
 const p=z.object({customer_id:z.string().uuid(),plan_code:z.string().regex(/^[A-Z0-9_-]{2,40}$/)}).strict().safeParse(req.body);
 if(!p.success)return res.status(400).json({error:'invalid_input'});
 try{const {rows:[item]}=await db.query('INSERT INTO ops_external_call_requests(customer_id,plan_code) VALUES($1,$2) RETURNING id,status,created_at',[p.data.customer_id,p.data.plan_code]);res.status(202).json(item);}catch(e){next(e);}
});
app.use((err,_req,res,_next)=>{console.error('request_error',err?.code||'internal');res.status(500).json({error:'internal_error'});});
app.listen(Number(process.env.PORT||6080),()=>console.log('Qorlla ops starter listening'));
