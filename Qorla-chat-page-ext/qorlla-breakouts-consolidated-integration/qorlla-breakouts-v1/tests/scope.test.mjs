import test from 'node:test';import assert from 'node:assert/strict';
import {scopeKey,createBreakouts} from '../src/service.mjs';
test('main and breakout signaling scopes differ',()=>assert.notEqual(scopeKey('occ','r1'),scopeKey('occ',null)));
test('real adapters are mandatory',()=>assert.throws(()=>createBreakouts({}),/Real Meet adapters required/));
