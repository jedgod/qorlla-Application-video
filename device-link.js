/**
 * Server-issued device link for sign-up (the "az_dev" cookie). Used by auth.js.
 *
 * What it is: a random 256-bit value the SERVER creates and puts in an HttpOnly cookie the first time a browser creates an account. It says
 * "this browser already created these accounts". Only the SHA-256 of the value is stored, next to the ids of the accounts created from
 * that browser. The page can neither read nor choose it, and a value the server never issued is ignored.
 *
 * What it is not: an identity. Clearing cookies or using another browser gives a fresh value, so this slows careless repeat sign-ups and
 * nothing more; the per-account quotas in Clips are what make extra free accounts not worth making. There is no fingerprinting, and IP
 * addresses are never stored here. Stored data is deleted 90 days after the browser was last seen.
 *
 * Overrides: an administrator can allow ONE more sign-up of a given username (a family sharing a computer, a classroom). It expires after
 * 7 days or when used. Every override is written to a hash-chained audit trail in the same file write, so a change cannot be recorded
 * without its audit entry, and editing history afterwards is detectable.
 */
const crypto = require('crypto');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;
const COOKIE_RE = /^[A-Za-z0-9_-]{43}$/;                  // 32 random bytes, base64url

module.exports = function createDeviceLinks({ dir, store, maxAccounts = 2, retentionMs = 90 * DAY, overrideTtlMs = 7 * DAY, now = () => Date.now() }) {
    const file = path.join(dir, 'device-links.json');
    const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
    const load = () => {
        const d = store.readJson(file, null) || {};
        return { devices: d.devices && typeof d.devices === 'object' ? d.devices : {}, overrides: Array.isArray(d.overrides) ? d.overrides : [], audit: Array.isArray(d.audit) ? d.audit : [] };
    };
    const save = (d) => store.writeJson(file, d);
    const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

    const entryHash = (prev, e) => sha(prev + '|' + JSON.stringify([e.at, e.action, e.actor, e.target, e.detail]));
    function appendAudit(d, { action, actor, target, detail }) {
        const prev = d.audit.length ? d.audit[d.audit.length - 1].hash : 'genesis';
        const e = { at: new Date(now()).toISOString(), action, actor, target, detail };
        e.hash = entryHash(prev, e);
        d.audit.push(e);
    }

    /** Only counts: never who. A cookie the server did not issue (or that expired) counts as no cookie. */
    function status(cookie) {
        if (typeof cookie !== 'string' || !COOKIE_RE.test(cookie)) return { linked: false, count: 0 };
        const rec = load().devices[sha(cookie)];
        if (!rec || now() - rec.lastSeen > retentionMs) return { linked: false, count: 0 };
        return { linked: rec.userIds.length > 0, count: rec.userIds.length };
    }

    /** May this browser create another account named `username`? */
    function allowed(cookie, username) {
        if (status(cookie).count < maxAccounts) return true;
        const t = now();
        return load().overrides.some((o) => o.username === username && t - o.at < overrideTtlMs);
    }

    /** Records that this browser created `userId`. Returns the cookie value to set (the existing one, or a new one). Consumes a matching override. */
    function link(cookie, userId, username) {
        const d = load(); const t = now();
        let value = typeof cookie === 'string' && COOKIE_RE.test(cookie) && d.devices[sha(cookie)] && t - d.devices[sha(cookie)].lastSeen <= retentionMs ? cookie : null;
        if (!value) value = crypto.randomBytes(32).toString('base64url');
        const key = sha(value);
        const rec = d.devices[key] || { userIds: [], createdAt: t, lastSeen: t };
        if (!rec.userIds.includes(userId)) rec.userIds.push(userId);
        rec.lastSeen = t; d.devices[key] = rec;
        const i = d.overrides.findIndex((o) => o.username === username && t - o.at < overrideTtlMs);
        if (i >= 0) { const [o] = d.overrides.splice(i, 1); appendAudit(d, { action: 'override_used', actor: o.adminId, target: username, detail: 'sign-up completed' }); }
        save(d);
        return value;
    }

    function grantOverride({ username, reason, adminId }) {
        const u = String(username || '').trim().toLowerCase(); const r = clean(reason, 300);
        if (!/^[a-z0-9][a-z0-9_.-]{2,23}$/.test(u)) return { ok: false, error: 'That is not a valid username.' };
        if (r.length < 3) return { ok: false, error: 'A reason is required.' };
        const d = load();
        d.overrides = d.overrides.filter((o) => o.username !== u);
        d.overrides.push({ username: u, adminId, reason: r, at: now() });
        appendAudit(d, { action: 'override_granted', actor: adminId, target: u, detail: r });
        save(d);                                                   // the override and its audit entry are one write
        return { ok: true, expiresInDays: Math.round(overrideTtlMs / DAY) };
    }

    /** Deletes devices not seen for the retention period and expired overrides. The audit trail holds no device data and is kept. */
    function prune() {
        const d = load(); const t = now(); const before = Object.keys(d.devices).length;
        for (const k of Object.keys(d.devices)) if (t - d.devices[k].lastSeen > retentionMs) delete d.devices[k];
        d.overrides = d.overrides.filter((o) => t - o.at < overrideTtlMs);
        const removed = before - Object.keys(d.devices).length;
        if (removed || d.overrides.length !== load().overrides.length) save(d);
        return { removed };
    }

    function auditTrail() { return load().audit.map((e) => ({ at: e.at, action: e.action, actor: e.actor, target: e.target, detail: e.detail })); }
    function verifyAudit() {
        let prev = 'genesis';
        for (const e of load().audit) { if (entryHash(prev, e) !== e.hash) return false; prev = e.hash; }
        return true;
    }

    return { status, allowed, link, grantOverride, prune, auditTrail, verifyAudit, COOKIE_RE, maxAccounts };
};
