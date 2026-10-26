import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import pg from 'pg';
import {z} from 'zod';
import path from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const app=express(); const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
app.use(helmet({contentSecurityPolicy:false}));app.use(express.json({limit:'128kb'}));
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
app.use(express.static(root));
// Shared MAIN identity: MAIN issues a short-lived RS256/ES256 JWT in a secure,
// HttpOnly, same-site cookie. Portal verifies it against MAIN's published JWKS.
// Both apps must be behind the same HTTPS origin. No development identity fallback.
const issuer=process.env.MAIN_AUTH_ISSUER;
const audience=process.env.PORTAL_AUTH_AUDIENCE || 'qorlla-workplace';
const jwksUrl=process.env.MAIN_AUTH_JWKS_URL;
const authConfigured=Boolean(issuer && jwksUrl && process.env.PORTAL_ALLOWED_ORIGIN);
const jwks=authConfigured?createRemoteJWKSet(new URL(jwksUrl)):null;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function cookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.includes('=')).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)]}));}
const safeMethod=m=>['GET','HEAD','OPTIONS'].includes(m);
app.use('/api/v1',(req,res,next)=>{
  if(safeMethod(req.method))return next();
  // Enforce same-origin for browser writes, including requests without Origin.
  const expected=process.env.PORTAL_ALLOWED_ORIGIN;
  if(!expected || req.get('origin')!==expected || req.get('sec-fetch-site')==='cross-site')return res.status(403).json({error:'Origin rejected'});
  const c=cookies(req);
  if(!c.qorlla_csrf || !req.get('x-csrf-token'))return res.status(403).json({error:'CSRF token required'});
  const a=Buffer.from(c.qorlla_csrf),b=Buffer.from(req.get('x-csrf-token'));
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b))return res.status(403).json({error:'CSRF token invalid'});
  next();
});
async function authenticate(req,res,next){
  if(!authConfigured)return res.status(503).json({error:'MAIN authentication not configured'});
  const token=cookies(req).qorlla_portal_session;
  if(!token)return res.status(401).json({error:'Sign in required'});
  try{
    const {payload}=await jwtVerify(token,jwks,{issuer,audience,algorithms:['RS256','ES256'],clockTolerance:5,maxTokenAge:'15m'});
    if(!uuid.test(payload.sub||''))return res.status(401).json({error:'Invalid identity'});
    req.actor=payload.sub;
    // Workspace is selected by server-side membership; never trust a workspace claim.
    const requested=req.get('x-workspace-id');
    if(requested && !uuid.test(requested))return res.status(400).json({error:'Invalid workspace'});
    const rows=await pool.query('SELECT workspace_id,role FROM portal.members WHERE user_id=$1 ORDER BY workspace_id',[req.actor]);
    if(!rows.rowCount)return res.status(403).json({error:'No workspace membership'});
    const member=requested?rows.rows.find(r=>r.workspace_id===requested):rows.rows[0];
    if(!member)return res.status(403).json({error:'Not a workspace member'});
    req.workspace=member.workspace_id;req.role=member.role;
    next();
  }catch(e){if(e.code?.startsWith('ERR_JWT')||e.code?.startsWith('ERR_JWS')||e.code==='ERR_JWK_MULTIPLE_MATCHING_KEYS')return res.status(401).json({error:'Session invalid or expired'});next(e)}
}
app.get('/api/v1/session',authenticate,(req,res)=>res.json({user_id:req.actor,workspace_id:req.workspace,role:req.role}));
app.get('/api/v1/workspaces',authenticate,async(req,res,next)=>{try{res.json((await pool.query('SELECT m.workspace_id,w.name,m.role FROM portal.members m JOIN portal.workspaces w ON w.id=m.workspace_id WHERE m.user_id=$1 ORDER BY w.name',[req.actor])).rows)}catch(e){next(e)}});
app.use('/api/v1',(req,res,next)=>{
  if(['/health','/products','/plans'].includes(req.path) && req.method==='GET')return next();
  return authenticate(req,res,next);
});
async function authorized(req,res,next){try{const r=await pool.query('SELECT role FROM portal.members WHERE workspace_id=$1 AND user_id=$2',[req.workspace,req.actor]);if(!r.rowCount)return res.status(403).json({error:'Not a workspace member'});req.role=r.rows[0].role;next()}catch(e){next(e)}}
app.get('/api/v1/health',async(req,res,next)=>{try{await pool.query('SELECT 1');res.json({status:'ok'})}catch(e){next(e)}});
app.get('/api/v1/products',async(req,res,next)=>{try{res.json((await pool.query('SELECT * FROM portal.products WHERE enabled=true ORDER BY name')).rows)}catch(e){next(e)}});
app.get('/api/v1/plans',async(req,res,next)=>{try{res.json((await pool.query('SELECT * FROM portal.plans ORDER BY monthly_cents NULLS LAST')).rows)}catch(e){next(e)}});
app.get('/api/v1/workspace',authorized,async(req,res,next)=>{try{const q=await pool.query('SELECT w.id,w.name,s.plan_slug FROM portal.workspaces w LEFT JOIN portal.subscriptions s ON s.workspace_id=w.id WHERE w.id=$1',[req.workspace]);res.json(q.rows[0]||null)}catch(e){next(e)}});
app.get('/api/v1/notes',authorized,async(req,res,next)=>{try{res.json((await pool.query('SELECT * FROM portal.notes WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 100',[req.workspace])).rows)}catch(e){next(e)}});
app.post('/api/v1/notes',authorized,async(req,res,next)=>{try{const p=z.object({title:z.string().trim().min(1).max(160),body:z.string().max(50000).default('')}).parse(req.body);const q=await pool.query('INSERT INTO portal.notes(workspace_id,author_id,title,body) VALUES($1,$2,$3,$4) RETURNING *',[req.workspace,req.actor,p.title,p.body]);res.status(201).json(q.rows[0])}catch(e){next(e)}});
app.get('/api/v1/support/tickets',authorized,async(req,res,next)=>{try{res.json((await pool.query('SELECT * FROM portal.support_tickets WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100',[req.workspace])).rows)}catch(e){next(e)}});
app.post('/api/v1/support/tickets',authorized,async(req,res,next)=>{try{const p=z.object({subject:z.string().trim().min(3).max(160),details:z.string().trim().min(5).max(10000)}).parse(req.body);const q=await pool.query('INSERT INTO portal.support_tickets(workspace_id,author_id,subject,details) VALUES($1,$2,$3,$4) RETURNING *',[req.workspace,req.actor,p.subject,p.details]);res.status(201).json(q.rows[0])}catch(e){next(e)}});
app.get('/api/v1/reports',authorized,async(req,res,next)=>{try{res.json((await pool.query('SELECT * FROM portal.meeting_reports WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100',[req.workspace])).rows)}catch(e){next(e)}});
app.get('/api/v1/usage',authorized,async(req,res,next)=>{try{res.json((await pool.query('SELECT feature,SUM(units)::int AS units FROM portal.usage_events WHERE workspace_id=$1 GROUP BY feature',[req.workspace])).rows)}catch(e){next(e)}});
app.get('/api/v1/:module/status',authorized,(req,res)=>{const allowed=['meet','receptionist','phone','mate','suite','billing','solutions','ai'];if(!allowed.includes(req.params.module))return res.status(404).json({error:'Unknown module'});res.json({module:req.params.module,status:'integration_required',message:'UI available. Live provider/API integration is not yet configured.'})});
app.get('/app/*',(req,res)=>res.sendFile(path.join(root,'index.html')));
app.use((err,req,res,next)=>{if(err instanceof z.ZodError)return res.status(400).json({error:'Invalid input',issues:err.issues});console.error(err);res.status(500).json({error:'Server error'})});
app.listen(Number(process.env.PORT||5500),()=>console.log('Qorlla portal at http://localhost:'+(process.env.PORT||5500)));
