import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyDial,prepareCall} from '../src/dial-routing.mjs';
test('local national format stays internal',()=>assert.deepEqual(classifyDial('0808 590 9693'),{kind:'INTERNAL_LOOKUP',national:'08085909693'}));
test('plus format requests external',()=>assert.deepEqual(classifyDial('+1 302 444 1516'),{kind:'EXTERNAL_REQUEST',e164:'+13024441516'}));
test('00 prefix never silently becomes paid',()=>assert.equal(classifyDial('0044 745 667 0202').kind,'INVALID'));
test('bad plus input rejected',()=>assert.equal(classifyDial('+000').kind,'INVALID'));
test('suspended principal denied',async()=>assert.equal((await prepareCall({dial:'+13024441516',principal:{verified:true,suspended:true},services:{}})).status,'DENIED'));
test('PSTN disabled fails closed',async()=>assert.equal((await prepareCall({dial:'+13024441516',principal:{verified:true,suspended:false},services:{flags:{VOICE_PSTN_ENABLED:false}}})).reason,'PSTN_DISABLED'));
test('missing local account never falls back to external',async()=>{
 const result=await prepareCall({dial:'0808 590 9693',principal:{verified:true,verifiedCountry:'GB',tenantId:'t'},services:{lookupInternal:async()=>null}});
 assert.equal(result.status,'NOT_FOUND');
});
test('external returns quote but never connects or charges',async()=>{
 let charged=false;
 const result=await prepareCall({dial:'+13024441516',principal:{verified:true},services:{flags:{VOICE_PSTN_ENABLED:true},authorizeExternal:async()=>({allowed:true}),quoteExternal:async()=>({quoteId:'q1',expiresAt:'2099-01-01T00:00:00Z'}),charge:()=>{charged=true}}});
 assert.equal(result.status,'EXTERNAL_CONFIRMATION_REQUIRED');assert.equal(charged,false);
});
