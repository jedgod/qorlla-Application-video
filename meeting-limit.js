'use strict';
// Free-plan meeting time limit: a meeting hosted on the free plan may run FREE_MEETING_LIMIT_MIN minutes (default 30), then a grace period of
// FREE_MEETING_GRACE_MIN minutes (default 10) with repeated "Upgrade" reminders, and then the meeting is closed with the message
// "Upgrade to have full access to Qorlla packages". Hosts on a paid plan are never interrupted.
//
// Whose plan counts: the HOST's, decided when the meeting is created (stored on the record as limitExempt). Real billing is not connected here, so
// exemption comes from MEETING_LIMIT_EXEMPT_USERS (comma-separated usernames, a trailing * is a prefix) or a `plan` of pro/business/enterprise on the
// account record once the portal writes one. FREE_MEETING_LIMIT_MIN=0 switches the limit off for the whole server.
// MEETING_LIMIT_UNIT_MS (default 60000 = one minute) exists so automated tests can run the whole sequence in seconds.
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
const UPGRADE_MESSAGE = 'Upgrade to have full access to Qorlla packages';

function config(env = process.env) {
    const unit = num(env.MEETING_LIMIT_UNIT_MS, 60000) || 60000;
    return { limitMs: Math.round(num(env.FREE_MEETING_LIMIT_MIN, 30) * unit), graceMs: Math.round(num(env.FREE_MEETING_GRACE_MIN, 10) * unit), unit };
}
function isExempt(user, env = process.env) {
    if (!user) return false;
    const name = String(user.username || '').toLowerCase();
    const listed = String(env.MEETING_LIMIT_EXEMPT_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
        .some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
    return listed || ['pro', 'business', 'enterprise'].includes(String(user.plan || '').toLowerCase());
}
/** { limitMs, graceMs } for a meeting, or null when it has no limit (exempt host, or the limit is switched off). */
function limitsFor(exempt, env = process.env) { const c = config(env); return exempt || c.limitMs <= 0 ? null : { limitMs: c.limitMs, graceMs: c.graceMs }; }

/** The reminders and the closing moment, as offsets from the start of the meeting: at the limit, half way through the grace period, in the last
 *  unit of it, and at the end. Returns [{ at, phase }] ascending; phase 'close' is the end. */
function plan({ limitMs, graceMs }, unit = config().unit) {
    const end = limitMs + graceMs, marks = [{ at: limitMs, phase: 'limit' }];
    if (graceMs >= 4 * unit) marks.push({ at: limitMs + Math.round(graceMs / 2), phase: 'reminder' });
    if (graceMs >= 2 * unit) marks.push({ at: end - unit, phase: 'final' });
    marks.push({ at: end, phase: 'close' });
    return marks.filter((m, i, a) => i === 0 || m.at > a[i - 1].at);
}
function reminderText(phase, remainingMs, unit = config().unit) {
    const mins = Math.max(1, Math.ceil(remainingMs / unit));
    return phase === 'close' ? UPGRADE_MESSAGE : 'You are on the free plan. This meeting closes in about ' + mins + ' minute' + (mins === 1 ? '' : 's') + '. Upgrade to have full access to Qorlla packages without interruptions.';
}
/** Arms the timers. `emit({phase,remainingMs,endsAt,message})` for reminders; `close()` at the end. Returns a function that cancels everything. */
function arm({ startedAt, limits, now = Date.now(), emit, close, unit = config().unit }) {
    const timers = [], endsAt = startedAt + limits.limitMs + limits.graceMs, marks = plan(limits, unit);
    const runner = (m) => () => { const remainingMs = Math.max(0, endsAt - Date.now()); if (m.phase === 'close') close(); else emit({ phase: m.phase, remainingMs, endsAt, message: reminderText(m.phase, remainingMs, unit) }); };
    for (const m of marks) { const delay = startedAt + m.at - now; if (delay > 0) timers.push(setTimeout(runner(m), delay)); }
    const due = marks.filter((m) => startedAt + m.at <= now); if (due.length) timers.push(setTimeout(runner(due[due.length - 1]), 0));   // overdue (a restart): only the newest missed step runs, at once
    return () => timers.forEach(clearTimeout);
}

module.exports = { config, isExempt, limitsFor, plan, reminderText, arm, UPGRADE_MESSAGE };
