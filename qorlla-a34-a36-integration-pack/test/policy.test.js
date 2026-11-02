import test from 'node:test';import assert from 'node:assert/strict';
import {assertDeployment,classifyDestination,requirePrincipal,requireScope} from '../src/policy.js';
import {rtcConfiguration,closeMediaOnRevocation} from '../src/relay-policy.js';
test('PSTN and public number flags fail deployment closed',()=>{
  for(const key of ['VOICE_PSTN_ENABLED','VOICE_NUMBERS_ENABLED']) assert.throws(()=>assertDeployment({VOICE_INTERNAL_CALLS_ENABLED:'true',VOICE_MEDIA_POLICY:'relay',[key]:'true'}));
});
test('relay-only is mandatory',()=>{assert.throws(()=>assertDeployment({VOICE_INTERNAL_CALLS_ENABLED:'true',VOICE_MEDIA_POLICY:'all'}));assert.doesNotThrow(()=>assertDeployment({VOICE_INTERNAL_CALLS_ENABLED:'true',VOICE_MEDIA_POLICY:'relay'}));});
test('extension-only routing',()=>{assert.equal(classifyDestination('4001').ok,true);for(const v of ['+15555551234','abc','123456789','1',null,'4001 '])assert.equal(classifyDestination(v).ok,false);});
test('guest and unverified principal denied',()=>{for(const p of [null,{kind:'guest',accountId:'a',tenantId:'t',verified:true},{accountId:'a',tenantId:'t',verified:false},{accountId:'a',tenantId:'t',verified:true,suspended:true}])assert.throws(()=>requirePrincipal(p));});
test('workload scopes required',()=>{assert.throws(()=>requireScope({scopes:['voice.read']},'voice.account.suspend'));});
test('relay-only WebRTC configuration',()=>assert.equal(rtcConfiguration({iceServers:[]}).iceTransportPolicy,'relay'));
test('client media teardown stops tracks',()=>{let stopped=0,closed=false;closeMediaOnRevocation({getSenders:()=>[{track:{stop:()=>stopped++}}],close:()=>closed=true},[{getTracks:()=>[{stop:()=>stopped++}]}]);assert.equal(stopped,2);assert.equal(closed,true);});
