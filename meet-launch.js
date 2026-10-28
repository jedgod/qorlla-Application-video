'use strict';
// Hands people from this server's meeting records to Qorlla Meet (the full video app), straight into the meeting - no Meet landing page.
//
// A meeting known to this server (for example a scheduled one with ID 920 4304 5426) is registered with Meet once, server to server, through Meet's bridge
// (QORLLA_BRIDGE_SECRET). Meet answers with the meeting's host credential, which is kept here (encrypted at rest when ENCRYPT_KEY is set) and NEVER sent to a
// browser. To enter, this server joins the person to the Meet meeting on their behalf (the host with the host credential, everyone else with a private
// per-meeting secret that only this server knows) and sends the browser to Meet with the resulting session in the URL FRAGMENT, which Meet reads and
// removes immediately. Because only this server holds that secret, the passcode check done here cannot be bypassed by typing the ID into Meet directly.
//
// Off (returns null / throws 'unavailable') when Meet is not reachable or no bridge secret is configured: callers then fall back to the built-in room.
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

    /** The Meet-side record for a meeting of this server (registering it the first time). Returns { meetUuid, meetCode, hostSecret, meetPass }. */
    async function ensureLink(meeting, ownerName) {
        if (!enabled()) throw unavailable('No bridge secret is configured');
        const digits = digitsOf(meeting.meetingId);
        if (links[digits] && links[digits].meetUuid) return links[digits];
        if (inflight.has(digits)) return inflight.get(digits);                                   // concurrent first uses register once
        const job = (async () => {
            const base = await internalBase(); if (!base) throw unavailable('Qorlla Meet is not reachable');
            const meetPass = crypto.randomBytes(18).toString('base64url');
            const body = { sourceId: 'main-' + digits, title: String(meeting.topic || 'Meeting').slice(0, 160), ownerName: String(ownerName || 'Host').slice(0, 70), scheduledAt: meeting.startTime || null, passcodeHash: await bcrypt.hash(meetPass, 10) };
            if (/^\d{10,12}$/.test(digits)) body.legacyCode = digits;
            const r = await call(base, '/api/integrations/scheduled-meetings', 'POST', body, { 'x-qorlla-bridge-secret': secret() });
            if (!r.ok) throw unavailable('Meet refused the registration (' + r.status + ')');
            if (!r.data.created) throw unavailable('This meeting is already registered with Meet by another service');   // no credentials to hand over
            links[digits] = { sourceId: body.sourceId, meetUuid: r.data.meetingId, meetCode: r.data.meetingCode, hostSecret: r.data.hostSecret, meetPass, at: new Date().toISOString() };
            persist();
            return links[digits];
        })();
        inflight.set(digits, job);
        try { return await job; } finally { inflight.delete(digits); }
    }

    /** Joins `name` to the Meet meeting; { host: true } uses the host credential. Returns { token, meetingId, participantId } for the browser. */
    async function join(link, { name, host }) {
        const base = await internalBase(); if (!base) throw unavailable('Qorlla Meet is not reachable');
        const r = await call(base, '/api/meetings/' + encodeURIComponent(link.meetUuid) + '/join', 'POST', { name: String(name || 'Guest').slice(0, 70), ...(host ? { hostSecret: link.hostSecret } : { passcode: link.meetPass }) });
        if (!r.ok) throw Object.assign(new Error(r.data.error || 'Meet refused the join'), { status: r.status, code: r.status === 403 || r.status === 404 ? 'REFUSED' : 'UNAVAILABLE' });
        return { token: r.data.token, meetingId: r.data.meetingId, participantId: r.data.participantId };
    }

    /** Where to send the browser. The session travels in the fragment (never sent to any server, removed by Meet at once). */
    function url(publicBase, session, { mic = true, camera = true, returnUrl = '' } = {}) {
        const q = new URLSearchParams({ mic: mic ? 'true' : 'false', camera: camera ? 'true' : 'false' });
        if (returnUrl) q.set('return', returnUrl);
        return publicBase + '?' + q.toString() + '#qs=' + Buffer.from(JSON.stringify(session)).toString('base64url');
    }
    const forget = (meetingId) => { const d = digitsOf(meetingId); if (links[d]) { delete links[d]; persist(); } };
    return { enabled, ensureLink, join, url, forget, _links: () => links };
}

module.exports = { createMeetLaunch };
