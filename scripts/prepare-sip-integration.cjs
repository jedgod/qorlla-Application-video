const fs=require('fs'),path=require('path'),cp=require('child_process');const root=process.cwd(),dest=path.join(root,'.worktrees/phone-gateway'),a3='C:/Users/cj_wo/qv-meet-a3',git='C:/Program Files/Git/cmd/git.exe';
const copy=(rel,base=a3)=>{const p=path.join(dest,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.copyFileSync(path.join(base,rel),p);};
for(const rel of ['server/phone.mjs','server/phone-gateway-auth.mjs','server/phone-lifecycle.mjs','server/phone-peer.mjs','server/meeting-code.mjs','server/shield-client.mjs','server/telephony/core.mjs','server/telephony/ivr.mjs','server/telephony/routes.mjs','server/telephony/service.mjs'])copy('qorlla-meet-video/'+rel);
for(const sub of ['sql','tests'])for(const n of fs.readdirSync(path.join(a3,'qorlla-meet-video',sub)))if((sub==='sql'&&/^v4_(24|25|29)_phone/.test(n))||(sub==='tests'&&/^phone.*(test\.mjs)$/.test(n)))copy('qorlla-meet-video/'+sub+'/'+n);
const tracked=cp.execFileSync(git,['ls-files','qorlla-phone-join'],{cwd:root,encoding:'utf8'}).trim().split('\n');for(const rel of tracked)if(!rel.includes('/dist/')&&!rel.includes('/node_modules/'))copy(rel,root);
let s=fs.readFileSync(path.join(dest,'qorlla-meet-video/server/index.js'),'utf8'),orig=s,a=fs.readFileSync(path.join(a3,'qorlla-meet-video/server/index.js'),'utf8');
s=s.replace(/\r\n/g,"\n");a=a.replace(/\r\n/g,"\n");
const replace=(x,y)=>{if(!s.includes(x))throw Error('anchor '+x.slice(0,90));s=s.replace(x,y);};
replace("import { registerPhone } from './phone.mjs';","import { registerPhone } from './phone.mjs';\nimport { createPhonePeers } from './phone-peer.mjs';\nimport { createGatewayAuth } from './phone-gateway-auth.mjs';\nimport { normalizePhoneMeetingCode } from './meeting-code.mjs';");
const begin='const carrier = createCarrier(process.env);',end="app.get('/api/health'";const p=s.indexOf(begin),q=s.indexOf(end,p);if(p<0||q<0)throw Error('phone block');s=s.slice(0,p)+a.slice(a.indexOf(begin),a.indexOf(end,a.indexOf(begin)))+s.slice(q);
replace("if(shield&&shieldCfg.enforce)shield.end(req.params.id).catch(()=>{});","shieldEnd(req.params.id);");
replace(" try {\n  const user=verify(socket.handshake.auth?.token);"," try {\n  if(socket.handshake.auth?.kind==='verification-peer'){const p=await phonePeers.authenticate(socket.handshake.auth.token);socket.data.peer=p;socket.data.user=p.user;return next();}\n  const user=verify(socket.handshake.auth?.token);");
replace("startSessionGuard({io,db,client:shield,config:shieldCfg});","startSessionGuard({io,db,client:shield,config:shieldCfg,audit,onPhonePeer:phone.revokeParticipant});");
replace(" const u=socket.data.user, id=u.meetingId, pid=u.participantId;"," const u=socket.data.user, id=u.meetingId, pid=u.participantId;\n if(socket.data.peer){phonePeers.attach(socket,socket.data.peer).catch(()=>socket.disconnect(true));return;}");
const signalStart=s.indexOf(" socket.on('signal',({to,data}={},ack)=>{"),signalEnd=s.indexOf(" socket.on('chat',",signalStart);if(signalStart<0||signalEnd<0)throw Error('signal anchors');
s=s.slice(0,signalStart)+` socket.on('signal',({to,data}={},ack)=>{
  if(typeof to!=='string'||!data||!['offer','answer','candidate','restart','rebuild'].includes(data.type)) return ackError(ack,'Invalid signal');
  const telephone=phonePeers.socketIdFor(id,to);
  if(telephone){if(breakouts.isActive(id)||breakouts.scopeOf(id,pid)!==null)return ackError(ack,'Telephone audio is unavailable during breakout rooms');io.to(telephone).emit('signal',{from:pid,data});phonePeers.noteFromBrowser(id,to,data.type);if(typeof ack==='function')ack({ok:true});return;}
  const target=isOnline(to); const gate=target?breakouts.signalGate(id,pid,to,data):{error:'Participant offline'}; if(gate.error) return ackError(ack,gate.error);
  io.to(target).emit('signal',{from:pid,data,toEpoch:gate.toEpoch}); if(typeof ack==='function')ack({ok:true});
 });
`+s.slice(signalEnd);
replace("db.query('UPDATE participants SET left_at=now() WHERE id=$1',[pid])","phonePeers.notifyOffline(id,pid);db.query('UPDATE participants SET left_at=now() WHERE id=$1',[pid])");
replace("authorize: async (meetingId, participantId) => {","authorize: async (meetingId, participantId) => {\n    if(breakouts.isActive(meetingId))return {allow:false,reason:'BREAKOUTS_ACTIVE'};");
fs.writeFileSync(path.join(dest,'qorlla-meet-video/server/index.js'),s);
for(const [p,target]of [['qorlla-meet-video/node_modules','C:/Users/cj_wo/qv-chatql/qorlla-meet-video/node_modules'],['qorlla-phone-join/node_modules',path.join(root,'qorlla-phone-join/node_modules')]])if(!fs.existsSync(path.join(dest,p)))fs.symlinkSync(target,path.join(dest,p),'junction');
console.log('Combined current Meet and authenticated telephone gateway workstreams without replacing collaboration features.');
