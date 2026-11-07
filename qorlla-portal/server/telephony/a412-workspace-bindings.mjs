import { createHash } from 'node:crypto';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_.:@/-]{1,200}$/.test(value);
const actions = new Set(['bind', 'suspend', 'resume', 'revoke']);

export class BindingError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// authorize must verify the authenticated workload's authority over this workspace
// using the supplied transaction, not identity or ownership supplied in the request.
export function createWorkspaceBindings({ pool, authorize, verifyMeeting }) {
  if (!pool || typeof authorize !== 'function' || typeof verifyMeeting !== 'function')
    throw new Error('Workspace bindings require authoritative authorization and meeting verification');
  return {
    async apply({ principal, requestId, workspaceId, meetingId, action }) {
      if (!identity(principal) || !uuid(requestId) || !uuid(workspaceId) || !uuid(meetingId) || !actions.has(action))
        throw new BindingError('INVALID_BINDING_REQUEST');
      requestId = requestId.toLowerCase(); workspaceId = workspaceId.toLowerCase(); meetingId = meetingId.toLowerCase();
      const digest = createHash('sha256').update(JSON.stringify([workspaceId, meetingId, action])).digest('hex');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (await authorize({ client, principal, workspaceId, meetingId, action }) !== true) throw new BindingError('BINDING_DENIED');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [principal + ':' + requestId]);
        const prior = (await client.query('SELECT payload_sha256,result FROM portal.a412_binding_requests WHERE principal=$1 AND request_id=$2', [principal, requestId])).rows[0];
        if (prior) {
          if (prior.payload_sha256 !== digest) throw new BindingError('BINDING_IDEMPOTENCY_CONFLICT');
          await client.query('COMMIT');
          return { ...prior.result, replayed: true };
        }
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [meetingId]);
        const binding = (await client.query('SELECT workspace_id,status FROM portal.a412_workspace_meetings WHERE meeting_id=$1 FOR UPDATE', [meetingId])).rows[0];
        if (binding && binding.workspace_id !== workspaceId) throw new BindingError('BINDING_CONFLICT');
        if (!binding && action !== 'bind') throw new BindingError('BINDING_NOT_FOUND');
        if (binding?.status === 'revoked' && action !== 'revoke') throw new BindingError('BINDING_REVOKED');
        if (binding?.status === 'suspended' && action === 'bind') throw new BindingError('BINDING_SUSPENDED');
        if (!binding && await verifyMeeting({ client, principal, workspaceId, meetingId }) !== true) throw new BindingError('MEETING_UNVERIFIED');
        const status = action === 'suspend' ? 'suspended' : action === 'revoke' ? 'revoked' : 'active';
        const changed = !binding || binding.status !== status;
        if (!binding) await client.query(`INSERT INTO portal.a412_workspace_meetings(meeting_id,workspace_id,status,provisioned_by)
          VALUES($1,$2,'active',$3)`, [meetingId, workspaceId, principal]);
        else if (changed) await client.query('UPDATE portal.a412_workspace_meetings SET status=$2,updated_at=now() WHERE meeting_id=$1', [meetingId, status]);
        const result = { workspaceId, meetingId, status, changed };
        await client.query('INSERT INTO portal.a412_binding_audit(meeting_id,workspace_id,principal,request_id,action,changed) VALUES($1,$2,$3,$4,$5,$6)',
          [meetingId, workspaceId, principal, requestId, action, changed]);
        await client.query('INSERT INTO portal.a412_binding_requests(principal,request_id,payload_sha256,result) VALUES($1,$2,$3,$4::jsonb)',
          [principal, requestId, digest, JSON.stringify(result)]);
        await client.query('COMMIT');
        return { ...result, replayed: false };
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    }
  };
}
