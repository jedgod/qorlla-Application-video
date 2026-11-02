import { randomInt } from 'node:crypto';

const PROFILES = Object.freeze({
  GB: {countryCallingCode:'44', prefix:'07', digits:11},
  GH: {countryCallingCode:'233', prefix:'0', digits:10},
  NG: {countryCallingCode:'234', prefix:'0', digits:11},
  US: {countryCallingCode:'1', prefix:'', digits:10},
  KE: {countryCallingCode:'254', prefix:'0', digits:10}
});
export function profileFor(iso) { const p=PROFILES[iso]; if(!p) throw new Error('COUNTRY_NOT_CONFIGURED'); return p; }
export function normalizeNational(value) { return String(value).replace(/[\s().-]/g,''); }
export function formatNational(value) { return String(value).replace(/(\d{4})(?=\d)/g,'$1 '); }
export function candidateForCountry(iso) {
  const p=profileFor(iso);
  let result=p.prefix;
  while(result.length<p.digits) result+=String(randomInt(0,10));
  return result;
}
/**
 * Repository integration boundary: db is the EXISTING engine PostgreSQL pool.
 * account and extension eligibility must be verified by caller within Shield's
 * authoritative transaction before invoking. A unique constraint arbitrates races.
 */
export async function assignCountryAlias({db, accountId, extensionId, confirmedCountry, verified}) {
  if(!verified || !accountId || !extensionId) throw new Error('ACCOUNT_INELIGIBLE');
  profileFor(confirmedCountry);
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    // Serialize provisioning for one account even when requests race.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',[String(accountId)]);
    const existing=await client.query('SELECT * FROM voice_country_aliases WHERE account_id=$1',[accountId]);
    if(existing.rows.length) {
      if(existing.rows[0].extension_id!==extensionId) throw new Error('EXTENSION_BINDING_CONFLICT');
      await client.query('COMMIT'); return existing.rows[0];
    }
    for(let i=0;i<40;i++) {
      const national=candidateForCountry(confirmedCountry);
      const result=await client.query(`INSERT INTO voice_country_aliases
        (account_id,extension_id,iso_country,national,canonical_national)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT DO NOTHING RETURNING *`,
        [accountId,extensionId,confirmedCountry,formatNational(national),national]);
      if(result.rows.length) { await client.query('COMMIT'); return result.rows[0]; }
    }
    throw new Error('ALIAS_CAPACITY_RETRY');
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally {client.release();}
}
export async function findInternalAlias({db,national,country}) {
  profileFor(country);
  const canonical=normalizeNational(national);
  const result=await db.query(`SELECT account_id,extension_id,iso_country,status FROM voice_country_aliases
    WHERE canonical_national=$1 AND iso_country=$2 AND status='active'`,[canonical,country]);
  return result.rows[0]??null;
}
