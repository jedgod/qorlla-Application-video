// ASCS-M1.2 SERVER INTEGRATION: the REAL Meet server (ASCS + relay enabled), a real PostgreSQL, a real coturn in user-database mode, and real WebRTC through the relay.
// The relay client is SYNTHETIC (a pair of relay-only RTCPeerConnections in a Chromium page) but its credentials come from Meet's own API (POST .../relay-credentials), so every server-side
// rule is exercised for real. The real Meet PAGE is not involved here (see ascs-browser.e2e.mjs section G for that).
//
//   LAN_IP=<lan> tests/poc/relay-up.sh                      # coturn + Redis (qm12-*)
//   LAN_IP=<lan> TEST_PG_URL=... PLAYWRIGHT_DIR=<dir with node_modules/playwright>  node tests/e2e/ascs-relay.e2e.mjs        (ONLY=S1,S2,... runs some scenarios)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { respCommand } from '../../server/resp-client.mjs';
import { turnCli, parseSessions } from '../../server/turn-cli.mjs';

const here = dirname(fileURLToPath(import.meta.url)), ROOT = join(here, '..', '..'), SQL = join(ROOT, 'sql');
const LAN = process.env.LAN_IP; if (!LAN) { console.error('set LAN_IP'); process.exit(2); }
const PG = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25690/postgres';
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_DIR || process.cwd(), 'package.json'))('playwright');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const RELAY = { REDIS_HOST: '127.0.0.1', REDIS_PORT: '36390', CLI_HOST: '127.0.0.1', CLI_PORT: '35790', CLI_PASSWORD: 'clipw', REALM: 'qorlla.poc', TURN: `turn:${LAN}:34790?transport=udp` };
const only = (k) => !process.env.ONLY || process.env.ONLY.split(',').includes(k);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '   [' + detail + ']' : '')); };
const note = (t) => console.log('  OBSERVED ' + t);
async function until(fn, ms = 20000, step = 250) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await wait(step); } return null; }

// ---- the same page library as relay-revocation.poc.mjs: pairs of relay-only peer connections, ICE restart, allocation probe
const PAGE_LIB = `
window.__pairs = {};
const turn = (c) => (c ? [{ urls: c.urls, username: c.username, credential: c.credential }] : []);
window.makePair = async (name, { a, b, w = 640, h = 360, fps = 15, policy = 'relay' }) => {
  const errs = [], cfg = (c) => ({ iceServers: turn(c), iceTransportPolicy: policy });
  const A = new RTCPeerConnection(cfg(a)), B = new RTCPeerConnection(cfg(b));
  A.onicecandidateerror = (e) => errs.push('A:' + e.errorCode); B.onicecandidateerror = (e) => errs.push('B:' + e.errorCode);
  A.onicecandidate = (e) => e.candidate && B.addIceCandidate(e.candidate).catch(() => {}); B.onicecandidate = (e) => e.candidate && A.addIceCandidate(e.candidate).catch(() => {});
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const x = cv.getContext('2d'); let n = 0;
  const timer = setInterval(() => { n += 5; x.fillStyle = 'hsl(' + (n % 360) + ' 80% 50%)'; x.fillRect(0, 0, w, h); x.fillStyle = '#fff'; for (let i = 0; i < 40; i++) x.fillRect((n * 7 + i * 53) % w, (n * 3 + i * 31) % h, 30, 12); }, 1000 / fps);
  const stream = cv.captureStream(fps); stream.getTracks().forEach((t) => A.addTrack(t, stream));
  const offer = await A.createOffer(); await A.setLocalDescription(offer); await B.setRemoteDescription(offer);
  const ans = await B.createAnswer(); await B.setLocalDescription(ans); await A.setRemoteDescription(ans);
  window.__pairs[name] = { A, B, errs, timer };
};
window.pairStats = async (name) => { const { B, errs } = window.__pairs[name]; const st = await B.getStats(); let frames = 0, lt = null;
  st.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') frames = r.framesDecoded || 0; });
  st.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) { const p = st.get(r.selectedCandidatePairId); if (p) lt = (st.get(p.localCandidateId) || {}).candidateType; } });
  return { frames, lt, ice: B.iceConnectionState, errs: errs.slice() }; };
window.restartPair = async (name) => { const { A, B } = window.__pairs[name]; A.restartIce(); const o = await A.createOffer({ iceRestart: true }); await A.setLocalDescription(o); await B.setRemoteDescription(o); const an = await B.createAnswer(); await B.setLocalDescription(an); await A.setRemoteDescription(an); };
window.probe = async (c) => { const pc = new RTCPeerConnection({ iceServers: turn(c), iceTransportPolicy: 'relay' }); const errs = []; let relay = 0;
  pc.onicecandidateerror = (e) => errs.push(e.errorCode); pc.onicecandidate = (e) => { if (e.candidate && e.candidate.type === 'relay') relay++; };
  pc.createDataChannel('probe'); await pc.setLocalDescription(await pc.createOffer());
  await new Promise((res) => { if (pc.iceGatheringState === 'complete') return res(); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && res(); setTimeout(res, 9000); });
  pc.close(); return { relay, errs }; };
window.closePair = (name) => { const p = window.__pairs[name]; if (!p) return; clearInterval(p.timer); p.A.close(); p.B.close(); delete window.__pairs[name]; };
`;

