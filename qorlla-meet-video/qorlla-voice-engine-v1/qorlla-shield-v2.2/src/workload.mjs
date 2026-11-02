import {timingSafeEqual} from 'node:crypto';
/** Identity MUST be derived from verified mTLS termination or SPIFFE verifier, never a client header. */
export function authorizeWorkload({verifiedIdentity,expectedIdentity,transportAuthenticated,operation,allowlist}) {
 if (!transportAuthenticated || typeof verifiedIdentity!=='string' || typeof expectedIdentity!=='string') return false;
 const a=Buffer.from(verifiedIdentity),b=Buffer.from(expectedIdentity);
 return a.length===b.length && timingSafeEqual(a,b) && Array.isArray(allowlist?.[verifiedIdentity]) && allowlist[verifiedIdentity].includes(operation);
}
