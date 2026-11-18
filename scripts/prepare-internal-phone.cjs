// Apply the internal-only integration to the isolated SIP integration snapshot.
const fs = require('node:fs'), path = require('node:path');
const base = path.resolve('.worktrees/internal-phone');
function edit(file, fn) { const p=path.join(base,file), s=fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n'); fs.writeFileSync(p,fn(s)); }
function replace(s,a,b){if(!s.includes(a))throw new Error('Missing anchor: '+a.slice(0,80));return s.replace(a,b);}
edit('qorlla-phone-join/src/admission.ts', s=>{
 s=replace(s,'export type Readiness = {','export type Readiness = InternalReadiness | {\n  mode?: \'pstn\';');
 s=replace(s,'/** The six conditions,','export type InternalReadiness = { mode: \'internal\'; internalExtensionsValidated: boolean; gatewayHealthy: boolean; mediaBridgeCertified: boolean; turnValidated: boolean; securityValidated: boolean; productionApproved: boolean };\nexport const INTERNAL_READINESS_KEYS = [\'internalExtensionsValidated\', \'gatewayHealthy\', \'mediaBridgeCertified\', \'turnValidated\', \'securityValidated\', \'productionApproved\'] as const;\n/** The six conditions,');
 s=replace(s,'callerNumber?: string };','callerNumber?: string; callerExtension?: string };');
 s=replace(s,'callerNumber?: string };','callerNumber?: string; callerExtension?: string };');
 s=replace(s,"return READINESS_KEYS.every((k) => (r as Record<string, unknown>)[k] === true);","if ('mode' in r && r.mode !== undefined && r.mode !== 'internal' && r.mode !== 'pstn') return false;\n  const keys = r.mode === 'internal' ? INTERNAL_READINESS_KEYS : READINESS_KEYS;\n  return keys.every((k) => (r as Record<string, unknown>)[k] === true);");
 s=replace(s,"!/^[-A-Za-z0-9_:]{8,128}$/.test(req.callId) || !/^\\+[1-9]\\d{5,14}$/.test(req.dialedNumber)","!/^[-A-Za-z0-9_:]{8,128}$/.test(req.callId) || (readiness.mode === 'internal' ? (!/^[0-9]{3,8}$/.test(req.dialedNumber) || !/^[0-9]{3,8}$/.test(req.callerExtension ?? '') || req.callerNumber !== undefined) : (!/^\\+[1-9]\\d{5,14}$/.test(req.dialedNumber) || req.callerExtension !== undefined))");
 s=replace(s,'callerNumber: req.callerNumber }','callerNumber: req.callerNumber, callerExtension: req.callerExtension }');return s;
});
edit('qorlla-phone-join/src/readiness-meet.ts',s=>{
 s=replace(s,'{ READINESS_KEYS, type Readiness }','{ READINESS_KEYS, INTERNAL_READINESS_KEYS, type Readiness }');
 s=replace(s,'  baseUrl: string;','  baseUrl: string;\n  mode?: \'internal\' | \'pstn\';');
 s=replace(s,"const value = Object.fromEntries(READINESS_KEYS.map((k) => [k, body.readiness[k] === true])) as Readiness;","const mode = this.cfg.mode ?? 'pstn';\n      if ((body.readiness.mode ?? 'pstn') !== mode) throw new Error('readiness mode mismatch');\n      const keys = mode === 'internal' ? INTERNAL_READINESS_KEYS : READINESS_KEYS;\n      const value = { ...(mode === 'internal' ? { mode } : {}), ...Object.fromEntries(keys.map((k) => [k, body.readiness[k] === true])) } as Readiness;");return s;
});
edit('qorlla-phone-join/src/telephone-controller.ts',s=>{
 s=replace(s,'  ingress: SipIngress;',"  mode?: 'internal' | 'pstn';\n  meetingExtension?: string;\n  ingress: SipIngress;");
 s=replace(s,'    const id = call.callId;',"    const id = call.callId;\n    if (this.c.mode === 'internal' && (!/^[0-9]{3,8}$/.test(call.principal) || call.caller !== call.principal || call.dialed !== this.c.meetingExtension)) { call.reject(403, 'Forbidden'); return; }");
 s=replace(s,'if (!telephoneReady(ready))',"if (!telephoneReady(ready) || (ready?.mode ?? 'pstn') !== (this.c.mode ?? 'pstn'))");
 s=replace(s,"dialedNumber: e164(call.dialed), callerNumber: /^\\+[1-9]\\d{5,14}$/.test(call.caller) ? call.caller : undefined","dialedNumber: this.c.mode === 'internal' ? call.dialed : e164(call.dialed), ...(this.c.mode === 'internal' ? { callerExtension: call.principal } : { callerNumber: /^\\+[1-9]\\d{5,14}$/.test(call.caller) ? call.caller : undefined })");return s;
});
edit('qorlla-phone-join/src/sip-gateway.ts',s=>{
 s=replace(s,'  enabled: boolean;',"  mode?: 'internal' | 'pstn';\n  meetingExtension?: string;\n  enabled: boolean;");
 s=replace(s,'  const users = Object.entries',"  if (c.mode === 'internal' && !/^[0-9]{3,8}$/.test(c.meetingExtension ?? '')) p.push('internal gateway requires a meeting service extension');\n  const users = Object.entries");
 s=replace(s,"  if (!c.sip?.allowedSources?.length)","  if (c.mode === 'internal' && users.some(([u]) => !/^[0-9]{3,8}$/.test(u))) p.push('internal SIP credential names must be extensions');\n  if (!c.sip?.allowedSources?.length)");
 s=replace(s,'{ ingress, gateway, bridge, authority:', '{ mode: c.mode, meetingExtension: c.meetingExtension, ingress, gateway, bridge, authority:');return s;
});
edit('qorlla-phone-join/src/meet-authority.ts',s=>{
 s=replace(s,'  baseUrl: string;',"  baseUrl: string;\n  mode?: 'internal' | 'pstn';");
 s=replace(s,'|| !opts.callerNumber) return no;',"|| (this.cfg.mode === 'internal' ? (!/^[0-9]{3,8}$/.test(opts.callerExtension ?? '') || opts.callerNumber !== undefined) : !opts.callerNumber)) return no;");
 s=replace(s,'from: opts.callerNumber, meetingId:',"...(this.cfg.mode === 'internal' ? { extension: opts.callerExtension } : { from: opts.callerNumber }), meetingId:");return s;
});
edit('qorlla-phone-join/src/runtime.ts',s=>{
 s=replace(s,'signalingTls: { ca:',"iceServers?: { urls: string | string[]; username?: string; credential?: string }[]; iceTransportPolicy?: 'all' | 'relay'; signalingTls: { ca:");
 s=replace(s,"  if (o.sip.labMode)","  if ((o.sip.mode ?? 'pstn') !== (o.meet.mode ?? 'pstn')) throw new Error('Gateway and Meet mode must match');\n  if (o.sip.mode === 'internal' && !o.iceServers?.some(s => [s.urls].flat().some(u => /^turns?:/.test(u)))) throw new Error('Internal gateway requires TURN configuration');\n  if (o.sip.labMode)");
 s=replace(s,'{ baseUrl: o.meet.baseUrl, auth:', '{ mode: o.meet.mode, baseUrl: o.meet.baseUrl, auth:');
 s=replace(s,'new MeshPeerAudio({signaling:', 'new MeshPeerAudio({iceServers:o.iceServers,iceTransportPolicy:o.iceTransportPolicy,signaling:');return s;
});
edit('qorlla-phone-join/src/media/mesh-peer.ts',s=>{
 s=replace(s,'export type MeshOptions = { signaling:',"export type MeshOptions = { iceTransportPolicy?: 'all' | 'relay'; signaling:");
 return replace(s,'iceServers: this.o.iceServers ?? []','iceServers: this.o.iceServers ?? [], iceTransportPolicy: this.o.iceTransportPolicy ?? \'all\'');
});
edit('qorlla-phone-join/scripts/run-gateway.mjs',s=>{
 s=replace(s,'runtime=createGatewayRuntime({instance:cfg.instance,db,','runtime=createGatewayRuntime({instance:cfg.instance,db,iceServers:cfg.iceServers,iceTransportPolicy:cfg.iceTransportPolicy,');
 return replace(s,'meet:{baseUrl:cfg.meetUrl,','meet:{mode:cfg.sip.mode,baseUrl:cfg.meetUrl,');
});
console.log('Internal gateway source prepared; no services started or readiness gates changed.');
