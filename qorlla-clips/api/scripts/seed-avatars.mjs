// Seeds the pre-built avatar catalog (InbuiltAvatar). Safe to run any number of times, on any database:
//   - it only INSERTS rows that do not exist (matched by slug); an existing row is never changed or deleted, because drafts point at
//     them and the catalog is immutable. A look that changes is a new entry with a new slug.
//   DATABASE_URL=... node scripts/seed-avatars.mjs
// The thumbnails and reference media are NOT shipped here: thumbnailUrl is left empty (the UI shows initials) and modelKey names where the
// media worker will find the reference clip. Nothing in this repo renders an avatar yet.
import { PrismaClient } from '@prisma/client';

export const CATALOG = [
  { slug: 'alex-corporate-presenter', name: 'Alex (Corporate Presenter)', tier: 'BASIC', modelKey: 'avatars/models/alex-corporate-presenter' },
  { slug: 'elena-casual-instructor', name: 'Elena (Casual Instructor)', tier: 'BASIC', modelKey: 'avatars/models/elena-casual-instructor' },
  { slug: 'marcus-studio-cinematic', name: 'Marcus (Studio Cinematic)', tier: 'MODERATE', modelKey: 'avatars/models/marcus-studio-cinematic' },
  { slug: 'chloe-studio-cinematic', name: 'Chloe (Studio Cinematic)', tier: 'MODERATE', modelKey: 'avatars/models/chloe-studio-cinematic' },
  { slug: 'zephyr-premium-anchor', name: 'Zephyr (Premium Anchor)', tier: 'ELITE', modelKey: 'avatars/models/zephyr-premium-anchor' },
  { slug: 'amara-ultra-presenter', name: 'Amara (Ultra Presenter)', tier: 'ELITE', modelKey: 'avatars/models/amara-ultra-presenter' },
];

export async function seedAvatars(prisma) {
  let added = 0;
  for (const a of CATALOG) {
    const have = await prisma.inbuiltAvatar.findUnique({ where: { slug: a.slug } });
    if (have) continue;
    await prisma.inbuiltAvatar.create({ data: a }); added++;
  }
  return { added, total: CATALOG.length };
}

if (process.argv[1] && process.argv[1].endsWith('seed-avatars.mjs')) {
  const prisma = new PrismaClient();
  seedAvatars(prisma)
    .then((r) => console.log(`avatar catalog: ${r.added} added, ${r.total - r.added} already present`))
    .catch((e) => { console.error('seeding the avatar catalog failed:', e.message); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
