/**
 * Catalog seeding and drift detection.
 * The plan catalog in src/plans.js is the single source of truth for enforcement. The database tables
 * (plans, features, plan_entitlements) mirror it for reporting and joins; verifyCatalog() proves they match.
 * Run seedCatalog as the migrator role; run verifyCatalog in CI and after every deploy.
 */

import { FEATURES, PLAN_ORDER, PLANS, resolveEntitlements } from './plans.js';

export async function seedCatalog(pool) {
  const client = await pool.connect();
  client.on('error', () => {});                       // a lost connection surfaces as a rejected query, not a crash
  try {
    await client.query('BEGIN');
    for (const code of PLAN_ORDER) {
      const p = PLANS[code];
      await client.query(
        `INSERT INTO plans (code, display_name, rank) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE SET display_name = EXCLUDED.display_name, rank = EXCLUDED.rank`, [p.code, p.displayName, p.rank]);
    }
    for (const [key, meta] of Object.entries(FEATURES)) {
      await client.query(
        `INSERT INTO features (key, description, category, value_type, metering, period) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, category = EXCLUDED.category,
           value_type = EXCLUDED.value_type, metering = EXCLUDED.metering, period = EXCLUDED.period`,
        [key, meta.description, meta.category, meta.type, meta.metering, meta.metering === 'consumption' ? (meta.period || 'billing') : null]);
    }
    await client.query('DELETE FROM plan_entitlements');
    for (const plan of PLAN_ORDER) {
      for (const [featureKey, value] of Object.entries(resolveEntitlements(plan))) {
        await client.query('INSERT INTO plan_entitlements (plan_code, feature_key, value) VALUES ($1, $2, $3)', [plan, featureKey, JSON.stringify(value)]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Returns { ok, differences[] }. Any difference means the database mirror has drifted from src/plans.js. */
export async function verifyCatalog(pool) {
  const diffs = [];
  const feats = new Map((await pool.query('SELECT key, value_type, metering FROM features')).rows.map((r) => [r.key, r]));
  for (const [key, meta] of Object.entries(FEATURES)) {
    const row = feats.get(key);
    if (!row) diffs.push(`feature missing in database: ${key}`);
    else if (row.value_type !== meta.type || row.metering !== meta.metering) diffs.push(`feature differs: ${key}`);
    feats.delete(key);
  }
  for (const key of feats.keys()) diffs.push(`feature only in database: ${key}`);

  const ents = new Map((await pool.query('SELECT plan_code, feature_key, value FROM plan_entitlements')).rows.map((r) => [`${r.plan_code}/${r.feature_key}`, r.value]));
  for (const plan of PLAN_ORDER) {
    for (const [featureKey, value] of Object.entries(resolveEntitlements(plan))) {
      const k = `${plan}/${featureKey}`;
      if (!ents.has(k)) diffs.push(`entitlement missing in database: ${k}`);
      else if (JSON.stringify(ents.get(k)) !== JSON.stringify(value)) diffs.push(`entitlement differs: ${k}`);
      ents.delete(k);
    }
  }
  for (const k of ents.keys()) diffs.push(`entitlement only in database: ${k}`);
  return { ok: diffs.length === 0, differences: diffs };
}
