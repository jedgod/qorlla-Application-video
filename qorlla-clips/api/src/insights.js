/**
 * Analytics, the PDF report, and moderation. Mounted on the authenticated /api router by app.js.
 *
 *   GET  /analytics/overview?days=30       real numbers from this organization's rows (admins: everyone's clips; members: their own)
 *   GET  /analytics/report.pdf?days=&title=  the same numbers as a PDF, built in memory and streamed (nothing is written to disk)
 *   POST /clips/:id/report                 any member who can see a clip may report it (once)
 *   GET  /admin/reports?status=OPEN        admins only
 *   POST /admin/reports/:id/resolve        admins only: dismiss, or move the clip to the trash. Every decision is audited.
 *   GET  /admin/audit                      admins only
 *
 * What "views" means: one playback link issued (recorded by uploads.js). Watch time is not measured, so it is not reported.
 * Nothing here sends e-mail: a report is downloaded by the person who asked for it.
 */
import { z } from 'zod';
import PDFDocument from 'pdfkit';

const MAX_ROWS = 50000;
const DAY = 24 * 3600 * 1000;

const q = z.object({ days: z.coerce.number().int().min(1).max(90).default(30), title: z.string().max(200).optional() });
const reportBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const resolveBody = z.object({ action: z.enum(['dismiss', 'trash']) }).strict();
const listQ = z.object({ status: z.enum(['OPEN', 'DISMISSED', 'ACTIONED']).default('OPEN') });

/** Removes control characters and caps the length: used for anything a person typed that ends up in a document or a header. */
export const cleanText = (s, max = 80) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
function bucketDays(dates, days, now) {
  const out = []; const start = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - (days - 1) * DAY;
  const counts = new Map();
  for (const d of dates) { const k = dayKey(d); counts.set(k, (counts.get(k) || 0) + 1); }
  for (let i = 0; i < days; i++) { const k = dayKey(start + i * DAY); out.push({ date: k, count: counts.get(k) || 0 }); }
  return out;
}

export async function computeOverview({ prisma, me, days, now = Date.now() }) {
  const admin = me.role === 'ADMIN';
  const since = new Date(now - days * DAY);
  const clipScope = { organizationId: me.orgId, ...(admin ? {} : { ownerId: me.id }) };
  const [clips, views, totals] = await Promise.all([
    prisma.clip.findMany({ where: { ...clipScope, createdAt: { gte: since } }, select: { createdAt: true, source: true }, take: MAX_ROWS }),
    prisma.playbackEvent.findMany({ where: { organizationId: me.orgId, createdAt: { gte: since }, clip: clipScope }, select: { createdAt: true, clipId: true }, take: MAX_ROWS }),
    prisma.clip.findMany({ where: { ...clipScope, isTrashed: false }, select: { status: true, sizeBytes: true } }),
  ]);
  const perClip = new Map(); for (const v of views) perClip.set(v.clipId, (perClip.get(v.clipId) || 0) + 1);
  const topIds = [...perClip.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const titles = topIds.length ? await prisma.clip.findMany({ where: { id: { in: topIds.map(([id]) => id) }, organizationId: me.orgId }, select: { id: true, title: true } }) : [];
  const title = new Map(titles.map((t) => [t.id, t.title]));
  const bySource = {}; for (const c of clips) bySource[c.source] = (bySource[c.source] || 0) + 1;
  return {
    scope: admin ? 'organization' : 'mine', days, generatedAt: new Date(now).toISOString(),
    totals: {
      clips: totals.length, ready: totals.filter((c) => c.status === 'READY').length,
      storageBytes: totals.reduce((n, c) => n + (c.sizeBytes == null ? 0 : Number(c.sizeBytes)), 0),
      clipsInPeriod: clips.length, viewsInPeriod: views.length,
    },
    clipsPerDay: bucketDays(clips.map((c) => c.createdAt), days, now),
    viewsPerDay: bucketDays(views.map((v) => v.createdAt), days, now),
    bySource, topClips: topIds.map(([id, n]) => ({ id, title: title.get(id) || '(deleted)', views: n })),
  };
}

const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);

/** Renders the overview to a PDF stream. Pure function of its inputs, so it can be tested without HTTP. */
export function renderReportPdf(overview, { title, orgName }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: title, Author: 'Qorlla Clips' } });
  doc.fontSize(22).fillColor('#111').text(title);
  doc.moveDown(0.3).fontSize(10).fillColor('#666').text(`${orgName} - ${overview.scope === 'organization' ? 'whole organization' : 'my clips only'} - last ${overview.days} days - generated ${overview.generatedAt}`);
  doc.moveDown();
  const rows = [['Clips (not in trash)', overview.totals.clips], ['Ready to play', overview.totals.ready], ['Storage used', fmtBytes(overview.totals.storageBytes)],
    [`Clips created, last ${overview.days} days`, overview.totals.clipsInPeriod], [`Playback links issued, last ${overview.days} days`, overview.totals.viewsInPeriod]];
  doc.fontSize(13).fillColor('#111').text('Summary').moveDown(0.3);
  for (const [k, v] of rows) doc.fontSize(11).fillColor('#333').text(`${k}: `, { continued: true }).fillColor('#000').text(String(v));
  doc.moveDown().fontSize(13).fillColor('#111').text('Top clips by playback').moveDown(0.3);
  if (!overview.topClips.length) doc.fontSize(11).fillColor('#666').text('No playback in this period.');
  overview.topClips.forEach((c, i) => doc.fontSize(11).fillColor('#333').text(`${i + 1}. ${cleanText(c.title, 100)} - ${c.views}`));
  doc.moveDown().fontSize(13).fillColor('#111').text('Clips by source').moveDown(0.3);
  const src = Object.entries(overview.bySource);
  if (!src.length) doc.fontSize(11).fillColor('#666').text('No clips created in this period.');
  src.forEach(([k, n]) => doc.fontSize(11).fillColor('#333').text(`${k}: ${n}`));
  doc.moveDown().fontSize(8).fillColor('#888').text('"Playback links issued" counts how often a playback link was requested. Watch time is not measured.');
  doc.end();
  return doc;
}

