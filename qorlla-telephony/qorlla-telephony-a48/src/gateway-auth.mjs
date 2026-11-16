import {createHmac,timingSafeEqual,createHash} from 'node:crypto';
import {PolicyError} from './policy.mjs';
export const digest = bytes=>createHash('sha256').update(bytes).digest('hex');
export function signGateway({method,path,timestamp,nonce,body,secret}) {
 const message=[method.toUpperCase(),path,String(timestamp),nonce,digest(body)].join('\n');
 return createHmac('sha256',secret).update(message).digest('hex');
}
export function verifyGateway({method,path,headers,body,secret,now=Date.now()}) {
 if(!secret || Buffer.byteLength(secret)<32)throw new Error('Gateway secret must be >=32 bytes');
 const ts=Number(headers['x-qorlla-timestamp']);const nonce=headers['x-qorlla-nonce'];
 const signature=headers['x-qorlla-signature'];
 if(!Number.isSafeInteger(ts)||Math.abs(now-ts)>60000||typeof nonce!=='string'||!/^[a-zA-Z0-9_-]{16,128}$/.test(nonce)||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature))throw new PolicyError('GATEWAY_AUTH_FAILED',401);
 const expected=signGateway({method,path,timestamp:ts,nonce,body,secret});
 if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex')))throw new PolicyError('GATEWAY_AUTH_FAILED',401);
 return {nonce,ts};
}
