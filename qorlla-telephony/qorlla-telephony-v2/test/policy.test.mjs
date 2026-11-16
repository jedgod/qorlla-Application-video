import test from 'node:test';import assert from 'node:assert/strict';
import {decideCall,canTransition} from '../src/policy.mjs';
const identity={tenantId:'tenant',userId:'user',active:true};
const shield={allow:true};const entitlements={voice:true,internalCalls:true,externalCalls:true,fundingAuthorized:true};
test('internal enabled',()=>assert.equal(decideCall({kind:'internal',destination:'ext:alice',config:{internalEnabled:true},identity,shield,entitlements}).target,'ext:alice'));
test('PSTN off refuses even certified carrier',()=>assert.throws(()=>decideCall({kind:'external',destination:'+12025550123',config:{externalEnabled:false},identity,shield,entitlements,carrier:{certified:true}}),/PSTN_DISABLED/));
test('Shield fail closed',()=>assert.throws(()=>decideCall({kind:'internal',destination:'ext:alice',config:{internalEnabled:true},identity,shield:{allow:false},entitlements}),/SHIELD_DENIED/));
test('no connection without verified two way media',()=>{assert.equal(canTransition('media_verifying','connected',{encrypted:true,inboundAudio:true,outboundAudio:false,gatewayVerified:true}),false);assert.equal(canTransition('media_verifying','connected',{encrypted:true,inboundAudio:true,outboundAudio:true,gatewayVerified:true}),true);});
test('terminal calls cannot restart',()=>assert.equal(canTransition('ended','ringing'),false));
