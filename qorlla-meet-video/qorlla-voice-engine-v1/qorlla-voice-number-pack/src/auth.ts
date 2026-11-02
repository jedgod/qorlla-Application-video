import {createRemoteJWKSet,jwtVerify} from 'jose';
import {config} from './config.js';
const jwks=createRemoteJWKSet(new URL(config.JWKS_URL));
export async function authenticate(header?:string){
 const token=header?.match(/^Bearer (\S+)$/)?.[1]; if(!token) throw new Error('UNAUTHORIZED');
 const {payload}=await jwtVerify(token,jwks,{issuer:config.JWT_ISSUER,audience:config.JWT_AUDIENCE,algorithms:['RS256','ES256']});
 if(typeof payload.sub!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.sub)) throw new Error('UNAUTHORIZED');
 return {userId:payload.sub,scopes:typeof payload.scope==='string'?payload.scope.split(' '):[]};
}
