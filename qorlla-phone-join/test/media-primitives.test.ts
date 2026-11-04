import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, linearToUlaw, linearToAlaw, ulawToLinear, alawToLinear, rmsDb } from '../src/media/g711.js';
import { JitterBuffer } from '../src/media/jitter.js';
import { DtmfDecoder, DtmfEntry, dtmfPayload, RULES } from '../src/media/dtmf.js';

test('G.711: known code words, round trips within the codec\'s quantisation error, and both laws agree on silence and full scale', () => {
  assert.equal(linearToUlaw(0), 0xff); assert.equal(linearToAlaw(0), 0xd5); assert.equal(ulawToLinear(0xff), 0); assert.ok(Math.abs(alawToLinear(0xd5)) <= 8);
  for (const codec of ['PCMU', 'PCMA'] as const) {
    const pcm = new Int16Array(160); for (let i = 0; i < 160; i++) pcm[i] = Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / 8000));
    const back = decode(codec, encode(codec, pcm)); let worst = 0; for (let i = 0; i < 160; i++) worst = Math.max(worst, Math.abs(back[i] - pcm[i]) / Math.max(256, Math.abs(pcm[i]))); assert.ok(worst < 0.07, codec + ' error ' + worst);
    for (const v of [-32768, -20000, -1000, -50, 50, 1000, 20000, 32767]) { const r = decode(codec, encode(codec, Int16Array.of(v)))[0]; assert.equal(Math.sign(r) || Math.sign(v), Math.sign(v), `${codec} keeps the sign of ${v}`); }
  }
  assert.equal(rmsDb(new Int16Array(160)), -Infinity); assert.ok(rmsDb(new Int16Array(160).fill(16384)) > -7);
});

