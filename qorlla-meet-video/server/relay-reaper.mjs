// ASCS-M1.3: the RELAY REAPER. A tiny watchdog that needs ONLY the credential store (Redis) and the coturn admin CLI: no database, no Meet, no Shield.
//
// WHY: coturn keeps forwarding an allocation that already exists even after its credential's key is deleted or has expired (measured in M1.1/M1.2/M1.3: it re-uses the key cached in the
// session). Meet's own reconciler closes that gap, but if MEET is down nobody would. The reaper closes it independently:
//     every sweep:  list coturn's allocations -> for each user, does its credential key still exist in Redis? -> if not, cancel that user's allocations.
// Credentials are renewed by the share's heartbeat (relay-authority renewShare), so with Meet down the keys expire within the credential TTL, and the reaper ends the media shortly after:
//     enforcement bound while Meet is DOWN  =  credential TTL  +  one reaper sweep      (RELAY_CREDENTIAL_TTL_SECONDS, minimum 30; recommended 60 in production)
// Run it as its own process/container (so it survives a Meet outage):    node server/relay-reaper.mjs      (env: REAPER_REDIS_*, REAPER_CLI_*, REAPER_REALM, REAPER_INTERVAL_SECONDS)
// Meet runs the same sweep inside its reconcile pass too (belt and braces).
import { respCommand } from './resp-client.mjs';
import { turnCli, parseSessions } from './turn-cli.mjs';

export function createReaper({ redis, cli, realm, log = console, timeoutMs = 4000 }) {
  const redisCfg = { ...redis, timeoutMs }, cliCfg = { ...cli, timeoutMs: Math.max(timeoutMs, 6000) }, keyOf = (u) => `turn/realm/${realm}/user/${u}/key`;
  const stats = { sweeps: 0, orphansFound: 0, cancelled: 0, failures: 0, lastSweepAt: null, lastOk: null };
  async function sweep() {
    stats.sweeps++; const out = { sessions: 0, users: 0, orphanUsers: [], cancelled: 0, errors: [] };
    try {
      const sessions = parseSessions((await turnCli(['ps'], cliCfg))[0] || ''); out.sessions = sessions.length;
      const byUser = new Map(); for (const s of sessions) (byUser.get(s.user) || byUser.set(s.user, []).get(s.user)).push(s.id); out.users = byUser.size;
      const users = [...byUser.keys()]; let alive = new Set();
      if (users.length) { for (let i = 0; i < users.length; i += 100) { const chunk = users.slice(i, i + 100);                  // EXISTS counts; ask one by one only when some are missing
        const n = Number(await respCommand(['EXISTS', ...chunk.map(keyOf)], redisCfg));
        if (n === chunk.length) chunk.forEach((u) => alive.add(u));
        else for (const u of chunk) if (Number(await respCommand(['EXISTS', keyOf(u)], redisCfg)) === 1) alive.add(u); } }
      out.orphanUsers = users.filter((u) => !alive.has(u));
      const ids = out.orphanUsers.flatMap((u) => byUser.get(u));
      if (ids.length) { await turnCli(ids.map((id) => 'cs ' + id), cliCfg); out.cancelled = ids.length; log.warn?.('[relay-reaper] cancelled ' + ids.length + ' allocation(s) of ' + out.orphanUsers.length + ' credential(s) that no longer exist'); }
      stats.orphansFound += out.orphanUsers.length; stats.cancelled += out.cancelled; stats.lastOk = true;
    } catch (e) { out.errors.push(e.message); stats.failures++; stats.lastOk = false; }
    stats.lastSweepAt = new Date().toISOString(); return out;
  }
  return { sweep, stats };
}

// stand-alone mode
if (process.argv[1] && /relay-reaper\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const e = process.env, need = ['REAPER_REDIS_HOST', 'REAPER_REDIS_PORT', 'REAPER_CLI_HOST', 'REAPER_CLI_PORT', 'REAPER_CLI_PASSWORD', 'REAPER_REALM'].filter((k) => !e[k]);
  if (need.length) { console.error('relay-reaper needs ' + need.join(', ')); process.exit(2); }
  const r = createReaper({ redis: { host: e.REAPER_REDIS_HOST, port: Number(e.REAPER_REDIS_PORT), password: e.REAPER_REDIS_PASSWORD || null }, cli: { host: e.REAPER_CLI_HOST, port: Number(e.REAPER_CLI_PORT), password: e.REAPER_CLI_PASSWORD }, realm: e.REAPER_REALM });
  const every = Math.max(2, Number(e.REAPER_INTERVAL_SECONDS) || 5) * 1000; console.log('[relay-reaper] sweeping every ' + every / 1000 + ' s');
  const tick = async () => { const o = await r.sweep(); if (o.errors.length) console.error('[relay-reaper] sweep failed: ' + o.errors.join('; ')); };
  tick(); setInterval(tick, every);
}
