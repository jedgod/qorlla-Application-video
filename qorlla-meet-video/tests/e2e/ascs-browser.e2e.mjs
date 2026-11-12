// ASCS v1-v2 in REAL browsers against the REAL Meet server of this checkout (not the Docker stack). Not part of `npm run check` (it needs Chromium).
//   TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:25690/postgres  PLAYWRIGHT_DIR=<folder that has node_modules/playwright>  node tests/e2e/ascs-browser.e2e.mjs
// The screen picker itself cannot be automated, so getDisplayMedia is replaced by a 416x234 animated canvas; everything else (cameras, microphones, WebRTC between the
// pages, the server, the database) is real. A shared screen is recognised on the other side by its size: 416 wide. (A camera can arrive at 320, 480, 640 ... when WebRTC adapts it under load, so 320 is NOT a safe marker.)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url)), ROOT = join(here, '..', '..'), SQL = join(ROOT, 'sql');
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_DIR || process.cwd(), 'package.json'))('playwright');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SHARE_W = 416;                                  // the width of the stubbed screen on the receiving side; anything else is a camera
const results = []; const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (ok ? '' : '  -> ' + detail)); };

async function bootServer({ ascs, port, leaseMs = 12000, extraEnv = {} }) {
  const dbName = 'ascs_e2e_' + Math.random().toString(36).slice(2, 8);
  const admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${dbName}`);
  const dbUrl = URL.replace(/\/[^/]*$/, '/' + dbName); const pool = new pg.Pool({ connectionString: dbUrl, max: 4 });
  for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8'));
  const env = { ...process.env, PORT: String(port), DATABASE_URL: dbUrl, JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0123456789', ASCS_ENABLED: ascs ? 'true' : 'false', ASCS_LEASE_MS: String(leaseMs), API_RATE_LIMIT: '100000', MEETING_RATE_LIMIT: '100000', SOCKET_EVENT_BUDGET: '100000', ...extraEnv };
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 240 && !log.includes('listening'); i++) { await wait(250); if (child.exitCode !== null) throw new Error('Meet exited: ' + log.slice(-600)); }
  if (!log.includes('listening')) throw new Error('Meet did not start: ' + log.slice(-600));
  return { base: `http://localhost:${port}`, pool, stop: async () => { child.kill(); await wait(300); await pool.end(); await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`).catch(() => {}); await admin.end(); }, log: () => log };
}

// getDisplayMedia -> a 416x234 animated canvas (so the other side can tell a share from a camera by its size)
const STUB = () => {
  window.__gum = []; window.__gumFail = 0; window.__pcs = [];
  const NativePC = window.RTCPeerConnection; window.RTCPeerConnection = class extends NativePC { constructor(...a) { super(...a); window.__pcs.push(this); } };
  const gum = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (gum) navigator.mediaDevices.getUserMedia = async (c) => { try { const s = await gum(c); window.__gum.push(s); return s; } catch (e) { window.__gumFail++; throw e; } };
  const realFetch = window.fetch.bind(window);
  window.fetch = (u, o) => { const a = o?.headers?.Authorization; if (a) window.__auth = a; const m = /\/meetings\/([0-9a-f-]{36})/.exec(String(u)); if (m) window.__mid = m[1]; return realFetch(u, o); };
  navigator.mediaDevices && (navigator.mediaDevices.getDisplayMedia = async function () {
    const c = document.createElement('canvas'); c.width = 416; c.height = 234; const x = c.getContext('2d'); let n = 0;
    setInterval(() => { x.fillStyle = `hsl(${(n += 7) % 360} 80% 50%)`; x.fillRect(0, 0, 416, 234); x.fillStyle = '#fff'; x.fillText('SHARE ' + n, 20, 90); }, 50);
    const stream = c.captureStream(15); stream.getVideoTracks()[0].contentHint = 'detail';      // keep the resolution: a degraded 320 px CAMERA must never be mistaken for the screen
    if (arguments[0] && arguments[0].audio) { const ac = new AudioContext(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start(); stream.addTrack(d.stream.getAudioTracks()[0]); }
    window.__shareCalls = (window.__shareCalls || 0) + 1; window.__shareStream = stream; return stream;
  });
};
const shareLabel = async (p) => ((await p.locator('#shareBtn span').textContent()) || '').trim();
const isSharing = async (p) => (await shareLabel(p)) === 'Stop share';
const toolsOf = (p) => p.evaluate(async () => (await fetch('/api/meetings/' + window.__mid + '/tools', { headers: { Authorization: window.__auth } })).json());
const liveTracks = (p, kind) => p.evaluate((k) => (window.__gum || []).flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live' && (!k || t.kind === k)).length, kind);
const presenterButton = (hp, name) => hp.locator('#peopleList .person', { hasText: name }).getByRole('button', { name: 'Stop presenting' });
const avatarShown = (hp, name) => hp.evaluate((n) => { const t = [...document.querySelectorAll('.tile')].find((e) => e.querySelector('.nameplate')?.textContent.startsWith(n)); return !!t && getComputedStyle(t.querySelector('.avatar')).display !== 'none'; }, name);
const remoteVideoWidth = (page, name) => page.evaluate((n) => { const t = [...document.querySelectorAll('.tile')].find((e) => e.querySelector('.nameplate')?.textContent.startsWith(n)); const v = t?.querySelector('video'); return v ? v.videoWidth : -1; }, name);
async function waitFor(fn, ms = 20000, step = 250) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await wait(step); } return last; }

