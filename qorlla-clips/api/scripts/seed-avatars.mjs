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
  { slug: 'sarah-technical-trainer', name: 'Sarah (Technical Trainer)', tier: 'BASIC', modelKey: 'avatars/models/sarah-technical-trainer' },
  { slug: 'david-executive-speaker', name: 'David (Executive Speaker)', tier: 'BASIC', modelKey: 'avatars/models/david-executive-speaker' },
  { slug: 'maya-product-evangelist', name: 'Maya (Product Evangelist)', tier: 'BASIC', modelKey: 'avatars/models/maya-product-evangelist' },
  { slug: 'james-creative-director', name: 'James (Creative Director)', tier: 'BASIC', modelKey: 'avatars/models/james-creative-director' },
  { slug: 'aisha-support-ambassador', name: 'Aisha (Support Ambassador)', tier: 'BASIC', modelKey: 'avatars/models/aisha-support-ambassador' },
  { slug: 'oliver-hr-liaison', name: 'Oliver (HR Liaison)', tier: 'BASIC', modelKey: 'avatars/models/oliver-hr-liaison' },
  { slug: 'marcus-studio-cinematic', name: 'Marcus (Studio Cinematic)', tier: 'PRO', modelKey: 'avatars/models/marcus-studio-cinematic' },
  { slug: 'chloe-studio-cinematic', name: 'Chloe (Studio Cinematic)', tier: 'PRO', modelKey: 'avatars/models/chloe-studio-cinematic' },
  { slug: 'priya-business-presenter', name: 'Priya (Business Presenter)', tier: 'BUSINESS', modelKey: 'avatars/models/priya-business-presenter' },
  { slug: 'daniel-business-presenter', name: 'Daniel (Business Presenter)', tier: 'BUSINESS', modelKey: 'avatars/models/daniel-business-presenter' },
  { slug: 'zephyr-premium-anchor', name: 'Zephyr (Premium Anchor)', tier: 'ENTERPRISE', modelKey: 'avatars/models/zephyr-premium-anchor' },
  { slug: 'amara-ultra-presenter', name: 'Amara (Ultra Presenter)', tier: 'ENTERPRISE', modelKey: 'avatars/models/amara-ultra-presenter' },
];

export async function seedAvatars(prisma) {
  // A database made before the 4-tier model (for example a local SQLite file) may still hold the old tier names; PostgreSQL is renamed by
  // migration 0006, where this statement simply fails and is ignored. It only renames values, it never touches a row's identity.
  for (const [from, to] of [['MODERATE', 'PRO'], ['ELITE', 'ENTERPRISE']]) {
    try { await prisma.$executeRawUnsafe(`UPDATE "InbuiltAvatar" SET "tier" = '${to}' WHERE "tier" = '${from}'`); } catch (e) { /* already on the new names */ }
  }
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
