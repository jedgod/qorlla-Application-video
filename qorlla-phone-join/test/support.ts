import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { verifyWorkloadToken, type ReplayStore } from '../src/gateway-auth.js';

export const keypair = () => { const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }); return { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string }; };
export const memoryReplay = (): ReplayStore & { seen: Set<string> } => { const seen = new Set<string>(); return { seen, firstUse: async (jti) => (seen.has(jti) ? false : (seen.add(jti), true)) }; };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Polls until the condition holds or the time runs out (never a fixed sleep that races a loaded machine). */
export const eventually = async (cond: () => boolean | Promise<boolean>, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(15); } return cond(); };
const servers = new Set<http.Server>();
/** Closes every server a test started, even when the test failed before it could close its own (so a failure never hangs the run). Register with test.after(closeAllServers). */
export const closeAllServers = async () => { await Promise.all([...servers].map((s) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }))); servers.clear(); };
export async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void>; server: http.Server }> {
  const server = http.createServer(app); servers.add(server); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, server, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

export const WEBHOOK_SECRET = 'meet-webhook-secret-for-tests-0123456789';
export const BRIDGE_SECRET = 'meet-bridge-secret-for-tests-0123456789-abcdef';
const MEETING_UUID = crypto.randomUUID(), SOURCE_ID = 'sched_12345';

/** A fake Meet that follows the real endpoints and rules (qorlla-meet-video/server: index.js, phone.mjs): signed webhooks with skew and idempotent event ids, bridge-secret call list, PIN and ban rules. */
export function fakeMeet(over: { number?: string; pin?: string; waitingRoom?: boolean; telephonyEnabled?: boolean } = {}) {
  const number = over.number ?? '12345678901', pin = over.pin ?? '12345678', uuid = MEETING_UUID;
  const calls = new Map<string, { id: string; providerCallId: string; status: string; from: string }>(), events = new Map<string, unknown>(), log: string[] = [], failures = new Map<string, number>();
  const state = { waitingRoom: over.waitingRoom ?? false, ended: false, telephonyEnabled: over.telephonyEnabled ?? true, resolveStatus: 0 as number };
  const app = express();
  const raw = express.raw({ type: '*/*', limit: '32kb' });
  const signedOk = (req: express.Request, body: Buffer) => {
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(req.get('x-qorlla-signature') || '')); if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
    const want = crypto.createHmac('sha256', WEBHOOK_SECRET).update(m[1] + '.' + body.toString('utf8')).digest('hex'); return crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(want));
  };
  app.get('/api/resolve/:code', (req, res) => { log.push('resolve'); if (state.resolveStatus) return void res.status(state.resolveStatus).json({}); return req.params.code === number && !state.ended ? res.json({ meetingId: uuid }) : res.status(404).json({ error: 'Meeting unavailable' }); });
  const signed = (handler: (j: any, res: express.Response) => unknown): express.RequestHandler => (req, res) => {
    if (!state.telephonyEnabled) return void res.status(503).json({ error: 'Telephony is not enabled' });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0); if (!signedOk(req, body)) { log.push('bad-signature'); return void res.status(401).json({ error: 'Invalid signature' }); }
    let j: any; try { j = JSON.parse(body.toString('utf8')); } catch { return void res.status(400).json({}); }
    if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(String(j.eventId || ''))) return void res.status(400).json({ error: 'eventId required' });
    if (events.has(j.eventId)) return void res.json({ ...(events.get(j.eventId) as object), duplicate: true });
    const out = handler(j, res) as object; events.set(j.eventId, out); res.json(out);
  };
  app.post('/api/phone/ivr/verify', raw, signed((j) => {
    log.push('verify:' + j.callId);
    if (j.meetingId !== number || !/^\+[1-9]\d{6,14}$/.test(String(j.from)) || state.ended) { failures.set(j.from, (failures.get(j.from) ?? 0) + 1); return { result: 'denied', say: 'We could not connect you to that meeting.' }; }
    if ((failures.get(j.from) ?? 0) >= 5) return { result: 'locked', say: 'We could not connect you to that meeting.' };
    if (j.pin !== pin) { failures.set(j.from, (failures.get(j.from) ?? 0) + 1); return { result: 'denied', say: 'We could not connect you to that meeting.' }; }
    for (const c of calls.values()) if (c.providerCallId === j.callId) return { result: 'denied', say: 'We could not connect you to that meeting.' };
    const call = { id: crypto.randomUUID(), providerCallId: String(j.callId), status: state.waitingRoom ? 'waiting' : 'connected', from: j.from }; calls.set(call.id, call);
    return state.waitingRoom ? { result: 'waiting', say: 'Please hold.', callRef: call.id } : { result: 'connected', say: 'You are connected to the meeting.', callRef: call.id };
  }));
  app.post('/api/phone/ivr/disconnect', raw, signed((j) => { log.push('disconnect:' + j.callId); const c = [...calls.values()].find((x) => x.providerCallId === String(j.callId)); if (!c) return { result: 'unknown' }; if (!['ended', 'removed', 'denied'].includes(c.status)) c.status = 'ended'; return { result: 'ended' }; }));
  app.get('/api/integrations/scheduled-meetings/:sourceId/phone-calls', (req, res) => {
    const given = String(req.get('x-qorlla-bridge-secret') || ''); if (given.length !== BRIDGE_SECRET.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(BRIDGE_SECRET))) return void res.status(401).json({ error: 'Bridge authentication required' });
    log.push('poll'); if (req.params.sourceId !== SOURCE_ID) return void res.status(404).json({ error: 'Not available' });
    res.json({ calls: [...calls.values()].map((c) => ({ id: c.id, status: c.status, name: 'Phone ••••' + c.from.slice(-4) })) });
  });
  return { app, uuid, sourceId: SOURCE_ID, number, pin, calls, log, state, failures, directory: { sourceIdFor: async (id: string) => (id === uuid ? SOURCE_ID : null) } };
}

