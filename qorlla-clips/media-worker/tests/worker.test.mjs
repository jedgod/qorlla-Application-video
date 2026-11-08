import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkPayload, processDraft, reportFailure } from '../src/process.mjs';
import { cardArgs, videoArgs, wrapText, renderSeconds, LABEL } from '../src/render.mjs';
import { createApiClient } from '../src/clients.mjs';

const ORG = '11111111-1111-4111-8111-111111111111', DRAFT = '22222222-2222-4222-8222-222222222222';
const payload = (over = {}) => ({ draftId: DRAFT, organizationId: ORG, objectKey: `avatars/${ORG}/${DRAFT}/render.mp4`, avatarName: 'Alex', title: 'Hello', script: 'Hi there', maxSeconds: 90, ...over });

async function fakeRender() { const dir = await mkdtemp(path.join(os.tmpdir(), 'wt-')); const file = path.join(dir, 'out.mp4'); await writeFile(file, 'x'.repeat(10)); return { file, dir, bytes: 10, seconds: 12 }; }

test('a good job renders, uploads to the key the API chose, reports READY with stored:true, and cleans up', async () => {
  const calls = []; let dir;
  const r = await processDraft(payload(), {
    render: async () => { const o = await fakeRender(); dir = o.dir; return o; },
    upload: async (key, file) => { calls.push(['upload', key]); return 10; },
    api: { complete: async (id, body) => { calls.push(['complete', id, body]); return { id, status: 'READY' }; } },
  });
  assert.deepEqual(calls, [['upload', `avatars/${ORG}/${DRAFT}/render.mp4`], ['complete', DRAFT, { status: 'READY', stored: true, durationMs: 12000 }]]);
  assert.equal(r.bytes, 10);
  await assert.rejects(access(dir), 'the temporary folder is removed');
});

test('a failed render is not reported READY, the error reaches the queue (so it retries), and the temporary files go', async () => {
  let dir; const calls = [];
  await assert.rejects(processDraft(payload(), {
    render: async () => { const o = await fakeRender(); dir = o.dir; return o; },
    upload: async () => { throw new Error('storage down'); },
    api: { complete: async () => { calls.push('complete'); } },
  }), /storage down/);
  assert.deepEqual(calls, []);
  await assert.rejects(access(dir));
});

test('a draft that was discarded meanwhile is fine (404 from the API is not an error)', async () => {
  const r = await processDraft(payload(), { render: fakeRender, upload: async () => 10, api: { complete: async () => ({ gone: true }) } });
  assert.equal(r.gone, true);
});

test('a job with an unexpected storage key or bad ids is refused before anything runs', async () => {
  for (const bad of [payload({ objectKey: 'avatars/other/x/render.mp4' }), payload({ objectKey: '../../etc/passwd' }), payload({ draftId: 'nope' }), payload({ maxSeconds: 0 }), payload({ maxSeconds: 'ninety' }), payload({ maxSeconds: 100000 }), null]) {
    assert.throws(() => checkPayload(bad));
  }
});

test('after the last attempt the draft is marked FAILED; a broken API call is only logged', async () => {
  const seen = []; await reportFailure(payload(), { complete: async (id, b) => { seen.push([id, b]); } });
  assert.deepEqual(seen, [[DRAFT, { status: 'FAILED' }]]);
  const logs = []; await reportFailure(payload(), { complete: async () => { throw new Error('api down'); } }, (m) => logs.push(m));
  assert.match(logs[0], /api down/);
});

test('ffmpeg arguments: user text is never in the filter string, only file names; no shell metacharacters can reach it', () => {
  const evil = "x':fontfile=/etc/passwd,drawtext=text='pwn";
  const args = cardArgs({ font: '/f.ttf', hasScript: true }).join(' ');
  assert.ok(!args.includes('pwn') && !args.includes('passwd'));
  assert.match(args, /textfile=title\.txt/); assert.match(args, /textfile=script\.txt/);
  assert.ok(cardArgs({ font: '/f.ttf', hasScript: false }).join(' ').indexOf('script.txt') < 0);
  const v = videoArgs({ seconds: 90 }); assert.equal(v[v.indexOf('-t') + 1], '90', 'the video is cut at exactly the requested length');
  assert.ok(v.includes('-loop') && v.includes('card.png'), 'the card is drawn once and looped, not redrawn on every frame');
});

test('wrapText: wraps, caps the lines with an ellipsis, drops control characters and splits very long words', () => {
  assert.equal(wrapText('a b c', 10, 3), 'a b c');
  assert.equal(wrapText('one two three four', 8, 2).split('\n').length, 2);
  assert.ok(wrapText('one two three four five six', 8, 2).endsWith('…'));
  assert.ok(!/[\u0000-\u001f]/.test(wrapText('a\u0000b\nc\td', 10, 3).replace(/\n/g, '')));
  assert.ok(wrapText('x'.repeat(100), 20, 10).split('\n').every((l) => l.length <= 20));
  assert.equal(wrapText('', 10, 3), ''); assert.equal(wrapText(null, 10, 3), '');
  assert.ok(LABEL.includes('PLACEHOLDER'));
});

test('the API client sends the service key, treats 404 as "gone" and refuses other errors', async () => {
  let seen;
  const mk = (status, body) => createApiClient({ baseUrl: 'http://api/', serviceKey: 'k'.repeat(40), fetchImpl: async (url, init) => { seen = { url, init }; return { status, json: async () => body }; } });
  assert.deepEqual(await mk(200, { id: DRAFT, status: 'READY' }).complete(DRAFT, { status: 'READY', stored: true }), { id: DRAFT, status: 'READY' });
  assert.equal(seen.url, `http://api/api/internal/avatar-drafts/${DRAFT}/complete`); assert.equal(seen.init.headers['x-service-key'], 'k'.repeat(40));
  assert.deepEqual(await mk(404, null).complete(DRAFT, { status: 'FAILED' }), { gone: true });
  await assert.rejects(mk(500, { error: 'x' }).complete(DRAFT, { status: 'FAILED' }), /refused/);
  assert.deepEqual(await mk(200, { drafts: [{ draftId: DRAFT }] }).pending(), [{ draftId: DRAFT }]);
});

test('the render length follows the script at about 2.5 words a second, never under 6 s and never over the tier limit (90 s for Basic)', () => {
  const w = (n) => Array(n).fill('word').join(' ');
  assert.equal(renderSeconds('', 90), 6); assert.equal(renderSeconds(w(2), 90), 6); assert.equal(renderSeconds(w(15), 90), 6);
  assert.equal(renderSeconds(w(100), 90), 40); assert.equal(renderSeconds(w(225), 90), 90);
  assert.equal(renderSeconds(w(1000), 90), 90, 'a Basic draft can never run past 90 seconds');
  assert.equal(renderSeconds(w(1000), 300), 300); assert.equal(renderSeconds(null, 90), 6);
});
