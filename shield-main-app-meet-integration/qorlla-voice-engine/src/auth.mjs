// Identity: verifies the short-lived token the Qorlla main app signs (JWKS, ES256/RS256, issuer and audience checked, subject required).
import { jwtVerify, createRemoteJWKSet } from 'jose';

/** Build a verifier from configuration. Returns a function (token) => account id, or one that always fails with auth_not_configured. */
export function makeAuthenticator(env = process.env, { jwks } = {}) {
  const keys = jwks || (env.VOICE_JWKS_URL ? createRemoteJWKSet(new URL(env.VOICE_JWKS_URL), { cooldownDuration: 10000, timeoutDuration: 5000 }) : null);
  const verify = async (token) => {
    if (!keys || !env.VOICE_JWT_ISSUER || !env.VOICE_JWT_AUDIENCE) throw new Error('auth_not_configured');
    if (typeof token !== 'string' || token.length < 20 || token.length > 4096) throw new Error('invalid_token');
    const { payload } = await jwtVerify(token, keys, { issuer: env.VOICE_JWT_ISSUER, audience: env.VOICE_JWT_AUDIENCE, algorithms: ['RS256', 'ES256'], clockTolerance: 5 });
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) throw new Error('invalid_subject');
    return payload;
  };
  const authenticate = async (token) => (await verify(token)).sub;
  authenticate.claims = verify;
  return authenticate;
}
export const authenticate = makeAuthenticator();
export const bearer = (req) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : null; };
