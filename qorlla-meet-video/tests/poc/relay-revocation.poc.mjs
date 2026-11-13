// ASCS-M1.2 PROOF OF CONCEPT: individually revocable relay credentials on coturn, with real Chromium and real WebRTC through a real coturn (user-database mode).
//
//   LAN_IP=<this machine's LAN address> tests/poc/relay-up.sh                       # coturn + Redis (disposable containers qm12-*)
//   TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:25690/postgres  PLAYWRIGHT_DIR=<dir with node_modules/playwright>  LAN_IP=<lan>  node tests/poc/relay-revocation.poc.mjs
//   (optional) EVIDENCE_OUT=docs/evidence/m12-relay-poc.json  writes every measurement as JSON;  ONLY=X,C,R,P  runs some sections.
//
// The PoC is deliberately ISOLATED from Meet: each "pair" is two RTCPeerConnections in one page, both relay-only, each with its own credential, exchanging real video through the relay.
// Nothing here assumes how coturn behaves: sections X1-X3 MEASURE what deleting a credential and cancelling an allocation each do, on their own and together.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createRelayAuthority, RelayUnavailable, RelayRefused } from '../../server/relay-authority.mjs';
import { respCommand } from '../../server/resp-client.mjs';
import { turnCli, parseSessions } from '../../server/turn-cli.mjs';

const here = dirname(fileURLToPath(import.meta.url)), SQL = join(here, '..', '..', 'sql', 'v4_24_relay_credentials.sql');
const LAN = process.env.LAN_IP; if (!LAN) { console.error('set LAN_IP (the TURN port is published there; Chromium ignores a loopback TURN server)'); process.exit(2); }
const PG = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25690/postgres';
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_DIR || process.cwd(), 'package.json'))('playwright');
const REDIS = { host: '127.0.0.1', port: 36390 }, CLI = { host: '127.0.0.1', port: 35790, password: 'clipw' }, REALM = 'qorlla.poc', TURN_URL = `turn:${LAN}:34790?transport=udp`;
const only = (k) => !process.env.ONLY || process.env.ONLY.split(',').includes(k);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = {}; const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '   [' + detail + ']' : '')); };
const observe = (key, text, data) => { evidence[key] = data ?? text; console.log('  OBSERVED ' + text); };
async function until(fn, ms = 20000, step = 250) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await wait(step); } return null; }

// ---------------------------------------------------------------- the page side: pairs of relay-only peer connections
const PAGE_LIB = `
window.__pairs = {};
const turn = (c) => (c ? [{ urls: window.__turnUrl, username: c.username, credential: c.credential }] : []);
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
window.pairStats = async (name) => {
  const { B, errs } = window.__pairs[name]; const st = await B.getStats(); let frames = 0, bytes = 0, rtt = null, lt = null, rt = null;
  st.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') { frames = r.framesDecoded || 0; bytes = r.bytesReceived || 0; } });
  st.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) { const p = st.get(r.selectedCandidatePairId); if (p) { rtt = p.currentRoundTripTime; lt = (st.get(p.localCandidateId) || {}).candidateType; rt = (st.get(p.remoteCandidateId) || {}).candidateType; } } });
  return { frames, bytes, rtt, lt, rt, ice: B.iceConnectionState, errs: errs.slice() };
};
// a client that RECONNECTS: an ICE restart (new gathering, so a NEW allocation attempt with whatever credentials the connection has)
window.restartPair = async (name, newA, newB) => {
  const { A, B } = window.__pairs[name];
  if (newA) A.setConfiguration({ ...A.getConfiguration(), iceServers: turn(newA) }); if (newB) B.setConfiguration({ ...B.getConfiguration(), iceServers: turn(newB) });
  A.restartIce(); const o = await A.createOffer({ iceRestart: true }); await A.setLocalDescription(o); await B.setRemoteDescription(o);
  const an = await B.createAnswer(); await B.setLocalDescription(an); await A.setRemoteDescription(an);
};
// "can this credential still get a relay allocation?": a fresh relay-only connection that gathers candidates with it
window.probe = async (c) => {
  const pc = new RTCPeerConnection({ iceServers: turn(c), iceTransportPolicy: 'relay' }); const errs = []; let relay = 0;
  pc.onicecandidateerror = (e) => errs.push(e.errorCode); pc.onicecandidate = (e) => { if (e.candidate && e.candidate.type === 'relay') relay++; };
  pc.createDataChannel('probe'); await pc.setLocalDescription(await pc.createOffer());
  await new Promise((res) => { if (pc.iceGatheringState === 'complete') return res(); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && res(); setTimeout(res, 9000); });
  pc.close(); return { relay, errs };
};
window.closePair = (name) => { const p = window.__pairs[name]; if (!p) return; clearInterval(p.timer); p.A.close(); p.B.close(); delete window.__pairs[name]; };
`;

