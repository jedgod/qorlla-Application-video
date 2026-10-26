import './threadpool.js';
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// Native bcrypt (libuv thread pool). The pure-JS implementation blocks the event loop: 200 concurrent joins took 15 s p95.
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { Server } from 'socket.io';
import { recoveryService } from './recovery-service.mjs';

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) throw Error('Set JWT_SECRET (32+ chars)');
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.disable('x-powered-by');
// Behind nginx the client address comes from X-Forwarded-For: set TRUST_PROXY_HOPS=1 (number of trusted proxies).
// Left at 0 by default so a directly exposed server cannot be spoofed into sharing/evading rate limits.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 0) || false);
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'], mediaSrc: ["'self'", 'blob:', 'mediastream:'],
      connectSrc: ["'self'", 'ws:', 'wss:'], fontSrc: ["'self'"], objectSrc: ["'none'"],
      baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"]
    }
  },
  referrerPolicy: { policy: 'no-referrer' }
}));
app.use(express.json({ limit: '32kb' }));
const rateOpts = { windowMs: 60_000, standardHeaders: 'draft-7', legacyHeaders: false };
// Private bridge traffic (MAIN's sync worker) has its own, higher budget so scheduling throughput is not starved
// by the browser-facing limit, but it is still capped to bound bridge-secret guessing.
const bridgeLimiter = rateLimit({ ...rateOpts, limit: Number(process.env.BRIDGE_RATE_LIMIT || 1200) });
const apiLimiter = rateLimit({ ...rateOpts, limit: Number(process.env.API_RATE_LIMIT || 90) });
app.use('/api', (req, res, next) => (req.path.startsWith('/integrations/') ? bridgeLimiter : apiLimiter)(req, res, next));
const server = createServer(app);
const io = new Server(server, { cors: { origin: process.env.CORS_ORIGIN || false }, maxHttpBufferSize: 16_384 });
const directory = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
app.use(express.static(directory));
const clean = (s, max) => typeof s === 'string' ? s.trim().slice(0, max) : '';
const fail = (res, status, error) => res.status(status).json({ error });
const sign = (p) => jwt.sign(p, SECRET, { expiresIn: '8h', issuer: 'qorlla-meet' });
const verify = (token) => jwt.verify(token, SECRET, { issuer: 'qorlla-meet' });
const audit = (meetingId, participantId, eventType, detail={}) => db.query('INSERT INTO audit_events(meeting_id,participant_id,event_type,detail) VALUES($1,$2,$3,$4)', [meetingId,participantId,eventType,JSON.stringify(detail)]).catch(console.error);
const room = id => `meeting:${id}`;
const isUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const normalizeCode = value => String(value || '').replace(/[\s-]/g, '');
const resolveMeeting = async value => {
 // Check for a UUID BEFORE stripping hyphens: normalizeCode() would otherwise destroy the UUID's own hyphens.
 if(isUuid(String(value||'').trim())) return String(value).trim().toLowerCase();
 const code=normalizeCode(value);
 if(!/^\d{10,12}$/.test(code)) return null;
 const {rows}=await db.query('SELECT id FROM meetings WHERE meeting_code=$1',[code]);
 if(rows[0]) return rows[0].id;
 const alias=await db.query('SELECT meeting_id FROM meeting_code_aliases WHERE alias_code=$1',[code]);
 return alias.rows[0]?.meeting_id || null;
};
const createCode = () => { const bytes = randomBytes(6); return Array.from(bytes, b => String(b % 100).padStart(2,'0')).join(''); };