export function registerInsights({ api, prisma, wrap, notFound, uuid, viewable }) {
  const admin = (req, res, next) => (req.user.role === 'ADMIN' ? next() : res.status(403).json({ error: 'forbidden', message: 'Only organization admins can do that.' }));

  api.get('/analytics/overview', wrap(async (req, res) => {
    const { days } = q.parse(req.query);
    res.json(await computeOverview({ prisma, me: req.user, days }));
  }));

  api.get('/analytics/report.pdf', wrap(async (req, res) => {
    const { days, title } = q.parse(req.query);
    const o = await computeOverview({ prisma, me: req.user, days });
    const org = await prisma.organization.findUnique({ where: { id: req.user.orgId }, select: { name: true } });
    const t = cleanText(title) || 'Clips activity report';
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="clips-report.pdf"' });
    renderReportPdf(o, { title: t, orgName: cleanText(org && org.name, 80) }).pipe(res);
  }));

  api.post('/clips/:id/report', wrap(async (req, res) => {
    const me = req.user; const id = uuid.safeParse(req.params.id); if (!id.success) return notFound(res);
    const clip = await viewable(me, id.data); if (!clip) return notFound(res);
    const { reason } = reportBody.parse(req.body || {});
    if (clip.ownerId === me.id) return res.status(400).json({ error: 'own_clip', message: 'You cannot report your own clip.' });
    try { await prisma.clipReport.create({ data: { clipId: clip.id, organizationId: me.orgId, reporterId: me.id, reason: cleanText(reason, 500) } }); }
    catch (e) { if (e && e.code !== 'P2002') throw e; }                              // reporting twice is the same as once
    res.status(201).json({ ok: true });
  }));

  api.get('/admin/reports', admin, wrap(async (req, res) => {
    const { status } = listQ.parse(req.query);
    const rows = await prisma.clipReport.findMany({ where: { organizationId: req.user.orgId, status }, orderBy: { createdAt: 'desc' }, take: 100, include: { clip: { select: { id: true, title: true, isTrashed: true, owner: { select: { name: true, email: true } } } } } });
    res.json({ reports: rows.map((r) => ({ id: r.id, reason: r.reason, status: r.status, createdAt: r.createdAt, clip: { id: r.clip.id, title: r.clip.title, isTrashed: r.clip.isTrashed, ownerName: r.clip.owner.name || r.clip.owner.email } })) });
  }));

  api.post('/admin/reports/:id/resolve', admin, wrap(async (req, res) => {
    const me = req.user; const id = uuid.safeParse(req.params.id); if (!id.success) return notFound(res);
    const { action } = resolveBody.parse(req.body || {});
    const report = await prisma.clipReport.findFirst({ where: { id: id.data, organizationId: me.orgId } });
    if (!report) return notFound(res);
    if (report.status !== 'OPEN') return res.status(409).json({ error: 'already_resolved', message: 'This report was already reviewed.' });
    const status = action === 'trash' ? 'ACTIONED' : 'DISMISSED';
    // claim the report first so two admins cannot both act on it
    const claimed = await prisma.clipReport.updateMany({ where: { id: report.id, status: 'OPEN' }, data: { status, resolvedById: me.id, resolvedAt: new Date() } });
    if (claimed.count !== 1) return res.status(409).json({ error: 'already_resolved', message: 'This report was already reviewed.' });
    if (action === 'trash') {
      const clip = await prisma.clip.findFirst({ where: { id: report.clipId, organizationId: me.orgId } });
      if (clip && !clip.isTrashed) {
        await prisma.clip.update({ where: { id: clip.id }, data: { isTrashed: true, trashedAt: new Date() } });
        await prisma.notification.create({ data: { userId: clip.ownerId, type: 'moderation', message: `"${cleanText(clip.title, 100)}" was moved to the trash after a report.`, clipId: clip.id } });
      }
    }
    await prisma.auditLog.create({ data: { organizationId: me.orgId, actorId: me.id, action: action === 'trash' ? 'report.trash_clip' : 'report.dismiss', clipId: report.clipId, detail: `report ${report.id}` } });
    res.json({ id: report.id, status });
  }));

  api.get('/admin/audit', admin, wrap(async (req, res) => {
    const rows = await prisma.auditLog.findMany({ where: { organizationId: req.user.orgId }, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json({ entries: rows.map((r) => ({ id: r.id, action: r.action, actorId: r.actorId, clipId: r.clipId, detail: r.detail, createdAt: r.createdAt })) });
  }));
}
