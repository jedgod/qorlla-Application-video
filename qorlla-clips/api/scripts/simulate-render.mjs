// DEVELOPMENT ONLY. There is no avatar renderer yet, so a draft stays "Processing" forever. This script stands in for the missing media worker
// so the Ready -> Save to My clips -> My clips path can be tried on localhost. It does NOT render anything: it attaches a public sample video
// and marks the title "[dev test render]" so nobody mistakes the result for a real avatar.
//
//   node scripts/simulate-render.mjs <draft-uuid>      one draft
//   node scripts/simulate-render.mjs --all             every draft still waiting (not promoted)
//   DEV_SAMPLE_VIDEO_URL=https://...                   use another https sample video
//
// Refuses to run with NODE_ENV=production or against a database that is not on this machine. Needs DATABASE_URL (api/.env is read).
import { PrismaClient } from '@prisma/client';

const SAMPLE = process.env.DEV_SAMPLE_VIDEO_URL || 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const TAG = ' [dev test render]';
const arg = process.argv[2];

function refuse(msg) { console.error('Refused: ' + msg); process.exit(1); }

if (process.env.NODE_ENV === 'production') refuse('NODE_ENV=production. This script is for local development only.');
const url = process.env.DATABASE_URL || '';
if (!url) refuse('DATABASE_URL is not set.');
if (!url.startsWith('file:')) {
  let host = ''; try { host = new URL(url).hostname; } catch (e) { /* not a URL */ }
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) refuse(`the database host "${host || 'unknown'}" is not this machine.`);
}
let sample; try { sample = new URL(SAMPLE); } catch (e) { sample = null; }
if (!sample || sample.protocol !== 'https:') refuse('the sample video must be an https URL.');
if (!arg || (arg !== '--all' && !/^[0-9a-f-]{36}$/i.test(arg))) refuse('give a draft UUID, or --all.');

const prisma = new PrismaClient();
try {
  const where = arg === '--all' ? { isPromoted: false, status: 'PROCESSING' } : { id: arg, isPromoted: false };
  const drafts = await prisma.avatarDraft.findMany({ where, select: { id: true, title: true } });
  if (drafts.length === 0) refuse(arg === '--all' ? 'no draft is waiting for a render.' : 'no such draft, or it was already saved to My clips (its media is frozen).');
  for (const d of drafts) {
    await prisma.avatarDraft.update({
      where: { id: d.id },
      data: { status: 'READY', videoUrl: SAMPLE, title: d.title.endsWith(TAG) ? d.title : (d.title + TAG).slice(0, 200) },
    });
    console.log(`READY (sample video attached): ${d.id}`);
  }
  console.log('This is a stand-in, not a real render. Refresh the Avatars page, then use "Save to My clips".');
} finally { await prisma.$disconnect(); }
