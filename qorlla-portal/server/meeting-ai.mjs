// Workplace v4.2 - AI Meeting Intelligence API. All authorisation is decided HERE, from database state, never from the browser.
//   meeting  -> must exist in Meet's directory (a MAIN-scheduled meeting) and be owned by a member of the caller's workspace
//   consent  -> only the host can attest; nothing is fetched, stored or sent to a model without active transcription+summary consent
//   report   -> manage: creator, host, workspace owner/admin | view: manage + 'workspace' visibility + member shares | assignee: their own items
//   transcript -> manage only (or a link share the manager created with include_transcript)
import crypto from 'node:crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { PlanLimitError, quotaFor, withWorkspaceLock } from './entitlements.mjs';
import { parseTranscript } from './ai/parse.mjs';
import { exportModel, toPdf, toDocx } from './ai/export.mjs';
import { UUID_RE } from './auth.mjs';

export const NOTICE = {
  version: 'v1',
  text: 'I confirm that everyone taking part in this meeting has been told that its chat or transcript will be processed by Qorlla AI to produce a summary, decisions and action items, and - where the law or our policy requires it - has agreed. I understand that revoking this consent deletes the transcript and withdraws every report derived from it.'
};
const uuid = z.string().regex(UUID_RE);
const isManager = (role) => role === 'owner' || role === 'admin';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const CONSENT_SCOPES = ['transcription', 'summary'];
const httpErr = (status, error, code, extra = {}) => Object.assign(new Error(error), { http: { status, body: { error, code, ...extra } } });

