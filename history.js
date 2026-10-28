'use strict';
// Meeting History and Activity Report.
//
// The meeting record that already exists (meetingsState, same meeting ID) is the single source of truth: this module only adds lifecycle facts to it
// (actual start/end, attendance, outcome, follow-ups) and reads it back. Nothing is copied into a separate history store.
//
//   status      scheduled -> active -> completed | partial        a meeting that ran
//               scheduled -> missed                                nobody ever joined and its time passed
//               scheduled -> cancelled                             the organiser deleted it before it started
//   History     completed, partial, missed, cancelled. These records are FROZEN: schedule edits, new occurrences and Reschedule never change them, and
//               they cannot be joined or restarted (the join routes already refuse status "completed"). Only the host's outcome and action items stay editable.
//   Attendance  built-in room: join/leave events recorded here. Meet-hosted meetings: pulled from Meet's participant sessions (names and times only).
//   Access      the host sees everything; someone who attended sees the banner, description, agenda, outcome and action items, never the attendee list.
const CATEGORIES = ['team', 'training', 'presentation', 'interview', 'webinar', 'other'];
const FINAL = new Set(['completed', 'partial', 'missed', 'cancelled']);
const IDLE_MS = Number(process.env.HISTORY_IDLE_MS || 30 * 60 * 1000);          // nobody in the room for this long = the meeting is over
const MAX_EVENTS = 4000;
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
const cleanLine = (v, n) => clean(v, n).replace(/\s+/g, ' ');

function cleanAgenda(v) {
    const a = Array.isArray(v) ? v : String(v || '').split('\n');
    return a.map((x) => cleanLine(x, 200)).filter(Boolean).slice(0, 20);
}
const cleanCategory = (v) => (CATEGORIES.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : '');
/** The descriptive metadata of a meeting, validated. Only keys that are present are returned, so partial edits do not blank anything. */
function cleanMeta(b) {
    const out = {};
    if ('title' in b) out.title = cleanLine(b.title, 200);
    if ('topic' in b) out.topicText = cleanLine(b.topic, 255);
    if ('description' in b) out.description = clean(b.description, 2000);
    if ('agenda' in b) out.agenda = cleanAgenda(b.agenda);
    if ('category' in b) out.category = cleanCategory(b.category);
    return out;
}

// ---- attendance recorded by this server (built-in room, and hand-offs to Meet) ----------------------------------------------------------------------
function recordJoin(m, who, at = Date.now()) {
    if (!m.attendance) m.attendance = [];
    if (m.attendance.length < MAX_EVENTS) m.attendance.push({ t: 'j', k: String(who.key).slice(0, 80), n: cleanLine(who.name, 70) || 'Guest', a: who.accountId ? String(who.accountId).slice(0, 40) : undefined, at });
    if (who.accountId) { if (!m.joinedAccounts) m.joinedAccounts = []; if (!m.joinedAccounts.includes(who.accountId)) m.joinedAccounts.push(who.accountId); }
    if (!m.actualStartAt) m.actualStartAt = at;
    m.lastActivityAt = at;
}
function recordAccount(m, accountId) { if (!accountId) return; if (!m.joinedAccounts) m.joinedAccounts = []; if (!m.joinedAccounts.includes(accountId)) m.joinedAccounts.push(accountId); }
function recordLeave(m, key, at = Date.now()) {
    if (!m.attendance) return;
    if (m.attendance.length < MAX_EVENTS) m.attendance.push({ t: 'l', k: String(key).slice(0, 80), at });
    m.lastActivityAt = at;
}
/** Per person (by key): first join, last leave, total time in the room and number of joins; plus unique and peak. Open sessions run until `until`. */
function localStats(m, until) {
    const ev = (m.attendance || []).slice().sort((a, b) => a.at - b.at);
    const per = new Map(), open = new Map(); let live = new Set(), peak = 0;
    for (const e of ev) {
        const p = per.get(e.k) || { name: e.n || '', firstJoin: e.at, lastLeft: e.at, seconds: 0, sessions: 0, role: 'participant' };
        if (e.t === 'j') {
            p.sessions++; p.name = e.n || p.name; p.firstJoin = Math.min(p.firstJoin, e.at);
            open.set(e.k, (open.get(e.k) || []).concat(e.at)); live.add(e.k); peak = Math.max(peak, live.size);
        } else {
            const starts = open.get(e.k) || []; const s = starts.shift(); if (s !== undefined) p.seconds += Math.round((e.at - s) / 1000);
            if (!starts.length) live.delete(e.k); p.lastLeft = Math.max(p.lastLeft, e.at);
        }
        per.set(e.k, p);
    }
    for (const [k, starts] of open) for (const s of starts) { const p = per.get(k); p.seconds += Math.max(0, Math.round((until - s) / 1000)); p.lastLeft = Math.max(p.lastLeft, until); }
    const att = [...per.values()].map((p) => ({ name: p.name, role: p.role, firstJoin: new Date(p.firstJoin).toISOString(), lastLeft: new Date(p.lastLeft).toISOString(), seconds: p.seconds, sessions: p.sessions }));
    const lastLeft = ev.filter((e) => e.t === 'l').reduce((x, e) => Math.max(x, e.at), 0) || null;
    return { attendees: att, unique: per.size, peak, online: live.size, lastLeftAt: lastLeft ? new Date(lastLeft).toISOString() : null, startedAt: ev.length ? new Date(ev[0].at).toISOString() : null };
}
const statsOf = (m, now = Date.now()) => (m.meetActivity && m.viaMeet ? m.meetActivity : localStats(m, m.actualEndAt || now));

