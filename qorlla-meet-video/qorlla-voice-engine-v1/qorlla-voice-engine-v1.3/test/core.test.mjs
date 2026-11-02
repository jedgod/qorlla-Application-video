import test from 'node:test';import assert from 'node:assert/strict';import {allowedTransition,validExtension,validCallId,safeSignal} from '../src/core.mjs';
test('valid extensions',()=>{assert.equal(validExtension('2041'),true);assert.equal(validExtension('+12025550100'),false)});
test('state machine prevents backwards transitions',()=>{assert.equal(allowedTransition('ringing','active'),true);assert.equal(allowedTransition('ended','active'),false);assert.equal(allowedTransition('active','ringing'),false)});
test('signal requires valid UUID',()=>{assert.equal(safeSignal({type:'offer',callId:'bad',sdp:'x'}),false)});
test('rejects oversize SDP',()=>{assert.equal(safeSignal({type:'offer',callId:'b00c477c-0b2e-42c5-ae21-211e14799322',sdp:'a'.repeat(65537)}),false)});
test('rejects invalid ICE payload',()=>{assert.equal(safeSignal({type:'ice',callId:'b00c477c-0b2e-42c5-ae21-211e14799322',candidate:{candidate:23}}),false)});
