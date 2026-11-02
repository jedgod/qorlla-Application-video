import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FOOTER, LANGUAGES, ROUTES, FEATURES, groupMeetingId, isSupportedLanguage, localeScript, parseMeetingId, columns, fitScale, HERO, heroArtWidth } from '../src/welcome.js';
import { createPolicy } from '../src/policy.js';
import { CATALOG, digitsHint, tooLongHint, translate } from '../src/i18n.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const SCREEN = read('../src/WelcomeScreen.js'), APP = read('../App.js'), ICONS = read('../src/icons.js');

test('meeting ID: exactly 11 digits is valid; spaces, hyphens and dots are accepted formatting', () => {
  assert.equal(parseMeetingId('12345678901').state, 'valid');
  assert.equal(parseMeetingId('123 4567 8901').digits, '12345678901');
  assert.equal(parseMeetingId('123-4567-8901').state, 'valid');
  assert.equal(parseMeetingId('').state, 'empty'); assert.equal(parseMeetingId(null).state, 'empty'); assert.equal(parseMeetingId(undefined).state, 'empty');
});
test('meeting ID: incomplete, letters and extra digits are each rejected with a message, and nothing is truncated', () => {
  assert.equal(parseMeetingId('1234567890').state, 'incomplete'); assert.match(parseMeetingId('1234567890').message, /10 of 11/);
  const letters = parseMeetingId('1234abc5678'); assert.equal(letters.state, 'letters'); assert.match(letters.message, /digits only/);
  const long = parseMeetingId('123456789012345'); assert.equal(long.state, 'too-long'); assert.equal(long.digits, '123456789012345', 'pasted digits stay as pasted'); assert.match(long.message, /15 digits.*nothing was cut off/);
  for (const bad of ['12345678901x', '１２３４５６７８９０１', '1234567890\n1', '1e10000000', '+1234567890', '12345678901.5']) assert.notEqual(parseMeetingId(bad).state, 'valid', JSON.stringify(bad));
});
test('meeting ID grouping is display only', () => {
  assert.equal(groupMeetingId('12345678901'), '123 4567 8901'); assert.equal(groupMeetingId('1234'), '123 4'); assert.equal(groupMeetingId('12'), '12');
  assert.equal(parseMeetingId(groupMeetingId('12345678901')).state, 'valid');
});
test('the four feature cards keep their copy and only move to the meeting field or open an informational page', () => {
  assert.deepEqual(FEATURES.map((f) => f.title), ['Video Meetings', 'Team Collaboration', 'Communication', 'Security & Privacy']);
  assert.equal(FEATURES.find((f) => f.key === 'video').gate, 'focus');
  for (const f of FEATURES.filter((x) => x.gate === 'page')) assert.ok(Object.values(ROUTES).includes(f.path), f.key);
  assert.ok(FEATURES.every((f) => f.gate === 'focus' || f.gate === 'page'), 'no card starts a service');
  assert.doesNotMatch(SCREEN, /Phone Calls|PSTN|tel:/);
});
test('every route the screen can open is accepted by the app policy and stays on the app origin (no new backend)', () => {
  const policy = createPolicy({ appUrl: 'https://app.staging.qorlla.net' });
  for (const [name, p] of Object.entries(ROUTES)) assert.equal(policy.pathUrl(p), 'https://app.staging.qorlla.net' + p, name);
  assert.deepEqual(ROUTES, { signIn: '/auth/login', guest: '/guest/welcome', help: '/guest/help', learn: '/guest/explore' });
});
test('the guest action opens Guest Welcome, never a meeting', () => { assert.equal(ROUTES.guest, '/guest/welcome'); assert.doesNotMatch(SCREEN, /prejoin|\/guest\/meeting/); });
test('footer wording is the specified one and does not promise phone calls or messaging', () => {
  assert.equal(FOOTER, "Meetings use Qorlla's own meeting service. Restricted services remain unavailable in this build.");
  assert.doesNotMatch(FOOTER, /yet|soon|coming/i);
});
test('languages are the four the web app ships, the locale script writes the web key only for a supported code', () => {
  assert.deepEqual(LANGUAGES.map((l) => l.code), ['en', 'es', 'fr', 'pt-PT']); assert.ok(isSupportedLanguage('pt-PT')); assert.ok(!isSupportedLanguage("x');alert(1);//"));
  assert.match(localeScript('fr'), /qorlla\.locale','fr'|qorlla\.locale',"fr"/); assert.equal(localeScript("x');alert(1);//"), 'true;'); assert.doesNotMatch(localeScript('fr'), /alert/);
});
test('one scale from the window width and height keeps the whole page on one screen; columns stay two/three across from 300dp', () => {
  assert.equal(fitScale(390, 900), 1); assert.equal(fitScale(1000, 5000), 1.06); assert.equal(fitScale(100, 5000), 0.66);
  assert.equal(fitScale(411, 385), 0.66, 'a very short window is limited by the floor, never zero');
  assert.ok(fitScale(412, 900 * 0.8) < fitScale(412, 900), 'a shorter window shrinks everything');
  assert.ok(fitScale(320, 2000) < fitScale(412, 2000), 'a narrower window shrinks everything');
  for (const w of [320, 360, 390, 412]) assert.deepEqual(columns({ width: w, fontScale: 1.3 }), { features: 2, accounts: 2, utility: 3 }, String(w));
  assert.deepEqual(columns({ width: 280 }), { features: 1, accounts: 1, utility: 1 });
});
test('design tokens match the specification', () => {
  for (const [k, v] of Object.entries({ bg: '#030B16', hero: '#071D38', card: '#071D34', elevated: '#102642', border: '#173C61', blue: '#087BFA', cyan: '#00D7E8', purple: '#9258F5', green: '#00D9AD', orange: '#FFAB19', text: '#F6F9FF', text2: '#A7C2E5' })) assert.ok(SCREEN.includes(k + ": '" + v + "'"), k);
});
test('the screen has the copy of the design and the ids the device test uses', () => {
  for (const t of ['Meet · Connect · Collaborate', 'A secure workspace for video meetings, team collaboration and communication anywhere in the world.', 'Join a Meeting', 'Enter the 11-digit meeting ID to join a session.', '11-digit meeting ID', 'Join Meeting', 'Sign In', 'Use your Qorlla account', 'Continue as Guest', 'Join without an account', 'Help & Support', 'Get help, tutorials and FAQs', 'Explore Qorlla', 'Learn more about features and use cases', 'Settings', 'Audio, video and app preferences', "t('OR')"]) assert.ok(SCREEN.includes(t), t);
  for (const t of ['Host and join collaborative sessions with high-quality video and audio.', 'Work together with your team, share ideas and get things done.', 'Stay connected with chats, communities and secure messaging.', 'Your data, meetings and conversations are protected and under your control.']) assert.ok(read('../src/welcome.js').includes(t), t);
  for (const id of ['meeting-id', 'join', 'sign-in', 'guest', 'language-select', 'util-', 'feature-', 'welcome-screen']) assert.ok(SCREEN.includes(id), id);
});
test('titles: one-word titles shrink on one line, longer titles wrap at spaces', () => { assert.match(SCREEN, /const titleLines = \(text\) =>/); assert.match(SCREEN, /lines=\{titleLines\(t\(f\.title\)\)\}/); assert.match(SCREEN, /lines=\{titleLines\(t\(u\.title\)\)\}/); });
test('autosizing: sizes are scaled from the window width, one-line labels shrink to fit, nothing uses a fixed pixel width for text', () => {
  assert.match(SCREEN, /fitScale\(width, availH/); assert.match(SCREEN, /adjustsFontSizeToFit/); assert.match(SCREEN, /minimumFontScale/); assert.match(SCREEN, /function makeStyles\(k, heroW, artW\)/); assert.match(SCREEN, /useWindowDimensions/);
});
test('screen rules: numeric keyboard, no maxLength truncation, disabled until valid, globe never takes touches and is hidden from TalkBack, font scaling is capped not disabled', () => {
  assert.match(SCREEN, /keyboardType="number-pad"/); assert.doesNotMatch(SCREEN, /maxLength/); assert.match(SCREEN, /disabled=\{!canJoin\}/); assert.match(SCREEN, /pointerEvents="none"/); assert.match(ICONS, /no-hide-descendants/);
  assert.match(SCREEN, /maxFontSizeMultiplier/); assert.doesNotMatch(SCREEN.replace(/allowFontScaling=\{false\}/, ''), /allowFontScaling=\{false\}/, 'only the decorative wordmark opts out');
  assert.match(SCREEN, /keyboardShouldPersistTaps="handled"/); assert.match(SCREEN, /<ScrollView/); assert.doesNotMatch(SCREEN, /scrollEnabled=\{true\}/);
});
test('no remote assets or tracking on the welcome screen', () => { for (const src of [SCREEN, ICONS]) assert.doesNotMatch(src, /https?:\/\/|uri:|require\(['"]http/); });
test('touch targets: every interactive style has a 48dp minimum height', () => {
  for (const name of ['lang', 'feature', 'join', 'action', 'util', 'langItem']) { const m = SCREEN.match(new RegExp('\\b' + name + ': \\{[^}]*minHeight: (?:tap\\()?(\\d+)')); assert.ok(m && Number(m[1]) >= 48, name); }
});
test('App wiring: joining is guarded against duplicates, the ID survives a failed join, sign in/guest/help go through the existing policy paths', () => {
  assert.match(APP, /joiningRef\.current\) return/); assert.match(APP, /finally \{ joiningRef\.current = false; setJoining\(false\); \}/); assert.match(APP, /policy\.pathUrl\(path\)/);
  assert.match(APP, /meetingRaw=\{meeting\}/, 'the typed ID lives in App state, so opening a page and coming back keeps it');
  assert.match(APP, /prejoinUrl\(meetingId\)/, 'joining still goes through the existing prejoin route');
});

test('translations: every visible string of the Welcome screen exists in French, Spanish and Portuguese, and nothing falls back to an empty label', () => {
  const english = [...FEATURES.flatMap((f) => [f.title, f.desc]), 'Language', 'Meet · Connect · Collaborate', 'A secure workspace for video meetings, team collaboration and communication anywhere in the world.', 'Join a Meeting', 'Enter the 11-digit meeting ID to join a session.', '11-digit meeting ID', 'Join Meeting', 'Joining…', 'OR', 'Sign In', 'Use your Qorlla account', 'Continue as Guest', 'Join without an account', 'Help & Support', 'Get help, tutorials and FAQs', 'Explore Qorlla', 'Learn more about features and use cases', 'Settings', 'Audio, video and app preferences', FOOTER, parseMeetingId('12ab').message];
  for (const lang of ['es', 'fr', 'pt-PT']) for (const e of english) { const t = CATALOG[lang][e]; assert.ok(t && t.length >= 1, lang + ': ' + e); if (!['Communication', 'OR'].includes(e)) assert.notEqual(t, e, lang + ' differs from English: ' + e); }
  assert.equal(translate('en', 'Sign In'), 'Sign In'); assert.equal(translate('xx', 'Sign In'), 'Sign In'); assert.equal(translate('fr', 'unknown text'), 'unknown text');
  assert.match(digitsHint('fr', 3), /3 sur 11 chiffres/); assert.match(digitsHint('es', 3), /3 de 11 dígitos/); assert.equal(digitsHint('en', 3), '3 of 11 digits'); assert.match(tooLongHint('pt-PT', 13), /13 dígitos/); assert.match(tooLongHint('en', 13), /13 digits.*nothing was cut off/);
});
test('the screen sends every visible string through the translator', () => { for (const m of ['t(f.title)', "t('Join Meeting')", "t('Sign In')", 't(FOOTER)', "t('Meet · Connect · Collaborate')"]) assert.ok(SCREEN.includes(m), m); });

test('pages that are separate documents (chat, portal /app/*) get a native close bar; hardware Back follows the own back state of the WebView', () => {
  assert.ok(APP.includes(String.raw`const SEPARATE_PAGE = /^\/(chat\.html|app(\/|$))/;`), 'the pattern for separate pages'); assert.ok(APP.includes('testID="page-close"')); assert.ok(APP.includes('accessibilityLabel="Close and go back"'));
  assert.ok(APP.includes("history.length>1?history.back():location.replace('/qorlla.html')"), 'closing goes back one page, or to the workspace when there is nothing behind');
  assert.ok(APP.includes('if (canGoBack.current && web.current) { web.current.goBack(); return true; } setUrl(null); return true;'), 'hardware Back follows the own back state of the WebView (a page with nothing behind it leaves to the Welcome screen); it never traps the person'); assert.ok(!APP.includes('HISTORY_PROBE'));
  const SEP = /^\/(chat\.html|app(\/|$))/; for (const ok of ['/chat.html', '/app', '/app/', '/app/suite', '/app/meet']) assert.ok(SEP.test(ok), ok);
  for (const no of ['/qorlla.html', '/guest/welcome', '/meet/room', '/application', '/guest/chat.html']) assert.ok(!SEP.test(no), no);
});

test('the decorative circle always fits inside the hero block, whatever the phone (it must never overlap the feature cards)', () => {
  for (const [w, h] of [[320, 568], [360, 640], [360, 592], [384, 700], [390, 844], [412, 915], [412, 600], [600, 960], [800, 1280]]) {
    const k = fitScale(w, h - 24 - 48), inner = w - 2 * Math.round(16 * k), artW = heroArtWidth(inner, k);
    const bottom = HERO.artTop * k + artW * HERO.artRatio, heroH = HERO.height * k;
    assert.ok(bottom <= heroH, `${w}x${h}: circle bottom ${bottom.toFixed(1)} must be above the hero bottom ${heroH.toFixed(1)}`);
    assert.ok(artW <= inner * 0.32 + 1 && artW >= 40, `${w}x${h}: a reasonable size`);
  }
  assert.ok(heroArtWidth(358, 1) < Math.round(358 * 0.38), 'smaller than the old 38% circle');
});
