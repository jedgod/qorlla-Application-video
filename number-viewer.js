// Number Authority VIEWER policy (main app). A read-only role between "ordinary user" and "telephony administrator".
//  - Exact usernames only, from PHONE_NUMBER_VIEWER_USERS (no wildcards, unlike PHONE_ADMIN_USERS): a typo can never widen access.
//  - A verified email address is required; a suspended or unverified account is never a viewer.
//  - An administrator is never treated as a viewer (admin rights are decided separately and are not reduced or merged).
//  - The flag is sent to Meet only for a GET on a route in READ_ONLY, and only when the calling handler opts in (viewerRead). Meet's mutations all call assertAdmin, which a viewer cannot satisfy.
// MFA is not offered by this application yet, so it cannot be required here; that is a recorded certification blocker, not something this module pretends to do.
const READ_ONLY = new Set(['GET /numbers', 'GET /numbers/requests', 'GET /numbers/snapshot', 'GET /diagnostics']);

const viewerNames = (env) => String((env && env.PHONE_NUMBER_VIEWER_USERS) || '').toLowerCase().split(',').map((x) => x.trim()).filter((x) => x && !x.includes('*'));

function isViewer(user, isAdmin, env = process.env) {
    if (!user || isAdmin || user.emailVerified !== true || user.suspended) return false;
    return viewerNames(env).includes(String(user.username || '').toLowerCase());
}

// The actor sent to Meet for one request.
function actorFor(user, { admin, method, route, viewerRead }, env = process.env) {
    const viewer = !admin && viewerRead === true && READ_ONLY.has(method + ' ' + route) && isViewer(user, admin, env);
    return { id: user.id, admin: !!admin, viewer };
}

module.exports = { READ_ONLY, isViewer, actorFor };
