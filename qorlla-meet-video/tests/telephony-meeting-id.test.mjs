import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeMeetingId } from '../server/telephony/core.mjs';
import { normalizePhoneMeetingCode } from '../server/meeting-code.mjs';

// The optional Twilio adapter must not keep its own meeting-code rule: it follows the internal definition exactly.
const inputs = ['12345678901', '123456789012', '123 4567 8901', '123-4567-89012', '01234567890', '012345678901',
  '1234567890', '1234567890123', '', ' ', '1234567890a', '١٢٣٤٥٦٧٨٩٠١', '123\t45678901', '12345678901\n', null, undefined, 12345678901];

test('the Twilio adapter accepts and refuses exactly what the internal normalizer does', () => {
  for (const input of inputs) {
    const expected = normalizePhoneMeetingCode(typeof input === 'string' ? input : String(input ?? ''));
    if (expected) assert.equal(normalizeMeetingId(input), expected, JSON.stringify(input));
    else assert.throws(() => normalizeMeetingId(input), { code: 'INVALID_MEETING_ID', status: 400 }, JSON.stringify(input));
  }
});

test('11 and 12 digits are accepted, leading zeros are kept, 10 and 13 digits are refused', () => {
  assert.equal(normalizeMeetingId('01234567890'), '01234567890');
  assert.equal(normalizeMeetingId('012345678901'), '012345678901');
  assert.throws(() => normalizeMeetingId('1234567890'), { code: 'INVALID_MEETING_ID' });
  assert.throws(() => normalizeMeetingId('1234567890123'), { code: 'INVALID_MEETING_ID' });
});

test('the IVR prompt no longer promises 11 digits and the adapter has no private digit rule', () => {
  const ivr = readFileSync(new URL('../server/telephony/ivr.mjs', import.meta.url), 'utf8');
  const core = readFileSync(new URL('../server/telephony/core.mjs', import.meta.url), 'utf8');
  assert.equal(ivr.includes('11-digit'), false);
  assert.equal(/\\d\{11\}/.test(core), false);
});
