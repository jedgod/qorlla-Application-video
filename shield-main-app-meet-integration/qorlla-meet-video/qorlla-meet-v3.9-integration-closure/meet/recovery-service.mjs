import crypto from 'node:crypto';
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const seal = (plaintext,key) => { const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm',key,iv); const ciphertext=Buffer.concat([c.update(plaintext,'utf8'),c.final()]); return Buffer.concat([iv,c.getAuthTag(),ciphertext]).toString('base64url'); };
const open = (blob,key) => { const b=Buffer.from(blob,'base64url'),d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8'); };
/**
 * Integration contract: pg pool, AES key (32 bytes), and existing host credential hash column.
 * Source authorization MUST be enforced by caller before invoking these methods.
 * The same requestId is replayable until ack; new request IDs cannot rotate an unacked credential.
 */
export function recoveryService(pool, key) {
  if (!Buffer.isBuffer(key) || key.length!==32) throw new Error('RECOVERY_ESCROW_KEY must decode to 32 bytes');
  return {
    async issue({sourceId,requestId}) {
      if (!/^[\w.-]{1,128}$/.test(requestId)) throw new Error('Invalid requestId');
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const m=await client.query("SELECT m.id,m.ended_at FROM meetings m JOIN external_meeting_links l ON l.meeting_id=m.id WHERE l.source_system='qorlla-main' AND l.source_id=$1 FOR UPDATE OF m",[sourceId]);
        if (!m.rowCount || m.rows[0].ended_at) { const e=new Error('Not found or ended');e.status=404;throw e; }
        const prior=await client.query('SELECT * FROM host_recovery_escrow WHERE meeting_id=$1 FOR UPDATE',[m.rows[0].id]);
        if (prior.rowCount && prior.rows[0].state==='pending') {
          if (prior.rows[0].request_id!==requestId) {const e=new Error('Recovery already pending');e.status=409;throw e;}
          const result={requestId,generation:prior.rows[0].generation,hostSecret:open(prior.rows[0].encrypted_secret,key)};
          await client.query('COMMIT');return result;
        }
        if (prior.rowCount && prior.rows[0].request_id===requestId) {const e=new Error('Already acknowledged');e.status=409;throw e;}
        const generation=(prior.rows[0]?.generation ?? 0)+1;
        const hostSecret=crypto.randomBytes(32).toString('base64url');
        // Adapt column name to the actual Meet schema. Credential hash and escrow MUST commit together.
        await client.query('UPDATE meetings SET host_secret_hash=$2 WHERE id=$1',[m.rows[0].id,hash(hostSecret)]);
        await client.query(`INSERT INTO host_recovery_escrow(meeting_id,request_id,generation,encrypted_secret,state)
          VALUES($1,$2,$3,$4,'pending') ON CONFLICT(meeting_id) DO UPDATE SET
          request_id=EXCLUDED.request_id,generation=EXCLUDED.generation,encrypted_secret=EXCLUDED.encrypted_secret,state='pending',updated_at=now()`,
          [m.rows[0].id,requestId,generation,seal(hostSecret,key)]);
        await client.query('COMMIT');return {requestId,generation,hostSecret};
      } catch(e){await client.query('ROLLBACK');throw e;} finally {client.release();}
    },
    async acknowledge({sourceId,requestId,generation}) {
      const result=await pool.query(`UPDATE host_recovery_escrow e SET state='acknowledged',encrypted_secret=NULL,updated_at=now()
        FROM external_meeting_links l WHERE e.meeting_id=l.meeting_id AND l.source_system='qorlla-main' AND l.source_id=$1 AND e.request_id=$2
        AND e.generation=$3 AND e.state='pending' RETURNING e.generation`,[sourceId,requestId,generation]);
      if (!result.rowCount) {const e=new Error('Recovery not pending');e.status=409;throw e;}
      return {acknowledged:true,generation};
    }
  };
}
