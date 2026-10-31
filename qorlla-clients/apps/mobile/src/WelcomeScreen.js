import React, { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, PixelRatio, Platform, Pressable, ScrollView, StatusBar as RNStatusBar, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { BookIcon, ChevronDown, ChevronRight, GearIcon, GlobeIcon, HashIcon, HeadsetIcon, HeroArt, InfoIcon, LinkIcon, MessageIcon, QorllaMark, ShieldIcon, UserIcon, UsersIcon, VideoIcon } from './icons';
import { FEATURES, FOOTER, LANGUAGES, ROUTES, columns, groupMeetingId, layoutScale, parseMeetingId } from './welcome';
import { digitsHint, tooLongHint, translate } from './i18n';

// Design tokens from the Welcome / Join specification.
export const C = { bg: '#030B16', hero: '#071D38', card: '#071D34', elevated: '#102642', blue: '#087BFA', cyan: '#00D7E8', purple: '#9258F5', green: '#00D9AD', orange: '#FFAB19', blue2: '#1A8EFF', text: '#F6F9FF', text2: '#A7C2E5', muted: '#A7C2E5', border: '#173C61', error: '#FF8A80' };
const TOP = Platform.OS === 'android' ? (RNStatusBar.currentHeight || 24) : 0;
const MAXFONT = 1.3, DENSE = 1.08; // body copy may grow to 130% of the system text size; the small text inside cards to 108% (beyond that the cards stack into one column instead)
// Body copy wraps and grows with the system font size (capped). One-line labels shrink to fit their space instead of clipping.
const T = (props) => <Text maxFontSizeMultiplier={MAXFONT} {...props} />;
// A one-word title is kept on one line and shrunk to fit (Android would otherwise break it in the middle of the word); a longer title wraps at its spaces, at most twice.
const titleLines = (text) => (/\s/.test(String(text).trim()) ? 2 : 1);
const D = (props) => <Text maxFontSizeMultiplier={DENSE} {...props} />;
const Fit = ({ lines = 1, ...props }) => <Text maxFontSizeMultiplier={MAXFONT} numberOfLines={lines} adjustsFontSizeToFit minimumFontScale={0.7} textBreakStrategy="simple" {...props} />;

/**
 * The first screen. It only collects intent: joining, signing in, guest, help and so on are handed to the callbacks, which use the existing flows (the Meet join/admission page, the web sign-in and guest routes).
 * Nothing here talks to a server and nothing switches a feature on: the feature cards only open informational pages or move to the meeting field.
 * Every size is the 390dp design size times a scale derived from the real window width (0.8-1.12), so the screen fits any phone without horizontal scrolling.
 */
export default function WelcomeScreen({ onJoin, joining, error, onOpen, onSettings, language, onLanguage, meetingRaw, onMeetingRaw }) {
  const { width } = useWindowDimensions(), fontScale = PixelRatio.getFontScale(), k = layoutScale(width), cols = columns({ width, fontScale });
  const inner = width - 2 * Math.round(20 * k), heroW = Math.round(inner * 0.56), artW = Math.round(inner * 0.5), s = useMemo(() => makeStyles(k, heroW, artW), [k, heroW, artW]), t = (x) => translate(language, x), gap = Math.round(10 * k);
  const [picker, setPicker] = useState(false), [focused, setFocused] = useState(false);
  const raw = meetingRaw, scroll = useRef(null), input = useRef(null), cardY = useRef(0);
  const id = parseMeetingId(raw), canJoin = id.state === 'valid' && !joining, shown = id.state === 'valid' || id.state === 'incomplete' ? groupMeetingId(id.digits) : raw;
  const lang = LANGUAGES.find((l) => l.code === language) || LANGUAGES[0];
  const submit = () => { if (canJoin) onJoin(id.digits); };
  const scrollToCard = () => scroll.current && scroll.current.scrollTo({ y: Math.max(0, cardY.current - 12), animated: true });
  const feature = (f) => { if (f.gate === 'focus') { scrollToCard(); input.current && input.current.focus(); } else onOpen(f.path); };
  const hint = id.state === 'letters' ? { text: t(id.message), bad: true } : id.state === 'too-long' ? { text: tooLongHint(language, id.digits.length), bad: true } : error ? { text: error, bad: true } : id.state === 'incomplete' || id.state === 'valid' ? { text: digitsHint(language, id.digits.length), bad: false } : null;
  const featureIcon = { video: <VideoIcon size={30 * k} color={C.blue2} solid />, team: <UsersIcon size={32 * k} color={C.purple} solid />, comm: <MessageIcon size={30 * k} color={C.green} />, secure: <ShieldIcon size={30 * k} color={C.orange} /> };
  const tint = { video: '#0F3B66', team: '#2B1F5C', comm: '#0B3A36', secure: '#40300F' };
  const featW = cols.features === 2 ? (inner - gap) / 2 : inner;
  const util = [
    { key: 'help', title: 'Help & Support', sub: 'Get help, tutorials and FAQs', icon: <HeadsetIcon size={34 * k} color={C.blue2} />, run: () => onOpen(ROUTES.help) },
    { key: 'learn', title: 'Explore Qorlla', sub: 'Learn more about features and use cases', icon: <BookIcon size={34 * k} color={C.purple} />, run: () => onOpen(ROUTES.learn) },
    { key: 'settings', title: 'Settings', sub: 'Audio, video and app preferences', icon: <GearIcon size={34 * k} color="#9BB9DC" />, run: onSettings },
  ];
  const wide = cols.utility === 1, utilW = wide ? inner : (inner - 2 * gap) / 3, acctW = cols.accounts === 2 ? (inner - gap) / 2 : inner;

  return (
    <View style={s.root} testID="welcome-screen">
      <ScrollView ref={scroll} contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}>
        {/* HERO */}
        <View style={s.heroTop}>
          <Pressable testID="language-select" accessibilityRole="button" accessibilityLabel={t('Language') + ': ' + lang.label + '. ' + t('Language')} onPress={() => setPicker(true)} style={({ pressed }) => [s.lang, pressed && s.pressed]}>
            <GlobeIcon size={20 * k} color={C.text2} /><Fit style={s.langText}>{lang.label}</Fit><ChevronDown size={18 * k} color={C.text2} />
          </Pressable>
        </View>
        <View style={s.hero}>
          <View style={s.heroText}>
            <View style={s.brandRow} accessible accessibilityRole="header" accessibilityLabel="Qorlla"><QorllaMark size={Math.round(heroW * 0.3)} /><T style={s.brand} allowFontScaling={false}>orlla</T></View>
            <Fit style={s.tagline}>{t('Meet · Connect · Collaborate')}</Fit>
            <T style={s.intro}>{t('A secure workspace for video meetings, team collaboration and communication anywhere in the world.')}</T>
          </View>
          <View style={s.art} pointerEvents="none"><HeroArt width={artW} /></View>
        </View>

        {/* FEATURE CARDS */}
        <View style={s.grid}>
          {FEATURES.map((f) => (
            <Pressable key={f.key} testID={'feature-' + f.key} accessibilityRole="button" accessibilityLabel={t(f.title) + '. ' + t(f.desc)} onPress={() => feature(f)} style={({ pressed }) => [s.feature, { width: featW }, pressed && s.pressed]}>
              <View style={[s.featureIcon, { backgroundColor: tint[f.key] }]}>{featureIcon[f.key]}</View>
              <View style={s.featureText}><Fit lines={titleLines(t(f.title))} style={s.featureTitle}>{t(f.title)}</Fit><D style={s.featureDesc}>{t(f.desc)}</D></View>
              <ChevronRight size={16 * k} color={C.text2} />
            </Pressable>
          ))}
        </View>

        {/* MEETING ENTRY */}
        <View style={s.card} onLayout={(e) => { cardY.current = e.nativeEvent.layout.y; }}>
          <View style={s.cardHead}>
            <View style={s.linkBadge}><LinkIcon size={34 * k} color={C.text2} /></View>
            <View style={s.cardHeadText}><Fit style={s.cardTitle} accessibilityRole="header">{t('Join a Meeting')}</Fit><T style={s.cardSub}>{t('Enter the 11-digit meeting ID to join a session.')}</T></View>
          </View>
          <View style={[s.field, focused && s.fieldFocus, hint && hint.bad && s.fieldBad]}>
            <HashIcon size={28 * k} color={C.text2} />
            <TextInput ref={input} testID="meeting-id" accessibilityLabel={t('11-digit meeting ID')} style={s.fieldInput} placeholder={t('11-digit meeting ID')} placeholderTextColor={C.muted} keyboardType="number-pad" inputMode="numeric" autoComplete="off" autoCorrect={false} importantForAutofill="no" maxFontSizeMultiplier={MAXFONT}
              value={shown} onChangeText={onMeetingRaw} onFocus={() => { setFocused(true); setTimeout(scrollToCard, 150); }} onBlur={() => setFocused(false)} onSubmitEditing={submit} returnKeyType="go" editable={!joining} />
          </View>
          {hint ? <T testID="meeting-hint" style={[s.hint, hint.bad && s.hintBad]} accessibilityRole={hint.bad ? 'alert' : undefined} accessibilityLiveRegion="polite">{hint.text}</T> : null}
          <Pressable testID="join" accessibilityRole="button" accessibilityLabel={t('Join Meeting')} accessibilityState={{ disabled: !canJoin, busy: !!joining }} disabled={!canJoin} onPress={submit} style={({ pressed }) => [s.join, !canJoin && s.joinOff, pressed && s.pressed]}>
            {joining ? <ActivityIndicator color="#fff" /> : <VideoIcon size={30 * k} color="#fff" solid />}
            <Fit style={s.joinText}>{joining ? t('Joining…') : t('Join Meeting')}</Fit>
            <ChevronRight size={24 * k} color="#fff" />
          </Pressable>
        </View>

        {/* OR + ACCOUNT ACTIONS */}
        <View style={s.or}><View style={s.orLine} /><T style={s.orText}>{t('OR')}</T><View style={s.orLine} /></View>
        <View style={s.row}>
          <ActionRow s={s} width={acctW} testID="sign-in" label={t('Sign In')} sub={t('Use your Qorlla account')} color={C.blue2} icon={<UserIcon size={34 * k} color={C.blue2} />} onPress={() => onOpen(ROUTES.signIn)} />
          <ActionRow s={s} width={acctW} testID="guest" label={t('Continue as Guest')} sub={t('Join without an account')} color={C.cyan} icon={<UsersIcon size={36 * k} color={C.cyan} solid />} onPress={() => onOpen(ROUTES.guest)} />
        </View>

        {/* UTILITY CARDS */}
        <View style={s.row}>
          {util.map((u) => (
            <Pressable key={u.key} testID={'util-' + u.key} accessibilityRole="button" accessibilityLabel={t(u.title) + '. ' + t(u.sub)} onPress={u.run} style={({ pressed }) => [s.util, wide && s.utilWide, { width: utilW }, pressed && s.pressed]}>
              <View style={wide ? s.utilIconWide : s.utilIcon}>{u.icon}</View>
              <View style={s.utilText}><Fit lines={titleLines(t(u.title))} style={s.utilTitle}>{t(u.title)}</Fit><D style={s.utilSub}>{t(u.sub)}</D></View>
              <View style={wide ? null : s.utilChev}><ChevronRight size={20 * k} color={C.text2} /></View>
            </Pressable>
          ))}
        </View>

        {/* AVAILABILITY NOTICE */}
        <View style={s.footer} accessible accessibilityLabel={t(FOOTER)}><InfoIcon size={24 * k} color={C.text2} /><T style={s.footerText}>{t(FOOTER)}</T></View>
      </ScrollView>

      <Modal visible={picker} transparent animationType="fade" onRequestClose={() => setPicker(false)}>
        <Pressable style={s.scrim} onPress={() => setPicker(false)} accessibilityLabel="Close language list">
          <View style={s.sheet} accessibilityViewIsModal>
            <T style={s.sheetTitle} accessibilityRole="header">{t('Language')}</T>
            {LANGUAGES.map((l) => (
              <Pressable key={l.code} testID={'lang-' + l.code} accessibilityRole="radio" accessibilityState={{ selected: l.code === lang.code }} onPress={() => { setPicker(false); onLanguage(l.code); }} style={({ pressed }) => [s.langItem, pressed && s.pressed]}>
                <T style={[s.langItemText, l.code === lang.code && { color: C.cyan }]}>{l.label}</T>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

function ActionRow({ s, width, testID, label, sub, color, icon, onPress }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label + '. ' + sub} onPress={onPress} style={({ pressed }) => [s.action, { width, borderColor: color }, pressed && s.pressed]}>
      <View style={s.actionIcon}>{icon}</View>
      <View style={s.actionText}><D style={s.actionLabel}>{label}</D><D style={s.actionSub}>{sub}</D></View>
      <ChevronRight size={22} color={color} />
    </Pressable>
  );
}

// All sizes are written at the 390dp design width and multiplied by k; touch targets never fall below 48dp.
function makeStyles(k, heroW, artW) {
  const d = (n) => Math.round(n * k * 10) / 10, f = (n) => Math.round(n * k * 10) / 10, tap = (n) => Math.max(48, d(n));
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg, paddingTop: TOP },
    scroll: { paddingHorizontal: Math.round(20 * k), paddingBottom: 56 },
    pressed: { opacity: 0.78 },
    heroTop: { flexDirection: 'row', justifyContent: 'flex-end' },
    hero: { flexDirection: 'row', alignItems: 'flex-start', paddingBottom: d(14), minHeight: d(200) },
    heroText: { width: heroW },
    art: { position: 'absolute', right: -d(6), top: -d(8), width: artW },
    lang: { flexDirection: 'row', alignItems: 'center', gap: d(8), minHeight: 48, maxWidth: '58%', paddingHorizontal: d(14), borderRadius: 24, borderWidth: 1, borderColor: C.border, backgroundColor: 'rgba(7,29,52,0.9)' },
    langText: { color: C.text, fontSize: f(16), fontWeight: '600', flexShrink: 1 },
    brandRow: { flexDirection: 'row', alignItems: 'center' },
    brand: { color: C.text, fontWeight: '800', fontSize: f(Math.round(heroW / k * 0.26)), letterSpacing: -1.5, marginLeft: -d(4) },
    tagline: { color: C.text2, fontSize: f(17), fontWeight: '600', marginTop: d(2) },
    intro: { color: C.text, fontSize: f(14.5), lineHeight: f(21), marginTop: d(12) },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: d(10), marginBottom: d(14) },
    feature: { flexDirection: 'row', alignItems: 'center', minHeight: tap(104), borderRadius: d(22), borderWidth: 1, borderColor: C.border, backgroundColor: C.card, paddingVertical: d(12), paddingLeft: d(10), paddingRight: d(8) },
    featureIcon: { width: d(40), height: d(40), borderRadius: d(13), alignItems: 'center', justifyContent: 'center', marginRight: d(8) },
    featureText: { flex: 1, minWidth: 0 }, featureTitle: { color: C.text, fontSize: f(13.5), fontWeight: '800' }, featureDesc: { color: C.text2, fontSize: f(11), lineHeight: f(15), marginTop: d(3) },
    card: { backgroundColor: C.card, borderRadius: d(24), borderWidth: 1, borderColor: C.border, padding: d(16), marginBottom: d(8) },
    cardHead: { flexDirection: 'row', alignItems: 'center', marginBottom: d(14) },
    linkBadge: { width: d(66), height: d(66), borderRadius: d(20), backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center', marginRight: d(14) },
    cardHeadText: { flex: 1, minWidth: 0 }, cardTitle: { color: C.text, fontSize: f(27), fontWeight: '800' }, cardSub: { color: C.text2, fontSize: f(15), lineHeight: f(21), marginTop: d(2) },
    field: { flexDirection: 'row', alignItems: 'center', minHeight: tap(58), borderRadius: d(20), backgroundColor: C.elevated, borderWidth: 1.5, borderColor: C.border, paddingHorizontal: d(16) },
    fieldFocus: { borderColor: C.blue2 }, fieldBad: { borderColor: C.error },
    fieldInput: { flex: 1, color: C.text, fontSize: f(19), marginLeft: d(14), paddingVertical: 12, letterSpacing: 0.5 },
    hint: { color: C.text2, fontSize: f(14), marginTop: d(8), marginLeft: 4 }, hintBad: { color: C.error },
    join: { flexDirection: 'row', alignItems: 'center', minHeight: tap(60), borderRadius: d(22), backgroundColor: C.blue, paddingHorizontal: d(22), marginTop: d(14), gap: d(12) },
    joinOff: { backgroundColor: '#0B4F9C', opacity: 0.6 },
    joinText: { color: '#fff', fontSize: f(23), fontWeight: '800', flex: 1, textAlign: 'center' },
    or: { flexDirection: 'row', alignItems: 'center', gap: d(14), marginVertical: d(10), paddingHorizontal: d(24) },
    orLine: { flex: 1, height: 1, backgroundColor: C.border }, orText: { color: C.text2, fontSize: f(17) },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: d(10), marginBottom: d(12) },
    action: { flexDirection: 'row', alignItems: 'center', minHeight: tap(74), borderRadius: d(28), borderWidth: 2, backgroundColor: C.card, paddingHorizontal: d(12) },
    actionIcon: { width: d(42), alignItems: 'center', marginRight: d(6) }, actionText: { flex: 1, minWidth: 0 },
    actionLabel: { color: C.text, fontSize: f(15), fontWeight: '800' }, actionSub: { color: C.text2, fontSize: f(12), marginTop: 2 },
    util: { minHeight: tap(120), borderRadius: d(20), borderWidth: 1, borderColor: C.border, backgroundColor: C.card, padding: d(10), justifyContent: 'space-between' },
    utilWide: { flexDirection: 'row', alignItems: 'center', minHeight: tap(76), paddingHorizontal: d(14) },
    utilChev: { position: 'absolute', right: d(8), top: d(16) },
    utilIcon: { height: d(40), justifyContent: 'center' }, utilIconWide: { width: d(44), alignItems: 'center', marginRight: d(12) }, utilText: { flexShrink: 1, flexGrow: 1, minWidth: 0 },
    utilTitle: { color: C.text, fontSize: f(14.5), fontWeight: '800' }, utilSub: { color: C.muted, fontSize: f(11.5), lineHeight: f(16), marginTop: d(4) },
    footer: { flexDirection: 'row', alignItems: 'center', gap: d(14), marginTop: d(4), padding: d(14), borderRadius: d(22), borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
    footerText: { flex: 1, color: C.text2, fontSize: f(13.5), lineHeight: f(20) },
    scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
    sheet: { backgroundColor: C.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderColor: C.border, borderWidth: 1, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 36 },
    sheetTitle: { color: C.text, fontSize: 20, fontWeight: '800', marginBottom: 8 }, langItem: { minHeight: 52, justifyContent: 'center', borderBottomWidth: 1, borderBottomColor: C.border }, langItemText: { color: C.text, fontSize: 18 },
  });
}
