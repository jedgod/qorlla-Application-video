// Navigation, link and permission policy for the Qorlla mobile client. Pure functions (no React Native imports) so they are tested in Node.
// The app shows only the Qorlla web app and Qorlla Meet (bare HTTPS origins, configured at build time). Anything else is refused or handed to the system browser as a plain https link.
const LOCAL = new Set(['localhost', '127.0.0.1']);
export const ANDROID_MEETING_PERMISSIONS = Object.freeze(['android.permission.CAMERA', 'android.permission.RECORD_AUDIO']);

/** A bare origin: https, no credentials, path, query or fragment. Plain http is accepted only for localhost/127.0.0.1 and only when `allowLocalhostHttp` (a TEST BUILD flag) is set. */
export function verifiedOrigin(raw, { allowLocalhostHttp = false } = {}) {
  let u; try { u = new URL(String(raw)); } catch { throw new Error('Configure a verified HTTPS origin'); }
  const ok = u.protocol === 'https:' || (allowLocalhostHttp && u.protocol === 'http:' && LOCAL.has(u.hostname));
  if (!ok || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Configure a verified HTTPS origin');
  return u.origin;
}
export function createPolicy({ appUrl, meetUrls = '', allowLocalhostHttp = false } = {}) {
  const opts = { allowLocalhostHttp }, origins = [verifiedOrigin(appUrl, opts)];
  for (const raw of String(meetUrls || '').split(',').map((s) => s.trim()).filter(Boolean)) { const o = verifiedOrigin(raw, opts); if (!origins.includes(o)) origins.push(o); }
  const trusted = (raw) => { try { const u = new URL(raw); return origins.includes(u.origin) && (u.protocol === 'https:' || (allowLocalhostHttp && u.protocol === 'http:' && LOCAL.has(u.hostname))); } catch { return false; } };
  const external = (raw) => { try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } };
  return Object.freeze({
    origins, allowLocalhostHttp, appOrigin: origins[0], isTrusted: trusted, canOpenExternally: external,
    prejoinUrl: (meetingId) => { if (!/^[0-9]{11}$/.test(String(meetingId))) throw new Error('Invalid meeting id'); return origins[0] + '/guest/meeting/' + meetingId + '/prejoin'; },
    pathUrl: (path) => { if (!/^\/[a-z0-9/_-]*$/i.test(path) || path.startsWith('//')) throw new Error('Invalid application path'); return origins[0] + path; }
  });
}
/** qorlla://join?meeting=<11 digits> -> { meetingId }; anything extra, malformed or path-carrying is null. */
export function parseJoinLink(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'qorlla:' || u.hostname !== 'join' || (u.pathname !== '' && u.pathname !== '/') || u.username || u.password || u.hash) return null;
    const keys = [...u.searchParams.keys()]; if (keys.length !== 1 || keys[0] !== 'meeting') return null;
    const id = u.searchParams.get('meeting'); return /^[0-9]{11}$/.test(id || '') ? { meetingId: id } : null;
  } catch { return null; }
}
/** Decision for one navigation request inside the WebView. */
export function navigationDecision(policy, url) {
  if (policy.isTrusted(url)) return 'allow';
  if (policy.canOpenExternally(url)) return 'external';
  return 'block';
}
/** Test builds (never store builds) may use http://localhost and a debuggable WebView. `dev` is React Native's __DEV__; `testBuild` the build-time EXPO_PUBLIC_QORLLA_TEST_BUILD flag. */
export const testHooksEnabled = ({ dev = false, testBuild = '' } = {}) => dev === true || testBuild === '1';
