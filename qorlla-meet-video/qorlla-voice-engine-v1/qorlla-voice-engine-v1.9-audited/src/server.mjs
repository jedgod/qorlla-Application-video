import http from 'node:http';import express from 'express';import helmet from 'helmet';import {WebSocketServer,WebSocket} from 'ws';
import {authenticate,bearer} from './auth.mjs';import {pool,identity,createCall,getCall,transition} from './store.mjs';
import {validExtension,validCallId,safeSignal,turnCredentials} from './core.mjs';
import {issueTicket,consumeTicket,originAllowed} from './tickets.mjs';
import {startMaintenance} from './maintenance.mjs';
import {claimDevice,refreshDevice,getLease,validDeviceId} from './device-leases.mjs';
import {authorizeSignal,signalEnvelope} from './signaling-policy.mjs';
import {iceConfiguration} from './ice-policy.mjs';
import {DistributedBus} from './distributed.mjs';
import {VoiceRouter} from './voice-router.mjs';
import {startOutbox} from './operations.mjs';
import {startDurableTimeouts} from './durable-timeouts.mjs';
import {mountProduction} from './production-http.mjs';
import {claimFencedDevice} from './reliability.mjs';
const app=express();app.disable('x-powered-by');app.use(helmet());app.use(express.json({limit:'16kb'}));
const bus=new DistributedBus({url:process.env.REDIS_URL,onDelivery:async m=>router.local(m.account,m.device,m.payload)});
const router=new VoiceRouter(bus);
const send=(account,payload)=>router.deliver(account,null,payload);
const auth=async(req,res,next)=>{try{const token=bearer(req);if(!token) return res.status(401).json({error:'unauthorized'});req.account=await authenticate(token);next();}catch{res.status(401).json({error:'unauthorized'});}};
mountProduction(app,auth,{bus});
const err=(res,e)=>{const known={invalid_recipient:404,not_found:404,blocked:403,forbidden:403,caller_disabled:403,busy:409,invalid_transition:409,invalid_device:400,call_not_active:409,turn_not_configured:503,invalid_turn_url:503};const status=known[e.message]||500;res.status(status).json({error:status===500?'internal_error':e.message});};
app.get('/healthz',(_req,res)=>res.json({ok:true,service:'qorlla-voice',pstn:false}));
app.get('/readyz',(_req,res)=>res.status(bus.ready&&bus.publisher?.isReady&&bus.subscriber?.isReady?200:503).json({ready:!!(bus.ready&&bus.publisher?.isReady&&bus.subscriber?.isReady)}));
app.post('/v1/voice/ws-ticket',auth,async(req,res)=>{
 try{const origin=req.headers.origin;if(!originAllowed(origin))return res.status(403).json({error:'invalid_origin'});
 const profile=await identity(req.account);if(!profile?.enabled)return res.status(403).json({error:'voice_disabled'});
 res.set('Cache-Control','no-store').json(await issueTicket(req.account,origin));}
 catch(e){err(res,e)}
});
app.get('/v1/voice/me',auth,async(req,res)=>{try{res.json({identity:await identity(req.account)})}catch(e){err(res,e)}});
app.get('/v1/voice/ice',auth,(req,res)=>{try{res.set('Cache-Control','no-store').json(iceConfiguration(req.account));}catch(e){err(res,e)}});
app.post('/v1/voice/calls/:id/device',auth,async(req,res)=>{try{
 if(!validCallId(req.params.id)||!validDeviceId(req.body?.deviceId))return res.status(400).json({error:'invalid_input'});
 const lease=await claimFencedDevice(req.params.id,req.account,req.body.deviceId);
 res.set('Cache-Control','no-store').json({leaseToken:lease.lease_token,expiresAt:lease.expires_at,generation:Number(lease.generation)});
 }catch(e){err(res,e)}});
app.post('/v1/voice/calls/:id/device/refresh',auth,async(req,res)=>{try{
 if(!validCallId(req.params.id)||!validDeviceId(req.body?.deviceId))return res.status(400).json({error:'invalid_input'});
 const lease=await refreshDevice(req.params.id,req.account,req.body.deviceId,req.body.leaseToken);
 if(!lease)return res.status(409).json({error:'lease_expired_or_replaced'});
 res.set('Cache-Control','no-store').json({expiresAt:lease.expires_at});
 }catch(e){err(res,e)}});
