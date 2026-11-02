import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDestination } from './support.js';
import { assertInternalOnly, InternalVoiceService } from '../src/internal-voice.js';
import { certificateThumbprint } from '../src/workload-auth.js';

test('public and malformed destinations denied', () => {
  for (const value of ['+15551234567','hello','12','123456789','100-200',null]) assert.equal(classifyDestination(value), false);
  assert.equal(classifyDestination('4001'), true);
});
test('public calling cannot be enabled', () => {
  assert.throws(() => assertInternalOnly({pstnEnabled:true}), /prohibited/);
  assert.throws(() => assertInternalOnly({publicNumbersEnabled:true}), /prohibited/);
  assert.doesNotThrow(() => assertInternalOnly({}));
});
test('certificate binding requires real DER bytes', () => {
  assert.throws(() => certificateThumbprint(null), /MTLS_CERT_REQUIRED/);
  assert.ok(certificateThumbprint(Buffer.from('test-cert')).length > 10);
});
test('guest cannot initiate calls', async () => {
  const service = new InternalVoiceService({db:{},outbox:{}});
  await assert.rejects(service.invite({kind:'guest',accountId:'x',tenantId:'y'},'4001'), /VOICE_FORBIDDEN/);
});