const DENY = () => {
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); window.__deny = true;
  navigator.mediaDevices.getUserMedia = async (c) => { if (window.__deny) { window.__gumFail = (window.__gumFail || 0) + 1; const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e; } return gum(c); };
};
async function room(srv, browserHost, browserGuest, { guestName = 'Gail', guestPerms = ['camera', 'microphone'], denyMedia = false, shareForAll = false, tamper = null } = {}) {
  const hctx = await browserHost.newContext({ permissions: ['camera', 'microphone'] }); const hp = await hctx.newPage(); await hp.addInitScript(STUB);
  await hp.goto(srv.base); await hp.fill('#displayName', 'Hugo'); await hp.fill('#meetingTitle', 'ASCS'); await hp.click('#createBtn');
  await hp.waitForSelector('#app:not(.hidden)', { timeout: 30000 });
  const code = (await hp.textContent('#roomId')).trim();
  if (shareForAll) await hp.evaluate(async () => { await fetch('/api/meetings/' + window.__mid + '/tools', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: window.__auth }, body: JSON.stringify({ share: true }) }); });
  const hp0 = hp; const gctx = await browserGuest.newContext({ permissions: guestPerms }); const gp = await gctx.newPage(); await gp.addInitScript(STUB); if (denyMedia) await gp.addInitScript(DENY); if (tamper) await tamper(gp); if (process.env.DEBUG_PAGES) { hp0 && hp0.on('console', (m) => { if (/share|relay/i.test(m.text())) console.log('  [host ' + m.type() + '] ' + m.text().slice(0, 220)); }); gp.on('pageerror', (e) => console.log('  [guest pageerror] ' + e.message)); gp.on('console', (m) => { if (['error', 'warning'].includes(m.type()) || /share|relay/i.test(m.text())) console.log('  [guest ' + m.type() + '] ' + m.text().slice(0, 220)); }); }
  await gp.goto(srv.base); await gp.fill('#displayName', guestName); await gp.fill('#meetingId', code); await gp.click('#joinBtn');
  await gp.waitForSelector('#app:not(.hidden)', { timeout: 30000 });
  await waitFor(async () => (await hp.locator('#peopleList .person').count()) >= 2, 20000);
  return { hp, gp, hctx, gctx, code };
}
const framesDecoded = (p) => p.evaluate(async () => { let n = 0; for (const pc of window.__pcs) { const st = await pc.getStats(); st.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') n += r.framesDecoded || 0; }); } return n; });
const pairTypes = (p) => p.evaluate(async () => { for (const pc of window.__pcs) { const st = await pc.getStats(); let sel = null; st.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) sel = r.selectedCandidatePairId; }); if (!sel) continue; const pair = st.get(sel); return { local: st.get(pair.localCandidateId)?.candidateType, remote: st.get(pair.remoteCandidateId)?.candidateType }; } return null; });
const allPcs = (p) => p.evaluate(async () => { const out = []; for (const pc of window.__pcs) { const st = await pc.getStats(); let sel = null; st.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) { const q = st.get(r.selectedCandidatePairId); if (q) sel = (st.get(q.localCandidateId) || {}).candidateType; } }); let vw = null; st.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') vw = r.frameWidth; }); out.push({ policy: pc.getConfiguration().iceTransportPolicy, sig: pc.signalingState, ice: pc.iceConnectionState, selected: sel, inboundVideoW: vw }); } return out; });
const inboundVideos = (p) => p.evaluate(async () => { const out = []; for (const pc of window.__pcs) { if (pc.signalingState === 'closed') continue; const st = await pc.getStats(); let type = null; st.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) { const q = st.get(r.selectedCandidatePairId); if (q) type = (st.get(q.localCandidateId) || {}).candidateType; } }); st.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') out.push({ w: r.frameWidth || 0, frames: r.framesDecoded || 0, type }); }); } return out; });
const screenFrames = async (p) => (await inboundVideos(p)).filter((v) => v.w === SHARE_W).reduce((n, v) => n + v.frames, 0);
const cameraFrames = async (p) => (await inboundVideos(p)).filter((v) => v.w > 0 && v.w !== SHARE_W).reduce((n, v) => n + v.frames, 0);
const note = (name, value) => console.log('  NOTE ' + name + ': ' + value);
// coturn's telnet-style admin CLI (the same protocol the voice engine's turn.mjs speaks): log in, run commands, return each command's output
import net from 'node:net';
function turnCli(commands, { host = '127.0.0.1', port, password, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host), outs = []; let buf = '', stage = 'login', i = 0, done = false;
    const finish = (err) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch { /* closed */ } err ? reject(err) : resolve(outs); };
    const timer = setTimeout(() => finish(new Error('turn_cli_timeout')), timeoutMs); sock.on('error', finish); sock.on('close', () => finish(done ? undefined : new Error('turn_cli_closed')));
    sock.on('data', (d) => { buf += d.toString().replace(/\r/g, '');
      if (stage === 'login' && /Enter password:\s*$/.test(buf)) { buf = ''; stage = 'pw'; sock.write(password + '\r\n'); return; }
      if (stage === 'pw' && /Enter password:\s*$/.test(buf)) return finish(new Error('turn_cli_auth_failed'));
      if ((stage === 'pw' || stage === 'cmd') && /(^|\n)> $/.test(buf)) { if (stage === 'cmd') outs.push(buf.replace(/\n> $/, '')); stage = 'cmd'; buf = ''; if (i >= commands.length) { try { sock.write('quit\r\n'); } catch { /* closed */ } return finish(); } sock.write(commands[i++] + '\r\n'); } });
  });
}
const parseSessions = (text) => [...String(text).matchAll(/^\s*\d+\)\s+id=([0-9a-fA-F]+),\s+user\s+<([^>]*)>/gm)].map((m) => ({ id: m[1], user: m[2] }));
const audioInbound = (p) => p.evaluate(async () => { let n = 0; for (const pc of window.__pcs) { const st = await pc.getStats(); st.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio' && r.bytesReceived > 500) n++; }); } return n; });
async function joinMore(srv, browser, code, name) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] }); const p = await ctx.newPage(); await p.addInitScript(STUB);
  await p.goto(srv.base); await p.fill('#displayName', name); await p.fill('#meetingId', code); await p.click('#joinBtn');
  try { await p.waitForSelector('#app:not(.hidden)', { timeout: 45000 }); } catch (e) {
    const err = await p.evaluate(() => (document.getElementById('landingError')?.textContent || '') + ' | landing hidden=' + document.getElementById('landing')?.classList.contains('hidden')).catch(() => 'page unreadable');
    throw new Error('late joiner did not get in: ' + err + ' | meeting=' + code + ' | server log tail: ' + srv.log().slice(-400));
  }
  return { ctx, p };
}
const allow = async (hp, name) => { await hp.click('[data-tab=people]'); await hp.locator('#peopleList .person', { hasText: name }).getByRole('button', { name: 'Allow sharing' }).click(); };

