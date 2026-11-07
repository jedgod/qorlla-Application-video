/**
 * Qorlla Meeting ingestion webhook. Mounted by app.js OUTSIDE the signed-in router (the caller is a server, not a person).
 *
 *   POST /api/webhooks/qorlla-ingest
 *     x-qorlla-timestamp: <unix seconds>
 *     x-qorlla-signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw request body>" with QORLLA_WEBHOOK_SECRET>
 *
 * Why it is safe to expose:
 *  - Disabled (404) unless QORLLA_WEBHOOK_SECRET is configured; the secret must be at least 32 characters (config.js refuses less).
 *  - The signature covers the exact bytes received (not a re-serialized object) and a timestamp, so a captured request cannot be replayed
 *    later (5 minute window) and a changed body fails. Compared in constant time, length checked first.
 *  - The server never fetches anything. It stores a LINK, and the link must be https on a host listed in MEDIA_HOSTS, so the payload
 *    cannot point at an internal address or a cloud metadata service. (https alone would not stop that.)
 *  - Premium only: the account's organization must not be on the "free" plan, the same rule that unlocks Upload video.
 *  - Idempotent: the same meeting id for the same organization returns the existing clip instead of creating another.
 *  - Nothing is created for an unknown e-mail address, and nothing is sent to anyone.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { cleanText } from './insights.js';

const WINDOW_SECONDS = 300;
const body = z.object({
  meetingId: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,120}$/),
  meetingTitle: z.string().max(300).optional(),
  ownerEmail: z.string().trim().toLowerCase().email().max(254),
  videoUrl: z.string().url().max(2000),
  durationSeconds: z.number().int().min(0).max(24 * 3600).optional(),
  sizeBytes: z.number().int().min(1).optional(),
}).strict();

export function signIngest(secret, timestamp, rawBody) {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

function signatureOk(secret, timestamp, rawBody, given, nowSeconds) {
  const ts = Number(timestamp);
  if (!/^\d{9,12}$/.test(String(timestamp || '')) || Math.abs(nowSeconds - ts) > WINDOW_SECONDS) return false;
  const want = Buffer.from(signIngest(secret, timestamp, rawBody));
  const got = Buffer.from(String(given || ''));
  return got.length === want.length && timingSafeEqual(got, want);          // timingSafeEqual throws on unequal lengths, so check first
}

export function registerIngest({ app, prisma, config, now = () => Date.now() }) {
  app.post('/api/webhooks/qorlla-ingest', async (req, res, next) => {
    try {
      if (!config.webhookSecret) return res.status(404).json({ error: 'not_found', message: 'Not found.' });
      const raw = req.rawBody;
      if (!Buffer.isBuffer(raw)) return res.status(400).json({ error: 'invalid_request', message: 'A JSON body is required.' });
      if (!req.headers['x-qorlla-signature']) return res.status(401).json({ error: 'unsigned', message: 'Missing signature.' });
      if (!signatureOk(config.webhookSecret, req.headers['x-qorlla-timestamp'], raw, req.headers['x-qorlla-signature'], Math.floor(now() / 1000))) {
        return res.status(403).json({ error: 'signature_mismatch', message: 'Signature mismatch or expired timestamp.' });
      }
      const b = body.safeParse(req.body);
      if (!b.success) return res.status(400).json({ error: 'invalid_request', message: 'The payload is not valid.', issues: b.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      const p = b.data;
      let u; try { u = new URL(p.videoUrl); } catch (e) { u = null; }
      if (!u || u.protocol !== 'https:' || u.username || u.password || !config.mediaHosts.includes(u.hostname.toLowerCase())) {
        return res.status(400).json({ error: 'invalid_media_host', message: 'videoUrl must be an https URL on an allowed media host.' });
      }
      const user = await prisma.user.findUnique({ where: { email: p.ownerEmail }, include: { organization: { select: { plan: true } } } });
      if (!user) return res.status(404).json({ error: 'unknown_account', message: 'No account has that e-mail address.' });
      if (user.organization.plan === 'free') {
        return res.status(403).json({ error: 'premium_required', code: 'PREMIUM_ENTITLEMENT_REQUIRED', message: 'Ingesting Qorlla meetings requires a paid plan.' });
      }
      const where = { organizationId: user.organizationId, externalId: p.meetingId };
      const existing = await prisma.clip.findFirst({ where });
      if (existing) return res.status(200).json({ clipId: existing.id, duplicate: true });
      let clip;
      try {
        clip = await prisma.clip.create({ data: {
          title: cleanText(p.meetingTitle, 200) || `Qorlla meeting ${new Date(now()).toISOString().slice(0, 10)}`,
          source: 'QORLLA_MEETING', status: 'READY', videoUrl: u.toString(), externalId: p.meetingId,
          durationMs: p.durationSeconds == null ? null : p.durationSeconds * 1000, sizeBytes: p.sizeBytes == null ? null : BigInt(p.sizeBytes),
          ownerId: user.id, organizationId: user.organizationId,
        } });
      } catch (e) {
        if (e && e.code === 'P2002') { const again = await prisma.clip.findFirst({ where }); if (again) return res.status(200).json({ clipId: again.id, duplicate: true }); }
        throw e;
      }
      res.status(201).json({ clipId: clip.id, duplicate: false });
    } catch (e) { next(e); }
  });
}
