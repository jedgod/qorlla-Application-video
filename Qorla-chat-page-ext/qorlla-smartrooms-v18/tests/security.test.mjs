import test from 'node:test';import assert from 'node:assert/strict';
import {constantTimeEqual,safeText,Forbidden} from '../src/security.mjs';
import {createPrivateReports} from '../src/private-ai.mjs';
import {createMediaAuthority} from '../src/media.mjs';
import {validatePortalBridge} from '../src/bridge-contract.mjs';
test('constant-time compare checks equality',()=>{assert.equal(constantTimeEqual('abc','abc'),true);assert.equal(constantTimeEqual('abc','abd'),false);});
test('safe text strips control characters',()=>assert.equal(safeText('a\nb'),'a b'));
test('private AI fails closed without gateway',()=>assert.throws(()=>createPrivateReports({pool:{}}),/Missing required adapter/));
test('media fails closed without Meet authority',()=>assert.throws(()=>createMediaAuthority({pool:{}}),/Missing required adapter/));
test('Portal bridge contract requires secure source staging',()=>assert.throws(()=>validatePortalBridge({generateRoomReport(){}}),/stageEncryptedSource/));
test('room-scoped signaling rejects different rooms',async()=>{
 const svc=createMediaAuthority({pool:{},meetAuth:{verify:async()=>({active:true,participantId:'a'})},roomAuthority:{currentLocation:async({participantId})=>({roomId:participantId==='a'?'r1':'r2',epoch:2})},signaling:{}});
 await assert.rejects(svc.authorizeSignal({session:'s',occurrenceId:'o',peerId:'b',epoch:2}),Forbidden);
});
test('media reports are never independently verified',async()=>{
 const svc=createMediaAuthority({pool:{query:async()=>({rows:[{client_state:'client_reported',relay_observation:'traffic_observed'}]})},meetAuth:{verify:async()=>({active:true,participantId:'a'})},roomAuthority:{currentLocation:async()=>({epoch:2})},signaling:{}});
 const r=await svc.reportClientState({session:'s',occurrenceId:'o',transitionId:'id',epoch:2,state:'client_reported'});
 assert.equal(r.verified,false);
});
