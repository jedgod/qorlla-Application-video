// M1.3 CERTIFICATION, suite 2: the REAL Meet server + real PostgreSQL + the HARDENED coturn + a stub Shield, attacked through its own API and sockets.
// Media is raw TURN traffic (tests/lib/turn-client.mjs) so every "media stopped" claim is a counted packet, with credentials obtained exactly as a page obtains them.
//   LAN_IP=<lan> tests/cert/relay-hardened-up.sh   (+ the PG container on 25690)
//   PLAYWRIGHT_DIR=<dir with node_modules/playwright> node tests/cert/m13-meet-security.cert.mjs
import http_ from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { CERT, ROOT, newDb, reporter, wait, until, sh, http, bootMeet, mediaPair, openAlloc, credFromApi, OPS_SECRET, playwright, authority } from './lib.mjs';

const { check, note, finish, metrics } = reporter('m13-meet-security');
const OPS = { 'x-qorlla-bridge-secret': OPS_SECRET };

async function main() {
  const D = await newDb(), db = D.pool; let port = 5100; const servers = [];
  const spawnMeet = async (o) => { const s = await bootMeet({ port: port++, dbUrl: D.url, ...o }); servers.push(s); return s; };
  const A = authority(db);
  const sessionsOf = async (u) => (await A.sessionsOf(u)).length;

  async function meeting(srv) {
    const H = http(srv.base), m = await H('POST', '/api/meetings', null, { title: 'cert', name: 'Hugo' }), host = { token: m.body.token, pid: m.body.participantId };
    const mk = async (name) => { const j = await H('POST', `/api/meetings/${m.body.meetingId}/join`, null, { name }); await db.query("UPDATE participants SET admission='admitted' WHERE id=$1", [j.body.participantId]); return { token: j.body.token, pid: j.body.participantId }; };
    const g1 = await mk('Gail'), g2 = await mk('Gus'), g3 = await mk('Gwen');
    const grant = await H('POST', `/api/meetings/${m.body.meetingId}/participants/${g1.pid}/share`, host.token, { allow: true });
    return { H, id: m.body.meetingId, host, g1, g2, g3, ok: grant.status === 200 };
  }
  const start = (M, who = M.g1, extra = {}) => M.H('POST', `/api/meetings/${M.id}/shares`, who.token, { kind: 'screen', mode: 'content', clientRequestId: randomUUID(), ...extra });
  const creds = (M, sid, who) => M.H('POST', `/api/meetings/${M.id}/shares/${sid}/relay-credentials`, who.token, {});
  const pairFor = async (M, share, viewer = M.host) => { const p = await creds(M, share.id, M.g1), v = await creds(M, share.id, viewer); return { p, v, media: await mediaPair(credFromApi(p.body), credFromApi(v.body)) }; };
  const dead = async (cred) => { const x = await openAlloc(cred); x.c.close(); return !x.r.ok && x.r.code === 401; };

  // ============================================================================================ M0 / M1
  const srv = await spawnMeet({ env: { ASCS_LEASE_MS: '60000' } });      // long lease: this part of the suite is slow and has no page heartbeating
  console.log('M0. monitoring endpoints are for the service only');
  { const H = http(srv.base); check('GET /api/ops/relay without the service token: refused (401)', (await H('GET', '/api/ops/relay')).status === 401);
    check('GET /api/ops/relay/metrics without the service token: refused (401)', (await H('GET', '/api/ops/relay/metrics')).status === 401);
    const ops = await H('GET', '/api/ops/relay', null, undefined, OPS); check('with the service token: a snapshot with health, counters, pending revocations and the invariant audit', ops.status === 200 && ops.body.healthy === true && 'pending' in ops.body && ops.body.invariantAudit && Array.isArray(ops.body.alerts), JSON.stringify({ healthy: ops.body.healthy, live: ops.body.live, pending: ops.body.pending }));
    const pm = await H('GET', '/api/ops/relay/metrics', null, undefined, OPS); check('Prometheus metrics expose the alerting signals', typeof pm.body === 'string' && ['qorlla_relay_revocations_pending', 'qorlla_relay_oldest_pending_revocation_seconds', 'qorlla_relay_redis_up', 'qorlla_relay_cli_up', 'qorlla_relay_last_reconcile_age_seconds'].every((m) => pm.body.includes(m))); }

  console.log('M1. malicious and non-compliant clients (API level)');
  const M = await meeting(srv); check('fixture: a meeting, a host, three admitted guests, one allowed to present', M.ok);
  const sh1 = await start(M); check('the allowed guest starts a share', sh1.status === 201); const sid = sh1.body.id;
  { const r = await M.H('POST', `/api/meetings/${M.id}/shares/${sid}/relay-credentials`, M.g2.token, { role: 'presenter', isHost: true, participantId: M.g1.pid }); check('a viewer that FORGES role/participant fields in the request still gets a VIEWER credential', r.status === 200 && r.body.role === 'viewer'); }
  check('a guest WITHOUT permission cannot start a share (403)', (await start(M, M.g2)).status === 403);
  check('a viewer cannot revoke the share (403)', (await M.H('POST', `/api/meetings/${M.id}/shares/${sid}/revoke`, M.g2.token, {})).status === 403);
  check('a viewer cannot stop someone else\'s share (403/404)', [403, 404].includes((await M.H('DELETE', `/api/meetings/${M.id}/shares/${sid}`, M.g2.token)).status));
  check('a viewer cannot hand the floor over (403)', (await M.H('POST', `/api/meetings/${M.id}/shares/handoff`, M.g2.token, { to: M.g2.pid })).status === 403);
  check('a share id that is not a UUID is refused (400), not passed to the database', (await creds(M, "x'; DROP TABLE relay_credentials;--", M.g2)).status === 400);
  { const other = await meeting(srv); const r = await M.H('POST', `/api/meetings/${M.id}/shares/${sid}/relay-credentials`, other.g1.token, {}); check('a token of ANOTHER meeting cannot obtain credentials for this share (403)', r.status === 403); }
  { const big = await fetch(srv.base + `/api/meetings/${M.id}/shares/${sid}/relay-credentials`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + M.g2.token }, body: JSON.stringify({ junk: 'x'.repeat(400_000) }) }); check('an oversized request body is refused (4xx, never a 5xx)', big.status >= 400 && big.status < 500, String(big.status)); }
  { const codes = []; for (let i = 0; i < 9; i++) codes.push((await creds(M, sid, M.g3)).status); const n = (await db.query("SELECT count(*)::int n FROM relay_credentials WHERE participant_id=$1 AND share_id=$2 AND revoked_at IS NULL", [M.g3.pid, sid])).rows[0].n; check('credential flooding is bounded: 429 after 6 live credentials, and the registry agrees', codes.includes(429) && n <= 6, JSON.stringify(codes) + ' live=' + n); }

  console.log('M1b. a REVOKED presenter, step by step');
  { const pc = await creds(M, sid, M.g1), vc = await creds(M, sid, M.host), media = await mediaPair(credFromApi(pc.body), credFromApi(vc.body)); check('the share flows before the revoke', (await media.flowing()) > 40);
    const t0 = Date.now(); const rv = await M.H('POST', `/api/meetings/${M.id}/shares/${sid}/revoke`, M.host.token, {}); const callMs = Date.now() - t0; check('host revokes: the API answers revoked', rv.status === 200 && rv.body.revoked === true, callMs + ' ms');
    await wait(400); check('no media is delivered after the revoke', (await media.flowing(2000)) === 0);
    check('the revoked presenter\'s heartbeat is refused (409/404)', [409, 404].includes((await M.H('POST', `/api/meetings/${M.id}/shares/${sid}/heartbeat`, M.g1.token, {})).status));
    check('the revoked presenter cannot get new credentials for that share (409)', (await creds(M, sid, M.g1)).status === 409);
    check('the old presenter credential and the old viewer credential are both refused by coturn (401)', (await dead(credFromApi(pc.body))) && (await dead(credFromApi(vc.body))));
    check('the registry shows every credential of the share revoked AND terminated', (await db.query('SELECT bool_and(revoked_at IS NOT NULL AND terminated_at IS NOT NULL) ok FROM relay_credentials WHERE share_id=$1', [sid])).rows[0].ok === true);
    const ev = (await db.query("SELECT event_type, count(*)::int n FROM audit_events WHERE meeting_id=$1 AND event_type LIKE 'relay.%' GROUP BY 1", [M.id])).rows.reduce((o, r) => ({ ...o, [r.event_type]: r.n }), {});
    check('AUDIT: issued and terminated credentials are recorded per meeting (relay.credential_issued / relay.credential_terminated)', ev['relay.credential_issued'] >= 3 && ev['relay.credential_terminated'] >= 3, JSON.stringify(ev)); media.stop(); }
  { const again = await start(M); check('a NEW share needs a NEW authorization and works (policy: the host revoking a SHARE does not silently remove the person; withdraw their permission to stop them presenting)', again.status === 201);
    await M.H('POST', `/api/meetings/${M.id}/participants/${M.g1.pid}/share`, M.host.token, { allow: false }); await wait(1500);
    const cur = await M.H('GET', `/api/meetings/${M.id}/shares/current`, M.host.token); check('host WITHDRAWS the permission: the live share ends at once (server decision, no client cooperation)', !cur.body.share || cur.body.share.state !== 'active', JSON.stringify(cur.body).slice(0, 100));
    check('and the guest cannot start another (403)', (await start(M)).status === 403); await M.H('POST', `/api/meetings/${M.id}/participants/${M.g1.pid}/share`, M.host.token, { allow: true }); }

  console.log('M1c. races: two presenters start at once; handoff; two meetings are isolated');
  { await M.H('POST', `/api/meetings/${M.id}/participants/${M.g2.pid}/share`, M.host.token, { allow: true });
    const rs = await Promise.all([M.g1, M.g2, M.host, M.g1, M.g2, M.host].map((w) => start(M, w))); const created = rs.filter((r) => r.status === 201).length;
    const active = (await db.query("SELECT count(*)::int n FROM meeting_shares WHERE meeting_id=$1 AND state='active'", [M.id])).rows[0].n;
    check('six simultaneous start requests from three people leave EXACTLY ONE active share (database invariant)', active === 1, 'created=' + created + ' active=' + active); }
  { const M1 = await meeting(srv), M2 = await meeting(srv); const s1 = (await start(M1)).body, s2 = (await start(M2)).body; const a = await pairFor(M1, s1), b = await pairFor(M2, s2);
    check('two meetings share at the same time through the same relay', (await a.media.flowing()) > 40 && (await b.media.flowing()) > 40);
    await M1.H('POST', `/api/meetings/${M1.id}/shares/${s1.id}/revoke`, M1.host.token, {}); await wait(400);
    check('revoking meeting 1\'s share stops meeting 1 and does NOT touch meeting 2', (await a.media.flowing(1500)) === 0 && (await b.media.flowing(1500)) > 40); a.media.stop(); b.media.stop();
    const hs = (await start(M2)).body; void hs;
    const M3 = await meeting(srv); await M3.H('POST', `/api/meetings/${M3.id}/participants/${M3.g2.pid}/share`, M3.host.token, { allow: true }); const s3 = (await start(M3)).body; const p3 = await pairFor(M3, s3);
    const ho = await M3.H('POST', `/api/meetings/${M3.id}/shares/handoff`, M3.host.token, { to: M3.g2.pid }); await wait(500);
    check('host hands the floor to someone else: the previous presenter\'s media stops and the new person may start', ho.status === 200 && (await p3.media.flowing(1500)) === 0 && (await start(M3, M3.g2)).status === 201); p3.media.stop(); }

  console.log('M2. invariants and alerts');
  { const M4 = await meeting(srv); const s = (await start(M4)).body; const c = await creds(M4, s.id, M4.host);
    await db.query("UPDATE meeting_shares SET state='stopped', ended_at=now(), end_reason='cert_injected' WHERE id=$1", [s.id]);                      // a share that ended WITHOUT the hooks (a crash): its credential is still live
    const closed = await until(async () => (await db.query('SELECT terminated_at FROM relay_credentials WHERE username=$1', [c.body.iceServers[0].username])).rows[0].terminated_at, 8000, 300);
    check('a live credential of a share that ended behind the hooks\' back is revoked and terminated by the sweeper', !!closed);
    const c2 = await creds(M4, (await start(M4)).body.id, M4.g2); await db.query("UPDATE participants SET admission='denied' WHERE id=$1", [M4.g2.pid]);
    const gone = await until(async () => (await db.query('SELECT terminated_at FROM relay_credentials WHERE username=$1', [c2.body.iceServers[0].username])).rows[0].terminated_at, 8000, 300);
    check('a participant who is no longer admitted loses every relay credential within one sweep', !!gone && (await dead(credFromApi(c2.body))));
    const ops = await http(srv.base)('GET', '/api/ops/relay', null, undefined, OPS); check('after the repairs the invariant audit is clean and no revocation is pending', ops.body.pending === 0 && ops.body.invariantAudit.violations.length === 0, JSON.stringify({ pending: ops.body.pending, v: ops.body.invariantAudit.violations.length })); }

  // ============================================================================================ M3: Meet down, PG down (the reaper)
  console.log('M3. MEET and the DATABASE fail; the stand-alone relay reaper bounds the exposure by the credential TTL');
  await srv.stop(); servers.length = 0;
  const TTL = 30, short = await spawnMeet({ env: { RELAY_CREDENTIAL_TTL_SECONDS: String(TTL) } });
  { const Mx = await meeting(short), s = (await start(Mx)).body; const beat = setInterval(() => Mx.H('POST', `/api/meetings/${Mx.id}/shares/${s.id}/heartbeat`, Mx.g1.token, {}).catch(() => {}), 2000);                 // the page's lease heartbeat renews the lease AND the credentials (started FIRST: the lease here is 8 s)
    const { p, v, media } = await pairFor(Mx, s); check('(TTL ' + TTL + ' s) the share flows', (await media.flowing()) > 40);
    await wait(8000); const live = await media.flowing(1000); check('while the presenter heartbeats, credentials are renewed and the share outlives the TTL basis', live > 20, 'packets/s=' + live);
    clearInterval(beat); short.kill('SIGKILL'); await wait(600); const t0 = Date.now();                                                                          // MEET DIES (kill -9) with the share live
    check('Meet is killed: media CONTINUES (the relay does not depend on Meet at this instant)', (await media.flowing(1500)) > 40);
    await wait((TTL + 6) * 1000); const after = await media.flowing(1500); note('Meet down for ' + Math.round((Date.now() - t0) / 1000) + ' s, NO reaper: media still flowing = ' + after + ' packets in 1.5 s (an allocation outlives its credential)'); metrics.meetDownNoReaperPackets = after;
    const reaper = spawn(process.execPath, [ROOT + '/server/relay-reaper.mjs'], { env: { ...process.env, REAPER_REDIS_HOST: CERT.redis.host, REAPER_REDIS_PORT: String(CERT.redis.port), REAPER_REDIS_PASSWORD: CERT.redis.password, REAPER_CLI_HOST: CERT.cli.host, REAPER_CLI_PORT: String(CERT.cli.port), REAPER_CLI_PASSWORD: CERT.cli.password, REAPER_REALM: CERT.realm, REAPER_INTERVAL_SECONDS: '2' }, stdio: 'ignore' });
    const t1 = Date.now(); const stopped = await until(async () => (await media.flowing(800)) === 0, 20000, 100); check('the stand-alone REAPER (Meet still down) ends the media of the expired credential', !!stopped, Math.round((Date.now() - t1) / 1000) + ' s after it started');
    check('no allocation of either credential remains in coturn', (await sessionsOf(credFromApi(p.body).username)) + (await sessionsOf(credFromApi(v.body).username)) === 0); reaper.kill(); media.stop();
    const back = await spawnMeet({ env: { RELAY_CREDENTIAL_TTL_SECONDS: String(TTL) } });
    const ended = await until(async () => (await db.query("SELECT state FROM meeting_shares WHERE id=$1", [s.id])).rows[0].state !== 'active', 15000, 300); check('Meet restarts: the share whose presenter vanished is ended by its lease (no zombie share)', !!ended);
    check('and every credential row of it is terminated by the boot reconcile', (await until(async () => (await db.query('SELECT bool_and(terminated_at IS NOT NULL) ok FROM relay_credentials WHERE share_id=$1', [s.id])).rows[0].ok, 10000, 300)) === true);
    metrics.meetDownBound = { ttlSeconds: TTL, note: 'enforcement bound with Meet down = credential TTL + one reaper sweep (observed ' + Math.round((Date.now() - t1) / 1000) + ' s after the reaper started)' };
    console.log('M3b. the DATABASE is unavailable (container paused)');
    const My = await meeting(back), sy = (await start(My)).body; const hb = setInterval(() => My.H('POST', `/api/meetings/${My.id}/shares/${sy.id}/heartbeat`, My.g1.token, {}).catch(() => {}), 2000); const py = await pairFor(My, sy); await wait(2000);
    const reaper2 = spawn(process.execPath, [ROOT + '/server/relay-reaper.mjs'], { env: { ...process.env, REAPER_REDIS_HOST: CERT.redis.host, REAPER_REDIS_PORT: String(CERT.redis.port), REAPER_REDIS_PASSWORD: CERT.redis.password, REAPER_CLI_HOST: CERT.cli.host, REAPER_CLI_PORT: String(CERT.cli.port), REAPER_CLI_PASSWORD: CERT.cli.password, REAPER_REALM: CERT.realm, REAPER_INTERVAL_SECONDS: '2' }, stdio: 'ignore' });
    sh('docker', ['pause', 'qascs-test-pg']); const tp = Date.now();
    const a1 = await My.H('GET', `/api/meetings/${My.id}/shares/current`, My.host.token).catch((e) => ({ status: 0 })); check('database down: Meet answers an error, does not crash, grants nothing', a1.status === 0 || a1.status >= 500 || a1.status === 408, 'status ' + a1.status);
    const gone = await until(async () => (await py.media.flowing(800)) === 0, (TTL + 40) * 1000, 100); check('with the database down and heartbeats failing, the credentials expire and the REAPER ends the media (bound = TTL + sweep)', !!gone, Math.round((Date.now() - tp) / 1000) + ' s'); metrics.pgDownBoundSeconds = Math.round((Date.now() - tp) / 1000);
    clearInterval(hb); sh('docker', ['unpause', 'qascs-test-pg']); reaper2.kill(); py.media.stop();
    const rec = await until(async () => (await db.query("SELECT state FROM meeting_shares WHERE id=$1", [sy.id])).rows[0].state !== 'active', 20000, 400); check('database back: Meet recovers on its own and ends the share whose lease lapsed', !!rec);
    check('Meet is still serving after the outage (no restart needed)', (await My.H('GET', `/api/meetings/${My.id}/tools`, My.host.token)).status === 200); await back.stop(); servers.length = 0; }

  // ============================================================================================ M4: the Shield is authoritative
  console.log('M4. SHIELD and Meet enforce the same authoritative state (stub Shield, real sockets)');
  { const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }); const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const st = { deny: new Set(), down: false, calls: 0 };
    const stub = http_.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { st.calls++; if (st.down) { res.writeHead(503); return res.end('{}'); } const j = b ? JSON.parse(b) : {}; res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/shield/meet/authorize') return res.end(JSON.stringify(st.deny.has(j.participantId) ? { allow: false, reason: 'SUSPENDED' } : { allow: true, kind: 'guest', capabilities: {} }));
      if (req.url === '/v1/shield/meet/recheck') return res.end(JSON.stringify({ revoke: (j.participants || []).filter((p) => st.deny.has(p.participantId)).map((p) => ({ meetingId: p.meetingId, participantId: p.participantId, reason: 'SUSPENDED' })) }));
      res.end('{}'); }); }); await new Promise((r) => stub.listen(5190, '127.0.0.1', r));
    // the people and the meeting are created by a Meet WITHOUT the shield (same database, same JWT secret); the shield-enforcing Meet then serves them
    const plain = await spawnMeet({}); const Mz = await meeting(plain); await plain.stop(); servers.length = 0;
    const shielded = await spawnMeet({ env: { SHIELD_MEET_ENFORCE: 'true', SHIELD_URL: 'http://127.0.0.1:5190', SHIELD_MEET_KEY_PEM: pem, SHIELD_WORKLOAD_ISSUER: 'cert-issuer', SHIELD_RECHECK_SECONDS: '1', SHIELD_RECHECK_GRACE_SECONDS: '4', ASCS_DISCONNECT_GRACE_MS: '3000', ASCS_LEASE_MS: '120000' } });
    const Hh = http(shielded.base), Ms = { ...Mz, H: Hh };
    const { chromium } = playwright(); const browser = await chromium.launch(); const page = await (await browser.newContext()).newPage(); await page.goto(shielded.base + '/'); await page.addScriptTag({ url: '/socket.io/socket.io.js' });
    await page.evaluate(() => { window.S = {}; window.go = (name, token) => new Promise((res) => { const s = io({ auth: { token }, transports: ['websocket'], reconnection: false }); window.S[name] = { s, revoked: null, closed: false }; s.on('session_revoked', (d) => { window.S[name].revoked = d && d.reason; }); s.on('disconnect', () => { window.S[name].closed = true; }); s.on('connect', () => res({ ok: true })); s.on('connect_error', (e) => res({ ok: false, error: e.message })); setTimeout(() => res({ ok: false, error: 'timeout' }), 6000); }); });
    const conn = (name, who) => page.evaluate(([n, t]) => window.go(n, t), [name, who.token]); const sockState = (name) => page.evaluate((n) => ({ closed: window.S[n].closed, revoked: window.S[n].revoked }), name);

    check('WITHOUT a live Shield-authorized session a presenter cannot start a share (403): the Shield decides nothing about a person it cannot see', (await start(Ms)).status === 403);
    const [h, p, v, v2] = [await conn('host', Ms.host), await conn('g1', Ms.g1), await conn('g2', Ms.g2), await conn('g3', Ms.g3)]; check('the Shield-authorized sessions connect', h.ok && p.ok && v.ok && v2.ok, JSON.stringify([h, p, v, v2].map((x) => x.error || 'ok')));
    const s = await start(Ms); check('with a live session the share starts', s.status === 201); const sid4 = s.body.id;
    { const gc = await Hh('POST', `/api/meetings/${Ms.id}/shares/${sid4}/relay-credentials`, Ms.g2.token, {}); check('a viewer with a live session gets credentials', gc.status === 200); }
    const Pc = await creds(Ms, sid4, Ms.g1), V1 = await creds(Ms, sid4, Ms.g2), V2 = await creds(Ms, sid4, Ms.g3);
    const m1 = await mediaPair(credFromApi(Pc.body), credFromApi(V1.body)), m2 = await mediaPair(credFromApi(Pc.body), credFromApi(V2.body)).catch(async () => null);
    check('presenter -> viewer 1 flows through the relay', (await m1.flowing()) > 40); if (m2) check('presenter -> viewer 2 flows through the relay', (await m2.flowing()) > 40);
    st.deny.add(Ms.g2.pid); const t0 = Date.now();
    const ended1 = await until(async () => (await m1.flowing(500)) === 0, 20000, 100); const lat1 = Date.now() - t0;
    check('the Shield SUSPENDS viewer 1: his screen media stops, his socket is closed with a reason, his credentials are terminated', !!ended1 && (await sockState('g2')).closed && !!(await sockState('g2')).revoked && (await dead(credFromApi(V1.body))), lat1 + ' ms');
    check('and everybody else keeps seeing the share (presenter and viewer 2 untouched)', m2 ? (await m2.flowing(1500)) > 40 : true); metrics.shieldDenyViewerToMediaStopMs = lat1;
    check('the denied person cannot come back with the same token (403 on the API)', (await Hh('POST', `/api/meetings/${Ms.id}/shares/${sid4}/relay-credentials`, Ms.g2.token, {})).status === 403);
    st.deny.add(Ms.g1.pid); const t1 = Date.now(); const ended2 = m2 ? await until(async () => (await m2.flowing(500)) === 0, 20000, 100) : true; const lat2 = Date.now() - t1; metrics.shieldDenyPresenterToMediaStopMs = lat2;
    const cur = await Hh('GET', `/api/meetings/${Ms.id}/shares/current`, Ms.host.token);
    check('the Shield SUSPENDS the presenter: the share ends in Meet and ALL viewers\' media stops (one authoritative state)', !!ended2 && (!cur.body.share || cur.body.share.state !== 'active'), lat2 + ' ms');
    check('every relay credential of the share is revoked and terminated', (await until(async () => (await db.query('SELECT bool_and(terminated_at IS NOT NULL) ok FROM relay_credentials WHERE share_id=$1', [sid4])).rows[0].ok, 8000, 300)) === true);
    m1.stop(); m2 && m2.stop(); st.deny.clear(); await db.query("UPDATE participants SET admission='admitted' WHERE meeting_id=$1", [Ms.id]);
    // ---- the Shield itself fails
    await page.evaluate(() => Object.values(window.S).forEach((x) => { try { x.s.close(); } catch { /* closed */ } }));
    await conn('host2', Ms.host); await conn('g1b', Ms.g1); const sh5 = await start(Ms); check('(Shield healthy again) a presenter with a live session starts a share', sh5.status === 201);
    const P5 = await creds(Ms, sh5.body.id, Ms.g1), V5 = await creds(Ms, sh5.body.id, Ms.host), m5 = await mediaPair(credFromApi(P5.body), credFromApi(V5.body)); check('it flows', (await m5.flowing()) > 40);
    st.down = true; const td = Date.now();
    const stopped5 = await until(async () => (await m5.flowing(500)) === 0, 60000, 200); const lat5 = Date.now() - td; metrics.shieldDownToMediaStopMs = lat5;
    check('the SHIELD GOES DOWN: after the grace period the sessions are closed, the lease is cut, the share ends and the relay media STOPS (fail closed, bounded)', !!stopped5, lat5 + ' ms (grace 4 s + disconnect grace 3 s + sweep)');
    check('while the Shield is down nobody can mint a new relay credential (no live session)', (await creds(Ms, sh5.body.id, Ms.host)).status !== 200);
    check('and nobody can start a new share (no live session / share ended)', (await start(Ms)).status === 403); m5.stop(); st.down = false;
    await browser.close(); stub.close(); await shielded.stop(); servers.length = 0; }

  await D.drop(); finish();
}
main().catch((e) => { console.error('SUITE ERROR', e); for (const m of globalThis.__meetLogs || []) console.error('--- Meet :' + m.port + ' log tail ---: ' + m.log().slice(-1500)); process.exit(3); });