// ---- lifecycle ----------------------------------------------------------------------------------------------------------------------------------
function finalize(m, reason, at = Date.now()) {
    if (m.status === 'completed') return false;
    m.status = 'completed'; m.endReason = reason; m.actualEndAt = at; m.endedAt = new Date(at).toISOString();
    if (reason === 'unverified') m.partial = true;
    return true;
}
const statusOf = (m) => (m.status === 'completed' ? (m.endReason === 'cancelled' ? 'cancelled' : m.endReason === 'missed' ? 'missed' : m.partial ? 'partial' : 'completed')
    : m.status === 'active' ? 'active' : 'scheduled');
/** Moves a meeting forward when the facts say it is over. `roomActive`: someone is in the built-in room right now. */
function advance(m, now, roomActive) {
    if (m.status === 'completed' || roomActive) return;
    const sched = Date.parse(m.startTime), end = (Number.isFinite(sched) ? sched : now) + (m.durationMinutes || 45) * 60000;
    const last = m.lastActivityAt || m.actualStartAt;
    if (m.actualStartAt) { if (now - last > IDLE_MS) finalize(m, 'idle', last); }
    else if (now > end + IDLE_MS) finalize(m, m.viaMeet && !m.meetActivity ? 'unverified' : 'missed', end);
}

/** Read-only: has this meeting reached the end of its life (so it belongs in History, not in the schedule)? Never changes the record. */
function isFinished(m, now = Date.now()) {
    if (m.status === 'completed') return true;
    if (m.status === 'active') return false;
    const sched = Date.parse(m.startTime), end = (Number.isFinite(sched) ? sched : now) + (m.durationMinutes || 45) * 60000;
    if (m.actualStartAt) return now - (m.lastActivityAt || m.actualStartAt) > IDLE_MS;
    return !m.viaMeet && now > end + IDLE_MS;                                      // a Meet-hosted meeting with no news yet is not assumed over
}

