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

const app = express();
// Behind nginx (private network) so req.ip reflects the real client for sign-in throttling
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
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
app.use('/api/auth', auth.router);

// Workplace carries whiteboard images, so it parses its own (larger) JSON bodies
app.use('/api/workplace', require('./workplace')({
    dataDir: DATA_ROOT,
    allocateMeeting: (m) => allocateMeeting(m),
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

// --- Mount service files ---
const appointmentsRouter = require('./appointments');
const docsRouter = require('./docs');
const postMeetingRouter = require('./post-meeting');
const notificationsModule = require('./notifications');

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

app.post('/api/meetings/create', (req, res) => {
    const { topic, startTime, durationMinutes, hostId, timezone } = req.body;

    if (!topic || !hostId) {
        return res.status(400).json({ error: "Missing required topic or host registration identifier." });
    }

    const newMeeting = allocateMeeting({ topic, startTime, durationMinutes, hostId, timezone });

    return res.status(201).json({
        message: "Meeting room allocation successful.",
        meeting: newMeeting
    });
});

app.get('/api/meetings/validate/:meetingId', (req, res) => {
    const meeting = meetingsState.get(normalizeId(req.params.meetingId));
    if (!meeting || meeting.status === 'completed') {
        return res.status(404).json({ isValid: false, error: "Meeting resource code is invalid or has expired." });
    }

    return res.json({ isValid: true, topic: meeting.topic, status: meeting.status });
});

// ==========================================
// LIVE WEBRTC & WEBSOCKET ROOM FLOW
// ==========================================
// Meetings created by a signed-in account (hostId starts with u_) can only be hosted by that
// account's session; anonymous meetings keep the old client-supplied id comparison.
function isHostFor(socket, meeting, claimedUserId) {
    if (String(meeting.hostId).startsWith('u_')) {
        const account = auth.getUser(socket.request);
        return !!account && account.id === meeting.hostId;
    }
    return !!claimedUserId && claimedUserId === meeting.hostId;
}

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

        leaveCurrentRoom(socket);

        if (!activeRooms.has(cleanId)) {
            activeRooms.set(cleanId, new Map());
            currentMeeting.status = 'active';
        }

        const roomParticipants = activeRooms.get(cleanId);
        const safeName = String(userName || '').trim().slice(0, 60) || 'Anonymous User';

        roomParticipants.set(socket.id, {
            socketId: socket.id,
            userId,
            userName: safeName,
            // Role is derived from the meeting record, never from client input
            role: isHostFor(socket, currentMeeting, userId) ? 'host' : 'participant',
            media: { audio: false, video: false, sharing: false, hand: false },
            permissions: { audio: true, video: true, screenShare: true }
        });

        socket.join(cleanId);
        socket.currentRoom = cleanId;
        console.log(`[User Joined Room]: ${safeName} entered ${cleanId}`);

        io.to(cleanId).emit('room_state_updated', {
            meetingMetadata: currentMeeting,
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
        }
    });

    socket.on('disconnect', () => {
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
app.get('/i18n.js', (req, res) => res.sendFile(path.join(__dirname, 'i18n.js')));
app.get('/locales/es.js', (req, res) => res.sendFile(path.join(__dirname, 'locales', 'es.js')));

app.get('/locales/fr.js', (req, res) => res.sendFile(path.join(__dirname, 'locales', 'fr.js')));
app.get('/locales/pt-PT.js', (req, res) => res.sendFile(path.join(__dirname, 'locales', 'pt-PT.js')));

// Public product assets only; the source and account data remain private.
app.use('/assets', express.static(path.join(__dirname, 'assets'), { dotfiles: 'deny', index: false }));
