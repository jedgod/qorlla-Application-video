import {createHash, timingSafeEqual} from 'node:crypto';
export class Forbidden extends Error { constructor(message='Forbidden', status=403){super(message);this.status=status;} }
export const assert=(condition,message='Forbidden')=>{if(!condition)throw new Forbidden(message);};
export const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function constantTimeEqual(a,b){const x=Buffer.from(String(a));const y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);}
export function requireDependencies(deps,names){for(const name of names)if(!deps[name])throw new Error(`Missing required adapter: ${name}`);}
export function safeText(text,max=20000){assert(typeof text==='string'&&text.length<=max,'Invalid source');return text.replace(/[\u0000-\u001f]/g,' ').trim();}
