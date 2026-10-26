import test from 'node:test';import assert from 'node:assert/strict';
import {registerSchedule,updateSchedule,cancelSchedule} from '../integration/qorlla-main-server-v3_5.mjs';
test('bridge refuses missing secret',async()=>{const old=process.env.QORLLA_BRIDGE_SECRET;delete process.env.QORLLA_BRIDGE_SECRET;await assert.rejects(registerSchedule({sourceId:'a'}),/Missing QORLLA_BRIDGE_SECRET/);if(old)process.env.QORLLA_BRIDGE_SECRET=old;});
test('update refuses missing secret',async()=>{const old=process.env.QORLLA_BRIDGE_SECRET;delete process.env.QORLLA_BRIDGE_SECRET;await assert.rejects(updateSchedule('a',{title:'T'}),/Missing QORLLA_BRIDGE_SECRET/);if(old)process.env.QORLLA_BRIDGE_SECRET=old;});
test('cancel refuses missing secret',async()=>{const old=process.env.QORLLA_BRIDGE_SECRET;delete process.env.QORLLA_BRIDGE_SECRET;await assert.rejects(cancelSchedule('a'),/Missing QORLLA_BRIDGE_SECRET/);if(old)process.env.QORLLA_BRIDGE_SECRET=old;});
