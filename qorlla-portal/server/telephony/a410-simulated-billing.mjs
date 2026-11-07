import { randomUUID } from 'node:crypto';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{3,128}$/.test(value);

export function createSimulatedBilling({ pool, verifyDuration, authorize, enabled = false, environment = process.env.NODE_ENV }) {
  if (enabled !== true || environment === 'production') throw new Error('Simulated billing is disabled');
  if (!pool || typeof verifyDuration !== 'function' || typeof authorize !== 'function')
    throw new Error('Simulated billing requires authoritative duration and authorization adapters');
  return {
    async rate({ principal, callId, workspaceId, tariffVersion, idempotencyKey }) {
      if (!uuid(callId) || !uuid(workspaceId) || !identifier(tariffVersion) || !identifier(idempotencyKey)) throw new Error('INVALID_SIMULATION');
      callId = callId.toLowerCase(); workspaceId = workspaceId.toLowerCase();
      if (await authorize({ principal, callId, workspaceId, tariffVersion }) !== true) throw new Error('SIMULATION_DENIED');
      const duration = await verifyDuration({ callId, workspaceId });
      if (!duration || duration.callId !== callId || duration.workspaceId !== workspaceId || duration.verified !== true ||
          duration.ended !== true || !Number.isSafeInteger(duration.durationMs) || duration.durationMs < 0)
        throw new Error('DURATION_UNVERIFIED');
      const seconds = (BigInt(duration.durationMs) + 999n) / 1000n;
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [idempotencyKey]);
        const existing = (await c.query('SELECT * FROM portal.a410_simulated_journal WHERE idempotency_key=$1', [idempotencyKey])).rows[0];
        if (existing) {
          if (existing.call_id !== callId || existing.workspace_id !== workspaceId || existing.tariff_version !== tariffVersion ||
              existing.duration_ms !== String(duration.durationMs)) throw new Error('SIMULATION_CONFLICT');
          await c.query('COMMIT');
          return { simulated: true, replayed: true, journalId: existing.id, amountMinor: existing.amount_minor, currency: existing.currency };
        }
        const ref = await c.query('SELECT meet_call_id FROM portal.a49_call_refs WHERE meet_call_id=$1 AND workspace_id=$2 FOR UPDATE', [callId, workspaceId]);
        if (!ref.rowCount) throw new Error('CALL_REFERENCE_NOT_FOUND');
        if ((await c.query('SELECT 1 FROM portal.a410_simulated_journal WHERE call_id=$1', [callId])).rowCount)
          throw new Error('CALL_ALREADY_SIMULATED');
        const tariff = (await c.query('SELECT * FROM portal.a410_simulated_tariffs WHERE version=$1', [tariffVersion])).rows[0];
        if (!tariff) throw new Error('SIMULATED_TARIFF_NOT_FOUND');
        const usageMinor = (seconds * BigInt(tariff.rate_micro_minor_per_second) + 999999n) / 1000000n;
        const subtotal = usageMinor + BigInt(tariff.connection_minor);
        const amount = subtotal > BigInt(tariff.minimum_minor) ? subtotal : BigInt(tariff.minimum_minor);
        if (amount > 9223372036854775807n) throw new Error('SIMULATION_AMOUNT_OVERFLOW');
        const id = randomUUID();
        await c.query(`INSERT INTO portal.a410_simulated_journal(id,idempotency_key,call_id,workspace_id,tariff_version,duration_ms,seconds,amount_minor,currency)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, idempotencyKey, callId, workspaceId, tariffVersion, duration.durationMs, seconds.toString(), amount.toString(), tariff.currency]);
        await c.query(`INSERT INTO portal.a410_simulated_postings(journal_id,account,amount_minor)
          VALUES($1,'customer',$2),($1,'simulated_revenue',$3)`, [id, amount.toString(), (-amount).toString()]);
        await c.query('COMMIT');
        return { simulated: true, replayed: false, journalId: id, amountMinor: amount.toString(), currency: tariff.currency };
      } catch (e) { await c.query('ROLLBACK'); throw e; }
      finally { c.release(); }
    }
  };
}
