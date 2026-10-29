// Qorlla Voice Engine: REST API, authenticated one-use-ticket WebSocket signaling, durable call/room events (outbox + replay), device fencing, group rooms, maintenance.
// A factory, so tests (and the real server) build the same thing. PostgreSQL is authoritative; Redis (optional) only carries delivery between replicas.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';
import { bearer } from './auth.mjs';
import { validExtension, validCallId, validIdempotencyKey, validAccountId, safeSignal, cleanCandidate, iceServersFor, secretEquals, makeLimiter, ringSeconds, callSeconds, publicCall } from './core.mjs';
import { issueTicket, consumeTicketFull, originAllowed, ticketFromRequest, PROTOCOL } from './tickets.mjs';
import { startMaintenance } from './maintenance.mjs';
import { createReliability, safeCursor } from './reliability.mjs';
import { OutboxWorker } from './outbox.mjs';
import { RedisBus } from './bus.mjs';
import { VoiceRouter } from './router.mjs';
import { validRoomId } from './rooms.mjs';
import { createHistory, parseRetentionDays } from './history.mjs';

const STATUS = { invalid_recipient: 404, not_found: 404, blocked: 403, forbidden: 403, caller_disabled: 403, voice_disabled: 403, invalid_origin: 403, busy: 409, invalid_transition: 409, idempotency_conflict: 409,
  extension_taken: 409, extensions_exhausted: 503, invalid_input: 400, too_many_tickets: 429, invalid_timeout: 400, overloaded: 503, device_not_owner: 409, lease_lost: 409, call_not_active: 409, room_full: 409,
  room_exists: 409, already_joined: 409, call_in_progress: 409, turn_not_configured: 503, invalid_cursor: 400, replay_unavailable: 503 };
const GSIGNALS = ['g_offer', 'g_answer', 'g_ice'];
const validGen = (g) => Number.isSafeInteger(g) && g >= 1;

