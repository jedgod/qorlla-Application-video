'use strict';
// Build profiles for the mobile app: development (default), staging, production. Read by app.config.js at `expo prebuild` time, so a bad configuration fails the BUILD, not the person holding the phone.
//   development  origins optional (the app fails closed without them); test hooks allowed
//   staging      EXPO_PUBLIC_QORLLA_URL (+ EXPO_PUBLIC_QORLLA_MEET_URLS) REQUIRED: explicit public https origins; no test hooks, no localhost, no placeholders; clearly labelled and installable beside production
//   production   same origin rules as staging, normal identity
const PROFILES = new Set(['development', 'staging', 'production']);
const RESERVED = /(^|\.)(localhost|invalid|test|local|internal|example|example\.com|example\.org|example\.net)$/;
const PLACEHOLDER = /replace|changeme|your-domain|yourdomain|<|>/i;

/** A bare public https origin (no path, query, credentials, IP literal or reserved/placeholder name). Returns an error string or null. */
function originProblem(raw) {
  let u; try { u = new URL(String(raw)); } catch { return 'not a URL: ' + String(raw).slice(0, 40); }
  if (u.protocol !== 'https:') return 'must be https: ' + u.origin;
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') return 'must be a bare origin (no path, query or credentials): ' + u.origin;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || u.hostname.includes(':')) return 'must be a hostname with a valid certificate, not an IP address: ' + u.hostname;
  if (RESERVED.test(u.hostname) || PLACEHOLDER.test(String(raw)) || !u.hostname.includes('.')) return 'is a placeholder, local or reserved name: ' + u.hostname;
  return null;
}
function resolveProfile(env) {
  const profile = env.QORLLA_BUILD_PROFILE || 'development', errors = [];
  if (!PROFILES.has(profile)) errors.push('QORLLA_BUILD_PROFILE must be development, staging or production (got ' + JSON.stringify(profile) + ')');
  const isRelease = profile === 'staging' || profile === 'production', testBuild = env.QORLLA_TEST_BUILD === '1';
  if (isRelease) {
    if (testBuild || env.EXPO_PUBLIC_QORLLA_TEST_BUILD === '1') errors.push(profile + ' builds cannot carry the test-build flags (cleartext traffic, debuggable WebView, localhost)');
    const app = env.EXPO_PUBLIC_QORLLA_URL; if (!app) errors.push('EXPO_PUBLIC_QORLLA_URL is required for a ' + profile + ' build'); else { const p = originProblem(app); if (p) errors.push('EXPO_PUBLIC_QORLLA_URL ' + p); }
    for (const m of String(env.EXPO_PUBLIC_QORLLA_MEET_URLS || '').split(',').map((s) => s.trim()).filter(Boolean)) { const p = originProblem(m); if (p) errors.push('EXPO_PUBLIC_QORLLA_MEET_URLS ' + p); }
    if (!env.EXPO_PUBLIC_QORLLA_MEET_URLS) errors.push('EXPO_PUBLIC_QORLLA_MEET_URLS is required for a ' + profile + ' build');
  }
  const staging = profile === 'staging';
  return { profile, errors, testBuild: !isRelease && testBuild, name: staging ? 'Qorlla (Staging)' : 'Qorlla', androidPackage: staging ? 'com.qorlla.mobile.staging' : 'com.qorlla.mobile', iosBundle: staging ? 'com.qorlla.mobile.staging' : 'com.qorlla.mobile' };
}
/** Throws (failing `expo prebuild`) when the profile is invalid. */
function requireProfile(env) { const r = resolveProfile(env); if (r.errors.length) throw new Error('Invalid Qorlla build configuration:\n - ' + r.errors.join('\n - ')); return r; }
module.exports = { resolveProfile, requireProfile, originProblem };
