// Meeting-AI job runner: leased queue (FOR UPDATE SKIP LOCKED), stage checkpoints, fenced writes, bounded retries with backoff.
// Every side effect is idempotent: transcripts are UNIQUE(job_id), reports UNIQUE(job_id), usage events UNIQUE(workspace, key).
// Consent is re-checked at every stage; a revoked consent cancels the job and nothing further is stored or sent to the model.
import crypto from 'node:crypto';

const CONSENT_SCOPES = ['transcription', 'summary'];
const safe = (s, n = 300) => String(s || '').replace(/[\u0000-\u001F]/g, ' ').slice(0, n);

export function createAiWorker({ pool, llm, meet, log, overage = null, isEnabled = async () => true, leaseSeconds = 120, maxAttempts = 5, backoffBaseSeconds = 15, retentionDays = 0 }) {
  async function activeConsents(db, job) {
    const r = await db.query(`SELECT scope FROM portal.meeting_ai_consents WHERE workspace_id=$1 AND meet_meeting_id=$2 AND revoked_at IS NULL AND scope = ANY($3)`, [job.workspace_id, job.meet_meeting_id, CONSENT_SCOPES]);
    return CONSENT_SCOPES.every((s) => r.rows.some((x) => x.scope === s));
  }
  async function claim() {
    const token = crypto.randomUUID();
    const r = await pool.query(
      `UPDATE portal.meeting_ai_jobs j SET status='running', lease_token=$1, lease_until=now()+($2::float8 * interval '1 second'), attempts=j.attempts+1, started_at=COALESCE(j.started_at,now())
       WHERE j.id = (SELECT id FROM portal.meeting_ai_jobs WHERE (status='queued' AND next_attempt_at<=now()) OR (status='running' AND lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING j.*`, [token, leaseSeconds]);
    return r.rows[0] || null;
  }
  const finish = (job, status, code, message) => pool.query(
    `UPDATE portal.meeting_ai_jobs SET status=$3, error_code=$4, error_message=$5, lease_until=NULL, lease_token=NULL, finished_at=CASE WHEN $3 IN ('completed','failed','cancelled') THEN now() ELSE finished_at END
     WHERE id=$1 AND lease_token=$2`, [job.id, job.lease_token, status, code || null, message ? safe(message) : null]);

  /** Runs `fn(client)` inside a transaction that holds the job row, but only if this worker still owns the lease. */
  async function fenced(job, fn) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const cur = (await c.query('SELECT status, lease_token FROM portal.meeting_ai_jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
      if (!cur || cur.lease_token !== job.lease_token || cur.status !== 'running') { await c.query('ROLLBACK'); return { lost: true }; }
      const out = await fn(c); await c.query('COMMIT'); return { out };
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }

  async function process(job) {
    if (!(await activeConsents(pool, job))) { await finish(job, 'cancelled', 'consent_revoked', 'Consent is not active'); return; }
    const dir = (await pool.query('SELECT title, owner_user_id FROM public.portal_meeting_directory WHERE meet_uuid=$1', [job.meet_meeting_id])).rows[0] || {};

    if (job.stage === 'fetch') {
      const chat = await meet.fetchChat(job.meet_meeting_id);            // retryable network/Meet errors bubble up
      const r = await fenced(job, async (c) => {
        if (!(await activeConsents(c, job))) return 'consent_revoked';   // revoked while we were fetching: store nothing
        const t = await c.query(
          `INSERT INTO portal.meeting_transcripts(workspace_id,meet_meeting_id,job_id,source,speaker_labels,segments,full_text,content_sha256,created_by)
           VALUES($1,$2,$3,'meet_chat',$4,$5,$6,$7,$8) ON CONFLICT (job_id) DO NOTHING RETURNING id`,
          [job.workspace_id, job.meet_meeting_id, job.id, chat.speakerLabels, JSON.stringify(chat.segments), chat.fullText, crypto.createHash('sha256').update(chat.fullText).digest('hex'), job.requested_by]);
        const tid = t.rows[0]?.id || (await c.query('SELECT id FROM portal.meeting_transcripts WHERE job_id=$1', [job.id])).rows[0].id;
        await c.query(`UPDATE portal.meeting_ai_jobs SET transcript_id=$2, stage='summarize' WHERE id=$1`, [job.id, tid]);
        return 'ok';
      });
      if (r.lost) return;
      if (r.out === 'consent_revoked') { await finish(job, 'cancelled', 'consent_revoked', 'Consent was revoked'); return; }
      job.stage = 'summarize';
    }

    if (job.stage === 'summarize') {
      if (!llm.available) { await finish(job, 'blocked', 'no_ai_provider', 'No AI provider is configured on this server'); return; }
      const t = (await pool.query('SELECT id, full_text, purged_at FROM portal.meeting_transcripts WHERE job_id=$1', [job.id])).rows[0];
      if (!t || t.purged_at) { await finish(job, 'cancelled', 'consent_revoked', 'Transcript no longer available'); return; }
      const res = await llm.summarize({ title: dir.title, transcript: t.full_text });
      const done = await fenced(job, async (c) => {
        if (!(await activeConsents(c, job))) return 'consent_revoked';  // revoked during inference: discard the model output
        const plan = (await c.query('SELECT plan_slug FROM portal.workspace_effective_plan WHERE workspace_id=$1', [job.workspace_id])).rows[0]?.plan_slug || 'basic';
        let rep = (await c.query(
          `INSERT INTO portal.meeting_reports(workspace_id,external_meeting_id,meet_meeting_id,job_id,transcript_id,title,summary,decisions,topics,generated_by,created_by,host_user_id)
           VALUES($1,$2,$12::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (job_id) DO NOTHING RETURNING id`,
          [job.workspace_id, job.meet_meeting_id, job.id, t.id, `Meeting report: ${dir.title || 'Meeting'}`.slice(0, 200), res.report.summary, JSON.stringify(res.report.decisions), JSON.stringify(res.report.topics), `llm:${res.model}`, job.requested_by, dir.owner_user_id || job.requested_by, job.meet_meeting_id])).rows[0];
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
        return 'ok';
      });
      if (done.lost) return;
      if (done.out === 'consent_revoked') await finish(job, 'cancelled', 'consent_revoked', 'Consent was revoked');
    }
  }

  async function fail(job, e) {
    const code = e.code || 'job_error'; const retryable = e.retryable === true;
    if (code === 'no_ai_provider') return finish(job, 'blocked', code, e.message);
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
    if (!(days > 0)) return 0;
    const r = await pool.query(`UPDATE portal.meeting_transcripts SET segments='[]'::jsonb, full_text='', purged_at=now(), purge_reason='retention' WHERE purged_at IS NULL AND created_at < now() - ($1::int * interval '1 day')`, [days]);
    if (r.rowCount) log?.info('transcripts purged by retention policy', { count: r.rowCount, days });
    return r.rowCount;
  }
  let timer = null, stopped = false, lastPurge = 0;
  function start(intervalMs = 2000) {
    const tick = async () => { if (stopped) return; try { if (Date.now() - lastPurge > 3600_000) { lastPurge = Date.now(); await purgeExpired(); } while (await runOne()) { /* drain */ } } catch (e) { log?.error('ai worker tick failed', { err: e.message }); } timer = setTimeout(tick, intervalMs); timer.unref?.(); };
    timer = setTimeout(tick, 500); timer.unref?.();
  }
  const stop = () => { stopped = true; clearTimeout(timer); };
  return { runOne, claim, start, stop, purgeExpired };
}
