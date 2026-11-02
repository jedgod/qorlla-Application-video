export const extensionPattern = /^[0-9]{3,8}$/;
export function assertDeployment(env = process.env) {
  for (const key of ['VOICE_PSTN_ENABLED','VOICE_NUMBERS_ENABLED']) {
    if (env[key] === 'true') throw new Error(`${key} forbidden in internal-only deployment`);
  }
  if (env.VOICE_INTERNAL_CALLS_ENABLED !== 'true') throw new Error('Internal calling must be explicitly enabled');
  if (env.VOICE_MEDIA_POLICY !== 'relay') throw new Error('Relay-only media required for revocable voice');
}
export function classifyDestination(value) {
  if (typeof value !== 'string') return { ok:false, code:'INVALID_EXTENSION' };
  if (value.startsWith('+')) return { ok:false, code:'PSTN_NOT_SUPPORTED' };
  if (!extensionPattern.test(value)) return { ok:false, code:'INVALID_EXTENSION' };
  return { ok:true, extension:value };
}
export function requirePrincipal(p) {
  if (!p || p.kind === 'guest' || !p.accountId || !p.tenantId || !p.verified || p.suspended) throw Object.assign(new Error('VOICE_FORBIDDEN'), { statusCode:403 });
  return p;
}
export function requireScope(identity, scope) {
  if (!identity?.scopes?.includes(scope)) throw Object.assign(new Error('FORBIDDEN'), { statusCode:403 });
}
