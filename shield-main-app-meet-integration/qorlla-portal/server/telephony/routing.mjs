// Pure call-routing logic (no I/O) so every rule can be tested exhaustively. Times are evaluated in the PROFILE's time zone.
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local calendar parts of `date` in an IANA time zone. */
export function localParts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { weekday: WEEKDAYS[p.weekday], date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const toMin = (t) => { const [h, m] = String(t).split(':'); return Number(h) * 60 + Number(m); };

/** 'open' | 'closed' for a profile at `now`. A closure date always wins; no windows at all means "closed" (explicitly configured hours only). */
export function hoursState({ timezone, windows, closures }, now = new Date()) {
  const l = localParts(now, timezone || 'UTC');
  if ((closures || []).some((c) => String(c.on_date).slice(0, 10) === l.date)) return 'closed';
  const open = (windows || []).some((w) => w.weekday === l.weekday && toMin(w.opens) <= l.minutes && l.minutes < toMin(w.closes));
  return open ? 'open' : 'closed';
}

/** Does the profile offer a keypad menu right now? (rules with a digit that apply in this hours state) */
export function menuRoutes(routes, hours) {
  return [...routes].sort((a, b) => a.position - b.position).filter((r) => r.digit && (r.hours === 'any' || r.hours === hours));
}

/**
 * Decide what to do with a call.
 * @returns {{action:'forward'|'voicemail'|'message'|'escalate'|'hangup', route:object|null, destination?:string, message?:string, reason:string}}
 */
export function decide({ profile, routes, hours, digit = null, caller = '', minutesExhausted = false }) {
  const sorted = [...routes].sort((a, b) => a.position - b.position);
  const matches = sorted.filter((r) => (r.hours === 'any' || r.hours === hours) && (!r.digit || r.digit === digit) && (!r.caller_prefix || String(caller).startsWith(r.caller_prefix)) && (digit ? r.digit === digit : !r.digit));
  const route = matches[0] || null;
  const fallback = () => (profile.voicemail_enabled ? { action: 'voicemail', route: null, reason: 'default_voicemail' } : { action: 'message', route: null, message: hours === 'open' ? 'Sorry, nobody is available to take your call.' : profile.closed_greeting_text, reason: 'default_message' });
  if (!route) return fallback();
  if (route.action === 'forward') {
    if (minutesExhausted) return { ...fallback(), reason: 'plan_minutes_exhausted' };     // never run up usage beyond the plan
    return { action: 'forward', route, destination: route.destination, reason: 'rule:' + route.name };
  }
  if (route.action === 'escalate') {
    if (minutesExhausted || !(profile.escalation_numbers || []).length) return { ...fallback(), reason: minutesExhausted ? 'plan_minutes_exhausted' : 'no_escalation_numbers' };
    return { action: 'escalate', route, reason: 'rule:' + route.name };
  }
  if (route.action === 'message') return { action: 'message', route, message: route.message || profile.closed_greeting_text, reason: 'rule:' + route.name };
  if (route.action === 'voicemail') return profile.voicemail_enabled ? { action: 'voicemail', route, reason: 'rule:' + route.name } : { action: 'message', route, message: 'Voicemail is not available.', reason: 'voicemail_disabled' };
  return { action: 'hangup', route, reason: 'rule:' + route.name };
}

/** Open slots (ISO strings) on a local date for a profile, excluding existing bookings. Slots start on `step` minute boundaries inside open windows. */
export function openSlots({ timezone, windows, closures, date, durationMin = 30, step = 30, booked = [] }) {
  const tz = timezone || 'UTC';
  if ((closures || []).some((c) => String(c.on_date).slice(0, 10) === date)) return [];
  // weekday of that calendar date (noon UTC is safe from DST edges)
  const weekday = localParts(new Date(`${date}T12:00:00Z`), 'UTC').weekday;
  const slots = [];
  for (const w of (windows || []).filter((x) => x.weekday === weekday).sort((a, b) => toMin(a.opens) - toMin(b.opens))) {
    for (let m = toMin(w.opens); m + durationMin <= toMin(w.closes); m += step) {
      const startUtc = zonedToUtc(date, m, tz); const endUtc = new Date(startUtc.getTime() + durationMin * 60000);
      if (booked.some((b) => new Date(b.starts_at) < endUtc && new Date(b.ends_at) > startUtc)) continue;
      slots.push(startUtc.toISOString());
    }
  }
  return slots;
}
/** Convert a local wall-clock time (date + minutes since midnight) in `timeZone` to a UTC Date (handles DST by probing the offset). */
export function zonedToUtc(date, minutes, timeZone) {
  const [y, mo, d] = date.split('-').map(Number); const guess = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  const offsetAt = (t) => { const l = localParts(new Date(t), timeZone); const [ly, lm, ld] = l.date.split('-').map(Number); return Date.UTC(ly, lm - 1, ld, 0, 0) + l.minutes * 60000 - t; };
  let t = guess - offsetAt(guess); t = guess - offsetAt(t); return new Date(t);
}
