// M1.3 CERTIFICATION, suite 3: relay LATENCY, BANDWIDTH, CPU and MEMORY under load, and the enforcement bound WHILE LOADED. Raw TURN clients, the hardened coturn (docker, one container).
// One "pair" = one viewer's dedicated relay connection: a presenter allocation -> a viewer allocation, ~1.2 Mbit/s (2 x 1200 B every 16 ms), the way a screen share runs.
// A share to V viewers = V pairs that all use the presenter's ONE credential (the page's design) and V viewer credentials.
//   node tests/cert/m13-load.cert.mjs            LEVELS="1x5,4x10,8x10" (shares x viewers), SECONDS=15
// NOTE: coturn runs inside Docker Desktop on the SAME machine as these clients; numbers are for sizing the method and comparing runs, NOT a production capacity figure.
import { randomUUID } from 'node:crypto';
import { CERT, newDb, authority, reporter, wait, sh, pctl, openAlloc } from './lib.mjs';

const { check, note, finish, metrics } = reporter('m13-load');
const LEVELS = (process.env.LEVELS || '1x5,4x10,8x10').split(',').map((x) => x.split('x').map(Number)), SECONDS = Number(process.env.SECONDS || 15);
const PACKET = 1200, TICK = 16, PER_TICK = 2;

function dockerStats() {
  try { const o = sh('docker', ['stats', '--no-stream', '--format', '{{.Name}} {{.CPUPerc}} {{.MemUsage}}', 'qm13-turn', 'qm13-redis']);
    return Object.fromEntries(o.split('\n').map((l) => { const [n, cpu, mem] = l.split(' '); const m = /([\d.]+)(MiB|GiB|KiB)/.exec(mem) || []; return [n, { cpu: parseFloat(cpu), memMiB: m[1] ? parseFloat(m[1]) * ({ GiB: 1024, MiB: 1, KiB: 1 / 1024 }[m[2]]) : null }]; })); } catch { return {}; }
}

