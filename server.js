/**
 * Zoom Workspace Signaling & Collaboration Engine Core
 * Real-time rooms, WebRTC signaling, chat, shared notes, reactions and REST microservices.
 */

// Load settings from a .env file next to this script (real environment variables always win).
require('dotenv').config({ path: process.env.DOTENV_PATH || require('path').join(__dirname, '.env') });

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
// Behind nginx (private network) so req.ip reflects the real client for sign-in throttling
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
// Baseline response hardening. (A strict script CSP is not possible yet: the pages use inline scripts.)
app.use((req, res, next) => {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'SAMEORIGIN',
        'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(), payment=()'
    });
    next();
});
app.use(cors());
// Accounts and sessions
const DATA_ROOT = process.env.DATA_DIR || path.join(__dirname, 'data');
const store = require('./store');

// Refuse to start if stored data cannot be read (wrong or missing ENCRYPT_KEY, corrupt file).
// Carrying on would show empty data and the next save would overwrite the real files.
for (const f of [path.join(DATA_ROOT, 'auth', 'users.json'), path.join(DATA_ROOT, 'meetings.json')]) {
    try { store.inspect(f); } catch (err) {
        console.error('FATAL: cannot read stored data: ' + err.message);
        console.error('Check that ENCRYPT_KEY matches the key the data was encrypted with (or run scripts/encrypt-data.js).');
        process.exit(1);
    }
}

const mailer = require('./mailer')({ dataDir: DATA_ROOT });
console.log('[Config] Encryption at rest: ' + (store.enabled ? 'ON' : 'OFF (set ENCRYPT_KEY to enable)'));
console.log('[Config] Email service: ' + (mailer.enabled ? 'ON (links use ' + mailer.baseUrl + ')'
    : mailer.configured ? 'OFF - SMTP is set but PUBLIC_URL is missing (required in production)'
    : 'OFF (set SMTP_URL, SMTP_FROM and PUBLIC_URL to enable reset links and outside mail)'));
const auth = require('./auth')({ dataDir: DATA_ROOT, mailer });
// Public keys the Workplace Portal uses to verify identity tokens issued by this server
app.get('/.well-known/jwks.json', (req, res) => res.set('Cache-Control', 'public, max-age=300').json(auth.portalTokens.jwks()));
app.use('/api/auth', auth.router);

// Workplace carries whiteboard images, so it parses its own (larger) JSON bodies
app.use('/api/workplace', require('./workplace')({
    dataDir: DATA_ROOT,
    allocateMeeting: (m) => allocateMeeting(m),
    // Keep the live meeting record in step with an edited/deleted scheduled meeting (so a moved meeting stays joinable and a deleted one stops working)
    updateMeeting: (id, f) => {
        const m = meetingsState.get(normalizeId(id)); if (!m) return;
        if (f.topic) m.topic = String(f.topic).slice(0, 200);
        if (f.startTime) m.startTime = f.startTime;
        if (f.durationMinutes) m.durationMinutes = f.durationMinutes;
        saveSnapshotSoon();
    },
    closeMeeting: (id) => {
        const m = meetingsState.get(normalizeId(id)); if (!m || m.status === 'completed') return;
        m.status = 'completed'; saveSnapshotSoon();
        io.to(m.meetingId).emit('meeting_terminated_by_host', { summaryMessage: 'The host deleted this scheduled meeting.' });
        guestSessions.revokeMeeting(m.meetingId, 'meeting_ended');
    },
    auth,
    mailer,
    // io is created further down; this only runs while serving requests, after start-up
    notify: (userIds, event, payload) => userIds.forEach((id) => io.to('user:' + id).emit(event, payload))
}));

app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// ==========================================
// IN-MEMORY STORE (DATA LAYER)
// ==========================================
const meetingsState = new Map();
const activeRooms = new Map(); // meetingId -> Map(socketId -> participant)

const ALLOWED_REACTIONS = new Set(['👍', '👏', '❤️', '😂', '🎉', '😮']);
const MAX_CHAT_LENGTH = 2000;
const MAX_NOTES_LENGTH = 20000;

const normalizeId = (id) => String(id || '').replace(/\s+/g, ' ').trim();

// ------------------------------------------
// Persistence: JSON snapshot so meetings and chats survive restarts
// ------------------------------------------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'meetings.json');
let saveTimer = null;

function loadSnapshot() {
    try {
        const saved = store.readJson(SNAPSHOT_FILE, []);
        for (const m of saved) {
            // No sockets survive a restart, so nothing can still be active
            if (m.status === 'active') m.status = 'scheduled';
            meetingsState.set(m.meetingId, m);
        }
    } catch (err) {
        console.error('[Persistence]: load failed:', err.message);
    }
}

function saveSnapshotSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            store.writeJson(SNAPSHOT_FILE, Array.from(meetingsState.values()));
        } catch (err) {
            console.error('[Persistence]: save failed:', err.message);
        }
    }, 500);
    saveTimer.unref();
}

loadSnapshot();

// Seed meeting used by the mobile client default, CI health check and demos
if (!meetingsState.has('858 9833 3712')) meetingsState.set('858 9833 3712', {
    id: uuidv4(),
    meetingId: '858 9833 3712',
    topic: "Master's Thesis Research I",
    startTime: new Date().toISOString(),
    durationMinutes: 45,
    hostId: 'usr_jane_doe',
    timezone: 'GMT-4:00 (Eastern Time)',
    status: 'scheduled',
    documents: [],
    notes: '',
    chatHistory: []
});

meetingsState.get('858 9833 3712').evergreen = true;   // the seeded demo meeting (mobile default, CI health check) never lapses

// ------------------------------------------
// Guest access (v4.6.1): meeting-scoped sessions, actor resolution, host keys
// ------------------------------------------
const { createGuestSessions, createGuestRouter, rateLimit } = require('./guest-sessions');
const meetingById = (id) => meetingsState.get(normalizeId(id));
const guestSessions = createGuestSessions({ getMeeting: meetingById });
const hostKeyHash = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
function verifyHostKey(meeting, key) {
    if (!meeting || !meeting.hostKeyHash || !key) return false;
    const a = Buffer.from(hostKeyHash(key)); const b = Buffer.from(meeting.hostKeyHash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const meetingAccounts = new Map();      // meetingId -> Set(accountId) of signed-in people who joined (they may read that meeting's documents)
const publicMeeting = ({ hostKeyHash: _h, passcodeHash: _p, removedAccounts: _r, ...rest }) => ({ ...rest, passcodeRequired: !!_p });

// Optional meeting passcode (MAIN meetings: 4-32 characters, scrypt). Meet has its own, separate policy (see docs/PASSCODE_POLICY.md).
// Attempts go through the durable lockout service: 5 failures lock the meeting for 10 minutes, across restarts and processes.
const { createFileLockoutStore, createPgLockoutStore, createLockoutService } = require('./lockout');
function buildLockoutStore() {
    const mode = process.env.LOCKOUT_STORE || (process.env.DATABASE_URL ? 'postgres' : 'file');
    if (mode === 'postgres') {
        const { Pool } = require('pg');
        const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, max: 4 });
        pool.on('error', (e) => console.error('[lockout] database pool error:', e.message));
        return createPgLockoutStore({ pool });
    }
    return createFileLockoutStore({ dir: path.join(DATA_ROOT, 'auth') });
}
const lockout = createLockoutService({ store: buildLockoutStore() });
console.log('[Config] Passcode lockout store: ' + lockout.store.kind);
const scryptAsync = require('util').promisify(crypto.scrypt);
const hashPasscode = (pc, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(String(pc), salt, 32).toString('hex');
async function comparePasscode(meeting, supplied) {
    const [salt, hash] = meeting.passcodeHash.split(':');
    const given = (await scryptAsync(String(supplied), salt, 32)).toString('hex');
    return given.length === hash.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(hash));
}
/** Resolves { required, ok, status, locked, lockedUntil }. An empty submission is refused WITHOUT consuming an attempt (so nobody can burn the budget with blanks). */
async function checkPasscode(meeting, supplied, req) {
    if (!meeting || !meeting.passcodeHash) return { required: false, ok: true };
    if (typeof supplied !== 'string' || !supplied) return { required: true, ok: false, status: 'missing' };
    if (supplied.length > 128) return { required: true, ok: false, status: 'invalid' };   // defensive request limit: refused before any hashing and without consuming an attempt
    const r = await lockout.verify({ meetingId: meeting.meetingId, clientKey: req && req.ip, check: () => comparePasscode(meeting, supplied) });
    if (r.newlyLocked) notifyHostsOfLockout(meeting.meetingId, r.lockedUntil);
    return { required: true, ok: r.status === 'ok', status: r.status, locked: r.status === 'locked', lockedUntil: r.lockedUntil };
}
function notifyHostsOfLockout(meetingId, lockedUntil) {
    const room = activeRooms.get(meetingId); if (!room) return;
    for (const p of room.values()) if (p.role === 'host') io.to(p.socketId).emit('passcode_lockout', { meetingId, lockedUntil });
}
const admittedAccounts = new Map();     // meetingId -> Set(accountId) that supplied the passcode
const admitAccount = (id, accountId) => { if (!admittedAccounts.has(id)) admittedAccounts.set(id, new Set()); admittedAccounts.get(id).add(accountId); };

