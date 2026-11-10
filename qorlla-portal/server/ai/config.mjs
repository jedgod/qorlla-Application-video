// Qorlla AI Gateway configuration. ONE explicit contract per environment, never a single global switch:
//   isolated integration   QORLLA_AI_ENABLED=true  QORLLA_AI_PROVIDER=auto  QORLLA_AI_ALLOW_FREE_TIER=true  QORLLA_AI_ALLOW_PAID_FALLBACK=false  QORLLA_AI_TEST_ADAPTER_ENABLED=false
//   isolated automated     QORLLA_AI_ENABLED=true  QORLLA_AI_PROVIDER=test  QORLLA_AI_TEST_ADAPTER_ENABLED=true  QORLLA_ENVIRONMENT=test  QORLLA_AI_ALLOW_PAID_FALLBACK=false
//   production (default)   QORLLA_AI_ENABLED=false QORLLA_AI_PROVIDER=none  QORLLA_AI_TEST_ADAPTER_ENABLED=false
// Anything not stated is OFF. Provider credentials are read here, server side only, and are never returned, logged or sent to a browser.
// A provider's tier (free or paid) is declared by the operator (QORLLA_AI_<NAME>_TIER); a key cannot tell us which plan it is on, so an undeclared tier is treated as PAID.

export const PROVIDER_IDS = ['openai', 'gemini', 'xai', 'selfhosted', 'anthropic', 'test'];
// Aria AI is deliberately absent: it is added only after an officially supported API integration has been identified and verified.
export const BLOCKED_PROVIDERS = { aria: 'No officially supported Aria AI API integration has been identified and verified yet' };

const bool = (v) => String(v || '').trim().toLowerCase() === 'true';
const trim = (v) => String(v || '').trim();
const tier = (v) => (trim(v).toLowerCase() === 'free' ? 'free' : 'paid');

/** Environment identity. Production is the DEFAULT whenever NODE_ENV=production; "test" must be named explicitly. */
export function environmentOf(env = process.env) {
  const named = trim(env.QORLLA_ENVIRONMENT).toLowerCase();
  if (trim(env.NODE_ENV).toLowerCase() === 'production') return named === 'staging' ? 'staging' : 'production';
  return named || 'development';
}

