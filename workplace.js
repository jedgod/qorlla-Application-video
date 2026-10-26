/**
 * Qorlla Workplace REST services: mail, whiteboards, calendar, schedule, notes and chat.
 * Mounted by server.js under /api/workplace. Everything requires a signed-in account.
 * Mail, whiteboards, calendar, schedule and notes are PRIVATE to each account: one JSON
 * file per user and collection (DATA_DIR/workplace/<collection>.<userId>.json), seeded from
 * ./seed the first time that user touches the collection. Chat is shared by design.
 */

const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const store = require('./store');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_IMAGE_CHARS = 6 * 1024 * 1024;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const nowIso = () => new Date().toISOString();

module.exports = function createWorkplaceRouter({ dataDir, allocateMeeting, auth, mailer, notify }) {
    const dir = path.join(dataDir, 'workplace');
    const seedDir = path.join(__dirname, 'seed');
    const router = express.Router();

    // Whiteboard saves are PNG data URLs, so this router needs a larger body limit
    router.use(express.json({ limit: '8mb' }));

    const { requireUser, listUsers } = auth;

    // Real-time nudge: tells these accounts' open pages that something changed so they re-fetch.
    // It carries no message content, so nothing private travels over the socket.
    const ping = (userIds, event, payload) => {
        if (typeof notify !== 'function') return;
        try { notify(Array.from(new Set(userIds)), event || 'chat_changed', payload || {}); } catch (err) { /* never break a request over a push */ }
    };

    // ---------- storage ----------
    function file(name) { return path.join(dir, name + '.json'); }

    // `key` is the file name (e.g. "mail.u_123"); `seedName` picks the starter data for it.
    // Reads go through store.js: encrypted when ENCRYPT_KEY is set, and an unreadable file throws
    // instead of being mistaken for an empty one.
    function load(key, seedName) {
        const existing = store.readJson(file(key), null);
        if (existing !== null) return existing;
        let seeded;
        try {
            seeded = JSON.parse(fs.readFileSync(path.join(seedDir, (seedName || key) + '.json'), 'utf8'));
        } catch (err) {
            return [];
        }
        save(key, seeded);
        return seeded;
    }

    function save(key, items) {
        store.writeJson(file(key), items);
    }

    // Account ids come from our own users file, but never let one reach the filesystem unchecked
    const SAFE_ID = /^u_[0-9a-f-]{36}$/;
    function userKey(name, user) {
        if (!SAFE_ID.test(user.id)) throw new Error('Invalid account id.');
        return name + '.' + user.id;
    }

    const bad = (res, message) => res.status(400).json({ error: message });
    const missing = (res) => res.status(404).json({ error: 'Not found.' });

    // Passcode from an authenticated request body (never a URL): undefined = leave as is, '' or null = clear, else bcrypt hash
    function passcodeChange(body) {
        if (!('passcode' in body)) return {};
        if (body.passcode === null || body.passcode === '') return { hash: null };
        if (typeof body.passcode !== 'string' || body.passcode.length < 8 || body.passcode.length > 128) return { error: 'Passcode must be 8-128 characters.' };
        return { hash: bcrypt.hashSync(body.passcode, 10) };
    }

    // ---------- Qorlla Meet sync (PostgreSQL outbox) ----------
    const meetSync = (() => {
        const enabled = !!(process.env.DATABASE_URL && process.env.QORLLA_BRIDGE_SECRET);
        if (!enabled) return { enabled: false };
        const { Pool } = require('pg');
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        const store = () => import('./meet-sync/src/store.mjs');
        const isoOf = (s) => {
            const t = new Date(`${s.date}T${s.time}:00`);
            return isNaN(t) ? null : t.toISOString();
        };
        const failed = (err) => { console.error('Meet sync failed:', err.message); return new Error('Could not queue the meeting for Qorlla Meet. Try again shortly.'); };
        return {
            enabled: true,
            async save(s, ownerName, legacyId, passcodeHash, ownerUserId) {
                try {
                    const { saveSchedule } = await store();
                    await saveSchedule(pool, {
                        sourceId: s.id, legacyCode: String(legacyId).replace(/\D/g, ''),
                        title: s.title, ownerName: ownerName || 'Host', scheduledAt: isoOf(s), passcodeHash, ownerUserId: String(ownerUserId || '').replace(/^u_/, '')
                    });
                } catch (err) { throw failed(err); }
            },
            async cancel(sourceId) {
                try {
                    const { cancelScheduleLocal } = await store();
                    await cancelScheduleLocal(pool, sourceId);
                } catch (err) { throw failed(err); }
            },
            // Attach sync status; anything MAIN never registered is 'unregistered' (not joinable)
            async decorate(items) {
                if (!items.length) return items;
                const { rows } = await pool.query(
                    'SELECT source_id, status, meet_code FROM qorlla_schedules WHERE source_id = ANY($1)', [items.map((i) => i.id)]);
                const byId = new Map(rows.map((r) => [r.source_id, r]));
                return items.map((i) => {
                    const r = byId.get(i.id);
                    return { ...i, syncStatus: r ? r.status : 'unregistered', meetCode: r && r.status === 'synced' ? r.meet_code : undefined };
                });
            }
        };
    })();

    // Generic helpers: each collection supplies sanitize(body, existing) -> {value} | {error}
    function crud(name, { sanitize, create, update, sort, afterUpdate, beforeDelete, decorate }) {
        const base = '/' + name;
        const mine = (req) => userKey(name, req.user);

        router.get(base, requireUser, async (req, res) => {
            const items = load(mine(req), name);
            const sorted = sort ? items.slice().sort(sort) : items;
            if (!decorate) return res.json(sorted);
            try { res.json(await decorate(sorted)); } catch (err) { console.error('Decorate failed:', err.message); res.status(502).json({ error: 'Meeting status unavailable.' }); }
        });

        if (create) {
            router.post(base, requireUser, async (req, res) => {
                const out = sanitize(req.body || {}, null);
                if (out.error) return bad(res, out.error);
                const items = load(mine(req), name);
                let item = { id: uuidv4(), ...out.value };
                try {
                    item = await create(item, req.body || {}, req.user);
                } catch (err) {
                    return bad(res, err.message);
                }
                items.unshift(item);
                save(mine(req), items);
                res.status(201).json(item);
            });
        }

        if (update) {
            const handler = async (req, res) => {
                const items = load(mine(req), name);
                const idx = items.findIndex((i) => i.id === req.params.id);
                if (idx === -1) return missing(res);
                const out = sanitize(req.body || {}, items[idx]);
                if (out.error) return bad(res, out.error);
                const next = { ...items[idx], ...out.value, updatedAt: nowIso() };
                if (afterUpdate) {
                    try { await afterUpdate(next, items[idx], req.user, req.body || {}); } catch (err) { return res.status(502).json({ error: err.message }); }
                }
                items[idx] = next;
                save(mine(req), items);
                res.json(items[idx]);
            };
            router.put(base + '/:id', requireUser, handler);
            router.patch(base + '/:id', requireUser, handler);
        }

        router.delete(base + '/:id', requireUser, async (req, res) => {
            const items = load(mine(req), name);
            const next = items.filter((i) => i.id !== req.params.id);
            if (next.length === items.length) return missing(res);
            if (beforeDelete) {
                try { await beforeDelete(items.find((i) => i.id === req.params.id), req.user); } catch (err) { return res.status(502).json({ error: err.message }); }
            }
            save(mine(req), next);
            res.json({ ok: true });
        });
    }

    // ---------- external email ----------
    // Only accounts with a VERIFIED email may send outside, which keeps this from becoming an open
    // relay, and each account has a daily cap (MAIL_DAILY_LIMIT, default 20).
    const DAILY_LIMIT = Math.max(1, parseInt(process.env.MAIL_DAILY_LIMIT, 10) || 20);
    const quotaFile = () => file('extquota');
    const today = () => new Date().toISOString().slice(0, 10);

    async function sendExternal(addresses, item, user) {
        if (!addresses.length) return [];
        if (!mailer.enabled) return addresses.map((to) => ({ to, status: 'not_configured' }));
        if (!user.emailVerified || !user.email) return addresses.map((to) => ({ to, status: 'verify_email_first' }));

        const quota = store.readJson(quotaFile(), {});
        const q = quota[user.id] && quota[user.id].day === today() ? quota[user.id] : { day: today(), count: 0 };
        const results = [];
        const jobs = [];
        addresses.forEach((to) => {
            if (!mailer.isValidAddress(to)) { results.push({ to, status: 'invalid_address' }); return; }
            if (q.count >= DAILY_LIMIT) { results.push({ to, status: 'limit_reached' }); return; }
            q.count++;
            jobs.push(mailer.send({
                to,
                subject: item.subject,
                replyTo: user.email,
                text: item.body + '\n\n--\nSent by ' + user.displayName + ' (@' + user.username + ') through Qorlla Workplace. Replying to this email reaches ' + user.email + '.'
            }).then((r) => results.push({ to, status: r.status, ...(r.error ? { error: r.error } : {}) })));
        });
        await Promise.all(jobs);
        quota[user.id] = q;
        store.writeJson(quotaFile(), quota);
        return addresses.map((to) => results.find((r) => r.to === to)).filter(Boolean);
    }

    // ---------- MAIL ----------
    const FOLDERS = new Set(['inbox', 'sent', 'trash']);
    crud('mail', {
        sort: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
        sanitize(body, existing) {
            if (existing) {
                // Only flags and folder can change after a message exists
                const v = {};
                if ('read' in body) v.read = !!body.read;
                if ('starred' in body) v.starred = !!body.starred;
                if ('folder' in body) {
                    if (!FOLDERS.has(body.folder)) return { error: 'Unknown folder.' };
                    v.folder = body.folder;
                }
                return { value: v };
            }
            const subject = str(body.subject, 200);
            const text = str(body.body, 10000);
            if (!subject) return { error: 'Subject is required.' };
            if (!text) return { error: 'Message body is required.' };
            return {
                value: {
                    subject,
                    from: '',
                    to: str(body.to, 300),
                    body: text,
                    folder: 'sent',
                    read: true,
                    starred: false,
                    createdAt: nowIso()
                }
            };
        },
        // Sender identity comes from the session. Recipients that are Qorlla usernames
        // (optionally written ann@qorlla.local) get a copy in their own inbox. Other valid
        // email addresses are sent through the configured SMTP server (see sendExternal).
        create: async (item, body, user) => {
            item.from = user.displayName + ' (@' + user.username + ')';
            const accounts = listUsers();
            const tokens = String(item.to || '').split(/[,;\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 10);
            const delivered = [], unknown = [], outside = [];
            tokens.forEach((t) => {
                const uname = t.toLowerCase().replace(/@qorlla\.local$/, '');
                const target = accounts.find((a) => a.username === uname);
                if (target) {
                    if (delivered.includes(target.username)) return;
                    const key = userKey('mail', target);
                    const inbox = load(key, 'mail');
                    inbox.unshift({ id: uuidv4(), subject: item.subject, from: item.from, to: item.to, body: item.body, folder: 'inbox', read: false, starred: false, createdAt: nowIso() });
                    save(key, inbox);
                    delivered.push(target.username);
                    ping([target.id], 'mail_changed');
                } else if (t.includes('@')) {
                    if (!outside.some((o) => o.toLowerCase() === t.toLowerCase())) outside.push(t);
                } else {
                    unknown.push(t);
                }
            });
            const external = await sendExternal(outside, item, user);
            const undeliverable = unknown.concat(external.filter((e) => e.status !== 'sent').map((e) => e.to));
            return { ...item, delivered, external, undeliverable };
        },
        update: true
    });

    // ---------- WHITEBOARD ----------
    crud('whiteboard', {
        sort: (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
        sanitize(body, existing) {
            const value = {};
            if (!existing || 'name' in body) {
                value.name = str(body.name, 120) || 'Untitled board';
            }
            if (!existing || 'data' in body) {
                const data = typeof body.data === 'string' ? body.data : '';
                if (data && !data.startsWith('data:image/png;base64,')) return { error: 'Board data must be a PNG data URL.' };
                if (data.length > MAX_IMAGE_CHARS) return { error: 'Board image is too large.' };
                value.data = data;
            }
            return { value };
        },
        create: async (item) => ({ ...item, updatedAt: nowIso() }),
        update: true
    });

    // ---------- CALENDAR ----------
    crud('calendar', {
        sort: (a, b) => (a.date + a.start).localeCompare(b.date + b.start),
        sanitize(body, existing) {
            const v = {
                title: 'title' in body || !existing ? str(body.title, 200) : existing.title,
                date: 'date' in body || !existing ? str(body.date, 10) : existing.date,
                start: 'start' in body || !existing ? str(body.start, 5) : existing.start,
                end: 'end' in body || !existing ? str(body.end, 5) : existing.end,
                host: 'host' in body || !existing ? str(body.host, 120) : existing.host
            };
            if (!v.title) return { error: 'Title is required.' };
            if (!DATE_RE.test(v.date)) return { error: 'Date must be YYYY-MM-DD.' };
            if (!TIME_RE.test(v.start) || !TIME_RE.test(v.end)) return { error: 'Start and end must be HH:MM.' };
            if (v.end <= v.start) return { error: 'End time must be after the start time.' };
            return { value: v };
        },
        create: async (item, body, user) => ({ ...item, host: item.host || user.displayName }),
        update: true
    });

    // ---------- SCHEDULE (creates a real meeting room) ----------
    crud('schedule', {
        sort: (a, b) => (a.date + a.time).localeCompare(b.date + b.time),
        sanitize(body, existing) {
            const v = {
                title: 'title' in body || !existing ? str(body.title, 200) : existing.title,
                date: 'date' in body || !existing ? str(body.date, 10) : existing.date,
                time: 'time' in body || !existing ? str(body.time, 5) : existing.time,
                duration: 'duration' in body || !existing ? Math.round(Number(body.duration)) : existing.duration
            };
            if (!v.title) return { error: 'Meeting title is required.' };
            if (!DATE_RE.test(v.date)) return { error: 'Date must be YYYY-MM-DD.' };
            if (!TIME_RE.test(v.time)) return { error: 'Time must be HH:MM.' };
            if (!Number.isFinite(v.duration) || v.duration < 1 || v.duration > 1440) return { error: 'Duration must be 1-1440 minutes.' };
            return { value: v };
        },
        update: true,
        // Meet sync (PostgreSQL outbox, see meet-sync/): enabled when DATABASE_URL and QORLLA_BRIDGE_SECRET are set.
        // Schedules start as pending_sync; a background worker registers them with Meet. Join is only offered once synced.
        afterUpdate: async (next, prev, user, body) => {
            if (!meetSync.enabled) return;
            const pc = passcodeChange(body);
            if (pc.error) throw new Error(pc.error);
            if (next.title === prev.title && next.date === prev.date && next.time === prev.time && pc.hash === undefined) return;
            await meetSync.save(next, prev.ownerName || '', prev.meetingId, pc.hash, prev.hostId);
            if (pc.hash !== undefined) next.hasPasscode = !!pc.hash;
        },
        beforeDelete: async (item) => {
            if (!meetSync.enabled || !item) return;
            await meetSync.cancel(item.id);
        },
        decorate: async (items) => (meetSync.enabled ? meetSync.decorate(items) : items),
        create: async (item, body, user) => {
            const startTime = new Date(`${item.date}T${item.time}:00`);
            const meeting = allocateMeeting({
                topic: item.title,
                startTime: isNaN(startTime) ? undefined : startTime.toISOString(),
                durationMinutes: item.duration,
                hostId: user.id
            });
            const out = { ...item, hostId: user.id, ownerName: user.displayName, meetingId: meeting.meetingId, createdAt: nowIso() };
            const pc = passcodeChange(body);
            if (pc.error) throw new Error(pc.error);
            if (pc.hash && !meetSync.enabled) throw new Error('Passcodes need Qorlla Meet sync to be enabled.');
            if (meetSync.enabled) {
                await meetSync.save(out, user.displayName, meeting.meetingId, pc.hash, user.id);
                out.syncStatus = 'pending_sync';
                out.hasPasscode = !!pc.hash;
            }
            return out;
        }
    });

    // ---------- NOTES ----------
    crud('notes', {
        sort: (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || String(b.updatedAt).localeCompare(String(a.updatedAt)),
        sanitize(body, existing) {
            const v = {
                title: 'title' in body || !existing ? str(body.title, 200) : existing.title,
                content: 'content' in body || !existing ? str(body.content, 50000) : existing.content,
                pinned: 'pinned' in body ? !!body.pinned : existing ? !!existing.pinned : false
            };
            if (!v.title && !v.content) return { error: 'A note needs a title or some content.' };
            if (!v.title) v.title = 'Untitled';
            return { value: v };
        },
        create: async (item) => ({ ...item, updatedAt: nowIso() }),
        update: true
    });

    // ---------- CHAT ----------
    // Conversations: { id, type: dm|channel|space|meeting, name, public, autoJoin, createdBy,
    //   members: [userId], reads: { userId: iso }, messages: [...] }.
    // Per-user state (starred, folders, installed apps) lives in chatprefs.
    // History: each chat keeps its newest CHAT_MAX_MESSAGES (50-5000, default 500) in the live file. Older
    // messages are moved to a per-chat archive (workplace/chatarchive/<chatId>.json, encrypted like everything
    // else) in batches, so nothing is lost and the live file stays small. The page shows the latest 200 and
    // can page further back through the archive.
    const MAX_MESSAGES = Math.min(5000, Math.max(50, parseInt(process.env.CHAT_MAX_MESSAGES, 10) || 500));
    const ARCHIVE_BATCH = Math.max(5, Math.min(50, Math.ceil(MAX_MESSAGES * 0.1)));
    const SAFE_CHAT_ID = /^[A-Za-z0-9-]{1,64}$/;
    const archiveKey = (chatId) => 'chatarchive/' + chatId;

    function trimHistory(chat) {
        if (chat.messages.length <= MAX_MESSAGES + ARCHIVE_BATCH) return;
        const overflow = chat.messages.slice(0, chat.messages.length - MAX_MESSAGES);
        if (SAFE_CHAT_ID.test(chat.id)) {
            // Archive first, then trim: a crash in between leaves a harmless duplicate (de-duplicated on read)
            const old = store.readJson(file(archiveKey(chat.id)), []);
            store.writeJson(file(archiveKey(chat.id)), old.concat(overflow));
            chat.archived = (chat.archived || 0) + overflow.length;
        }
        chat.messages = chat.messages.slice(-MAX_MESSAGES);
    }
    function dropArchive(chatId) {
        if (!SAFE_CHAT_ID.test(chatId)) return;
        try { fs.unlinkSync(file(archiveKey(chatId))); } catch (err) { /* none to remove */ }
    }
    const REMINDER_MIN_MS = Math.max(1, parseInt(process.env.REMINDER_MIN_SECONDS, 10) || 30) * 1000;
    const REMINDER_MAX_MS = 30 * 24 * 60 * 60 * 1000;
    const REMINDER_PER_USER = 20;
    const APPS = [
        { id: 'meeting-bot', name: 'Meeting Bot', command: '/meet', description: 'Type /meet (optionally followed by a topic) to create a video room and post its meeting ID with a Join button.' },
        { id: 'dice-roller', name: 'Dice Roller', command: '/roll', description: 'Type /roll 2d6 (or /roll d20) to roll dice in the chat.' },
        { id: 'poll-bot', name: 'Polls', command: '/poll', description: 'Type /poll Question | Option 1 | Option 2 (2 to 6 options) to start a poll everyone in the chat can vote in.' },
        { id: 'reminder-bot', name: 'Reminders', command: '/remind', description: 'Type /remind 10m take a break (units s, m, h, d) and the bot mentions you in this chat when it is time.' }
    ];
    const userMap = () => new Map(listUsers().map((u) => [u.id, u]));

    function prefsFor(prefs, userId) {
        let p = prefs.find((x) => x.userId === userId);
        if (!p) { p = { userId, starred: [], folders: [], apps: [], setup: false }; prefs.push(p); }
        return p;
    }

    // First request after sign-up: personal "you" chat + the default channels, with no unread backlog
    function ensureSetup(user) {
        const chats = load('chat');
        const prefs = load('chatprefs');
        const p = prefsFor(prefs, user.id);
        if (p.setup) return;
        const now = nowIso();
        chats.forEach((c) => {
            if (c.autoJoin && !c.members.includes(user.id)) { c.members.push(user.id); c.reads[user.id] = now; }
        });
        let self = chats.find((c) => c.type === 'dm' && c.members.length === 1 && c.members[0] === user.id);
        if (!self) {
            self = { id: uuidv4(), type: 'dm', name: '', public: false, createdBy: user.id, createdAt: now, members: [user.id], reads: { [user.id]: now }, messages: [] };
            chats.push(self);
        }
        if (!p.starred.includes(self.id)) p.starred.push(self.id);
        p.setup = true;
        save('chat', chats);
        save('chatprefs', prefs);
    }

    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mentionsUser = (text, username) => new RegExp('(^|\\W)@' + escapeRe(username) + '(?![\\w.-])', 'i').test(text);

    // Polls keep who-voted-what on the server; clients only see counts and their own choice
    function publicMessage(m, meId, archived) {
        if (!m.poll) return archived ? { ...m, archived: true } : m;
        const votes = m.poll.votes || {};
        const counts = m.poll.options.map(() => 0);
        Object.keys(votes).forEach((uid) => { if (counts[votes[uid]] !== undefined) counts[votes[uid]]++; });
        return {
            ...m,
            poll: {
                question: m.poll.question,
                options: m.poll.options.map((o, i) => ({ text: o.text, count: counts[i] })),
                total: counts.reduce((a, b) => a + b, 0),
                myVote: Number.isInteger(votes[meId]) ? votes[meId] : null,
                closed: !!m.poll.closed || !!archived,
                mine: m.poll.createdBy === meId
            },
            ...(archived ? { archived: true } : {})
        };
    }

    function project(c, me, p, users) {
        const others = c.members.filter((id) => id !== me.id);
        const readAt = Date.parse(c.reads[me.id] || 0) || 0;
        const unread = c.messages.filter((m) => m.userId !== me.id && Date.parse(m.at) > readAt);
        const folder = p.folders.find((f) => f.chatIds.includes(c.id));
        const last = c.messages[c.messages.length - 1];
        return {
            id: c.id,
            type: c.type,
            name: c.type === 'dm'
                ? (others.length ? (users.get(others[0]) || { displayName: 'Former member' }).displayName : me.displayName + ' (You)')
                : c.name,
            public: !!c.public,
            canDelete: c.type !== 'dm' && c.createdBy === me.id,
            starred: p.starred.includes(c.id),
            folderId: folder ? folder.id : null,
            unread: unread.length,
            mentions: unread.filter((m) => mentionsUser(m.text, me.username)).length,
            lastAt: last ? last.at : c.createdAt,
            members: c.members.map((id) => users.get(id)).filter(Boolean).map((u) => ({ username: u.username, displayName: u.displayName })),
            hasEarlier: (c.archived || 0) > 0 || c.messages.length > 200,
            messages: c.messages.slice(-200).map((m) => publicMessage(m, me.id))
        };
    }

    const memberOf = (c, user) => !!c && c.members.includes(user.id);
    const userByName = (name) => listUsers().find((u) => u.username === String(name || '').trim().toLowerCase());

    router.get('/chat', requireUser, (req, res) => {
        ensureSetup(req.user);
        const prefs = load('chatprefs');
        const p = prefsFor(prefs, req.user.id);
        const users = userMap();
        res.json({
            me: { id: req.user.id, username: req.user.username, displayName: req.user.displayName },
            chats: load('chat').filter((c) => memberOf(c, req.user)).map((c) => project(c, req.user, p, users)),
            folders: p.folders.map((f) => ({ id: f.id, name: f.name })),
            apps: p.apps
        });
    });

    router.get('/chat/directory', requireUser, (req, res) => {
        const q = String(req.query.q || '').trim().toLowerCase();
        res.json(load('chat')
            .filter((c) => c.type !== 'dm' && c.public && !memberOf(c, req.user) && (!q || c.name.toLowerCase().includes(q)))
            .map((c) => ({ id: c.id, name: c.name, type: c.type, memberCount: c.members.length })));
    });

    router.post('/chat', requireUser, (req, res) => {
        const body = req.body || {};
        const name = str(body.name, 100);
        if (!name) return bad(res, 'A name is required.');
        if (body.type !== 'channel' && body.type !== 'space') return bad(res, 'Unknown chat type.');
        const chats = load('chat');
        if (body.public && chats.some((c) => c.type === body.type && c.public && c.name.toLowerCase() === name.toLowerCase())) {
            return bad(res, 'A public ' + body.type + ' with that name already exists.');
        }
        const members = [req.user.id];
        (Array.isArray(body.usernames) ? body.usernames : []).slice(0, 50).forEach((n) => {
            const u = userByName(n);
            if (u && !members.includes(u.id)) members.push(u.id);
        });
        const now = nowIso();
        const chat = { id: uuidv4(), type: body.type, name, public: !!body.public, createdBy: req.user.id, createdAt: now, members, reads: {}, messages: [] };
        members.forEach((id) => { chat.reads[id] = now; });
        chats.push(chat);
        save('chat', chats);
        ping(members, 'chat_changed', { chatId: chat.id });
        res.status(201).json(project(chat, req.user, prefsFor(load('chatprefs'), req.user.id), userMap()));
    });

    router.post('/chat/dm', requireUser, (req, res) => {
        const target = userByName(req.body && req.body.username);
        if (!target) return bad(res, 'No account with that username.');
        const chats = load('chat');
        const want = target.id === req.user.id ? [req.user.id] : [req.user.id, target.id];
        let chat = chats.find((c) => c.type === 'dm' && c.members.length === want.length && want.every((id) => c.members.includes(id)));
        if (!chat) {
            const now = nowIso();
            chat = { id: uuidv4(), type: 'dm', name: '', public: false, createdBy: req.user.id, createdAt: now, members: want, reads: { [req.user.id]: now }, messages: [] };
            chats.push(chat);
            save('chat', chats);
            ping(want, 'chat_changed', { chatId: chat.id });
        }
        res.status(201).json(project(chat, req.user, prefsFor(load('chatprefs'), req.user.id), userMap()));
    });

    router.post('/chat/read-all', requireUser, (req, res) => {
        const chats = load('chat');
        const now = nowIso();
        chats.forEach((c) => { if (memberOf(c, req.user)) c.reads[req.user.id] = now; });
        save('chat', chats);
        ping([req.user.id]);
        res.json({ ok: true });
    });

    function withChat(handler) {
        return (req, res) => {
            const chats = load('chat');
            const chat = chats.find((c) => c.id === req.params.id);
            if (!chat) return missing(res);
            return handler(req, res, chat, chats);
        };
    }

    router.post('/chat/:id/join', requireUser, withChat((req, res, chat, chats) => {
        if (chat.type === 'dm' || !chat.public) return res.status(403).json({ error: 'This chat is private.' });
        if (!chat.members.includes(req.user.id)) {
            chat.members.push(req.user.id);
            chat.reads[req.user.id] = nowIso(); // history is not "unread" for a newcomer
            save('chat', chats);
            ping(chat.members, 'chat_changed', { chatId: chat.id });
        }
        res.json(project(chat, req.user, prefsFor(load('chatprefs'), req.user.id), userMap()));
    }));

    function removeFromPrefs(userId, chatId) {
        const prefs = load('chatprefs');
        const p = prefsFor(prefs, userId);
        p.starred = p.starred.filter((id) => id !== chatId);
        p.folders.forEach((f) => { f.chatIds = f.chatIds.filter((id) => id !== chatId); });
        save('chatprefs', prefs);
    }

    router.post('/chat/:id/leave', requireUser, withChat((req, res, chat, chats) => {
        if (!memberOf(chat, req.user)) return missing(res);
        chat.members = chat.members.filter((id) => id !== req.user.id);
        delete chat.reads[req.user.id];
        save('chat', chat.members.length ? chats : chats.filter((c) => c.id !== chat.id));
        if (!chat.members.length) dropArchive(chat.id);
        removeFromPrefs(req.user.id, chat.id);
        ping(chat.members.concat(req.user.id), 'chat_changed', { chatId: chat.id });
        res.json({ ok: true });
    }));

    router.post('/chat/:id/read', requireUser, withChat((req, res, chat, chats) => {
        if (!memberOf(chat, req.user)) return missing(res);
        chat.reads[req.user.id] = nowIso();
        save('chat', chats);
        ping([req.user.id], 'chat_changed', { chatId: chat.id });
        res.json({ ok: true });
    }));

    router.post('/chat/:id/members', requireUser, withChat((req, res, chat, chats) => {
        if (!memberOf(chat, req.user)) return missing(res);
        if (chat.type === 'dm') return bad(res, 'You cannot add people to a direct message.');
        const target = userByName(req.body && req.body.username);
        if (!target) return bad(res, 'No account with that username.');
        if (!chat.members.includes(target.id)) {
            chat.members.push(target.id);
            chat.reads[target.id] = nowIso();
            save('chat', chats);
            ping(chat.members, 'chat_changed', { chatId: chat.id });
        }
        res.json(project(chat, req.user, prefsFor(load('chatprefs'), req.user.id), userMap()));
    }));

    // The creator of a channel or space can remove people (everyone else can only leave)
    router.post('/chat/:id/members/remove', requireUser, withChat((req, res, chat, chats) => {
        if (!memberOf(chat, req.user)) return missing(res);
        if (chat.type === 'dm') return bad(res, 'You cannot remove people from a direct message.');
        if (chat.createdBy !== req.user.id) return res.status(403).json({ error: 'Only the creator can remove people.' });
        const target = userByName(req.body && req.body.username);
        if (!target || !chat.members.includes(target.id)) return bad(res, 'That person is not in this chat.');
        if (target.id === req.user.id) return bad(res, 'Use Leave to remove yourself.');
        chat.members = chat.members.filter((id) => id !== target.id);
        delete chat.reads[target.id];
        save('chat', chats);
        removeFromPrefs(target.id, chat.id);
        ping(chat.members.concat(target.id), 'chat_changed', { chatId: chat.id });
        res.json(project(chat, req.user, prefsFor(load('chatprefs'), req.user.id), userMap()));
    }));

    // Slash commands from installed apps. Returns the bot post, or null for plain text.
    function runCommand(text, user, chat, installed) {
        const m = text.match(/^\/(meet|roll|poll|remind)(?:\s+(.*))?$/i);
        if (!m) return null;
        const cmd = m[1].toLowerCase();
        const app = APPS.find((a) => a.command === '/' + cmd);
        if (!installed.includes(app.id)) throw new Error('Install the ' + app.name + ' app first (Chat → + → Get apps).');
        const arg = (m[2] || '').trim();
        if (cmd === 'meet') {
            const topic = str(arg, 100) || (chat.type === 'dm' ? user.displayName + "'s meeting" : chat.name + ' meeting');
            const meeting = allocateMeeting({ topic, hostId: user.id });
            return { botId: app.id, botName: app.name, text: user.displayName + ' started a meeting: "' + topic + '"', extra: { meetingId: meeting.meetingId } };
        }
        if (cmd === 'poll') {
            const parts = arg.split('|').map((x) => x.trim()).filter(Boolean);
            if (parts.length < 3 || parts.length > 7) throw new Error('Usage: /poll Question | Option 1 | Option 2 (2 to 6 options)');
            const question = str(parts[0], 200);
            const options = parts.slice(1).map((o) => ({ text: str(o, 80) }));
            return { botId: app.id, botName: app.name, text: question, extra: { poll: { question, options, votes: {}, closed: false, createdBy: user.id } } };
        }
        if (cmd === 'remind') {
            const r = arg.match(/^(?:in\s+)?(\d{1,6})\s*(s|sec|m|min|h|hr|d)\s+(.+)$/i);
            if (!r) throw new Error('Usage: /remind 10m take a break (units: s, m, h, d)');
            const unit = { s: 1000, sec: 1000, m: 60000, min: 60000, h: 3600000, hr: 3600000, d: 86400000 }[r[2].toLowerCase()];
            const ms = Number(r[1]) * unit;
            if (ms < REMINDER_MIN_MS) throw new Error('Reminders must be at least ' + Math.ceil(REMINDER_MIN_MS / 1000) + ' seconds away.');
            if (ms > REMINDER_MAX_MS) throw new Error('Reminders can be at most 30 days away.');
            const reminders = load('reminders');
            if (reminders.filter((x) => x.userId === user.id).length >= REMINDER_PER_USER) throw new Error('You already have ' + REMINDER_PER_USER + ' pending reminders.');
            const what = str(r[3], 300);
            reminders.push({ id: uuidv4(), userId: user.id, username: user.username, chatId: chat.id, at: new Date(Date.now() + ms).toISOString(), text: what });
            save('reminders', reminders);
            return { botId: app.id, botName: app.name, text: 'Okay ' + user.displayName + ", I'll remind you in " + r[1] + r[2].toLowerCase() + ': ' + what, extra: {} };
        }
        const d = arg === '' ? [null, '1', '6'] : arg.toLowerCase().match(/^(\d{1,2})?d(\d{1,3})$/);
        if (!d) throw new Error('Usage: /roll 2d6 or /roll d20');
        const n = Number(d[1] || 1), sides = Number(d[2]);
        if (n < 1 || n > 20 || sides < 2 || sides > 100) throw new Error('Roll 1-20 dice with 2-100 sides.');
        const rolls = Array.from({ length: n }, () => 1 + crypto.randomInt(sides));
        return { botId: app.id, botName: app.name, text: user.displayName + ' rolled ' + n + 'd' + sides + ': ' + rolls.join(' + ') + ' = ' + rolls.reduce((a, b) => a + b, 0), extra: {} };
    }

    router.post('/chat/:id/messages', requireUser, withChat((req, res, chat, chats) => {
        if (!memberOf(chat, req.user)) return missing(res);
        const text = str(req.body && req.body.text, 5000);
        if (!text) return bad(res, 'Message text is required.');
        const out = [{ id: uuidv4(), userId: req.user.id, name: req.user.displayName, text, at: nowIso() }];
        let cmd;
        try {
            cmd = runCommand(text, req.user, chat, prefsFor(load('chatprefs'), req.user.id).apps);
        } catch (err) {
            return bad(res, err.message);
        }
        if (cmd) out.push({ id: uuidv4(), userId: 'bot:' + cmd.botId, name: cmd.botName, text: cmd.text, at: nowIso(), ...cmd.extra });
        chat.messages.push(...out);
        trimHistory(chat);
        chat.reads[req.user.id] = nowIso();
        save('chat', chats);
        ping(chat.members, 'chat_changed', { chatId: chat.id });
        res.status(201).json({ messages: out.map((m) => publicMessage(m, req.user.id)) });
    }));

    // Older messages, newest-first paging: GET /chat/:id/messages?before=<messageId>&limit=50
    // Returns up to `limit` messages that came before `before` (oldest first) and whether more exist.
    router.get('/chat/:id/messages', requireUser, withChat((req, res, chat) => {
        if (!memberOf(chat, req.user)) return missing(res);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const liveIds = new Set(chat.messages.map((m) => m.id));
        const archived = (chat.archived || 0) > 0 && SAFE_CHAT_ID.test(chat.id)
            ? store.readJson(file(archiveKey(chat.id)), []).filter((m) => !liveIds.has(m.id))
            : [];
        const archivedIds = new Set(archived.map((m) => m.id));
        const all = archived.concat(chat.messages);
        let end = all.length;
        if (req.query.before) {
            end = all.findIndex((m) => m.id === req.query.before);
            if (end === -1) return bad(res, 'Unknown message.');
        }
        const start = Math.max(0, end - limit);
        res.set('Cache-Control', 'no-store');
        res.json({
            messages: all.slice(start, end).map((m) => publicMessage(m, req.user.id, archivedIds.has(m.id))),
            hasMore: start > 0
        });
    }));

    // ---- polls ----
    router.post('/chat/:id/messages/:mid/vote', requireUser, withChat((req, res, chat, chats) => {
        if (!memberOf(chat, req.user)) return missing(res);
        const m = chat.messages.find((x) => x.id === req.params.mid);
        if (!m || !m.poll) return missing(res);
        if (m.poll.closed) return bad(res, 'This poll is closed.');
        const i = Number(req.body && req.body.option);
        if (!Number.isInteger(i) || i < 0 || i >= m.poll.options.length) return bad(res, 'Pick one of the options.');
        m.poll.votes = m.poll.votes || {};
        m.poll.votes[req.user.id] = i; // voting again simply changes your vote
        save('chat', chats);
        ping(chat.members, 'chat_changed', { chatId: chat.id });
        res.json(publicMessage(m, req.user.id));
    }));

    router.post('/chat/:id/messages/:mid/close', requireUser, withChat((req, res, chat, chats) => {
        if (!memberOf(chat, req.user)) return missing(res);
        const m = chat.messages.find((x) => x.id === req.params.mid);
        if (!m || !m.poll) return missing(res);
        if (m.poll.createdBy !== req.user.id) return res.status(403).json({ error: 'Only the person who started the poll can close it.' });
        m.poll.closed = true;
        save('chat', chats);
        ping(chat.members, 'chat_changed', { chatId: chat.id });
        res.json(publicMessage(m, req.user.id));
    }));

    // ---- reminders: due ones are posted into their chat by the bot ----
    function fireDueReminders() {
        let reminders;
        try { reminders = load('reminders'); } catch (err) { return; }
        const now = Date.now();
        const due = reminders.filter((r) => Date.parse(r.at) <= now);
        if (!due.length) return;
        const chats = load('chat');
        const touched = new Set();
        due.forEach((r) => {
            const chat = chats.find((c) => c.id === r.chatId);
            // Dropped quietly if the chat is gone or the person left it
            const user = chat && listUsers().find((u) => u.id === r.userId);
            if (!chat || !user || !chat.members.includes(r.userId)) return;
            chat.messages.push({ id: uuidv4(), userId: 'bot:reminder-bot', name: 'Reminders', text: '\u23F0 @' + user.username + ' reminder: ' + r.text, at: nowIso() });
            trimHistory(chat);
            touched.add(chat);
        });
        save('chat', chats);
        save('reminders', reminders.filter((r) => Date.parse(r.at) > now));
        touched.forEach((chat) => ping(chat.members, 'chat_changed', { chatId: chat.id }));
    }
    const reminderTimer = setInterval(() => { try { fireDueReminders(); } catch (err) { console.error('[Reminders]:', err.message); } }, Math.max(200, parseInt(process.env.REMINDER_TICK_MS, 10) || 15000));
    reminderTimer.unref();
    setTimeout(() => { try { fireDueReminders(); } catch (err) { console.error('[Reminders]:', err.message); } }, 1500).unref();

    router.patch('/chat/:id', requireUser, withChat((req, res, chat, chats) => {
        if (!memberOf(chat, req.user)) return missing(res);
        const body = req.body || {};
        const prefs = load('chatprefs');
        const p = prefsFor(prefs, req.user.id);
        if ('starred' in body) {
            p.starred = p.starred.filter((id) => id !== chat.id);
            if (body.starred) p.starred.push(chat.id);
        }
        if ('folderId' in body) {
            if (body.folderId && !p.folders.some((x) => x.id === body.folderId)) return bad(res, 'Unknown folder.');
            p.folders.forEach((f) => { f.chatIds = f.chatIds.filter((id) => id !== chat.id); });
            if (body.folderId) p.folders.find((x) => x.id === body.folderId).chatIds.push(chat.id);
        }
        if ('name' in body) {
            if (chat.type === 'dm' || chat.createdBy !== req.user.id) return res.status(403).json({ error: 'Only the creator can rename a channel.' });
            const name = str(body.name, 100);
            if (!name) return bad(res, 'A name is required.');
            chat.name = name;
            save('chat', chats);
        }
        if ('public' in body) {
            if (chat.type === 'dm' || chat.type === 'meeting' || chat.createdBy !== req.user.id) {
                return res.status(403).json({ error: 'Only the creator of a channel or space can change who can find it.' });
            }
            const want = !!body.public;
            if (want && chats.some((c) => c.id !== chat.id && c.type === chat.type && c.public && c.name.toLowerCase() === chat.name.toLowerCase())) {
                return bad(res, 'A public ' + chat.type + ' with that name already exists. Rename this one first.');
            }
            chat.public = want;
            save('chat', chats);
        }
        save('chatprefs', prefs);
        ping('name' in body || 'public' in body ? chat.members : [req.user.id], 'chat_changed', { chatId: chat.id });
        res.json(project(chat, req.user, p, userMap()));
    }));

    router.delete('/chat/:id', requireUser, withChat((req, res, chat, chats) => {
        if (!memberOf(chat, req.user)) return missing(res);
        if (chat.type === 'dm' || chat.createdBy !== req.user.id) return res.status(403).json({ error: 'Only the creator can delete a channel. Use Leave instead.' });
        save('chat', chats.filter((c) => c.id !== chat.id));
        dropArchive(chat.id);
        ping(chat.members, 'chat_changed', { chatId: chat.id });
        res.json({ ok: true });
    }));

    // Folders (private to each user)
    router.post('/chat-folders', requireUser, (req, res) => {
        const name = str(req.body && req.body.name, 60);
        if (!name) return bad(res, 'A folder name is required.');
        const prefs = load('chatprefs');
        const p = prefsFor(prefs, req.user.id);
        if (p.folders.length >= 30) return bad(res, 'Folder limit reached.');
        if (p.folders.some((f) => f.name.toLowerCase() === name.toLowerCase())) return bad(res, 'You already have a folder with that name.');
        const folder = { id: uuidv4(), name, chatIds: [] };
        p.folders.push(folder);
        save('chatprefs', prefs);
        res.status(201).json({ id: folder.id, name: folder.name });
    });
    router.patch('/chat-folders/:id', requireUser, (req, res) => {
        const name = str(req.body && req.body.name, 60);
        if (!name) return bad(res, 'A folder name is required.');
        const prefs = load('chatprefs');
        const f = prefsFor(prefs, req.user.id).folders.find((x) => x.id === req.params.id);
        if (!f) return missing(res);
        f.name = name;
        save('chatprefs', prefs);
        res.json({ id: f.id, name: f.name });
    });
    router.delete('/chat-folders/:id', requireUser, (req, res) => {
        const prefs = load('chatprefs');
        const p = prefsFor(prefs, req.user.id);
        if (!p.folders.some((x) => x.id === req.params.id)) return missing(res);
        p.folders = p.folders.filter((x) => x.id !== req.params.id);
        save('chatprefs', prefs);
        res.json({ ok: true });
    });

    // Apps (per-user installs)
    router.get('/chat-apps', requireUser, (req, res) => {
        const installed = prefsFor(load('chatprefs'), req.user.id).apps;
        res.json(APPS.map((a) => ({ ...a, installed: installed.includes(a.id) })));
    });
    router.post('/chat-apps/:id/install', requireUser, (req, res) => {
        if (!APPS.some((a) => a.id === req.params.id)) return missing(res);
        const prefs = load('chatprefs');
        const p = prefsFor(prefs, req.user.id);
        if (!p.apps.includes(req.params.id)) p.apps.push(req.params.id);
        save('chatprefs', prefs);
        res.json({ ok: true });
    });
    router.delete('/chat-apps/:id', requireUser, (req, res) => {
        const prefs = load('chatprefs');
        const p = prefsFor(prefs, req.user.id);
        p.apps = p.apps.filter((id) => id !== req.params.id);
        save('chatprefs', prefs);
        res.json({ ok: true });
    });

    router.use((err, req, res, next) => {
        if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
        if (err instanceof SyntaxError) return bad(res, 'Invalid JSON.');
        console.error('[Workplace]:', err);
        res.status(500).json({ error: 'Server error.' });
    });

    return router;
};
