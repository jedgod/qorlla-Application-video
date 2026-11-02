// Free-plan meeting time limit, enforced by Meet for meetings that the scheduling backend registered with limits (meetings.time_limit_ms / grace_ms).
// Counted from the moment the first person connected: at the limit everyone gets an "Upgrade" reminder, more reminders follow through the grace period,
// then the meeting is closed with "Upgrade to have full access to Qorlla packages". Meetings without limits (paid hosts) are never touched.
export const UPGRADE_MESSAGE = 'Upgrade to have full access to Qorlla packages';

/** Offsets (ms from the start): at the limit, half way through the grace period, in its last tenth, and the end. */
export function plan(limitMs, graceMs) {
  const unit = graceMs / 10, end = limitMs + graceMs, marks = [{ at: limitMs, phase: 'limit' }];
  if (graceMs >= 4 * unit) marks.push({ at: limitMs + Math.round(graceMs / 2), phase: 'reminder' });
  marks.push({ at: end - Math.round(unit), phase: 'final' }, { at: end, phase: 'close' });
  return marks.filter((m, i, a) => i === 0 || m.at > a[i - 1].at);
}
const text = (remainingMs, unit) => { const mins = Math.max(1, Math.ceil(remainingMs / unit)); return 'You are on the free plan. This meeting closes in about ' + mins + ' minute' + (mins === 1 ? '' : 's') + '. Upgrade to have full access to Qorlla packages without interruptions.'; };

export function makeLimit({ io, db, room, audit, onEnd, upgradeUrl }) {
  const timers = new Map();                                         // meetingId -> [timeouts] (null while arming)
  async function close(id) {
    timers.delete(id);
    const { rowCount } = await db.query("UPDATE meetings SET ended_at=now(), end_reason='time_limit' WHERE id=$1 AND ended_at IS NULL", [id]); if (!rowCount) return;
    io.to(room(id)).emit('meeting-limit', { message: UPGRADE_MESSAGE, upgradeUrl });
    try { await onEnd(id); } catch (e) { console.error('[limit] end hook failed:', e.message); }
    db.query('UPDATE participant_sessions SET disconnected_at=now() WHERE meeting_id=$1 AND disconnected_at IS NULL', [id]).catch(() => {});
    audit(id, null, 'meeting.time_limit', {});
    setTimeout(() => io.in(room(id)).disconnectSockets(true), 1500).unref();
  }
  /** Called whenever someone connects; arms once per meeting (also after a restart, from the recorded start). */
  async function arm(id) {
    if (timers.has(id)) return; timers.set(id, null);
    try {
      const { rows: [m] } = await db.query('SELECT time_limit_ms, grace_ms, ended_at FROM meetings WHERE id=$1', [id]);
      if (!m || m.ended_at || !Number(m.time_limit_ms)) { timers.delete(id); return; }
      const limitMs = Number(m.time_limit_ms), graceMs = Math.max(Number(m.grace_ms) || 0, 1000), unit = graceMs / 10;
      const { rows: [s] } = await db.query('SELECT min(connected_at) AS t FROM participant_sessions WHERE meeting_id=$1', [id]);
      const startedAt = s && s.t ? new Date(s.t).getTime() : Date.now(), endsAt = startedAt + limitMs + graceMs, now = Date.now(), marks = plan(limitMs, graceMs), list = [];
      const run = (mk) => () => { const remainingMs = Math.max(0, endsAt - Date.now()); if (mk.phase === 'close') close(id).catch((e) => console.error('[limit]', e.message)); else io.to(room(id)).emit('limit-reminder', { phase: mk.phase, remainingMs, endsAt, message: text(remainingMs, unit), upgradeUrl }); };
      for (const mk of marks) { const d = startedAt + mk.at - now; if (d > 0) list.push(setTimeout(run(mk), d)); }
      const due = marks.filter((mk) => startedAt + mk.at <= now); if (due.length) list.push(setTimeout(run(due[due.length - 1]), 0));
      timers.set(id, list); list.forEach((t) => t.unref && t.unref());
    } catch (e) { timers.delete(id); console.error('[limit] arm failed:', e.message); }
  }
  return { arm, clear: (id) => { (timers.get(id) || []).forEach(clearTimeout); timers.delete(id); } };
}
