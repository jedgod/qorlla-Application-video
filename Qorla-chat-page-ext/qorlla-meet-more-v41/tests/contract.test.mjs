import test from 'node:test';
import assert from 'node:assert/strict';
import {createMoreRouter} from '../src/server.mjs';
test('fail closed without Meet authority adapters',()=>{
 assert.throws(()=>createMoreRouter({}),/Meet adapters required/);
});
