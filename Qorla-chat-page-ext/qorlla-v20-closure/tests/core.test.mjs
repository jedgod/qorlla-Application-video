import test from 'node:test';import assert from 'node:assert/strict';import {validId,isDeliverable,authorize} from '../src/core.mjs';
test('rejects unsafe identifiers',()=>{assert.equal(validId('a_b-12'),true);assert.equal(validId('../x'),false);assert.equal(validId(''),false);});
test('cross-room and stale epochs are denied',()=>{const e={meeting_id:'m',room_id:'r',epoch:2};assert.equal(isDeliverable(e,{room_id:'r',epoch:2},{meetingId:'m'}),true);assert.equal(isDeliverable(e,{room_id:'other',epoch:2},{meetingId:'m'}),false);assert.equal(isDeliverable(e,{room_id:'r',epoch:1},{meetingId:'m'}),false);});
test('membership check fails closed',async()=>{const db={query:async()=>({rows:[]})};await assert.rejects(()=>authorize(db,{meetingId:'m',participantId:'p'},'m','r',1),/denied/);});
