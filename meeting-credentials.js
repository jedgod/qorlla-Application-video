'use strict';
// Meeting ID + password on current and History meetings, and re-use of a finished meeting (same Meeting ID, same password), limited by the host's subscription.
//
//   GET  /api/meetings/:id/credentials          host only. The Meeting ID, whether a password is set / viewable, and the re-use allowance. NEVER the password.
//   POST /api/meetings/:id/credentials/reveal   host only. The password, on an explicit click (POST so it is never cached, logged as a URL or put in history). Rate limited, audited without the password.
//   POST /api/meetings/:id/reuse                host only. Opens a NEW run of a finished meeting under the same ID and password: { clientRequestId } makes it idempotent.
//
// What re-use does: the finished run is FROZEN as it was (outcome, attendance, action items, its Meet record) and kept in History under `<id>~r<n>`; a fresh live record takes the Meeting ID,
// with the same password and settings but no attendees, chat, notes, documents or Meet registration (Meet gets a NEW meeting for the new run when the host starts it, so nobody from the
// earlier run can slip in with an old session). The whole switch is one synchronous step on the server, so two clicks at once cannot use more re-uses than the plan allows.
const crypto = require('crypto');

const REUSABLE = new Set(['completed', 'partial', 'missed', 'cancelled']);           // every finished meeting in History (a cancelled one too: "start again")
const digitsOf = (id) => String(id || '').replace(/\D/g, '');
const fmtId = (id) => digitsOf(id).replace(/^(\d{3})(\d{4})(\d{4})$/, '$1 $2 $3');

