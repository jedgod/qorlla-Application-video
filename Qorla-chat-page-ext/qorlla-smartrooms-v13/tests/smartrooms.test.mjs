import test from 'node:test';
import assert from 'node:assert/strict';
import {balancedGroups,createSmartRooms,SmartRoomError} from '../src/smartrooms.mjs';
test('balanced distribution',()=>assert.deepEqual(balancedGroups(['a','b','c','d','e'],['x','y']),[{participantId:'a',roomId:'x'},{participantId:'b',roomId:'y'},{participantId:'c',roomId:'x'},{participantId:'d',roomId:'y'},{participantId:'e',roomId:'x'}]));
test('capacity fails closed',()=>assert.throws(()=>balancedGroups(['a','b','c'],['x'],{maxPerRoom:2}),e=>e.status===409));
test('duplicate participants denied',()=>assert.throws(()=>balancedGroups(['a','a'],['x']),e=>e instanceof SmartRoomError));
test('missing adapters denied',()=>assert.throws(()=>createSmartRooms({}),/required/));
test('inactive actors denied',async()=>{const s=createSmartRooms({pool:{connect(){}},verifyActor:async()=>({active:false})});await assert.rejects(s.createMission('token','occ','room',{title:'Task'}),e=>e.status===403)});
test('authority outage fails closed',async()=>{const s=createSmartRooms({pool:{connect(){}},verifyActor:async()=>{throw Error('offline')}});await assert.rejects(s.hostDashboard('token','occ'),e=>e.status===503)});
