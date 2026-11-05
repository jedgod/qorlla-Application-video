// The A4/A5 telephone gateway as a SEPARATE PROCESS, for the isolated end-to-end environment (Meet + Chromium + synthetic SIP phone).
//   - it reaches Meet only through Meet's own authorization: the verify route (PIN, host, Shield), the media token, and the restricted verification credential (never a pre-made participant token);
//   - its meeting side is the real WebRTC mesh peer (werift, DTLS-SRTP, PCMU); its telephone side is the real SIP ingress + SRTP leg;
//   - the call ledger is PostgreSQL;
//   - READINESS: the six readiness conditions need a real carrier, gateway certification etc. and are NOT true anywhere. This runner has a LAB-ONLY stub (A5_LAB_READINESS=1) that says "ready" so a synthetic call can be exercised
//     in an isolated test; it is refused unless that variable is set, binds only to loopback, and proves nothing about production readiness.
// Configuration comes from the environment (secrets are never printed). On start it prints one JSON line {"ready":true,"sipPort":...}.
import crypto from 'node:crypto';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dist = path.join(import.meta.dirname, '..', 'dist', 'src');
const imp = (f) => import(pathToFileURL(path.join(dist, f)).href);
const [{ createSipGateway }, { MeetPhoneAuthority }, { MeshPeerAudio }, { verificationPeerSignaling }, { PostgresCallLedger }, { terminateCall, startReaper, startLeaseKeeper }, { startMediaKeepAlive }, { ha1 }] = await Promise.all(
  ['sip-gateway.js', 'meet-authority.js', 'media/mesh-peer.js', 'media/meet-signaling.js', 'ledger-pg.js', 'compose.js', 'meet-media.js', 'sip/digest.js'].map(imp));
const need = (k) => { const v = process.env[k]; if (!v) { console.error('missing ' + k); process.exit(2); } return v; };
if (process.env.A5_LAB_READINESS !== '1') { console.error('refusing to start: this runner uses a lab-only readiness stub and needs A5_LAB_READINESS=1'); process.exit(2); }
const MEET = need('MEET_URL'), HMAC = need('MEET_HMAC_SECRET'), USER = need('SIP_USER'), PASS = need('SIP_PASSWORD'), DB = need('GATEWAY_DATABASE_URL'), SCHEMA = need('GATEWAY_PG_SCHEMA');
const [lo, hi] = (process.env.RTP_RANGE || '33000-33200').split('-').map(Number);
const pool = new pg.Pool({ connectionString: DB, options: '-c search_path=' + SCHEMA, max: 6 }), admin = new pg.Pool({ connectionString: DB });
await admin.query('CREATE SCHEMA IF NOT EXISTS ' + SCHEMA); const c = await admin.connect(); try { await c.query('SET search_path=' + SCHEMA); for (const f of ['001_phone_join.sql', '002_phone_join_lease.sql']) await c.query(fs.readFileSync(path.join(import.meta.dirname, '..', 'sql', f), 'utf8')); } finally { c.release(); }
const authority = new MeetPhoneAuthority({ baseUrl: MEET, auth: { kind: 'hmac', secret: HMAC }, requestTimeoutMs: 8000, decisionWaitMs: 8000, pollMs: 300 });
const sessions = new Map();                                                                                        // call id -> Meet session id (for terminateCall)
const wrapped = { verifyPhoneJoin: async (m, p, o) => { const d = await authority.verifyPhoneJoin(m, p, o); if (d.meetingSessionId && o?.callId) sessions.set(o.callId, d.meetingSessionId); return d; },
  requestHostApproval: (s, id, o) => authority.requestHostApproval(s, id, o), cancelAdmission: (s, id) => authority.cancelAdmission(s, id) };
const ledger = new PostgresCallLedger(pool, 'a5-gateway-' + process.pid, { lease: { leaseMs: Number(process.env.A5_LEASE_MS || 15000), graceMs: Number(process.env.A5_LEASE_GRACE_MS || 15000) } });
const READY = { carrierConnected: true, inboundNumberCertified: true, gatewayHealthy: true, mediaBridgeCertified: true, billingCertified: true, productionApproved: true };   // LAB ONLY (see above)
// Lab observability only: with A5_LOG set, every signalling message the gateway peer sends or receives is logged (type and the first 8 characters of the peer id; never an SDP or a credential).
const traced = (factory) => async (a) => { const port = await factory(a); if (!process.env.A5_LOG) return port; const note = (o) => console.error(JSON.stringify({ sig: o, t: Date.now() })); const onSignal = port.onSignal.bind(port), send = port.send.bind(port);
  port.onSignal = (cb) => onSignal((from, d) => { note({ in: d && d.type, from: String(from).slice(0, 8) }); cb(from, d); }); port.send = (to, d) => { note({ out: d && d.type, to: String(to).slice(0, 8) }); send(to, d); }; return port; };
