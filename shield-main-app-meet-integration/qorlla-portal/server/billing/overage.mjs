// Usage-based AI billing, the part every AI feature shares.
//  * A workspace is NEVER billed beyond its plan unless ALL of these hold: it is on a paid plan, its owner opted in (and accepted the terms),
//    an admin set an ACTIVE unit price for that feature (prices ship empty), and the 'overage_billing' kill switch is on.
//  * Billable units are recorded at the moment of consumption with a snapshot of the unit price, keyed by the usage event, so replays and
//    retries cannot double-bill and later price changes cannot rewrite history.
import { PlanLimitError, quotaFor, effectivePlan } from '../entitlements.mjs';

export const OVERAGE_QUOTA = { meeting_report: 'ai.meeting_reports_per_month', assistant_message: 'ai.assistant_messages_per_month', doc_generation: 'ai.doc_generations_per_month' };
export const OVERAGE_FEATURES = Object.keys(OVERAGE_QUOTA);

export function createOverage({ flags }) {
  /** The unit price a workspace would pay beyond its quota for this feature, or null if overage is not available to it. */
  async function quote(db, workspaceId, feature) {
    if (!OVERAGE_QUOTA[feature] || !(await flags.enabled('overage_billing'))) return null;
    if ((await effectivePlan(db, workspaceId)) === 'basic') return null;
    const s = (await db.query('SELECT overage_enabled FROM portal.workspace_billing_settings WHERE workspace_id=$1', [workspaceId])).rows[0];
    if (!s?.overage_enabled) return null;
    const p = (await db.query('SELECT unit_amount_cents, currency FROM portal.usage_prices WHERE usage_feature=$1 AND active', [feature])).rows[0];
    return p ? { unit_amount_cents: p.unit_amount_cents, currency: p.currency } : null;
  }
  /** Throw the plan-limit error unless the workspace may keep going into billable overage. */
  async function allowBeyondQuota(db, workspaceId, feature, quotaInfo, extra = {}) {
    if (quotaInfo.granted && (await quote(db, workspaceId, feature))) return true;
    throw new PlanLimitError(OVERAGE_QUOTA[feature], quotaInfo.quota, quotaInfo.plan, { ...extra, overage_available: false });
  }
  /** Record one unit of usage (idempotent). If it lands beyond the quota and overage is available, also record the billable unit. */
  async function meter(db, workspaceId, feature, key, { jobId = null, plan = null } = {}) {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`usage:${workspaceId}:${feature}`]);          // serialise concurrent meters of one feature
    const ins = await db.query(`INSERT INTO portal.ai_usage_events(workspace_id,job_id,feature,units,idempotency_key,plan_slug) VALUES($1,$4,$2,1,$3,$5) ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING id`, [workspaceId, feature, key, jobId, plan]);
    if (!ins.rowCount) return { recorded: false, overage: false };
    const q = await quotaFor(db, workspaceId, OVERAGE_QUOTA[feature]);
    if (q.quota === null) return { recorded: true, overage: false };
    const position = Number((await db.query(`SELECT count(*) FROM portal.ai_usage_events WHERE workspace_id=$1 AND feature=$2 AND created_at >= date_trunc('month', now())`, [workspaceId, feature])).rows[0].count);
    if (position <= q.quota) return { recorded: true, overage: false };
    const price = await quote(db, workspaceId, feature);
    if (!price) return { recorded: true, overage: false, unbilled: true };
    await db.query(`INSERT INTO portal.usage_overage_events(workspace_id,usage_feature,units,unit_amount_cents,currency,period_month,idempotency_key) VALUES($1,$2,1,$3,$4,date_trunc('month', now())::date,$5) ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
      [workspaceId, feature, price.unit_amount_cents, price.currency, 'ovg:' + key]);
    return { recorded: true, overage: true, ...price };
  }
  return { quote, allowBeyondQuota, meter };
}
