import { createHash } from 'node:crypto';

export class A49AccountingError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const uuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const identifier = (v) => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{3,128}$/.test(v);
const money = (x) => Number.isSafeInteger(x?.seconds) && x.seconds >= 0 &&
  Number.isSafeInteger(x.amountMinor) && x.amountMinor >= 0 && typeof x.currency === 'string' && /^[A-Z]{3}$/.test(x.currency);

async function transaction(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally { c.release(); }
}

// These methods are not mounted as HTTP routes. Each authorization callback must
// verify a service identity and the authoritative assignment, not request claims.
export function createA49Accounting({ pool, authorizeMeetCall, authorizeCarrier, authorizeRating }) {
  if (!pool || typeof authorizeMeetCall !== 'function' || typeof authorizeCarrier !== 'function' || typeof authorizeRating !== 'function')
    throw new Error('A49 accounting requires authenticated Meet, carrier and rating authorizers');

  return {
    async bindCall({ principal, meetCallId, workspaceId, sourceKey }) {
      if (!uuid(meetCallId) || !uuid(workspaceId) || !identifier(sourceKey)) throw new A49AccountingError('INVALID_CALL_REFERENCE');
      meetCallId = meetCallId.toLowerCase(); workspaceId = workspaceId.toLowerCase();
      if (await authorizeMeetCall({ principal, meetCallId, workspaceId, sourceKey }) !== true) throw new A49AccountingError('MEET_CALL_DENIED');
      return transaction(pool, async (c) => {
        const inserted = await c.query(`INSERT INTO portal.a49_call_refs(meet_call_id,workspace_id,source_key)
          VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING meet_call_id`, [meetCallId, workspaceId, sourceKey]);
        if (inserted.rowCount) return { replayed: false };
        const prior = await c.query('SELECT meet_call_id,workspace_id,source_key FROM portal.a49_call_refs WHERE meet_call_id=$1 OR source_key=$2', [meetCallId, sourceKey]);
        if (prior.rowCount !== 1 || prior.rows[0].meet_call_id !== meetCallId || prior.rows[0].workspace_id !== workspaceId || prior.rows[0].source_key !== sourceKey)
          throw new A49AccountingError('CALL_REFERENCE_CONFLICT');
        return { replayed: true };
      });
    },

    async recordRating({ principal, meetCallId, workspaceId, seconds, amountMinor, currency, tariffVersion }) {
      if (!uuid(meetCallId) || !uuid(workspaceId) || !money({ seconds, amountMinor, currency }) || !identifier(tariffVersion))
        throw new A49AccountingError('INVALID_RATING');
      meetCallId = meetCallId.toLowerCase(); workspaceId = workspaceId.toLowerCase();
      if (await authorizeRating({ principal, meetCallId, workspaceId }) !== true) throw new A49AccountingError('RATING_DENIED');
      return transaction(pool, async (c) => {
        const reference = await c.query('SELECT meet_call_id FROM portal.a49_call_refs WHERE meet_call_id=$1 AND workspace_id=$2 FOR UPDATE', [meetCallId, workspaceId]);
        if (!reference.rowCount) throw new A49AccountingError('CALL_REFERENCE_NOT_FOUND');
        const result = await c.query(`INSERT INTO portal.a49_ratings(meet_call_id,seconds,amount_minor,currency,tariff_version)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING meet_call_id`, [meetCallId, seconds, amountMinor, currency, tariffVersion]);
        if (result.rowCount) {
          await c.query(`INSERT INTO portal.a410_accounting_outbox(event_key,topic,payload)
            VALUES($1,'accounting.rating_recorded',$2::jsonb)`,
          ['rating:' + meetCallId, JSON.stringify({ meetCallId })]);
          return { replayed: false };
        }
        const prior = (await c.query('SELECT seconds,amount_minor,currency,tariff_version FROM portal.a49_ratings WHERE meet_call_id=$1', [meetCallId])).rows[0];
        if (prior.seconds !== String(seconds) || prior.amount_minor !== String(amountMinor) || prior.currency !== currency || prior.tariff_version !== tariffVersion)
          throw new A49AccountingError('RATING_CONFLICT');
        return { replayed: true };
      });
    },

    async ingestCdr({ principal, rawBody }) {
      if (!Buffer.isBuffer(rawBody) || rawBody.length > 65536) throw new A49AccountingError('INVALID_CDR');
      let cdr;
      try { cdr = JSON.parse(rawBody.toString('utf8')); } catch { throw new A49AccountingError('INVALID_CDR'); }
      if (!cdr || !identifier(cdr.carrierId) || !identifier(cdr.cdrId) || !uuid(cdr.meetCallId) || !money(cdr))
        throw new A49AccountingError('INVALID_CDR');
      if (await authorizeCarrier({ principal, carrierId: cdr.carrierId, cdrId: cdr.cdrId, meetCallId: cdr.meetCallId.toLowerCase(), rawBody }) !== true)
        throw new A49AccountingError('CARRIER_DENIED');
      const hash = createHash('sha256').update(rawBody).digest('hex');
      return transaction(pool, async (c) => {
        const reference = await c.query('SELECT meet_call_id FROM portal.a49_call_refs WHERE meet_call_id=$1 FOR UPDATE', [cdr.meetCallId]);
        if (!reference.rowCount) throw new A49AccountingError('CALL_REFERENCE_NOT_FOUND');
        const inserted = await c.query(`INSERT INTO portal.a49_carrier_cdr(carrier_id,cdr_id,meet_call_id,seconds,amount_minor,currency,payload_sha256)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING carrier_id`,
          [cdr.carrierId, cdr.cdrId, cdr.meetCallId, cdr.seconds, cdr.amountMinor, cdr.currency, hash]);
        if (!inserted.rowCount) {
          const prior = (await c.query('SELECT payload_sha256 FROM portal.a49_carrier_cdr WHERE carrier_id=$1 AND cdr_id=$2', [cdr.carrierId, cdr.cdrId])).rows[0];
          if (!prior || prior.payload_sha256 !== hash) throw new A49AccountingError('CDR_CONFLICT');
        } else {
          const eventKey = 'cdr:' + createHash('sha256').update(JSON.stringify([cdr.carrierId, cdr.cdrId])).digest('hex');
          await c.query(`INSERT INTO portal.a410_accounting_outbox(event_key,topic,payload)
            VALUES($1,'accounting.cdr_recorded',$2::jsonb)`,
          [eventKey, JSON.stringify({ meetCallId: cdr.meetCallId.toLowerCase(), carrierId: cdr.carrierId, cdrId: cdr.cdrId })]);
        }
        const result = await c.query('SELECT result FROM portal.a49_reconciliation WHERE carrier_id=$1 AND cdr_id=$2', [cdr.carrierId, cdr.cdrId]);
        return { replayed: !inserted.rowCount, status: result.rows[0].result };
      });
    }
  };
}
