'use strict';
// Navigation, permission and deep-link policy for the Qorlla desktop shell. Pure functions (tested without Electron).
// The shell may only ever show the Qorlla web app and Qorlla Meet: a bare HTTPS origin for each. Everything else is refused or sent to the system browser.
const { URL } = require('node:url');

const LOCAL = new Set(['localhost', '127.0.0.1']);
/** A bare origin: https, no credentials, path, query or fragment. `allowLocalhostHttp` (development only, decided by the caller) additionally accepts http on localhost/127.0.0.1. */
function verifiedOrigin(raw, { allowLocalhostHttp = false } = {}) {
  const u = new URL(raw);
  const okScheme = u.protocol === 'https:' || (allowLocalhostHttp && u.protocol === 'http:' && LOCAL.has(u.hostname));
  if (!okScheme || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('A bare HTTPS origin is required');
  return u.origin;
}
/** The set of origins the shell trusts: the app origin plus any explicitly configured Meet origins (comma separated). */
function trustedOrigins(appUrl, meetUrls = '', opts = {}) {
  const list = [verifiedOrigin(appUrl, opts)];
  for (const raw of String(meetUrls || '').split(',').map((s) => s.trim()).filter(Boolean)) { const o = verifiedOrigin(raw, opts); if (!list.includes(o)) list.push(o); }
  return list;
}
const asList = (origins) => (Array.isArray(origins) ? origins : [origins]);
function navigationAllowed(raw, origins, opts = {}) {
  try { const u = new URL(raw); return asList(origins).includes(u.origin) && (u.protocol === 'https:' || (!!opts.allowLocalhostHttp && u.protocol === 'http:' && LOCAL.has(u.hostname))); } catch { return false; }
}
/** What may be handed to the system browser: plain https links only (never credentials, never file:, never custom schemes). */
function externalAllowed(raw) { try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } }
/** qorlla://join?meeting=<11 digits> -> { meetingId }; anything else is null (an unknown link is ignored, never navigated to). */
function parseJoinLink(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'qorlla:' || u.hostname !== 'join' || (u.pathname !== '' && u.pathname !== '/') || u.username || u.password || u.hash) return null;
    const keys = [...u.searchParams.keys()]; if (keys.length !== 1 || keys[0] !== 'meeting') return null;
    const id = u.searchParams.get('meeting'); return /^[0-9]{11}$/.test(id || '') ? { meetingId: id } : null;
  } catch { return null; }
}
/** The page that joins a meeting as a guest or signed-in user. The id was validated as 11 digits, so nothing else can reach the path. */
const prejoinUrl = (origin, meetingId) => origin + '/guest/meeting/' + encodeURIComponent(meetingId) + '/prejoin';
/** Permissions the shell grants, and only to trusted origins. Screen capture is separate: it needs an explicit person-confirmed choice (see main.cjs). */
const PERMISSIONS = new Set(['media', 'display-capture', 'notifications']);
const permissionAllowed = (permission, requestingUrl, origins, opts) => PERMISSIONS.has(permission) && navigationAllowed(requestingUrl, origins, opts);
/** The development exception for http://localhost: never in a packaged build, and only when explicitly asked for. */
const localhostHttpAllowed = (env, isPackaged) => !isPackaged && env.QORLLA_DEV_ALLOW_LOCALHOST_HTTP === '1';
/** Chromium switches that turn its process sandbox off. A packaged build must refuse to run with any of them, whatever launcher or desktop entry passed them. */
const SANDBOX_OFF = /^--(no-sandbox|disable-setuid-sandbox|disable-gpu-sandbox|disable-seccomp-filter-sandbox|disable-namespace-sandbox|disable-renderer-sandbox|disable-sandbox)(=.*)?$/i;
const sandboxDisabled = (argv) => (argv || []).some((a) => SANDBOX_OFF.test(String(a)));
module.exports = { verifiedOrigin, trustedOrigins, navigationAllowed, externalAllowed, parseJoinLink, prejoinUrl, permissionAllowed, localhostHttpAllowed, sandboxDisabled, PERMISSIONS };