app.post('/v1/voice/calls',auth,async(req,res)=>{const {extension,idempotencyKey}=req.body||{};if(!validExtension(extension)||typeof idempotencyKey!=='string'||!/^[a-zA-Z0-9_-]{12,100}$/.test(idempotencyKey)) return res.status(400).json({error:'invalid_input'});try{const result=await createCall(req.account,extension,idempotencyKey);res.status(result.reused?200:201).json(result);}catch(e){err(res,e)}});
app.get('/v1/voice/calls',auth,async(req,res)=>{try{const r=await pool.query('SELECT id,caller_id,callee_id,status,created_at,answered_at,ended_at FROM voice_calls WHERE caller_id=$1 OR callee_id=$1 ORDER BY created_at DESC LIMIT 100',[req.account]);res.json({calls:r.rows});}catch(e){err(res,e)}});
app.post('/v1/voice/calls/:id/:action',auth,async(req,res)=>{const {id,action}=req.params;const mapping={answer:'active',reject:'rejected',end:'ended'};if(!validCallId(id)||!mapping[action])return res.status(400).json({error:'invalid_input'});try{const call=await transition(id,req.account,mapping[action]);res.json({call});}catch(e){err(res,e)}});
const server=http.createServer(app);const wss=new WebSocketServer({noServer:true,maxPayload:70000,perMessageDeflate:false});
server.on('upgrade',async(req,socket,head)=>{try{
 const url=new URL(req.url,'http://localhost');if(url.pathname!=='/v1/voice/ws')throw Error('route');
 const origin=req.headers.origin;if(!originAllowed(origin))throw Error('origin');
 // Ticket is single-use and bound to the authenticated account and browser origin.
 const ticket=url.searchParams.get('ticket');const deviceId=url.searchParams.get('deviceId');
 if(!validDeviceId(deviceId))throw Error('device');
 const account=await consumeTicket(ticket,origin);
 if(!account)throw Error('invalid_ticket');
 const profile=await identity(account);if(!profile?.enabled)throw Error('disabled');
 wss.handleUpgrade(req,socket,head,ws=>{ws.account=account;ws.deviceId=deviceId;wss.emit('connection',ws,req)});
 }catch{socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');socket.destroy();}});
wss.on('connection',ws=>{const account=ws.account;const group=router.sockets.get(account)||new Set();if(group.size>=3){ws.close(1008,'connection_limit');return;}router.attach(ws);
 let tokens=50;const refill=setInterval(()=>{tokens=50},10000);ws.on('message',async raw=>{try{
 if(--tokens<0){ws.close(1008,'rate_limit');return;}
 const msg=JSON.parse(raw.toString());if(!safeSignal(msg))return;
 const call=await getCall(msg.callId);const lease=await getLease(msg.callId,account);
 if(authorizeSignal({message:msg,call,account,deviceId:ws.deviceId,lease}))return;
 if(!lease||lease.lease_token!==msg.leaseToken||!Number.isSafeInteger(msg.generation)||Number(lease.generation)!==msg.generation)return;
 // Offer/answer/ICE only to the other authorized call participant.
 const other=call.caller_id===account?call.callee_id:call.caller_id;
 const peerLease=await getLease(msg.callId,other);
 if(peerLease && new Date(peerLease.expires_at).getTime()>Date.now()){
  await router.deliver(other,peerLease.device_id,signalEnvelope(msg,ws.deviceId));
 }
 }catch{}});ws.on('close',()=>{clearInterval(refill);router.detach(ws);});});
const stopMaintenance=()=>{};const stopTimeouts=startDurableTimeouts();
const port=Number(process.env.PORT||4600);await bus.start();
const stopOutbox=startOutbox({publish:async(account,payload)=>router.deliver(account,null,payload)});server.listen(port,()=>console.log(`Qorlla voice listening on ${port}`));
process.on('SIGTERM',async()=>{stopMaintenance();stopTimeouts();await stopOutbox();wss.clients.forEach(ws=>ws.close(1001));server.close();await bus.close();await pool.end();});