/** Who is calling: a signed-in account, a guest with a live session, or nobody. Never trusts ids sent by the client. */
function actorOf(req) {
    const user = auth.getUser(req);
    if (user) return { type: 'account', id: user.id, user };
    const s = guestSessions.fromRequest(req);
    return s ? { type: 'guest', id: 'guest:' + s.sid, session: s } : null;
}
function actorCanAccess(actor, meetingId, allowEnded = false) {
    const id = normalizeId(meetingId); const meeting = meetingsState.get(id);
    if (!actor || !meeting) return false;
    if (meeting.status === 'completed' && !(allowEnded && actor.type === 'account')) return false;   // guest sessions die with the meeting
    if (actor.type === 'guest') return actor.session.meetingId === id;
    return meeting.hostId === actor.id || !!(meetingAccounts.get(id) && meetingAccounts.get(id).has(actor.id));
}
function actorIsHost(actor, meetingId, allowEnded = false) {
    const id = normalizeId(meetingId); const meeting = meetingsState.get(id);
    if (!actor || !meeting) return false;
    if (meeting.status === 'completed' && !(allowEnded && actor.type === 'account')) return false;
    return actor.type === 'guest' ? actor.session.meetingId === id && actor.session.role === 'host' : meeting.hostId === actor.id;
}
function attachActor(req, res, next) {
    req.actor = actorOf(req);
    req.canAccessMeeting = (id, allowEnded) => actorCanAccess(req.actor, id, allowEnded);
    req.isMeetingHost = (id, allowEnded) => actorIsHost(req.actor, id, allowEnded);
    next();
}
app.use('/api/guest', createGuestRouter({ express, sessions: guestSessions, getMeeting: meetingById, getAccount: (req) => auth.getUser(req), verifyHostKey, checkPasscode, admitAccount }));

// --- Mount service files ---
const appointmentsRouter = require('./appointments');
const docsRouter = require('./docs');
const postMeetingRouter = require('./post-meeting');
const notificationsModule = require('./notifications');

app.use(['/api/appointments', '/api/docs', '/api/post-meeting', '/api/notifications'], attachActor);
app.use('/api/appointments', appointmentsRouter);
app.use('/api/docs', docsRouter);
app.use('/api/post-meeting', postMeetingRouter);
app.use('/api/notifications', notificationsModule.router);

// Liveness/status endpoint used by the UI and by container health checks
const APP_VERSION = require('./package.json').version;
app.get('/api/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok', version: APP_VERSION, uptimeSeconds: Math.round(process.uptime()) });
});

// Serve only the two UI pages (never the server source directory)
// "/" is the Workplace home page; it links on to the video page.
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'qorlla.html'));
});
app.get('/qorlla.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'qorlla.html'));
});
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});
// Guest area: a landing page of its own; the video page opens only when a guest chooses a meeting (or follows an invitation)
const sendGuest = (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'guest.html')); };
app.get(['/guest', '/guest/welcome', '/guest/join-meeting', '/guest/explore', '/guest/help'], sendGuest);
app.get('/guest/meeting/:id/prejoin', sendGuest);
app.get('/guest.js', (req, res) => res.sendFile(path.join(__dirname, 'guest.js')));
// Canonical auth entry points: sign-in and registration live in the home page shell; a ?next= destination is preserved.
app.get('/auth/login', (req, res) => { const q = new URLSearchParams(); if (req.query.next) q.set('next', String(req.query.next)); res.redirect(302, '/qorlla.html' + (q.toString() ? '?' + q : '')); });
app.get('/auth/register', (req, res) => { const q = new URLSearchParams({ tab: 'up' }); if (req.query.next) q.set('next', String(req.query.next)); res.redirect(302, '/qorlla.html?' + q); });
app.get('/chat.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'chat.html'));
});
app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// MEETING PREPARATION FLOW (REST API)
// ==========================================
function allocateMeeting({ topic, startTime, durationMinutes, hostId, timezone }) {
    const rawId = Math.floor(10000000000 + Math.random() * 90000000000).toString();
    const formattedMeetingId = `${rawId.substring(0, 3)} ${rawId.substring(3, 7)} ${rawId.substring(7, 11)}`;

    const newMeeting = {
        id: uuidv4(),
        meetingId: formattedMeetingId,
        topic: String(topic).slice(0, 200),
        startTime: startTime || new Date().toISOString(),
        durationMinutes: durationMinutes || 45,
        hostId,
        timezone: timezone || "GMT-4:00 (Eastern Time)",
        status: 'scheduled',
        documents: [],
        notes: "",
        chatHistory: []
    };

    meetingsState.set(formattedMeetingId, newMeeting);
    saveSnapshotSoon();
    console.log(`[Notification Engine]: Invite dispatched for Meeting ID: ${formattedMeetingId}`);
    return newMeeting;
}