export function registerMeetingAi(app, { pool, cfg, auth, h, directory, log, llm, meet, overage = null, flags = null }) {
  const { member } = auth;
  const audit = (db, ws, actor, action, obj) => db.query('INSERT INTO portal.audit_events(workspace_id,actor_id,action,object_id) VALUES($1,$2,$3,$4)', [ws, actor, action, String(obj ?? '')]);

  // ---------------------------------------------------------------- meetings & consent
  /** The Meet meeting, if (and only if) the caller may use AI on it: they host it, or they are owner/admin of the host's workspace. */
  async function meetingFor(db, req, meetUuid) {
    if (!UUID_RE.test(meetUuid)) return null;
    const r = (await db.query(
      `SELECT d.meet_uuid, d.meet_code, d.title, d.scheduled_at, d.owner_user_id, d.status FROM public.portal_meeting_directory d
       JOIN portal.members m ON m.workspace_id=$1 AND m.user_id=d.owner_user_id WHERE d.meet_uuid=$2 AND d.status='synced'`, [req.workspace, meetUuid.toLowerCase()])).rows[0];
    if (!r) return null;
    return (r.owner_user_id === req.actor || isManager(req.role)) ? r : null;
  }
  const activeConsents = async (db, ws, meetUuid) => (await db.query('SELECT id, scope, notice_version, granted_by, granted_at FROM portal.meeting_ai_consents WHERE workspace_id=$1 AND meet_meeting_id=$2 AND revoked_at IS NULL ORDER BY scope', [ws, meetUuid])).rows;

  app.get('/api/v1/meeting-ai/notice', member, (req, res) => res.json(NOTICE));
  app.get('/api/v1/meeting-ai/status', member, (req, res) => res.json({ ai_provider_configured: llm.available, meet_integration_configured: meet.available, processes_recordings: false,
    sources: ['meet_chat', 'transcript_import'], note: 'Recordings are never processed in this release; only the meeting chat or a transcript you import.' }));

  app.get('/api/v1/meeting-ai/meetings', member, h(async (req, res) => {
    const rows = (await pool.query(
      `SELECT d.meet_uuid, d.meet_code, d.title, d.scheduled_at, d.owner_user_id,
         (SELECT array_agg(c.scope ORDER BY c.scope) FROM portal.meeting_ai_consents c WHERE c.workspace_id=$1 AND c.meet_meeting_id=d.meet_uuid AND c.revoked_at IS NULL) AS consent_scopes,
         (SELECT row_to_json(j) FROM (SELECT id,status,stage,error_code,created_at FROM portal.meeting_ai_jobs WHERE workspace_id=$1 AND meet_meeting_id=d.meet_uuid ORDER BY created_at DESC LIMIT 1) j) AS latest_job,
         (SELECT r.id FROM portal.meeting_reports r WHERE r.workspace_id=$1 AND r.meet_meeting_id=d.meet_uuid AND r.deleted_at IS NULL AND r.status='final' ORDER BY r.created_at DESC LIMIT 1) AS report_id
       FROM public.portal_meeting_directory d JOIN portal.members m ON m.workspace_id=$1 AND m.user_id=d.owner_user_id
       WHERE d.status='synced' AND ($2::boolean OR d.owner_user_id=$3) ORDER BY d.scheduled_at DESC NULLS LAST, d.title LIMIT 100`, [req.workspace, isManager(req.role), req.actor])).rows;
    res.set('Cache-Control', 'no-store').json(rows.map((r) => ({ ...r, consent_scopes: r.consent_scopes || [], i_am_host: r.owner_user_id === req.actor })));
  }));
  app.get('/api/v1/meeting-ai/meetings/:id/consents', member, h(async (req, res) => {
    const m = await meetingFor(pool, req, req.params.id); if (!m) return res.status(404).json({ error: 'Meeting not found' });
    const rows = (await pool.query('SELECT id, scope, notice_version, granted_by, granted_at, revoked_at, revoked_by, revoke_reason FROM portal.meeting_ai_consents WHERE workspace_id=$1 AND meet_meeting_id=$2 ORDER BY granted_at DESC', [req.workspace, m.meet_uuid])).rows;
    res.json({ notice: NOTICE, consents: rows });
  }));
  app.post('/api/v1/meeting-ai/meetings/:id/consents', member, h(async (req, res) => {
    const p = z.object({ attest: z.literal(true), notice_version: z.literal(NOTICE.version), scopes: z.array(z.enum(['transcription', 'summary', 'recording'])).min(1).default(['transcription', 'summary']) }).parse(req.body);
    const m = await meetingFor(pool, req, req.params.id); if (!m) return res.status(404).json({ error: 'Meeting not found' });
    if (m.owner_user_id !== req.actor) return res.status(403).json({ error: 'Only the meeting host can grant consent', code: 'host_only' });
    const out = await withWorkspaceLock(pool, req.workspace, async (c) => {
      for (const scope of new Set(p.scopes)) {
        await c.query(`INSERT INTO portal.meeting_ai_consents(workspace_id,meet_meeting_id,scope,notice_version,notice_text,granted_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [req.workspace, m.meet_uuid, scope, NOTICE.version, NOTICE.text, req.actor]);
      }
      await audit(c, req.workspace, req.actor, 'meeting_ai.consent_granted', m.meet_uuid);
      return activeConsents(c, req.workspace, m.meet_uuid);
    });
    res.status(201).json({ active: out });
  }));
  app.post('/api/v1/meeting-ai/consents/:cid/revoke', member, h(async (req, res) => {
    if (!UUID_RE.test(req.params.cid)) return res.status(400).json({ error: 'Invalid id' });
    const p = z.object({ reason: z.string().trim().max(300).optional() }).parse(req.body || {});
    const c0 = (await pool.query('SELECT * FROM portal.meeting_ai_consents WHERE id=$1 AND workspace_id=$2', [req.params.cid, req.workspace])).rows[0];
    const m = c0 && (await meetingFor(pool, req, c0.meet_meeting_id)); if (!m) return res.status(404).json({ error: 'Consent not found' });
    const out = await withWorkspaceLock(pool, req.workspace, async (c) => {
      const r = await c.query('UPDATE portal.meeting_ai_consents SET revoked_at=now(), revoked_by=$2, revoke_reason=$3 WHERE id=$1 AND revoked_at IS NULL RETURNING scope', [c0.id, req.actor, p.reason || null]);
      if (!r.rowCount) return { already: true };
      const summary = { cancelled_jobs: 0, purged_transcripts: 0, withdrawn_reports: 0, revoked_shares: 0 };
      if (CONSENT_SCOPES.includes(c0.scope)) {      // derived content exists only for these scopes; recording is never processed
        summary.cancelled_jobs = (await c.query(`UPDATE portal.meeting_ai_jobs SET status='cancelled', error_code='consent_revoked', error_message='Consent revoked', lease_until=NULL, lease_token=NULL, finished_at=now() WHERE workspace_id=$1 AND meet_meeting_id=$2 AND status IN ('queued','running','blocked')`, [req.workspace, c0.meet_meeting_id])).rowCount;
        summary.purged_transcripts = (await c.query(`UPDATE portal.meeting_transcripts SET segments='[]'::jsonb, full_text='', purged_at=now(), purge_reason='consent_revoked' WHERE workspace_id=$1 AND meet_meeting_id=$2 AND purged_at IS NULL`, [req.workspace, c0.meet_meeting_id])).rowCount;
        const reps = (await c.query(`UPDATE portal.meeting_reports SET status='withdrawn', summary='', decisions='[]'::jsonb, topics='[]'::jsonb, updated_at=now() WHERE workspace_id=$1 AND meet_meeting_id=$2 AND status='final' RETURNING id`, [req.workspace, c0.meet_meeting_id])).rows.map((x) => x.id);
        summary.withdrawn_reports = reps.length;
        if (reps.length) {
          await c.query('DELETE FROM portal.meeting_action_items WHERE workspace_id=$1 AND report_id = ANY($2)', [req.workspace, reps]);
          summary.revoked_shares = (await c.query('UPDATE portal.report_shares SET revoked_at=now(), revoked_by=$3 WHERE workspace_id=$1 AND report_id = ANY($2) AND revoked_at IS NULL', [req.workspace, reps, req.actor])).rowCount;
        }
      }
      await audit(c, req.workspace, req.actor, 'meeting_ai.consent_revoked', c0.meet_meeting_id);
      return summary;
    });
    res.json(out.already ? { already_revoked: true } : { revoked: true, ...out });
  }));

  // ---------------------------------------------------------------- jobs
  const jobView = (j) => ({ id: j.id, meet_meeting_id: j.meet_meeting_id, source: j.source, status: j.status, stage: j.stage, attempts: j.attempts, error_code: j.error_code, error_message: j.error_message, report_id: j.report_id, created_at: j.created_at, finished_at: j.finished_at, requested_by: j.requested_by });
  app.post('/api/v1/meeting-ai/jobs', member, h(async (req, res) => {
    const p = z.object({
      meet_meeting_id: uuid, source: z.enum(['meet_chat', 'transcript_import']), idempotency_key: z.string().min(8).max(100),
      transcript: z.object({ format: z.enum(['txt', 'vtt', 'srt']), text: z.string().min(1).max(500_000) }).optional()
    }).parse(req.body);
    if ((p.source === 'transcript_import') !== !!p.transcript) return res.status(400).json({ error: 'transcript is required for imports and not allowed for meet_chat' });
    const m = await meetingFor(pool, req, p.meet_meeting_id); if (!m) return res.status(404).json({ error: 'Meeting not found' });
    let parsed = null;
    if (p.transcript) { try { parsed = parseTranscript(p.transcript.format, p.transcript.text); } catch (e) { return res.status(400).json({ error: e.message, code: e.code || 'bad_transcript' }); } }
    const out = await withWorkspaceLock(pool, req.workspace, async (c) => {
      const dup = (await c.query('SELECT * FROM portal.meeting_ai_jobs WHERE workspace_id=$1 AND idempotency_key=$2', [req.workspace, p.idempotency_key])).rows[0];
      if (dup) { if (dup.meet_meeting_id !== m.meet_uuid || dup.source !== p.source) throw httpErr(409, 'Idempotency key was used for a different request', 'idempotency_conflict'); return { job: dup, duplicate: true }; }
      const have = await activeConsents(c, req.workspace, m.meet_uuid); const missing = CONSENT_SCOPES.filter((s) => !have.some((x) => x.scope === s));
      if (missing.length) throw httpErr(403, 'The meeting host has not given consent for AI processing', 'consent_required', { missing });
      const q = await quotaFor(c, req.workspace, 'ai.meeting_reports_per_month');
      const used = Number((await c.query(`SELECT count(*) FROM portal.meeting_ai_jobs WHERE workspace_id=$1 AND status IN ('queued','running','completed') AND created_at >= date_trunc('month', now())`, [req.workspace])).rows[0].count);
      if (!q.granted || (q.quota !== null && used >= q.quota)) { if (overage) await overage.allowBeyondQuota(c, req.workspace, 'meeting_report', q, { used }); else throw new PlanLimitError('ai.meeting_reports_per_month', q.quota, q.plan, { used }); }
      const job = (await c.query(`INSERT INTO portal.meeting_ai_jobs(workspace_id,meet_meeting_id,requested_by,source,stage,idempotency_key) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.workspace, m.meet_uuid, req.actor, p.source, parsed ? 'summarize' : 'fetch', p.idempotency_key])).rows[0];
      if (parsed) {
        const t = (await c.query(`INSERT INTO portal.meeting_transcripts(workspace_id,meet_meeting_id,job_id,source,speaker_labels,segments,full_text,content_sha256,created_by) VALUES($1,$2,$3,'transcript_import',$4,$5,$6,$7,$8) RETURNING id`,
          [req.workspace, m.meet_uuid, job.id, parsed.speakerLabels, JSON.stringify(parsed.segments), parsed.fullText, sha256(parsed.fullText), req.actor])).rows[0];
        await c.query('UPDATE portal.meeting_ai_jobs SET transcript_id=$2 WHERE id=$1', [job.id, t.id]); job.transcript_id = t.id;
      }
      await audit(c, req.workspace, req.actor, 'meeting_ai.job_created', job.id);
      return { job, duplicate: false };
    });
    res.status(out.duplicate ? 200 : 202).json({ ...jobView(out.job), duplicate: out.duplicate });
  }));
  app.get('/api/v1/meeting-ai/jobs', member, h(async (req, res) => {
    const rows = (await pool.query(`SELECT * FROM portal.meeting_ai_jobs WHERE workspace_id=$1 AND ($2::boolean OR requested_by=$3) ORDER BY created_at DESC LIMIT 100`, [req.workspace, isManager(req.role), req.actor])).rows;
    res.set('Cache-Control', 'no-store').json(rows.map(jobView));
  }));
  const jobFor = async (req) => {
    if (!UUID_RE.test(req.params.id)) return null;
    const j = (await pool.query('SELECT * FROM portal.meeting_ai_jobs WHERE id=$1 AND workspace_id=$2', [req.params.id, req.workspace])).rows[0];
    return j && (j.requested_by === req.actor || isManager(req.role)) ? j : null;
  };
  app.get('/api/v1/meeting-ai/jobs/:id', member, h(async (req, res) => { const j = await jobFor(req); return j ? res.set('Cache-Control', 'no-store').json(jobView(j)) : res.status(404).json({ error: 'Job not found' }); }));
  app.post('/api/v1/meeting-ai/jobs/:id/cancel', member, h(async (req, res) => {
    const j = await jobFor(req); if (!j) return res.status(404).json({ error: 'Job not found' });
    const r = await pool.query(`UPDATE portal.meeting_ai_jobs SET status='cancelled', error_code='cancelled_by_user', lease_until=NULL, lease_token=NULL, finished_at=now() WHERE id=$1 AND status IN ('queued','blocked','failed')`, [j.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'This job can no longer be cancelled', code: 'not_cancellable' });
    res.json({ cancelled: true });
  }));
  app.post('/api/v1/meeting-ai/jobs/:id/retry', member, h(async (req, res) => {
    const j = await jobFor(req); if (!j) return res.status(404).json({ error: 'Job not found' });
    if (!isManager(req.role) && j.requested_by !== req.actor) return res.status(403).json({ error: 'Not allowed' });
    const have = await activeConsents(pool, req.workspace, j.meet_meeting_id); if (!CONSENT_SCOPES.every((s) => have.some((x) => x.scope === s))) return res.status(403).json({ error: 'Consent is not active', code: 'consent_required' });
    const r = await pool.query(`UPDATE portal.meeting_ai_jobs SET status='queued', attempts=0, error_code=NULL, error_message=NULL, next_attempt_at=now(), finished_at=NULL WHERE id=$1 AND status IN ('failed','blocked')`, [j.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'Only failed or blocked jobs can be retried', code: 'not_retryable' });
    res.status(202).json({ queued: true });
  }));

  // ---------------------------------------------------------------- reports
  /** @returns {{report, level}} level: 'manage' | 'view' | 'assignee' | 'meta' (withdrawn, managers only) | null */
  async function reportAccess(db, req, id) {
    if (!UUID_RE.test(id)) return null;
    const r = (await db.query('SELECT * FROM portal.meeting_reports WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL', [id, req.workspace])).rows[0]; if (!r) return null;
    const manage = req.actor === r.created_by || req.actor === r.host_user_id || isManager(req.role);
    if (r.status === 'withdrawn') return manage ? { report: r, level: 'meta' } : null;
    if (manage) return { report: r, level: 'manage' };
    if (r.visibility === 'workspace') return { report: r, level: 'view' };
    const share = (await db.query(`SELECT 1 FROM portal.report_shares WHERE report_id=$1 AND kind='member' AND recipient_user_id=$2 AND revoked_at IS NULL`, [r.id, req.actor])).rowCount;
    if (share) return { report: r, level: 'view' };
    const mine = (await db.query('SELECT 1 FROM portal.meeting_action_items WHERE report_id=$1 AND owner_id=$2', [r.id, req.actor])).rowCount;
    return mine ? { report: r, level: 'assignee' } : null;
  }
  const listVisibleSql = `SELECT r.id, r.title, left(r.summary, 280) AS excerpt, r.status, r.visibility, r.created_at, r.meet_meeting_id, r.created_by, r.host_user_id,
      (SELECT count(*) FROM portal.meeting_action_items a WHERE a.report_id=r.id AND a.status='open')::int AS open_items
    FROM portal.meeting_reports r WHERE r.workspace_id=$1 AND r.deleted_at IS NULL AND (
      ($2::boolean AND true) OR r.created_by=$3 OR r.host_user_id=$3
      OR (r.status='final' AND (r.visibility='workspace'
          OR EXISTS (SELECT 1 FROM portal.report_shares s WHERE s.report_id=r.id AND s.kind='member' AND s.recipient_user_id=$3 AND s.revoked_at IS NULL)
          OR EXISTS (SELECT 1 FROM portal.meeting_action_items a WHERE a.report_id=r.id AND a.owner_id=$3)))
    ) ORDER BY r.created_at DESC LIMIT 100`;
  app.get('/api/v1/meeting-ai/reports', member, h(async (req, res) => res.set('Cache-Control', 'no-store').json((await pool.query(listVisibleSql, [req.workspace, isManager(req.role), req.actor])).rows)));

  async function itemsFor(db, req, reportId, level) {
    const rows = (await db.query('SELECT id, title, owner_hint, due_hint, owner_id, due_at, status, completed_at, source FROM portal.meeting_action_items WHERE report_id=$1 ORDER BY created_at, id', [reportId])).rows;
    const visible = level === 'assignee' ? rows.filter((i) => i.owner_id === req.actor) : rows;
    const names = await directory.names(visible.map((i) => i.owner_id).filter(Boolean));
    return visible.map((i) => ({ ...i, owner_label: i.owner_id ? (names[i.owner_id] || null) : null }));
  }
  app.get('/api/v1/meeting-ai/reports/:id', member, h(async (req, res) => {
    const a = await reportAccess(pool, req, req.params.id); if (!a) return res.status(404).json({ error: 'Report not found' });
    const r = a.report; const manage = a.level === 'manage' || a.level === 'meta';
    const body = { id: r.id, title: r.title, status: r.status, visibility: r.visibility, created_at: r.created_at, meet_meeting_id: r.meet_meeting_id, generated_by: r.generated_by, level: a.level,
      permissions: { manage, transcript: manage && r.status === 'final', export: a.level === 'manage' || a.level === 'view' } };
    if (a.level !== 'meta' && a.level !== 'assignee') Object.assign(body, { summary: r.summary, decisions: r.decisions, topics: r.topics });
    if (a.level === 'assignee') body.summary_hidden = true;
    body.action_items = a.level === 'meta' ? [] : await itemsFor(pool, req, r.id, a.level);
    if (manage) body.members = (await pool.query('SELECT user_id, role FROM portal.members WHERE workspace_id=$1', [req.workspace])).rows;
    if (manage && body.members) { const n = await directory.names(body.members.map((m) => m.user_id)); body.members = body.members.map((m) => ({ ...m, display_name: n[m.user_id] || null })); }
    res.set('Cache-Control', 'no-store').json(body);
  }));
  app.patch('/api/v1/meeting-ai/reports/:id', member, h(async (req, res) => {
    const a = await reportAccess(pool, req, req.params.id); if (!a || a.level === 'assignee') return res.status(404).json({ error: 'Report not found' });
    if (a.level !== 'manage') return res.status(403).json({ error: 'Only the report owner, the host or an admin can edit this report' });
    const p = z.object({ title: z.string().trim().min(1).max(200).optional(), visibility: z.enum(['restricted', 'workspace']).optional() }).parse(req.body);
    const r = await pool.query('UPDATE portal.meeting_reports SET title=COALESCE($3,title), visibility=COALESCE($4,visibility), updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING id,title,visibility', [a.report.id, req.workspace, p.title ?? null, p.visibility ?? null]);
    await audit(pool, req.workspace, req.actor, 'meeting_ai.report_updated', a.report.id);
    res.json(r.rows[0]);
  }));
  app.delete('/api/v1/meeting-ai/reports/:id', member, h(async (req, res) => {
    const a = await reportAccess(pool, req, req.params.id); if (!a || a.level === 'assignee') return res.status(404).json({ error: 'Report not found' });
    if (a.level !== 'manage' && a.level !== 'meta') return res.status(403).json({ error: 'Not allowed' });
    await withWorkspaceLock(pool, req.workspace, async (c) => {
      await c.query('UPDATE portal.meeting_reports SET deleted_at=now() WHERE id=$1', [a.report.id]);
      await c.query('UPDATE portal.report_shares SET revoked_at=now(), revoked_by=$2 WHERE report_id=$1 AND revoked_at IS NULL', [a.report.id, req.actor]);
      await audit(c, req.workspace, req.actor, 'meeting_ai.report_deleted', a.report.id);
    });
    res.status(204).end();
  }));
  app.get('/api/v1/meeting-ai/reports/:id/transcript', member, h(async (req, res) => {
    const a = await reportAccess(pool, req, req.params.id);
    if (!a || a.level !== 'manage') return res.status(a ? 403 : 404).json({ error: a ? 'Transcripts are visible to the report owner, the host and workspace admins only' : 'Report not found' });
    const t = (await pool.query('SELECT id, source, speaker_labels, segments, created_at, purged_at FROM portal.meeting_transcripts WHERE id=$1 AND workspace_id=$2', [a.report.transcript_id, req.workspace])).rows[0];
    if (!t || t.purged_at) return res.status(410).json({ error: 'The transcript has been deleted', code: 'purged' });
    res.set('Cache-Control', 'no-store').json({ source: t.source, speaker_labels: t.speaker_labels, speaker_note: 'Speaker names are labels typed by participants, not verified identities.', segments: t.segments, created_at: t.created_at });
  }));

  // ---------------------------------------------------------------- action items
  app.post('/api/v1/meeting-ai/reports/:id/action-items', member, h(async (req, res) => {
    const a = await reportAccess(pool, req, req.params.id); if (!a || a.level === 'assignee') return res.status(404).json({ error: 'Report not found' });
    if (a.level !== 'manage') return res.status(403).json({ error: 'Not allowed' });
    const p = z.object({ title: z.string().trim().min(1).max(500), owner_id: uuid.nullish(), due_at: z.string().datetime({ offset: true }).nullish() }).parse(req.body);
    if (p.owner_id && !(await pool.query('SELECT 1 FROM portal.members WHERE workspace_id=$1 AND user_id=$2', [req.workspace, p.owner_id.toLowerCase()])).rowCount) return res.status(400).json({ error: 'The assignee must be a member of this workspace', code: 'not_a_member' });
    const r = await pool.query(`INSERT INTO portal.meeting_action_items(workspace_id,report_id,title,owner_id,due_at,source,created_by) VALUES($1,$2,$3,$4,$5,'manual',$6) RETURNING id,title,owner_id,due_at,status`, [req.workspace, a.report.id, p.title, p.owner_id?.toLowerCase() || null, p.due_at || null, req.actor]);
    res.status(201).json(r.rows[0]);
  }));
  app.patch('/api/v1/meeting-ai/action-items/:aid', member, h(async (req, res) => {
    if (!UUID_RE.test(req.params.aid)) return res.status(400).json({ error: 'Invalid id' });
    const item = (await pool.query('SELECT i.*, r.status AS report_status FROM portal.meeting_action_items i JOIN portal.meeting_reports r ON r.id=i.report_id AND r.deleted_at IS NULL WHERE i.id=$1 AND i.workspace_id=$2', [req.params.aid, req.workspace])).rows[0];
    if (!item || item.report_status !== 'final') return res.status(404).json({ error: 'Action item not found' });
    const a = await reportAccess(pool, req, item.report_id); if (!a) return res.status(404).json({ error: 'Action item not found' });
    const canEdit = a.level === 'manage'; const isAssignee = item.owner_id === req.actor;
    if (!canEdit && !isAssignee) return res.status(403).json({ error: 'Not allowed' });
    const p = z.object({ title: z.string().trim().min(1).max(500).optional(), owner_id: uuid.nullable().optional(), due_at: z.string().datetime({ offset: true }).nullable().optional(), status: z.enum(['open', 'done']).optional() }).strict().parse(req.body);
    if (!canEdit && (p.title !== undefined || p.owner_id !== undefined || p.due_at !== undefined)) return res.status(403).json({ error: 'Assignees can only change the status of their own items', code: 'assignee_status_only' });
    if (p.owner_id && !(await pool.query('SELECT 1 FROM portal.members WHERE workspace_id=$1 AND user_id=$2', [req.workspace, p.owner_id.toLowerCase()])).rowCount) return res.status(400).json({ error: 'The assignee must be a member of this workspace', code: 'not_a_member' });
    const r = await pool.query(
      `UPDATE portal.meeting_action_items SET title=COALESCE($3,title), owner_id=CASE WHEN $4::boolean THEN $5::uuid ELSE owner_id END, due_at=CASE WHEN $6::boolean THEN $7::timestamptz ELSE due_at END,
         status=COALESCE($8,status), completed_at=CASE WHEN $8='done' THEN COALESCE(completed_at, now()) WHEN $8='open' THEN NULL ELSE completed_at END, updated_at=now()
       WHERE id=$1 AND workspace_id=$2 RETURNING id,title,owner_id,due_at,status,completed_at`,
      [item.id, req.workspace, p.title ?? null, p.owner_id !== undefined, p.owner_id?.toLowerCase() ?? null, p.due_at !== undefined, p.due_at ?? null, p.status ?? null]);
    await audit(pool, req.workspace, req.actor, 'meeting_ai.action_item_updated', item.id);
    res.json(r.rows[0]);
  }));
  app.get('/api/v1/meeting-ai/action-items', member, h(async (req, res) => {
    const rows = (await pool.query(
      `SELECT i.id, i.title, i.due_at, i.status, i.report_id, r.title AS report_title FROM portal.meeting_action_items i JOIN portal.meeting_reports r ON r.id=i.report_id AND r.deleted_at IS NULL AND r.status='final'
       WHERE i.workspace_id=$1 AND i.owner_id=$2 AND ($3::text IS NULL OR i.status=$3) ORDER BY i.due_at NULLS LAST, i.created_at LIMIT 200`, [req.workspace, req.actor, req.query.status === 'open' || req.query.status === 'done' ? req.query.status : null])).rows;
    res.set('Cache-Control', 'no-store').json(rows);
  }));

  // ---------------------------------------------------------------- sharing
  app.get('/api/v1/meeting-ai/reports/:id/shares', member, h(async (req, res) => {
    const a = await reportAccess(pool, req, req.params.id); if (!a || a.level !== 'manage') return res.status(a ? 403 : 404).json({ error: a ? 'Not allowed' : 'Report not found' });
    const rows = (await pool.query(`SELECT id, kind, recipient_user_id, recipient_label, include_transcript, expires_at, revoked_at, access_count, last_accessed_at, created_at, created_by FROM portal.report_shares WHERE report_id=$1 ORDER BY created_at DESC`, [a.report.id])).rows;
    res.set('Cache-Control', 'no-store').json(rows);
  }));
  app.post('/api/v1/meeting-ai/reports/:id/shares', member, h(async (req, res) => {
    const a = await reportAccess(pool, req, req.params.id); if (!a || a.level !== 'manage') return res.status(a ? 403 : 404).json({ error: a ? 'Not allowed' : 'Report not found' });
    const p = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('member'), user_id: uuid }),
      z.object({ kind: z.literal('link'), label: z.string().trim().max(120).optional(), expires_in_days: z.number().int().min(1).max(90).default(14), include_transcript: z.boolean().default(false) })
    ]).parse(req.body);
    if (p.kind === 'member') {
      if (!(await pool.query('SELECT 1 FROM portal.members WHERE workspace_id=$1 AND user_id=$2', [req.workspace, p.user_id.toLowerCase()])).rowCount) return res.status(400).json({ error: 'Share with workspace members only', code: 'not_a_member' });
      const r = await pool.query(`INSERT INTO portal.report_shares(report_id,workspace_id,kind,recipient_user_id,created_by) VALUES($1,$2,'member',$3,$4) ON CONFLICT DO NOTHING RETURNING id`, [a.report.id, req.workspace, p.user_id.toLowerCase(), req.actor]);
      await audit(pool, req.workspace, req.actor, 'meeting_ai.report_shared', a.report.id);
      return res.status(r.rowCount ? 201 : 200).json({ id: r.rows[0]?.id || null, kind: 'member', already: !r.rowCount });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const r = await pool.query(`INSERT INTO portal.report_shares(report_id,workspace_id,kind,recipient_label,token_hash,include_transcript,expires_at,created_by) VALUES($1,$2,'link',$3,$4,$5,now()+($6::int * interval '1 day'),$7) RETURNING id,expires_at`,
      [a.report.id, req.workspace, p.label || null, sha256(token), p.include_transcript, p.expires_in_days, req.actor]);
    await audit(pool, req.workspace, req.actor, 'meeting_ai.report_link_created', a.report.id);
    res.status(201).set('Cache-Control', 'no-store').json({ id: r.rows[0].id, kind: 'link', expires_at: r.rows[0].expires_at, path: `/shared/report/${token}`, token, shown_once: true });   // the token is never retrievable again
  }));
  app.post('/api/v1/meeting-ai/shares/:sid/revoke', member, h(async (req, res) => {
    if (!UUID_RE.test(req.params.sid)) return res.status(400).json({ error: 'Invalid id' });
    const s = (await pool.query('SELECT id, report_id FROM portal.report_shares WHERE id=$1 AND workspace_id=$2', [req.params.sid, req.workspace])).rows[0];
    const a = s && (await reportAccess(pool, req, s.report_id)); if (!a || a.level !== 'manage') return res.status(a ? 403 : 404).json({ error: a ? 'Not allowed' : 'Share not found' });
    const r = await pool.query('UPDATE portal.report_shares SET revoked_at=now(), revoked_by=$2 WHERE id=$1 AND revoked_at IS NULL', [s.id, req.actor]);
    await audit(pool, req.workspace, req.actor, 'meeting_ai.share_revoked', s.id);
    res.json({ revoked: true, already: !r.rowCount });
  }));

  // PUBLIC (no cookies): a bearer link. Read-only, rate limited, no-store, never indexed; access is counted; revocation is immediate.
  const shareLimiter = rateLimit({ windowMs: 60_000, limit: cfg.shareLimit ?? 60, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests' } });
  app.get('/api/v1/shared/reports/:token', shareLimiter, h(async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    const token = String(req.params.token || ''); if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return res.status(404).json({ error: 'This link is not valid' });
    const s = (await pool.query(`SELECT s.id, s.include_transcript, r.id AS rid, r.title, r.summary, r.decisions, r.topics, r.created_at, r.transcript_id, r.status
      FROM portal.report_shares s JOIN portal.meeting_reports r ON r.id=s.report_id AND r.deleted_at IS NULL AND r.status='final'
      WHERE s.token_hash=$1 AND s.kind='link' AND s.revoked_at IS NULL AND s.expires_at > now()`, [sha256(token)])).rows[0];
    if (!s) return res.status(404).json({ error: 'This link is not valid, has expired or was revoked' });   // same answer for every failure: no oracle
    await pool.query('UPDATE portal.report_shares SET access_count=access_count+1, last_accessed_at=now() WHERE id=$1', [s.id]);
    const items = (await pool.query('SELECT title, status, due_at FROM portal.meeting_action_items WHERE report_id=$1 ORDER BY created_at, id', [s.rid])).rows;
    let transcript = null;
    if (s.include_transcript && s.transcript_id) { const t = (await pool.query('SELECT segments, purged_at FROM portal.meeting_transcripts WHERE id=$1', [s.transcript_id])).rows[0]; if (t && !t.purged_at) transcript = t.segments; }
    res.json({ title: s.title, summary: s.summary, decisions: s.decisions, topics: s.topics, action_items: items, transcript, generated_at: s.created_at, note: 'AI-generated. Speaker names are labels typed by participants.' });
  }));

  // ---------------------------------------------------------------- export
  async function exportReport(req, res, format) {
    const a = await reportAccess(pool, req, req.params.id); if (!a || !['manage', 'view'].includes(a.level)) return res.status(a ? 403 : 404).json({ error: a ? 'Not allowed' : 'Report not found' });
    const items = await itemsFor(pool, req, a.report.id, a.level);
    let transcript = null;
    if (req.query.transcript === '1') {
      if (a.level !== 'manage') return res.status(403).json({ error: 'Transcripts are visible to the report owner, the host and workspace admins only' });
      const t = (await pool.query('SELECT segments, purged_at FROM portal.meeting_transcripts WHERE id=$1', [a.report.transcript_id])).rows[0]; if (t && !t.purged_at) transcript = { segments: t.segments };
    }
    const model = exportModel({ report: a.report, items, transcript });
    const buf = format === 'pdf' ? await toPdf(model) : await toDocx(model);
    await audit(pool, req.workspace, req.actor, 'meeting_ai.report_exported', a.report.id);
    res.set({ 'Content-Type': format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': `attachment; filename="meeting-report-${a.report.id.slice(0, 8)}.${format}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).send(buf);
  }
  app.get('/api/v1/meeting-ai/reports/:id/export.pdf', member, h((req, res) => exportReport(req, res, 'pdf')));
  app.get('/api/v1/meeting-ai/reports/:id/export.docx', member, h((req, res) => exportReport(req, res, 'docx')));

  // ---------------------------------------------------------------- usage
  app.get('/api/v1/meeting-ai/usage', member, h(async (req, res) => {
    const q = await quotaFor(pool, req.workspace, 'ai.meeting_reports_per_month');
    const used = Number((await pool.query(`SELECT count(*) FROM portal.meeting_ai_jobs WHERE workspace_id=$1 AND status IN ('queued','running','completed') AND created_at >= date_trunc('month', now())`, [req.workspace])).rows[0].count);
    const ev = (await pool.query(`SELECT feature, COALESCE(sum(units),0)::bigint AS units FROM portal.ai_usage_events WHERE workspace_id=$1 AND created_at >= date_trunc('month', now()) GROUP BY feature`, [req.workspace])).rows;
    res.set('Cache-Control', 'no-store').json({ plan: q.plan, reports_limit: q.quota, reports_used: used, unlimited: q.quota === null, events: Object.fromEntries(ev.map((e) => [e.feature, Number(e.units)])) });
  }));
}

export { httpErr };
