import http from 'node:http';import express from 'express';import helmet from 'helmet';import {WebSocketServer,WebSocket} from 'ws';
import {authenticate,bearer} from './auth.mjs';import {pool,identity,createCall,getCall,transition} from './store.mjs';
import {validExtension,validCallId,safeSignal,turnCredentials} from './core.mjs';
const app=express();app.disable('x-powered-by');app.use(helmet());app.use(express.json({limit:'16kb'}));
const sockets=new Map();const send=(account,payload)=>{for(const ws of sockets.get(account)||[]) if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(payload));};
const auth=async(req,res,next)=>{try{const token=bearer(req);if(!token) return res.status(401).json({error:'unauthorized'});req.account=await authenticate(token);next();}catch{res.status(401).json({error:'unauthorized'});}};
const err=(res,e)=>{const known={invalid_recipient:404,not_found:404,blocked:403,forbidden:403,caller_disabled:403,busy:409,invalid_transition:409};const status=known[e.message]||500;res.status(status).json({error:status===500?'internal_error':e.message});};
app.get('/healthz',(_req,res)=>res.json({ok:true,service:'qorlla-voice',pstn:false}));
app.get('/v1/voice/me',auth,async(req,res)=>{try{res.json({identity:await identity(req.account)})}catch(e){err(res,e)}});
app.get('/v1/voice/ice',auth,(req,res)=>{try{const creds=turnCredentials(req.account);res.set('Cache-Control','no-store').json({iceServers:[{urls:(process.env.STUN_URL||'stun:stun.l.google.com:19302')},{urls:(process.env.TURN_URLS||'').split(',').filter(Boolean),username:creds.username,credential:creds.credential}]});}catch(e){err(res,e)}});
app.post('/v1/voice/calls',auth,async(req,res)=>{const {extension,idempotencyKey}=req.body||{};if(!validExtension(extension)||typeof idempotencyKey!=='string'||!/^[a-zA-Z0-9_-]{12,100}$/.test(idempotencyKey)) return res.status(400).json({error:'invalid_input'});try{const result=await createCall(req.account,extension,idempotencyKey);if(!result.reused)send(result.call.callee_id,{type:'incoming',call:result.call});res.status(result.reused?200:201).json(result);}catch(e){err(res,e)}});
app.get('/v1/voice/calls',auth,async(req,res)=>{try{const r=await pool.query('SELECT id,caller_id,callee_id,status,created_at,answered_at,ended_at FROM voice_calls WHERE caller_id=$1 OR callee_id=$1 ORDER BY created_at DESC LIMIT 100',[req.account]);res.json({calls:r.rows});}catch(e){err(res,e)}});
app.post('/v1/voice/calls/:id/:action',auth,async(req,res)=>{const {id,action}=req.params;const mapping={answer:'active',reject:'rejected',end:'ended'};if(!validCallId(id)||!mapping[action])return res.status(400).json({error:'invalid_input'});try{const call=await transition(id,req.account,mapping[action]);send(call.caller_id,{type:'state',call});send(call.callee_id,{type:'state',call});res.json({call});}catch(e){err(res,e)}});
const server=http.createServer(app);const wss=new WebSocketServer({noServer:true,maxPayload:70000,perMessageDeflate:false});
server.on('upgrade',async(req,socket,head)=>{try{
 const url=new URL(req.url,'http://localhost');if(url.pathname!=='/v1/voice/ws')throw Error('route');
 const origin=req.headers.origin;if(!origin||!process.env.VOICE_ALLOWED_ORIGIN?.split(',').includes(origin))throw Error('origin');
 // Browser WebSocket cannot set Authorization headers; use a short-lived, one-use
 // ticket issued by the authenticated main app. Replace this placeholder verifier
 // with the existing Qorlla session-backed ticket service before deployment.
 const ticket=url.searchParams.get('ticket');if(!ticket)throw Error('ticket');
 const account=await authenticate(ticket);const profile=await identity(account);if(!profile?.enabled)throw Error('disabled');
 wss.handleUpgrade(req,socket,head,ws=>{ws.account=account;wss.emit('connection',ws,req)});
 }catch{socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');socket.destroy();}});
wss.on('connection',ws=>{const account=ws.account;const group=sockets.get(account)||new Set();if(group.size>=3){ws.close(1008,'connection_limit');return;}group.add(ws);sockets.set(account,group);
 let tokens=50;const refill=setInterval(()=>{tokens=50},10000);ws.on('message',async raw=>{try{
 if(--tokens<0){ws.close(1008,'rate_limit');return;}
 const msg=JSON.parse(raw.toString());if(!safeSignal(msg))return;
 const call=await getCall(msg.callId);if(!call||![call.caller_id,call.callee_id].includes(account))return;
 if(!['ringing','active'].includes(call.status))return;
 // Offer/answer/ICE only to the other authorized call participant.
 const other=call.caller_id===account?call.callee_id:call.caller_id;
 send(other,{type:msg.type,callId:msg.callId,...(msg.type==='ice'?{candidate:msg.candidate}:{sdp:msg.sdp})});
 }catch{}});ws.on('close',()=>{clearInterval(refill);group.delete(ws);if(!group.size)sockets.delete(account);});});
const port=Number(process.env.PORT||4600);server.listen(port,()=>console.log(`Qorlla voice listening on ${port}`));
process.on('SIGTERM',async()=>{wss.clients.forEach(ws=>ws.close(1001));server.close();await pool.end();});