const limitCreate = rateLimit(20), limitValidate = rateLimit(60);
app.post('/api/meetings/create', limitCreate, (req, res) => {
    const { topic, startTime, durationMinutes, timezone } = req.body;
    const account = auth.getUser(req);
    const hostId = account ? account.id : req.body.hostId;    // a signed-in host is always the account, never a client-supplied id

    if (!topic || !hostId) {
        return res.status(400).json({ error: "Missing required topic or host registration identifier." });
    }

    const newMeeting = allocateMeeting({ topic, startTime, durationMinutes, hostId, timezone });
    // Anonymous hosts prove they are the host with this one-time key (only its hash is stored); accounts do not need it.
    let hostKey;
    if (!account) { hostKey = crypto.randomBytes(24).toString('base64url'); newMeeting.hostKeyHash = hostKeyHash(hostKey); }
    if (req.body.allowGuests === false) newMeeting.allowGuests = false;
    if (req.body.passcode !== undefined && req.body.passcode !== '') {
        const pc = String(req.body.passcode);
        if (pc.length < 4 || pc.length > 32) { meetingsState.delete(newMeeting.meetingId); return res.status(400).json({ error: 'The passcode must be 4 to 32 characters.' }); }
        newMeeting.passcodeHash = hashPasscode(pc);
    }
    saveSnapshotSoon();

    return res.status(201).json({
        message: "Meeting room allocation successful.",
        meeting: publicMeeting(newMeeting),
        ...(hostKey ? { hostKey } : {})
    });
});

// Host sends invitations by email (needs SMTP; says so plainly when it is not configured). Text/SMS and share-sheet invites are device links in the page.
const limitRecoverIp = rateLimit(30, 60 * 60 * 1000);                          // coarse brake against noise from one address (the strict allowance is durable, below)
app.get('/api/meetings/:meetingId/passcode-security', attachActor, async (req, res) => {
    const id = normalizeId(req.params.meetingId);
    if (!req.actor) return res.status(401).json({ error: 'Sign in or join the meeting first.' });
    if (!meetingsState.get(id) || !actorIsHost(req.actor, id)) return res.status(403).json({ error: 'Only the host can see this.' });
    try { const s = await lockout.status(id); res.set('Cache-Control', 'no-store').json({ locked: s.locked, lockedUntil: s.lockedUntil, events: s.events }); }
    catch (e) { res.status(503).json({ error: 'Passcode security status is unavailable.' }); }
});
// Authorised recovery: clears ONLY the lock state. It cannot read, change or reveal the passcode; it is host-only, rate limited and audited.
// Audit line for every recovery request: actor, meeting, time, outcome and a reason code. Never a passcode, host key or credential.
function auditRecovery(id, actor, outcome, reason) {
    console.log(JSON.stringify({ audit: 'passcode_lockout_clear', meeting: id, actor: actor ? actor.id : null, at: new Date().toISOString(), outcome, reason }));
}
app.post('/api/meetings/:meetingId/passcode-lockout/clear', limitRecoverIp, attachActor, async (req, res) => {
    const id = normalizeId(req.params.meetingId);
    // Rejected requests are recorded (durably, under their own kind) but never use up the three allowed successful recoveries.
    const reject = async (status, reason, message) => {
        auditRecovery(id, req.actor, 'rejected', reason);
        if (meetingsState.get(id)) { try { await lockout.audit(id, 'clear_rejected', req.actor ? (req.actor.type === 'account' ? req.actor.id : 'guest-session') : null, reason); } catch (e) { /* the response below is still a refusal */ } }
        return res.status(status).json({ error: message });
    };
    const origin = req.get('origin'); if (origin) { let h = ''; try { h = new URL(origin).host; } catch (e) { /* malformed */ } if (h !== req.get('host')) return reject(403, 'origin_rejected', 'Origin rejected.'); }
    if (!req.actor) return reject(401, 'unauthenticated', 'Sign in or join the meeting first.');
    if (!meetingsState.get(id) || !actorIsHost(req.actor, id)) return reject(403, 'not_host', 'Only the host can lift a passcode lockout.');   // checked on EVERY request
    try {
        // The allowance belongs to the host's stable identity: the owning account, or (for an anonymous host) the meeting itself. It must NOT be the
        // guest session id: re-issuing a session with the host key would otherwise reset the allowance.
        const hostIdentity = req.actor.type === 'account' ? req.actor.id : 'hostkey:' + id;
        const out = await lockout.clearLockLimited(id, hostIdentity);          // allowance check + clear + event in one atomic operation
        if (!out.ok) { auditRecovery(id, req.actor, 'rejected', out.reason); res.set('Retry-After', String(Math.ceil((out.retryAfterMs || 3600000) / 1000))); return res.status(429).json({ error: 'You have lifted this lockout too often. Try again later.' }); }
        auditRecovery(id, req.actor, 'cleared', out.wasLocked ? 'was_locked' : 'was_not_locked');
        res.json({ cleared: true, wasLocked: out.wasLocked });
    } catch (e) { auditRecovery(id, req.actor, 'failed', 'store_unavailable'); res.status(503).json({ error: 'The lockout store is unavailable; nothing was changed.' }); }
});

