import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SafeAreaView, Text, View, Pressable, TextInput, StyleSheet, Alert, Linking, BackHandler, PermissionsAndroid, Platform, StatusBar as RNStatusBar } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { WebView } from 'react-native-webview';
import { createPolicy, navigationDecision, parseJoinLink, testHooksEnabled, ANDROID_MEETING_PERMISSIONS } from './src/policy';

// NOTE originWhitelist is ['*'] on purpose: react-native-webview tests that list against the bare origin and hands any miss to the system browser BEFORE our handler runs (a trailing "/*" never matches),
// so the exact-origin decision lives in onShouldStartLoadWithRequest (src/policy.js navigationDecision), the single place that allows, externalises or blocks.
// The app shows ONLY the Qorlla web app and Qorlla Meet inside a locked-down WebView (origins are fixed at build time; see src/policy.js).
// Meetings run on Qorlla's existing Meet web client and media path (signaling, TURN, SFU/mesh as deployed): this app adds the native shell, permissions, deep links and navigation rules.
// Test hooks (http://localhost, debuggable WebView) exist only in dev or a build made with EXPO_PUBLIC_QORLLA_TEST_BUILD=1; the production profile cannot carry them.
const TEST = testHooksEnabled({ dev: typeof __DEV__ !== 'undefined' && __DEV__, testBuild: process.env.EXPO_PUBLIC_QORLLA_TEST_BUILD });
// Event log for the certification runs only (test builds): event names and results, never meeting ids, URLs or user data.
const log = TEST ? (...a) => console.log('[qorlla-app]', ...a) : () => {};
let policy = null, configError = null;
try { policy = createPolicy({ appUrl: process.env.EXPO_PUBLIC_QORLLA_URL, meetUrls: process.env.EXPO_PUBLIC_QORLLA_MEET_URLS, allowLocalhostHttp: TEST }); } catch (e) { configError = e.message; }

// Android 15+ draws apps edge-to-edge: keep content below the system status bar (the old SafeAreaView does not inset on Android)
const TOP = Platform.OS === 'android' ? (RNStatusBar.currentHeight || 24) : 0;
const routes = [['Sign in', '/auth/login'], ['Continue as guest', '/guest/welcome'], ['Help and support', '/guest/help']];

/** Asks for camera and microphone. Returns { granted, blocked }: `blocked` means the system will not ask again, so the person must use Settings. */
async function ensureMeetingPermissions() {
  if (Platform.OS !== 'android') return { granted: true, blocked: false };
  const r = await PermissionsAndroid.requestMultiple(ANDROID_MEETING_PERMISSIONS);
  return { granted: ANDROID_MEETING_PERMISSIONS.every((p) => r[p] === PermissionsAndroid.RESULTS.GRANTED), blocked: ANDROID_MEETING_PERMISSIONS.some((p) => r[p] === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) };
}

