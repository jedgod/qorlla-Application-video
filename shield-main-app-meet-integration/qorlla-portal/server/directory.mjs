// Display names for account ids, from MAIN (the only system that knows people). Cached briefly; failures degrade to "no name".
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function createDirectory({ baseUrl, secret, fetchImpl = fetch, now = () => Date.now(), ttlMs = 60_000 }) {
  const cache = new Map();
  const enabled = !!(baseUrl && secret);
  async function name(uuid) {
    if (!enabled || !UUID_RE.test(uuid)) return null;
    const hit = cache.get(uuid); if (hit && hit.until > now()) return hit.name;
    let n = null;
    try {
      const r = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/${uuid}`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(2000) });
      if (r.ok) n = (await r.json()).displayName || null;
    } catch { /* names are a convenience, never a dependency */ }
    cache.set(uuid, { name: n, until: now() + ttlMs }); if (cache.size > 5000) cache.clear();
    return n;
  }
  const names = async (ids) => Object.fromEntries(await Promise.all([...new Set(ids)].map(async (id) => [id, await name(id)])));
  return { enabled, name, names };
}
