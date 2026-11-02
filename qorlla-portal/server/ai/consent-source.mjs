// Meet's consent answers, with a high-water mark. Meet's numbers only ever increase, so an answer whose revision is LOWER than the highest the portal has ever seen for that meeting is not a delayed
// answer, it is a different history (a restored backup, a stale replica, a replayed response, a reset sequence). Trusting it could hide a withdrawal, so it is refused like an outage: nothing is shown.
// An operator who has verified a deliberate Meet restore resets the mark for that meeting explicitly (DELETE FROM portal.meet_consent_watermark WHERE meet_meeting_id=...); the portal never does it by itself.
export function withWatermark(meet, pool) {
  async function fetchConsent(meetingUuid) {
    const c = await meet.fetchConsent(meetingUuid);
    const r = await pool.query(`INSERT INTO portal.meet_consent_watermark(meet_meeting_id,revision) VALUES($1,$2)
      ON CONFLICT (meet_meeting_id) DO UPDATE SET revision = GREATEST(portal.meet_consent_watermark.revision, EXCLUDED.revision), updated_at = CASE WHEN EXCLUDED.revision > portal.meet_consent_watermark.revision THEN now() ELSE portal.meet_consent_watermark.updated_at END
      RETURNING revision`, [meetingUuid, c.revision]);
    if (Number(r.rows[0].revision) > c.revision) { const e = new Error('Meet reported an older consent history than the portal has already seen'); e.code = 'consent_regressed'; e.retryable = false; throw e; }
    return c;
  }
  return { ...meet, fetchConsent };
}
