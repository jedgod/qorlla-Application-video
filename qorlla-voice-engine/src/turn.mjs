// Allocation-controlled relay (A3.7.1): the engine controls TURN credentials and TURN allocations, so that suspending or revoking an account ends the account's MEDIA, not only its signaling.
// Two modes:
//   rest    (default, unchanged): stateless coturn "REST API" credentials (HMAC + expiry). The engine cannot revoke one; it can only (if the relay's admin CLI is configured) cancel the account's live allocations.
//           A revoked client may re-allocate with an old credential until it expires (TURN_CREDENTIAL_TTL_SECONDS).
//   userdb  (TURN_AUTH_MODE=userdb): credentials live in coturn's Redis user database (coturn runs --lt-cred-mech --redis-userdb). The engine issues an opaque, short-lived, per-account credential and can DELETE
//           it, so a revoked account cannot allocate, refresh or reuse it from the next request on; the relay's admin CLI then cancels the allocations that are already running (their media stops at once).
// The credential PASSWORD is never stored: it is HMAC(TURN_CREDENTIAL_SECRET, username); Redis holds only coturn's own MD5 key. Nothing here places a call or reaches a carrier.
import net from 'node:net';
import { createClient } from 'redis';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const md5hex = (s) => createHash('md5').update(s).digest('hex');
export class TurnConfigError extends Error { constructor(m) { super(m); this.code = 'turn_config'; } }

/** Speaks coturn's telnet-style admin CLI: log in, run commands, return each command's output. */
export async function turnCli(commands, { host, port, password, timeoutMs = 3000 }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host), outs = []; let buf = '', stage = 'login', i = 0, done = false;
    const finish = (err) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch { /* closed */ } err ? reject(err) : resolve(outs); };
    const timer = setTimeout(() => finish(new Error('turn_cli_timeout')), timeoutMs);
    sock.on('error', (e) => finish(e)); sock.on('close', () => finish(done ? undefined : new Error('turn_cli_closed')));
    sock.on('data', (d) => {
      buf += d.toString().replace(/\r/g, '');
      if (stage === 'login' && /Enter password:\s*$/.test(buf)) { buf = ''; stage = 'pw'; sock.write(password + '\r\n'); return; }
      if (stage === 'pw' && /Enter password:\s*$/.test(buf)) return finish(new Error('turn_cli_auth_failed'));
      if ((stage === 'pw' || stage === 'cmd') && /(^|\n)> $/.test(buf)) {
        if (stage === 'cmd') outs.push(buf.replace(/\n> $/, '')); stage = 'cmd';
        buf = ''; if (i >= commands.length) { try { sock.write('quit\r\n'); } catch { /* closed */ } return finish(); }
        sock.write(commands[i++] + '\r\n');
      }
    });
  });
}
/** "  1) id=003000000000000001, user <u1>:" -> [{ id, user }] */
export function parseSessions(text) { return [...String(text).matchAll(/^\s*\d+\)\s+id=([0-9a-fA-F]+),\s+user\s+<([^>]*)>/gm)].map((m) => ({ id: m[1], user: m[2] })); }

