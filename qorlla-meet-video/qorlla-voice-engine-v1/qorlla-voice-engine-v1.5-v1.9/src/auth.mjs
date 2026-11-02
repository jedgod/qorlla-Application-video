import {jwtVerify, createRemoteJWKSet} from 'jose';
const jwks = process.env.VOICE_JWKS_URL ? createRemoteJWKSet(new URL(process.env.VOICE_JWKS_URL)) : null;
export async function authenticate(token) {
 if (!jwks || !process.env.VOICE_JWT_ISSUER || !process.env.VOICE_JWT_AUDIENCE) throw new Error('auth_not_configured');
 const {payload} = await jwtVerify(token,jwks,{issuer:process.env.VOICE_JWT_ISSUER,audience:process.env.VOICE_JWT_AUDIENCE,algorithms:['RS256','ES256']});
 if(typeof payload.sub!=='string'||!payload.sub) throw new Error('invalid_subject');
 return payload.sub;
}
export function bearer(req){const h=req.headers.authorization||'';return h.startsWith('Bearer ')?h.slice(7):null;}
