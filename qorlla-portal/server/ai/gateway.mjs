// Qorlla AI Gateway: the ONE server-side door to every language model. Features (Docs, Sheets, Slides, QorllaMate, Meet, Clips) call this, never a provider.
// It has the same small interface as the pre-gateway client (available, generateJson, summarize), so existing features keep working, and adds:
//   - capability-ordered provider selection and automatic failover (local first, then free; paid only when separately allowed),
//   - a circuit breaker and a timeout per provider, and a per-person request limit,
//   - an external-processing check per workspace: content leaves the platform ONLY for a workspace that authorised it; otherwise only local providers are used,
//   - an audit record per request (who, which feature, which provider, how long, how many tokens, a short hash): never the prompt or the answer,
//   - one public identity: callers and users only ever see "Qorlla AI" and the model name "qorlla-ai". Real provider and model names go to the audit trail and the administrator status only.
import crypto from 'node:crypto';
import { LlmError, ReportSchema, SYSTEM as SUMMARY_SYSTEM } from './llm.mjs';
import { BLOCKED_PROVIDERS, eligibleProviders } from './config.mjs';
import { buildAdapters } from './providers.mjs';

export const PUBLIC_NAME = 'Qorlla AI', PUBLIC_MODEL = 'qorlla-ai';
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

