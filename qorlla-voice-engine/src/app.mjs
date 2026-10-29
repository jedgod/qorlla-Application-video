// Qorlla Voice Engine: REST API, authenticated one-use-ticket WebSocket signaling, call notifications, maintenance. A factory, so tests (and the real server) build the same thing.
import http from 'node:http';
import express from 'express';
import helmet from 'helmet';
import { WebSocketServer, WebSocket } from 'ws';
import { bearer } from './auth.mjs';
import { validExtension, validCallId, validIdempotencyKey, validAccountId, safeSignal, cleanCandidate, iceServersFor, secretEquals, makeLimiter, ringSeconds, callSeconds } from './core.mjs';
import { issueTicket, consumeTicket, originAllowed, ticketFromRequest, PROTOCOL } from './tickets.mjs';
import { startMaintenance } from './maintenance.mjs';

const STATUS = { invalid_recipient: 404, not_found: 404, blocked: 403, forbidden: 403, caller_disabled: 403, voice_disabled: 403, invalid_origin: 403, busy: 409, invalid_transition: 409, idempotency_conflict: 409,
  extension_taken: 409, extensions_exhausted: 503, invalid_input: 400, too_many_tickets: 429, invalid_timeout: 400 };
const publicCall = (c) => ({ id: c.id, caller_id: c.caller_id, callee_id: c.callee_id, status: c.status, created_at: c.created_at, answered_at: c.answered_at, ended_at: c.ended_at, end_reason: c.end_reason || null });