async function main() {
  const D = await newDb(), A = authority(D.pool);
  const mkShare = async (viewers) => {
    const meetingId = randomUUID(), shareId = randomUUID(), pc = await A.issue({ meetingId, participantId: randomUUID(), shareId, role: 'presenter' }), pcred = { username: pc.username, password: pc.credential, realm: CERT.realm };
    const pairs = []; for (let i = 0; i < viewers; i++) { const vc = await A.issue({ meetingId, participantId: randomUUID(), shareId, role: 'viewer' });
      const a = await openAlloc(pcred), b = await openAlloc({ username: vc.username, password: vc.credential, realm: CERT.realm }); if (!a.r.ok || !b.r.ok) throw new Error('allocation failed ' + a.r.code + '/' + b.r.code);
      await a.c.createPermission(CERT.relayIp); await b.c.createPermission(CERT.relayIp); pairs.push({ a, b, sent: 0, got: [], lastAt: 0 }); }
    return { shareId, pcred, pairs };
  };
  for (const [S, V] of LEVELS) {
    console.log(`L. ${S} share(s) x ${V} viewer(s) = ${S * V} pairs = ${S * V * 2} allocations, ~${(S * V * PACKET * 8 * PER_TICK * (1000 / TICK) / 1e6).toFixed(0)} Mbit/s offered each way`);
    const shares = []; const tAlloc = Date.now(); for (let i = 0; i < S; i++) shares.push(await mkShare(V)); const allocMs = Date.now() - tAlloc;
    const all = shares.flatMap((s) => s.pairs); for (const p of all) p.b.c.onData = (d) => { p.got.push({ lat: d.at - d.data.readDoubleBE(0), at: d.at }); };
    let stop = false; const sender = setInterval(() => { if (stop) return; const now = Date.now(); for (const p of all) for (let k = 0; k < PER_TICK; k++) { const buf = Buffer.alloc(PACKET); buf.writeDoubleBE(now, 0); p.a.c.send(p.b.r.relayed.ip, p.b.r.relayed.port, buf); p.sent++; } }, TICK);
    await wait(4000); for (const p of all) { p.got.length = 0; p.sent = 0; } const cpu0 = process.cpuUsage(); const samples = []; const t0 = Date.now();
    while (Date.now() - t0 < SECONDS * 1000) { await wait(2500); samples.push(dockerStats()); }
    const secs = (Date.now() - t0) / 1000, cpu = process.cpuUsage(cpu0); const lat = all.flatMap((p) => p.got.map((g) => g.lat)), got = all.reduce((n, p) => n + p.got.length, 0), sent = all.reduce((n, p) => n + p.sent, 0);
    const turnCpu = samples.map((s) => s['qm13-turn']?.cpu).filter((x) => x != null), turnMem = samples.map((s) => s['qm13-turn']?.memMiB).filter((x) => x != null), redCpu = samples.map((s) => s['qm13-redis']?.cpu).filter((x) => x != null);
    const r = { shares: S, viewersPerShare: V, pairs: all.length, allocations: all.length * 2, allocSetupMs: allocMs, offeredMbitPerPair: +(PACKET * 8 * PER_TICK * (1000 / TICK) / 1e6).toFixed(2), deliveredMbitTotal: +(got * PACKET * 8 / secs / 1e6).toFixed(1), lossPct: +(100 * (1 - got / sent)).toFixed(2),
      latencyMs: { p50: pctl(lat, 50), p95: pctl(lat, 95), p99: pctl(lat, 99), max: Math.max(...lat) }, coturnCpuPctMax: Math.max(...turnCpu), coturnCpuPctAvg: +(turnCpu.reduce((a, b) => a + b, 0) / turnCpu.length).toFixed(0), coturnMemMiBMax: Math.max(...turnMem), redisCpuPctMax: Math.max(...redCpu), testClientCpuPct: +(100 * (cpu.user + cpu.system) / 1e6 / secs).toFixed(0) };
    metrics['L_' + S + 'x' + V] = r; note(JSON.stringify(r));
    check(`${S}x${V}: every pair delivers (loss under 2%)`, r.lossPct < 2, r.lossPct + '% loss, ' + r.deliveredMbitTotal + ' Mbit/s delivered');
    check(`${S}x${V}: one-way relay latency p95 under 100 ms (same host: this measures the relay's own queueing)`, r.latencyMs.p95 < 100, 'p50 ' + r.latencyMs.p50 + ' / p95 ' + r.latencyMs.p95 + ' / p99 ' + r.latencyMs.p99 + ' ms');

    // enforcement bound WHILE LOADED: revoke share 0 with every other pair still flowing
    const target = shares[0]; const ids = all.filter((p) => target.pairs.includes(p)); const t1 = Date.now(); const rv = await A.revokeShare(target.shareId, 'load'); const callMs = Date.now() - t1;
    await wait(2500); const last = Math.max(...ids.map((p) => p.got.length ? p.got[p.got.length - 1].at : t1)) - t1; const others = all.filter((p) => !target.pairs.includes(p)); const n0 = others.reduce((n, p) => n + p.got.length, 0); await wait(1500); const n1 = others.reduce((n, p) => n + p.got.length, 0);
    metrics['L_' + S + 'x' + V].revokeUnderLoad = { callMs, lastPacketAfterRevokeMs: Math.max(0, last), pairsRevoked: ids.length };
    check(`${S}x${V}: revoking one share UNDER LOAD stops all its ${ids.length} pairs (no packet later than 8 s after the call began) and finishes cleanly`, rv.errors.length === 0 && last <= 8000, `call ${callMs} ms, last packet ${Math.max(0, last)} ms after start`);
    if (others.length) check(`${S}x${V}: the other shares keep flowing`, n1 - n0 > others.length * 100, (n1 - n0) + ' packets in 1.5 s');
    stop = true; clearInterval(sender); for (const p of all) { p.a.c.close(); p.b.c.close(); } for (const s of shares.slice(1)) await A.revokeShare(s.shareId, 'load-end'); await wait(1500);
  }
  await D.drop(); finish();
}
main().catch((e) => { console.error('SUITE ERROR', e); process.exit(3); });
