'use strict';
/**
 * Meeting-scoped guest sessions (v4.6.1).
 *
 * A guest is someone who joins a meeting without a Qorlla account. Knowing a meeting ID is not enough to act inside the
 * meeting: the server first validates eligibility, then issues an opaque, random, short-lived session bound to ONE meeting,
 * one display name, one role and a fixed capability list. The session travels in an HttpOnly, SameSite=Strict cookie, so page
 * script cannot read or forward it and a client can never choose its own meeting, role or capabilities.
 *
 *  - tokens are 256-bit random values; only their SHA-256 is kept server-side (a memory dump or log never yields a usable token)
 *  - the server never accepts a token from the client when issuing (no session fixation); an incoming guest cookie is revoked first
 *  - idle expiry (TTL) plus an absolute lifetime; refresh ROTATES the token, so a replayed old token fails
 *  - every lookup re-checks revocation, expiry and that the meeting still exists and has not ended (fails closed)
 *  - revocation by session, by meeting (host ended it) or by host removal; revoked sessions are disconnected by the onRevoke hook
 */
const crypto = require('crypto');

const COOKIE = 'qorlla_guest';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const TTL_MS = Number(process.env.GUEST_SESSION_TTL_MS) || 60 * 60 * 1000;
const MAX_LIFETIME_MS = Number(process.env.GUEST_SESSION_MAX_MS) || 8 * 60 * 60 * 1000;
const JOIN_GRACE_MS = 24 * 60 * 60 * 1000;          // invitation links stop working this long after the scheduled end
const MAX_SESSIONS_PER_MEETING = 500;

const CAPS = {
    participant: ['meeting:join', 'meeting:chat', 'meeting:media', 'docs:read', 'docs:upload', 'notifications:read'],
    host: ['meeting:join', 'meeting:chat', 'meeting:media', 'docs:read', 'docs:upload', 'notifications:read', 'meeting:admin', 'meeting:end', 'meeting:remove']
};

function cleanName(raw) {
    return String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function parseCookie(req, name) {
    const header = String((req && req.headers && req.headers.cookie) || '');
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return '';
}

/** Tiny fixed-window limiter keyed by client IP. In-memory: fine for one process, documented as such. */
function rateLimit(requested, windowMs = 60 * 1000, keyFn) {
    const max = Number(process.env.GUEST_RATE_LIMIT_MAX) || requested;      // tests raise the ceiling; production keeps the defaults
    const hits = new Map();
    const timer = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, windowMs);
    timer.unref();
    return (req, res, next) => {
        const now = Date.now(); const key = (keyFn ? keyFn(req) : req.ip) || 'unknown'; let h = hits.get(key);
        if (!h || h.reset <= now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
        if (++h.n > max) { res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000))); return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' }); }
        next();
    };
}

