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
