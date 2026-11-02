// Meeting-AI job runner: leased queue (FOR UPDATE SKIP LOCKED), stage checkpoints, fenced writes, bounded retries with backoff.
// Every side effect is idempotent: transcripts are UNIQUE(job_id), reports UNIQUE(job_id), usage events UNIQUE(workspace, key).
// Consent is re-checked at every stage; a revoked consent cancels the job and nothing further is stored or sent to the model.
import crypto from 'node:crypto';
import { segmentsFromMeetChat } from './parse.mjs';
import { applyParticipantConsent, importAllowed, stillConsented, checkFresh, basisFor } from './meet-consent.mjs';
import { withdrawReport } from './withdraw.mjs';
import { groundStatement, sha } from './citations.mjs';

const CONSENT_SCOPES = ['transcription', 'summary'];
const safe = (s, n = 300) => String(s || '').replace(/[\u0000-\u001F]/g, ' ').slice(0, n);

export function createAiWorker({ pool, llm, meet, citations, log, overage = null, isEnabled = async () => true, leaseSeconds = 120, maxAttempts = 5, backoffBaseSeconds = 15, retentionDays = 0 }) {
  async function activeConsents(db, job) {
    const r = await db.query(`SELECT scope FROM portal.meeting_ai_consents WHERE workspace_id=$1 AND meet_meeting_id=$2 AND revoked_at IS NULL AND scope = ANY($3)`, [job.workspace_id, job.meet_meeting_id, CONSENT_SCOPES]);
    return CONSENT_SCOPES.every((s) => r.rows.some((x) => x.scope === s));
  }
  async function claim() {
    // a job whose worker keeps dying is not taken over forever (it would re-send consented text to the gateway on every attempt): after maxAttempts it is failed, and a person decides
    await pool.query(`UPDATE portal.meeting_ai_jobs SET status='failed', error_code='interrupted_too_often', error_message='The job was interrupted too many times', lease_until=NULL, lease_token=NULL, finished_at=now() WHERE status='running' AND lease_until<now() AND attempts>=$1`, [maxAttempts]);
    const token = crypto.randomUUID();
    const r = await pool.query(
      `UPDATE portal.meeting_ai_jobs j SET status='running', lease_token=$1, lease_until=now()+($2::float8 * interval '1 second'), attempts=j.attempts+1, started_at=COALESCE(j.started_at,now())
       WHERE j.id = (SELECT id FROM portal.meeting_ai_jobs WHERE (status='queued' AND next_attempt_at<=now()) OR (status='running' AND lease_until<now() AND attempts<$3) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING j.*`, [token, leaseSeconds, maxAttempts]);
    return r.rows[0] || null;
  }
  const finish = (job, status, code, message) => pool.query(
    `UPDATE portal.meeting_ai_jobs SET status=$3, error_code=$4, error_message=$5, lease_until=NULL, lease_token=NULL, finished_at=CASE WHEN $3 IN ('completed','failed','cancelled') THEN now() ELSE finished_at END
     WHERE id=$1 AND lease_token=$2`, [job.id, job.lease_token, status, code || null, message ? safe(message) : null]);

  // LOCK ORDER, everywhere: workspace row, then job row, then transcript rows (a host's revocation, meeting-ai.mjs, takes them in this order too). A KEY SHARE lock on the workspace is exactly
  // what the foreign keys of the rows written below need anyway, and it only conflicts with a revocation's FOR UPDATE, so workers do not block each other. Without taking it FIRST, a worker holding
  // the job row and a revocation holding the workspace row waited on each other and PostgreSQL aborted one of them (found by the revocation-race test).
  const lockWorkspace = (c, job) => c.query('SELECT 1 FROM portal.workspaces WHERE id=$1 FOR KEY SHARE', [job.workspace_id]);

  /** Runs `fn(client)` inside a transaction that holds the job row, but only if this worker still owns the lease. */
  async function fenced(job, fn) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); await lockWorkspace(c, job);
      const cur = (await c.query('SELECT status, lease_token FROM portal.meeting_ai_jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
      if (!cur || cur.lease_token !== job.lease_token || cur.status !== 'running') { await c.query('ROLLBACK'); return { lost: true }; }
      const out = await fn(c); await c.query('COMMIT'); return { out };
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }

  // ---- consent evidence (append-only, counts and reason codes only: never transcript text or names) ----
  const cAudit = (db, job, event, detail = {}, scope = null) => db.query('INSERT INTO portal.meeting_ai_consent_audit(workspace_id,meet_meeting_id,job_id,actor,event,scope,detail) VALUES($1,$2,$3,$4,$5,$6,$7)', [job.workspace_id, job.meet_meeting_id, job.id, 'system:ai-worker', event, scope, JSON.stringify(detail)]);
  const CODE = { request_closed: 'participant_consent_required', participant_consent_required: 'participant_consent_required', participant_withdrew: 'participant_consent_withdrawn', participant_declined: 'participant_declined' };
  const clockLabel = (s) => (s?.at ? new Date(s.at).toISOString().slice(11, 16) + ' UTC' : (s?.start_ms != null ? Math.floor(s.start_ms / 60000) + ':' + String(Math.floor(s.start_ms / 1000) % 60).padStart(2, '0') : ''));

  /** Meet's answer right now: is every person whose content is (or would be) used still agreeing, and is the host's AI request still open? Unreachable Meet = no answer = nothing proceeds. */
  async function participantCheck(job) {
    const consent = await meet.fetchConsent(job.meet_meeting_id);
    const rows = (await pool.query('SELECT participant_id, transcription_seq, summary_seq FROM portal.meeting_ai_job_participants WHERE job_id=$1 AND included', [job.id])).rows;
    return stillConsented({ consent, rows, source: job.source });                     // an import is checked against EVERY person in the meeting, a chat job against the people whose words it holds
  }
  /** The numbers an included person's agreements had when their messages were taken (what every later read is checked against). */
  const snapshotRows = async (db, job) => (await db.query('SELECT participant_id, transcription_seq, summary_seq FROM portal.meeting_ai_job_participants WHERE job_id=$1 AND included ORDER BY participant_id', [job.id])).rows;
  /** Consent was withdrawn while a job was in flight: nothing further is processed, the stored transcript is discarded, no result is published.
   *  ONE transaction, locking the job row first and the transcript second: the same order as a host's revocation (meeting-ai.mjs), so the two can never deadlock. */
  async function stopForConsent(job, reason, event, stage) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); await lockWorkspace(c, job);
      await c.query(`UPDATE portal.meeting_ai_jobs SET status='cancelled', error_code=$3, error_message='Consent was withdrawn', lease_until=NULL, lease_token=NULL, finished_at=now() WHERE id=$1 AND lease_token=$2`, [job.id, job.lease_token, CODE[reason] || 'consent_revoked']);
      await c.query(`UPDATE portal.meeting_transcripts SET segments='[]'::jsonb, full_text='', purged_at=now(), purge_reason='participant_consent' WHERE job_id=$1 AND purged_at IS NULL`, [job.id]);
      await cAudit(c, job, event, { reason, stage });
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }

  async function process(job) {
    if (!(await activeConsents(pool, job))) { await finish(job, 'cancelled', 'consent_revoked', 'Consent is not active'); await cAudit(pool, job, 'processing_stopped', { reason: 'host_consent_revoked', stage: job.stage }); return; }
    const dir = (await pool.query('SELECT title, owner_user_id FROM public.portal_meeting_directory WHERE meet_uuid=$1', [job.meet_meeting_id])).rows[0] || {};

    if (job.stage === 'fetch') {
      const raw = await meet.fetchChatRaw(job.meet_meeting_id);          // retryable network/Meet errors bubble up
      const consent = await meet.fetchConsent(job.meet_meeting_id);      // so do these: without Meet's answer nothing is processed
      const d = applyParticipantConsent({ messages: raw.messages, consent });
      if (!d.requested) { await cAudit(pool, job, 'job_blocked', { reason: 'participant_consent_required' }); await finish(job, 'blocked', 'participant_consent_required', 'The host has not asked participants for Qorlla AI consent in this meeting'); return; }
      if (!d.included.length) { await cAudit(pool, job, 'job_blocked', { reason: 'no_consented_content', excluded: d.excluded }); await finish(job, 'blocked', 'no_consented_content', 'No participant has agreed to AI processing of their messages'); return; }
      let chat; try { chat = { title: raw.title, ...segmentsFromMeetChat(d.included) }; } catch (e) { e.retryable = false; throw e; }       // only consented content is ever turned into a transcript
      const r = await fenced(job, async (c) => {
        if (!(await activeConsents(c, job))) return 'consent_revoked';   // revoked while we were fetching: store nothing
        const t = await c.query(
          `INSERT INTO portal.meeting_transcripts(workspace_id,meet_meeting_id,job_id,source,speaker_labels,segments,full_text,content_sha256,created_by)
           VALUES($1,$2,$3,'meet_chat',$4,$5,$6,$7,$8) ON CONFLICT (job_id) DO NOTHING RETURNING id`,
          [job.workspace_id, job.meet_meeting_id, job.id, chat.speakerLabels, JSON.stringify(chat.segments), chat.fullText, crypto.createHash('sha256').update(chat.fullText).digest('hex'), job.requested_by]);
        const tid = t.rows[0]?.id || (await c.query('SELECT id FROM portal.meeting_transcripts WHERE job_id=$1', [job.id])).rows[0].id;
        for (const p of d.participants) await c.query('INSERT INTO portal.meeting_ai_job_participants(job_id,participant_id,transcription,summary,included,reason,transcription_seq,summary_seq) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING', [job.id, p.participant_id, p.transcription, p.summary, p.included, p.reason, p.transcription_seq, p.summary_seq]);
        await c.query('UPDATE portal.meeting_ai_jobs SET consent_revision=$2 WHERE id=$1', [job.id, consent.revision]);
        await cAudit(c, job, 'job_snapshot', { included_participants: d.participants.filter((p) => p.included).length, excluded: d.excluded, messages_used: d.included.length });
        await c.query(`UPDATE portal.meeting_ai_jobs SET transcript_id=$2, stage='summarize' WHERE id=$1`, [job.id, tid]);
        return 'ok';
      });
      if (r.lost) return;
      if (r.out === 'consent_revoked') { await finish(job, 'cancelled', 'consent_revoked', 'Consent was revoked'); return; }
      job.stage = 'summarize'; job.consent_revision = consent.revision;
    }

    if (job.stage === 'summarize') {
      if (!llm.available) { await finish(job, 'blocked', 'no_ai_provider', 'No AI provider is configured on this server'); return; }
      const t = (await pool.query('SELECT id, full_text, segments, purged_at FROM portal.meeting_transcripts WHERE job_id=$1', [job.id])).rows[0];
      if (!t || t.purged_at) { await finish(job, 'cancelled', 'consent_revoked', 'Transcript no longer available'); return; }
      // before ANY content goes to the gateway: every participant whose messages are in the transcript must still agree, and the host's request must still be open
      const pre = await participantCheck(job); if (!pre.ok) { await stopForConsent(job, pre.reason, 'processing_stopped', 'before_model'); return; }
      const res = await llm.summarize({ title: dir.title, transcript: t.full_text, ctx: { workspaceId: job.workspace_id, actorId: job.requested_by, feature: 'meeting_summary' } });
      // citations are made HERE, from the transcript we hold: each decision / action item points at the segments that really contain it (the model supplies no identifiers)
      const segs = Array.isArray(t.segments) ? t.segments : [];
      const refsFor = (statement) => groundStatement(statement, segs).map((i) => ({ ref: citations.sign({ ws: job.workspace_id, kind: 'meet_transcript', id: t.id, loc: { t: 'segment', i }, h: citations.mac(segs[i].text), label: `Meeting chat, message ${i + 1}` }), label: `Message ${i + 1}${clockLabel(segs[i]) ? ' at ' + clockLabel(segs[i]) : ''}` }));
      const cites = { decisions: res.report.decisions.map(refsFor), action_items: res.report.action_items.map((a) => ({ title: a.title, refs: refsFor(a.title) })) };
      const basis = basisFor({ source: job.source === 'transcript_import' ? 'transcript_import' : 'meet_chat', rows: await snapshotRows(pool, job), revision: job.consent_revision });
      const post = await participantCheck(job);                           // asked of Meet just before publishing, OUTSIDE any transaction (no lock is held while waiting on the network)
      if (!post.ok) { await stopForConsent(job, post.reason, 'result_discarded', 'before_publish'); return; }       // a participant withdrew while the model was working: nothing is published
      const done = await fenced(job, async (c) => {
        if (!(await activeConsents(c, job))) return 'consent_revoked';  // revoked during inference: discard the model output
        const plan = (await c.query('SELECT plan_slug FROM portal.workspace_effective_plan WHERE workspace_id=$1', [job.workspace_id])).rows[0]?.plan_slug || 'basic';
        let rep = (await c.query(
          `INSERT INTO portal.meeting_reports(workspace_id,external_meeting_id,meet_meeting_id,job_id,transcript_id,title,summary,decisions,topics,generated_by,created_by,host_user_id,citations,consent_basis)
           VALUES($1,$2,$12::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$13,$14) ON CONFLICT (job_id) DO NOTHING RETURNING id`,
          [job.workspace_id, job.meet_meeting_id, job.id, t.id, `Meeting report: ${dir.title || 'Meeting'}`.slice(0, 200), res.report.summary, JSON.stringify(res.report.decisions), JSON.stringify(res.report.topics), `llm:${res.model}`, job.requested_by, dir.owner_user_id || job.requested_by, job.meet_meeting_id, JSON.stringify(cites), JSON.stringify(basis)])).rows[0];
        const created = !!rep;
        if (!rep) rep = (await c.query('SELECT id FROM portal.meeting_reports WHERE job_id=$1', [job.id])).rows[0];
        if (created) for (const a of res.report.action_items) {
          await c.query(`INSERT INTO portal.meeting_action_items(workspace_id,report_id,title,owner_hint,due_hint,source,created_by) VALUES($1,$2,$3,$4,$5,'ai',$6)`, [job.workspace_id, rep.id, a.title, a.owner_hint, a.due_hint, job.requested_by]);
        }
        // accounting: keyed by job, so a retry after a crash can never double count
        if (overage) await overage.meter(c, job.workspace_id, 'meeting_report', `job:${job.id}:report`, { jobId: job.id, plan });
        for (const [feature, units, key] of [...(overage ? [] : [['meeting_report', 1, 'report']]), ['llm_input_tokens', res.inputTokens, 'in'], ['llm_output_tokens', res.outputTokens, 'out']]) {
          await c.query(`INSERT INTO portal.ai_usage_events(workspace_id,job_id,feature,units,idempotency_key,plan_slug) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`, [job.workspace_id, job.id, feature, units, `job:${job.id}:${key}`, plan]);
        }
        await c.query(`UPDATE portal.meeting_ai_jobs SET status='completed', stage='done', report_id=$2, error_code=NULL, error_message=NULL, lease_until=NULL, lease_token=NULL, finished_at=now() WHERE id=$1`, [job.id, rep.id]);
        await cAudit(c, job, 'result_published', { report_id: rep.id, cited_decisions: cites.decisions.filter((x) => x.length).length, cited_actions: cites.action_items.filter((x) => x.refs.length).length });
        return { ok: true, reportId: rep.id };
      });
      if (done.lost) return;
      if (done.out?.ok) {                                 // published. Verify ONCE MORE straight after the commit: if a person objected in the gap between the last check and the commit, withdraw now (every read re-checks anyway; if Meet cannot be reached here the reads fail closed)
        try { const after = checkFresh({ basis, consent: await meet.fetchConsent(job.meet_meeting_id) }); if (!after.ok) { await withdrawReport(pool, { workspaceId: job.workspace_id, reportId: done.out.reportId, reason: after.reason }); await cAudit(pool, job, 'result_discarded', { reason: after.reason, stage: 'after_commit' }); } }
        catch (e) { await cAudit(pool, job, 'consent_unverifiable', { stage: 'after_commit', code: e.code || 'error' }); }
      } else if (done.out === 'consent_revoked') { await cAudit(pool, job, 'result_discarded', { reason: 'host_consent_revoked' }); await finish(job, 'cancelled', 'consent_revoked', 'Consent was revoked'); }
      else if (String(done.out).startsWith('pc:')) await stopForConsent(job, String(done.out).slice(3), 'result_discarded', 'before_publish');
    }
  }

  async function fail(job, e) {
    const code = e.code || 'job_error'; const retryable = e.retryable === true;
    if (['no_ai_provider', 'consent_required', 'private_unavailable', 'ai_quota_exceeded'].includes(code)) return finish(job, 'blocked', code, e.message);   // the AI gateway refused (not authorised / no provider / quota): explicit, retryable by a person
    if (retryable && job.attempts < maxAttempts) {
      const delay = backoffBaseSeconds * 2 ** (job.attempts - 1);
      await pool.query(`UPDATE portal.meeting_ai_jobs SET status='queued', error_code=$3, error_message=$4, next_attempt_at=now()+($5::float8 * interval '1 second'), lease_until=NULL, lease_token=NULL WHERE id=$1 AND lease_token=$2`, [job.id, job.lease_token, code, safe(e.message), delay]);
      log?.warn('meeting-ai job will retry', { job_id: job.id, code, attempt: job.attempts, delay_s: delay });
      return;
    }
    log?.error('meeting-ai job failed', { job_id: job.id, code, attempts: job.attempts });
    return finish(job, 'failed', code, e.message);
  }

  /** @returns {Promise<boolean>} true if a job was processed (successfully or not) */
  async function runOne() {
    if (!(await isEnabled())) return false;                    // kill switch: jobs stay queued and resume when switched back on
    const job = await claim(); if (!job) return false;
    try { await process(job); } catch (e) { try { await fail(job, e); } catch (e2) { log?.error('could not record job failure', { job_id: job.id, err: e2.message }); } }
    return true;
  }
  /** Retention: transcript TEXT is deleted after `days` days (reports and their metadata stay). Returns how many were purged. */
  async function purgeExpired(days = retentionDays) {
    // transcripts of jobs that ended WITHOUT publishing (failed, cancelled, blocked) hold consented text for nothing: they go after a day, whatever the retention setting
    const stale = await pool.query(`UPDATE portal.meeting_transcripts t SET segments='[]'::jsonb, full_text='', purged_at=now(), purge_reason='job_not_published' FROM portal.meeting_ai_jobs j
      WHERE j.id=t.job_id AND j.status IN ('failed','cancelled','blocked') AND COALESCE(j.finished_at, j.created_at) < now() - interval '24 hours' AND t.purged_at IS NULL`);
    if (!(days > 0)) return stale.rowCount;
    const r = await pool.query(`UPDATE portal.meeting_transcripts SET segments='[]'::jsonb, full_text='', purged_at=now(), purge_reason='retention' WHERE purged_at IS NULL AND created_at < now() - ($1::int * interval '1 day')`, [days]);
    if (r.rowCount) log?.info('transcripts purged by retention policy', { count: r.rowCount, days });
    return r.rowCount + stale.rowCount;
  }
  let timer = null, stopped = false, lastPurge = 0;
  function start(intervalMs = 2000) {
    const tick = async () => { if (stopped) return; try { if (Date.now() - lastPurge > 3600_000) { lastPurge = Date.now(); await purgeExpired(); } while (await runOne()) { /* drain */ } } catch (e) { log?.error('ai worker tick failed', { err: e.message }); } timer = setTimeout(tick, intervalMs); timer.unref?.(); };
    timer = setTimeout(tick, 500); timer.unref?.();
  }
  const stop = () => { stopped = true; clearTimeout(timer); };
  return { runOne, claim, start, stop, purgeExpired };
}