/** A fake Shield following the real routes (qorlla-voice-engine/src/app.mjs, shield.mjs): ES256 workload token required (aud qorlla-shield, scope = a known subject), strict bodies, guest rules. */
export function fakeShield(gatewayPublicKeyPem: string, issuer: string) {
  const known = new Map<string, { guestEnabled: boolean; ended: boolean }>(), log: string[] = [], replay = memoryReplay();
  const state = { unreachable: false, revoke: new Map<string, string>() };
  const app = express(); app.use(express.json({ limit: '16kb' }));
  const auth: express.RequestHandler = async (req, res, next) => {
    if (state.unreachable) return void req.socket.destroy();
    try { await verifyWorkloadToken(String(req.get('authorization') || '').replace(/^Bearer /, ''), { keys: { [issuer]: { w1: gatewayPublicKeyPem } }, subjects: ['svc:meet'], audience: 'qorlla-shield', replay }, {}); next(); }
    catch (e) { log.push('auth-refused:' + (e as Error).message); res.status(401).json({ error: 'workload_required' }); }
  };
  const strict = (b: any, keys: string[]) => (b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).every((k) => keys.includes(k)) ? b : {});
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  app.post('/v1/shield/meet/authorize', auth, (req, res) => {
    const b = strict(req.body, ['meetingId', 'participantId', 'accountId', 'role', 'admission']); log.push('authorize:' + b.admission);
    if (!b.meetingId || !uuid.test(b.participantId) || !['host', 'guest'].includes(b.role) || typeof b.admission !== 'string') return void res.status(400).json({ error: 'invalid_input' });
    const m = known.get(b.meetingId), no = (reason: string) => res.status(403).json({ allow: false, reason });
    if (!m || m.ended) return void no('MEETING_UNKNOWN_OR_ENDED'); if (b.admission !== 'admitted') return void no('NOT_ADMITTED'); if (b.role === 'host') return void no('NOT_THE_HOST'); if (!m.guestEnabled) return void no('GUEST_NOT_ALLOWED');
    res.json({ allow: true, reason: 'ALLOW', kind: 'guest' });
  });
  app.post('/v1/shield/meet/recheck', auth, (req, res) => { const b = strict(req.body, ['participants']); log.push('recheck:' + (b.participants || []).length); res.json({ revoke: (b.participants || []).filter((p: any) => state.revoke.has(p.participantId)).map((p: any) => ({ meetingId: p.meetingId, participantId: p.participantId, reason: state.revoke.get(p.participantId) })) }); });
  app.post('/v1/shield/report', auth, (req, res) => { log.push('report:' + (req.body || {}).kind); res.json({ ok: true }); });
  return { app, known, log, state };
}
