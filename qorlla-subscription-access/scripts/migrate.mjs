// Applies pending migrations. Run as the MIGRATOR (table owner):  DATABASE_URL=postgres://migrator:...@host/db node scripts/migrate.mjs
import { migrate } from '../src/migrate.js';

try {
  const applied = await migrate({ log: (m) => console.log(m) });
  console.log(applied.length ? `applied ${applied.length} migration(s)` : 'schema is up to date');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
