import { randomUUID } from 'node:crypto';
import { refuse } from './errors.js';

// Repository interface: withTransaction(async tx => ...), tx.one(query, params), tx.exec(query, params).
// Identity must come from the existing authenticated user middleware, never request JSON.
export class InternalVoiceService {
  constructor({ db, outbox }) { this.db = db; this.outbox = outbox; }
  async invite(principal, extension) {
    if (!principal?.accountId || !principal?.tenantId || principal.kind === 'guest') refuse('VOICE_FORBIDDEN');
    if (typeof extension !== 'string' || !/^[0-9]{3,8}$/.test(extension)) refuse('INVALID_EXTENSION', 400);
    return this.db.withTransaction(async tx => {
      // Lock both principal records in stable order through the DB adapter; the
      // adapter must serialize suspension against call creation.
      const calleeId = await tx.one('SELECT account_id FROM voice_extensions WHERE tenant_id=$1 AND extension=$2 AND active=true', [principal.tenantId, extension]);
      if (!calleeId) refuse('EXTENSION_NOT_FOUND', 404);
      if (calleeId.account_id === principal.accountId) refuse('SELF_CALL_NOT_ALLOWED');
      const ids = [...new Set([principal.accountId, calleeId.account_id])].sort();
      const accounts = [];
      for (const id of ids) {
        const row = await tx.one('SELECT account_id, tenant_id, verified, suspended FROM voice_principals WHERE account_id=$1 FOR UPDATE', [id]);
        if (!row || row.tenant_id !== principal.tenantId || !row.verified || row.suspended) refuse('VOICE_FORBIDDEN');
        accounts.push(row);
      }
      const callId = randomUUID();
      await tx.exec('INSERT INTO voice_calls (call_id, tenant_id, caller_id, callee_id, state) VALUES ($1,$2,$3,$4,$5)', [callId, principal.tenantId, principal.accountId, calleeId.account_id, 'ringing']);
      await this.outbox.enqueue(tx, 'voice.call.invited', { callId, tenantId: principal.tenantId, calleeId: calleeId.account_id });
      return { callId, state: 'ringing' };
    });
  }
  async suspendAccount({ accountId, tenantId, actorId, reason }) {
    if (!actorId || !reason) refuse('INVALID_SUSPENSION', 400);
    // Caller must already have passed Shield authorization for voice.account.suspend.
    return this.db.withTransaction(async tx => {
      const row = await tx.one('SELECT account_id FROM voice_principals WHERE account_id=$1 AND tenant_id=$2 FOR UPDATE', [accountId, tenantId]);
      if (!row) refuse('ACCOUNT_NOT_FOUND', 404);
      await tx.exec('UPDATE voice_principals SET suspended=true WHERE account_id=$1 AND tenant_id=$2', [accountId, tenantId]);
      const calls = await tx.query('UPDATE voice_calls SET state=$1, ended_at=now() WHERE tenant_id=$2 AND (caller_id=$3 OR callee_id=$3) AND state IN ($4,$5,$6) RETURNING call_id', ['revoked', tenantId, accountId, 'ringing', 'connected', 'terminating']);
      for (const call of calls) await this.outbox.enqueue(tx, 'voice.call.revoked', { callId: call.call_id, tenantId, accountId });
      await this.outbox.enqueue(tx, 'voice.account.suspended', { tenantId, accountId, actorId, reason });
      return { revokedCalls: calls.length, signalingTerminationPending: calls.length > 0 };
    });
  }
}
export function assertInternalOnly({ pstnEnabled, publicNumbersEnabled }) {
  if (pstnEnabled === true || publicNumbersEnabled === true) throw new Error('Public calling prohibited by deployment policy');
}
