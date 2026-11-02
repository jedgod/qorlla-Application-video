// Withdrawing a published report because the consent it rested on was withdrawn. Irreversible on purpose: a report is never silently restored (a person who changes their mind again
// is a new decision about NEW processing). Takes the workspace lock first, like every other writer here, so it cannot deadlock with a host's revocation or a publishing worker.
// History is never rewritten: the audit trail only gets a new row.
import { withWorkspaceLock } from '../entitlements.mjs';

/** @returns {Promise<boolean>} true when this call withdrew the report (false when it was already withdrawn or gone) */
export async function withdrawReport(pool, { workspaceId, reportId, reason }) {
  return withWorkspaceLock(pool, workspaceId, async (c) => {
    const r = (await c.query(`UPDATE portal.meeting_reports SET status='withdrawn', summary='', decisions='[]'::jsonb, topics='[]'::jsonb, citations='{}'::jsonb, updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND status='final' RETURNING transcript_id, meet_meeting_id, job_id`, [reportId, workspaceId])).rows[0];
    if (!r) return false;
    if (r.transcript_id) await c.query(`UPDATE portal.meeting_transcripts SET segments='[]'::jsonb, full_text='', purged_at=now(), purge_reason='participant_consent' WHERE id=$1 AND purged_at IS NULL`, [r.transcript_id]);
    await c.query('DELETE FROM portal.meeting_action_items WHERE workspace_id=$1 AND report_id=$2', [workspaceId, reportId]);
    await c.query('UPDATE portal.report_shares SET revoked_at=now() WHERE workspace_id=$1 AND report_id=$2 AND revoked_at IS NULL', [workspaceId, reportId]);
    await c.query(`INSERT INTO portal.meeting_ai_consent_audit(workspace_id,meet_meeting_id,job_id,actor,event,detail) VALUES($1,$2,$3,'system:consent-fence','report_withdrawn',$4)`, [workspaceId, r.meet_meeting_id, r.job_id, JSON.stringify({ reason, report_id: reportId })]);
    return true;
  });
}
