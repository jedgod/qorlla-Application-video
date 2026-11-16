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
const MEETING_UUID = crypto.randomUUID();
const b64 = (b: Buffer) => b.toString('base64url');

/**
 * A fake Meet that gives the SAME answers as the real one after the telephone lifecycle change (qorlla-meet-video/server/phone.mjs, v4.24): verify -> approved | waiting | denied | locked, never connected;
 * a one-time media token; a durable decision (long-poll or status); a media report judged by Meet itself; a disconnect. Authentication is Meet's two schemes (provider HMAC, gateway workload token).
 * The package is ALSO tested against the real Meet server (test/real-meet.e2e.test.ts); this double exists for the failures a real server cannot be made to produce on demand.
 */
export function fakeMeet(over: { number?: string; pin?: string; waitingRoom?: boolean; gatewayKey?: string } = {}) {
  const number = over.number ?? '12345678901', pin = over.pin ?? '12345678', uuid = MEETING_UUID;
  type Call = { id: string; callId: string; state: string; token: string; tokenIssued: boolean; from: string };
  const calls = new Map<string, Call>(), events = new Map<string, unknown>(), log: string[] = [], failures = new Map<string, number>(), replay = memoryReplay(), reports: any[] = [];
  const state = { waitingRoom: over.waitingRoom ?? false, telephonyEnabled: true, legacyConnected: false, omitMeetingId: false, terminateMedia: false, openLongPolls: 0 };
  const app = express(); const raw = express.raw({ type: '*/*', limit: '32kb' });
  const authed = async (req: express.Request, body: Buffer | null) => {
    const bearer = String(req.get('authorization') || '');
    if (bearer.startsWith('Bearer ')) {
      if (!over.gatewayKey) return false;
      try { await verifyWorkloadToken(bearer.slice(7), { keys: { 'qorlla-gateway': { w1: over.gatewayKey } }, subjects: ['svc:phone-gateway'], audience: 'qorlla-phone-gateway', replay }, { bodySha256: body ? b64(crypto.createHash('sha256').update(body).digest()) : null }); return true; } catch { return false; }
    }
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(req.get('x-qorlla-signature') || '')); if (!m || !body || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
    const want = crypto.createHmac('sha256', WEBHOOK_SECRET).update(m[1] + '.' + body.toString('utf8')).digest('hex'); return crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(want));
  };
  const post = (path: string, handler: (j: any) => unknown, o: { event?: boolean } = { event: true }) => app.post(path, raw, async (req, res) => {
    if (!state.telephonyEnabled) return void res.status(503).json({ error: 'Telephony is not enabled' });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0); if (!(await authed(req, body))) { log.push('bad-auth'); return void res.status(401).json({ error: 'Gateway authentication failed' }); }
    let j: any; try { j = JSON.parse(body.toString('utf8')); } catch { return void res.status(400).json({}); }
    if (o.event !== false) { if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(String(j.eventId || ''))) return void res.status(400).json({ error: 'eventId required' }); if (events.has(j.eventId)) return void res.json({ ...(events.get(j.eventId) as object), duplicate: true }); }
    const out = handler(j) as object; if (o.event !== false) events.set(j.eventId, out); res.json(out);
  });
  const byCallId = (id: string) => [...calls.values()].find((c) => c.callId === id);
  const decisionOf = (c: Call) => {
    const d = ['AWAITING_HOST', 'VERIFIED'].includes(c.state) ? 'pending' : ['APPROVED', 'MEDIA_CONNECTING', 'MEDIA_CONNECTED'].includes(c.state) ? 'approved' : c.state === 'REFUSED' ? 'refused' : c.state === 'TIMED_OUT' ? 'timed_out' : c.state === 'CANCELLED' ? 'cancelled' : 'ended';
    const out: any = { callRef: c.id, state: c.state, decision: d }; if (d === 'approved' && c.state === 'APPROVED' && !c.tokenIssued) { c.tokenIssued = true; out.mediaToken = c.token; } return out;
  };
  post('/api/phone/ivr/verify', (j) => {
    log.push('verify:' + j.callId); const no = { result: 'denied', say: 'We could not connect you to that meeting.' };
    if (j.meetingId !== number || !/^\+[1-9]\d{6,14}$/.test(String(j.from))) { failures.set(j.from, (failures.get(j.from) ?? 0) + 1); return no; }
    if ((failures.get(j.from) ?? 0) >= 5) return { result: 'locked', say: no.say };
    if (j.pin !== pin) { failures.set(j.from, (failures.get(j.from) ?? 0) + 1); return no; }
    if (byCallId(j.callId)) return no;
    const c: Call = { id: crypto.randomUUID(), callId: String(j.callId), state: state.waitingRoom ? 'AWAITING_HOST' : 'APPROVED', token: crypto.randomBytes(24).toString('base64url'), tokenIssued: !state.waitingRoom, from: j.from }; calls.set(c.id, c);
    const meetingId = state.omitMeetingId ? undefined : uuid;
    if (state.legacyConnected) return { result: 'connected', say: 'You are connected to the meeting.', callRef: c.id, meetingId };
    return state.waitingRoom ? { result: 'waiting', say: 'Please hold.', callRef: c.id, meetingId } : { result: 'approved', say: 'Connecting you to the meeting.', callRef: c.id, meetingId, mediaToken: c.token };
  });
  post('/api/phone/ivr/status', (j) => { const c = byCallId(String(j.callId)); return c ? { result: 'ok', ...decisionOf(c) } : { result: 'unknown' }; }, { event: false });
  app.get('/api/phone/ivr/calls/:ref/decision', async (req, res) => {
    if (!(await authed(req, null))) return void res.status(401).json({ error: 'Gateway authentication failed' });
    const c = calls.get(req.params.ref); if (!c) return void res.status(404).json({}); log.push('decision-poll'); state.openLongPolls++;
    let closed = false; req.on('close', () => { closed = true; }); const until = Date.now() + Math.min(20000, Number(req.query.waitMs) || 0);
    try { while (!closed && Date.now() < until && ['AWAITING_HOST', 'VERIFIED'].includes(c.state)) await sleep(20); } finally { state.openLongPolls--; }
    if (closed) { log.push('decision-poll-aborted'); return; } res.json(decisionOf(c));
  });
  post('/api/phone/ivr/media', (j) => {
    reports.push(j); const c = byCallId(String(j.callId)); if (!c) return { result: 'unknown', action: 'terminate' };
    if (['REFUSED', 'TIMED_OUT', 'CANCELLED', 'TERMINATED', 'ORPHANED'].includes(c.state)) return { result: 'terminate', action: 'terminate', state: c.state };
    if (j.mediaToken !== c.token || !c.tokenIssued) return { result: 'denied', action: 'none' };
    if (state.terminateMedia) { c.state = 'REFUSED'; return { result: 'terminate', action: 'terminate', state: 'REFUSED' }; }
    const e = j.evidence; const ok = !!e && e.state === 'audio_flowing' && e.inboundPackets >= 25 && e.outboundPackets >= 25 && e.observedMs >= 500 && e.encrypted === true && ['opus', 'PCMU', 'PCMA'].includes(e.codec) && Date.now() - e.measuredAt <= 5000 && e.source !== 'synthetic';
    if (!ok) { if (c.state === 'APPROVED') c.state = 'MEDIA_CONNECTING'; return { result: 'connecting', action: 'none' }; }
    const refreshed = c.state === 'MEDIA_CONNECTED'; c.state = 'MEDIA_CONNECTED'; return { result: 'connected', action: 'none', ...(refreshed ? { refreshed: true } : {}) };
  });
  post('/api/phone/ivr/disconnect', (j) => { log.push('disconnect:' + j.callId); const c = byCallId(String(j.callId)); if (!c) return { result: 'unknown' }; if (!['REFUSED', 'TIMED_OUT', 'TERMINATED'].includes(c.state)) c.state = c.state === 'MEDIA_CONNECTED' ? 'TERMINATED' : 'CANCELLED'; return { result: 'ended' }; });
  post('/api/phone/ivr/gateway-health', (j) => { log.push('heartbeat:' + j.instance); return { result: 'ok' }; }, { event: false });
  return { app, uuid, number, pin, calls, log, state, failures, reports, host: (callId: string, to: 'APPROVED' | 'REFUSED' | 'TIMED_OUT') => { byCallId(callId)!.state = to; } };
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
