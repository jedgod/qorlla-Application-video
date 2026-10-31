import React from 'react';
import Svg, { Path, Circle, Ellipse, Line, Rect, Defs, LinearGradient, Stop, RadialGradient } from 'react-native-svg';

// Bundled vector icons (24x24 line icons), so the Welcome screen has no remote or font dependency. Decorative: the label next to each icon carries the meaning.
const base = (size, color, w = 1.9) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: w, strokeLinecap: 'round', strokeLinejoin: 'round' });
const hide = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' };

export const VideoIcon = ({ size = 24, color = '#fff', solid }) => <Svg {...base(size, color)} {...hide}><Rect x="1.5" y="5" width="14" height="14" rx="3" fill={solid ? color : 'none'} /><Path d="M22.5 7.5l-6 4.5 6 4.5v-9z" fill={solid ? color : 'none'} /></Svg>;
export const PhoneIcon = ({ size = 24, color = '#fff' }) => <Svg {...base(size, color)} {...hide}><Path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" /></Svg>;
export const UsersIcon = ({ size = 24, color = '#fff', solid }) => <Svg {...base(size, color)} {...hide}><Path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><Circle cx="9" cy="7" r="4" fill={solid ? color : 'none'} /><Path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></Svg>;
export const ShieldIcon = ({ size = 24, color = '#fff' }) => <Svg {...base(size, color)} {...hide}><Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><Path d="M9 12l2 2 4-4" /></Svg>;
export const LinkIcon = ({ size = 24, color = '#fff' }) => <Svg {...base(size, color)} {...hide}><Path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></Svg>;
export const HashIcon = ({ size = 24, color = '#fff' }) => <Svg {...base(size, color, 2.1)} {...hide}><Path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18" /></Svg>;
export const UserIcon = ({ size = 24, color = '#fff' }) => <Svg {...base(size, color)} {...hide}><Path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><Circle cx="12" cy="7" r="4" fill={color} /></Svg>;
export const HelpIcon = ({ size = 24, color = '#fff' }) => <Svg {...base(size, color)} {...hide}><Circle cx="12" cy="12" r="10" fill={color} /><Path d="M9.2 9.2a3 3 0 0 1 5.8 1c0 2-3 2.8-3 2.8" stroke="#0B1C31" /><Line x1="12" y1="17" x2="12.01" y2="17" stroke="#0B1C31" /></Svg>;
export const BookIcon = ({ size = 24, color = '#fff' }) => <Svg {...base(size, color)} {...hide}><Path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" fill={color} fillOpacity={0.9} /></Svg>;
export const GearIcon = ({ size = 24, color = '#fff' }) => <Svg {...base(size, color, 2.2)} {...hide}><Circle cx="12" cy="12" r="3.2" /><Circle cx="12" cy="12" r="7.2" /><Path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></Svg>;
export const MessageIcon = ({ size = 24, color = '#fff' }) => <Svg {...base(size, color)} {...hide}><Path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.5L3 20.5l1.6-4.9A8.5 8.5 0 1 1 21 11.5z" fill={color} fillOpacity={0.9} /></Svg>;
export const HeadsetIcon = ({ size = 24, color = '#fff' }) => <Svg {...base(size, color, 2)} {...hide}><Path d="M4 14v-2a8 8 0 0 1 16 0v2" /><Rect x="2.5" y="13" width="4.5" height="7" rx="2" fill={color} /><Rect x="17" y="13" width="4.5" height="7" rx="2" fill={color} /><Path d="M19.5 20c0 1.5-2 2-5 2" /></Svg>;
export const ChevronRight = ({ size = 22, color = '#fff' }) => <Svg {...base(size, color, 2.2)} {...hide}><Path d="M9 18l6-6-6-6" /></Svg>;
export const ChevronDown = ({ size = 20, color = '#fff' }) => <Svg {...base(size, color, 2.2)} {...hide}><Path d="M6 9l6 6 6-6" /></Svg>;
export const InfoIcon = ({ size = 22, color = '#fff' }) => <Svg {...base(size, color)} {...hide}><Circle cx="12" cy="12" r="10" /><Path d="M12 16v-5M12 8h.01" /></Svg>;
export const GlobeIcon = ({ size = 22, color = '#fff' }) => <Svg {...base(size, color, 1.7)} {...hide}><Circle cx="12" cy="12" r="10" /><Ellipse cx="12" cy="12" rx="4.2" ry="10" /><Path d="M2 12h20M4 7h16M4 17h16" /></Svg>;

/** The Qorlla mark: a ring that runs from cyan to blue with the Q's tail. A vector redraw of the reference; replace it with the approved logo asset when one exists in the app bundle. */
export const QorllaMark = ({ size = 64 }) => (
  <Svg width={size} height={size} viewBox="0 0 64 64" {...hide}>
    <Defs><LinearGradient id="qg" x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor="#00E0F0" /><Stop offset="1" stopColor="#1A6BFF" /></LinearGradient></Defs>
    <Circle cx="31" cy="30" r="22" stroke="url(#qg)" strokeWidth="13" fill="none" />
    <Path d="M36 38 L52 56 L41 58 L28 44 Z" fill="url(#qg)" />
  </Svg>
);

