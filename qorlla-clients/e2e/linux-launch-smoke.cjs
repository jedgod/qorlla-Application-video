'use strict';
// Linux launch smoke test for the INSTALLED Qorlla (the deb, after `apt install`). It proves the application really starts with Chromium's sandbox working, not merely that a process stays alive:
//   1. the app starts as a non-root user and a real window (a page target) loads
//   2. no process of the app carries a sandbox-disabling switch, and every renderer runs under a seccomp filter with no-new-privs (Chromium's sandbox is in effect)
//   3. the AppArmor profile is attached to the real process (/proc/<pid>/attr/current names it), not merely present on disk
//   4. a controlled media test works inside the sandboxed renderer: a loopback WebRTC call carrying generated audio and video, with counters that must grow
// Modes:
//   node linux-launch-smoke.cjs /opt/Qorlla/qorlla --expect-profile qorlla         normal run (needs a display, e.g. xvfb-run -a)
//   node linux-launch-smoke.cjs /opt/Qorlla/qorlla --expect-sandbox-refusal         negative control: with NO profile the app must refuse to start (fail closed), not run unsandboxed
// Evidence (no secrets, no user data) is written to $LINUX_SMOKE_EVIDENCE when set. Linux only.
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const SANDBOX_OFF = /^--(no-sandbox|disable-setuid-sandbox|disable-gpu-sandbox|disable-seccomp-filter-sandbox|disable-namespace-sandbox|disable-renderer-sandbox|disable-sandbox)(=.*)?$/i;
const REFUSAL = /setuid_sandbox_host|No usable sandbox|sandbox helper|namespace sandbox|Rather than run without sandboxing/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** /proc/<pid>/stat -> { pid, ppid }. The command name sits in parentheses and may itself contain spaces or parentheses, so parse from the LAST closing parenthesis. */
function parseStat(text) { const i = text.lastIndexOf(')'); if (i < 0) return null; const rest = text.slice(i + 2).split(' '); return { pid: Number(text.slice(0, text.indexOf(' '))), ppid: Number(rest[1]) }; }
function descendants(rootPid, table) { const out = [rootPid]; for (let i = 0; i < out.length; i++) for (const p of table) if (p.ppid === out[i] && !out.includes(p.pid)) out.push(p.pid); return out; }
const field = (status, name) => { const m = new RegExp('^' + name + ':\\s*(.*)$', 'm').exec(status); return m ? m[1].trim() : null; };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
function procInfo(pid) {
  const cmd = (read(`/proc/${pid}/cmdline`) || '').split('\0').filter(Boolean), status = read(`/proc/${pid}/status`) || '';
  let userNs = null; try { userNs = fs.readlinkSync(`/proc/${pid}/ns/user`); } catch { /* gone */ }
  return { pid, type: (cmd.find((a) => a.startsWith('--type=')) || '--type=main').slice(7), cmd, seccomp: field(status, 'Seccomp'), noNewPrivs: field(status, 'NoNewPrivs'), uid: (field(status, 'Uid') || '').split(/\s+/)[0], apparmor: (read(`/proc/${pid}/attr/current`) || '').trim(), userNs };
}
const snapshot = (rootPid) => { const table = []; for (const d of fs.readdirSync('/proc')) if (/^\d+$/.test(d)) { const s = parseStat(read(`/proc/${d}/stat`) || ''); if (s) table.push(s); } return descendants(rootPid, table).map(procInfo); };

