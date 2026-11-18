const fs=require('fs'),path=require('path'),base=path.resolve('.worktrees/internal-phone');
function edit(f,fn){const p=path.join(base,f);fs.writeFileSync(p,fn(fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n')));}
function rep(s,a,b){if(!s.includes(a))throw Error('Missing '+a.slice(0,70));return s.replace(a,b);}
edit('qorlla-voice-engine/src/app.mjs',s=>{
 s="import { registerInternalGateway } from './internal-gateway.mjs';\n"+s;
 return rep(s,"  app.get('/healthz'","  registerInternalGateway({ app, adminAuth, gate, route, store, db, env, mediaAllowed, iceServersFor });\n  app.get('/healthz'");
});
edit('qorlla-meet-video/server/telephony/service.mjs',s=>{
 s="import { internalReadiness, internalReady } from '../internal-phone.mjs';\n"+s;
 s=rep(s,'  async capabilities(actorId) {',`  async capabilities(actorId) {
    if(this.env.PHONE_JOIN_MODE === 'internal') {
      const status=await this.phoneReadiness(), enabled=internalReady(status.readiness), r=(active,detail)=>({status:active?'active':'not_connected',detail,proof:[]});
      return { mode:'internal', provider:r(false,'External carriers disabled.'), dialin:r(false,'Public dial-in disabled; use an internal extension.'), carrier:r(false,'PSTN disabled.'), number:{status:'unassigned',detail:'Use your Qorlla extension.',proof:[]}, billing:r(false,'External telephone billing disabled.'), bridge:r(enabled,enabled?'Internal SIP/WebRTC bridge verified.':'Internal audio bridge is awaiting validation.'), callingEnabled:false, phoneMeetingJoinEnabled:enabled, internal:status, carrierName:'qorlla-internal', webhookConfigured:false, flags:[...this.flags()] };
    }`);
 return rep(s,'  async phoneReadiness() {',"  async phoneReadiness() {\n    if(this.env.PHONE_JOIN_MODE === 'internal') return internalReadiness({ db:this.db, env:this.env });");
});
edit('qorlla-meet-video/server/index.js',s=>rep(s,'const carrier = createCarrier(process.env);',"const carrier = createCarrier(process.env.PHONE_JOIN_MODE === 'internal' ? {} : process.env);"));
edit('qorlla-meet-video/server/phone.mjs',s=>{
 s="import { internalReady, internalVoiceClient } from './internal-phone.mjs';\n"+s;
 s=rep(s,'  const gatewayMode =',"  const internal = env.PHONE_JOIN_MODE === 'internal', voiceDirectory = internal ? internalVoiceClient(env) : null;\n  const gatewayMode =");
 s=rep(s,"const allReady = (r) => !!r && typeof r === 'object' && READY_KEYS.every((k) => r[k] === true);","const allReady = (r) => internal ? internalReady(r) : !!r && r.mode !== 'internal' && typeof r === 'object' && READY_KEYS.every((k) => r[k] === true);");
 s=rep(s,'          if (!provider.ready)',"          if (internal) return res.status(503).json({error:'Authenticated internal gateway required'});\n          if (!provider.ready)");
 s=rep(s,"    const num = e164(j.from), callId =", "    const identity = internal && j.from === undefined ? await voiceDirectory.extension(j.extension) : null;\n    const num = internal ? (identity ? 'ext:' + identity.extension : '') : e164(j.from), callId =");
 s=rep(s,"const wait = m.waiting_room ? 'waiting_room'", "const wait = (internal || m.waiting_room) ? 'waiting_room'");
 return s;
});
console.log('Meet and Voice wired for internal extensions in isolated sources.');
