import {createRemoteJWKSet,jwtVerify} from 'jose';
const jwksUrl=process.env.QORLLA_JWKS_URL;
const JWKS=jwksUrl?createRemoteJWKSet(new URL(jwksUrl)):null;
export async function auth(req,res,next){
 try {
  if(!JWKS||!process.env.QORLLA_JWT_ISSUER||!process.env.QORLLA_JWT_AUDIENCE) throw Error('Authentication not configured');
  const match=/^Bearer (.+)$/.exec(req.get('authorization')||'');
  if(!match) return res.status(401).json({error:'Bearer token required'});
  const {payload}=await jwtVerify(match[1],JWKS,{issuer:process.env.QORLLA_JWT_ISSUER,audience:process.env.QORLLA_JWT_AUDIENCE});
  if(typeof payload.sub!=='string'||!payload.sub) return res.status(401).json({error:'Missing subject'});
  req.actor=payload.sub; next();
 }catch(e){res.status(401).json({error:'Unauthorized'});}
}
export {hostRole,editorRole} from './roles.mjs';
