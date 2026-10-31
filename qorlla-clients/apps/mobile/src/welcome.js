// Pure logic for the Welcome / Join screen (no React Native imports, so it is tested in Node).

/**
 * Reads what the person typed or pasted into the meeting-ID field.
 * Spaces (also non-breaking), hyphens and dots are accepted formatting and ignored; any other non-digit, too few digits or too many digits is reported, never silently dropped or truncated.
 * Returns { digits, state, message }, state one of: empty | incomplete | valid | letters | too-long.
 */
export function parseMeetingId(raw) {
  const text = String(raw == null ? '' : raw);
  const stripped = text.replace(/[  \-.]/g, '');
  if (stripped === '') return { digits: '', state: 'empty', message: '' };
  if (/\D/.test(stripped)) return { digits: stripped.replace(/\D/g, ''), state: 'letters', message: 'A meeting ID contains digits only. Remove the letters or symbols.' };
  if (stripped.length > 11) return { digits: stripped, state: 'too-long', message: 'That is ' + stripped.length + ' digits. A meeting ID has exactly 11; nothing was cut off.' };
  if (stripped.length < 11) return { digits: stripped, state: 'incomplete', message: stripped.length + ' of 11 digits' };
  return { digits: stripped, state: 'valid', message: '11 of 11 digits' };
}

/** Shows an ID as 3-4-4 groups while it is typed; the stored value is still the plain digits. */
export const groupMeetingId = (digits) => String(digits).replace(/^(\d{3})(\d{1,4})?(\d{1,4})?.*$/, (m, a, b, c) => [a, b, c].filter(Boolean).join(' '));

/** The four feature cards under the hero. `gate` says what a tap does: 'focus' (go to the meeting field) or 'page' (open an informational page of the existing guest site). No card starts a service. */
export const FEATURES = Object.freeze([
  { key: 'video', title: 'Video Meetings', desc: 'Host and join collaborative sessions with high-quality video and audio.', gate: 'focus' },
  { key: 'team', title: 'Team Collaboration', desc: 'Work together with your team, share ideas and get things done.', gate: 'page', path: '/guest/explore' },
  { key: 'comm', title: 'Communication', desc: 'Stay connected with chats, communities and secure messaging.', gate: 'page', path: '/guest/explore' },
  { key: 'secure', title: 'Security & Privacy', desc: 'Your data, meetings and conversations are protected and under your control.', gate: 'page', path: '/guest/explore' },
]);

/** Existing web routes the screen opens; each is a path the app policy accepts (see policy.pathUrl). Sign in and guest welcome are the existing flows. */
export const ROUTES = Object.freeze({ signIn: '/auth/login', guest: '/guest/welcome', help: '/guest/help', learn: '/guest/explore' });

/** Languages the web app ships catalogs for (locales/*.js); the code is what the web app stores under localStorage key qorlla.locale. */
export const LANGUAGES = Object.freeze([
  { code: 'en', label: 'English' }, { code: 'es', label: 'Español' }, { code: 'fr', label: 'Français' }, { code: 'pt-PT', label: 'Português (Portugal)' },
]);
export const isSupportedLanguage = (code) => LANGUAGES.some((l) => l.code === code);

export const FOOTER = "Meetings use Qorlla's own meeting service. Restricted services remain unavailable in this build.";

/** Script run inside the WebView before any page loads, so the web pages open in the language chosen on this screen (the web app persists it itself). */
export const localeScript = (code) => (isSupportedLanguage(code) ? "try{localStorage.setItem('qorlla.locale'," + JSON.stringify(code) + ");}catch(e){}true;" : 'true;');

/** Design width the layout was drawn at (dp), and the range the whole layout is scaled over so it fits any phone. */
export const BASE_WIDTH = 390;
export const layoutScale = (width) => Math.min(1.12, Math.max(0.8, width / BASE_WIDTH));
/** Columns for each block. The feature cards sit two across only while their text column stays wide enough for the longest word ("Collaboration") at the current text size; the account buttons two across, the utility cards three across, on the same terms. Otherwise one column. */
export const columns = ({ width, fontScale }) => {
  const f = Math.min(fontScale, 1.08), inner = width - 40, featText = (inner - 10) / 2 - 76, acctText = (inner - 10) / 2 - 78, utilText = (inner - 20) / 3 - 20;
  return { features: featText >= 88 * f ? 2 : 1, accounts: acctText >= 80 * f ? 2 : 1, utility: utilText >= 84 * f ? 3 : 1 };
};
