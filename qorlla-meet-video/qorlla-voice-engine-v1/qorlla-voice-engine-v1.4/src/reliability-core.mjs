export const MAX_REPLAY=200;
export function safeCursor(n){return typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=Number.MAX_SAFE_INTEGER;}
export function backoff(attempt){return Math.min(300000,1000*Math.pow(2,Math.min(8,Math.max(0,attempt-1))));}
export function safeEvent(kind,payload){return ['incoming','state','device_revoked','device_claimed'].includes(kind)&&payload&&typeof payload==='object'&&JSON.stringify(payload).length<=32000;}
