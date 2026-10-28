'use strict';
// Hands people from this server's meeting records to Qorlla Meet (the full video app), straight into the meeting - no Meet landing page.
//
// A meeting known to this server (for example a scheduled one with ID 920 4304 5426) is registered with Meet once, server to server, through Meet's bridge
// (QORLLA_BRIDGE_SECRET). Meet answers with the meeting's host credential, which is kept here (encrypted at rest when ENCRYPT_KEY is set) and NEVER sent to a
// browser. To enter, this server joins the person to the Meet meeting on their behalf (the host with the host credential, everyone else with a private
// per-meeting secret that only this server knows) and sends the browser to Meet with the resulting session in the URL FRAGMENT, which Meet reads and
// removes immediately. Because only this server holds that secret, the passcode check done here cannot be bypassed by typing the ID into Meet directly.
// The meeting's title and admission settings (waiting room, join before host, lock when the host joins) are pushed to Meet, which ENFORCES them.
//
// Off (throws 'unavailable') when Meet is not reachable or no bridge secret is configured: callers then fall back to the built-in room.
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const store = require('./store');

function createMeetLaunch({ dataDir, probePort, env = process.env, fetchImpl = fetch }) {
    const file = path.join(dataDir, 'meet-links.json');
    let links = {};
    try { links = store.readJson(file, {}) || {}; } catch (e) { links = {}; }
    const persist = () => store.writeJson(file, links, { durable: true });
    const secret = () => String(env.QORLLA_BRIDGE_SECRET || '');
    // Direct mode only: when the PostgreSQL meet-sync worker (DATABASE_URL + bridge) owns the registrations, it also owns the host credentials, so this stays off.
    const enabled = () => secret().length >= 32 && !env.DATABASE_URL;
    const unavailable = (why) => Object.assign(new Error(why || 'Qorlla Meet is not available'), { code: 'UNAVAILABLE' });
    const digitsOf = (id) => String(id || '').replace(/\D/g, '');
    const inflight = new Map();
    const bridge = () => ({ 'x-qorlla-bridge-secret': secret() });
    const meetSettings = (s) => ({ waitingRoom: !!s.waitingRoom, joinBeforeHost: s.joinBeforeHost !== false, lockOnHostJoin: !!s.lockAfterJoin });

    async function internalBase() {
        if (env.MEET_INTERNAL_URL) { try { return new URL(env.MEET_INTERNAL_URL).origin; } catch (e) { /* fall through to the probe */ } }
        const port = await probePort(); if (!port) return '';
        return new URL(env.MEET_PROBE_URL || 'http://127.0.0.1:3000').origin;
    }
    async function call(base, route, method, body, headers) {
        const r = await fetchImpl(base + route, { method, headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
        const data = await r.json().catch(() => ({}));
        return { ok: r.ok, status: r.status, data };
    }

    /** Readiness for the pre-meeting network check: is Meet reachable from this server, and how fast does it answer? */
    async function ping() {
        const t0 = Date.now();
        try { const base = await internalBase(); if (!base) return { configured: enabled(), reachable: false, ms: null }; const r = await fetchImpl(base + '/api/config', { signal: AbortSignal.timeout(3000) }); return { configured: enabled(), reachable: r.ok, ms: Date.now() - t0 }; }
        catch (e) { return { configured: enabled(), reachable: false, ms: null }; }
    }

    /** The Meet-side record for a meeting of this server (registering it the first time). desired = { title, settings } is kept in step on every call. */
    async function ensureLink(meeting, ownerName, desired = {}) {
        if (!enabled()) throw unavailable('No bridge secret is configured');
        const digits = digitsOf(meeting.meetingId);
        const title = String(desired.title || meeting.topic || 'Meeting').slice(0, 160), ms = meetSettings(desired.settings || {});
        if (links[digits] && links[digits].meetUuid) return syncLink(digits, title, ms);
        if (inflight.has(digits)) return inflight.get(digits);                                   // concurrent first uses register once
        const job = (async () => {
            const base = await internalBase(); if (!base) throw unavailable('Qorlla Meet is not reachable');
            const meetPass = crypto.randomBytes(18).toString('base64url');
            const body = { sourceId: 'main-' + digits, title, ownerName: String(ownerName || 'Host').slice(0, 70), scheduledAt: meeting.startTime || null, passcodeHash: await bcrypt.hash(meetPass, 10), ...ms };
            if (/^\d{10,12}$/.test(digits)) body.legacyCode = digits;
            const r = await call(base, '/api/integrations/scheduled-meetings', 'POST', body, bridge());
            if (!r.ok) throw unavailable('Meet refused the registration (' + r.status + ')');
            if (!r.data.created) throw unavailable('This meeting is already registered with Meet by another service');   // no credentials to hand over
            links[digits] = { sourceId: body.sourceId, meetUuid: r.data.meetingId, meetCode: r.data.meetingCode, hostSecret: r.data.hostSecret, meetPass, title, settings: ms, at: new Date().toISOString() };
            persist();
            return links[digits];
        })();
        inflight.set(digits, job);
        try { return await job; } finally { inflight.delete(digits); }
    }
    /** Pushes a changed title / settings to Meet (only when something differs). */
    async function syncLink(digits, title, ms) {
        const l = links[digits];
        if (l.title === title && JSON.stringify(l.settings || null) === JSON.stringify(ms)) return l;
        const base = await internalBase(); if (!base) throw unavailable('Qorlla Meet is not reachable');
        const r = await call(base, '/api/integrations/scheduled-meetings/' + encodeURIComponent(l.sourceId), 'PATCH', { title, ...ms }, bridge());
        if (!r.ok) throw unavailable('Meet refused the update (' + r.status + ')');
        l.title = title; l.settings = ms; persist(); return l;
    }
    /** After a settings change in the pre-meeting screen: update Meet too if this meeting is already registered there. */
    async function updateIfLinked(meeting, desired) {
        const digits = digitsOf(meeting.meetingId); if (!enabled() || !links[digits]) return false;
        await syncLink(digits, String(desired.title || meeting.topic || 'Meeting').slice(0, 160), meetSettings(desired.settings || {})); return true;
    }

    /** Joins `name` to the Meet meeting; { host: true } uses the host credential. Returns { token, meetingId, participantId, admission } for the browser. */
    async function join(link, { name, host }) {
        const base = await internalBase(); if (!base) throw unavailable('Qorlla Meet is not reachable');
        const r = await call(base, '/api/meetings/' + encodeURIComponent(link.meetUuid) + '/join', 'POST', { name: String(name || 'Guest').slice(0, 70), ...(host ? { hostSecret: link.hostSecret } : { passcode: link.meetPass }) });
        if (!r.ok) throw Object.assign(new Error(r.data.error || 'Meet refused the join'), { status: r.status, code: r.status === 403 || r.status === 404 ? 'REFUSED' : 'UNAVAILABLE' });
        return { token: r.data.token, meetingId: r.data.meetingId, participantId: r.data.participantId, admission: r.data.admission };
    }

    /** Where to send the browser. The session travels in the fragment (never sent to any server, removed by Meet at once). */
    function url(publicBase, session, { mic = true, camera = true, returnUrl = '', prefs = null } = {}) {
        const q = new URLSearchParams({ mic: mic ? 'true' : 'false', camera: camera ? 'true' : 'false' });
        if (returnUrl) q.set('return', returnUrl);
        const payload = { token: session.token, meetingId: session.meetingId, participantId: session.participantId };
        if (prefs && (prefs.camLabel || prefs.micLabel || prefs.spkLabel)) payload.prefs = { camLabel: String(prefs.camLabel || '').slice(0, 120), micLabel: String(prefs.micLabel || '').slice(0, 120), spkLabel: String(prefs.spkLabel || '').slice(0, 120) };
        return publicBase + '?' + q.toString() + '#qs=' + Buffer.from(JSON.stringify(payload)).toString('base64url');
    }
    const forget = (meetingId) => { const d = digitsOf(meetingId); if (links[d]) { delete links[d]; persist(); } };
    return { enabled, ensureLink, updateIfLinked, join, url, ping, forget, _links: () => links };
}

module.exports = { createMeetLaunch };
