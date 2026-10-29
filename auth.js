/**
 * Qorlla accounts: register / sign in / sign out, email verification, password reset by email,
 * single-use recovery codes, and password change. Mounted by server.js at /api/auth.
 *
 * Passwords are scrypt-hashed. Sessions are opaque random tokens in an HttpOnly cookie and are
 * stored only as SHA-256 hashes. Email/reset tokens are single-use, expire, and are also stored
 * only as hashes. Everything persists through store.js (encrypted at rest when ENCRYPT_KEY is set).
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const store = require('./store');
const createPortalTokens = require('./portal-token');

const COOKIE = 'qs';
const PORTAL_COOKIE = 'qorlla_portal_session';
const CSRF_COOKIE = 'qorlla_csrf';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{2,23}$/;
const CODE_COUNT = 10;
const HOUR = 60 * 60 * 1000;

module.exports = function createAuth({ dataDir, mailer, onAccountChange }) {
    // Tells the Security Shield / Numbers & Plans (through shield-bridge.js) who this account is now. Never throws into the request.
    const notify = (u) => { try { if (onAccountChange && u) onAccountChange({ id: u.id, verified: !!u.emailVerified, suspended: !!u.suspended }); } catch (e) { /* the bridge retries on its own */ } };
    const dir = path.join(dataDir, 'auth');
    const usersFile = path.join(dir, 'users.json');
    const sessionsFile = path.join(dir, 'sessions.json');
    const tokensFile = path.join(dir, 'tokens.json');
    const router = express.Router();
    router.use(express.json({ limit: '10kb' }));

    // Identity for the Workplace Portal (JWT in a cookie, verified by the portal via our JWKS). See portal-token.js.
    const originOf = (u) => { try { return new URL(u).origin; } catch (e) { return ''; } };
    const portalTokens = createPortalTokens({
        dataDir,
        issuer: process.env.MAIN_AUTH_ISSUER || originOf(process.env.PUBLIC_URL) || 'http://localhost:' + (process.env.PORT || 5000),
        audience: process.env.PORTAL_AUTH_AUDIENCE || 'qorlla-workplace'
    });

    const loadUsers = () => store.readJson(usersFile, []);
    const saveUsers = (u) => store.writeJson(usersFile, u);

    // ---------- helpers ----------
    const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
    const normEmail = (e) => String(e || '').trim().toLowerCase();
    const validEmail = (e) => mailer.isValidAddress(e);

    function checkPassword(pw, username) {
        if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
        if (pw.length > 200) return 'Password is too long.';
        if (username && pw.toLowerCase() === username) return 'Password cannot be the same as your username.';
        return null;
    }

    function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
    function verifyPassword(password, user) {
        const a = Buffer.from(hashPassword(password, user.salt), 'hex');
        const b = Buffer.from(user.hash, 'hex');
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    function setPassword(user, password) {
        user.salt = crypto.randomBytes(16).toString('hex');
        user.hash = hashPassword(password, user.salt);
    }

    const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
    const selfUser = (u) => ({
        ...publicUser(u),
        email: u.email || '',
        emailVerified: !!u.emailVerified,
        recoveryCodesRemaining: (u.recoveryCodes || []).filter((c) => !c.used).length
    });

    // Recovery codes: 16 hex chars (64 bits) shown once, stored as salted hashes, each usable once
    const normCode = (c) => String(c || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    const hashCode = (code, salt) => crypto.createHash('sha256').update(salt + ':' + normCode(code)).digest('hex');
    function newRecoveryCodes(user) {
        user.recoverySalt = crypto.randomBytes(16).toString('hex');
        const plain = Array.from({ length: CODE_COUNT }, () => crypto.randomBytes(8).toString('hex').match(/.{4}/g).join('-'));
        user.recoveryCodes = plain.map((c) => ({ hash: hashCode(c, user.recoverySalt), used: false }));
        return plain;
    }
    function useRecoveryCode(user, input) {
        if (normCode(input).length !== 16 || !user.recoverySalt) return false;
        const want = Buffer.from(hashCode(input, user.recoverySalt), 'hex');
        let hit = null;
        (user.recoveryCodes || []).forEach((c) => {
            if (c.used) return;
            const have = Buffer.from(c.hash, 'hex');
            if (have.length === want.length && crypto.timingSafeEqual(have, want)) hit = c;
        });
        if (!hit) return false;
        hit.used = true;
        return true;
    }

    // ---------- cookies & sessions ----------
    function parseCookies(req) {
        const out = {};
        String(req.headers.cookie || '').split(';').forEach((part) => {
            const i = part.indexOf('=');
            if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
        });
        return out;
    }
    // Secure when the site is configured for https, or when this very request arrived over https
    // (req.secure honours the proxy headers because server.js trusts private-network proxies)
    function setCookie(req, res, token, maxAgeMs) {
        const secure = ((process.env.PUBLIC_URL || '').startsWith('https://') || req.secure) ? ['Secure'] : [];
        res.setHeader('Set-Cookie', [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`, ...secure].join('; '));
    }
    function addCookie(req, res, name, value, maxAgeSec, httpOnly) {
        const secure = ((process.env.PUBLIC_URL || '').startsWith('https://') || req.secure) ? ['Secure'] : [];
        res.append('Set-Cookie', [`${name}=${value}`, 'Path=/', ...(httpOnly ? ['HttpOnly'] : []), 'SameSite=Lax', `Max-Age=${maxAgeSec}`, ...secure].join('; '));
    }
    function issuePortalCookies(req, res, userId, sid) {
        if (!portalTokens.subjectFor(userId)) return; // only real account ids get portal access
        const { jwt, csrf } = portalTokens.issue({ userId, sid });
        addCookie(req, res, PORTAL_COOKIE, jwt, portalTokens.TOKEN_TTL_S, true);
        addCookie(req, res, CSRF_COOKIE, csrf, portalTokens.TOKEN_TTL_S, false); // readable by page script on purpose (double-submit)
    }
    function clearPortalCookies(req, res) {
        addCookie(req, res, PORTAL_COOKIE, '', 0, true);
        addCookie(req, res, CSRF_COOKIE, '', 0, false);
    }
    function loadSessions() {
        const now = Date.now();
        const all = store.readJson(sessionsFile, {});
        return Object.fromEntries(Object.entries(all).filter(([, s]) => s.exp > now));
    }
    function startSession(req, res, userId) {
        const token = crypto.randomBytes(32).toString('hex');
        const sessions = loadSessions();
        sessions[sha(token)] = { userId, exp: Date.now() + SESSION_MS };
        store.writeJson(sessionsFile, sessions);
        setCookie(req, res, token, SESSION_MS);
        issuePortalCookies(req, res, userId, sha(token));
    }
    function dropSessions(userId, keepHash) {
        const sessions = loadSessions();
        Object.keys(sessions).forEach((h) => { if (sessions[h].userId === userId && h !== keepHash) delete sessions[h]; });
        store.writeJson(sessionsFile, sessions);
    }
    const currentHash = (req) => { const t = parseCookies(req)[COOKIE]; return t ? sha(t) : null; };

    function getUser(req) {
        const token = parseCookies(req)[COOKIE];
        if (!token) return null;
        const s = loadSessions()[sha(token)];
        if (!s) return null;
        const u = loadUsers().find((x) => x.id === s.userId) || null;
        return u && !u.suspended ? u : null;                                  // a suspended account has no usable session, wherever it is presented
    }
    function requireUser(req, res, next) {
        const user = getUser(req);
        if (!user) return res.status(401).json({ error: 'Please sign in.' });
        req.user = user;
        next();
    }

    // ---------- single-use email tokens ----------
    function loadTokens() { const now = Date.now(); return store.readJson(tokensFile, []).filter((t) => t.exp > now); }
    function issueToken(userId, purpose, ttlMs, extra) {
        const raw = crypto.randomBytes(32).toString('hex');
        const tokens = loadTokens().filter((t) => !(t.userId === userId && t.purpose === purpose));
        tokens.push({ hash: sha(raw), userId, purpose, exp: Date.now() + ttlMs, ...extra });
        store.writeJson(tokensFile, tokens);
        return raw;
    }
    function consumeToken(raw, purpose) {
        if (typeof raw !== 'string' || raw.length !== 64) return null;
        const tokens = loadTokens();
        const i = tokens.findIndex((t) => t.purpose === purpose && t.hash === sha(raw));
        if (i === -1) return null;
        const [entry] = tokens.splice(i, 1);
        store.writeJson(tokensFile, tokens);
        return entry;
    }
    function dropTokens(userId, purpose) {
        store.writeJson(tokensFile, loadTokens().filter((t) => !(t.userId === userId && (!purpose || t.purpose === purpose))));
    }

    // ---------- rate limiting ----------
    // Attempt times are saved to disk (through store.js, so encrypted when ENCRYPT_KEY is set), which
    // means restarting the server does NOT reset a lockout.
    const limitsFile = path.join(dir, 'limits.json');
    const limiters = {};
    let savedLimits = {};
    try { savedLimits = store.readJson(limitsFile, {}); } catch (err) { console.error('[Auth]: could not read saved rate limits:', err.message); }
    // Saved immediately on every change: these events are rare (failed attempts, reset requests), and a
    // crash or hard kill must not be able to erase the most recent failures.
    function flushLimits() {
        const out = {};
        Object.keys(limiters).forEach((name) => { out[name] = limiters[name].dump(); });
        try { store.writeJson(limitsFile, out); } catch (err) { console.error('[Auth]: could not save rate limits:', err.message); }
    }
    const scheduleFlush = flushLimits;

    function limiter(name, max, windowMs) {
        const hits = new Map();
        const now0 = Date.now();
        Object.entries(savedLimits[name] || {}).forEach(([key, times]) => {
            const live = (Array.isArray(times) ? times : []).filter((t) => now0 - t < windowMs);
            if (live.length) hits.set(key, live);
        });
        const recent = (key) => { const now = Date.now(); const l = (hits.get(key) || []).filter((t) => now - t < windowMs); if (l.length) hits.set(key, l); else hits.delete(key); return l; };
        const l = {
            blocked: (key) => recent(key).length >= max,
            record: (key) => { hits.set(key, recent(key).concat(Date.now())); scheduleFlush(); },
            clear: (key) => { hits.delete(key); scheduleFlush(); },
            dump: () => { const o = {}; Array.from(hits.keys()).forEach((k) => { const r = recent(k); if (r.length) o[k] = r; }); return o; }
        };
        limiters[name] = l;
        return l;
    }
    const loginLimit = limiter('login', 5, 15 * 60 * 1000);
    const recoverLimit = limiter('recover', 5, 15 * 60 * 1000);
    const pwLimit = limiter('password', 5, 15 * 60 * 1000);
    const forgotIpLimit = limiter('forgotIp', 5, HOUR);
    const forgotUserLimit = limiter('forgotUser', 3, HOUR);
    const mailLimit = limiter('mail', 5, HOUR);

    // ---------- email sending ----------
    async function sendVerification(user) {
        if (!mailer.enabled || !user.email) return { status: 'not_configured' };
        const token = issueToken(user.id, 'verify', VERIFY_TTL_MS, { email: user.email });
        return mailer.send({
            to: user.email, system: true, subject: 'Confirm your email for Qorlla',
            text: `Hi ${user.displayName},\n\nConfirm this email address for your Qorlla account (@${user.username}):\n\n${mailer.baseUrl}/login.html?verify=${token}\n\nThe link works once and expires in 24 hours. If you did not ask for this, ignore this email.`
        });
    }
    async function sendReset(user) {
        const token = issueToken(user.id, 'reset', RESET_TTL_MS);
        return mailer.send({
            to: user.email, system: true, subject: 'Reset your Qorlla password',
            text: `Hi ${user.displayName},\n\nSomeone asked to reset the password for @${user.username}. To choose a new one, open:\n\n${mailer.baseUrl}/login.html?reset=${token}\n\nThe link works once and expires in 1 hour. If this was not you, ignore this email and your password stays the same.`
        });
    }

    // ---------- routes ----------
    router.get('/config', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json({ emailEnabled: mailer.enabled, encryptedAtRest: store.enabled });
    });

    router.post('/register', async (req, res) => {
        const body = req.body || {};
        const username = String(body.username || '').trim().toLowerCase();
        const displayName = String(body.displayName || '').trim().slice(0, 60) || username;
        const password = typeof body.password === 'string' ? body.password : '';
        const email = normEmail(body.email);

        if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 3-24 characters: letters, numbers, dot, dash or underscore.' });
        const pwError = checkPassword(password, username);
        if (pwError) return res.status(400).json({ error: pwError });
        if (email && !validEmail(email)) return res.status(400).json({ error: 'That email address does not look valid.' });

        const users = loadUsers();
        if (users.some((u) => u.username === username)) return res.status(409).json({ error: 'That username is taken.' });

        const user = { id: 'u_' + uuidv4(), username, displayName, email, emailVerified: false, createdAt: new Date().toISOString() };
        setPassword(user, password);
        const recoveryCodes = newRecoveryCodes(user);
        users.push(user);
        saveUsers(users);
        startSession(req, res, user.id);
        notify(user);

        const verification = email ? (await sendVerification(user)).status : 'none';
        res.status(201).json({ user: selfUser(user), recoveryCodes, verificationEmail: verification });
    });

    router.post('/login', (req, res) => {
        const username = String((req.body && req.body.username) || '').trim().toLowerCase();
        const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
        const key = req.ip + '|' + username;
        if (loginLimit.blocked(key)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });

        const user = loadUsers().find((u) => u.username === username);
        // Always hash, so response time does not reveal whether the username exists
        const ok = user ? verifyPassword(password, user) : (hashPassword(password, 'x'.repeat(32)), false);
        if (!ok) { loginLimit.record(key); return res.status(401).json({ error: 'Wrong username or password.' }); }

        if (user.suspended) return res.status(403).json({ error: 'This account is suspended.' });
        loginLimit.clear(key);
        startSession(req, res, user.id);
        res.json({ user: selfUser(user) });
    });

    router.post('/logout', (req, res) => {
        const token = parseCookies(req)[COOKIE];
        if (token) {
            const sessions = loadSessions();
            delete sessions[sha(token)];
            store.writeJson(sessionsFile, sessions);
        }
        setCookie(req, res, '', 0);
        clearPortalCookies(req, res);
        res.json({ ok: true });
    });

    // Renew the 15-minute portal token while the MAIN session is alive (same-origin XHR from the portal / pricing page).
    router.post('/portal-token', (req, res) => {
        const origin = req.get('origin');
        if (origin && new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Origin rejected.' });
        const user = getUser(req);
        const token = parseCookies(req)[COOKIE];
        if (!user || !token) { clearPortalCookies(req, res); return res.status(401).json({ error: 'Sign in required.' }); }
        issuePortalCookies(req, res, user.id, sha(token));
        res.set('Cache-Control', 'no-store').json({ ok: true, expiresIn: portalTokens.TOKEN_TTL_S });
    });

    // Server-to-server: lets the portal confirm a session is still alive (logout / password change revoke at once).
    // Authenticated with PORTAL_INTROSPECTION_SECRET; the reverse proxy must NOT expose /api/auth/internal/ publicly.
    router.get('/internal/users/:uuid', (req, res) => {
        const expected = process.env.PORTAL_INTROSPECTION_SECRET || '';
        const given = (req.get('authorization') || '').replace(/^Bearer /, '');
        const ok = expected.length >= 32 && given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
        if (!ok) return res.status(401).json({ error: 'Unauthorized' });
        const u = loadUsers().find((x) => portalTokens.subjectFor(x.id) === String(req.params.uuid).toLowerCase());
        res.set('Cache-Control', 'no-store').json(u ? { displayName: u.displayName || u.username } : { displayName: null });
    });

    router.get('/internal/session/:sid', (req, res) => {
        const expected = process.env.PORTAL_INTROSPECTION_SECRET || '';
        const given = (req.get('authorization') || '').replace(/^Bearer /, '');
        const ok = expected.length >= 32 && given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
        if (!ok) return res.status(401).json({ error: 'Unauthorized' });
        const s = loadSessions()[String(req.params.sid)];
        res.set('Cache-Control', 'no-store').json({ active: !!s, sub: s ? portalTokens.subjectFor(s.userId) : null });
    });

    router.get('/me', (req, res) => {
        const user = getUser(req);
        res.set('Cache-Control', 'no-store');
        res.json({ user: user ? selfUser(user) : null });
    });

    router.patch('/me', requireUser, (req, res) => {
        const displayName = String((req.body && req.body.displayName) || '').trim().slice(0, 60);
        if (!displayName) return res.status(400).json({ error: 'Display name is required.' });
        const users = loadUsers();
        const u = users.find((x) => x.id === req.user.id);
        u.displayName = displayName;
        saveUsers(users);
        res.json({ user: selfUser(u) });
    });

    // Re-check the password for sensitive actions, with its own attempt limit
    function confirmPassword(req, res) {
        const key = 'pw|' + req.user.id;
        if (pwLimit.blocked(key)) { res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' }); return false; }
        const pw = req.body && req.body.currentPassword;
        if (typeof pw !== 'string' || !verifyPassword(pw, req.user)) {
            pwLimit.record(key);
            res.status(401).json({ error: 'Your current password is wrong.' });
            return false;
        }
        pwLimit.clear(key);
        return true;
    }

    router.post('/password', requireUser, (req, res) => {
        if (!confirmPassword(req, res)) return;
        const err = checkPassword(req.body && req.body.password, req.user.username);
        if (err) return res.status(400).json({ error: err });
        const users = loadUsers();
        const u = users.find((x) => x.id === req.user.id);
        setPassword(u, req.body.password);
        saveUsers(users);
        dropSessions(u.id, currentHash(req)); // sign out every other device
        res.json({ ok: true });
    });

    router.post('/email', requireUser, async (req, res) => {
        if (!confirmPassword(req, res)) return;
        const email = normEmail(req.body && req.body.email);
        if (email && !validEmail(email)) return res.status(400).json({ error: 'That email address does not look valid.' });
        const users = loadUsers();
        const u = users.find((x) => x.id === req.user.id);
        u.email = email;
        u.emailVerified = false; notify(u);
        saveUsers(users);
        dropTokens(u.id, 'verify');
        let sent = 'none';
        if (email) {
            if (mailLimit.blocked(u.id)) return res.status(429).json({ error: 'Too many emails requested. Try again later.', user: selfUser(u) });
            mailLimit.record(u.id);
            sent = (await sendVerification(u)).status;
        }
        res.json({ user: selfUser(u), verificationEmail: sent });
    });

    router.post('/verify/resend', requireUser, async (req, res) => {
        if (!mailer.enabled) return res.status(503).json({ error: 'Email is not set up on this server.' });
        if (!req.user.email) return res.status(400).json({ error: 'Add an email address first.' });
        if (req.user.emailVerified) return res.json({ ok: true, alreadyVerified: true });
        if (mailLimit.blocked(req.user.id)) return res.status(429).json({ error: 'Too many emails requested. Try again later.' });
        mailLimit.record(req.user.id);
        const r = await sendVerification(req.user);
        if (r.status !== 'sent') return res.status(502).json({ error: 'The verification email could not be sent.' });
        res.json({ ok: true });
    });

    router.post('/verify', (req, res) => {
        const entry = consumeToken(req.body && req.body.token, 'verify');
        if (!entry) return res.status(400).json({ error: 'This link is invalid or has expired. Request a new one from Settings.' });
        const users = loadUsers();
        const u = users.find((x) => x.id === entry.userId);
        if (!u || u.email !== entry.email) return res.status(400).json({ error: 'This link is no longer valid for your account.' });
        if (users.some((x) => x.id !== u.id && x.emailVerified && x.email === u.email)) {
            return res.status(409).json({ error: 'That email address is already verified on another account.' });
        }
        u.emailVerified = true;
        saveUsers(users);
        notify(u);
        res.json({ ok: true, username: u.username });
    });

    // Always answers the same way, whether or not the account exists
    router.post('/forgot', (req, res) => {
        if (!mailer.enabled) return res.status(503).json({ error: 'Email is not set up on this server. Use a recovery code instead.' });
        if (forgotIpLimit.blocked(req.ip)) return res.status(429).json({ error: 'Too many requests. Try again later.' });
        forgotIpLimit.record(req.ip);
        const id = String((req.body && req.body.identifier) || '').trim().toLowerCase();
        res.json({ ok: true });
        if (!id) return;
        // Work happens after the reply so response time does not reveal anything
        setImmediate(async () => {
            try {
                const users = loadUsers();
                const user = users.find((u) => u.username === id) || users.find((u) => u.emailVerified && u.email === id);
                if (!user || !user.emailVerified || !user.email) return;
                if (forgotUserLimit.blocked(user.id)) return;
                forgotUserLimit.record(user.id);
                await sendReset(user);
            } catch (err) { console.error('[Auth]: reset email failed:', err.message); }
        });
    });

    function finishReset(user, password) {
        setPassword(user, password);
        dropSessions(user.id);
        dropTokens(user.id, 'reset');
    }

    router.post('/reset', (req, res) => {
        const body = req.body || {};
        const pwErr = checkPassword(body.password);
        if (pwErr) return res.status(400).json({ error: pwErr });
        const entry = consumeToken(body.token, 'reset');
        if (!entry) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
        const users = loadUsers();
        const u = users.find((x) => x.id === entry.userId);
        if (!u) return res.status(400).json({ error: 'This reset link is no longer valid.' });
        finishReset(u, body.password);
        saveUsers(users);
        res.json({ ok: true, username: u.username });
    });

    // Works on servers without email: a single-use recovery code from sign-up
    router.post('/recover', (req, res) => {
        const body = req.body || {};
        const username = String(body.username || '').trim().toLowerCase();
        const key = req.ip + '|' + username;
        if (recoverLimit.blocked(key)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
        const pwErr = checkPassword(body.password, username);
        if (pwErr) return res.status(400).json({ error: pwErr });

        const users = loadUsers();
        const u = users.find((x) => x.username === username);
        if (!u || !useRecoveryCode(u, body.code)) {
            recoverLimit.record(key);
            return res.status(401).json({ error: 'That username and recovery code do not match.' });
        }
        recoverLimit.clear(key);
        finishReset(u, body.password);
        saveUsers(users);
        res.json({ ok: true, username: u.username, recoveryCodesRemaining: u.recoveryCodes.filter((c) => !c.used).length });
    });

    router.post('/recovery-codes', requireUser, (req, res) => {
        if (!confirmPassword(req, res)) return;
        const users = loadUsers();
        const u = users.find((x) => x.id === req.user.id);
        const codes = newRecoveryCodes(u);
        saveUsers(users);
        res.json({ recoveryCodes: codes });
    });

    // Account directory for starting chats (signed-in users only; never exposes email)
    router.get('/users', requireUser, (req, res) => {
        const q = String(req.query.q || '').trim().toLowerCase();
        const list = loadUsers()
            .filter((u) => !q || u.username.includes(q) || u.displayName.toLowerCase().includes(q))
            .slice(0, 20)
            .map(publicUser);
        res.json(list);
    });

    router.use((err, req, res, next) => {
        if (err instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON.' });
        console.error('[Auth]:', err);
        res.status(500).json({ error: 'Server error.' });
    });

    /** Suspends or restores an account: a suspended account is signed out everywhere at once and cannot sign in. Returns false if there is no such account. */
    function setSuspended(userId, suspended) {
        const users = loadUsers(), u = users.find((x) => x.id === userId); if (!u) return false;
        u.suspended = !!suspended; saveUsers(users); if (suspended) dropSessions(userId); notify(u); return true;
    }
    return { router, portalTokens, setSuspended, allAccounts: () => loadUsers().map((u) => ({ id: u.id, verified: !!u.emailVerified, suspended: !!u.suspended })), getUser, requireUser, listUsers: () => loadUsers().map(publicUser), getUserById: (id) => { const u = loadUsers().find((y) => y.id === id); return u ? selfUser(u) : null; } };
};