export function resolveAiConfig(env = process.env) {
  const environment = environmentOf(env), production = environment === 'production';
  const problems = [];
  const enabled = bool(env.QORLLA_AI_ENABLED);
  const requested = (trim(env.QORLLA_AI_PROVIDER) || 'none').toLowerCase();
  const testAdapter = bool(env.QORLLA_AI_TEST_ADAPTER_ENABLED);
  const cfg = {
    environment, enabled: false, requested, allowFreeTier: bool(env.QORLLA_AI_ALLOW_FREE_TIER), allowPaidFallback: bool(env.QORLLA_AI_ALLOW_PAID_FALLBACK), testAdapter: false,
    timeoutMs: Number(env.QORLLA_AI_TIMEOUT_MS || 30_000), maxInputChars: Number(env.QORLLA_AI_MAX_INPUT_CHARS || 120_000),
    testAdapterDelayMs: Number(env.QORLLA_AI_TEST_ADAPTER_DELAY_MS || 0),          // only ever used by the labelled test adapter
    approved: new Set(trim(env.QORLLA_AI_APPROVED_PROVIDERS).toLowerCase().split(',').map((x) => x.trim()).filter(Boolean)),   // only providers whose credentials, quota, data handling and commercial terms were approved
    workspaceDailyRequests: Number(env.QORLLA_AI_WORKSPACE_DAILY_REQUESTS || 2000),
    ratePerMinute: Number(env.QORLLA_AI_RATE_PER_MINUTE || 30), breaker: { failures: Number(env.QORLLA_AI_BREAKER_FAILURES || 3), cooldownMs: Number(env.QORLLA_AI_BREAKER_COOLDOWN_MS || 30_000) },
    providers: {}, problems
  };
  // the deterministic test adapter exists only in an explicitly identified test environment, and the production configuration refuses it outright
  if (testAdapter || requested === 'test') {
    if (production) problems.push('QORLLA_AI_TEST_ADAPTER_ENABLED / QORLLA_AI_PROVIDER=test is refused in production');
    else if (environment !== 'test') problems.push('the test adapter needs QORLLA_ENVIRONMENT=test (an explicitly identified test environment)');
    else if (!testAdapter) problems.push('QORLLA_AI_PROVIDER=test needs QORLLA_AI_TEST_ADAPTER_ENABLED=true');
    else cfg.testAdapter = true;
  }
  if (!enabled || requested === 'none') return cfg;                       // OFF is the default and the production setting
  if (requested !== 'auto' && requested !== 'test' && !PROVIDER_IDS.includes(requested)) { problems.push('unknown QORLLA_AI_PROVIDER: ' + requested); return cfg; }
  cfg.enabled = true;
  const p = cfg.providers;
  const add = (id, o) => { if (o.apiKey) p[id] = o; };                   // a provider exists only when its key is set; default base URLs must not count
  add('openai', { apiKey: trim(env.QORLLA_AI_OPENAI_API_KEY), baseUrl: trim(env.QORLLA_AI_OPENAI_BASE_URL) || 'https://api.openai.com/v1', model: trim(env.QORLLA_AI_OPENAI_MODEL), tier: tier(env.QORLLA_AI_OPENAI_TIER), external: true });
  add('gemini', { apiKey: trim(env.QORLLA_AI_GEMINI_API_KEY), baseUrl: trim(env.QORLLA_AI_GEMINI_BASE_URL) || 'https://generativelanguage.googleapis.com/v1beta', model: trim(env.QORLLA_AI_GEMINI_MODEL), tier: tier(env.QORLLA_AI_GEMINI_TIER), external: true });
  add('xai', { apiKey: trim(env.QORLLA_AI_XAI_API_KEY), baseUrl: trim(env.QORLLA_AI_XAI_BASE_URL) || 'https://api.x.ai/v1', model: trim(env.QORLLA_AI_XAI_MODEL), tier: tier(env.QORLLA_AI_XAI_TIER), external: true });
  // a self-hosted open-weight model runs on infrastructure the operator controls: no per-call cost, and no data leaves it
  if (trim(env.QORLLA_AI_SELFHOSTED_URL)) p.selfhosted = { apiKey: trim(env.QORLLA_AI_SELFHOSTED_API_KEY), baseUrl: trim(env.QORLLA_AI_SELFHOSTED_URL), model: trim(env.QORLLA_AI_SELFHOSTED_MODEL), tier: 'local', external: false };
  if (p.selfhosted && bool(env.QORLLA_AI_SELFHOSTED_OLLAMA)) {
    p.selfhosted.ollama = true;
    p.selfhosted.allowedHosts = (trim(env.QORLLA_AI_OLLAMA_ALLOWED_HOSTS) || 'ollama,localhost,127.0.0.1').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
    p.selfhosted.concurrency = Number(env.QORLLA_AI_OLLAMA_CONCURRENCY || 2);
    p.selfhosted.maxQueue = Number(env.QORLLA_AI_OLLAMA_MAX_QUEUE || 8);
    if (!p.selfhosted.model) problems.push('QORLLA_AI_SELFHOSTED_MODEL is required for Ollama');
  }
  // the pre-gateway Anthropic path keeps working when its own key is set (compatibility), under the same rules as every other provider
  if (trim(env.AI_LLM_API_KEY)) p.anthropic = { apiKey: trim(env.AI_LLM_API_KEY), baseUrl: production ? 'https://api.anthropic.com' : (trim(env.AI_LLM_API_BASE) || 'https://api.anthropic.com'), model: trim(env.AI_LLM_MODEL) || 'claude-sonnet-5-5', tier: tier(env.QORLLA_AI_ANTHROPIC_TIER), external: true };
  for (const [id, o] of Object.entries(p)) if (id !== 'selfhosted' && !o.model && id !== 'anthropic') problems.push('QORLLA_AI_' + id.toUpperCase() + '_MODEL is required when a ' + id + ' key is configured');
  if (requested !== 'auto' && requested !== 'test' && !cfg.approved.has(requested)) problems.push('QORLLA_AI_PROVIDER=' + requested + ' is not in QORLLA_AI_APPROVED_PROVIDERS');
  if (requested !== 'auto' && requested !== 'test' && !p[requested]) problems.push('QORLLA_AI_PROVIDER=' + requested + ' but that provider has no credentials or URL');
  return cfg;
}

/** Which configured providers may be used at all under this configuration, in order of preference (local first, then free, then paid only if allowed). */
export function eligibleProviders(cfg) {
  const out = [];
  if (!cfg.enabled) return out;
  if (cfg.testAdapter && (cfg.requested === 'test' || cfg.requested === 'auto')) out.push({ id: 'test', tier: 'local', external: false });
  if (cfg.requested === 'test') return out;
  const rank = { local: 0, free: 1, paid: 2 };
  for (const [id, o] of Object.entries(cfg.providers)) {
    if (cfg.requested !== 'auto' && cfg.requested !== id) continue;
    if (!cfg.approved.has(id)) continue;                                  // configured but not approved: never used, never sent content
    if (o.tier === 'paid' && !cfg.allowPaidFallback) continue;          // paid use needs separate approval
    if (o.tier === 'free' && !cfg.allowFreeTier) continue;
    out.push({ id, ...o });
  }
  return out.sort((a, b) => (rank[a.tier] ?? 3) - (rank[b.tier] ?? 3));
}
