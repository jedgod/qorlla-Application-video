'use strict';
// Desktop shell against ONE existing Qorlla server (npm run dev:local): it starts no second backend, stays on the approved origin, and qorlla://join only ever opens the pre-join page of an 11-digit meeting.
// Needs DESKTOP_E2E_URL (the server to open, e.g. http://localhost:18081 for an isolated test server; never point it at a production host). Uses a throw-away profile folder. Development run only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const URL_ = process.env.DESKTOP_E2E_URL, skip = URL_ ? false : 'set DESKTOP_E2E_URL to a running Qorlla server (an isolated test server)';
const desktop = path.join(__dirname, '..', 'apps', 'desktop'), PORT = Number(process.env.DESKTOP_E2E_DEBUG_PORT || 19300 + Math.floor(Math.random() * 600));   // a fresh port each run, so a shell still closing from the last run cannot be mistaken for this one
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qorlla-desktop-e2e-'));
const env = () => { const e = { ...process.env, QORLLA_APP_URL: URL_, QORLLA_DEV_USER_DATA: profile }; delete e.ELECTRON_RUN_AS_NODE; return e; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// every process started by the shell launcher (the launcher, Electron and its helpers), found by walking the parent links
const tree = (root) => spawnSync('powershell', ['-NoProfile', '-Command', '$all = Get-CimInstance Win32_Process; $ids = @(' + root + '); do { $n = @($all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | ForEach-Object { $_.ProcessId }); $ids += $n } while ($n.Count); $ids -join ","'], { encoding: 'utf8' }).stdout.trim().split(',').map(Number);
// TCP ports in LISTEN state that belong to those processes (other software on the machine opening ports is not the shell's doing)
const listeningBy = (pids) => [...spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout.matchAll(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/gm)].filter((m) => pids.includes(Number(m[2]))).map((m) => Number(m[1]));
const pages = async () => (await (await fetch('http://127.0.0.1:' + PORT + '/json')).json()).filter((p) => p.type === 'page');
const pageUrl = async () => ((await pages())[0] || {}).url || '';
async function cdp(expression) {
  const ws = new WebSocket((await pages())[0].webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
  const done = new Promise((r, rej) => { const t = setTimeout(() => rej(new Error('no answer from the window within 10 s')), 10000); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { clearTimeout(t); r(d); } }; });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } })); const out = await done; ws.close(); return out;
}
let child = null;
async function waitUrl(re, ms = 15000) { const t0 = Date.now(); let u = ''; while (Date.now() - t0 < ms) { try { u = await pageUrl(); if (re.test(u)) return u; } catch { /* not up yet */ } await sleep(300); } return u; }

test('npm run dev:local opens the one existing server and starts no second backend', { skip }, async () => {
  child = spawn(process.execPath, [path.join(desktop, 'dev-local.cjs'), '--remote-debugging-port=' + PORT], { cwd: desktop, env: env(), stdio: 'ignore' });
  const u = await waitUrl(/^https?:/); assert.equal(new URL(u).origin, new URL(URL_).origin, 'the window shows the configured server: ' + u);
  await sleep(2500); const mine = tree(child.pid); assert.ok(mine.length >= 2, 'the shell has processes: ' + mine.join(','));
  assert.deepEqual(listeningBy(mine).filter((p) => p !== PORT), [], 'the shell and its helpers listen on no port besides the debugging port used by this test (no server, no database)');
  const stray = []; (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(sqlite3?|db|mdb)$/i.test(f.name) && !/^(Cookies|History|Favicons|Web Data|Login Data|Network Persistent State|Shared Dictionary|Safe Browsing|Reporting and NEL|Trust Tokens|DIPS|Conversions|SharedStorage|Top Sites|Visited Links)/i.test(f.name)) stray.push(p); } })(profile);
  assert.deepEqual(stray, [], 'the profile folder holds only the browser profile, no application database');
});

test('the window cannot be navigated off the approved origin', { skip }, async () => {
  const origin = new URL(URL_).origin;
  for (const target of ['http://localhost:3225/', 'https://example.com/', 'http://127.0.0.1:' + (new URL(URL_).port || '80') + '/', 'file:///C:/Windows/win.ini']) {
    await cdp('try{location.href=' + JSON.stringify(target) + '}catch(e){}'); await sleep(1200);
    assert.equal(new URL(await pageUrl()).origin, origin, 'still on the approved origin after trying ' + target);
  }
  await cdp("window.open('https://example.com/')"); await sleep(1200); assert.equal((await pages()).length, 1, 'no extra window was opened');
});

test('qorlla://join opens the pre-join page for an 11-digit meeting, and ignores anything else', { skip }, async () => {
  const send = async (link) => { spawnSync(process.execPath, [path.join(desktop, 'dev-local.cjs'), link], { cwd: desktop, env: env(), stdio: 'ignore', timeout: 20000 }); await sleep(1500); return pageUrl(); };
  const base = await pageUrl();
  const ok = await send('qorlla://join?meeting=85898333712'); assert.match(ok, /\/guest\/meeting\/858[ %20]*9833[ %20]*3712\/prejoin$/, 'opened the pre-join page: ' + ok); assert.equal(new URL(ok).origin, new URL(URL_).origin);
  const stay = ok;
  for (const bad of ['qorlla://join?meeting=123', 'qorlla://join?meeting=8589833371x', 'qorlla://join?meeting=85898333712&next=https://evil.example/', 'qorlla://join?next=https://evil.example/', 'qorlla://evil/?meeting=85898333712', 'qorlla://join/../x?meeting=85898333712', 'qorlla://join?meeting=../../etc/passwd', 'qorlla://user:pw@join?meeting=85898333712', 'qorlla://join?meeting=85898333712#frag', 'qorlla://join?meeting=https://evil.example/']) {
    const got = await send(bad); if (process.env.DESKTOP_E2E_TRACE) console.log('TRACE', bad, '->', got); assert.equal(got, stay, 'ignored: ' + bad);
  }
  assert.ok(base);
});

test.after(async () => { if (child && child.pid) { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); await sleep(3000); } try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* profile is in the temp folder */ } });
