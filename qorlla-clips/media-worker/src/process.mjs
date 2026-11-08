// One render job, with every outside effect passed in so it can be tested without ffmpeg, Redis, storage or the API.
import { rm } from 'node:fs/promises';

const ID = /^[0-9a-f-]{36}$/i;

/** The payload comes from the queue, so it is checked before anything uses it. */
export function checkPayload(p) {
  if (!p || typeof p !== 'object') throw new Error('empty job');
  if (!ID.test(p.draftId || '') || !ID.test(p.organizationId || '')) throw new Error('bad draft or organization id');
  // the key is chosen by the API; the worker only refuses anything that does not look like it
  if (!Number.isInteger(p.maxSeconds) || p.maxSeconds < 1 || p.maxSeconds > 600) throw new Error('bad maximum length');
  if (p.objectKey !== `avatars/${p.organizationId}/${p.draftId}/render.mp4`) throw new Error('unexpected storage key');
  return p;
}

/** render -> upload -> tell the API. Throws on any failure so the queue can retry; always removes the temporary files. */
export async function processDraft(payload, { render, upload, api, log = () => {} }) {
  const p = checkPayload(payload);
  let out;
  try {
    out = await render({ title: p.title, avatarName: p.avatarName, script: p.script, maxSeconds: p.maxSeconds });
    const bytes = await upload(p.objectKey, out.file);
    const r = await api.complete(p.draftId, { status: 'READY', stored: true, durationMs: Math.round(out.seconds * 1000) });
    log(r && r.gone ? `draft ${p.draftId} no longer exists; the render was not needed` : `draft ${p.draftId} is READY (${bytes} bytes)`);
    return { bytes, seconds: out.seconds, gone: !!(r && r.gone) };
  } finally { if (out && out.dir) await rm(out.dir, { recursive: true, force: true }); }
}

/** After the last attempt failed: show the draft as FAILED so it does not wait for ever. */
export async function reportFailure(payload, api, log = () => {}) {
  try { checkPayload(payload); await api.complete(payload.draftId, { status: 'FAILED' }); log(`draft ${payload.draftId} marked FAILED`); }
  catch (e) { log(`could not mark draft ${payload && payload.draftId} FAILED: ${e.message}`); }
}