/** Decorative globe for the hero: dotted continents on a dark sphere with a soft glow and a few light arcs. Never receives touches. */
export function Globe({ size = 220 }) {
  const dots = [];
  for (let i = 0; i < 260; i += 1) {
    const a = i * 2.399963, r = Math.sqrt((i + 0.5) / 260) * 96, x = 100 + r * Math.cos(a), y = 100 + r * Math.sin(a);
    if (((Math.sin(x * 0.19) + Math.cos(y * 0.23) + Math.sin((x + y) * 0.11)) > 0.35)) dots.push(<Circle key={i} cx={x} cy={y} r={1.5} fill="#38C8F0" fillOpacity={0.75} />);
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 200 200" pointerEvents="none" {...hide}>
      <Defs><RadialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><Stop offset="0.6" stopColor="#0B5FA8" stopOpacity="0.55" /><Stop offset="1" stopColor="#030B16" stopOpacity="0" /></RadialGradient></Defs>
      <Circle cx="100" cy="100" r="100" fill="url(#glow)" />
      <Circle cx="100" cy="100" r="96" fill="#061A33" fillOpacity={0.6} stroke="#1B5E96" strokeWidth="1" />
      {dots}
      <Path d="M20 120 Q100 40 190 80" stroke="#38C8F0" strokeWidth="1" fill="none" strokeOpacity={0.7} />
      <Circle cx="150" cy="62" r="3.5" fill="#7FE7FF" /><Circle cx="62" cy="100" r="2.5" fill="#7FE7FF" />
    </Svg>
  );
}

/** Hero artwork: the globe with two video tiles (stylised people, drawn in vector) and three round badges, as in the design. Decorative; never receives touches and is hidden from TalkBack. */
export function HeroArt({ width = 200 }) {
  const h = width * 0.9, person = (x, y, w, hh, skin, shirt, id) => (
    <React.Fragment key={id}>
      <Rect x={x} y={y} width={w} height={hh} rx="7" fill="#16314F" stroke="#2FA8FF" strokeWidth="1.2" />
      <Circle cx={x + w / 2} cy={y + hh * 0.36} r={w * 0.2} fill={skin} />
      <Path d={`M${x + w * 0.12} ${y + hh} Q${x + w * 0.5} ${y + hh * 0.52} ${x + w * 0.88} ${y + hh}Z`} fill={shirt} />
    </React.Fragment>);
  return (
    <Svg width={width} height={h} viewBox="0 0 200 180" pointerEvents="none" {...hide}>
      <Defs><RadialGradient id="hg" cx="0.5" cy="0.5" r="0.5"><Stop offset="0.55" stopColor="#0B5FA8" stopOpacity="0.6" /><Stop offset="1" stopColor="#030B16" stopOpacity="0" /></RadialGradient></Defs>
      <Circle cx="105" cy="90" r="86" fill="url(#hg)" />
      <Circle cx="105" cy="90" r="74" fill="#061A33" fillOpacity={0.7} stroke="#2FA8FF" strokeWidth="1.5" />
      {Array.from({ length: 150 }, (_, i) => { const a = i * 2.399963, r = Math.sqrt((i + 0.5) / 150) * 70, x = 105 + r * Math.cos(a), y = 90 + r * Math.sin(a); return (Math.sin(x * 0.2) + Math.cos(y * 0.25)) > 0.3 ? <Circle key={i} cx={x} cy={y} r={1.3} fill="#38C8F0" fillOpacity={0.7} /> : null; })}
      {person(52, 56, 50, 56, '#8A5A3C', '#2B4468', 'a')}
      {person(106, 52, 52, 60, '#C68A62', '#9DB8D8', 'b')}
      <Circle cx="168" cy="40" r="15" fill="#0A66D8" stroke="#2FA8FF" strokeWidth="1.5" /><Circle cx="168" cy="40" r="4" fill="#fff" /><Path d="M158 52q10-9 20 0" stroke="#fff" strokeWidth="2.4" fill="none" />
      <Circle cx="92" cy="130" r="14" fill="#0C2A4A" stroke="#2FA8FF" strokeWidth="1.5" /><Rect x="84" y="124" width="16" height="11" rx="3" fill="none" stroke="#7FE7FF" strokeWidth="1.8" />
      <Circle cx="40" cy="146" r="15" fill="#0A66D8" stroke="#2FA8FF" strokeWidth="1.5" /><Rect x="31" y="140" width="12" height="11" rx="2.5" fill="#fff" /><Path d="M43 143l7-3v12l-7-3z" fill="#fff" />
      <Circle cx="150" cy="142" r="15" fill="#16314F" stroke="#2FA8FF" strokeWidth="1.5" /><Circle cx="150" cy="138" r="5" fill="#C9D8EE" /><Path d="M141 154q9-9 18 0z" fill="#C9D8EE" />
    </Svg>
  );
}