async function main() {
  const PORT = 4977; const flags = ['--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
  const withUi = await chromium.launch({ args: [...flags, '--use-fake-ui-for-media-stream'] });      // devices ready and permission prompts auto-accepted
  let srv = await bootServer({ ascs: true, port: PORT });
  let hp, gp, hctx, gctx; const run = (k) => !process.env.ONLY || process.env.ONLY.includes(k);      // ONLY=A,B,C,D runs just those sections
  try {
    // ---------------- A. ASCS ON: a guest with a camera, host-granted, shares; the host sees it; the host takes it back
    if (run('A')) {
    console.log('A. ASCS on, guest with camera');
    ({ hp, gp, hctx, gctx } = await room(srv, withUi, withUi));
    check('tools tell the page ASCS is on', (await toolsOf(gp)).ascs === true);
    check('guest sees no Share button before the host allows it', await gp.locator('#shareBtn').isHidden());
    await allow(hp, 'Gail'); await waitFor(() => gp.locator('#shareBtn').isVisible());
    check('after "Allow sharing" the guest\'s Share button appears', await gp.locator('#shareBtn').isVisible());
    await gp.click('#shareBtn'); check('the chooser opens (a user gesture, not an immediate capture)', (await gp.locator('#rcModal').count()) === 1 && (await gp.evaluate(() => window.__shareCalls || 0)) === 0);
    await gp.getByRole('radio').nth(1).check(); await gp.getByRole('button', { name: 'Start sharing' }).click();
    await waitFor(() => isSharing(gp));
    const active = (await srv.pool.query("SELECT state,kind FROM meeting_shares WHERE state='active'")).rows;
    check('the server holds exactly one active share, of the kind chosen', active.length === 1 && active[0].kind === 'window', JSON.stringify(active));
    check('guest button reads "Stop share"', (await gp.locator('#shareBtn span').textContent()).trim() === 'Stop share', 'toast="' + ((await gp.locator('#toast').textContent()) || '').trim() + '" label=' + (await gp.locator('#shareBtn span').textContent()) + ' shareCalls=' + (await gp.evaluate(() => window.__shareCalls)) + ' rows=' + JSON.stringify((await srv.pool.query('SELECT state,end_reason FROM meeting_shares')).rows));
    const w1 = await waitFor(async () => (await remoteVideoWidth(hp, 'Gail')) === SHARE_W ? SHARE_W : 0, 25000);
    check('the HOST receives the guest\'s shared screen (416px video through WebRTC)', w1 === SHARE_W, 'width ' + (await remoteVideoWidth(hp, 'Gail')));
    check('the host\'s People list offers "Stop presenting" for the presenter', await waitFor(() => hp.locator('#peopleList .person', { hasText: 'Gail' }).getByRole('button', { name: 'Stop presenting' }).isVisible(), 8000));
    // heartbeat keeps a 12 s lease alive well past its first deadline
    await wait(16000); check('the lease is renewed: the share is still active after 16 s on a 12 s lease', (await srv.pool.query("SELECT 1 FROM meeting_shares WHERE state='active'")).rowCount === 1);
    await hp.locator('#peopleList .person', { hasText: 'Gail' }).getByRole('button', { name: 'Stop presenting' }).click();
    await waitFor(async () => !(await isSharing(gp)));
    check('host "Stop presenting": the guest page stops capturing', !(await isSharing(gp)));
    check('the guest\'s capture tracks are really stopped', await gp.evaluate(() => window.__shareStream.getTracks().every((t) => t.readyState === 'ended')));
    check('the server marks the share revoked (host_revoked)', (await srv.pool.query("SELECT 1 FROM meeting_shares WHERE state='revoked' AND end_reason='host_revoked'")).rowCount === 1);
    check('the guest is told why', (await gp.locator('#toast').textContent()).includes('host ended your screen share'));
    // ---- handoff
    await hp.locator('#peopleList .person', { hasText: 'Gail' }).getByRole('button', { name: 'Give the screen' }).click();
    await waitFor(() => gp.locator('#shareBtn').isVisible());
    check('handoff: the guest may start again right after being handed the screen', await gp.locator('#shareBtn').isVisible());
    await hctx.close(); await gctx.close();
    }

    // ---------------- B. the defect behind "guest sharing not activated": a guest with NO camera or microphone shares their screen
    if (run('B')) {
    console.log('B. guest with no camera/microphone (permission denied) shares');
    ({ hp, gp, hctx, gctx } = await room(srv, withUi, withUi, { guestName: 'Nocam', denyMedia: true }));
    check('the guest page has no camera and no microphone (permission denied)', (await liveTracks(gp)) === 0 && (await gp.evaluate(() => window.__gumFail)) >= 1);
    check('the host\'s tile for them shows the avatar (not a black video)', !!(await waitFor(() => avatarShown(hp, 'Nocam'), 10000)));
    await allow(hp, 'Nocam'); await waitFor(() => gp.locator('#shareBtn').isVisible());
    await gp.click('#shareBtn'); await gp.getByRole('button', { name: 'Start sharing' }).click();
    await waitFor(() => isSharing(gp));
    const w2 = await waitFor(async () => (await remoteVideoWidth(hp, 'Nocam')) === SHARE_W ? SHARE_W : 0, 25000);
    check('a guest WITHOUT a camera can share: the host receives the 416px screen', w2 === SHARE_W, 'width ' + (await remoteVideoWidth(hp, 'Nocam')));
    await gp.click('#shareBtn'); await waitFor(async () => !(await isSharing(gp)));
    check('the guest stops sharing; the server marks it stopped', !!(await waitFor(async () => (await srv.pool.query("SELECT 1 FROM meeting_shares WHERE state='stopped' AND end_reason='stopped'")).rowCount === 1, 8000)));
    check('after stopping, the host\'s tile goes back to the avatar', !!(await waitFor(() => avatarShown(hp, 'Nocam'), 10000)));
    // ---- and the camera/microphone recovery: permission is granted LATER, the guest clicks "Start video" instead of rejoining
    await gp.evaluate(() => { window.__deny = false; });                       // the person clicks "Allow" in the browser's permission prompt
    await gp.click('#camBtn'); await waitFor(async () => (await liveTracks(gp, 'video')) > 0);
    check('"Start video" after granting permission gets the camera without rejoining', (await liveTracks(gp, 'video')) > 0 && ((await gp.locator('#camBtn span').textContent()) || '').trim() === 'Stop video', 'toast="' + ((await gp.locator('#toast').textContent()) || '').trim() + '" label=' + (await gp.locator('#camBtn span').textContent()) + ' gumFail=' + (await gp.evaluate(() => window.__gumFail)) + ' gum=' + (await gp.evaluate(() => window.__gum.length)));
    const w3 = await waitFor(async () => { const w = await remoteVideoWidth(hp, 'Nocam'); return w > 0 && w !== SHARE_W ? w : 0; }, 25000);
    check('the host now SEES the guest\'s camera (no renegotiation needed)', w3 > 0 && w3 !== SHARE_W, 'width ' + (await remoteVideoWidth(hp, 'Nocam')));
    await gp.click('#micBtn'); await waitFor(async () => (await liveTracks(gp, 'audio')) > 0);
    check('"Unmute" after granting permission gets the microphone', (await liveTracks(gp, 'audio')) > 0 && ((await gp.locator('#micBtn span').textContent()) || '').trim() === 'Mute', 'toast="' + ((await gp.locator('#toast').textContent()) || '').trim() + '" label=' + (await gp.locator('#micBtn span').textContent()));
    await hctx.close(); await gctx.close();
    }

    // ---------------- C. permission withdrawn and a crashed page
    if (run('C')) {
    console.log('C. withdrawn permission, vanished page');
    ({ hp, gp, hctx, gctx } = await room(srv, withUi, withUi, { guestName: 'Gail' }));
    await allow(hp, 'Gail'); await waitFor(() => gp.locator('#shareBtn').isVisible());
    await gp.click('#shareBtn'); await gp.getByRole('button', { name: 'Start sharing' }).click(); await waitFor(() => isSharing(gp));
    await hp.locator('#peopleList .person', { hasText: 'Gail' }).getByRole('button', { name: 'Stop sharing' }).click();
    await waitFor(async () => !(await isSharing(gp)));
    check('the host takes back "Allow sharing": the share ends at once on the guest page', !(await isSharing(gp)));
    check('...and the server recorded permission_withdrawn', !!(await waitFor(async () => (await srv.pool.query("SELECT 1 FROM meeting_shares WHERE end_reason='permission_withdrawn'")).rowCount === 1, 8000)), JSON.stringify((await srv.pool.query('SELECT state,end_reason FROM meeting_shares')).rows));
    await allow(hp, 'Gail'); await waitFor(() => gp.locator('#shareBtn').isVisible());
    await gp.click('#shareBtn'); await gp.getByRole('button', { name: 'Start sharing' }).click(); await waitFor(() => isSharing(gp));
    await gctx.close();                                                                                  // the guest's browser vanishes without saying goodbye
    const gone = await waitFor(async () => (await srv.pool.query("SELECT 1 FROM meeting_shares WHERE end_reason='lease_expired'")).rowCount === 1, 45000, 500);
    check('a page that vanishes: the lease runs out and the server ends the share', !!gone);
    check('...and the host page no longer offers "Stop presenting"', !!(await waitFor(async () => (await presenterButton(hp, 'Gail').count()) === 0, 8000)));
    await hctx.close();
    }

    // ---------------- E. the Teams-upgrade items: ASCS known from the start, computer audio, a late joiner, a reload, failing closed
    if (run('E')) {
    console.log('E. audio, late joiner, reload, fail-closed');
    ({ hp, gp, hctx, gctx } = await room(srv, withUi, withUi, { guestName: 'Eve', shareForAll: true }));
    const code = (await hp.textContent('#roomId')).trim();
    await waitFor(() => gp.locator('#shareBtn').isVisible());
    await gp.click('#shareBtn');
    check('a guest (sharing on for everyone from the start, no tool change since) gets the new chooser', (await gp.locator('#rcModal').count()) === 1);
    const passerby = await joinMore(srv, withUi, code, 'Passerby'); await wait(3000);                 // somebody ELSE joins while the chooser is open (the server then sends "recording-state")
    check('the open chooser is NOT closed when another person joins', (await gp.locator('#rcModal').count()) === 1 && (await gp.locator('#shareAudio').count()) === 1);
    await passerby.ctx.close();
    await gp.locator('#shareAudio').check(); await gp.getByRole('button', { name: 'Start sharing' }).click(); await waitFor(() => isSharing(gp));
    check('the guest is told computer audio is being shared', !!(await waitFor(async () => ((await gp.locator('#toast').textContent()) || '').includes('computer audio'), 8000)));
    const na = await waitFor(async () => ((await audioInbound(hp)) >= 2 ? 2 : 0), 30000);
    check('computer audio reaches the host: a second audio stream (besides the microphone) carries data', na === 2, 'inbound audio streams with data: ' + (await audioInbound(hp)));
    check('...together with the picture', (await waitFor(async () => ((await remoteVideoWidth(hp, 'Eve')) === SHARE_W ? SHARE_W : 0), 20000)) === SHARE_W);
    // a person who joins WHILE the share runs receives it
    const late = await joinMore(srv, withUi, code, 'Late');
    check('a late joiner receives the running share (416px)', (await waitFor(async () => ((await remoteVideoWidth(late.p, 'Eve')) === SHARE_W ? SHARE_W : 0), 30000)) === SHARE_W, 'width ' + (await remoteVideoWidth(late.p, 'Eve')));
    await late.ctx.close();
    // a reload loses the capture: the stale share is ended at once (not after the lease) and the person can start again immediately
    // (the lease is set far ahead first: a slow machine can take longer than the test lease to reload, and then the SERVER would end it and hide whether the page does)
    const staleId = (await srv.pool.query("UPDATE meeting_shares SET lease_expires_at = now() + interval '5 minutes' WHERE state = 'active' RETURNING id")).rows[0].id;
    await gp.reload(); await gp.waitForSelector('#app:not(.hidden)', { timeout: 30000 });
    // follow THIS share by id (older sections leave ended shares in the same database)
    const ended = await waitFor(async () => (await srv.pool.query("SELECT end_reason FROM meeting_shares WHERE id=$1 AND state<>'active'", [staleId])).rows[0]?.end_reason, 25000, 250);
    check('after a reload the page ends its own stale share itself (its lease had minutes left)', ended === 'stopped', 'end_reason=' + ended);
    await waitFor(() => gp.locator('#shareBtn').isVisible()); await gp.click('#shareBtn'); await gp.getByRole('button', { name: 'Start sharing' }).click(); await waitFor(() => isSharing(gp));
    check('...and it can share again right away', (await srv.pool.query("SELECT count(*)::int n FROM meeting_shares WHERE state='active'")).rows[0].n === 1 && await isSharing(gp));
    // the page cannot reach the server any more: it stops capturing once a whole lease has passed, and the server ends the share too
    await gp.route('**/shares/*/heartbeat', (r) => r.abort());
    const stopped = await waitFor(async () => !(await isSharing(gp)), 50000, 500);
    check('FAIL CLOSED: with the server unreachable for a whole lease, the page stops capturing', !!stopped);
    check('...and tells the person why', ((await gp.locator('#toast').textContent()) || '').includes('lost its connection'));
    check('...and the server has ended it by lease expiry as well', !!(await waitFor(async () => (await srv.pool.query("SELECT 1 FROM meeting_shares WHERE end_reason='lease_expired'")).rowCount >= 1, 40000, 500)));
    await hctx.close(); await gctx.close();
    }

    // ---------------- F. a MALICIOUS presenter (ignores every stop message): what the server enforces, and what it cannot
    if (run('F')) {
    console.log('F. malicious presenter that ignores revoke');
    const tamper = async (page) => page.route('**/app.js', async (route) => { const resp = await route.fetch(); const body = (await resp.text()).replace('async function endShare(opts={}){', 'async function endShare(opts={}){return;'); await route.fulfill({ response: resp, body }); });   // endShare does nothing: no message, no refusal, no browser "Stop" bar can stop it
    ({ hp, gp, hctx, gctx } = await room(srv, withUi, withUi, { guestName: 'Mallory', tamper }));
    await allow(hp, 'Mallory'); await waitFor(() => gp.locator('#shareBtn').isVisible());
    await gp.click('#shareBtn'); await gp.getByRole('button', { name: 'Start sharing' }).click(); await waitFor(() => isSharing(gp));
    check('the share reaches the host before anything is revoked (416px)', (await waitFor(async () => ((await remoteVideoWidth(hp, 'Mallory')) === SHARE_W ? SHARE_W : 0), 25000)) === SHARE_W);
    const framesBefore = await screenFrames(hp);
    await hp.locator('#peopleList .person', { hasText: 'Mallory' }).getByRole('button', { name: 'Stop presenting' }).click();
    await hp.locator('#peopleList .person', { hasText: 'Mallory' }).getByRole('button', { name: 'Stop sharing' }).click();      // and take the permission away
    const shareId = (await srv.pool.query("SELECT id FROM meeting_shares ORDER BY started_at DESC LIMIT 1")).rows[0].id;
    check('SERVER: the share is revoked', !!(await waitFor(async () => (await srv.pool.query("SELECT 1 FROM meeting_shares WHERE id=$1 AND state='revoked'", [shareId])).rowCount === 1, 15000)));
    await wait(1500);
    check('the tampered page IGNORED the stop: it is still capturing', await isSharing(gp));
    const call = (method, path, body) => gp.evaluate(async ([m, p, b]) => { const r = await fetch('/api/meetings/' + window.__mid + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: window.__auth }, body: b ? JSON.stringify(b) : undefined }); return r.status; }, [method, path, body]);
    check('SERVER: its heartbeat is refused (409)', (await call('POST', '/shares/' + shareId + '/heartbeat', {})) === 409);
    check('SERVER: a new share start is refused (403)', (await call('POST', '/shares', { kind: 'screen', mode: 'content', clientRequestId: 'mal-' + Date.now() })) === 403);
    check('SERVER: the host\'s list shows nobody presenting', (await presenterButton(hp, 'Mallory').count()) === 0);
    // ---- the media itself
    const f1 = await screenFrames(hp); await wait(4000); const f2 = await screenFrames(hp);
    note('video frames the host decoded: before revoke ' + framesBefore + ', right after ' + f1 + ', 4 s later ' + f2, (f2 - f1) + ' new frames in 4 s');
    check('KNOWN GAP, MEASURED (this is why the verdict is NO-GO): the server revoked the share and withdrew the permission, yet the ignoring client still delivers video to the host', f2 - f1 > 10, 'only ' + (f2 - f1) + ' new frames: the gap was NOT reproduced (the check documents the CURRENT behaviour; when real media enforcement exists this must flip)');
    await hctx.close(); await gctx.close();
    }

    // ---------------- G. REAL PAGES with the relay-enforced share channel (ASCS-M1.2): needs the qm12 relay (tests/poc/relay-up.sh)
    if (run('G')) {
    if (!process.env.RELAY_LAN_IP) console.log('G. SKIPPED (start the relay: LAN_IP=<lan> tests/poc/relay-up.sh ; then set RELAY_LAN_IP=<lan>)');
    else {
      console.log('G. real pages, relay-enforced share channel');
      const relayEnv = { ASCS_RELAY_ENABLED: 'true', ASCS_SWEEP_MS: '1000', RELAY_REDIS_HOST: '127.0.0.1', RELAY_REDIS_PORT: '36390', RELAY_CLI_HOST: '127.0.0.1', RELAY_CLI_PORT: '35790', RELAY_CLI_PASSWORD: 'clipw', RELAY_REALM: 'qorlla.poc', RELAY_TURN_URLS: 'turn:' + process.env.RELAY_LAN_IP + ':34790?transport=udp', RELAY_CREDENTIAL_TTL_SECONDS: '300' };
      const srvG = await bootServer({ ascs: true, port: PORT + 3, extraEnv: relayEnv });
      try {
        // ---- G1: normal use
        ({ hp, gp, hctx, gctx } = await room(srvG, withUi, withUi, { guestName: 'Rae', shareForAll: true }));
        const codeG = (await hp.textContent('#roomId')).trim();
        check('the page is told the relay is on', (await toolsOf(gp)).relay === true);
        const camPre0 = await cameraFrames(hp); await wait(3000); const camBaseRate = ((await cameraFrames(hp)) - camPre0) / 3;      // camera frames per second BEFORE sharing
        await gp.click('#shareBtn'); await gp.getByRole('button', { name: 'Start sharing' }).click(); await waitFor(() => isSharing(gp));
        check('G1 the host receives the guest\'s screen (416 px) through the relay-enforced channel', (await waitFor(async () => ((await screenFrames(hp)) > 20 ? 1 : 0), 40000)) === 1, JSON.stringify(await inboundVideos(hp)));
        const vids = await inboundVideos(hp);
        check('G1 on a SEPARATE connection from the camera: the host has a camera stream (not 416 px) AND a screen stream (416 px)', vids.some((v) => v.w === SHARE_W) && vids.some((v) => v.w > 0 && v.w !== SHARE_W), 'streams ' + JSON.stringify(vids) + ' | ALL host peer connections ' + JSON.stringify(await allPcs(hp)) + ' | guest ' + JSON.stringify(await allPcs(gp)));
        check('G1 the screen connection is RELAY-only (selected candidate pair type is relay)', vids.filter((v) => v.w === SHARE_W).every((v) => v.type === 'relay'), JSON.stringify(vids));
        check('G1 the server holds revocable credentials for this share (presenter + viewer), none revoked', (await srvG.pool.query('SELECT count(*)::int n FROM relay_credentials WHERE revoked_at IS NULL')).rows[0].n >= 2);
        check('G1 the host\'s tile shows the screen (416 px video)', (await remoteVideoWidth(hp, 'Rae')) === SHARE_W);
        const late = await joinMore(srvG, withUi, codeG, 'Late');
        check('G1 a person who joins WHILE the share runs receives it through the relay too', (await waitFor(async () => ((await remoteVideoWidth(late.p, 'Rae')) === SHARE_W ? SHARE_W : 0), 40000)) === SHARE_W, 'width ' + (await remoteVideoWidth(late.p, 'Rae')));
        await late.ctx.close();
        await gp.click('#micBtn'); const micLabel = ((await gp.locator('#micBtn span').textContent()) || '').trim(); await gp.click('#micBtn');
        check('G1 NO REGRESSION: the guest\'s microphone button still works while sharing (' + micLabel + ' then back)', ['Mute', 'Unmute'].includes(micLabel));
        const camBefore = await cameraFrames(hp); await wait(4000); const camDuringRate = ((await cameraFrames(hp)) - camBefore) / 4;
        check('G1 NO REGRESSION: the guest\'s camera keeps flowing to the host while sharing (mesh path untouched): at least half of its own rate from before the share', camDuringRate >= Math.max(1, camBaseRate * 0.5), 'before ' + camBaseRate.toFixed(1) + ' fps, while sharing ' + camDuringRate.toFixed(1) + ' fps');
        // ---- G2: an HONEST host stop: the page cooperates, the tile goes back to the camera
        await hp.click('[data-tab=people]');
        await hp.locator('#peopleList .person', { hasText: 'Rae' }).getByRole('button', { name: 'Stop presenting' }).click();
        check('G2 host stops presenting: the guest\'s page ends the share and the host\'s tile returns to the camera', !!(await waitFor(async () => !(await isSharing(gp)) && (await remoteVideoWidth(hp, 'Rae')) !== SHARE_W, 25000)));
        check('G2 every relay credential of the share is revoked and terminated in the registry', !!(await waitFor(async () => (await srvG.pool.query('SELECT count(*)::int n FROM relay_credentials WHERE terminated_at IS NULL')).rows[0].n === 0, 20000)));
        await hctx.close(); await gctx.close();

        // ---- G3: the SAME malicious presenter as scenario F (its page ignores every stop message): now the relay stops it
        const tamperG = async (page) => page.route('**/app.js', async (route) => { const resp = await route.fetch(); const body = (await resp.text()).replace('async function endShare(opts={}){', 'async function endShare(opts={}){return;'); await route.fulfill({ response: resp, body }); });
        ({ hp, gp, hctx, gctx } = await room(srvG, withUi, withUi, { guestName: 'Mallory', tamper: tamperG }));
        await allow(hp, 'Mallory'); await waitFor(() => gp.locator('#shareBtn').isVisible());
        await gp.click('#shareBtn'); await gp.getByRole('button', { name: 'Start sharing' }).click(); await waitFor(() => isSharing(gp));
        check('G3 the share reaches the host through the relay before anything is revoked', (await waitFor(async () => ((await screenFrames(hp)) > 20 ? 1 : 0), 40000)) === 1);
        const sf0 = await screenFrames(hp); await wait(2500); const flowingRate = (await screenFrames(hp)) - sf0;
        await hp.locator('#peopleList .person', { hasText: 'Mallory' }).getByRole('button', { name: 'Stop presenting' }).click();
        await hp.locator('#peopleList .person', { hasText: 'Mallory' }).getByRole('button', { name: 'Stop sharing' }).click();
        await waitFor(async () => (await srvG.pool.query("SELECT count(*)::int n FROM meeting_shares WHERE state='revoked'")).rows[0].n >= 1, 15000);
        await waitFor(async () => (await srvG.pool.query('SELECT count(*)::int n FROM relay_credentials WHERE terminated_at IS NULL')).rows[0].n === 0, 20000);
        check('G3 the tampered page IGNORED the stop: it is still capturing', await isSharing(gp));
        const s1 = await screenFrames(hp), c1 = await cameraFrames(hp); await wait(5000); const s2 = await screenFrames(hp), c2 = await cameraFrames(hp);
        note('MALICIOUS PRESENTER, relay-enforced: screen frames the host decoded in 5 s AFTER revoke: ' + (s2 - s1) + ' (before the revoke the screen delivered ' + flowingRate + ' per 2.5 s). Compare scenario F (peer to peer): 60 per 4 s.');
        check('G3 THE RELAY STOPS IT: the revoked, ignoring presenter delivers (almost) no more screen frames to the host', s2 - s1 <= 5, (s2 - s1) + ' frames in 5 s');
        check('G3 ...while the ordinary camera connection is untouched (camera frames still arrive)', c2 - c1 > 20, (c2 - c1) + ' camera frames in 5 s');
        const callG = (method, path, body) => gp.evaluate(async ([m, p, b]) => { const r = await fetch('/api/meetings/' + window.__mid + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: window.__auth }, body: b ? JSON.stringify(b) : undefined }); return r.status; }, [method, path, body]);
        const shareIdG = (await srvG.pool.query("SELECT id FROM meeting_shares ORDER BY started_at DESC LIMIT 1")).rows[0].id;
        check('G3 it cannot get fresh relay credentials for the revoked share (409), and cannot start a new share (403)', (await callG('POST', '/shares/' + shareIdG + '/relay-credentials', {})) === 409 && (await callG('POST', '/shares', { kind: 'screen', mode: 'content', clientRequestId: 'mal-' + Date.now() })) === 403);
        await hctx.close(); await gctx.close();
      } finally { await srvG.stop(); }
    }
    }

    // ---------------- T. TURN-ONLY (relay) share, and what cancelling the presenter's relay session does (needs a coturn: see the header)
    if (run('T')) {
    if (!process.env.TURN_TEST_PORT) console.log('T. SKIPPED (set TURN_TEST_PORT, TURN_TEST_CLI_PORT, TURN_TEST_CLI_PW, TURN_TEST_SECRET: a coturn with --use-auth-secret --lt-cred-mech --cli)');
    else {
      console.log('T. TURN-only share and relay-level termination');
      const TP = process.env.TURN_TEST_PORT, cli = { port: Number(process.env.TURN_TEST_CLI_PORT), password: process.env.TURN_TEST_CLI_PW };
      const srvT = await bootServer({ ascs: true, port: PORT + 2, extraEnv: { TURN_URLS: 'turn:' + (process.env.TURN_TEST_HOST || '127.0.0.1') + ':' + TP + '?transport=udp', TURN_SHARED_SECRET: process.env.TURN_TEST_SECRET, ICE_TRANSPORT_POLICY: 'relay', TURN_CREDENTIAL_TTL_SECONDS: '600' } });
      try {
        ({ hp, gp, hctx, gctx } = await room(srvT, withUi, withUi, { guestName: 'Rae', shareForAll: true }));
        await gp.click('#shareBtn'); await gp.getByRole('button', { name: 'Start sharing' }).click(); await waitFor(() => isSharing(gp));
        const w = await waitFor(async () => ((await remoteVideoWidth(hp, 'Rae')) === SHARE_W ? SHARE_W : 0), 40000);
        const st = async (p) => p.evaluate(() => window.__pcs.map((pc) => pc.iceConnectionState + '/' + pc.connectionState + '/' + pc.iceGatheringState).join(','));
        const iceCfg = await hp.evaluate(async () => { const r = await (await fetch('/api/meetings/' + window.__mid + '/ice', { headers: { Authorization: window.__auth } })).json(); return { policy: r.iceTransportPolicy, servers: (r.iceServers || []).map((x) => ({ urls: x.urls, user: x.username ? 'set' : 'none' })) }; });
        check('TURN-ONLY: the guest\'s screen reaches the host (416px) through the relay', w === SHARE_W, 'width ' + (await remoteVideoWidth(hp, 'Rae')) + ' | host pc: ' + (await st(hp)) + ' | guest pc: ' + (await st(gp)) + ' | /ice: ' + JSON.stringify(iceCfg));
        const pt = await pairTypes(hp); check('TURN-ONLY: the selected candidate pair on the host is a RELAY candidate (no direct path exists)', pt?.local === 'relay', JSON.stringify(pt));
        const guestId = (await srvT.pool.query("SELECT id FROM participants WHERE display_name='Rae'")).rows[0].id;
        const listed = parseSessions((await turnCli(['psp :' + guestId], cli))[0]);
        check('the relay holds live allocation(s) of the presenter (found by its participant id in the REST username)', listed.length >= 1, 'sessions: ' + JSON.stringify(listed));
        const framesPre = await screenFrames(hp); await wait(2500); const framesMid = await screenFrames(hp);
        check('before cancelling, frames are flowing', framesMid - framesPre > 10, 'delta ' + (framesMid - framesPre));
        await turnCli(listed.map((x) => 'cs ' + x.id), cli);
        const cancelledAt = Date.now(); await wait(300); const atCancel = await screenFrames(hp);
        await wait(3000); const afterCancel = await screenFrames(hp);
        check('RELAY-LEVEL TERMINATION: after the server cancels the presenter\'s relay allocation the host receives (almost) no more frames', afterCancel - atCancel < 8, (afterCancel - atCancel) + ' frames in 3 s');
        const resumed = await waitFor(async () => ((await screenFrames(hp)) - afterCancel > 30 ? Math.round((Date.now() - cancelledAt) / 1000) : 0), 60000, 500);
        note('after the cancel, with a stateless REST credential that is still valid, the media', resumed ? 'RESUMED after ' + resumed + ' s (the client re-allocated: cancelling alone is not durable enforcement; the credential must be revocable too)' : 'did NOT resume within 60 s');
        await hctx.close(); await gctx.close();
      } finally { await srvT.stop(); }
    }
    }
  } finally { await srv.stop(); }

  // ---------------- D. ASCS OFF (the default): the old flow still works, the server keeps no share
  if (run('D')) {
  console.log('D. ASCS off (default)');
  srv = await bootServer({ ascs: false, port: PORT + 1 });
  try {
    const { hp, gp, hctx, gctx } = await room(srv, withUi, withUi);
    check('the page is told ASCS is off', (await toolsOf(gp)).ascs === false);
    await allow(hp, 'Gail'); await waitFor(() => gp.locator('#shareBtn').isVisible());
    await gp.click('#shareBtn'); await wait(500);
    check('no chooser: Share starts immediately as before', (await gp.locator('#rcModal').count()) === 0 && await waitFor(() => isSharing(gp), 8000));
    check('the host still receives the share', (await waitFor(async () => (await remoteVideoWidth(hp, 'Gail')) === SHARE_W ? SHARE_W : 0, 25000)) === SHARE_W);
    check('the server keeps no share row when the feature is off', (await srv.pool.query('SELECT count(*)::int n FROM meeting_shares')).rows[0].n === 0);
    await hctx.close(); await gctx.close();
  } finally { await srv.stop(); }
  }
  await withUi.close();
  const failed = results.filter((r) => !r.ok); console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
