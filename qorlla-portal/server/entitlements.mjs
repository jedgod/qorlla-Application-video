// Backend entitlement enforcement. The plan a workspace gets is computed in PostgreSQL (portal.workspace_effective_plan):
// a paid plan counts only while its subscription is active/trialing or inside the payment-retry grace; otherwise Basic.
// Quota NULL = unlimited. The UI may mirror these limits but is never the authority.
export class PlanLimitError extends Error {
  constructor(feature, limit, plan, extra = {}) { super(`Plan limit reached for ${feature}`); this.status = 402; this.code = 'plan_limit'; this.feature = feature; this.limit = limit; this.plan = plan; this.extra = extra; }
}

export async function effectivePlan(db, workspaceId) {
  return (await db.query('SELECT plan_slug FROM portal.workspace_effective_plan WHERE workspace_id=$1', [workspaceId])).rows[0]?.plan_slug || 'basic';
}
export async function entitlementsFor(db, workspaceId) {
  const plan = await effectivePlan(db, workspaceId);
  const rows = (await db.query('SELECT feature,quota,description FROM portal.entitlements WHERE plan_slug=$1 ORDER BY feature', [plan])).rows;
  return { plan, features: Object.fromEntries(rows.map((r) => [r.feature, { quota: r.quota, unlimited: r.quota === null, description: r.description }])) };
}
export async function quotaFor(db, workspaceId, feature) {
  const plan = await effectivePlan(db, workspaceId);
  const r = (await db.query('SELECT quota FROM portal.entitlements WHERE plan_slug=$1 AND feature=$2', [plan, feature])).rows[0];
  // a feature with no row for the plan is not granted at all
  return { plan, granted: !!r, quota: r ? r.quota : 0 };
}
/** Run `fn(client)` holding the workspace row lock, so two concurrent requests cannot both pass a count check. */
export async function withWorkspaceLock(pool, workspaceId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM portal.workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

/** The usage_events store used by POST /usage: one row per (workspace, feature, idempotency key), counted per calendar month. */
export const usageEventsStore = (ws, feature) => ({
  exists: async (c, key) => (await c.query('SELECT 1 FROM portal.usage_events WHERE workspace_id=$1 AND feature=$2 AND idempotency_key=$3', [ws, feature, key])).rowCount > 0,
  used: async (c) => Number((await c.query(`SELECT COALESCE(SUM(units),0) s FROM portal.usage_events WHERE workspace_id=$1 AND feature=$2 AND created_at >= date_trunc('month', now())`, [ws, feature])).rows[0].s),
  insert: (c, key, units) => c.query('INSERT INTO portal.usage_events(workspace_id,feature,units,idempotency_key) VALUES($1,$2,$3,$4)', [ws, feature, units, key]),
});
/** Atomic, idempotent quota consumption: under the workspace lock, a repeat of `key` spends nothing ({duplicate:true}); otherwise the units are counted against the plan's quota
 *  for `feature` (no entitlement row = not granted = PlanLimitError, quota NULL = unlimited) and recorded in the same transaction, so concurrent callers cannot exceed the quota.
 *  POST /usage uses the default usage_events store; Portal Chat passes its own store (`exists(c,key)`, `used(c)`, `insert(c,key,units)`) so a failed model call can be marked and not counted. */
export async function consumeQuota(pool, { workspace, feature, units = 1, key, store = usageEventsStore(workspace, feature) }) {
  return withWorkspaceLock(pool, workspace, async (c) => {
    if (await store.exists(c, key)) return { duplicate: true };
    const q = await quotaFor(c, workspace, feature);
    const used = await store.used(c);
    if (!q.granted || (q.quota !== null && used + units > q.quota)) throw new PlanLimitError(feature, q.quota, q.plan, { used });
    await store.insert(c, key, units);
    return { duplicate: false, used: used + units, limit: q.quota };
  });
}