// ---- a real Meet server process on a database
async function bootMeet({ port, dbUrl, env = {}, expectExit = false }) {
  const e = { ...process.env, PORT: String(port), DATABASE_URL: dbUrl, JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0123456789', ASCS_ENABLED: 'true', ASCS_RELAY_ENABLED: 'true', ASCS_LEASE_MS: '8000', ASCS_SWEEP_MS: '1000',
    RELAY_REDIS_HOST: RELAY.REDIS_HOST, RELAY_REDIS_PORT: RELAY.REDIS_PORT, RELAY_CLI_HOST: RELAY.CLI_HOST, RELAY_CLI_PORT: RELAY.CLI_PORT, RELAY_CLI_PASSWORD: RELAY.CLI_PASSWORD, RELAY_REALM: RELAY.REALM, RELAY_TURN_URLS: RELAY.TURN,
    RELAY_CREDENTIAL_TTL_SECONDS: '300', API_RATE_LIMIT: '100000', MEETING_RATE_LIMIT: '100000', SOCKET_EVENT_BUDGET: '100000', ...env };
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: e, stdio: ['ignore', 'pipe', 'pipe'] }); let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  for (let i = 0; i < 240 && !log.includes('listening'); i++) { await wait(250); if (child.exitCode !== null) break; }
  if (expectExit) { const code = child.exitCode ?? (await Promise.race([exited, wait(5000).then(() => null)])); try { child.kill(); } catch { /* gone */ } return { exited: code !== null, code, log }; }
  if (!log.includes('listening')) { try { child.kill(); } catch { /* gone */ } throw new Error('Meet did not start: ' + log.slice(-500)); }
  return { base: `http://127.0.0.1:${port}`, log: () => log, stop: async () => { child.kill(); await Promise.race([exited, wait(3000)]); } };
}
const http = (base) => async (method, path, token, body) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j }; };

