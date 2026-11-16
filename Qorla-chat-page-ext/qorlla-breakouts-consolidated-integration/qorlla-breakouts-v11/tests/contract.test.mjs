
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoomCollaboration,RoomAccessError} from '../src/room-collaboration.mjs';
test('fails closed when Meet adapters missing',()=>assert.throws(()=>createRoomCollaboration({}),/required/));
test('rejects inactive meeting actor',async()=>{
 const svc=createRoomCollaboration({pool:{connect(){}},meetAuthority:{verifyActor:async()=>({active:false})},mediaCoordinator:{transition(){}},eventHub:{publish(){}}});
 await assert.rejects(svc.askForHelp('token','occ'),e=>e instanceof RoomAccessError && e.status===403);
});
test('rejects unsupported content kind',async()=>{
 const svc=createRoomCollaboration({pool:{connect(){}},meetAuthority:{verifyActor(){}},mediaCoordinator:{transition(){}},eventHub:{publish(){}}});
 await assert.rejects(svc.authorizeContent('token','occ','recording','x'),e=>e.status===400);
});