const active = new Map(); // meetingId -> Map(participantId -> socketId); single active socket per participant
const activeList = id => [...(active.get(id)?.keys() || [])];
const auth = (req,res,next) => { try { req.user=verify((req.headers.authorization||'').replace(/^Bearer /,'')); next(); } catch { fail(res,401,'Authentication required'); } };
const member = async (req,res,next) => {
 try {
  if (req.user.meetingId !== req.params.id) return fail(res,403,'Wrong meeting');
  const { rows } = await db.query('SELECT m.ended_at, p.id FROM meetings m JOIN participants p ON p.meeting_id=m.id WHERE m.id=$1 AND p.id=$2',[req.params.id,req.user.participantId]);
  if (!rows.length || rows[0].ended_at) return fail(res,403,'Meeting unavailable');
  next();
 } catch { fail(res,500,'Database unavailable'); }
};
// Server-to-server schedule reconciliation. Never call this from browser JavaScript.
const bridgeAuth=(req,res,next)=>{
 const expected=process.env.QORLLA_BRIDGE_SECRET||'';
 const provided=req.get('x-qorlla-bridge-secret')||'';
 if(!expected || expected.length<32 || provided.length!==expected.length ||
    !timingSafeEqual(Buffer.from(provided),Buffer.from(expected))) return fail(res,401,'Bridge authentication required');
 next();
};
const validSource=v=>typeof v==='string'&&/^[a-zA-Z0-9_.:-]{1,120}$/.test(v);
const isValidDate=v=>v===null||(typeof v==='string'&&Number.isFinite(Date.parse(v)));
const scheduleStates=new Set(['scheduled','cancelled']);
// Main hashes scheduled-meeting passcodes (bcrypt) itself; Meet only ever receives the hash, never the passcode.
const validPasscodeHash=v=>v===null||v===undefined||(typeof v==='string'&&/^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(v));
app.post('/api/integrations/scheduled-meetings',bridgeAuth,async(req,res)=>{
 const sourceId=req.body?.sourceId, title=clean(req.body?.title,160),
       legacyCode=normalizeCode(req.body?.legacyCode), ownerName=clean(req.body?.ownerName,70),
       scheduledAt=req.body?.scheduledAt ?? null;
 if(!validSource(sourceId)||!title||!ownerName||
    (legacyCode && !/^\d{10,12}$/.test(legacyCode)) ||
    !isValidDate(scheduledAt) || !validPasscodeHash(req.body?.passcodeHash))
   return fail(res,400,'Invalid scheduled meeting data');
 const client=await db.connect().catch(()=>null);
 if(!client)return fail(res,503,'Database unavailable');
 try{
  await client.query('BEGIN');
  // Advisory transaction lock serializes concurrent retries of this source ID.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['qorlla:'+sourceId]);
  const existing=await client.query('SELECT s.meeting_id,m.meeting_code,m.title FROM external_meeting_links s JOIN meetings m ON m.id=s.meeting_id WHERE s.source_system=$1 AND s.source_id=$2',['qorlla-main',sourceId]);
  if(existing.rows.length){
   const e=existing.rows[0];
   if(legacyCode){const aliases=await client.query('SELECT meeting_id FROM meeting_code_aliases WHERE alias_code=$1',[legacyCode]);
    if(aliases.rows.length&&aliases.rows[0].meeting_id!==e.meeting_id){await client.query('ROLLBACK');return fail(res,409,'Legacy code already mapped');}
    const primary=await client.query('SELECT id FROM meetings WHERE meeting_code=$1',[legacyCode]);
    if(primary.rows.length&&primary.rows[0].id!==e.meeting_id){await client.query('ROLLBACK');return fail(res,409,'Legacy code already in use');}
    await client.query('INSERT INTO meeting_code_aliases(alias_code,meeting_id) VALUES($1,$2) ON CONFLICT(alias_code) DO NOTHING',[legacyCode,e.meeting_id]);
   }
   await client.query('COMMIT');return res.json({meetingId:e.meeting_id,meetingCode:e.meeting_code,sourceId,created:false});
  }
  if(legacyCode){const conflict=await client.query('SELECT id FROM meetings WHERE meeting_code=$1 UNION SELECT meeting_id AS id FROM meeting_code_aliases WHERE alias_code=$1',[legacyCode]);
   if(conflict.rows.length){await client.query('ROLLBACK');return fail(res,409,'Legacy code already in use');}}
  const id=randomUUID(), hostSecret=randomUUID();let meetingCode;
  for(let i=0;i<8;i++){
   const candidate=createCode();
   const found=await client.query('SELECT 1 FROM meetings WHERE meeting_code=$1 UNION SELECT 1 FROM meeting_code_aliases WHERE alias_code=$1',[candidate]);
   if(!found.rows.length&&candidate!==legacyCode){meetingCode=candidate;break;}
  }
  if(!meetingCode)throw Error('Unable to allocate meeting code');
  await client.query('INSERT INTO meetings(id,title,host_secret_hash,meeting_code,passcode_hash) VALUES($1,$2,$3,$4,$5)',[id,title,await bcrypt.hash(hostSecret,10),meetingCode,req.body?.passcodeHash??null]);
  await client.query('INSERT INTO external_meeting_links(source_system,source_id,meeting_id,scheduled_at) VALUES($1,$2,$3,$4)',['qorlla-main',sourceId,id,scheduledAt]);
  if(legacyCode)await client.query('INSERT INTO meeting_code_aliases(alias_code,meeting_id) VALUES($1,$2)',[legacyCode,id]);
  await client.query('COMMIT');
  // Host secret is only returned once, to the trusted scheduling backend.
  return res.status(201).json({meetingId:id,meetingCode,sourceId,created:true,hostSecret});
 }catch(e){await client.query('ROLLBACK').catch(()=>{});if(e.code==='23505')return fail(res,409,'Meeting mapping conflict');console.error(e);return fail(res,500,'Reconciliation failed');}
 finally{client.release();}
});
// v3.9: host credential recovery with stable request ID + acknowledgment (replaces v3.8 blind rotation).
// Bridge-only; the caller must authorize the schedule. Responses are never cached or logged.
const recovery=process.env.RECOVERY_ESCROW_KEY?recoveryService(db,Buffer.from(process.env.RECOVERY_ESCROW_KEY,'base64'),{hashSecret:s=>bcrypt.hash(s,10),verifySecret:(s,h)=>bcrypt.compare(s,h)}):null;
const recoveryRoute=(name,run)=>app.post('/api/integrations/scheduled-meetings/:sourceId/'+name,bridgeAuth,async(req,res)=>{
 res.set('Cache-Control','no-store');
 if(!recovery)return fail(res,503,'Host recovery not configured');
 if(!validSource(req.params.sourceId))return fail(res,400,'Invalid source ID');
 try{const out=await run(req);const link=await db.query("SELECT meeting_id FROM external_meeting_links WHERE source_system='qorlla-main' AND source_id=$1",[req.params.sourceId]);if(link.rowCount)audit(link.rows[0].meeting_id,null,'host.recovery_'+name,{generation:out.generation});return res.json(out);}
 catch(e){if(e.status)return fail(res,e.status,e.message);console.error('Host recovery failed');return fail(res,503,'Host recovery unavailable');}
});
recoveryRoute('recover-host',req=>recovery.issue({sourceId:req.params.sourceId,requestId:String(req.body?.requestId||'')}));
recoveryRoute('ack-host',req=>recovery.acknowledge({sourceId:req.params.sourceId,requestId:String(req.body?.requestId||''),generation:Number(req.body?.generation),hostSecret:req.body?.hostSecret}));
app.get('/api/integrations/scheduled-meetings/:sourceId',bridgeAuth,async(req,res)=>{
 if(!validSource(req.params.sourceId))return fail(res,400,'Invalid source ID');
 try{const {rows}=await db.query('SELECT s.source_id AS "sourceId",s.meeting_id AS "meetingId",m.meeting_code AS "meetingCode",s.scheduled_at AS "scheduledAt" FROM external_meeting_links s JOIN meetings m ON m.id=s.meeting_id WHERE s.source_system=$1 AND s.source_id=$2',['qorlla-main',req.params.sourceId]);
 if(!rows.length)return fail(res,404,'Not registered');res.json(rows[0]);}catch{fail(res,503,'Database unavailable');}
});
// v3.2: idempotent schedule metadata synchronization. Never revive ended sessions.
app.patch('/api/integrations/scheduled-meetings/:sourceId',bridgeAuth,async(req,res)=>{
 if(!validSource(req.params.sourceId))return fail(res,400,'Invalid source ID');
 const title=req.body?.title===undefined?undefined:clean(req.body.title,160);
 const scheduledAt=req.body?.scheduledAt;
 if((title!==undefined&&!title)||(scheduledAt!==undefined&&!isValidDate(scheduledAt))||!validPasscodeHash(req.body?.passcodeHash))return fail(res,400,'Invalid schedule update');
 const client=await db.connect().catch(()=>null);if(!client)return fail(res,503,'Database unavailable');
 try{await client.query('BEGIN');
 const {rows}=await client.query('SELECT meeting_id FROM external_meeting_links WHERE source_system=$1 AND source_id=$2 FOR UPDATE',['qorlla-main',req.params.sourceId]);
 if(!rows.length){await client.query('ROLLBACK');return fail(res,404,'Not registered');}
 if(title!==undefined)await client.query('UPDATE meetings SET title=$1 WHERE id=$2 AND ended_at IS NULL',[title,rows[0].meeting_id]);
 if(req.body?.passcodeHash!==undefined)await client.query('UPDATE meetings SET passcode_hash=$1 WHERE id=$2 AND ended_at IS NULL',[req.body.passcodeHash,rows[0].meeting_id]);
 if(scheduledAt!==undefined)await client.query('UPDATE external_meeting_links SET scheduled_at=$1 WHERE source_system=$2 AND source_id=$3',[scheduledAt,'qorlla-main',req.params.sourceId]);
 await client.query('COMMIT');res.json({ok:true,meetingId:rows[0].meeting_id});
 }catch(e){await client.query('ROLLBACK').catch(()=>{});console.error(e);fail(res,500,'Schedule update failed');}finally{client.release();}
});
// v3.3: cancellation is terminal and idempotent; cannot be used to reopen a meeting.
app.post('/api/integrations/scheduled-meetings/:sourceId/cancel',bridgeAuth,async(req,res)=>{
 if(!validSource(req.params.sourceId))return fail(res,400,'Invalid source ID');
 try{const {rows}=await db.query(`UPDATE meetings SET ended_at=COALESCE(ended_at,now()) WHERE id=(SELECT meeting_id FROM external_meeting_links WHERE source_system=$1 AND source_id=$2) RETURNING id`,['qorlla-main',req.params.sourceId]);
 if(!rows.length)return fail(res,404,'Not registered');io.to(room(rows[0].id)).emit('meeting-ended');audit(rows[0].id,null,'schedule.cancelled');res.json({ok:true,meetingId:rows[0].id});
 }catch(e){console.error(e);fail(res,503,'Cancellation failed');}
});
// v3.4: readiness probe includes DB and required bridge configuration.
app.get('/api/ready',async(_req,res)=>{
 try{await db.query('SELECT 1');const bridgeConfigured=!!process.env.QORLLA_BRIDGE_SECRET&&process.env.QORLLA_BRIDGE_SECRET.length>=32;
 res.status(bridgeConfigured?200:503).json({ready:bridgeConfigured,database:'ok',bridgeConfigured});
 }catch{res.status(503).json({ready:false,database:'unavailable'});}
});
app.get('/api/config', (_req,res) => { let iceServers=[]; try { iceServers=JSON.parse(process.env.ICE_SERVERS_JSON||'[]'); } catch {} res.json({iceServers}); });
app.post('/api/meetings', async (req,res) => {
 const title=clean(req.body.title,160), name=clean(req.body.name,70), passcode=clean(req.body.passcode,100);
 if (!title || !name) return fail(res,400,'Title and display name required');
 const id=randomUUID(), pid=randomUUID(), hostSecret=randomUUID(), meetingCode=createCode();
 const client=await db.connect().catch(()=>null);
 if(!client) return fail(res,503,'Database unavailable');
 try {
  await client.query('BEGIN');
  await client.query('INSERT INTO meetings(id,title,host_secret_hash,passcode_hash,meeting_code) VALUES($1,$2,$3,$4,$5)',[id,title,await bcrypt.hash(hostSecret,10),passcode?await bcrypt.hash(passcode,10):null,meetingCode]);
  await client.query('INSERT INTO participants(id,meeting_id,display_name,role) VALUES($1,$2,$3,$4)',[pid,id,name,'host']);
  await client.query('COMMIT');
  res.status(201).json({meetingId:id, meetingCode, participantId:pid, token:sign({meetingId:id,participantId:pid,role:'host',name}),hostSecret});
  audit(id,pid,'meeting.created');
 } catch(e) { await client.query('ROLLBACK'); console.error(e); fail(res,500,'Unable to create meeting'); } finally {client.release();}
});
// Join-failure throttle: bcrypt makes each passcode guess costly, but a public 12-digit code is guessable-by-design,
// so failed joins are capped per (client, meeting) and per meeting overall within a sliding window.
const FAIL_WINDOW_MS=10*60_000, FAIL_PER_CLIENT=Number(process.env.JOIN_FAIL_PER_CLIENT||8), FAIL_PER_MEETING=Number(process.env.JOIN_FAIL_PER_MEETING||60);
const joinFails=new Map();
const failKey=k=>{const now=Date.now();const a=(joinFails.get(k)||[]).filter(t=>now-t<FAIL_WINDOW_MS);if(a.length)joinFails.set(k,a);else joinFails.delete(k);return a;};
const joinBlocked=(ip,mid)=>failKey('c|'+ip+'|'+mid).length>=FAIL_PER_CLIENT||failKey('m|'+mid).length>=FAIL_PER_MEETING;
const joinFailed=(ip,mid)=>{for(const k of ['c|'+ip+'|'+mid,'m|'+mid]){const a=failKey(k);a.push(Date.now());joinFails.set(k,a);}};
setInterval(()=>{for(const k of [...joinFails.keys()])failKey(k);},60_000).unref();
app.post('/api/meetings/:id/join', async(req,res) => {
 const name=clean(req.body.name,70), passcode=clean(req.body.passcode,100), hostSecret=clean(req.body.hostSecret,100);
 if(!name) return fail(res,400,'Display name required');
 try {
  const resolved=await resolveMeeting(req.params.id);
  if(!resolved) return fail(res,404,'Meeting unavailable');
  if(joinBlocked(req.ip,resolved)){res.set('Retry-After','600');return fail(res,429,'Too many failed attempts. Try again later.');}
  const {rows}=await db.query('SELECT * FROM meetings WHERE id=$1',[resolved]);
  if(!rows.length || rows[0].ended_at) return fail(res,404,'Meeting unavailable');
  const m=rows[0]; const host=!!hostSecret && await bcrypt.compare(hostSecret,m.host_secret_hash);
  if(m.locked && !host) return fail(res,403,'Meeting locked');
  if(!host && m.passcode_hash && !(await bcrypt.compare(passcode,m.passcode_hash))){joinFailed(req.ip,m.id);return fail(res,403,'Invalid passcode');}
  const pid=randomUUID(), role=host?'host':'guest';
  await db.query('INSERT INTO participants(id,meeting_id,display_name,role) VALUES($1,$2,$3,$4)',[pid,m.id,name,role]);
  res.json({meetingId:m.id,meetingCode:m.meeting_code,participantId:pid,token:sign({meetingId:m.id,participantId:pid,role,name})});
  audit(m.id,pid,'participant.joined');
 } catch(e) { if(e.code==='22P02') return fail(res,400,'Invalid meeting ID'); console.error(e); fail(res,500,'Join failed'); }
});
app.get('/api/meetings/:id',auth,member,async(req,res)=>{
 const {rows:[m]}=await db.query('SELECT id,meeting_code,title,created_at,notes,locked FROM meetings WHERE id=$1',[req.params.id]);
 const {rows:messages}=await db.query('SELECT p.display_name AS name, x.id,x.body,x.created_at FROM messages x JOIN participants p ON p.id=x.participant_id WHERE x.meeting_id=$1 ORDER BY x.created_at DESC LIMIT 100',[req.params.id]);
 const {rows:polls}=await db.query('SELECT id,question,options FROM polls WHERE meeting_id=$1 ORDER BY created_at DESC LIMIT 30',[req.params.id]);
 res.json({...m,messages:messages.reverse(),polls,online:activeList(req.params.id)});
});
app.post('/api/meetings/:id/lock',auth,member,async(req,res)=>{
 if(req.user.role!=='host')return fail(res,403,'Host only');
 if(typeof req.body.locked!=='boolean')return fail(res,400,'locked must be boolean');
 await db.query('UPDATE meetings SET locked=$1 WHERE id=$2',[req.body.locked,req.params.id]);
 io.to(room(req.params.id)).emit('meeting-locked',{locked:req.body.locked});
 audit(req.params.id,req.user.participantId,'meeting.lock_changed',{locked:req.body.locked});
 res.json({ok:true,locked:req.body.locked});
});
app.get('/api/resolve/:code',async(req,res)=>{
 try {const id=await resolveMeeting(req.params.code);if(!id)return fail(res,404,'Meeting unavailable');const {rows}=await db.query('SELECT ended_at FROM meetings WHERE id=$1',[id]);if(!rows.length||rows[0].ended_at)return fail(res,404,'Meeting unavailable');res.json({meetingId:id});}
 catch {fail(res,503,'Database unavailable');}
});
app.post('/api/meetings/:id/end',auth,member,async(req,res)=>{
 if(req.user.role!=='host') return fail(res,403,'Host only');
 await db.query('UPDATE meetings SET ended_at=now() WHERE id=$1',[req.params.id]);
 io.to(room(req.params.id)).emit('meeting-ended');
 audit(req.params.id,req.user.participantId,'meeting.ended'); res.json({ok:true});
});
app.get('/api/health',async(_req,res)=>{try{await db.query('SELECT 1');res.json({ok:true});}catch{res.status(503).json({ok:false});}});
const ackError=(ack,message)=>typeof ack==='function'&&ack({ok:false,error:message});
io.use(async(socket,next)=>{
 try {
  const user=verify(socket.handshake.auth?.token);
  const {rows}=await db.query('SELECT m.ended_at,p.id FROM meetings m JOIN participants p ON p.meeting_id=m.id WHERE m.id=$1 AND p.id=$2',[user.meetingId,user.participantId]);
  if(!rows.length||rows[0].ended_at) throw Error('Meeting unavailable');
  socket.data.user=user;next();
 } catch { next(new Error('Unauthorized')); }
});
io.on('connection',socket=>{
 const u=socket.data.user, id=u.meetingId, pid=u.participantId;
 // Flood control: signalling is exempt (WebRTC negotiation bursts); every other event shares a sliding budget.
 const BUDGET=Number(process.env.SOCKET_EVENT_BUDGET||40), BUDGET_MS=10_000; let stamps=[];
 socket.use(([event,...args],next)=>{
  if(event==='signal')return next();
  const now=Date.now();stamps=stamps.filter(t=>now-t<BUDGET_MS);
  if(stamps.length>=BUDGET){const ack=args.find(a=>typeof a==='function');if(ack)ack({ok:false,error:'Rate limited'});return;}
  stamps.push(now);next();
 });
 if(!active.has(id)) active.set(id,new Map());
 const roster=active.get(id);
 const prior=roster.get(pid);
 if(prior && prior!==socket.id) io.sockets.sockets.get(prior)?.disconnect(true);
 roster.set(pid,socket.id); socket.join(room(id));
 socket.emit('roster',activeList(id));
 socket.to(room(id)).emit('participant-online',{participantId:pid,name:u.name,role:u.role});
 const isOnline=(target)=>roster.get(target);
 socket.on('signal',({to,data}={},ack)=>{
  if(typeof to!=='string'||!data||!['offer','answer','candidate'].includes(data.type)) return ackError(ack,'Invalid signal');
  const target=isOnline(to); if(!target) return ackError(ack,'Participant offline');
  io.to(target).emit('signal',{from:pid,data}); if(typeof ack==='function')ack({ok:true});
 });
 socket.on('chat',async(body,ack)=>{
  body=clean(body,4000); if(!body)return ackError(ack,'Empty message');
  try {const mid=randomUUID();const {rows:[msg]}=await db.query('INSERT INTO messages(id,meeting_id,participant_id,body) VALUES($1,$2,$3,$4) RETURNING created_at',[mid,id,pid,body]);
   io.to(room(id)).emit('chat',{id:mid,name:u.name,body,created_at:msg.created_at}); if(typeof ack==='function')ack({ok:true});
  } catch {ackError(ack,'Message failed');}
 });
 socket.on('hand',raised=>{socket.to(room(id)).emit('hand',{participantId:pid,raised:!!raised});});
 socket.on('media-state',state=>{socket.to(room(id)).emit('media-state',{participantId:pid,mic:!!state?.mic,cam:!!state?.cam,sharing:!!state?.sharing});});
 socket.on('reaction',emoji=>{if(['👍','👏','❤️','🎉','😂'].includes(emoji))io.to(room(id)).emit('reaction',{name:u.name,emoji});});
 socket.on('notes',async(text,ack)=>{
  if(u.role!=='host')return ackError(ack,'Host only');
  text=clean(text,12000);
  try{await db.query('UPDATE meetings SET notes=$1 WHERE id=$2',[text,id]);socket.to(room(id)).emit('notes',text);if(typeof ack==='function')ack({ok:true});}catch{ackError(ack,'Save failed');}
 });
 socket.on('poll-create',async(data,ack)=>{
  if(u.role!=='host')return ackError(ack,'Host only');
  const question=clean(data?.question,300),options=Array.isArray(data?.options)?data.options.map(s=>clean(s,100)).filter(Boolean).slice(0,8):[];
  if(!question||options.length<2)return ackError(ack,'Question and two options required');
  try{const poll={id:randomUUID(),question,options};await db.query('INSERT INTO polls(id,meeting_id,question,options) VALUES($1,$2,$3,$4)',[poll.id,id,question,JSON.stringify(options)]);io.to(room(id)).emit('poll-created',poll);ack?.({ok:true});}catch{ackError(ack,'Poll failed');}
 });
 socket.on('poll-vote',async({pollId,choice}={},ack)=>{
  if(!Number.isInteger(choice)||choice<0||choice>7)return ackError(ack,'Invalid choice');
  try{const {rows:[poll]}=await db.query('SELECT options FROM polls WHERE id=$1 AND meeting_id=$2',[pollId,id]);if(!poll||choice>=poll.options.length)return ackError(ack,'Invalid poll');
   await db.query('INSERT INTO poll_votes(poll_id,participant_id,choice) VALUES($1,$2,$3) ON CONFLICT(poll_id,participant_id) DO UPDATE SET choice=EXCLUDED.choice',[pollId,pid,choice]);
   const {rows}=await db.query('SELECT choice,count(*)::int AS count FROM poll_votes WHERE poll_id=$1 GROUP BY choice',[pollId]);io.to(room(id)).emit('poll-results',{pollId,counts:rows});ack?.({ok:true});
  }catch{ackError(ack,'Vote failed');}
 });
 socket.on('disconnect',()=>{if(roster.get(pid)!==socket.id)return;roster.delete(pid);socket.to(room(id)).emit('participant-offline',{participantId:pid});db.query('UPDATE participants SET left_at=now() WHERE id=$1',[pid]).catch(console.error);});
});
server.listen(PORT,()=>console.log(`Qorlla Meet listening on http://localhost:${PORT}`));