export function createVoiceApp({ store, db, authenticate, env = process.env, maintenance = true, maintenanceMs = 5000 }) {
  const app = express(); app.disable('x-powered-by'); app.set('trust proxy', env.VOICE_TRUST_PROXY === '1' ? 1 : false);
  app.use(helmet()); app.use(express.json({ limit: '16kb' }));
  const allowed = () => env.VOICE_ALLOWED_ORIGIN || '';
  const sockets = new Map();
  const send = (account, payload) => { const msg = JSON.stringify(payload); for (const ws of sockets.get(account) || []) if (ws.readyState === WebSocket.OPEN) ws.send(msg); };
  const notifyState = (call) => { const p = { type: 'state', call: publicCall(call) }; send(call.caller_id, p); send(call.callee_id, p); };
  const closeAccount = (account, code = 4001, reason = 'account_changed') => { for (const ws of sockets.get(account) || []) { try { ws.close(code, reason); } catch { /* gone */ } } };
  const apiLimit = makeLimiter({ max: 240, windowMs: 60000 }), callLimit = makeLimiter({ max: 20, windowMs: 60000 }), ticketLimit = makeLimiter({ max: 30, windowMs: 60000 }), adminLimit = makeLimiter({ max: 120, windowMs: 60000 });

  // CORS: only the exact allowed browser origins may call the API from a page; everything else is refused at the preflight.
  app.use((req, res, next) => {
    const o = req.headers.origin, ok = !!o && originAllowed(o, allowed());
    if (ok) { res.set('Access-Control-Allow-Origin', o); res.set('Vary', 'Origin'); res.set('Access-Control-Allow-Headers', 'authorization, content-type'); res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS'); res.set('Access-Control-Max-Age', '600'); }
    if (req.method === 'OPTIONS') return res.status(ok ? 204 : 403).end();
    next();
  });
  const fail = (res, e) => { const status = STATUS[e.code] || STATUS[e.message] || 500; if (status === 500) console.error('voice error', e?.code || e?.message); res.status(status).json({ error: status === 500 ? 'internal_error' : (e.code || e.message) }); };
  const auth = async (req, res, next) => {
    try { const token = bearer(req); if (!token) return res.status(401).json({ error: 'unauthorized' }); req.account = await authenticate(token); } catch { return res.status(401).json({ error: 'unauthorized' }); }
    if (!apiLimit.take(req.account)) return res.status(429).json({ error: 'rate_limited' });
    next();
  };
  const adminAuth = (req, res, next) => {
    const secret = env.VOICE_ADMIN_SECRET; if (!secret || secret.length < 32) return res.status(503).json({ error: 'admin_disabled' });
    if (!adminLimit.take(req.ip || 'x')) return res.status(429).json({ error: 'rate_limited' });
    if (!secretEquals(req.get('x-voice-admin-secret') || '', secret)) return res.status(401).json({ error: 'unauthorized' });
    next();
  };

  app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'qorlla-voice', pstn: false }));
  app.get('/readyz', async (_req, res) => { try { await store.ping(); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); } });

  app.post('/v1/voice/ws-ticket', auth, async (req, res) => {
    try {
      const origin = req.headers.origin; if (!originAllowed(origin, allowed())) return res.status(403).json({ error: 'invalid_origin' });
      if (!ticketLimit.take(req.account)) return res.status(429).json({ error: 'rate_limited' });
      const profile = await store.identity(req.account); if (!profile?.enabled) return res.status(403).json({ error: 'voice_disabled' });
      res.set('Cache-Control', 'no-store').json(await issueTicket(req.account, origin, db, allowed()));
    } catch (e) { fail(res, Object.assign(e, { code: e.code || e.message })); }
  });
  app.get('/v1/voice/me', auth, async (req, res) => { try { res.json({ identity: await store.identity(req.account) }); } catch (e) { fail(res, e); } });
  app.get('/v1/voice/ice', auth, (req, res) => { try { const { iceServers } = iceServersFor(req.account, env); res.set('Cache-Control', 'no-store').json({ iceServers }); } catch (e) { fail(res, e); } });

  app.post('/v1/voice/calls', auth, async (req, res) => {
    const { extension, idempotencyKey } = req.body || {};
    if (!validExtension(extension) || !validIdempotencyKey(idempotencyKey)) return res.status(400).json({ error: 'invalid_input' });
    if (!callLimit.take(req.account)) return res.status(429).json({ error: 'rate_limited' });
    try {
      const result = await store.createCall(req.account, extension, idempotencyKey);
      if (!result.reused) { const me = await store.identity(req.account); send(result.call.callee_id, { type: 'incoming', call: publicCall(result.call), from: { extension: me?.extension || null } }); }
      res.status(result.reused ? 200 : 201).json({ call: publicCall(result.call), reused: result.reused });
    } catch (e) { fail(res, e); }
  });
  app.get('/v1/voice/calls', auth, async (req, res) => {
    try {
      const rows = await store.listCalls(req.account, Math.min(200, Number(req.query.limit) || 100));
      res.json({ calls: rows.map((c) => { const out = c.caller_id === req.account; return { id: c.id, direction: out ? 'outgoing' : 'incoming', status: c.status, peer_account_id: out ? c.callee_id : c.caller_id, peer_extension: out ? c.callee_extension : c.caller_extension,
        created_at: c.created_at, answered_at: c.answered_at, ended_at: c.ended_at, end_reason: c.end_reason, seconds: callSeconds(c) }; }) });
    } catch (e) { fail(res, e); }
  });
  app.get('/v1/voice/calls/live', auth, async (req, res) => { try { const c = await store.liveCall(req.account); res.set('Cache-Control', 'no-store').json({ call: c ? publicCall(c) : null }); } catch (e) { fail(res, e); } });
  app.post('/v1/voice/calls/:id/:action', auth, async (req, res) => {
    const { id, action } = req.params, mapping = { answer: 'active', reject: 'rejected', end: 'ended', fail: 'failed' };
    if (!validCallId(id) || !mapping[action]) return res.status(400).json({ error: 'invalid_input' });
    try { const call = await store.transition(id, req.account, mapping[action]); notifyState(call); res.json({ call: publicCall(call) }); } catch (e) { fail(res, e); }
  });

  app.get('/v1/voice/blocks', auth, async (req, res) => { try { res.json({ blocked: await store.listBlocks(req.account) }); } catch (e) { fail(res, e); } });
  app.post('/v1/voice/blocks', auth, async (req, res) => { const { extension } = req.body || {}; if (!validExtension(extension)) return res.status(400).json({ error: 'invalid_input' }); try { await store.addBlock(req.account, extension); res.status(201).json({ blocked: await store.listBlocks(req.account) }); } catch (e) { fail(res, e); } });
  app.delete('/v1/voice/blocks/:extension', auth, async (req, res) => { if (!validExtension(req.params.extension)) return res.status(400).json({ error: 'invalid_input' }); try { await store.removeBlock(req.account, req.params.extension); res.json({ blocked: await store.listBlocks(req.account) }); } catch (e) { fail(res, e); } });
  app.get('/v1/voice/usage', auth, async (req, res) => { try { res.json(await store.usage(req.account, Number(req.query.days) || 30)); } catch (e) { fail(res, e); } });
  // Diagnostics: state only. No secrets, tokens, SDP or call content.
  app.get('/v1/voice/diagnostics', auth, async (req, res) => {
    try {
      const me = await store.identity(req.account), ice = iceServersFor(req.account, env);
      res.set('Cache-Control', 'no-store').json({ identity: me ? { extension: me.extension, enabled: me.enabled } : null, signaling: { devicesConnected: (sockets.get(req.account) || new Set()).size, maxDevices: 3, queryTicket: String(env.VOICE_WS_QUERY_TICKET || 'on').toLowerCase() !== 'off' },
        ice: { stun: ice.stun, turn: ice.turn, note: ice.turn ? 'TURN relay is configured.' : 'No TURN relay is configured: calls work on the same network and between networks that allow direct UDP, but not behind strict firewalls.' },
        requestOriginAllowed: originAllowed(req.headers.origin, allowed()), ringSeconds: ringSeconds(env), pstn: false });
    } catch (e) { fail(res, e); }
  });

  // ---- trusted provisioning (server to server). Browsers never call these; the secret never leaves the main app's server.
  app.post('/v1/voice/admin/identities', adminAuth, async (req, res) => {
    const { accountId, extension } = req.body || {};
    if (!validAccountId(accountId) || (extension != null && !validExtension(extension))) return res.status(400).json({ error: 'invalid_input' });
    try { const r = await store.provisionIdentity(accountId, extension ?? null); res.status(r.created ? 201 : 200).json(r); } catch (e) { fail(res, e); }
  });
  app.get('/v1/voice/admin/identities', adminAuth, async (req, res) => {
    try { const ids = req.query.ids ? String(req.query.ids).split(',').slice(0, 500) : undefined; res.json({ identities: await store.listIdentities({ ids }) }); } catch (e) { fail(res, e); }
  });
  app.post('/v1/voice/admin/identities/:accountId/enabled', adminAuth, async (req, res) => {
    const enabled = (req.body || {}).enabled; if (!validAccountId(req.params.accountId) || typeof enabled !== 'boolean') return res.status(400).json({ error: 'invalid_input' });
    try { const r = await store.setEnabled(req.params.accountId, enabled); for (const c of r.ended) notifyState(c); if (!enabled) closeAccount(req.params.accountId, 4003, 'voice_disabled'); res.json({ identity: r.identity, endedCalls: r.ended.length }); } catch (e) { fail(res, e); }
  });

  // body-parser problems (too large, not JSON) get a short JSON answer, never a stack trace
  app.use((err, _req, res, next) => { if (res.headersSent) return next(err); if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' }); if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) return res.status(400).json({ error: 'invalid_json' }); console.error('voice error', err?.message); res.status(500).json({ error: 'internal_error' }); });

  // ---- WebSocket signaling
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 70000, perMessageDeflate: false, handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false) });
  server.on('upgrade', async (req, socket, head) => {
    try {
      if (new URL(req.url, 'http://localhost').pathname !== '/v1/voice/ws') throw Error('route');
      const origin = req.headers.origin; if (!originAllowed(origin, allowed())) throw Error('origin');
      const { token } = ticketFromRequest(req, env), account = await consumeTicket(token, origin, db, allowed());     // consumed atomically: a replay, a stale or a foreign-origin ticket all fail
      if (!account) throw Error('invalid_ticket');
      const profile = await store.identity(account); if (!profile?.enabled) throw Error('disabled');
      wss.handleUpgrade(req, socket, head, (ws) => { ws.account = account; ws.extension = profile.extension; wss.emit('connection', ws, req); });
    } catch { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); }
  });
  wss.on('connection', (ws) => {
    const account = ws.account, group = sockets.get(account) || new Set();
    if (group.size >= 3) { ws.close(1008, 'connection_limit'); return; }
    group.add(ws); sockets.set(account, group); ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
    let tokens = 50; const refill = setInterval(() => { tokens = 50; }, 10000); refill.unref?.();
    ws.send(JSON.stringify({ type: 'ready', extension: ws.extension }));
    ws.on('message', async (raw) => {
      try {
        if (--tokens < 0) { ws.close(1008, 'rate_limit'); return; }
        const msg = JSON.parse(raw.toString()); if (!safeSignal(msg)) return;
        const call = await store.getCall(msg.callId); if (!call || ![call.caller_id, call.callee_id].includes(account)) return;
        if (call.status !== 'active') return;                                          // never relay SDP or ICE before the callee has answered, or after the call ended
        if (msg.type === 'offer' && account !== call.caller_id) return;                // the caller offers, the callee answers
        if (msg.type === 'answer' && account !== call.callee_id) return;
        const other = call.caller_id === account ? call.callee_id : call.caller_id;
        send(other, { type: msg.type, callId: msg.callId, ...(msg.type === 'ice' ? { candidate: cleanCandidate(msg.candidate) } : { sdp: msg.sdp }) });
      } catch { /* malformed input is dropped, never echoed */ }
    });
    ws.on('close', () => { clearInterval(refill); group.delete(ws); if (!group.size) sockets.delete(account); });
  });
  const heartbeat = setInterval(() => { for (const ws of wss.clients) { if (ws.isAlive === false) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch { /* gone */ } } }, 30000); heartbeat.unref?.();
  const maint = maintenance ? startMaintenance({ store, db, onExpired: notifyState, intervalMs: maintenanceMs, ringSeconds: ringSeconds(env) }) : null;

  return {
    app, server, wss, sockets, send, notifyState, maint,
    listen: (port = 0, host) => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: async () => { maint?.stop(); clearInterval(heartbeat); for (const ws of wss.clients) ws.close(1001); await new Promise((r) => server.close(() => r())); }
  };
}