const MEDIA_TEST = `(async () => {
  const c = document.createElement('canvas'); c.width = 320; c.height = 240; const g = c.getContext('2d'); let t = 0; const iv = setInterval(() => { g.fillStyle = 'hsl(' + ((t++ * 7) % 360) + ',80%,50%)'; g.fillRect(0, 0, 320, 240); g.fillStyle = '#fff'; g.fillText(String(t), 10, 20); }, 33);
  const ac = new AudioContext(); await ac.resume().catch(() => {}); const osc = ac.createOscillator(), dst = ac.createMediaStreamDestination(); osc.connect(dst); osc.start();
  const stream = new MediaStream([...c.captureStream(30).getVideoTracks(), ...dst.stream.getAudioTracks()]);
  const a = new RTCPeerConnection(), b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate); b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  stream.getTracks().forEach((tr) => a.addTrack(tr, stream));
  await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription); await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription);
  const sample = async () => { const r = await b.getStats(); const o = { audioBytes: 0, videoBytes: 0, framesDecoded: 0, lost: 0 }; r.forEach((s) => { if (s.type === 'inbound-rtp') { o.lost += s.packetsLost || 0; if (s.kind === 'audio') o.audioBytes += s.bytesReceived || 0; else { o.videoBytes += s.bytesReceived || 0; o.framesDecoded += s.framesDecoded || 0; } } }); return o; };
  const t0 = Date.now(); while (Date.now() - t0 < 15000 && b.connectionState !== 'connected') await new Promise((r) => setTimeout(r, 250));
  const connected = b.connectionState; await new Promise((r) => setTimeout(r, 2500)); const s1 = await sample(); await new Promise((r) => setTimeout(r, 3000)); const s2 = await sample();
  clearInterval(iv); a.close(); b.close(); await ac.close();
  return { connected, delta: { audioBytes: s2.audioBytes - s1.audioBytes, videoBytes: s2.videoBytes - s1.videoBytes, framesDecoded: s2.framesDecoded - s1.framesDecoded }, packetsLost: s2.lost };
})()`;

async function cdp(wsUrl, expression) {
  const ws = new WebSocket(wsUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('devtools connection failed')); });
  const id = 1; const done = new Promise((res) => { ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === id) res(d); }; });
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); const r = await done; ws.close();
  if (r.error || (r.result && r.result.exceptionDetails)) throw new Error('page evaluation failed: ' + JSON.stringify(r.error || r.result.exceptionDetails).slice(0, 300));
  return r.result.result.value;
}

