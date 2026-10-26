import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { Server } from 'socket.io';

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) throw Error('Set JWT_SECRET (32+ chars)');
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '32kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: 'draft-7', legacyHeaders: false }));
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
 const code=normalizeCode(value);
 if(isUuid(code)) return code;
 if(!/^\d{10,12}$/.test(code)) return null;
 const {rows}=await db.query('SELECT id FROM meetings WHERE meeting_code=$1',[code]);
 return rows[0]?.id || null;
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
app.post('/api/meetings/:id/join', async(req,res) => {
 const name=clean(req.body.name,70), passcode=clean(req.body.passcode,100), hostSecret=clean(req.body.hostSecret,100);
 if(!name) return fail(res,400,'Display name required');
 try {
  const resolved=await resolveMeeting(req.params.id);
  if(!resolved) return fail(res,404,'Meeting unavailable');
  const {rows}=await db.query('SELECT * FROM meetings WHERE id=$1',[resolved]);
  if(!rows.length || rows[0].ended_at) return fail(res,404,'Meeting unavailable');
  const m=rows[0]; const host=!!hostSecret && await bcrypt.compare(hostSecret,m.host_secret_hash);
  if(m.locked && !host) return fail(res,403,'Meeting locked');
  if(!host && m.passcode_hash && !(await bcrypt.compare(passcode,m.passcode_hash))) return fail(res,403,'Invalid passcode');
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
 try {const id=await resolveMeeting(req.params.code);if(!id)return fail(res,404,'Meeting unavailable');res.json({meetingId:id});}
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
