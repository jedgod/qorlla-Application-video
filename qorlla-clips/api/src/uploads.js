/**
 * Recording uploads and playback. Mounted on the authenticated /api router by app.js.
 *
 *   POST /recordings                 start: creates the clip (UPLOADING) and the multipart upload; the SERVER picks the object key
 *   GET  /clips/:id/upload           what is already in storage (so an interrupted upload can resume)
 *   POST /clips/:id/upload/parts     signed URLs for parts (each bound to this clip's key, upload id, part number and exact length)
 *   POST /clips/:id/upload/complete  the server lists the parts in storage, checks them, completes, verifies the size, marks READY
 *   POST /clips/:id/upload/abort     cancels and removes the clip
 *   GET  /clips/:id/playback         a short-lived signed link, only for people who may see the clip
 *
 * What is NOT trusted: the browser's part list, ETags, sizes, or any key. Nothing the caller sends can name another object.
 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

const EXT = { 'video/webm': 'webm', 'video/mp4': 'mp4' };
const MAX_ACTIVE_UPLOADS = 5;
const MAX_URLS_PER_CALL = 50;

const schemas = {
  start: z.object({
    title: z.string().trim().min(1).max(200).optional(),
    source: z.enum(['RECORDING', 'UPLOAD']).default('RECORDING'),
    mimeType: z.string().max(100).transform((s) => s.split(';')[0].trim().toLowerCase()).pipe(z.enum(['video/webm', 'video/mp4'])),
    sizeBytes: z.number().int().min(1),
    durationMs: z.number().int().min(0).max(24 * 3600 * 1000).optional(),
  }).strict(),
  parts: z.object({ partNumbers: z.array(z.number().int().min(1).max(10000)).min(1).max(MAX_URLS_PER_CALL) }).strict(),
};

const totalPartsOf = (clip) => Math.ceil(Number(clip.sizeBytes) / clip.partSize);
const expectedLength = (clip, n) => (n < totalPartsOf(clip) ? clip.partSize : Number(clip.sizeBytes) - (n - 1) * clip.partSize);

export function registerUploads({ api, prisma, config, storage, wrap, notFound, clipDto, myClip, viewable, uuid }) {
  const unavailable = (res) => res.status(503).json({ error: 'storage_unavailable', message: 'Video storage is not configured on this server.' });
  const storageError = (res, e, what) => {
    console.error('[clips-api] storage', what, e && (e.name || e.code), e && e.message);
    return res.status(502).json({ error: 'storage_error', message: 'Video storage did not respond. Try again shortly.' });
  };
  const ownUploading = async (req, res) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) { notFound(res); return null; }
    const clip = await myClip(req.user, id.data);
    if (!clip || !clip.storageKey) { notFound(res); return null; }
    return clip;
  };

  api.post('/recordings', wrap(async (req, res) => {
    const me = req.user;
    if (!storage) return unavailable(res);
    const b = schemas.start.parse(req.body);
    if (b.sizeBytes > config.maxUploadBytes) return res.status(400).json({ error: 'too_large', message: `Recordings can be up to ${Math.floor(config.maxUploadBytes / 1048576)} MB.` });
    if (b.source === 'UPLOAD') {                                                    // picking a file from disk is a paid feature; recording is not
      const org = await prisma.organization.findUnique({ where: { id: me.orgId }, select: { plan: true } });
      if (org.plan === 'free') return res.status(403).json({ error: 'feature_locked', feature: 'upload', message: 'Uploading video is available on paid plans.' });
    }
    if ((await prisma.clip.count({ where: { ownerId: me.id, status: 'UPLOADING' } })) >= MAX_ACTIVE_UPLOADS) return res.status(429).json({ error: 'too_many_uploads', message: 'Finish or cancel your current uploads first.' });

    const clipId = randomUUID();
    const key = `${me.orgId}/${me.id}/${clipId}.${EXT[b.mimeType]}`;           // built here, from ids the server owns: never from user input
    const partSize = config.uploadPartBytes;
    const clip = await prisma.clip.create({
      data: { id: clipId, title: b.title || `${b.source === 'UPLOAD' ? 'Upload' : 'Recording'} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, source: b.source, status: 'UPLOADING',
        ownerId: me.id, organizationId: me.orgId, storageKey: key, mimeType: b.mimeType, sizeBytes: BigInt(b.sizeBytes), partSize, durationMs: b.durationMs ?? null },
      include: { owner: { select: { name: true } } },
    });
    try {
      const uploadId = await storage.startMultipart(key, b.mimeType);
      await prisma.clip.update({ where: { id: clip.id }, data: { uploadId } });
    } catch (e) {
      await prisma.clip.delete({ where: { id: clip.id } }).catch(() => null);          // nothing was opened in storage: leave no half-made clip
      return storageError(res, e, 'start');
    }
    res.status(201).json({ clip: clipDto(clip, me), upload: { partSize, totalParts: Math.ceil(b.sizeBytes / partSize) } });
  }));

  api.get('/clips/:id/upload', wrap(async (req, res) => {
    if (!storage) return unavailable(res);
    const clip = await ownUploading(req, res); if (!clip) return;
    const base = { status: clip.status, partSize: clip.partSize, totalParts: totalPartsOf(clip) };
    if (clip.status !== 'UPLOADING' || !clip.uploadId) return res.json({ ...base, uploadedParts: [] });
    try { res.json({ ...base, uploadedParts: (await storage.listParts(clip.storageKey, clip.uploadId)).map((p) => ({ partNumber: p.partNumber, size: p.size })) }); }
    catch (e) { storageError(res, e, 'listParts'); }
  }));

  api.post('/clips/:id/upload/parts', wrap(async (req, res) => {
    if (!storage) return unavailable(res);
    const b = schemas.parts.parse(req.body);
    const clip = await ownUploading(req, res); if (!clip) return;
    if (clip.status !== 'UPLOADING' || !clip.uploadId) return res.status(409).json({ error: 'not_uploading', message: 'This upload is not open.' });
    if (clip.isTrashed) return res.status(409).json({ error: 'in_trash', message: 'Restore the clip first.' });
    const total = totalPartsOf(clip);
    if (b.partNumbers.some((n) => n > total)) return res.status(400).json({ error: 'invalid_request', message: `This upload has ${total} part${total === 1 ? '' : 's'}.` });
    try {
      const urls = {};
      for (const n of new Set(b.partNumbers)) urls[n] = await storage.signPart(clip.storageKey, clip.uploadId, n, expectedLength(clip, n), 1800);
      res.json({ urls, expiresInSeconds: 1800 });
    } catch (e) { storageError(res, e, 'signPart'); }
  }));

  api.post('/clips/:id/upload/complete', wrap(async (req, res) => {
    const me = req.user;
    if (!storage) return unavailable(res);
    const clip = await ownUploading(req, res); if (!clip) return;
    if (clip.status === 'READY') return res.json({ clip: clipDto(clip, me) });         // completing twice is harmless
    if (clip.status !== 'UPLOADING' || !clip.uploadId) return res.status(409).json({ error: 'not_uploading', message: 'This upload is not open.' });

    try {
      const total = totalPartsOf(clip);
      // If another request completed this upload a moment ago the store no longer knows the upload id: that is not an error,
      // the finished object is checked below exactly as if this request had completed it.
      let held = null;
      try { held = await storage.listParts(clip.storageKey, clip.uploadId); } catch (e) { if (e?.name !== 'NoSuchUpload') throw e; }
      if (held) {
        const byNumber = new Map(held.map((p) => [p.partNumber, p]));
        const missing = [], wrong = [];
        for (let n = 1; n <= total; n++) { const p = byNumber.get(n); if (!p) missing.push(n); else if (p.size !== expectedLength(clip, n)) wrong.push(n); }
        const extra = held.filter((p) => p.partNumber < 1 || p.partNumber > total).map((p) => p.partNumber);
        if (missing.length || wrong.length || extra.length) {
          return res.status(409).json({ error: 'incomplete_upload', message: 'Some parts are missing or have the wrong size.', missing, wrong, extra });
        }
        try { await storage.complete(clip.storageKey, clip.uploadId, held.filter((p) => p.partNumber <= total).sort((a, b) => a.partNumber - b.partNumber)); }
        catch (e) { if (e?.name !== 'NoSuchUpload') throw e; /* a concurrent complete finished it: verified below */ }
      }

      const head = await storage.head(clip.storageKey);
      if (!head && !held) return res.status(409).json({ error: 'upload_gone', message: 'This upload is no longer open. Please record again.' });
      if (!head || head.size !== Number(clip.sizeBytes)) {
        await storage.remove(clip.storageKey).catch(() => null);
        await prisma.clip.updateMany({ where: { id: clip.id, status: 'UPLOADING' }, data: { status: 'FAILED', uploadId: null } });
        return res.status(409).json({ error: 'size_mismatch', message: 'The uploaded file is not the size that was announced. Please record again.' });
      }
      await prisma.clip.updateMany({ where: { id: clip.id, status: 'UPLOADING' }, data: { status: 'READY', uploadId: null } });
      const done = await prisma.clip.findUnique({ where: { id: clip.id }, include: { owner: { select: { name: true } } } });
      res.json({ clip: clipDto(done, me) });
    } catch (e) { storageError(res, e, 'complete'); }
  }));

  api.post('/clips/:id/upload/abort', wrap(async (req, res) => {
    if (!storage) return unavailable(res);
    const clip = await ownUploading(req, res); if (!clip) return;
    if (clip.status === 'READY') return res.status(409).json({ error: 'already_complete', message: 'This recording is already saved.' });
    try { if (clip.uploadId) await storage.abort(clip.storageKey, clip.uploadId); } catch (e) { return storageError(res, e, 'abort'); }
    await prisma.clip.delete({ where: { id: clip.id } });
    res.json({ ok: true });
  }));

  api.get('/clips/:id/playback', wrap(async (req, res) => {
    const me = req.user; const id = uuid.safeParse(req.params.id); if (!id.success) return notFound(res);
    const clip = await viewable(me, id.data); if (!clip) return notFound(res);
    if (clip.isTrashed && clip.ownerId !== me.id) return notFound(res);
    if (clip.status !== 'READY') return res.status(409).json({ error: 'not_ready', message: 'This clip is not ready to play yet.' });
    if (clip.storageKey) {
      if (!storage) return unavailable(res);
      await prisma.playbackEvent.create({ data: { clipId: clip.id, organizationId: me.orgId, viewerId: me.id } });
      try { return res.json({ url: await storage.signGet(clip.storageKey, { expiresIn: config.playbackSeconds, contentType: clip.mimeType }), expiresInSeconds: config.playbackSeconds, mimeType: clip.mimeType }); }
      catch (e) { return storageError(res, e, 'signGet'); }
    }
    if (clip.videoUrl) return res.json({ url: clip.videoUrl, expiresInSeconds: 0, mimeType: clip.mimeType });
    res.status(409).json({ error: 'not_ready', message: 'This clip has no video.' });
  }));
}

/**
 * Uploads that were never finished (the browser closed, the network died) would hold storage forever. Abort them and mark the clip
 * FAILED so its owner sees what happened. Called when the server starts and then periodically.
 */
export async function sweepUploads({ prisma, storage, ttlMs, now = Date.now(), log = console }) {
  if (!storage) return { aborted: 0 };
  const stale = await prisma.clip.findMany({ where: { status: 'UPLOADING', createdAt: { lt: new Date(now - ttlMs) } }, take: 200 });
  let aborted = 0;
  for (const c of stale) {
    try {
      if (c.uploadId && c.storageKey) await storage.abort(c.storageKey, c.uploadId);
      await prisma.clip.updateMany({ where: { id: c.id, status: 'UPLOADING' }, data: { status: 'FAILED', uploadId: null } });
      aborted++;
    } catch (e) { log.error?.('[clips-api] sweep failed for', c.id, e && e.message); }
  }
  return { aborted };
}
