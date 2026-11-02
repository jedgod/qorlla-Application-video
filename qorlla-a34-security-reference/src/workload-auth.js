import { createHash, timingSafeEqual } from 'node:crypto';
import { refuse } from './errors.js';

// Terminate TLS at a trusted reverse proxy only if it strips all inbound identity headers.
// Prefer obtaining the peer certificate from the Node TLS socket on a direct mTLS listener.
export function certificateThumbprint(rawDer) {
  if (!Buffer.isBuffer(rawDer) || rawDer.length === 0) refuse('MTLS_CERT_REQUIRED', 401);
  return createHash('sha256').update(rawDer).digest('base64url');
}
export async function createWorkloadVerifier({ jwksUrl, issuer, audience, allowedIdentities }) {
  const { jwtVerify, createRemoteJWKSet } = await import('jose');
  if (!jwksUrl || !issuer || !audience || !allowedIdentities?.size) throw new Error('Missing verifier configuration');
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  return async ({ authorization, peerCertificateDer, requiredScope }) => {
    if (typeof authorization !== 'string' || !/^Bearer [^ ]+$/.test(authorization)) refuse('UNAUTHORIZED', 401);
    const thumbprint = certificateThumbprint(peerCertificateDer);
    let payload;
    try {
      ({ payload } = await jwtVerify(authorization.slice(7), jwks, {
        issuer, audience, algorithms: ['EdDSA'], requiredClaims: ['exp', 'iat', 'sub', 'cnf']
      }));
    } catch { refuse('UNAUTHORIZED', 401); }
    const expected = payload.cnf?.['x5t#S256'];
    if (typeof expected !== 'string') refuse('CERT_BINDING_REQUIRED', 401);
    const a = Buffer.from(expected); const b = Buffer.from(thumbprint);
    if (a.length !== b.length || !timingSafeEqual(a, b)) refuse('CERT_BINDING_MISMATCH', 401);
    const identity = allowedIdentities.get(payload.sub);
    if (!identity || !identity.scopes?.includes(requiredScope)) refuse('WORKLOAD_FORBIDDEN', 403);
    if (payload.iat > Math.floor(Date.now()/1000) + 30 || payload.exp - payload.iat > 300) refuse('TOKEN_LIFETIME_INVALID', 401);
    return { workloadId: payload.sub, scope: requiredScope };
  };
}