function createGuestSessions({ getMeeting, now = () => Date.now() }) {
    const byHash = new Map();
    const bySid = new Map();
    let onRevoke = () => {};

    function eligibility(meeting) {
        if (!meeting || meeting.status === 'completed') return false;
        if (meeting.allowGuests === false) return false;
        if (meeting.evergreen) return true;                                    // the seeded demo meeting never lapses
        const start = Date.parse(meeting.startTime); const dur = Number(meeting.durationMinutes) || 60;
        if (Number.isFinite(start) && now() > start + dur * 60000 + JOIN_GRACE_MS) return false;
        return true;
    }

    function purge(session, reason) {
        if (!session || session.revokedAt) return;
        session.revokedAt = now(); session.reason = reason;
        byHash.delete(session.tokenHash); bySid.delete(session.sid);
        try { onRevoke(session, reason); } catch (e) { console.error('[guest] revoke hook failed:', e.message); }
    }

    function live(session) {
        if (!session || session.revokedAt) return null;
        const t = now();
        if (t >= session.expiresAt || t >= session.maxExpiresAt) { purge(session, 'expired'); return null; }
        const meeting = getMeeting(session.meetingId);
        if (!meeting || meeting.status === 'completed') { purge(session, 'meeting_ended'); return null; }
        return session;
    }

    function mint(meetingId, name, role, sid, maxExpiresAt) {
        const token = crypto.randomBytes(32).toString('base64url');
        const t = now();
        const session = {
            sid: sid || crypto.randomUUID(), tokenHash: sha(token), meetingId, name, role, caps: CAPS[role].slice(),
            issuedAt: t, expiresAt: Math.min(t + TTL_MS, maxExpiresAt || t + MAX_LIFETIME_MS), maxExpiresAt: maxExpiresAt || t + MAX_LIFETIME_MS,
            revokedAt: null, reason: null, socketId: null
        };
        byHash.set(session.tokenHash, session); bySid.set(session.sid, session);
        return { token, session };
    }

    const api = {
        COOKIE, CAPS, eligibility,
        setRevokeHandler(fn) { onRevoke = fn; },
        fromRequest(req) {
            const token = parseCookie(req, COOKIE);
            return token ? live(byHash.get(sha(token))) : null;
        },
        get(sid) { return live(bySid.get(sid)); },
        issue({ meetingId, displayName, role = 'participant' }) {
            const name = cleanName(displayName);
            if (!name) throw Object.assign(new Error('A display name is required.'), { status: 400 });
            let count = 0; for (const s of bySid.values()) if (s.meetingId === meetingId) count++;
            if (count >= MAX_SESSIONS_PER_MEETING) throw Object.assign(new Error('This meeting is full.'), { status: 429 });
            return mint(meetingId, name, role === 'host' ? 'host' : 'participant');
        },
        /** Rotates the token; the session id, role and absolute deadline are preserved. */
        refresh(req) {
            const old = api.fromRequest(req); if (!old) return null;
            byHash.delete(old.tokenHash);
            const { token, session } = mint(old.meetingId, old.name, old.role, old.sid, old.maxExpiresAt);
            session.socketId = old.socketId; bySid.set(session.sid, session);
            return { token, session };
        },
        revokeSid(sid, reason = 'revoked') { purge(bySid.get(sid), reason); },
        revokeRequest(req, reason = 'signed_out') { const s = api.fromRequest(req); if (s) purge(s, reason); },
        revokeMeeting(meetingId, reason = 'meeting_ended') { for (const s of [...bySid.values()]) if (s.meetingId === meetingId) purge(s, reason); },
        sweep() { for (const s of [...bySid.values()]) live(s); },
        count() { return bySid.size; },
        cookieHeader(req, token, session) {
            const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
            const secure = req.secure || proto === 'https' ? ['Secure'] : [];
            const maxAge = token ? Math.max(0, Math.floor((session.expiresAt - now()) / 1000)) : 0;
            return [`${COOKIE}=${token || ''}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`, ...secure].join('; ');
        }
    };
    setInterval(api.sweep, 60 * 1000).unref();
    return api;
}

/**
 * Express router mounted at /api/guest.
 * deps: { express, sessions, getMeeting, getAccount(req), verifyHostKey(meeting, key) }
 */