// ---- views --------------------------------------------------------------------------------------------------------------------------------------
function banner(m, user, now = Date.now()) {
    const st = statsOf(m, now), start = m.actualStartAt || null, end = m.actualEndAt || null;
    return {
        meetingId: m.meetingId, title: m.title || m.topic || '', topic: m.topicText || '', category: m.category || '', hostName: m.hostName || '', isHost: !!user && m.hostId === user.id,
        status: statusOf(m), scheduledStartAt: m.scheduledStartAt || m.startTime || null, actualStartAt: start ? new Date(start).toISOString() : null, actualEndAt: end ? new Date(end).toISOString() : null,
        durationSeconds: start && end ? Math.max(0, Math.round((end - start) / 1000)) : null, uniqueAttendeeCount: st.unique || 0, peakConcurrentCount: st.peak || 0,
        outcomeSummary: (m.outcome || '').slice(0, 280), previousMeetingId: m.previousMeetingId || null, endReason: m.endReason || null, recurrence: m.recurrenceLabel || ''
    };
}
function details(m, user, now = Date.now()) {
    const b = banner(m, user, now), out = { ...b, description: m.description || '', agenda: m.agenda || [], outcome: m.outcome || '', actionItems: m.actionItems || [], outcomeUpdatedAt: m.outcomeUpdatedAt || null };
    if (b.isHost) {
        out.attendees = statsOf(m, now).attendees || []; out.recordings = { available: false, note: 'Recordings are managed in the meeting itself (Recordings list). They are not linked into History yet.' };
        out.scheduledDuration = m.durationMinutes || null; out.attendanceSource = m.viaMeet ? 'Qorlla Meet' : 'built-in room';
    }
    return out;
}
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function reportCsv(m, now = Date.now()) {
    const d = details(m, { id: m.hostId }, now), rows = [['Meeting', d.title], ['Topic', d.topic], ['Category', d.category], ['Host', d.hostName], ['Meeting ID', d.meetingId], ['Status', d.status],
        ['Scheduled start', d.scheduledStartAt || ''], ['Actual start', d.actualStartAt || ''], ['Actual end', d.actualEndAt || ''], ['Duration (seconds)', d.durationSeconds ?? ''],
        ['Unique attendees', d.uniqueAttendeeCount], ['Peak concurrent', d.peakConcurrentCount], ['Outcome', d.outcome], [], ['Attendee', 'First joined', 'Last left', 'Minutes', 'Joins']];
    for (const a of d.attendees) rows.push([a.name, a.firstJoin, a.lastLeft, Math.round(a.seconds / 60), a.sessions]);
    if (d.actionItems.length) { rows.push([], ['Action item', 'Owner', 'Due', 'Done']); for (const x of d.actionItems) rows.push([x.text, x.owner, x.due, x.done ? 'yes' : 'no']); }
    return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
function cleanActionItems(v) {
    if (!Array.isArray(v)) return null;
    return v.slice(0, 50).map((x) => ({ text: cleanLine(x && x.text, 300), owner: cleanLine(x && x.owner, 80), due: /^\d{4}-\d{2}-\d{2}$/.test((x && x.due) || '') ? x.due : '', done: !!(x && x.done) })).filter((x) => x.text);
}

function registerHistory({ app, meetingsState, saveSnapshotSoon, auth, activeRooms, fetchActivity }) {
    const pulled = new Map();                                                      // meetingId -> last pull time (a short cache keeps the list fast)
    async function refresh(m, now = Date.now()) {
        const room = activeRooms.get(m.meetingId);
        if (m.status !== 'completed' && m.viaMeet && fetchActivity && now - (pulled.get(m.meetingId) || 0) > 15000) {
            pulled.set(m.meetingId, now);
            try {
                const a = await fetchActivity(m);
                if (a) {
                    m.meetActivity = a; if (a.startedAt) m.actualStartAt = Date.parse(a.startedAt);
                    if (a.startedAt && m.status === 'scheduled') m.status = 'active';
                    if (a.endedAt) finalize(m, a.endReason === 'time_limit' ? 'time_limit' : 'host_ended', Date.parse(a.endedAt));
                    else if (a.startedAt && !a.online && a.lastLeftAt && now - Date.parse(a.lastLeftAt) > IDLE_MS) finalize(m, 'idle', Date.parse(a.lastLeftAt));
                    if (m.status === 'completed') m.actualEndAt = m.actualEndAt || Date.parse(a.endedAt || a.lastLeftAt || new Date(now).toISOString());
                    if (a.online) m.lastActivityAt = now;
                    else if (a.lastLeftAt) m.lastActivityAt = Date.parse(a.lastLeftAt);
                }
            } catch (e) { /* Meet unreachable: what we already know stays; advance() decides below */ }
        }
        const before = m.status; advance(m, now, !!(room && room.size));
        if (m.status !== before) saveSnapshotSoon();
    }
    const me = (req, res) => { const u = auth.getUser(req); if (!u) { res.status(401).json({ error: 'Sign in first.' }); return null; } return u; };
    const involved = (m, u) => m.hostId === u.id || (m.joinedAccounts || []).includes(u.id);
    const find = (req) => meetingsState.get(String(req.params.id || '').replace(/\D/g, '').replace(/^(\d{3})(\d{4})(\d{4})$/, '$1 $2 $3'));
    app.use('/api/history', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

    app.get('/api/history/meetings', async (req, res) => {
        const u = me(req, res); if (!u) return;
        const q = cleanLine(req.query.q, 100).toLowerCase(), cat = cleanCategory(req.query.category), st = String(req.query.status || ''), host = cleanLine(req.query.host, 80).toLowerCase();
        const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? Date.parse(req.query.from + 'T00:00:00') : null, to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? Date.parse(req.query.to + 'T23:59:59') : null;
        const mine = [...meetingsState.values()].filter((m) => involved(m, u));
        await Promise.all(mine.map((m) => refresh(m)));
        let rows = mine.filter((m) => FINAL.has(statusOf(m)) || m.status === 'completed').map((m) => banner(m, u));
        rows = rows.filter((b) => (!st || b.status === st) && (!cat || b.category === cat) && (!host || b.hostName.toLowerCase().includes(host))
            && (!q || (b.title + ' ' + b.topic + ' ' + b.hostName).toLowerCase().includes(q))
            && (!from || Date.parse(b.actualStartAt || b.scheduledStartAt) >= from) && (!to || Date.parse(b.actualStartAt || b.scheduledStartAt) <= to));
        rows.sort((a, b) => Date.parse(b.actualStartAt || b.scheduledStartAt || 0) - Date.parse(a.actualStartAt || a.scheduledStartAt || 0));
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0), limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        res.json({ total: rows.length, offset, limit, meetings: rows.slice(offset, offset + limit), categories: CATEGORIES });
    });
    app.get('/api/history/meetings/:id', async (req, res) => {
        const u = me(req, res); if (!u) return; const m = find(req);
        if (!m || !involved(m, u)) return res.status(404).json({ error: 'This meeting is not in your history.' });
        await refresh(m); if (!FINAL.has(statusOf(m))) return res.status(409).json({ error: 'This meeting has not finished yet.' });
        res.json(details(m, u));
    });
    app.patch('/api/history/meetings/:id', express_json(), async (req, res) => {
        const u = me(req, res); if (!u) return; const m = find(req);
        if (!m || !involved(m, u)) return res.status(404).json({ error: 'This meeting is not in your history.' });
        if (m.hostId !== u.id) return res.status(403).json({ error: 'Only the host can write the outcome.' });
        await refresh(m); if (!FINAL.has(statusOf(m))) return res.status(409).json({ error: 'The outcome can be written once the meeting has finished.' });
        const b = req.body || {};
        if ('outcome' in b) { if (typeof b.outcome !== 'string') return res.status(400).json({ error: 'outcome must be text.' }); m.outcome = clean(b.outcome, 4000); }
        if ('actionItems' in b) { const items = cleanActionItems(b.actionItems); if (!items) return res.status(400).json({ error: 'actionItems must be a list.' }); m.actionItems = items; }
        m.outcomeUpdatedAt = new Date().toISOString(); saveSnapshotSoon(); res.json(details(m, u));
    });
    app.get('/api/history/meetings/:id/report', async (req, res) => {
        const u = me(req, res); if (!u) return; const m = find(req);
        if (!m || !involved(m, u)) return res.status(404).json({ error: 'This meeting is not in your history.' });
        if (m.hostId !== u.id) return res.status(403).json({ error: 'Only the host can download the attendance report.' });
        await refresh(m); if (!FINAL.has(statusOf(m))) return res.status(409).json({ error: 'The report is available once the meeting has finished.' });
        const name = 'meeting-report-' + String(m.meetingId).replace(/\D/g, '');
        if (req.query.format === 'json') return res.set('Content-Disposition', 'attachment; filename="' + name + '.json"').json(details(m, u));
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + name + '.csv"' }).send(reportCsv(m));
    });
    function express_json() { return require('express').json({ limit: '64kb' }); }
}

module.exports = { isFinished, registerHistory, recordJoin, recordAccount, recordLeave, finalize, advance, statusOf, localStats, statsOf, banner, details, reportCsv, cleanMeta, cleanAgenda, cleanCategory, cleanActionItems, CATEGORIES, FINAL };