export function createAiGateway({ config, fetchImpl = fetch, now = Date.now, log = console, audit = async () => {}, consent = async () => false, quota = async () => true, adapters } = {}) {
  if (!config) throw new Error('AI gateway needs a configuration');
  if (config.problems.length) throw new Error('AI configuration refused: ' + config.problems.join('; '));      // fail closed: a bad AI configuration stops the server from starting
  const eligible = eligibleProviders(config);
  const list = adapters || buildAdapters(eligible, { fetchImpl, timeoutMs: config.timeoutMs, testDelayMs: config.testAdapterDelayMs });
  const state = new Map(list.map((a) => [a.id, { failures: 0, openUntil: 0, lastCode: null, ok: 0, failed: 0 }]));
  const windows = new Map();                                                                      // per-person sliding window for the request limit
  const maxInputChars = config.maxInputChars;

  const limited = (key) => {
    const t = now(), w = (windows.get(key) || []).filter((x) => t - x < 60_000);
    if (w.length >= config.ratePerMinute) { windows.set(key, w); return true; }
    w.push(t); windows.set(key, w); return false;
  };
  const record = async (ctx, a, outcome, o = {}) => {
    try { await audit({ at: new Date(now()).toISOString(), feature: ctx.feature || 'unknown', actorId: ctx.actorId || null, workspaceId: ctx.workspaceId || null, orgId: ctx.orgId || null, provider: a ? a.id : null, tier: a ? a.tier : null, model: o.model || (a && a.model) || null, outcome, code: o.code || null, ms: o.ms || 0, inputChars: o.inputChars || 0, outputChars: o.outputChars || 0, inputTokens: o.inputTokens || 0, outputTokens: o.outputTokens || 0, promptHash: o.promptHash || null }); }
    catch (e) { log.error && log.error('ai audit failed', { err: e && e.message }); }
  };

  async function generateJson({ system, user, schema, maxTokens = 3000, ctx = {}, signal }) {
    if (signal && signal.aborted) throw new LlmError('Request cancelled', { retryable: false, code: 'llm_cancelled' });
    if (!list.length) throw new LlmError('No AI provider is configured', { code: 'no_ai_provider' });
    if (limited(ctx.actorId || 'anonymous')) { await record(ctx, null, 'rate_limited', { code: 'ai_rate_limited' }); throw new LlmError(PUBLIC_NAME + ' is busy. Try again in a minute.', { retryable: false, code: 'ai_rate_limited' }); }
    if (!(await quota(ctx))) { await record(ctx, null, 'quota_exceeded', { code: 'ai_quota_exceeded' }); throw new LlmError('This workspace has reached its ' + PUBLIC_NAME + ' limit for today. It resets tomorrow.', { retryable: false, code: 'ai_quota_exceeded' }); }
    const t = now(); let candidates = list.filter((a) => (state.get(a.id).openUntil || 0) <= t);
    // content leaves the platform only for a workspace that authorised external processing
    let externalOk = ctx.externalProcessing; if (externalOk === undefined) externalOk = ctx.workspaceId ? await consent(ctx) : false;
    if (!externalOk) { const before = candidates.length; candidates = candidates.filter((a) => !a.external); if (!candidates.length && before) { await record(ctx, null, 'consent_required', { code: 'consent_required' }); throw new LlmError('This workspace has not authorised external AI processing. A workspace owner can turn it on in the AI settings.', { code: 'consent_required' }); } }
    if (ctx.profile === 'private') { candidates = candidates.filter((a) => !a.external); if (!candidates.length) { await record(ctx, null, 'unavailable', { code: 'private_unavailable' }); throw new LlmError('The private ' + PUBLIC_NAME + ' model is not available on this server', { code: 'private_unavailable' }); } }
    if (!candidates.length) { await record(ctx, null, 'unavailable', { code: 'ai_unavailable' }); throw new LlmError(PUBLIC_NAME + ' is temporarily unavailable', { retryable: true, code: 'ai_unavailable' }); }
    const promptHash = hash(system + '\u0000' + user); let last = null;
    for (const a of candidates) {
      const st = state.get(a.id), t0 = now(); let r;
      try {
        r = await a.call({ system, user, maxTokens, signal });
        let parsed; try { parsed = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)); } catch { throw Object.assign(new LlmError(PUBLIC_NAME + ' returned unreadable output', { retryable: true, code: 'invalid_model_output' }), { provider: a.id }); }
        const v = schema.safeParse(parsed); if (!v.success) throw Object.assign(new LlmError(PUBLIC_NAME + ' output did not match the required format', { retryable: true, code: 'invalid_model_output' }), { provider: a.id });
        st.failures = 0; st.ok++; st.lastCode = null;
        await record(ctx, a, 'ok', { ms: now() - t0, model: r.model, inputChars: (system + user).length, outputChars: r.text.length, inputTokens: r.inputTokens, outputTokens: r.outputTokens, promptHash });
        return { data: v.data, model: PUBLIC_MODEL, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
      } catch (e) {
        const code = (e && e.code) || 'llm_error';
        if (code === 'llm_cancelled' || (signal && signal.aborted)) { await record(ctx, a, 'error', { code: 'llm_cancelled', ms: now() - t0, inputChars: (system + user).length, promptHash }); throw new LlmError('Request cancelled', { retryable: false, code: 'llm_cancelled' }); }   // the person went away: not a provider failure, no failover, no breaker
        st.failed++; st.lastCode = code;
        if (code !== 'invalid_model_output') { st.failures++; if (st.failures >= config.breaker.failures) st.openUntil = now() + config.breaker.cooldownMs; }     // unreadable output is a content problem, not an outage: it must not shut the only provider off
        await record(ctx, a, 'error', { code, ms: now() - t0, inputChars: (system + user).length, promptHash });
        last = e; if (e instanceof LlmError && !e.retryable) throw new LlmError(PUBLIC_NAME + ' could not process this request', { retryable: false, code: e.code, status: e.status });
      }
    }
    throw new LlmError(PUBLIC_NAME + ' is temporarily unavailable', { retryable: true, code: (last && last.code) === 'invalid_model_output' ? 'invalid_model_output' : 'ai_unavailable' });
  }

  async function summarize({ title, transcript, ctx = {} }) {
    const truncated = transcript.length > maxInputChars;
    const user = `Meeting title (data): ${JSON.stringify(String(title || '').slice(0, 200))}\n${truncated ? 'NOTE: the transcript was truncated to fit; say so in the summary.\n' : ''}<transcript>\n${truncated ? transcript.slice(0, maxInputChars) : transcript}\n</transcript>`;
    const r = await generateJson({ system: SUMMARY_SYSTEM, user, schema: ReportSchema, ctx: { feature: 'meeting_summary', ...ctx } });
    return { report: r.data, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, truncated };
  }

  /** For administrators only: real provider names, tiers and health. Never returned to workspace users. */
  const adminStatus = () => ({
    environment: config.environment, enabled: config.enabled, mode: config.requested, allowFreeTier: config.allowFreeTier, allowPaidFallback: config.allowPaidFallback, testAdapter: config.testAdapter,
    providers: list.map((a) => { const s = state.get(a.id); return { id: a.id, tier: a.tier, external: a.external, model: a.model || null, healthy: (s.openUntil || 0) <= now(), consecutiveFailures: s.failures, ok: s.ok, failed: s.failed, lastErrorCode: s.lastCode }; }),
    configuredNotApproved: Object.keys(config.providers).filter((id) => !config.approved.has(id)),
    blocked: Object.entries(BLOCKED_PROVIDERS).map(([id, reason]) => ({ id, reason }))
  });
  /** The choices a workspace user may pick: Qorlla profiles, never a vendor. "private" keeps content on infrastructure the operator controls. */
  const models = () => [{ id: PUBLIC_MODEL, name: PUBLIC_NAME, description: 'Automatic: the best available option', available: list.length > 0 }, { id: 'qorlla-ai-private', name: PUBLIC_NAME + ' Private', description: 'Runs only on Qorlla-controlled infrastructure; content never leaves it', available: list.some((a) => !a.external) }];
  /** What a workspace user may see: the product name and whether it can answer. */
  const publicStatus = () => ({ assistant: PUBLIC_NAME, available: list.length > 0 });
  return { available: list.length > 0, provider: 'qorlla', model: PUBLIC_MODEL, maxInputChars, generateJson, summarize, adminStatus, publicStatus, models, name: PUBLIC_NAME };
}