function createGuestRouter({ express, sessions, getMeeting, getAccount, verifyHostKey, checkPasscode, admitAccount, handoff }) {
    const router = express.Router();
    const limit = rateLimit(30);
    const NOT_OPEN = { eligible: false, error: 'This meeting was not found, has ended, or is not open to guests.' };
    router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.use(express.json({ limit: '4kb' }));
    // Browsers that attach an Origin must be on our own host (cookie is SameSite=Strict as well; this is belt and braces)
    router.use((req, res, next) => {
        if (req.method === 'GET') return next();
        const origin = req.get('origin');
        if (origin) { let host = ''; try { host = new URL(origin).host; } catch (e) { /* malformed */ } if (host !== req.get('host')) return res.status(403).json({ error: 'Origin rejected.' }); }
        if (!req.is('application/json')) return res.status(415).json({ error: 'JSON body required.' });
        next();
    });
    const idOf = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 40);

    const denyPasscode = (res, pc) => {
        const lockedish = pc.status === 'locked' || pc.status === 'busy' || pc.status === 'rate_limited';
        const code = lockedish ? 429 : pc.status === 'unavailable' ? 503 : pc.status === 'invalid' ? 400 : 403;
        const error = lockedish ? 'Too many wrong passcodes. This meeting is locked for a while; ask the host.' : pc.status === 'unavailable' ? 'The passcode check is unavailable. Try again later.' : pc.status === 'invalid' ? 'That passcode is not valid.' : 'Incorrect passcode.';
        return res.status(code).json({ error, passcodeRequired: true });
    };

    router.post('/meetings/resolve', limit, (req, res) => {
        const meeting = getMeeting(idOf(req.body && req.body.meetingId));
        if (!sessions.eligibility(meeting)) return res.status(404).json(NOT_OPEN);
        res.json({ eligible: true, passcodeRequired: !!meeting.passcodeHash, meeting: { meetingId: meeting.meetingId, topic: meeting.topic, status: meeting.status, startsAt: meeting.startTime } });
    });

    router.post('/sessions', limit, async (req, res) => {
        const body = req.body || {};
        const meeting = getMeeting(idOf(body.meetingId));
        const account = getAccount(req);
        // A signed-in account needs no guest session; confirm the meeting is joinable and say so.
        if (account) {
            if (!meeting || meeting.status === 'completed') return res.status(404).json(NOT_OPEN);
            if (meeting.hostId !== account.id) {
                const pc = await checkPasscode(meeting, body.passcode, req);
                if (pc.required && !pc.ok) return denyPasscode(res, pc);
                admitAccount(meeting.meetingId, account.id);
            }
            const meetA = meeting.hostId !== account.id && handoff ? await handoff(meeting, { name: account.displayName || body.displayName || 'Guest' }, req) : null;
            return res.json({ kind: 'account', meeting: { meetingId: meeting.meetingId }, ...(meetA ? { meet: meetA } : {}) });
        }
        if (!sessions.eligibility(meeting)) return res.status(404).json(NOT_OPEN);
        const isHost = verifyHostKey(meeting, body.hostKey);
        if (!isHost) {                                                              // the host key bypasses the passcode; nobody else does
            const pc = await checkPasscode(meeting, body.passcode, req);
            if (pc.required && !pc.ok) return denyPasscode(res, pc);
        }
        sessions.revokeRequest(req, 'replaced');                                    // never reuse an incoming token
        const role = isHost ? 'host' : 'participant';
        let out;
        try { out = sessions.issue({ meetingId: meeting.meetingId, displayName: body.displayName, role }); }
        catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
        res.set('Set-Cookie', sessions.cookieHeader(req, out.token, out.session));
        const meetG = !isHost && handoff ? await handoff(meeting, { name: out.session.name }, req) : null;              // invitees enter the current Meet video page
        res.status(201).json({ kind: 'guest', session: view(out.session), ...(meetG ? { meet: meetG } : {}) });
    });

    router.post('/sessions/refresh', limit, (req, res) => {
        const out = sessions.refresh(req);
        if (!out) { res.set('Set-Cookie', sessions.cookieHeader(req, '', null)); return res.status(401).json({ error: 'Guest session expired or revoked.' }); }
        res.set('Set-Cookie', sessions.cookieHeader(req, out.token, out.session));
        res.json({ kind: 'guest', session: view(out.session) });
    });

    router.post('/sessions/revoke', (req, res) => {
        sessions.revokeRequest(req, 'signed_out');
        res.set('Set-Cookie', sessions.cookieHeader(req, '', null));
        res.status(204).end();
    });

    router.get('/sessions/me', (req, res) => {
        const account = getAccount(req);
        if (account) return res.json({ kind: 'account' });
        const s = sessions.fromRequest(req);
        if (!s) return res.status(401).json({ error: 'No active guest session.' });
        res.json({ kind: 'guest', session: view(s) });
    });

    function view(s) {
        return { meetingId: s.meetingId, displayName: s.name, role: s.role, capabilities: s.caps, expiresAt: new Date(s.expiresAt).toISOString(), maxExpiresAt: new Date(s.maxExpiresAt).toISOString() };
    }
    return router;
}

module.exports = { createGuestSessions, createGuestRouter, rateLimit, cleanName, CAPS, COOKIE, sha };