async function main(argv) {
  const bin = argv[0], expectProfile = argv.includes('--expect-profile') ? argv[argv.indexOf('--expect-profile') + 1] : null, expectRefusal = argv.includes('--expect-sandbox-refusal');
  if (process.platform !== 'linux' || !bin) { console.error('usage (Linux only): linux-launch-smoke.cjs <binary> [--expect-profile <name> | --expect-sandbox-refusal]'); return 2; }
  const port = 9300 + Math.floor(Math.random() * 400), evidence = { binary: bin, nonRoot: process.getuid() !== 0, mode: expectRefusal ? 'expect-sandbox-refusal' : 'normal' };
  let log = ''; const child = spawn(bin, ['--remote-debugging-port=' + port], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', QORLLA_APP_URL: process.env.QORLLA_APP_URL || 'https://qorlla-ci.invalid' } });   // a packaged app refuses to start without a verified https origin; .invalid never resolves, so the window shows the built-in offline page: this tests the shell, sandbox, renderer and media stack, NOT the Qorlla service
  for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { if (log.length < 200000) log += d; });
  let exited = null; child.on('exit', (code, sig) => { exited = { code, sig }; });
  const finish = async (code) => { try { child.kill('SIGTERM'); await sleep(1500); if (!exited) child.kill('SIGKILL'); } catch { /* gone */ } if (process.env.LINUX_SMOKE_EVIDENCE) fs.writeFileSync(process.env.LINUX_SMOKE_EVIDENCE, JSON.stringify(evidence, null, 2)); return code; };
  const fail = async (msg) => { evidence.failure = msg; console.log('FAIL: ' + msg); console.log('--- last log lines:'); console.log(log.split('\n').filter(Boolean).slice(-12).map((l) => '  ' + l.slice(0, 240)).join('\n')); return finish(1); };

  if (evidence.nonRoot === false) return fail('must run as a normal (non-root) user');
  // wait for a window (page target) or for the process to give up
  let target = null; const t0 = Date.now();
  while (Date.now() - t0 < 60000 && !exited && !target) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = list.find((t) => t.type === 'page'); } catch { /* not up yet */ } if (!target) await sleep(500); }
  if (expectRefusal) {
    if (target) return fail('NEGATIVE CONTROL FAILED: the app started a window although no AppArmor profile permits its sandbox');
    for (let i = 0; i < 40 && !exited; i++) await sleep(250);
    if (!exited || !REFUSAL.test(log)) return fail('NEGATIVE CONTROL: expected the app to refuse to start with a sandbox error; exit=' + JSON.stringify(exited));
    evidence.refused = { exit: exited, sandboxError: (log.split('\n').find((l) => REFUSAL.test(l)) || '').slice(0, 200).replace(/\[\d+:\d+\/\d+\.\d+:/, '[') };
    console.log('ok   fail-closed: with no permitting profile the app refused to start (sandbox error, exit ' + (exited.code ?? exited.sig) + ') instead of running unsandboxed'); return finish(0);
  }
  if (!target) return fail(exited ? 'the app exited before any window appeared (exit ' + JSON.stringify(exited) + ')' : 'no window appeared within 60 s');
  console.log('ok   a window loaded: ' + target.type + ' "' + String(target.title).slice(0, 60) + '"'); evidence.window = { note: 'built-in offline page: no Qorlla service is configured in this test', type: target.type, title: String(target.title).slice(0, 80), scheme: String(target.url).split(':')[0] };

  await sleep(3000); const procs = snapshot(child.pid); evidence.processes = procs.map((p) => ({ type: p.type, uidIsMain: p.uid === procs[0].uid, seccomp: p.seccomp, noNewPrivs: p.noNewPrivs, apparmor: p.apparmor, sameUserNsAsMain: p.userNs === procs[0].userNs }));
  const off = procs.flatMap((p) => p.cmd.filter((a) => SANDBOX_OFF.test(a)).map((a) => p.type + ': ' + a)); if (off.length) return fail('a process runs with the sandbox disabled: ' + off.join(', '));
  console.log(`ok   ${procs.length} processes inspected: none carries a sandbox-disabling switch`);
  const renderers = procs.filter((p) => p.type === 'renderer'); if (!renderers.length) return fail('no renderer process found to inspect');
  const bad = renderers.filter((r) => r.seccomp !== '2' || r.noNewPrivs !== '1'); if (bad.length) return fail(`${bad.length} renderer(s) are NOT under a seccomp filter with no-new-privs (Seccomp=${bad[0].seccomp}, NoNewPrivs=${bad[0].noNewPrivs}): the sandbox is not in effect`);
  console.log(`ok   ${renderers.length} renderer process(es) run under a seccomp filter with no-new-privs (Chromium's sandbox is in effect)`);
  const zyg = procs.filter((p) => p.type === 'zygote' || p.type === 'renderer'); evidence.userNamespaceSandbox = zyg.some((p) => p.userNs !== procs[0].userNs); console.log('info user-namespace sandbox in use (child processes in their own user namespace): ' + evidence.userNamespaceSandbox);
  if (expectProfile) { const a = procs[0].apparmor; evidence.apparmorMainProcess = a; if (!a.startsWith(expectProfile)) return fail(`the AppArmor profile "${expectProfile}" is NOT attached to the running process (attr/current = "${a || 'unavailable'}")`); console.log('ok   AppArmor profile attached to the running process: ' + a); }

  const page = await cdp(target.webSocketDebuggerUrl, '({ title: document.title, nodeExposed: typeof require !== "undefined" || typeof process !== "undefined", scheme: location.protocol })');
  if (page.nodeExposed) return fail('Node APIs are exposed to page content'); console.log('ok   page content has no Node access');
  let media; try { media = await cdp(target.webSocketDebuggerUrl, MEDIA_TEST); } catch (e) { return fail('media test: ' + e.message); }
  evidence.media = media; const m = media.delta;
  if (media.connected !== 'connected') return fail('media test: the loopback call did not connect (' + media.connected + ')');
  if (!(m.videoBytes > 0 && m.framesDecoded > 0 && m.audioBytes > 0)) return fail('media test: counters did not grow: ' + JSON.stringify(m));
  console.log(`ok   media test in the sandboxed renderer: loopback call carried video (${m.videoBytes} B, ${m.framesDecoded} frames) and audio (${m.audioBytes} B), ${media.packetsLost} packets lost`);
  if (exited) return fail('the app exited during the test'); console.log('PASS'); return finish(0);
}
module.exports = { parseStat, descendants, field };
if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
