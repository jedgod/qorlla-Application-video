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
