/**
 * Seed the feature catalog and plan entitlements, then prove the database mirror matches src/plans.js.
 * Run as the MIGRATOR role:   DATABASE_URL=postgres://migrator:...@host/db node examples/seed-entitlements.js
 */

import pg from 'pg';
import { seedCatalog, verifyCatalog } from '../src/seed.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  await seedCatalog(pool);
  const check = await verifyCatalog(pool);
  if (!check.ok) {
    console.error('Catalog drift after seeding:\n' + check.differences.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Seed complete; database catalog matches src/plans.js');
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