async function main() {
  const admin = new pg.Pool({ connectionString: PG, max: 1 }); const dbName = 'm12_' + Math.random().toString(36).slice(2, 8);
  await admin.query('CREATE DATABASE ' + dbName); const db = new pg.Pool({ connectionString: PG.replace(/\/[^/]*$/, '/' + dbName), max: 6 });
  await db.query(readFileSync(SQL, 'utf8'));
  const mk = (over = {}) => createRelayAuthority({ db, redis: REDIS, cli: CLI, realm: REALM, ttlSeconds: 300, ...over });
  let A = mk();
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const page = await (await browser.newContext()).newPage();
  await page.goto('about:blank'); await page.evaluate((u) => { window.__turnUrl = u; }, TURN_URL); await page.addScriptTag({ content: PAGE_LIB });
  const stats = (n) => page.evaluate((x) => window.pairStats(x), n);
  const flow = async (n, ms = 3000) => { const a = await stats(n); await wait(ms); const b = await stats(n); return { frames: b.frames - a.frames, kbps: Math.round(((b.bytes - a.bytes) * 8) / ms), rtt: b.rtt, lt: b.lt, ice: b.ice, errs: b.errs }; };
  const flowing = async (n) => (await flow(n)).frames > 10;
  const probe = (c) => page.evaluate((x) => window.probe(x), c);
  const ids = () => ({ meetingId: randomUUID(), participantId: randomUUID(), shareId: randomUUID() });
  /** a share's dedicated relay connection: presenter + viewer credentials from the authority, both relay-only */
  async function sharePair(name, over = {}) {
    const base = { ...ids(), ...over }; const p = await A.issue({ ...base, role: 'presenter' }); const v = await A.issue({ ...base, participantId: randomUUID(), role: 'viewer' });
    await page.evaluate(([n, a, b, o]) => window.makePair(n, { a, b, ...o }), [name, p, v, over.size || {}]);
    const up = await until(() => flowing(name), 45000, 500); return { name, ...base, p, v, up: !!up };
  }
  const hold = async (n, ms) => { const end = Date.now() + ms; let min = 1e9; while (Date.now() < end) { min = Math.min(min, (await flow(n, 2000)).frames); } return min; };

  try {
    // ---------------------------------------------------------------- 0. the relay path works at all, and credentials are individual
    console.log('0. baseline');
    const h = await A.health(); check('the credential authority sees Redis and the coturn admin CLI', h.ok, JSON.stringify(h));
    const s0 = await sharePair('s0'); check('a share pair with two individual credentials connects and carries video through the relay', s0.up);
    const f0 = await flow('s0'); evidence.baseline = f0; check('the selected candidate pair is a RELAY candidate (no direct path)', f0.lt === 'relay', JSON.stringify(f0));
    check('the credentials are distinct per role and opaque (no account, meeting or share id in them)', s0.p.username !== s0.v.username && ![s0.meetingId, s0.shareId, s0.participantId].some((x) => s0.p.username.includes(x)));
    const live0 = await A.sessionsOf(s0.p.username); check('coturn lists live allocation(s) under the PRESENTER credential, found by username', live0.length >= 1, 'sessions ' + live0.length);

    // ---------------------------------------------------------------- X. WHAT EACH ACTION ACTUALLY DOES (measured, not assumed)
    if (only('X')) {
      console.log('X. experiment matrix: what do "delete the credential" and "cancel the allocation" each do, alone?');
      // X1: delete the credential only
      const x1 = await sharePair('x1'); check('x1: pair up', x1.up);
      await respCommand(['DEL', A.keyOf(x1.p.username), A.keyOf(x1.v.username)], REDIS);
      const x1flow = await flow('x1', 4000); const x1probe = await probe(x1.p);
      observe('X1', `X1 DELETE ONLY: existing media ${x1flow.frames > 10 ? 'CONTINUES' : 'stopped'} (${x1flow.frames} frames in 4 s); a NEW allocation with the deleted credential gets ${x1probe.relay} relay candidates, errors ${JSON.stringify(x1probe.errs)}`, { mediaContinues: x1flow.frames > 10, frames: x1flow.frames, probe: x1probe });
      check('X1: a deleted credential can NOT make a new allocation (401, no relay candidate)', x1probe.relay === 0 && x1probe.errs.includes(401), JSON.stringify(x1probe));
      await A.revokeShare(x1.shareId, 'cleanup'); await page.evaluate(() => window.closePair('x1'));

      // X2: cancel the allocation only (credential stays valid)
      const x2 = await sharePair('x2'); check('x2: pair up', x2.up);
      const ids2 = [...(await A.sessionsOf(x2.p.username)), ...(await A.sessionsOf(x2.v.username))].map((s) => s.id);
      await turnCli(ids2.map((id) => 'cs ' + id), CLI); const x2stop = await flow('x2', 3000);
      await page.evaluate((n) => window.restartPair(n), 'x2'); const x2back = await until(async () => (await flow('x2', 2000)).frames > 10, 30000, 500);
      observe('X2', `X2 CANCEL ONLY: media ${x2stop.frames <= 8 ? 'STOPS' : 'continues'} (${x2stop.frames} frames in 3 s, live rate is ~45); after an ICE restart with the SAME credential it ${x2back ? 'RESUMES' : 'does not resume'}`, { stops: x2stop.frames <= 8, resumesAfterIceRestart: !!x2back, framesAfterCancel: x2stop.frames });
      check('X2: cancelling alone is NOT enough: the client reconnects with the still-valid credential (the ASCS-M1.1 weakness, reproduced with a user-database credential)', !!x2back);
      await A.revokeShare(x2.shareId, 'cleanup'); await page.evaluate(() => window.closePair('x2'));
    }

    // ---------------------------------------------------------------- C. THE FIVE DEMONSTRATIONS
    if (only('C')) {
      console.log('C1. credentials are individually revocable');
      const a1 = await sharePair('a1'), a2 = await sharePair('a2'); check('two shares (two sets of credentials) are up', a1.up && a2.up);
      await A.revokeShare(a1.shareId, 'host_revoked');
      const a1stop = await flow('a1', 3000), a2go = await flow('a2', 3000), a2probe = await probe(a2.p);
      check('revoking share 1 stops share 1 ...', a1stop.frames <= 3, a1stop.frames + ' frames/3 s');
      check('... and does NOT touch share 2 (still flowing, its credentials still allocate)', a2go.frames > 10 && a2probe.relay >= 1, `${a2go.frames} frames, relay candidates ${a2probe.relay}`);
      const rows = (await db.query('SELECT share_id, revoke_reason, terminated_at IS NOT NULL AS done FROM relay_credentials WHERE share_id = ANY($1)', [[a1.shareId, a2.shareId]])).rows;
      check('the registry shows share 1 revoked and terminated, share 2 untouched', rows.filter((r) => r.share_id === a1.shareId).every((r) => r.revoke_reason === 'host_revoked' && r.done) && rows.filter((r) => r.share_id === a2.shareId).every((r) => !r.revoke_reason));

      console.log('C2/C3. revocation terminates existing allocations and prevents fresh allocation AND reconnection');
      const x3 = await sharePair('x3'); check('x3: pair up (carrying video)', x3.up);
      const t0 = Date.now(); const rv = await A.revokeShare(x3.shareId, 'host_revoked'); const revokeMs = Date.now() - t0;
      check('revokeShare reports every credential deleted and every allocation terminated', rv.errors.length === 0 && rv.terminated === 2, JSON.stringify(rv));
      const stopped = await until(async () => (await flow('x3', 1000)).frames <= 2, 15000, 100); evidence.revokeCallMs = revokeMs;
      check('C3 existing allocation terminated: the relay stops forwarding the screen', !!stopped, `revoke call took ${revokeMs} ms`);
      check('coturn no longer lists any allocation of either credential', (await A.sessionsOf(x3.p.username)).length + (await A.sessionsOf(x3.v.username)).length === 0);
      await page.evaluate((n) => window.restartPair(n), 'x3'); const x3back = await until(async () => (await flow('x3', 2000)).frames > 10, 25000, 500);
      check('C2 ICE restart after revocation: the connection does NOT come back (25 s)', !x3back);
      const pr = await probe(x3.p), pv = await probe(x3.v);
      check('C2 the revoked credential is refused for a NEW allocation (presenter and viewer): 401, no relay candidate', pr.relay === 0 && pv.relay === 0 && pr.errs.includes(401) && pv.errs.includes(401), JSON.stringify({ pr, pv }));

      console.log('C4. screen transport is isolated from camera/microphone transport');
      await page.evaluate(() => Object.keys(window.__pairs).forEach((k) => window.closePair(k)));          // no leftover pairs competing for the page's CPU
      const cam = await sharePair('cam'), shr = await sharePair('shr'); check('a "camera" pair and a "share" pair are up, on different credentials', cam.up && shr.up && cam.p.username !== shr.p.username);
      const su = (n) => A.sessionsOf(n); const camS = (await su(cam.p.username)).map((s) => s.id), shrS = (await su(shr.p.username)).map((s) => s.id);
      check('coturn holds them as SEPARATE allocations (no id in common)', camS.length >= 1 && shrS.length >= 1 && !camS.some((i) => shrS.includes(i)));
      const camBase = []; for (let i = 0; i < 3; i++) camBase.push((await flow('cam', 2000)).frames); const baseAvg = camBase.reduce((s, x) => s + x, 0) / camBase.length;
      await A.revokeShare(shr.shareId, 'host_revoked');
      const camAfter = []; for (let i = 0; i < 4; i++) camAfter.push((await flow('cam', 2000)).frames); const minAfter = Math.min(...camAfter), avgAfter = camAfter.reduce((s, x) => s + x, 0) / camAfter.length;
      evidence.isolation = { cameraFramesPer2sBefore: camBase, cameraFramesPer2sAfterShareRevoked: camAfter };
      check('revoking the share leaves the camera pair untouched: after the revoke it keeps at least 70% of its own baseline rate in every 2 s window', minAfter >= baseAvg * 0.7 && avgAfter >= baseAvg * 0.85, 'before ' + JSON.stringify(camBase) + ' after ' + JSON.stringify(camAfter));
      check('and the share pair is dead', (await flow('shr', 2000)).frames <= 2);

      console.log('C-race. a revocation that races with issuing cannot leave a usable credential');
      let calls = 0; const racing = await A.issue({ ...ids(), role: 'presenter' }, { stillActive: async () => ++calls < 2 }).then(() => null, (e) => e);
      check('issue() re-checks authorization AFTER the credential exists and refuses', racing instanceof RelayRefused, racing && racing.message);
      const rr = (await db.query("SELECT username, revoke_reason, terminated_at IS NOT NULL AS done FROM relay_credentials WHERE revoke_reason = 'revoked_during_issue'")).rows;
      check('... the credential it had written is revoked and terminated at once (a probe confirms it is dead)', rr.length === 1 && rr[0].done && (await respCommand(['EXISTS', A.keyOf(rr[0].username)], REDIS)) === 0);
    }

    // ---------------------------------------------------------------- R. RESTARTS AND FAILURES
    if (only('R')) {
      console.log('R1. TURN restart: revocation stays effective');
      const r1 = await sharePair('r1'), r1b = await sharePair('r1b'); check('r1: two pairs up', r1.up && r1b.up);
      await A.revokeShare(r1.shareId, 'host_revoked');
      execFileSync('docker', ['restart', 'qm12-turn'], { stdio: 'ignore', timeout: 120000 });
      const back = await until(async () => (await mk().health()).ok, 90000, 1000); check('coturn restarted and its admin CLI answers again', !!back);
      const p1 = await probe(r1.p); check('a credential revoked BEFORE the TURN restart is still refused AFTER it', p1.relay === 0 && p1.errs.includes(401), JSON.stringify(p1));
      const fresh = await A.issue({ ...ids(), role: 'presenter' }); const pf = await probe(fresh); check('control: a FRESH credential from the authority allocates normally after the restart (the relay itself works)', pf.relay >= 1, JSON.stringify(pf));
      const pOld = await probe(r1b.p); evidence.unrevokedAfterTurnRestart = pOld; check('an UNREVOKED credential still allocates after the TURN restart (Redis kept the user database): no collateral loss', pOld.relay >= 1, JSON.stringify(pOld));
      await page.evaluate(() => { window.closePair('r1'); window.closePair('r1b'); });

      console.log('R2. "Meet restart": a revocation recorded but not completed is finished by a NEW instance (no memory)');
      const r2 = await sharePair('r2'); check('r2: pair up', r2.up);
      const broken = mk({ ttlSeconds: 300 }); const brokenA = createRelayAuthority({ db, redis: REDIS, cli: { ...CLI, port: 35799 }, realm: REALM });     // the TURN control service is unreachable at revoke time
      const rv2 = await brokenA.revokeShare(r2.shareId, 'shield_denied');
      check('the revocation is recorded durably and the credential key is deleted, but termination is reported incomplete', rv2.errors.some((e) => e.startsWith('cli:')) && rv2.terminated === 0, JSON.stringify(rv2));
      const exposure = await flow('r2', 3000); observe('R2exposure', `R2 EXPOSURE WINDOW: while the control service is down the existing allocation keeps forwarding (${exposure.frames} frames in 3 s); new allocation is already impossible`, { frames: exposure.frames });
      const pend = (await db.query("SELECT count(*)::int n FROM relay_credentials WHERE share_id = $1 AND revoked_at IS NOT NULL AND terminated_at IS NULL", [r2.shareId])).rows[0].n; check('the registry shows the revocation as PENDING termination', pend === 2);
      const A2 = mk(); const rc = await A2.reconcile();          // "after the restart": a brand-new authority instance, only the database in common
      check('reconcile() on the new instance terminates it', rc.pending >= 2 && rc.errors.length === 0, JSON.stringify(rc));
      check('the relay stops forwarding after reconcile', !!(await until(async () => (await flow('r2', 1000)).frames <= 2, 15000, 100)));
      const donerows = (await db.query('SELECT count(*)::int n FROM relay_credentials WHERE share_id = $1 AND terminated_at IS NOT NULL', [r2.shareId])).rows[0].n; check('and the registry now says terminated', donerows === 2);
      await page.evaluate(() => window.closePair('r2'));

      console.log('R3. fail closed');
      const noCli = createRelayAuthority({ db, redis: REDIS, cli: { ...CLI, port: 35799 }, realm: REALM }), noRedis = createRelayAuthority({ db, redis: { host: '127.0.0.1', port: 36399 }, cli: CLI, realm: REALM });
      const e1 = await noCli.issue({ ...ids(), role: 'presenter' }).then(() => null, (e) => e), e2 = await noRedis.issue({ ...ids(), role: 'presenter' }).then(() => null, (e) => e);
      check('TURN control service (admin CLI) unavailable: NEW screen sharing is denied', e1 instanceof RelayUnavailable, e1 && e1.message.slice(0, 80));
      check('credential store (Redis) unavailable: NEW screen sharing is denied', e2 instanceof RelayUnavailable, e2 && e2.message.slice(0, 80));
      check('nothing was written to the registry by the denied attempts', (await db.query("SELECT count(*)::int n FROM relay_credentials WHERE revoke_reason = 'issue_failed'")).rows[0].n === 0);

      console.log('R4. credential expiry: a share whose lease ran out has its allocation terminated even though its credential expired first');
      const r4 = await sharePair('r4'); const shortA = mk({ ttlSeconds: 30 }); await page.evaluate(() => window.closePair('r4'));
      const sp = await shortA.issue({ ...ids(), role: 'presenter' }), sv = await shortA.issue({ ...ids(), role: 'viewer' });
      await page.evaluate(([a, b]) => window.makePair('r4s', { a, b }), [sp, sv]); check('r4: short-lived pair up', !!(await until(() => flowing('r4s'), 45000, 500)));
      await db.query("UPDATE relay_credentials SET expires_at = now() - interval '1 second' WHERE username = ANY($1)", [[sp.username, sv.username]]);      // the lease ran out
      const stillGoing = await flow('r4s', 2000); observe('R4', `R4: right after the lease ran out and BEFORE reconcile, the allocation still forwards (${stillGoing.frames} frames in 2 s): an allocation outlives its credential`, { frames: stillGoing.frames });
      const rc4 = await mk().reconcile(); check('reconcile() revokes the expired credentials and terminates their allocations', rc4.expiredNow >= 2 && rc4.errors.length === 0, JSON.stringify(rc4));
      check('the relay stops forwarding', !!(await until(async () => (await flow('r4s', 1000)).frames <= 2, 15000, 100)));
      await page.evaluate(() => window.closePair('r4s'));

      console.log('R5. data loss in the credential store');
      const r5 = await sharePair('r5'); check('r5: pair up', r5.up);
      await respCommand(['FLUSHALL'], REDIS); const p5 = await probe(r5.p);
      check('after Redis loses its data NO credential allocates (revoked or not): fail closed, clients must be re-authorized', p5.relay === 0 && p5.errs.includes(401), JSON.stringify(p5));
      const rc5 = await mk().reconcile(); observe('R5', `R5 after FLUSHALL: reconcile finds ${rc5.pending} pending. NO credential can allocate (fail closed), but allocations ALREADY RUNNING are not cancelled until their credential expires in the registry (then reconcile terminates them): a loss of Redis does not stop live media by itself`, rc5);
      await page.evaluate(() => window.closePair('r5'));
    }

    // ---------------------------------------------------------------- P. PERFORMANCE
    if (only('P')) {
      console.log('P. performance: relay vs direct (1280x720 @ 15 fps animated screen content)');
      const big = { w: 1280, h: 720, fps: 15 };
      const rp = await sharePair('prelay', { size: big }); check('p: relay pair up at 720p', rp.up);
      const dpair = await page.evaluate(([o]) => window.makePair('pdirect', { a: null, b: null, policy: 'all', ...o }), [big]); await until(() => flowing('pdirect'), 30000, 500);
      const samples = { relay: [], direct: [] };
      for (let i = 0; i < 4; i++) { samples.relay.push(await flow('prelay', 3000)); samples.direct.push(await flow('pdirect', 3000)); }
      const avg = (arr, k) => Math.round(arr.reduce((s, x) => s + (x[k] || 0), 0) / arr.length * 100) / 100;
      const sum = { relay: { fps: avg(samples.relay, 'frames') / 3, kbps: avg(samples.relay, 'kbps'), rttMs: avg(samples.relay, 'rtt') * 1000, type: samples.relay[0].lt }, direct: { fps: avg(samples.direct, 'frames') / 3, kbps: avg(samples.direct, 'kbps'), rttMs: avg(samples.direct, 'rtt') * 1000, type: samples.direct[0].lt } };
      evidence.performance = sum; observe('P', `P relay: ${sum.relay.fps.toFixed(1)} fps, ${sum.relay.kbps} kbit/s, RTT ${sum.relay.rttMs.toFixed(1)} ms (${sum.relay.type}) | direct: ${sum.direct.fps.toFixed(1)} fps, ${sum.direct.kbps} kbit/s, RTT ${sum.direct.rttMs.toFixed(1)} ms (${sum.direct.type})`, sum);
      const lat = []; for (let i = 0; i < 3; i++) { const q = await sharePair('plat' + i); const t = Date.now(); await A.revokeShare(q.shareId, 'host_revoked'); const ok = await until(async () => (await flow('plat' + i, 1000)).frames <= 2, 15000, 100); lat.push({ revokeCallMs: Date.now() - t, stopped: !!ok }); await page.evaluate((n) => window.closePair(n), 'plat' + i); }
      evidence.revocationLatency = lat; observe('Plat', 'P revocation latency (call returned, media already stopped): ' + lat.map((x) => x.revokeCallMs + ' ms').join(', '), lat);
      check('relay carries 720p screen content at about the same frame rate as a direct path (>= 80%)', sum.relay.fps >= sum.direct.fps * 0.8, `${sum.relay.fps.toFixed(1)} vs ${sum.direct.fps.toFixed(1)} fps`);
    }
  } finally {
    await browser.close().catch(() => {}); await db.end().catch(() => {}); await admin.query('DROP DATABASE IF EXISTS ' + dbName + ' WITH (FORCE)').catch(() => {}); await admin.end().catch(() => {});
  }
  if (process.env.EVIDENCE_OUT) { mkdirSync(dirname(process.env.EVIDENCE_OUT), { recursive: true }); writeFileSync(process.env.EVIDENCE_OUT, JSON.stringify({ when: new Date().toISOString(), turn: 'coturn 4.17 user-database mode (--lt-cred-mech --redis-userdb --cli)', results, evidence }, null, 2)); }
  const failed = results.filter((r) => !r.ok); console.log(`\n${results.length - failed.length}/${results.length} checks passed`); process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error('POC crashed:', e); process.exit(2); });