function registerMeetingCredentials({ app, express, meetingsState, saveSnapshotSoon, auth, hist, meetLaunch, ML, vault, reuse, roomActive = () => false, onArchived = () => {}, audit = (l) => console.log(JSON.stringify(l)), env = process.env, now = () => Date.now() }) {
    const json = express.json({ limit: '8kb' });
    const noStore = (res) => res.set('Cache-Control', 'no-store');
    const user = (req, res) => { const u = auth.getUser(req); if (!u) { res.status(401).json({ error: 'Sign in first.' }); return null; } return u; };
    const headOf = (req) => meetingsState.get(fmtId(req.params.id));
    const hostOf = (req, res) => {
        const u = user(req, res); if (!u) return null;
        const m = headOf(req);
        if (!m || m.hostId !== u.id) { res.status(m ? 403 : 404).json({ error: m ? 'Only the host can do this.' : 'Meeting not found.' }); return null; }    // a stranger learns nothing: 404 or 403, never a detail
        return { u, m };
    };

    /** 'none' | 'viewable' | 'hash_only' (set before passwords could be kept, or no key now) */
    function passwordState(m) {
        if (!m.passcodeHash) return 'none';
        if (!m.passcodeEnc) return 'hash_only';
        const o = vault.open(m.meetingId, m.passcodeEnc, env); return o.ok ? 'viewable' : 'hash_only';
    }
    const enabledOf = (m) => m.reuseAllowed !== false;                              // the host's "Allow reuse" switch (a per-meeting setting kept on the server; ON unless the host turned it off)
    const reuseInfo = (u, m) => {
        const before = m.status; hist.advance(m, now(), !!roomActive(m.meetingId)); if (m.status !== before) saveSnapshotSoon();      // a meeting whose time is really over counts as finished, as in History
        const ev = reuse.evaluate(u, (m.reuse && m.reuse.index) || 0, env), st = hist.statusOf(m), latest = meetingsState.get(m.meetingId) === m, enabled = enabledOf(m);
        const reason = !ev.allowed ? 'limit' : !enabled ? 'off' : !REUSABLE.has(st) ? 'open' : !latest ? 'not_latest' : null;         // why "Start again" is unavailable (null = available)
        return { plan: ev.plan, limit: ev.limit, used: ev.used, remaining: ev.remaining, allowed: ev.allowed, enabled, status: st, reason, canReuse: reason === null, runIndex: ev.used };
    };

    /** Host-only additions for the History list / details (hist.registerHistory({ decorate })). Attendees get nothing extra. */
    function decorate(b, m, u) {
        if (!u || m.hostId !== u.id) return b;
        const head = meetingsState.get(m.meetingId) === m;
        return { ...b, credentials: { meetingId: m.meetingId, passwordState: head ? passwordState(m) : 'archived' }, reuse: head ? reuseInfo(u, m) : { canReuse: false, latest: false } };
    }

    app.use(['/api/meetings/:id/credentials', '/api/meetings/:id/reuse', '/api/meetings/:id/reuse-setting'], (req, res, next) => { noStore(res); next(); });

    app.get('/api/meetings/:id/credentials', (req, res) => {
        const h = hostOf(req, res); if (!h) return;
        res.json({ meetingId: h.m.meetingId, passwordState: passwordState(h.m), keyConfigured: vault.available(env), reuse: reuseInfo(h.u, h.m) });
    });

    const revealLog = new Map();                                                    // user id -> timestamps of recent reveals
    app.post('/api/meetings/:id/credentials/reveal', json, (req, res) => {
        const h = hostOf(req, res); if (!h) return;
        const t = now(), log = (revealLog.get(h.u.id) || []).filter((x) => t - x < 10 * 60 * 1000);
        if (log.length >= 20) return res.status(429).json({ error: 'Too many password requests. Try again in a few minutes.' });
        log.push(t); revealLog.set(h.u.id, log);
        const state = passwordState(h.m);
        if (state === 'none') return res.status(404).json({ error: 'This meeting has no password.', passwordState: 'none' });
        if (state !== 'viewable') {
            audit({ audit: 'meeting_password_reveal_unavailable', meeting: h.m.meetingId, actor: h.u.id, at: new Date(t).toISOString(), keyConfigured: vault.available(env) });
            return res.status(409).json({ error: 'This password cannot be shown: it is stored only as a one-way hash (it was set before passwords could be kept, or the server has no key). Set a new password to see it here.', passwordState: state });
        }
        const o = vault.open(h.m.meetingId, h.m.passcodeEnc, env), fresh = vault.resealIfOld(h.m.meetingId, o, env);
        if (fresh) { h.m.passcodeEnc = fresh; saveSnapshotSoon(); }                // moved to the current key (rotation)
        audit({ audit: 'meeting_password_revealed', meeting: h.m.meetingId, actor: h.u.id, at: new Date(t).toISOString() });
        res.json({ meetingId: h.m.meetingId, password: o.password });
    });

    // "Allow reuse": the host's switch, kept on the server. ON permits starting the meeting again (same ID and password) while the plan allows; OFF forbids it. Turning it ON is refused when the plan allows no (more) re-uses.
    app.put('/api/meetings/:id/reuse-setting', json, (req, res) => {
        const h = hostOf(req, res); if (!h) return; const { u, m } = h;
        if (!req.body || typeof req.body.allowed !== 'boolean') return res.status(400).json({ error: 'allowed must be true or false.' });
        if (req.body.allowed) { const ev = reuse.evaluate(u, (m.reuse && m.reuse.index) || 0, env); if (!ev.allowed) return res.status(403).json({ error: reuse.refusal(ev), code: 'reuse_limit', upgrade: true, ...ev }); }
        m.reuseAllowed = req.body.allowed; saveSnapshotSoon();
        audit({ audit: 'meeting_reuse_setting', meeting: m.meetingId, actor: u.id, allowed: m.reuseAllowed, at: new Date(now()).toISOString() });
        res.json({ reuse: reuseInfo(u, m) });
    });

    const inflight = new Map();                                                     // `${meetingKey}|${requestId}` -> true while a re-use is running (it is synchronous, this guards a re-entrant call)
    app.post('/api/meetings/:id/reuse', json, (req, res) => {
        const h = hostOf(req, res); if (!h) return; const { u, m } = h;
        const rid = String((req.body && req.body.clientRequestId) || '').trim();
        if (!/^[A-Za-z0-9_.:-]{8,80}$/.test(rid)) return res.status(400).json({ error: 'clientRequestId is required (8 to 80 letters, digits or - _ . :).' });
        // 1. the same request again (a double click, a retry after a lost answer): the same answer, no second re-use
        const seen = ((m.reuse && m.reuse.requests) || []).find((r) => r.id === rid);
        if (seen) return res.json({ ...seen.result, idempotent: true, reuse: reuseInfo(u, m) });
        // 2. is the meeting in a state that can be re-used?
        const before = m.status; hist.advance(m, now(), !!roomActive(m.meetingId)); if (m.status !== before) saveSnapshotSoon();      // an idle room that is really over counts as finished
        const st = hist.statusOf(m);
        if (!REUSABLE.has(st)) return res.status(409).json({ error: 'This meeting is still open. Re-use is available once it has finished.', code: 'not_finished' });
        if (!enabledOf(m)) return res.status(403).json({ error: 'Re-use is switched off for this meeting. Turn on Allow reuse to start it again.', code: 'reuse_off' });
        // 3. the host's plan, decided here: the limit that applies is the one for the plan they have NOW
        const ev = reuse.evaluate(u, (m.reuse && m.reuse.index) || 0, env);
        if (!ev.allowed) return res.status(403).json({ error: reuse.refusal(ev), code: 'reuse_limit', upgrade: true, ...ev });
        const key = fmtId(m.meetingId) + '|' + rid; if (inflight.has(key)) return res.status(409).json({ error: 'This request is already being processed.' }); inflight.set(key, true);
        try {
            // 4. the switch: one synchronous step (nothing can interleave), all or nothing
            const idx = (m.reuse && m.reuse.index) || 0, archiveKey = m.meetingId + '~r' + idx, at = new Date(now()).toISOString();
            if (meetingsState.has(archiveKey)) return res.status(409).json({ error: 'This run was already archived.', code: 'conflict' });
            const head = JSON.parse(JSON.stringify(m));                              // a plain copy; lifecycle, people and content of the finished run are NOT carried over
            for (const k of ['actualStartAt', 'actualEndAt', 'endedAt', 'endReason', 'partial', 'lastActivityAt', 'attendance', 'joinedAccounts', 'meetActivity', 'viaMeet', 'outcome', 'outcomeUpdatedAt', 'actionItems', 'storeKey']) delete head[k];
            Object.assign(head, { id: crypto.randomUUID(), status: 'scheduled', startTime: at, scheduledStartAt: at, documents: [], notes: '', chatHistory: [], limitExempt: ML.isExempt(u, env), removedAccounts: m.removedAccounts || [] });
            const result = { meetingId: m.meetingId, runIndex: idx + 1, passwordState: m.passcodeHash ? (m.passcodeEnc ? 'viewable' : 'hash_only') : 'none' };
            head.reuse = { index: idx + 1, series: m.meetingId, at, requests: [...((m.reuse && m.reuse.requests) || []), { id: rid, result }].slice(-20) };
            // the finished run: frozen in History under its own key. Its password material is not needed any more (it can never be joined) and must not outlive the run next to a changed password.
            m.storeKey = archiveKey; delete m.passcodeEnc; delete m.passcodeHash;
            meetingsState.set(archiveKey, m); meetingsState.set(head.meetingId, head);
            try { meetLaunch.retire(m.meetingId, idx); } catch (e) { /* Meet link bookkeeping only; the new run registers a NEW Meet meeting when it starts */ }
            try { onArchived(head.meetingId); } catch (e) { console.error('[reuse] cleanup hook failed:', e.message); }
            saveSnapshotSoon();
            audit({ audit: 'meeting_reused', meeting: head.meetingId, actor: u.id, run: idx + 1, plan: ev.plan, at });
            res.status(201).json({ ...result, reuse: reuseInfo(u, head) });
        } finally { inflight.delete(key); }
    });

    return { decorate, passwordState, reuseInfo };
}

module.exports = { registerMeetingCredentials, REUSABLE };