const push = (jb: JitterBuffer<number>, seq: number, t = 0) => jb.push(seq & 0xffff, seq, t, seq * 20);
test('jitter buffer: reorders, drops duplicates and frames that arrive too late, and conceals a gap by repeating the last frame', () => {
  const jb = new JitterBuffer<number>(3); push(jb, 100); push(jb, 102); push(jb, 101); push(jb, 101); push(jb, 103);
  assert.deepEqual([jb.pop(), jb.pop(), jb.pop(), jb.pop()].map((x) => x?.frame), [100, 101, 102, 103]); assert.equal(jb.stats.duplicates, 1); assert.equal(jb.stats.reordered, 1); push(jb, 100); assert.equal(jb.stats.late, 1, 'a frame behind the playout point is late, not replayed');
  const lossy = new JitterBuffer<number>(3); [10, 11, 13, 14, 15].forEach((s) => push(lossy, s)); const out = [lossy.pop(), lossy.pop(), lossy.pop(), lossy.pop()];
  assert.deepEqual(out.map((x) => x?.frame), [10, 11, 11, 13]); assert.equal(out[2]?.concealed, true); assert.equal(lossy.stats.lost, 1); assert.equal(lossy.stats.concealed, 1);
});
test('jitter buffer: a frame that arrives late but within the buffer depth is played in order, not counted as lost (reordering is not loss)', () => {
  const jb = new JitterBuffer<number>(3); push(jb, 1); push(jb, 2); push(jb, 3); assert.equal(jb.pop()?.frame, 1); push(jb, 5); assert.equal(jb.pop()?.frame, 2); assert.equal(jb.pop()?.frame, 3);
  assert.equal(jb.pop(), null, 'frame 4 is not overdue yet: wait one tick'); push(jb, 4); assert.equal(jb.pop()?.frame, 4); assert.equal(jb.pop()?.frame, 5); assert.equal(jb.stats.lost, 0); assert.equal(jb.stats.concealed, 0);
});
test('jitter buffer: DTMF packets that share the sequence space are not losses, and a long gap resynchronises at once', () => {
  const jb = new JitterBuffer<number>(3); push(jb, 1); push(jb, 2); push(jb, 3); for (let s = 4; s <= 9; s++) jb.skip(s); push(jb, 10); push(jb, 11); push(jb, 12);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(() => jb.pop()?.frame), [1, 2, 3, 10, 11, 12], 'the skipped numbers cost no time and no loss'); assert.equal(jb.stats.lost, 0);
  const gap = new JitterBuffer<number>(3); push(gap, 1); push(gap, 2); push(gap, 3); gap.pop(); gap.pop(); gap.pop(); for (let s = 200; s < 205; s++) push(gap, s); const got: (number | undefined)[] = []; for (let i = 0; i < 8; i++) got.push(gap.pop()?.frame);
  assert.ok(got.includes(200) && got.includes(204), 'after a 196-frame gap the stream resumes within a few ticks: ' + got.join(',')); assert.ok(gap.stats.lost >= 190);
});
test('jitter buffer: waits to fill before playing, goes quiet when the stream stops, bounds its memory, and survives the 16-bit sequence wrap', () => {
  const jb = new JitterBuffer<number>(3); push(jb, 1); push(jb, 2); assert.equal(jb.pop(), null, 'not yet filled'); push(jb, 3); assert.equal(jb.pop()?.frame, 1); jb.pop(); jb.pop(); assert.equal(jb.pop(), null, 'an idle stream is silence, not loss'); assert.equal(jb.stats.lost, 0);
  const big = new JitterBuffer<number>(3); for (let i = 0; i < 500; i += 2) push(big, i); assert.ok((big as unknown as { frames: Map<number, number> }).frames.size <= 12, 'at most depth*4 frames are held');
  const wrap = new JitterBuffer<number>(3); const seqs = [65533, 65534, 65535, 0, 1, 2]; seqs.forEach((s, i) => wrap.push(s, i, 0, i * 20)); assert.deepEqual(Array.from({ length: 6 }, () => wrap.pop()?.frame), [0, 1, 2, 3, 4, 5]); assert.equal(wrap.stats.late, 0);
  const jittery = new JitterBuffer<number>(3); let t = 0; for (let i = 0; i < 40; i++) { t += 20 + (i % 2 ? 15 : -15); jittery.push(i, i, t, i * 20); } assert.ok(jittery.stats.jitterMs > 5, 'interarrival jitter is measured: ' + jittery.stats.jitterMs);
});
test('DTMF: a digit is reported once however often its packets are repeated; bad events are ignored', () => {
  const d = new DtmfDecoder(); assert.equal(d.decode(1, 1000, dtmfPayload('5', 160, false)), '5'); assert.equal(d.decode(1, 1000, dtmfPayload('5', 320, false)), null); assert.equal(d.decode(1, 1000, dtmfPayload('5', 640, true)), null);
  assert.equal(d.decode(1, 2000, dtmfPayload('#', 640, true)), '#'); assert.equal(d.decode(1, 3000, Buffer.from([20, 10, 0, 160])), null, 'event 20 is not a DTMF symbol'); assert.equal(d.decode(1, 5000, Buffer.from([1, 2])), null, 'short payload');
});
test('DTMF entry: a meeting ID completes at 11 digits; # ends a PIN; * restarts; too short / too long / silence / hang-up are distinct, bounded outcomes', async () => {
  const feed = (e: DtmfEntry, s: string) => { for (const c of s) e.push(c); };
  const id = new DtmfEntry(RULES.meetingId); feed(id, '1234567890'); id.push('1'); assert.deepEqual(await id.result, { ok: true, digits: '12345678901' });
  const pin = new DtmfEntry(RULES.pin); feed(pin, '99'); pin.push('*'); feed(pin, '4321#'); assert.deepEqual(await pin.result, { ok: true, digits: '4321' });
  const short = new DtmfEntry(RULES.pin); feed(short, '12#'); assert.deepEqual(await short.result, { ok: false, reason: 'too_short' });
  const long = new DtmfEntry({ ...RULES.pin, maxDigits: 5 }); feed(long, '123456'); assert.deepEqual(await long.result, { ok: false, reason: 'too_long' });
  const idle = new DtmfEntry({ ...RULES.pin, interDigitMs: 40 }); idle.push('1'); assert.deepEqual(await idle.result, { ok: false, reason: 'timeout' });
  const total = new DtmfEntry({ ...RULES.pin, totalMs: 60, interDigitMs: 1000 }); const tick = setInterval(() => total.push('1'), 10); assert.deepEqual(await total.result, { ok: false, reason: 'timeout' }, 'a caller who keeps pressing keys cannot hold the line forever'); clearInterval(tick);
  const ctl = new AbortController(), gone = new DtmfEntry(RULES.pin, ctl.signal); ctl.abort(); assert.deepEqual(await gone.result, { ok: false, reason: 'cancelled' });
  const ignore = new DtmfEntry(RULES.pin); ignore.push('A'); ignore.push('B'); feed(ignore, '1234#'); assert.deepEqual(await ignore.result, { ok: true, digits: '1234' }, 'A-D are not entry digits');
});
