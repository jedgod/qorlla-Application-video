import {randomBytes,createHash} from 'node:crypto';
async function database(db){return db || (await import('./store.mjs')).pool;}
export const hashTicket = value => createHash('sha256').update(value).digest('hex');
export function originAllowed(origin,allowed=process.env.VOICE_ALLOWED_ORIGIN||'') {
 return typeof origin==='string' && allowed.split(',').map(x=>x.trim()).filter(Boolean).includes(origin);
}
export async function issueTicket(account,origin,db) {
 if(!originAllowed(origin)) throw Error('invalid_origin');
 const token=randomBytes(32).toString('base64url');
 await (await database(db)).query(`INSERT INTO voice_ws_tickets(token_hash,account_id,origin,expires_at)
 VALUES($1,$2,$3,now()+interval '45 seconds')`,[hashTicket(token),account,origin]);
 return {ticket:token,expiresIn:45};
}
export async function consumeTicket(token,origin,db) {
 if(typeof token!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(token)||!originAllowed(origin)) return null;
 const {rows}=await (await database(db)).query(`UPDATE voice_ws_tickets SET consumed_at=now()
 WHERE token_hash=$1 AND origin=$2 AND consumed_at IS NULL AND expires_at>now()
 RETURNING account_id`,[hashTicket(token),origin]);
 return rows[0]?.account_id||null;
}
export async function pruneTickets(db){
 await (await database(db)).query(`DELETE FROM voice_ws_tickets WHERE expires_at < now()-interval '1 hour'`);
}
