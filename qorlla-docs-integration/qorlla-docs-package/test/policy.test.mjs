import test from 'node:test';import assert from 'node:assert/strict';import {policyFor,requireFeature} from '../src/policy.mjs';
test('unknown plan denied',()=>assert.throws(()=>policyFor('trial'),/Unknown plan/));
test('free quota',()=>assert.equal(policyFor('free').maxDocuments,5));
test('pro cannot live collaborate',()=>assert.equal(policyFor('pro').live,false));
test('business can live collaborate',()=>assert.equal(policyFor('business').live,true));
test('enterprise unlimited',()=>assert.equal(policyFor('enterprise').maxDocuments,null));
test('feature enforcement',()=>assert.throws(()=>requireFeature(policyFor('free'),'comments'),/not included/));
