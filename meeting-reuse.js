'use strict';
// Meeting re-use policy: how many times a finished meeting (same Meeting ID, same password) may be opened again, depending on the HOST's subscription.
//
// The Portal is the entitlement authority (like meeting-limit.js): the count and the limit are decided here, on the server, from the host's account; the page only displays them.
// Real billing is not connected in this repository, so "plan" is read from the account record (`plan`: free | pro | business | enterprise) and from MEETING_LIMIT_EXEMPT_USERS
// (listed users count as paid: pro). Defaults, all changeable by environment (blank or -1 = unlimited, 0 = no re-use):
//   REUSE_LIMIT_FREE=3   REUSE_LIMIT_PRO=25   REUSE_LIMIT_BUSINESS=100   REUSE_LIMIT_ENTERPRISE=unlimited
// The limit applies to the plan the host has WHEN they ask (a downgrade lowers it at once; re-uses already made keep counting).
const ML = require('./meeting-limit');

const PLANS = ['free', 'pro', 'business', 'enterprise'];
const DEFAULTS = { free: 3, pro: 25, business: 100, enterprise: null };           // null = unlimited

function planOf(user, env = process.env) {
    if (!user) return 'free';
    const p = String(user.plan || '').toLowerCase(); if (PLANS.includes(p) && p !== 'free') return p;
    return ML.isExempt(user, env) ? 'pro' : 'free';
}
/** The number of re-uses a plan allows: a non-negative integer, or null for unlimited. */
function limitFor(plan, env = process.env) {
    const p = PLANS.includes(plan) ? plan : 'free', raw = env['REUSE_LIMIT_' + p.toUpperCase()];
    if (raw === undefined) return DEFAULTS[p];
    const s = String(raw).trim().toLowerCase(); if (s === '' || s === '-1' || s === 'unlimited') return null;
    const n = Number(s); return Number.isInteger(n) && n >= 0 ? n : DEFAULTS[p];
}
/** { plan, limit, used, remaining, allowed }: `used` = re-uses already made for this meeting; remaining is null when unlimited. */
function evaluate(user, used, env = process.env) {
    const plan = planOf(user, env), limit = limitFor(plan, env), n = Math.max(0, Number(used) || 0);
    const remaining = limit === null ? null : Math.max(0, limit - n);
    return { plan, limit, used: n, remaining, allowed: limit === null || n < limit };
}
const refusal = (e) => e.limit === 0
    ? 'Your plan does not include re-using a meeting. Upgrade to have full access to Qorlla packages.'
    : 'You have used all ' + e.limit + ' re-uses your ' + e.plan + ' plan allows for this meeting. Upgrade to have full access to Qorlla packages.';

module.exports = { PLANS, DEFAULTS, planOf, limitFor, evaluate, refusal };
