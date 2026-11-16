import test from 'node:test';import assert from 'node:assert/strict';
import {assertPrincipal,assertFeature,assertConsent,safeAIOutput} from '../src/policy.mjs';
test('membership fails closed',()=>{assert.throws(()=>assertPrincipal(null,'x'));assert.throws(()=>assertPrincipal({actorId:'a',occurrenceId:'y',active:true},'x'));assert.throws(()=>assertPrincipal({actorId:'a',occurrenceId:'x',active:false},'x'));assert.equal(assertPrincipal({actorId:'a',occurrenceId:'x',active:true},'x').actorId,'a');});
test('feature flags fail closed',()=>{assert.throws(()=>assertFeature(undefined));assert.throws(()=>assertFeature(false));assert.doesNotThrow(()=>assertFeature(true));});
test('explicit typed consent required',()=>{assert.throws(()=>assertConsent({kind:'ai',granted:true},'transcription'));assert.throws(()=>assertConsent({kind:'ai',granted:false},'ai'));assert.doesNotThrow(()=>assertConsent({kind:'ai',granted:true},'ai'));});
test('AI output bounded',()=>{assert.throws(()=>safeAIOutput({}));assert.throws(()=>safeAIOutput('x'.repeat(16001)));assert.equal(safeAIOutput('ok'),'ok');});