async function main() {
  const admin = new pg.Pool({ connectionString: PG, max: 1 }); const dbName = 'm12e_' + Math.random().toString(36).slice(2, 8);
  await admin.query('CREATE DATABASE ' + dbName); const dbUrl = PG.replace(/\/[^/]*$/, '/' + dbName); const db = new pg.Pool({ connectionString: dbUrl, max: 4 });
  for (const f of ORDER) await db.query(readFileSync(join(SQL, f), 'utf8'));
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const page = await (await browser.newContext()).newPage();
  await page.goto('about:blank'); await page.addScriptTag({ content: PAGE_LIB });
  const servers = []; const spawnMeet = async (o) => { const s = await bootMeet(o); servers.push(s); return s; };
  const stats = (n) => page.evaluate((x) => window.pairStats(x), n);
  const flow = async (n, ms = 3000) => { const a = await stats(n); await wait(ms); const b = await stats(n); return { frames: b.frames - a.frames, lt: b.lt }; };
  const probe = (c) => page.evaluate((x) => window.probe(x), c);
  const sessionsOf = async (u) => (await turnCli(['ps ' + u], { host: '127.0.0.1', port: 35790, password: 'clipw' })).flatMap(parseSessions).filter((s) => s.user === u);
  let port = 4990;

  /** a meeting with a host, an admitted guest allowed to present (g1), and a second admitted guest (g2): all through the real API */
  async function meeting(srv) {
    const H = http(srv.base); const m = await H('POST', '/api/meetings', null, { title: 'relay', name: 'Hugo' }); const host = { token: m.body.token, pid: m.body.participantId };
    const mk = async (name) => { const j = await H('POST', `/api/meetings/${m.body.meetingId}/join`, null, { name }); await db.query("UPDATE participants SET admission='admitted' WHERE id=$1", [j.body.participantId]); return { token: j.body.token, pid: j.body.participantId }; };
    const g1 = await mk('Gail'), g2 = await mk('Gus');
    const grant = await H('POST', `/api/meetings/${m.body.meetingId}/participants/${g1.pid}/share`, host.token, { allow: true });
    return { H, id: m.body.meetingId, host, g1, g2, ok: grant.status === 200 };
  }
  const startShare = (M, who = M.g1) => M.H('POST', `/api/meetings/${M.id}/shares`, who.token, { kind: 'screen', mode: 'content', clientRequestId: randomUUID() });
  const creds = (M, sid, who) => M.H('POST', `/api/meetings/${M.id}/shares/${sid}/relay-credentials`, who.token, {});
  /** presenter + viewer credentials from the API, and a relay pair running on them */
  async function relayPair(M, name, share) {
    const p = await creds(M, share.id, M.g1), v = await creds(M, share.id, M.host);
    const cp = { ...p.body.iceServers[0], urls: p.body.iceServers[0].urls[0] }, cv = { ...v.body.iceServers[0], urls: v.body.iceServers[0].urls[0] };
    await page.evaluate(([n, a, b]) => window.makePair(n, { a, b }), [name, cp, cv]); const up = await until(async () => (await flow(name)).frames > 10, 45000, 500);
    return { p, v, cp, cv, up: !!up };
  }
  const relayRows = (shareId) => db.query('SELECT role, revoke_reason, terminated_at IS NOT NULL AS done FROM relay_credentials WHERE share_id=$1 ORDER BY role', [shareId]).then((r) => r.rows);

  try {
    console.log('S0. configuration and credential rules');
    const bad = await bootMeet({ port: port++, dbUrl, env: { RELAY_CLI_PORT: '' }, expectExit: true });
    check('relay enabled with an INCOMPLETE configuration: Meet refuses to start (never silently unenforced)', bad.exited && /ASCS_RELAY_ENABLED=true needs .*RELAY_CLI_PORT/.test(bad.log), bad.log.trim().split('\n').pop().slice(0, 120));
    const noAscs = await bootMeet({ port: port++, dbUrl, env: { ASCS_ENABLED: 'false' }, expectExit: true });
    check('relay enabled without ASCS: Meet refuses to start', noAscs.exited && /needs ASCS_ENABLED=true/.test(noAscs.log));
    const srv = await spawnMeet({ port: port++, dbUrl });
    const M = await meeting(srv); check('a meeting, a host, two admitted guests and a presenter permission, through the real API', M.ok);
    check('the page is told the relay is on (GET /tools)', (await M.H('GET', `/api/meetings/${M.id}/tools`, M.host.token)).body.relay === true);
    const noShare = await M.H('POST', `/api/meetings/${M.id}/shares/${randomUUID()}/relay-credentials`, M.g1.token, {}); check('credentials for a share that does not exist: 404', noShare.status === 404);
    const sh = await startShare(M); check('the presenter starts a share (the relay answered the start guard)', sh.status === 201);
    const sid = sh.body.id;
    check('no credentials without a token (401)', (await M.H('POST', `/api/meetings/${M.id}/shares/${sid}/relay-credentials`, null, {})).status === 401);
    const other = await meeting(srv); check('a token of ANOTHER meeting gets none (403)', (await M.H('POST', `/api/meetings/${M.id}/shares/${sid}/relay-credentials`, other.g1.token, {})).status === 403);
    const rp = await creds(M, sid, M.g1), rv = await creds(M, sid, M.host), rg = await creds(M, sid, M.g2);
    check('the SERVER decides the role: the owner is the presenter, everyone else a viewer', rp.body.role === 'presenter' && rv.body.role === 'viewer' && rg.body.role === 'viewer');
    check('credentials are relay-only, short-lived and per person (distinct usernames, no secret in the registry)', rp.body.iceTransportPolicy === 'relay' && rp.body.ttlSeconds === 300 && new Set([rp, rv, rg].map((r) => r.body.iceServers[0].username)).size === 3 && !JSON.stringify((await db.query('SELECT * FROM relay_credentials')).rows).includes(rp.body.iceServers[0].credential));
    await db.query("UPDATE participants SET admission='waiting' WHERE id=$1", [M.g2.pid]);
    check('a participant who is NOT admitted gets none (403)', (await creds(M, sid, M.g2)).status === 403); await db.query("UPDATE participants SET admission='admitted' WHERE id=$1", [M.g2.pid]);
    const burst = []; for (let i = 0; i < 8; i++) burst.push((await creds(M, sid, M.g2)).status); check('a client cannot mint credentials without bound (429 after 6 live ones)', burst.includes(429), JSON.stringify(burst));
    await M.H('DELETE', `/api/meetings/${M.id}/shares/${sid}`, M.g1.token);

    // ------------------------------------------------------------------------------------------------ S1
    if (only('S1')) {
      console.log('S1. host stops presenting');
      const m = await meeting(srv); const share = (await startShare(m)).body; const rp1 = await relayPair(m, 's1', share); check('the screen flows through the relay (relay candidate selected)', rp1.up && (await flow('s1')).lt === 'relay');
      check('coturn holds the presenter\'s allocation, found by the credential username', (await sessionsOf(rp1.cp.username)).length >= 1);
      const t0 = Date.now(); const rev = await m.H('POST', `/api/meetings/${m.id}/shares/${share.id}/revoke`, m.host.token, {}); const ms = Date.now() - t0;
      check('the revoke request returns only AFTER the relay was told (and says it was revoked)', rev.status === 200 && rev.body.revoked === true, ms + ' ms');
      check('Host stops presenting: the screen relay stops forwarding', !!(await until(async () => (await flow('s1', 1500)).frames <= 2, 20000, 100)));
      check('coturn lists no allocation of either credential any more', (await sessionsOf(rp1.cp.username)).length + (await sessionsOf(rp1.cv.username)).length === 0);
      const pr = await probe(rp1.cp), pv = await probe(rp1.cv); check('Revoked credential reused: connection denied (401, no relay candidate; presenter and viewer)', pr.relay === 0 && pv.relay === 0 && pr.errs.includes(401) && pv.errs.includes(401), JSON.stringify({ pr, pv }));
      await page.evaluate(() => window.restartPair('s1')); check('ICE restart after revocation: reconnection denied (25 s)', !(await until(async () => (await flow('s1', 2000)).frames > 10, 25000, 500)));
      check('New TURN allocation attempted with the old credentials: denied', (await probe(rp1.cp)).relay === 0);
      const again = await creds(m, share.id, m.g1); check('the server will NOT issue new credentials for the revoked share (409): reconnecting needs fresh authorization', again.status === 409);
      check('the registry records the revocation durably with its reason', (await relayRows(share.id)).every((r) => r.revoke_reason === 'share_host_revoked' && r.done));
      const ns = await startShare(m); const rp2 = ns.status === 201 ? await relayPair(m, 's1b', ns.body) : { up: false }; check('a NEW share (fresh server authorization) works with NEW credentials', rp2.up);
      await page.evaluate(() => { window.closePair('s1'); window.closePair('s1b'); }); await m.H('DELETE', `/api/meetings/${m.id}/shares/${ns.body.id}`, m.g1.token);
    }

    // ------------------------------------------------------------------------------------------------ S2
    if (only('S2')) {
      console.log('S2. the Shield removes the presenter (the participant is no longer admitted)');
      const m = await meeting(srv); const share = (await startShare(m)).body; const r = await relayPair(m, 's2', share); check('the screen flows through the relay', r.up);
      await db.query("UPDATE participants SET admission='denied' WHERE id=$1", [m.g1.pid]);              // exactly what the Shield session guard writes
      check('Shield revokes participant: the relay stops forwarding (via the invariant audit, within seconds)', !!(await until(async () => (await flow('s2', 1500)).frames <= 2, 25000, 100)));
      check('the share is revoked (participant_removed) and ALL its relay credentials are revoked and terminated', (await db.query("SELECT 1 FROM meeting_shares WHERE id=$1 AND state='revoked' AND end_reason='participant_removed'", [share.id])).rowCount === 1 && (await relayRows(share.id)).every((x) => x.revoke_reason === 'share_participant_removed' && x.done));
      check('the revoked presenter\'s credential gets 401', (await probe(r.cp)).errs.includes(401)); await page.evaluate(() => window.closePair('s2'));
    }

    // ------------------------------------------------------------------------------------------------ S3
    if (only('S3')) {
      console.log('S3. the share lease expires (the presenter\'s page vanished: nobody renews)');
      const m = await meeting(srv); const share = (await startShare(m)).body; const r = await relayPair(m, 's3', share); check('the screen flows through the relay', r.up);
      check('lease expiry: the relay stops forwarding (8 s lease + sweep)', !!(await until(async () => (await flow('s3', 1500)).frames <= 2, 40000, 200)));
      check('the share ended as lease_expired and its credentials were revoked and terminated', (await db.query("SELECT 1 FROM meeting_shares WHERE id=$1 AND end_reason='lease_expired'", [share.id])).rowCount === 1 && (await relayRows(share.id)).every((x) => x.revoke_reason === 'share_lease_expired' && x.done));
      await page.evaluate(() => window.closePair('s3'));
    }

    // ------------------------------------------------------------------------------------------------ S4
    if (only('S4')) {
      console.log('S4. the TURN control service is unavailable');
      const broken = await spawnMeet({ port: port++, dbUrl, env: { RELAY_CLI_PORT: '35799' } });
      const m = await meeting(broken); const st = await startShare(m);
      check('TURN control service down: a NEW share is denied (503), nothing is created', st.status === 503 && (await db.query("SELECT 1 FROM meeting_shares WHERE meeting_id=$1", [m.id])).rowCount === 0, JSON.stringify(st.body));
      await broken.stop(); servers.splice(servers.indexOf(broken), 1);
      const brokenRedis = await spawnMeet({ port: port++, dbUrl, env: { RELAY_REDIS_PORT: '36399' } }); const m2 = await meeting(brokenRedis);
      check('credential store (Redis) down: a NEW share is denied (503)', (await startShare(m2)).status === 503); await brokenRedis.stop(); servers.splice(servers.indexOf(brokenRedis), 1);
    }

    // ------------------------------------------------------------------------------------------------ S5
    if (only('S5')) {
      console.log('S5. server restart: a revocation survives, and is finished by the new process');
      const A1 = await spawnMeet({ port: port++, dbUrl }); const m = await meeting(A1); const share = (await startShare(m)).body; const r = await relayPair(m, 's5', share); check('the screen flows through the relay', r.up);
      await A1.stop(); servers.splice(servers.indexOf(A1), 1);                                                                                     // the first process dies
      const A2 = await spawnMeet({ port: port++, dbUrl, env: { RELAY_CLI_PORT: '35799' } });                                                      // a restart whose TURN control service is unreachable
      const preRevoke = await flow('s5', 1500); const shareRow = (await db.query('SELECT state, end_reason, lease_expires_at > now() AS lease_ok FROM meeting_shares WHERE id=$1', [share.id])).rows[0]; note(`just before the host revokes on the restarted process: ${preRevoke.frames} frames in 1.5 s, share ${JSON.stringify(shareRow)}`);
      const rv = await http(A2.base)('POST', `/api/meetings/${m.id}/shares/${share.id}/revoke`, m.host.token, {});
      check('the host revokes through the restarted process: the share is revoked', rv.status === 200 && rv.body.revoked === true);
      const pend = (await relayRows(share.id)); check('the revocation is PENDING termination in the registry (credential keys deleted, allocations not yet cancelled)', pend.length === 2 && pend.every((x) => x.revoke_reason === 'share_host_revoked' && !x.done));
      const exposure = await flow('s5', 3000); note(`exposure window while the control service is down: the existing allocation still forwards (${exposure.frames} frames in 3 s); a new allocation is already impossible (${JSON.stringify(await probe(r.cp))})`);
      check('...but nothing can re-allocate with those credentials (401)', (await probe(r.cp)).errs.includes(401));
      await A2.stop(); servers.splice(servers.indexOf(A2), 1);
      const A3 = await spawnMeet({ port: port++, dbUrl });                                                                                          // the next process: healthy; its boot reconcile finishes the job
      check('after the next restart the relay stops forwarding (boot reconcile)', !!(await until(async () => (await flow('s5', 1500)).frames <= 2, 30000, 200)));
      check('and the registry says terminated', !!(await until(async () => (await relayRows(share.id)).every((x) => x.done), 15000, 250)));
      await page.evaluate(() => window.closePair('s5'));
    }

    // ------------------------------------------------------------------------------------------------ S7
    if (only('S7')) {
      console.log('S7. a share that outlives its credentials\' TTL keeps running while it is renewed (an allocation outlives its credential, so without renewal reconcile would kill every share at the first expiry)');
      const longSrv = await spawnMeet({ port: port++, dbUrl, env: { RELAY_CREDENTIAL_TTL_SECONDS: '30' } });
      const m = await meeting(longSrv); const share = (await startShare(m)).body;
      const beat = setInterval(() => { m.H('POST', `/api/meetings/${m.id}/shares/${share.id}/heartbeat`, m.g1.token, {}).catch(() => {}); }, 2000);                                                              // the presenter's page renews the lease from the very first second
      const r = await relayPair(m, 's7', share); check('the screen flows through the relay (credential TTL 30 s)', r.up);
      const samples = []; for (let i = 0; i < 5; i++) { await wait(15000); samples.push((await flow('s7', 2000)).frames); }                      // 75 s: two and a half credential lifetimes
      const exp = (await db.query('SELECT min(expires_at) - now() AS left FROM relay_credentials WHERE share_id=$1 AND revoked_at IS NULL', [share.id])).rows[0].left;
      check('the share is STILL flowing after 2.5 credential lifetimes, sampled every 15 s: ' + JSON.stringify(samples), samples.every((x) => x > 10));
      check('its credentials were extended with the heartbeat (still valid, none revoked, none expired)', !!exp && ((await relayRows(share.id)).every((x) => !x.revoke_reason)));
      clearInterval(beat);                                                                                                                           // the presenter's page vanishes: nobody renews any more
      check('when the renewals STOP the lease ends the share and the relay stops forwarding', !!(await until(async () => (await flow('s7', 1500)).frames <= 2, 60000, 200)));
      check('and its credentials are revoked and terminated', !!(await until(async () => (await relayRows(share.id)).every((x) => x.done), 20000, 250)));
      await page.evaluate(() => window.closePair('s7')); await longSrv.stop(); servers.splice(servers.indexOf(longSrv), 1);
    }

    // ------------------------------------------------------------------------------------------------ S6
    if (only('S6')) {
      console.log('S6. LIMITATION (documented, demonstrated): a modified client can send screen content through its ORDINARY camera connection');
      const m = await meeting(srv); const share = (await startShare(m)).body; const r = await relayPair(m, 's6share', share);
      await page.evaluate(() => window.makePair('s6cam', { a: null, b: null, policy: 'all' }));            // the ordinary camera/mic path: direct, not relayed, not governed by the share credentials
      check('a camera-path pair carrying screen-like content flows', !!(await until(async () => (await flow('s6cam')).frames > 10, 30000, 500)));
      await m.H('POST', `/api/meetings/${m.id}/shares/${share.id}/revoke`, m.host.token, {});
      check('the share channel is dead after the revoke', !!(await until(async () => (await flow('s6share', 1500)).frames <= 2, 20000, 100)));
      const camAfter = await flow('s6cam', 3000); check('LIMITATION: content sent over the ordinary camera connection STILL flows after the share was revoked (the relay cannot tell screen from camera; an SFU is required)', camAfter.frames > 10, camAfter.frames + ' frames in 3 s');
      await page.evaluate(() => { window.closePair('s6share'); window.closePair('s6cam'); });
    }
  } finally {
    await browser.close().catch(() => {}); for (const s of servers) await s.stop().catch(() => {}); await db.end().catch(() => {}); await admin.query('DROP DATABASE IF EXISTS ' + dbName + ' WITH (FORCE)').catch(() => {}); await admin.end().catch(() => {});
  }
  const failed = results.filter((r) => !r.ok); console.log(`\n${results.length - failed.length}/${results.length} checks passed`); process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
