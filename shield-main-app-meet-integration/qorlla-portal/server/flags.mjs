// Platform kill switches. Stored in PostgreSQL so every replica agrees; cached for a few seconds so a hot path costs no query.
// A switched-off feature answers 503 {code:'feature_disabled'} and background workers pause (jobs stay queued and resume when re-enabled).
export const FLAG_KEYS = ['checkout', 'plan_changes', 'ai', 'overage_billing'];

export function createFlags({ pool, ttlMs = 3000, now = () => Date.now() }) {
  let cache = null, at = 0;
  async function load() {
    if (cache && now() - at < ttlMs) return cache;
    try { cache = Object.fromEntries((await pool.query('SELECT key, enabled, reason, updated_at FROM portal.platform_flags')).rows.map((r) => [r.key, r])); at = now(); }
    catch (e) { if (!cache) throw e; }                       // keep serving the last known state if the database blips
    return cache;
  }
  const enabled = async (key) => { const f = (await load())[key]; return f ? f.enabled : true; };
  async function list() { cache = null; return Object.values(await load()).sort((a, b) => a.key.localeCompare(b.key)); }
  async function set(key, on, reason, actor) {
    if (!FLAG_KEYS.includes(key)) throw Object.assign(new Error('Unknown flag'), { http: { status: 400, body: { error: 'Unknown flag' } } });
    await pool.query(`INSERT INTO portal.platform_flags(key,enabled,reason,updated_by,updated_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT (key) DO UPDATE SET enabled=EXCLUDED.enabled, reason=EXCLUDED.reason, updated_by=EXCLUDED.updated_by, updated_at=now()`, [key, on, reason || null, actor]);
    cache = null;
  }
  /** Express middleware: 503 while the switch is off. */
  const require = (key) => async (req, res, next) => {
    try { if (await enabled(key)) return next(); res.status(503).json({ error: 'This feature is temporarily switched off by the platform operators.', code: 'feature_disabled', flag: key }); } catch (e) { next(e); }
  };
  return { enabled, list, set, require };
}