export function createVoiceApp({ store, db, authenticate, env = process.env, maintenance = true, maintenanceMs = 5000, bus: busOption, outbox = true, instanceId = randomUUID() }) {
  const app = express(); app.disable('x-powered-by'); app.set('trust proxy', env.VOICE_TRUST_PROXY === '1' ? 1 : false);
  app.use(helmet()); app.use(express.json({ limit: '16kb' }));
  const allowed = () => env.VOICE_ALLOWED_ORIGIN || '';
  const reliability = createReliability(db), history = createHistory({ db, tx: store.tx }), retention = parseRetentionDays(env.VOICE_HISTORY_RETENTION_DAYS);
  if (retention.warning) console.warn('voice: ' + retention.warning);
  const router = new VoiceRouter();
  const bus = busOption !== undefined ? busOption : (env.REDIS_URL ? new RedisBus({ url: env.REDIS_URL, instanceId, onDelivery: (m) => router.onRemote(m) }) : null);
  if (bus) { router.bus = bus; if (!bus.onDelivery) bus.onDelivery = (m) => router.onRemote(m); }
  const worker = outbox ? new OutboxWorker({ db, workerId: instanceId, publish: (account, msg) => router.deliverDurable(account, msg), intervalMs: Number(env.VOICE_OUTBOX_INTERVAL_MS || 500) }) : null;
  const kick = () => worker?.kick();
  const sockets = router.sockets, send = (account, payload, device) => router.send(account, payload, device);
  const closeAccount = (account, code = 4001, reason = 'account_changed') => router.send(account, { type: '__close', code, reason });
  const num = (v, d) => { const x = Number(v); return Number.isInteger(x) && x > 0 ? x : d; };
  const apiLimit = makeLimiter({ max: num(env.VOICE_API_RATE_PER_MIN, 240), windowMs: 60000 }), callLimit = makeLimiter({ max: num(env.VOICE_CALL_RATE_PER_MIN, 20), windowMs: 60000 }), ticketLimit = makeLimiter({ max: 30, windowMs: 60000 }), adminLimit = makeLimiter({ max: num(env.VOICE_ADMIN_RATE_PER_MIN, 120), windowMs: 60000 });

  // Backpressure (DR-07): when the outbox is far behind, new calls and rooms are refused (fail closed) instead of piling up more undelivered work.
  const MAX_PENDING = Number(env.VOICE_OUTBOX_MAX_PENDING || 5000), MAX_AGE = Number(env.VOICE_OUTBOX_MAX_AGE_SECONDS || 300);
  let qcache = { at: 0, v: { pending: 0, oldestSeconds: 0, maxAttempts: 0 } };
  const queue = async () => { if (Date.now() - qcache.at > 1000) qcache = { at: Date.now(), v: await reliability.queueStats() }; return qcache.v; };
  const guardCapacity = async (res) => { const q = await queue(); if (q.pending > MAX_PENDING || q.oldestSeconds > MAX_AGE) { res.set('Retry-After', '10').status(503).json({ error: 'overloaded' }); return false; } return true; };

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
    // A metrics scraper (Prometheus) can only send an Authorization header, so GET .../admin/metrics also accepts "Bearer <admin secret>". No other admin route does.
    const given = req.get('x-voice-admin-secret') || (req.method === 'GET' && req.path === '/v1/voice/admin/metrics' ? (req.get('authorization') || '').replace(/^Bearer\s+/i, '') : '');
    if (!secretEquals(given, secret)) return res.status(401).json({ error: 'unauthorized' });
    next();
  };
  const route = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { fail(res, e); } };

  app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'qorlla-voice', pstn: false, instance: instanceId }));
  // Readiness is about the database (the source of truth). A Redis outage is reported as degraded but does not stop the node: calls on this node keep working and the outbox retries delivery to the others.
  app.get('/readyz', async (_req, res) => { try { await store.ping(); res.json({ ok: true, redis: bus ? (bus.up ? 'up' : 'down') : 'off', degraded: bus && !bus.up ? ['redis'] : [] }); } catch { res.status(503).json({ ok: false }); } });

  // Strict readiness for load balancers deciding where NEW calls may go (v1.8/1.9): the database must answer, Redis must be up when it is configured, and the oldest undelivered event must be recent.
  // /readyz above stays lenient on purpose (a Redis outage must not take a node out of service for the calls it already holds).
  const READY_LAG = Number(env.VOICE_READY_MAX_LAG_SECONDS || 60);
  app.get('/v1/voice/operational/readiness', async (_req, res) => {
    try { await store.ping(); const q = await reliability.queueStats(), redis = bus ? (bus.up ? 'up' : 'down') : 'off', ready = redis !== 'down' && q.oldestSeconds < READY_LAG;
      res.status(ready ? 200 : 503).set('Cache-Control', 'no-store').json({ ready, db: true, redis, outbox: { pending: q.pending, oldestSeconds: q.oldestSeconds }, maxLagSeconds: READY_LAG, instance: instanceId });
    } catch { res.status(503).json({ ready: false, db: false }); }
  });

  app.post('/v1/voice/ws-ticket', auth, route(async (req, res) => {
    const origin = req.headers.origin; if (!originAllowed(origin, allowed())) return res.status(403).json({ error: 'invalid_origin' });
    if (!ticketLimit.take(req.account)) return res.status(429).json({ error: 'rate_limited' });
    const deviceId = (req.body || {}).deviceId; if (!store.validDevice(deviceId)) return res.status(400).json({ error: 'invalid_input' });
    const profile = await store.identity(req.account); if (!profile?.enabled) return res.status(403).json({ error: 'voice_disabled' });
    try { res.set('Cache-Control', 'no-store').json(await issueTicket(req.account, origin, db, allowed(), deviceId)); } catch (e) { fail(res, Object.assign(e, { code: e.code || e.message })); }
  }));
  app.get('/v1/voice/me', auth, route(async (req, res) => { res.json({ identity: await store.identity(req.account) }); }));
  app.get('/v1/voice/ice', auth, route(async (req, res) => { const { iceServers, iceTransportPolicy } = iceServersFor(req.account, env); res.set('Cache-Control', 'no-store').json({ iceServers, iceTransportPolicy, expiresIn: 600 }); }));

  // ---- one-to-one calls
  app.post('/v1/voice/calls', auth, route(async (req, res) => {
    const { extension, idempotencyKey, deviceId } = req.body || {};
    if (!validExtension(extension) || !validIdempotencyKey(idempotencyKey) || !store.validDevice(deviceId)) return res.status(400).json({ error: 'invalid_input' });
    if (!callLimit.take(req.account)) return res.status(429).json({ error: 'rate_limited' });
    if (!(await guardCapacity(res))) return;
    const result = await store.createCall(req.account, extension, idempotencyKey, deviceId); kick();
    res.status(result.reused ? 200 : 201).json({ call: publicCall(result.call), reused: result.reused, generation: result.lease ? Number(result.lease.generation) : null });
  }));
  app.get('/v1/voice/calls', auth, route(async (req, res) => {
    const rows = await store.listCalls(req.account, Math.min(200, Number(req.query.limit) || 100));
    res.json({ calls: rows.map((c) => { const out = c.caller_id === req.account; return { id: c.id, direction: out ? 'outgoing' : 'incoming', status: c.status, peer_account_id: out ? c.callee_id : c.caller_id, peer_extension: out ? c.callee_extension : c.caller_extension,
      created_at: c.created_at, answered_at: c.answered_at, ended_at: c.ended_at, end_reason: c.end_reason, seconds: callSeconds(c) }; }) });
  }));
  app.get('/v1/voice/calls/live', auth, route(async (req, res) => {
    const c = await store.liveCall(req.account); if (!c) return res.set('Cache-Control', 'no-store').json({ call: null });
    const ctx = await store.signalContext(c.id), mine = ctx?.leases[req.account], peer = c.caller_id === req.account ? c.callee_id : c.caller_id;
    res.set('Cache-Control', 'no-store').json({ call: publicCall(c), role: c.caller_id === req.account ? 'caller' : 'callee', peer_extension: (await store.identity(peer))?.extension || null, lease: mine ? { device_id: mine.device_id, generation: mine.generation, valid: mine.valid } : null });
  }));
  app.post('/v1/voice/calls/:id/device', auth, route(async (req, res) => {
    const { deviceId } = req.body || {}; if (!validCallId(req.params.id) || !store.validDevice(deviceId)) return res.status(400).json({ error: 'invalid_input' });
    const r = await store.claimDevice(req.params.id, req.account, deviceId); kick();
    res.set('Cache-Control', 'no-store').json({ generation: r.lease.generation, expiresIn: 90, call: publicCall(r.call) });
  }));
  app.post('/v1/voice/calls/:id/device/refresh', auth, route(async (req, res) => {
    const { deviceId, generation } = req.body || {}; if (!validCallId(req.params.id) || !store.validDevice(deviceId) || !validGen(generation)) return res.status(400).json({ error: 'invalid_input' });
    if (!(await store.refreshLease(req.params.id, req.account, deviceId, generation))) return res.status(409).json({ error: 'lease_lost' });
    res.json({ ok: true, expiresIn: 90 });
  }));
  app.post('/v1/voice/calls/:id/:action', auth, route(async (req, res) => {
    const { id, action } = req.params, mapping = { answer: 'active', reject: 'rejected', end: 'ended', fail: 'failed' }, body = req.body || {};
    if (!validCallId(id) || !mapping[action]) return res.status(400).json({ error: 'invalid_input' });
    const opts = {};
    if (action === 'answer') { if (!store.validDevice(body.deviceId)) return res.status(400).json({ error: 'invalid_input' }); opts.deviceId = body.deviceId; }
    if (action === 'fail') { if (!store.validDevice(body.deviceId) || !validGen(body.generation)) return res.status(400).json({ error: 'invalid_input' }); opts.fence = { deviceId: body.deviceId, generation: body.generation }; }
    const call = await store.transition(id, req.account, mapping[action], undefined, opts); kick();
    res.json({ call: publicCall(call), generation: call._lease ? Number(call._lease.generation) : null });
  }));

  // ---- group call history (what Recent Calls shows for rooms): only the caller's own calls, newest first, cursor-paginated
  app.get('/v1/voice/history', auth, route(async (req, res) => { res.set('Cache-Control', 'private, no-store').json(await history.list(req.account, { limit: req.query.limit, cursor: req.query.cursor })); }));
  app.get('/v1/voice/history/:id', auth, route(async (req, res) => { const d = await history.detail(req.account, req.params.id); res.set('Cache-Control', 'private, no-store'); if (!d) return res.status(404).json({ error: 'not_found' }); res.json(d); }));
  // Deleting your own record: one ended call, or all of them (?confirm=all, a batch at a time). A call in progress is refused; a legal hold hides the record from you and keeps it until the hold is released.
  app.delete('/v1/voice/history/:id', auth, route(async (req, res) => { res.set('Cache-Control', 'no-store').json(await history.remove(req.account, req.params.id)); }));
  app.delete('/v1/voice/history', auth, route(async (req, res) => { if (req.query.confirm !== 'all') return res.status(400).json({ error: 'invalid_input' }); res.set('Cache-Control', 'no-store').json(await history.clear(req.account)); }));
  app.get('/v1/voice/history-policy', auth, (_req, res) => res.set('Cache-Control', 'no-store').json({ retentionDays: retention.days, retentionEnabled: retention.days > 0, deletable: 'ended calls only' }));

  // ---- durable events: replay after a reconnect, and acknowledgements (the cursor only moves forward and only over this account's own events)
  app.get('/v1/voice/events', auth, route(async (req, res) => {
    const after = Number(req.query.after ?? 0); if (!safeCursor(after)) return res.status(400).json({ error: 'invalid_cursor' });
    res.set('Cache-Control', 'no-store').json(await reliability.replay(req.account, after));
  }));
  app.post('/v1/voice/events/ack', auth, route(async (req, res) => {
    const { deviceId, cursor } = req.body || {}; if (!store.validDevice(deviceId) || !safeCursor(cursor)) return res.status(400).json({ error: 'invalid_input' });
    res.set('Cache-Control', 'no-store').json({ cursor: await reliability.acknowledge(req.account, deviceId, cursor) });
  }));

  // ---- group rooms
  app.post('/v1/voice/rooms', auth, route(async (req, res) => {
    const { extensions, title, deviceId } = req.body || {};
    if (!Array.isArray(extensions) || extensions.length > 7 || !store.validDevice(deviceId)) return res.status(400).json({ error: 'invalid_input' });
    if (!callLimit.take(req.account)) return res.status(429).json({ error: 'rate_limited' });
    if (!(await guardCapacity(res))) return;
    const r = await store.rooms.createRoom(req.account, extensions, { title: title || '', deviceId }); kick();
    res.status(201).json({ room: r.room, generation: r.lease.generation });
  }));
  app.get('/v1/voice/rooms/live', auth, route(async (req, res) => {
    const room = await store.rooms.liveFor(req.account); if (!room) return res.set('Cache-Control', 'no-store').json({ room: null });
    res.set('Cache-Control', 'no-store').json({ room, me: await store.rooms.seat(room.id, req.account) });
  }));
  app.get('/v1/voice/rooms/:id', auth, route(async (req, res) => {
    if (!validRoomId(req.params.id)) return res.status(400).json({ error: 'invalid_input' });
    const room = await store.rooms.get(req.params.id, req.account); if (!room) return res.status(404).json({ error: 'not_found' }); res.set('Cache-Control', 'no-store').json({ room });
  }));
  app.post('/v1/voice/rooms/:id/:action', auth, route(async (req, res) => {
    const { id, action } = req.params, body = req.body || {}; if (!validRoomId(id)) return res.status(400).json({ error: 'invalid_input' });
    let out;
    if (action === 'join' || action === 'device') {
      if (!store.validDevice(body.deviceId)) return res.status(400).json({ error: 'invalid_input' });
      const r = await (action === 'join' ? store.rooms.join : store.rooms.claimDevice)(id, req.account, body.deviceId); out = { room: r.room, generation: r.lease.generation, expiresIn: 90 };
    } else if (action === 'device-refresh') {
      if (!store.validDevice(body.deviceId) || !validGen(body.generation)) return res.status(400).json({ error: 'invalid_input' });
      if (!(await store.rooms.refreshLease(id, req.account, body.deviceId, body.generation))) return res.status(409).json({ error: 'lease_lost' });
      out = { ok: true, expiresIn: 90 };
    } else if (action === 'leave' || action === 'decline') out = { room: await store.rooms.leave(id, req.account) };
    else if (action === 'end') out = { room: await store.rooms.end(id, req.account) };
    else if (action === 'invite') { if (!(await guardCapacity(res))) return; out = await store.rooms.invite(id, req.account, body.extension); }
    else if (action === 'kick') { if (!validAccountId(body.accountId)) return res.status(400).json({ error: 'invalid_input' }); out = { room: await store.rooms.kick(id, req.account, body.accountId) }; }
    else return res.status(400).json({ error: 'invalid_input' });
    kick(); res.json(out);
  }));

  app.get('/v1/voice/blocks', auth, route(async (req, res) => { res.json({ blocked: await store.listBlocks(req.account) }); }));
  app.post('/v1/voice/blocks', auth, route(async (req, res) => { const { extension } = req.body || {}; if (!validExtension(extension)) return res.status(400).json({ error: 'invalid_input' }); await store.addBlock(req.account, extension); res.status(201).json({ blocked: await store.listBlocks(req.account) }); }));
  app.delete('/v1/voice/blocks/:extension', auth, route(async (req, res) => { if (!validExtension(req.params.extension)) return res.status(400).json({ error: 'invalid_input' }); await store.removeBlock(req.account, req.params.extension); res.json({ blocked: await store.listBlocks(req.account) }); }));
  app.get('/v1/voice/usage', auth, route(async (req, res) => { res.json(await store.usage(req.account, Number(req.query.days) || 30)); }));
  // Diagnostics: state only. No secrets, tokens, SDP or call content.
  app.get('/v1/voice/diagnostics', auth, route(async (req, res) => {
    const me = await store.identity(req.account); let ice = { stun: false, turn: false }, iceError = null;
    try { ice = iceServersFor(req.account, env); } catch (e) { iceError = e.code || e.message; }
    res.set('Cache-Control', 'no-store').json({ identity: me ? { extension: me.extension, enabled: me.enabled } : null, signaling: { devicesConnected: router.count(req.account), maxDevices: 3, queryTicket: String(env.VOICE_WS_QUERY_TICKET || 'on').toLowerCase() !== 'off', distributed: bus ? (bus.up ? 'redis' : 'redis_down') : 'single_instance' },
      ice: { stun: ice.stun, turn: ice.turn, relayOnly: ice.iceTransportPolicy === 'relay', error: iceError, note: iceError ? 'ICE is misconfigured: ' + iceError : ice.turn ? 'TURN relay is configured.' : 'No TURN relay is configured: calls work on the same network and between networks that allow direct UDP, but not behind strict firewalls.' },
      requestOriginAllowed: originAllowed(req.headers.origin, allowed()), ringSeconds: ringSeconds(env), pstn: false });
  }));

  // ---- trusted provisioning and operations (server to server). Browsers never call these; the secret never leaves the main app's server.
  app.post('/v1/voice/admin/identities', adminAuth, route(async (req, res) => {
    const { accountId, extension } = req.body || {};
    if (!validAccountId(accountId) || (extension != null && !validExtension(extension))) return res.status(400).json({ error: 'invalid_input' });
    const r = await store.provisionIdentity(accountId, extension ?? null); res.status(r.created ? 201 : 200).json(r);
  }));
  app.get('/v1/voice/admin/identities', adminAuth, route(async (req, res) => { const ids = req.query.ids ? String(req.query.ids).split(',').slice(0, 500) : undefined; res.json({ identities: await store.listIdentities({ ids }) }); }));
  app.post('/v1/voice/admin/identities/:accountId/enabled', adminAuth, route(async (req, res) => {
    const enabled = (req.body || {}).enabled; if (!validAccountId(req.params.accountId) || typeof enabled !== 'boolean') return res.status(400).json({ error: 'invalid_input' });
    const r = await store.setEnabled(req.params.accountId, enabled); kick(); if (!enabled) closeAccount(req.params.accountId, 4003, 'voice_disabled'); res.json({ identity: r.identity, endedCalls: r.ended.length });
  }));
  // Legal holds (administrators only): a held room is never deleted, by retention or by a user; a user's deletion request then only hides the record from them.
  app.get('/v1/voice/admin/legal-holds', adminAuth, route(async (_req, res) => { res.json({ holds: await history.listHolds() }); }));
  app.post('/v1/voice/admin/legal-holds', adminAuth, route(async (req, res) => { const { roomId, placedBy, reason } = req.body || {}; res.status(201).json(await history.placeHold(roomId, placedBy, reason)); }));
  app.delete('/v1/voice/admin/legal-holds/:roomId', adminAuth, route(async (req, res) => { res.json(await history.releaseHold(req.params.roomId)); }));
  app.post('/v1/voice/admin/history/purge', adminAuth, route(async (_req, res) => { res.json(await history.purgeExpired({ days: retention.days })); }));
  // What an operator alerts on: queue depth and age, failed deliveries, sockets, bus state.
  app.get('/v1/voice/admin/metrics', adminAuth, route(async (req, res) => {
    const q = await reliability.queueStats(), hs = await history.stats();
    if (req.query.format === 'prometheus') {                                    // text exposition for a scraper; the secret header is still required
      const g = (name, help, v) => `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${Number(v) || 0}`, rows = [
        g('qorlla_voice_outbox_pending', 'Durable events not yet published', q.pending), g('qorlla_voice_outbox_oldest_seconds', 'Age of the oldest undelivered event', q.oldestSeconds), g('qorlla_voice_outbox_max_attempts', 'Highest retry count in the outbox', q.maxAttempts),
        g('qorlla_voice_outbox_published_total', 'Events published by this replica since start', worker?.stats.published), g('qorlla_voice_outbox_failed_total', 'Failed publish attempts by this replica since start', worker?.stats.failed),
        g('qorlla_voice_outbox_fail_closed', '1 when new calls are being refused for backlog', q.pending > MAX_PENDING || q.oldestSeconds > MAX_AGE ? 1 : 0),
        g('qorlla_voice_sockets_open', 'Open signaling sockets on this replica', router.total()), g('qorlla_voice_sockets_slow_closed_total', 'Sockets closed for not keeping up', router.slowClosed), g('qorlla_voice_bus_up', '1 when Redis delivery is up (1 also when Redis is not configured)', bus ? (bus.up ? 1 : 0) : 1),
        g('qorlla_voice_history_legal_holds', 'Rooms under legal hold', hs.legalHolds), g('qorlla_voice_history_deletions_waiting_on_hold', 'User deletion requests waiting for a legal hold to be released', hs.deletionsWaitingOnHold),
        g('qorlla_voice_history_retention_deleted_rooms_total', 'Rooms deleted by the retention policy', hs.ops.retention?.rooms), g('qorlla_voice_history_retention_days', 'Configured retention (0 = keep for ever)', retention.days)];
      return res.set('Cache-Control', 'no-store').type('text/plain; version=0.0.4').send(rows.join('\n') + '\n');
    }
    res.set('Cache-Control', 'no-store').json({ instance: instanceId, history: { retentionDays: retention.days, ...hs }, outbox: { ...q, published: worker?.stats.published ?? null, failed: worker?.stats.failed ?? null, maxPending: MAX_PENDING, maxAgeSeconds: MAX_AGE, failClosed: q.pending > MAX_PENDING || q.oldestSeconds > MAX_AGE },
      sockets: { open: router.total(), slowClosed: router.slowClosed }, bus: bus ? (bus.up ? 'up' : 'down') : 'off' });
  }));

  // body-parser problems (too large, not JSON) get a short JSON answer, never a stack trace
  app.use((err, _req, res, next) => { if (res.headersSent) return next(err); if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' }); if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) return res.status(400).json({ error: 'invalid_json' }); console.error('voice error', err?.message); res.status(500).json({ error: 'internal_error' }); });

  // ---- WebSocket signaling
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 70000, perMessageDeflate: false, handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false) });
  server.on('upgrade', async (req, socket, head) => {
    try {
      if (new URL(req.url, 'http://localhost').pathname !== '/v1/voice/ws') throw Error('route');
      const origin = req.headers.origin; if (!originAllowed(origin, allowed())) throw Error('origin');
      const { token } = ticketFromRequest(req, env), t = await consumeTicketFull(token, origin, db, allowed());     // consumed atomically: a replay, a stale or a foreign-origin ticket all fail
      if (!t || !t.deviceId) throw Error('invalid_ticket');
      const profile = await store.identity(t.account); if (!profile?.enabled) throw Error('disabled');
      wss.handleUpgrade(req, socket, head, (ws) => { ws.account = t.account; ws.deviceId = t.deviceId; ws.extension = profile.extension; wss.emit('connection', ws, req); });
    } catch { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); }
  });
  wss.on('connection', async (ws) => {
    const account = ws.account;
    if (router.count(account) >= 3) { ws.close(1008, 'connection_limit'); return; }
    router.attach(ws); ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
    let tokens = 200; const refill = setInterval(() => { tokens = 200; }, 10000); refill.unref?.();
    ws.on('close', () => { clearInterval(refill); router.detach(ws); });
    const reply = (m) => { try { ws.send(JSON.stringify(m)); } catch { /* gone */ } };
    const readySent = (async () => { try { reply({ type: 'ready', extension: ws.extension, deviceId: ws.deviceId, cursor: await reliability.latest(account) }); return true; } catch { ws.close(1011, 'unavailable'); return false; } })();
    ws.on('message', async (raw) => {
      try {
        if (--tokens < 0) { ws.close(1008, 'rate_limit'); return; }          // counted before anything is awaited, so a flood cannot slip through
        if (!(await readySent)) return;
        const msg = JSON.parse(raw.toString());
        if (msg && msg.type === 'resume' && safeCursor(msg.after)) { reply({ type: 'resume_batch', ...(await reliability.replay(account, msg.after)) }); return; }
        if (msg && msg.type === 'ack' && safeCursor(msg.cursor)) { reply({ type: 'ack_ok', cursor: await reliability.acknowledge(account, ws.deviceId, msg.cursor) }); return; }
        if (msg && GSIGNALS.includes(msg.type)) return await relayGroup(ws, msg);
        if (!safeSignal(msg) || !validGen(msg.generation)) return;
        const ctx = await store.signalContext(msg.callId);
        if (!ctx || ![ctx.call.caller_id, ctx.call.callee_id].includes(account)) return;
        if (ctx.call.status !== 'active') return;                                       // never relay SDP or ICE before the callee has answered, or after the call ended
        const mine = ctx.leases[account];
        if (!mine || !mine.valid || mine.device_id !== ws.deviceId || mine.generation !== msg.generation) return;   // fencing: a replaced or expired device has no signaling authority
        const other = ctx.call.caller_id === account ? ctx.call.callee_id : ctx.call.caller_id, theirs = ctx.leases[other];
        if (!theirs || !theirs.valid) return;
        send(other, { type: msg.type, callId: msg.callId, gen: msg.generation, ...(msg.type === 'ice' ? { candidate: cleanCandidate(msg.candidate) } : { sdp: msg.sdp }) }, theirs.device_id);
      } catch { /* malformed input is dropped, never echoed */ }
    });
  });
  /** Mesh signaling inside a room: both people must be joined, the sender must hold the seat's current device and generation, and the message goes only to the recipient's current device. */
  async function relayGroup(ws, msg) {
    const account = ws.account;
    if (!validRoomId(msg.roomId) || !validAccountId(msg.to) || msg.to === account || !validGen(msg.generation)) return;
    const type = msg.type.slice(2);
    if (!safeSignal({ type, callId: msg.roomId, sdp: msg.sdp, candidate: msg.candidate })) return;
    const ctx = await store.rooms.signalContext(msg.roomId, account, msg.to);
    if (!ctx || !ctx.live || !ctx.from || !ctx.to || ctx.from.status !== 'joined' || ctx.to.status !== 'joined') return;
    if (!ctx.from.valid || ctx.from.device_id !== ws.deviceId || ctx.from.generation !== msg.generation || !ctx.to.valid) return;
    send(msg.to, { type: msg.type, roomId: msg.roomId, from: account, gen: msg.generation, toGen: ctx.to.generation, ...(type === 'ice' ? { candidate: cleanCandidate(msg.candidate) } : { sdp: msg.sdp }) }, ctx.to.device_id);
  }
  const heartbeat = setInterval(() => { for (const ws of wss.clients) { if (ws.isAlive === false) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch { /* gone */ } } }, 30000); heartbeat.unref?.();
  const maint = maintenance ? startMaintenance({ store, db, reliability, history, historyRetentionDays: retention.days, afterChange: kick, intervalMs: maintenanceMs, ringSeconds: ringSeconds(env), leaseGraceSeconds: Number(env.VOICE_LEASE_GRACE_SECONDS || 120), retentionHours: Number(env.VOICE_EVENT_RETENTION_HOURS || 168) }) : null;

  return {
    app, server, wss, sockets, send, router, bus, worker, reliability, maint, instanceId, kick, closeAccount,
    listen: async (port = 0, host) => {
      if (bus) { try { await Promise.race([bus.start(), new Promise((_r, rej) => setTimeout(() => rej(Error('redis_start_timeout')), 3000))]); } catch (e) { console.error('voice: Redis is not reachable yet; running degraded and retrying:', e.message); } }
      worker?.start(); worker?.kick();
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
    },
    close: async () => { maint?.stop(); worker?.stop(); clearInterval(heartbeat); for (const ws of wss.clients) ws.close(1001); await new Promise((r) => server.close(() => r())); await bus?.close().catch(() => {}); }
  };
}