export function createTurnControl({ env = process.env, createRedis = (url) => createClient({ url }) } = {}) {
  const mode = env.TURN_AUTH_MODE === 'userdb' ? 'userdb' : 'rest';
  const cli = env.TURN_CLI_HOST && env.TURN_CLI_PASSWORD ? { host: env.TURN_CLI_HOST, port: Number(env.TURN_CLI_PORT || 5766), password: env.TURN_CLI_PASSWORD, timeoutMs: Number(env.TURN_CLI_TIMEOUT_MS || 3000) } : null;
  const ttl = Math.min(3600, Math.max(5, Number(env.TURN_CREDENTIAL_TTL_SECONDS || 600) || 600)), realm = env.TURN_REALM || '';
  if (mode === 'userdb') {
    const missing = ['TURN_USERDB_REDIS_URL', 'TURN_REALM', 'TURN_CREDENTIAL_SECRET', 'TURN_CLI_HOST', 'TURN_CLI_PASSWORD'].filter((k) => !env[k]);
    if (missing.length) throw new TurnConfigError('TURN_AUTH_MODE=userdb needs ' + missing.join(', '));
    if (String(env.TURN_CREDENTIAL_SECRET).length < 32) throw new TurnConfigError('TURN_CREDENTIAL_SECRET must be at least 32 characters');
  }
  let redis = null, connecting = null;
  const getRedis = async () => {
    if (redis) return redis;
    connecting = connecting || (async () => { const c = createRedis(env.TURN_USERDB_REDIS_URL); c.on('error', () => {}); await Promise.race([c.connect(), new Promise((_r, no) => setTimeout(() => no(new Error('turn_redis_timeout')), 3000))]); redis = c; return c; })().finally(() => { connecting = null; });
    return connecting;
  };
  const userKey = (u) => `turn/realm/${realm}/user/${u}/key`, acctSet = (a) => `qorlla:turn:acct:${a}`, current = (a) => `qorlla:turn:cur:${a}`;
  const password = (username) => createHmac('sha256', env.TURN_CREDENTIAL_SECRET).update(username).digest('base64url');

  /** A credential for this account: reused while more than 40% of its life remains (so ICE restarts do not multiply credentials), otherwise a fresh opaque one. `stillActive` re-checks the account AFTER the credential exists, closing the race with a concurrent revocation. */
  async function issue(accountId, { stillActive } = {}) {
    if (mode !== 'userdb') throw new Error('not_userdb_mode');
    const r = await getRedis(), cur = await r.get(current(accountId)); let username = null;
    if (cur) { const { u, exp } = JSON.parse(cur); if (exp - Date.now() / 1000 > ttl * 0.4 && (await r.exists(userKey(u)))) username = u; }
    if (!username) {
      username = 'q' + randomBytes(12).toString('base64url'); const exp = Math.floor(Date.now() / 1000) + ttl;
      await r.multi().set(userKey(username), md5hex(`${username}:${realm}:${password(username)}`), { EX: ttl }).sAdd(acctSet(accountId), username).expire(acctSet(accountId), ttl * 3).set(current(accountId), JSON.stringify({ u: username, exp }), { EX: ttl }).exec();
      if (stillActive && !(await stillActive())) { await revokeCredentials(accountId); throw Object.assign(new Error('revoked_during_issue'), { code: 'suspended' }); }
    }
    return { username, credential: password(username), ttl };
  }
  async function revokeCredentials(accountId) {
    const r = await getRedis(), names = await r.sMembers(acctSet(accountId)); if (!names.length) { await r.del(current(accountId)); return []; }
    await r.multi().del(names.map(userKey)).del(acctSet(accountId)).del(current(accountId)).exec(); return names;
  }
  /** Ends the account's media: (userdb) its credentials are deleted, then (when the relay admin CLI is configured) every live allocation it holds is cancelled. Never throws: the outcome says what happened. */
  async function revokeAccount(accountId) {
    const out = { mode, credentials: 0, sessions: 0, errors: [] }; let names = [];
    if (mode === 'userdb') { try { names = await revokeCredentials(accountId); out.credentials = names.length; } catch (e) { out.errors.push('credentials:' + (e.message || e)); } }
    if (cli) {
      try {
        const probe = mode === 'userdb' ? names.map((u) => 'ps ' + u) : ['psp :' + accountId], outs = probe.length ? await turnCli(probe, cli) : [], ids = [];
        for (const text of outs) for (const s of parseSessions(text)) if (mode === 'userdb' || s.user.endsWith(':' + accountId)) ids.push(s.id);
        if (ids.length) await turnCli(ids.map((id) => 'cs ' + id), cli); out.sessions = ids.length;
        if (ids.length) { const left = (await turnCli(probe, cli)).flatMap(parseSessions).filter((s) => ids.includes(s.id)); if (left.length) out.errors.push('sessions_remaining:' + left.length); }
      } catch (e) { out.errors.push('cli:' + (e.message || e)); }
    } else if (mode === 'rest') out.errors.push('cli_not_configured');
    return out;
  }
  return { mode, ttl, cliConfigured: !!cli, issue, revokeAccount, close: async () => { try { await redis?.quit(); } catch { /* closed */ } } };
}
