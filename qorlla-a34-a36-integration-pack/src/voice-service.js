import { randomUUID } from 'node:crypto';
import { classifyDestination, requirePrincipal } from './policy.js';
const activeStates = ['ringing','connected'];
const fail = (code, statusCode=403) => { throw Object.assign(new Error(code), { statusCode }); };
export class VoiceService {
  constructor(db) { this.db=db; }
  async invite(principal, destination) {
    requirePrincipal(principal);
    const route=classifyDestination(destination);
    if (!route.ok) fail(route.code,400);
    return this.db.withTransaction(async tx => {
      const ext=await tx.one('SELECT account_id FROM voice_extensions WHERE tenant_id=$1 AND extension=$2 AND active=true',[principal.tenantId,route.extension]);
      if (!ext) fail('EXTENSION_NOT_FOUND',404);
      if (ext.account_id===principal.accountId) fail('SELF_CALL_NOT_ALLOWED');
      for (const id of [principal.accountId,ext.account_id].sort()) {
        const row=await tx.one('SELECT account_id,tenant_id,verified,suspended FROM voice_principals WHERE account_id=$1 FOR UPDATE',[id]);
        if (!row || row.tenant_id!==principal.tenantId || !row.verified || row.suspended) fail('VOICE_FORBIDDEN');
      }
      const callId=randomUUID();
      await tx.exec('INSERT INTO voice_calls(call_id,tenant_id,caller_id,callee_id,state) VALUES($1,$2,$3,$4,$5)',[callId,principal.tenantId,principal.accountId,ext.account_id,'ringing']);
      await tx.event('voice.invited',{callId,tenantId:principal.tenantId,callerId:principal.accountId,calleeId:ext.account_id});
      return {callId,state:'ringing'};
    });
  }
  async transition(principal,callId,action) {
    requirePrincipal(principal);
    const targets={accept:['ringing','connected'],reject:['ringing','completed'],end:['ringing','completed']};
    if (!targets[action]) fail('INVALID_ACTION',400);
    return this.db.withTransaction(async tx=>{
      const call=await tx.one('SELECT * FROM voice_calls WHERE call_id=$1 AND tenant_id=$2 FOR UPDATE',[callId,principal.tenantId]);
      if (!call || ![call.caller_id,call.callee_id].includes(principal.accountId)) fail('CALL_NOT_FOUND',404);
      if (action==='accept' && call.callee_id!==principal.accountId) fail('CALLEE_ONLY');
      if (call.state!=='ringing' && !(action==='end' && call.state==='connected')) fail('INVALID_CALL_STATE',409);
      const next=action==='accept'?'connected':'completed';
      if (next==='connected') {
        for (const id of [call.caller_id,call.callee_id].sort()) {
          const p=await tx.one('SELECT verified,suspended FROM voice_principals WHERE account_id=$1 FOR UPDATE',[id]);
          if (!p?.verified || p.suspended) fail('VOICE_FORBIDDEN');
        }
      }
      await tx.exec('UPDATE voice_calls SET state=$1,ended_at=CASE WHEN $1=$2 THEN now() ELSE ended_at END WHERE call_id=$3',[next,'completed',callId]);
      await tx.event('voice.state',{callId,tenantId:call.tenant_id,callerId:call.caller_id,calleeId:call.callee_id,state:next});
      return {callId,state:next};
    });
  }
  async suspend({tenantId,accountId,actorId,reason}) {
    if (!reason || !actorId) fail('INVALID_SUSPENSION',400);
    return this.db.withTransaction(async tx=>{
      const p=await tx.one('SELECT account_id FROM voice_principals WHERE account_id=$1 AND tenant_id=$2 FOR UPDATE',[accountId,tenantId]);
      if (!p) fail('ACCOUNT_NOT_FOUND',404);
      await tx.exec('UPDATE voice_principals SET suspended=true WHERE account_id=$1 AND tenant_id=$2',[accountId,tenantId]);
      const calls=await tx.query("UPDATE voice_calls SET state='revoked',ended_at=now() WHERE tenant_id=$1 AND (caller_id=$2 OR callee_id=$2) AND state=ANY($3::text[]) RETURNING call_id,caller_id,callee_id",[tenantId,accountId,activeStates]);
      for (const call of calls) await tx.event('voice.revoked',{callId:call.call_id,tenantId,callerId:call.caller_id,calleeId:call.callee_id});
      await tx.event('voice.suspended',{tenantId,accountId,actorId,reason});
      return {revokedCalls:calls.length,mediaTermination:'not_confirmed'};
    });
  }
}