const limitInvite = rateLimit(10, 60 * 60 * 1000);
app.post('/api/meetings/:meetingId/invite', limitInvite, attachActor, async (req, res) => {
    const id = normalizeId(req.params.meetingId);
    const meeting = meetingsState.get(id);
    if (!req.actor) return res.status(401).json({ error: 'Sign in or join the meeting first.' });
    if (!meeting || !actorIsHost(req.actor, id)) return res.status(403).json({ error: 'Only the host can send invitations.' });
    const list = Array.isArray(req.body && req.body.emails) ? [...new Set(req.body.emails.map((e) => String(e).trim().toLowerCase()))] : [];
    if (!list.length || list.length > 20) return res.status(400).json({ error: 'Give 1 to 20 email addresses.' });
    if (!list.every((e) => mailer.isValidAddress(e))) return res.status(400).json({ error: 'One or more addresses are not valid.' });
    if (!mailer.configured) return res.status(503).json({ error: 'Email is not set up on this server (SMTP_URL and SMTP_FROM). Copy the invite link or share it by text instead.' });
    const base = (mailer.baseUrl || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
    const link = base + '/guest/meeting/' + encodeURIComponent(id) + '/prejoin';
    const who = req.actor.type === 'guest' ? req.actor.session.name : (req.actor.user.displayName || req.actor.user.username);
    const text = who + ' invited you to a Qorlla meeting.\n\nTopic: ' + meeting.topic + '\nMeeting ID: ' + id + '\nJoin: ' + link + '\n' + (meeting.passcodeHash ? '\nThis meeting needs a passcode. Ask the host for it.\n' : '') + '\nYou do not need an account to join.';
    const results = [];
    for (const to of list) { const r = await mailer.send({ to, subject: who + ' invited you to a Qorlla meeting', text }); results.push({ email: to, status: r.status }); }
    res.json({ sent: results.filter((r) => r.status === 'sent').length, results });
});

app.get('/api/meetings/validate/:meetingId', limitValidate, (req, res) => {
    const meeting = meetingsState.get(normalizeId(req.params.meetingId));
    if (!meeting || meeting.status === 'completed') {
        return res.status(404).json({ isValid: false, error: "Meeting resource code is invalid or has expired." });
    }

    return res.json({ isValid: true, topic: meeting.topic, status: meeting.status, passcodeRequired: !!meeting.passcodeHash });
});

// ==========================================
// LIVE WEBRTC & WEBSOCKET ROOM FLOW
// ==========================================
// Host status comes only from the server: the signed-in account that owns the meeting, or a guest session that was issued
// with the meeting's host key. A user id sent by the client is never consulted.
function isHostFor(socket, meeting) {
    const account = auth.getUser(socket.request);
    if (account) return account.id === meeting.hostId;
    const gs = socket.guestSid && guestSessions.get(socket.guestSid);
    return !!gs && gs.meetingId === meeting.meetingId && gs.role === 'host';
}

guestSessions.setRevokeHandler((session, reason) => {
    const s = session.socketId && io.sockets.sockets.get(session.socketId);
    if (!s) return;
    s.emit('session_revoked', { reason });
    leaveCurrentRoom(s);
    s.guestSid = null;
    setTimeout(() => s.disconnect(true), 50);
});

function rosterOf(roomId) {
    const room = activeRooms.get(roomId);
    return room ? Array.from(room.values()) : [];
}

function leaveCurrentRoom(socket) {
    const roomId = socket.currentRoom;
    if (!roomId) return;

    socket.leave(roomId);
    socket.currentRoom = null;

    const room = activeRooms.get(roomId);
    if (!room) return;

    room.delete(socket.id);
    socket.to(roomId).emit('webrtc_peer_left', { socketId: socket.id });

    if (room.size === 0) {
        const meeting = meetingsState.get(roomId);
        if (meeting && meeting.status === 'active') meeting.status = 'scheduled';
        activeRooms.delete(roomId);
    } else {
        io.to(roomId).emit('room_state_updated', { participants: rosterOf(roomId) });
    }
}

io.on('connection', (socket) => {
    console.log(`[Socket Connected]: Socket Session initialized (${socket.id})`);

    // Signed-in visitors get a private room so chat/mail changes can be pushed to them instantly.
    // Only "something changed" nudges are sent; pages re-fetch the actual data over the REST API.
    const account = auth.getUser(socket.request);
    if (account) socket.join('user:' + account.id);

    const currentParticipant = () => {
        const room = socket.currentRoom && activeRooms.get(socket.currentRoom);
        return room ? room.get(socket.id) : undefined;
    };

    socket.on('join_room', ({ meetingId, userId, userName } = {}) => {
        const cleanId = normalizeId(meetingId);
        const currentMeeting = meetingsState.get(cleanId);

        if (!currentMeeting || currentMeeting.status === 'completed') {
            socket.emit('error_response', { message: "Target meeting tracking entity missing or already ended." });
            return;
        }

        if (currentMeeting.removedAccounts && currentMeeting.removedAccounts.includes((auth.getUser(socket.request) || {}).id)) {
            socket.emit('error_response', { message: "You were removed from this meeting by the host." });
            return;
        }
        // Authorization: a signed-in account, or a live guest session issued for THIS meeting. Knowing the ID is not enough.
        const joiningAccount = auth.getUser(socket.request);
        let gs = null;
        if (!joiningAccount) {
            gs = (socket.guestSid && guestSessions.get(socket.guestSid)) || guestSessions.fromRequest(socket.request);
            if (!gs || gs.meetingId !== cleanId || !gs.caps.includes('meeting:join')) {
                socket.emit('error_response', { code: 'guest_session_required', message: "Join from the meeting page so a guest session can be created for this meeting." });
                return;
            }
            const previous = gs.socketId && gs.socketId !== socket.id ? io.sockets.sockets.get(gs.socketId) : null;
            if (previous) { previous.emit('session_revoked', { reason: 'taken_over' }); leaveCurrentRoom(previous); previous.guestSid = null; previous.disconnect(true); }
            gs.socketId = socket.id; socket.guestSid = gs.sid;
        } else {
            if (currentMeeting.passcodeHash && currentMeeting.hostId !== joiningAccount.id && !(admittedAccounts.get(cleanId) && admittedAccounts.get(cleanId).has(joiningAccount.id))) {
                socket.emit('error_response', { code: 'passcode_required', message: 'This meeting needs a passcode. Join from the meeting page and enter it.' });
                return;
            }
            if (!meetingAccounts.has(cleanId)) meetingAccounts.set(cleanId, new Set());
            meetingAccounts.get(cleanId).add(joiningAccount.id);
        }

        leaveCurrentRoom(socket);

        if (!activeRooms.has(cleanId)) {
            activeRooms.set(cleanId, new Map());
            currentMeeting.status = 'active';
        }

        const roomParticipants = activeRooms.get(cleanId);
        const safeName = String((gs && gs.name) || userName || '').trim().slice(0, 60) || 'Anonymous User';

        roomParticipants.set(socket.id, {
            socketId: socket.id,
            userId: String(userId || '').slice(0, 64),
            userName: safeName,
            // Role is derived from the meeting record, never from client input
            role: isHostFor(socket, currentMeeting) ? 'host' : 'participant',
            media: { audio: false, video: false, sharing: false, hand: false },
            permissions: { audio: true, video: true, screenShare: true }
        });

        socket.join(cleanId);
        socket.currentRoom = cleanId;
        console.log(`[User Joined Room]: ${safeName} entered ${cleanId}`);

        io.to(cleanId).emit('room_state_updated', {
            meetingMetadata: publicMeeting(currentMeeting),
            participants: rosterOf(cleanId)
        });

        socket.to(cleanId).emit('webrtc_peer_join', { socketId: socket.id, userName: safeName });
    });

    socket.on('leave_room', () => leaveCurrentRoom(socket));

    socket.on('webrtc_signal', ({ targetSocketId, signalData } = {}) => {
        const room = socket.currentRoom && activeRooms.get(socket.currentRoom);
        if (!room || !room.has(targetSocketId)) return;
        io.to(targetSocketId).emit('webrtc_signal_forward', {
            senderSocketId: socket.id,
            signalData
        });
    });

    socket.on('media_state', (state = {}) => {
        const me = currentParticipant();
        if (!me) return;
        me.media = {
            audio: !!state.audio,
            video: !!state.video,
            sharing: !!state.sharing,
            hand: !!state.hand
        };
        io.to(socket.currentRoom).emit('room_state_updated', { participants: rosterOf(socket.currentRoom) });
    });

    socket.on('reaction', ({ emoji } = {}) => {
        const me = currentParticipant();
        if (!me || !ALLOWED_REACTIONS.has(emoji)) return;
        io.to(socket.currentRoom).emit('reaction_received', { socketId: socket.id, userName: me.userName, emoji });
    });

    socket.on('send_chat_message', ({ messageText } = {}) => {
        const roomId = socket.currentRoom;
        const participant = currentParticipant();
        const meeting = meetingsState.get(roomId);
        const text = typeof messageText === 'string' ? messageText.trim().slice(0, MAX_CHAT_LENGTH) : '';

        if (participant && meeting && text) {
            const chatPayload = {
                id: uuidv4(),
                senderName: participant.userName,
                senderId: participant.userId,
                message: text,
                timestamp: new Date().toISOString()
            };

            meeting.chatHistory.push(chatPayload);
            saveSnapshotSoon();
            io.to(roomId).emit('chat_message_received', chatPayload);
        }
    });

    socket.on('notes_update', ({ text } = {}, ack) => {
        const meeting = meetingsState.get(socket.currentRoom);
        const me = currentParticipant();
        if (!meeting || !me || typeof text !== 'string') {
            if (typeof ack === 'function') ack({ ok: false });
            return;
        }
        meeting.notes = text.slice(0, MAX_NOTES_LENGTH);
        saveSnapshotSoon();
        socket.to(socket.currentRoom).emit('notes_updated', { text: meeting.notes, by: me.userName });
        if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('admin_broadcast_control', ({ targetSocketId, targetAction, statusState } = {}) => {
        const roomId = socket.currentRoom;
        const room = roomId && activeRooms.get(roomId);
        const sender = room && room.get(socket.id);

        if (!sender || (sender.role !== 'host' && sender.role !== 'admin')) {
            socket.emit('error_response', { message: "Operation denied. Insufficient administrative privileges." });
            return;
        }

        if (targetSocketId === 'all') {
            room.forEach((user) => {
                if (user.socketId !== socket.id) {
                    io.to(user.socketId).emit('force_action_override', { targetAction, statusState });
                }
            });
        } else if (room.has(targetSocketId)) {
            io.to(targetSocketId).emit('force_action_override', { targetAction, statusState });
        }
    });

    socket.on('document_linked', ({ fileName, fileUrl, fileSize } = {}) => {
        const meeting = meetingsState.get(socket.currentRoom);

        if (meeting && currentParticipant()) {
            const assetPayload = {
                id: uuidv4(),
                fileName: String(fileName || '').slice(0, 255),
                fileUrl: String(fileUrl || '').slice(0, 2000),
                fileSize: Number(fileSize) || 0,
                attachedAt: new Date().toISOString()
            };
            meeting.documents.push(assetPayload);
            saveSnapshotSoon();
            io.to(socket.currentRoom).emit('document_registry_updated', meeting.documents);
        }
    });

    socket.on('terminate_meeting_session', () => {
        const roomId = socket.currentRoom;
        const room = roomId && activeRooms.get(roomId);
        const sender = room && room.get(socket.id);

        if (sender && (sender.role === 'host' || sender.role === 'admin')) {
            const meeting = meetingsState.get(roomId);
            if (meeting) {
                meeting.status = 'completed';
                saveSnapshotSoon();
                console.log(`[Post-Processing Engine]: Meeting ${roomId} marked closed.`);
            }

            io.to(roomId).emit('meeting_terminated_by_host', {
                summaryMessage: "The host has concluded this session. Post-meeting summaries and cloud recordings will generate shortly."
            });

            for (const sid of room.keys()) {
                const s = io.sockets.sockets.get(sid);
                if (s) {
                    s.leave(roomId);
                    s.currentRoom = null;
                }
            }
            activeRooms.delete(roomId);
            guestSessions.revokeMeeting(roomId, 'meeting_ended');
        }
    });

    // Host removes a participant: a guest's session is revoked (the old cookie stops working), an account is taken out of the
    // room and barred from re-joining this meeting.
    socket.on('remove_participant', ({ targetSocketId } = {}) => {
        const roomId = socket.currentRoom; const room = roomId && activeRooms.get(roomId);
        const sender = room && room.get(socket.id);
        if (!sender || (sender.role !== 'host' && sender.role !== 'admin')) { socket.emit('error_response', { message: "Operation denied. Insufficient administrative privileges." }); return; }
        if (!room.has(targetSocketId) || targetSocketId === socket.id) return;
        const target = io.sockets.sockets.get(targetSocketId);
        if (target && target.guestSid) {
            guestSessions.revokeSid(target.guestSid, 'removed_by_host');
        } else if (target) {
            const acct = auth.getUser(target.request);
            const meeting = meetingsState.get(roomId);
            if (acct && meeting) { (meeting.removedAccounts = meeting.removedAccounts || []).push(acct.id); saveSnapshotSoon(); }
            target.emit('session_revoked', { reason: 'removed_by_host' });
            leaveCurrentRoom(target);
        }
        io.to(roomId).emit('room_state_updated', { participants: rosterOf(roomId) });
    });

    socket.on('disconnect', () => {
        if (socket.guestSid) { const g = guestSessions.get(socket.guestSid); if (g && g.socketId === socket.id) g.socketId = null; }
        leaveCurrentRoom(socket);
        console.log(`[Socket Disconnected]: Active Session Closed (${socket.id})`);
    });
});

// ==========================================
// RUNTIME BOOTSTRAP INITIALIZATION
// ==========================================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Zoom Workspace Signaling Engine online and bound to Port [${PORT}]`);
});

// Explicit public translation assets; never expose the source directory.
// Portal sections (/app, /pricing) and Meet (/meet) are served by the reverse proxy in the full stack. On a standalone MAIN there is nothing behind
// them, so say so instead of a bare "Cannot GET".
app.get(['/app', '/app/*', '/pricing', '/pricing/*', '/meet', '/meet/*'], (req, res) => {
    res.status(503).set('Cache-Control', 'no-store').type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Section not running</title><body style="font:16px system-ui;max-width:560px;margin:12vh auto;padding:0 20px;color:#101b39"><h1 style="font-size:24px">This section is not running here</h1><p style="color:#536487;line-height:1.6">Phone, Docs, Clips, Pricing, Billing and Meet are served by the Qorlla Workplace Portal behind the reverse proxy. This is the standalone meeting server, which does not include them. Start the full stack (<code>docker compose up</code>) and open it on the proxy port.</p><p><a href="/qorlla.html" style="color:#1765f5">Back to Qorlla</a></p></body>');
});
app.get('/i18n.js', (req, res) => res.sendFile(path.join(__dirname, 'i18n.js')));
app.get('/locales/es.js', (req, res) => res.sendFile(path.join(__dirname, 'locales', 'es.js')));

app.get('/locales/fr.js', (req, res) => res.sendFile(path.join(__dirname, 'locales', 'fr.js')));
app.get('/locales/pt-PT.js', (req, res) => res.sendFile(path.join(__dirname, 'locales', 'pt-PT.js')));

// Public product assets only; the source and account data remain private.
// Where the public Meet site lives (MEET_PUBLIC_URL, e.g. https://meet.example.com). Empty = qorlla.html derives it.
// Where is Qorlla Meet (the full video app)? MEET_PUBLIC_URL when set; otherwise a Meet answering on this machine (MEET_PROBE_URL, default
// http://127.0.0.1:3000) is detected, so "New meeting" opens the current video page whenever Meet is running. Only a server that really is Meet
// qualifies (it must answer GET /api/config with { iceServers: [...] }); any other app on that port is ignored. MEET_DETECT=off disables the probe.
let meetProbe = { at: 0, port: 0 };
async function probeMeetPort() {
    if (process.env.MEET_DETECT === 'off') return 0;
    if (Date.now() - meetProbe.at < 4000) return meetProbe.port;
    let port = 0;
    try {
        const base = new URL(process.env.MEET_PROBE_URL || 'http://127.0.0.1:3000');
        if (Number(base.port || 80) !== Number(process.env.PORT || 5000)) {
            const r = await fetch(base.origin + '/api/config', { signal: AbortSignal.timeout(800) });
            const j = r.ok ? await r.json() : null;
            if (j && Array.isArray(j.iceServers)) port = Number(base.port || 80);
        }
    } catch (e) { /* nothing (or not Meet) there */ }
    meetProbe = { at: Date.now(), port };
    return port;
}
app.get('/meet-config.js', async (req, res) => {
    let url = '';
    try { const u = new URL(process.env.MEET_PUBLIC_URL || ''); if (/^https?:$/.test(u.protocol)) url = u.origin + '/'; } catch (e) { /* unset */ }
    if (!url) { const port = await probeMeetPort(); if (port) url = req.protocol + '://' + req.hostname + ':' + port + '/'; }
    res.set('Cache-Control', 'no-store').type('application/javascript').send('window.QORLLA_MEET_URL=' + JSON.stringify(url) + ';');
});
// Brand logo used by login.html
app.get('/Qorlla-Logo.jpg', (req, res) => res.sendFile(path.join(__dirname, 'Qorlla-Logo.jpg')));
// Browsers request /favicon.ico implicitly; answer with the brand icon instead of a 404
app.get('/favicon.ico', (req, res) => res.type('image/svg+xml').sendFile(path.join(__dirname, 'assets', 'favicon.svg')));
app.use('/assets', express.static(path.join(__dirname, 'assets'), { dotfiles: 'deny', index: false }));
