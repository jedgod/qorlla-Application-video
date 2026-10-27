// Pure state-machine rules for Qorlla Meet recording consent (no database): node --test tests/recording-consent.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../qorlla-meet-video/server/recording.mjs';

const S = (status, o = {}) => ({ status, want_video: true, want_audio: true, ...o });
const yes = { decision: 'agree', video: true, audio: true };
const L = (o) => new Map(Object.entries(o));

test('nobody can record until everyone present has agreed to every requested scope', () => {
  assert.equal(evaluate({ session: S('awaiting'), roster: ['a', 'b'], latest: L({ a: yes }) }).status, 'awaiting');
  assert.equal(evaluate({ session: S('awaiting'), roster: ['a', 'b'], latest: L({ a: yes, b: yes }) }).status, 'ready');
  assert.equal(evaluate({ session: S('awaiting'), roster: ['a', 'b'], latest: L({ a: yes, b: { decision: 'agree', video: true, audio: false } }) }).status, 'awaiting');   // audio missing
  assert.equal(evaluate({ session: S('awaiting', { want_audio: false }), roster: ['a'], latest: L({ a: { decision: 'agree', video: true, audio: false } }) }).status, 'ready');
});
test('a decline blocks; a decline or withdrawal while recording stops it', () => {
  assert.equal(evaluate({ session: S('awaiting'), roster: ['a', 'b'], latest: L({ a: yes, b: { decision: 'decline' } }) }).status, 'blocked');
  const w = evaluate({ session: S('recording'), roster: ['a', 'b'], latest: L({ a: yes, b: { decision: 'withdraw' } }) });
  assert.deepEqual([w.status, w.endReason], ['stopped', 'consent_withdrawn']);
  assert.equal(evaluate({ session: S('recording'), roster: ['a', 'b'], latest: L({ a: yes, b: { decision: 'decline' } }) }).endReason, 'declined_during_recording');
});
test('a late joiner pauses a running recording until they answer; leaving resumes it', () => {
  assert.equal(evaluate({ session: S('recording'), roster: ['a', 'c'], latest: L({ a: yes }) }).status, 'paused');
  assert.equal(evaluate({ session: S('paused'), roster: ['a', 'c'], latest: L({ a: yes, c: yes }) }).status, 'recording');
  assert.equal(evaluate({ session: S('paused'), roster: ['a'], latest: L({ a: yes, c: yes }) }).status, 'recording');
});
test('someone who declined and left no longer blocks a new decision for the people present', () => {
  assert.equal(evaluate({ session: S('blocked'), roster: ['a'], latest: L({ a: yes, b: { decision: 'decline' } }) }).status, 'ready');
});
