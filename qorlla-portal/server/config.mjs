// Environment parsing for the portal. Nothing here ever supplies a development identity: when authentication is not fully
// configured the private API answers 503 (fail closed) instead of guessing who the caller is.
export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const trim = (v) => (v == null ? '' : String(v).trim());
  const origin = trim(env.PORTAL_ALLOWED_ORIGIN).replace(/\/+$/, '');
  const cfg = {
    production,
    port: Number(env.PORT || 5500),
    databaseUrl: trim(env.DATABASE_URL),
    origin,
    trustProxyHops: Number(env.TRUST_PROXY_HOPS || (production ? 1 : 0)) || false,
    issuer: trim(env.MAIN_AUTH_ISSUER),
    audience: trim(env.PORTAL_AUTH_AUDIENCE) || 'qorlla-workplace',
    jwksUrl: trim(env.MAIN_AUTH_JWKS_URL),
    introspectionUrl: trim(env.MAIN_INTROSPECTION_URL).replace(/\/+$/, ''),
    introspectionSecret: trim(env.PORTAL_INTROSPECTION_SECRET),
    // In production a stolen cookie must die at logout, so the introspection check is mandatory unless explicitly waived.
    requireIntrospection: env.AUTH_REQUIRE_INTROSPECTION != null ? env.AUTH_REQUIRE_INTROSPECTION === 'true' : production,
    salesIpPepper: trim(env.SALES_IP_PEPPER) || 'dev-pepper',
    billing: {
      enabled: env.BILLING_ENABLED === 'true',
      provider: 'stripe',
      secretKey: trim(env.STRIPE_SECRET_KEY),
      webhookSecret: trim(env.STRIPE_WEBHOOK_SECRET),
      // A non-default API base exists only so tests can point at a local test double; it is refused in production.
      apiBase: production ? 'https://api.stripe.com' : (trim(env.STRIPE_API_BASE) || 'https://api.stripe.com'),
      liveAuthorization: trim(env.BILLING_LIVE_AUTHORIZED),
      successPath: trim(env.BILLING_SUCCESS_PATH) || '/app/billing?checkout=success',
      cancelPath: trim(env.BILLING_CANCEL_PATH) || '/pricing/?checkout=cancelled',
      maxSeats: 1000
    }
  };
  const authProblems = [];
  if (!cfg.issuer) authProblems.push('MAIN_AUTH_ISSUER');
  if (!cfg.jwksUrl) authProblems.push('MAIN_AUTH_JWKS_URL');
  if (!cfg.origin) authProblems.push('PORTAL_ALLOWED_ORIGIN');
  if (cfg.requireIntrospection && (!cfg.introspectionUrl || cfg.introspectionSecret.length < 32)) authProblems.push('MAIN_INTROSPECTION_URL + PORTAL_INTROSPECTION_SECRET (>=32 chars)');
  const aiKey = trim(env.AI_LLM_API_KEY);
  cfg.ai = {
    workerEnabled: env.AI_WORKER_ENABLED !== 'false',
    llm: { provider: 'anthropic', apiKey: aiKey, model: trim(env.AI_LLM_MODEL) || 'claude-sonnet-5-5',
      // like the payment API base: a non-default endpoint exists only so tests can use a local test double, and is refused in production
      apiBase: production ? 'https://api.anthropic.com' : (trim(env.AI_LLM_API_BASE) || 'https://api.anthropic.com'), maxInputChars: Number(env.AI_LLM_MAX_INPUT_CHARS || 120000) },
    meetBaseUrl: trim(env.MEET_INTERNAL_URL), meetReadSecret: trim(env.MEET_READ_SECRET),
    directoryUrl: trim(env.MAIN_DIRECTORY_URL) || (cfg.introspectionUrl ? cfg.introspectionUrl.replace(/\/session$/, '/users') : ''),
    transcriptRetentionDays: Number(env.AI_TRANSCRIPT_RETENTION_DAYS || 90)
  };
  cfg.telephony = {
    enabled: env.TELEPHONY_ENABLED === 'true',
    accountSid: trim(env.TWILIO_ACCOUNT_SID), authToken: trim(env.TWILIO_AUTH_TOKEN),
    apiKeySid: trim(env.TWILIO_API_KEY_SID), apiKeySecret: trim(env.TWILIO_API_KEY_SECRET), twimlAppSid: trim(env.TWILIO_TWIML_APP_SID),
    // like the payment/LLM bases: a non-default endpoint exists only so tests can use a local test double, and is refused in production
    apiBase: production ? 'https://api.twilio.com' : (trim(env.TWILIO_API_BASE) || 'https://api.twilio.com'),
    complianceAck: trim(env.TELEPHONY_COMPLIANCE_ACK), allowInternational: env.TELEPHONY_ALLOW_INTERNATIONAL === 'true'
  };
  cfg.platformAdmins = String(env.PLATFORM_ADMIN_USER_IDS || '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => /^[0-9a-f-]{36}$/.test(x));
  // Enterprise operations (Admin / Staff / Support). OFF unless OPS_ENABLED is exactly "true". In production MFA for admins and two-person refunds cannot be waived.
  const exact = (v) => v === 'true';
  let approvedRanges = {}; try { const j = JSON.parse(env.OPS_APPROVED_NUMBER_RANGES || '{}'); if (j && typeof j === 'object' && !Array.isArray(j)) approvedRanges = Object.fromEntries(Object.entries(j).filter(([k, v]) => /^[A-Z]{2}$/.test(k) && Array.isArray(v)).map(([k, v]) => [k, v.filter((p) => /^[0-9]{4,8}$/.test(String(p))).map(String)])); } catch { /* malformed: no range is approved */ }
  cfg.ops = {
    enabled: exact(env.OPS_ENABLED),
    requireMfa: production ? true : env.OPS_ADMIN_REQUIRE_MFA !== 'false', mfaMaxAgeSeconds: Number(env.OPS_MFA_MAX_AGE_SECONDS || 900) || 900,
    refundTwoPerson: production ? true : env.OPS_REFUND_TWO_PERSON != null ? exact(env.OPS_REFUND_TWO_PERSON) : false,
    workerEnabled: exact(env.OPS_WORKER_ENABLED), approvedRanges,
    // release gates, reported to Admin exactly as configured (only the exact value "true" is on); the portal never turns any of them on
    gates: { pstn: exact(env.VOICE_PSTN_ENABLED) || exact(env.PSTN_ENABLED), numbers: exact(env.VOICE_NUMBERS_ENABLED), countryAlias: exact(env.VOICE_COUNTRY_ALIAS_ENABLED), a38: exact(env.VOICE_A38_ENABLED) }
  };
  cfg.metricsToken =trim(env.METRICS_TOKEN).length >= 24 ? trim(env.METRICS_TOKEN) : '';   // shorter tokens are ignored: the endpoint then stays off
  cfg.authProblems = authProblems;
  cfg.authConfigured = authProblems.length === 0;

  const b = cfg.billing; const reasons = [];
  if (!b.enabled) reasons.push('billing_disabled');
  else {
    if (!b.secretKey) reasons.push('missing_secret_key');
    if (!b.webhookSecret) reasons.push('missing_webhook_secret');
    // Explicit, separate authorization is required before a LIVE key can collect real money.
    if (/^(sk|rk)_live_/.test(b.secretKey) && b.liveAuthorization !== 'yes-i-authorize-real-payments') reasons.push('live_key_not_authorized');
  }
  b.unavailableReasons = reasons;
  b.available = reasons.length === 0;
  return cfg;
}