export default function App() {
  const [url, setUrl] = useState(null), [meeting, setMeeting] = useState(''), [error, setError] = useState(''), web = useRef(null), canGoBack = useRef(false);

  const openUrl = useCallback((u, why) => { log('openUrl', why || 'direct'); setError(''); setUrl(u); }, []);
  const joinMeeting = useCallback(async (meetingId) => {
    if (!policy) return;
    let target; try { target = policy.prejoinUrl(meetingId); } catch { setError('Enter the 11-digit meeting ID.'); return; }
    log('joinMeeting: asking for permissions');
    const p = await ensureMeetingPermissions();
    log('joinMeeting: permissions', JSON.stringify(p));
    if (!p.granted) {
      log('alert shown', p.blocked ? 'blocked' : 'not-blocked');
      // Permission recovery: say what is missing and how to fix it; the person can still join and use the meeting without camera or microphone.
      Alert.alert('Camera and microphone', 'Qorlla needs camera and microphone access to be seen and heard in a meeting.' + (p.blocked ? ' Allow them in Settings.' : ''),
        [...(p.blocked ? [{ text: 'Open settings', onPress: () => Linking.openSettings() }] : []), { text: 'Join without', onPress: () => { log('alert: Join without pressed'); openUrl(target, 'join-without'); } }, { text: 'Cancel', style: 'cancel', onPress: () => log('alert: Cancel pressed') }], { onDismiss: () => log('alert dismissed') });
      return;
    }
    openUrl(target, 'granted');
  }, [openUrl]);

  // A qorlla://join?meeting=<id> link (from the system, a browser or a message) joins that meeting; any other link is ignored.
  useEffect(() => {
    const handle = (link, src) => { const j = link && parseJoinLink(link); log('link', src, j ? 'accepted' : link ? 'rejected' : 'none'); if (j) joinMeeting(j.meetingId); };
    Linking.getInitialURL().then((l) => handle(l, 'initial')).catch(() => {});
    const sub = Linking.addEventListener('url', (e) => handle(e.url, 'event')); return () => sub.remove();
  }, [joinMeeting]);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { if (!url) return false; if (canGoBack.current && web.current) { web.current.goBack(); return true; } setUrl(null); return true; });
    return () => sub.remove();
  }, [url]);

  if (configError) return <SafeAreaView style={s.root}><StatusBar style="light" /><Text style={s.title}>Qorlla is not configured</Text><Text style={s.body}>{configError}</Text></SafeAreaView>;

  if (url) {
    return (
      <SafeAreaView style={s.web}>
        <StatusBar style="light" />
        <WebView ref={web} testID="qorlla-webview" source={{ uri: url }} originWhitelist={['*']}
          onShouldStartLoadWithRequest={(r) => { const d = navigationDecision(policy, r.url); if (d === 'external') Linking.openURL(r.url).catch(() => {}); return d === 'allow'; }}
          onNavigationStateChange={(n) => { canGoBack.current = n.canGoBack; }}
          javaScriptEnabled domStorageEnabled mediaPlaybackRequiresUserAction={false} allowsInlineMediaPlayback mediaCapturePermissionGrantType="prompt"
          setSupportMultipleWindows={false} mixedContentMode="never" allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} allowsLinkPreview={false}
          thirdPartyCookiesEnabled={false} javaScriptCanOpenWindowsAutomatically={false} webviewDebuggingEnabled={TEST}
          onError={() => setError('Qorlla could not be reached. Check your connection and try again.')} onHttpError={() => {}} />
        {error ? <Text style={s.err} accessibilityRole="alert">{error}</Text> : null}
      </SafeAreaView>
    );
  }
  return (
    <SafeAreaView style={s.root}>
      <StatusBar style="light" />
      <View style={s.header}><Text style={s.brand}>Qorlla</Text><Text style={s.subtitle}>Meet · Connect · Work</Text></View>
      <Text style={s.title}>Join a meeting</Text>
      <TextInput testID="meeting-id" accessibilityLabel="Meeting ID" style={s.input} placeholder="11-digit meeting ID" placeholderTextColor="#7f93b3" keyboardType="number-pad" maxLength={11} value={meeting} onChangeText={(t) => setMeeting(t.replace(/\D/g, ''))} />
      <Pressable testID="join" accessibilityRole="button" accessibilityLabel="Join a meeting" onPress={() => joinMeeting(meeting)} style={s.button}><Text style={s.buttonText}>Join a meeting</Text></Pressable>
      {error ? <Text style={s.err} accessibilityRole="alert">{error}</Text> : null}
      {routes.map(([name, path]) => <Pressable accessibilityRole="button" accessibilityLabel={name} key={path} onPress={() => openUrl(policy.pathUrl(path))} style={[s.button, s.secondary]}><Text style={s.buttonText}>{name}</Text></Pressable>)}
      <Text style={s.note}>Meetings use Qorlla's own meeting service. Calls to phone numbers, push notifications and offline messaging are not part of this app yet.</Text>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({ root: { flex: 1, backgroundColor: '#0c1527', padding: 24, paddingTop: 24 + TOP }, web: { flex: 1, backgroundColor: '#0c1527', paddingTop: TOP }, header: { paddingTop: 44, paddingBottom: 32 }, brand: { fontSize: 38, color: '#fff', fontWeight: '800' }, subtitle: { color: '#93b2da', marginTop: 8 },
  title: { fontSize: 25, color: '#fff', fontWeight: '700', marginBottom: 12 }, body: { color: '#b7c8df', lineHeight: 23 }, input: { backgroundColor: '#14233f', color: '#fff', borderRadius: 12, padding: 16, fontSize: 18, marginBottom: 12 },
  button: { backgroundColor: '#2766dc', padding: 17, borderRadius: 12, marginBottom: 12 }, secondary: { backgroundColor: '#1b3566' }, buttonText: { color: '#fff', fontWeight: '700', textAlign: 'center' },
  err: { color: '#ff8a80', margin: 8 }, note: { color: '#91a5c4', fontSize: 12, marginTop: 24, lineHeight: 19 } });
