import test from 'node:test';import assert from 'node:assert/strict';
import {hashTicket,originAllowed,issueTicket,consumeTicket} from '../src/tickets.mjs';
const origin='https://app.qorlla.test';
test('origin allowlist uses exact match',()=>{
 assert.equal(originAllowed(origin,origin),true);
 assert.equal(originAllowed('https://app.qorlla.test.evil',origin),false);
});
test('ticket hash is deterministic but not the token',()=>{
 assert.equal(hashTicket('abc'),hashTicket('abc'));
 assert.notEqual(hashTicket('abc'),'abc');
});
test('ticket is random and DB receives hash only',async()=>{
 let params;const db={query:async(_sql,p)=>{params=p;return {rows:[]}}};
 process.env.VOICE_ALLOWED_ORIGIN=origin;
 const {ticket,expiresIn}=await issueTicket('alice',origin,db);
 assert.equal(expiresIn,45);assert.match(ticket,/^[A-Za-z0-9_-]{43}$/);
 assert.equal(params[0],hashTicket(ticket));assert.equal(params[1],'alice');
});
test('consume rejects malformed and mismatched origin before DB',async()=>{
 process.env.VOICE_ALLOWED_ORIGIN=origin;
 const db={query:async()=>{throw Error('must not query')}};
 assert.equal(await consumeTicket('bad',origin,db),null);
 assert.equal(await consumeTicket('A'.repeat(43),'https://evil.test',db),null);
});
test('atomic consume returns account only when DB returns one row',async()=>{
 process.env.VOICE_ALLOWED_ORIGIN=origin;
 const db={query:async(sql,params)=>{assert.match(sql,/consumed_at IS NULL/);assert.equal(params[1],origin);return {rows:[{account_id:'alice'}]}}};
 assert.equal(await consumeTicket('A'.repeat(43),origin,db),'alice');
});