// Lab observability only (with A5_LOG): a ledger operation that fails or is slow is logged with its duration and error, so a 503 can be told apart (claim vs. Meet request vs. media).
if (process.env.A5_LOG) for (const m of ['claim', 'transition']) { const f = ledger[m].bind(ledger); ledger[m] = async (...a) => { const t = Date.now(); try { const r = await f(...a); if (Date.now() - t > 1000) console.error(JSON.stringify({ ledgerSlow: m, ms: Date.now() - t })); return r; } catch (e) { console.error(JSON.stringify({ ledgerError: m, ms: Date.now() - t, error: String(e && e.message) })); throw e; } }; }
// Lab observability only (with A5_LOG): is the GATEWAY PROCESS starved (event-loop lag) or is the DATABASE slow (round trip of SELECT 1 on a separate connection)? Both are sampled with a monotonic clock; stats are printed when something exceeds 300 ms and at exit.
const probe = { maxLag: 0, maxDb: 0, lagOver: 0, dbOver: 0, samples: 0 };
if (process.env.A5_LOG) { let last = performance.now(); const lag = setInterval(() => { const n = performance.now(), l = n - last - 200; last = n; probe.samples++; if (l > probe.maxLag) probe.maxLag = l; if (l > 300) { probe.lagOver++; console.error(JSON.stringify({ loopLagMs: Math.round(l) })); } }, 200); lag.unref(); const db = setInterval(async () => { const t = performance.now(); try { await admin.query('SELECT 1'); } catch { return; } const d = performance.now() - t; if (d > probe.maxDb) probe.maxDb = d; if (d > 300) { probe.dbOver++; console.error(JSON.stringify({ dbProbeMs: Math.round(d) })); } }, 1000); db.unref(); }
// Lab observability only (with A5_LOG): how long a ledger operation waits to ACQUIRE a pooled connection (a new connection includes TCP + authentication) versus how long it then spends in SQL.
if (process.env.A5_LOG) { const connect = pool.connect.bind(pool); pool.connect = async (...a) => { const t = performance.now(); const c = await connect(...a); const ms = performance.now() - t; if (ms > 300) console.error(JSON.stringify({ acquireMs: Math.round(ms), waiting: pool.waitingCount, total: pool.totalCount })); return c; }; }
let gw; const terminate = async (callId, reason) => { await terminateCall({ bridge: gw.bridge, authority: wrapped, ledger })({ callId, meetingSessionId: sessions.get(callId) ?? '' }, reason).catch(() => undefined); };
gw = createSipGateway({ enabled: true, labMode: true, sip: { host: '127.0.0.1', port: Number(process.env.SIP_PORT || 0), realm: 'qorlla-a5', allowedSources: ['127.0.0.1'], maxCalls: 8, t1Ms: 100, t2Ms: 800 },
  digest: { secret: crypto.randomBytes(32), ha1ByUser: { [USER]: ha1('SHA-256', USER, 'qorlla-a5', PASS) } }, media: { bindHost: '127.0.0.1', publicHost: '127.0.0.1', portRange: [lo, hi], inactivityMs: 8000 } },
  { authority: wrapped, reporter: authority, meeting: new MeshPeerAudio({ signaling: traced(verificationPeerSignaling({ baseUrl: MEET, authority })) }), readiness: async () => READY, ledger, onEnded: async (callId, reason, phase) => { if (phase !== 'ivr') await terminate(callId, reason); }, log: (l) => { if (process.env.A5_LOG) console.error(JSON.stringify(l)); } });
// LAB ONLY isolation switches for the A5.2 gateway-deadline scenario: A5_NO_KEEPALIVE stops the evidence reports to Meet (so Meet cannot end the call first); A5_RECOVER_WITHIN_MS relaxes the gateway's own media watchdog (5 s in production, reason media_interrupted) so the layer under test, the mesh peer's recovery deadline, is the only thing left that can end the leg.
if (process.env.A5_RECOVER_WITHIN_MS) gw.gateway.o.recoverWithinMs = Number(process.env.A5_RECOVER_WITHIN_MS);
const keep = process.env.A5_NO_KEEPALIVE ? { stop() {} } : startMediaKeepAlive({ legs: gw.bridge.legs, measure: async (id) => gw.gateway.measure(id), meet: authority, terminate: (id, r) => gw.gateway.stop(id, r), peerJti: (id) => gw.gateway.peerJti(id), intervalMs: 2000 });
// Ownership: this gateway renews the leases of the calls it owns and stops a leg it no longer owns. Crash recovery for claims a DEAD gateway left behind (any replica may reap, per-state deadlines, challenge then grace): optional, A5_REAPER=1.
const log = { error: (m) => console.error(String(m)) }, lease = startLeaseKeeper({ ledger, bridge: gw.bridge, intervalMs: Math.max(200, Number(process.env.A5_LEASE_MS || 15000) / 3), log });
const reaper = process.env.A5_REAPER ? startReaper({ ledger, bridge: gw.bridge, authority: wrapped, intervalMs: 1000, log }) : null;
const addr = await gw.start(); console.log(JSON.stringify({ ready: true, sipPort: addr.port, pid: process.pid }));
const quit = async () => { if (process.env.A5_LOG) console.error(JSON.stringify({ labProbe: { ...probe, maxLag: Math.round(probe.maxLag), maxDb: Math.round(probe.maxDb) } })); keep.stop(); lease.stop(); reaper?.stop(); await gw.stop().catch(() => undefined); await pool.end().catch(() => undefined); await admin.end().catch(() => undefined); process.exit(0); };
process.on('SIGTERM', quit); process.on('SIGINT', quit); process.stdin.resume();
