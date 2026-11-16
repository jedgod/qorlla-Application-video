import test from 'node:test';import assert from 'node:assert/strict';import {reactionSchema,questionSchema,roomSchema,requireRole,featureGate,safeFilename} from '../src/core.mjs';
test('reaction allowlist',()=>{assert.equal(reactionSchema.parse({emoji:'👏'}).emoji,'👏');assert.equal(reactionSchema.safeParse({emoji:'<script>'}).success,false);});
test('question bounds',()=>{assert.equal(questionSchema.safeParse({body:''}).success,false);assert.equal(questionSchema.safeParse({body:'x'.repeat(4001)}).success,false);});
test('host roles',()=>{assert.throws(()=>requireRole({role:'guest'},['host','cohost']));assert.doesNotThrow(()=>requireRole({role:'host'},['host','cohost']));});
test('fail closed flags',()=>assert.throws(()=>featureGate({},'files')));
test('safe file names',()=>assert.equal(safeFilename('../../evil.pdf'),'.._.._evil.pdf'));
test('room title validation',()=>assert.equal(roomSchema.safeParse({title:''}).success,false));
