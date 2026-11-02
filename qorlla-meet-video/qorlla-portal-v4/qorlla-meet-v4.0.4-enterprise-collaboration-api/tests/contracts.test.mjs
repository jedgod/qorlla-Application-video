import test from 'node:test';import assert from 'node:assert/strict';import {hostRole,editorRole} from '../src/roles.mjs';
test('host permissions',()=>{assert.equal(hostRole('host'),true);assert.equal(hostRole('cohost'),true);assert.equal(hostRole('participant'),false);});
test('editor permissions',()=>{assert.equal(editorRole('presenter'),true);assert.equal(editorRole('participant'),false);});
