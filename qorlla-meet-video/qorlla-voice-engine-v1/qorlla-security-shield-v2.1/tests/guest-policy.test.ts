import {test} from 'node:test';import {strict as assert} from 'node:assert';
import {evaluate,type Context,type Action} from '../src/policy.js';
const base:Context={action:'meeting.join',verified:false,mfa:false,trustedDevice:false,suspended:false,orgSuspended:false,isGuest:true,scopes:[],risk:0,pstnEnabled:false,internationalEnabled:false,international:false,externalInvite:false,destinationAllowed:false};
for(const action of ['voice.internal','voice.pstn.outbound','voice.number.assign','meeting.join','meeting.create','meeting.invite','message.send','admin.read','admin.mutate','organization.manage'] as Action[]){
 test('guest denied '+action,()=>assert.equal(evaluate({...base,action}).allow,false));
}
test('guest admission requires separate gateway',()=>assert.equal(evaluate({...base,action:'guest.join'}).reason,'GUEST_JOIN_VIA_ADMISSION_GATEWAY_ONLY'));
test('unverified cannot create meeting',()=>assert.equal(evaluate({...base,isGuest:false,action:'meeting.create'}).allow,false));
test('suspended verified cannot join',()=>assert.equal(evaluate({...base,isGuest:false,verified:true,suspended:true,action:'meeting.join'}).allow,false));
