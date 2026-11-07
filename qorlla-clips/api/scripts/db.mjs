// npm run db:push     create/update the schema directly (SQLite files, local development and tests)
// npm run db:migrate  apply the reviewed SQL migrations in prisma/migrations (PostgreSQL, production)
import { generate, prisma, providerOf, schemaFor } from './lib.mjs';

const [cmd] = process.argv.slice(2);
if (!['push', 'migrate'].includes(cmd)) { console.error('usage: node scripts/db.mjs push|migrate'); process.exit(2); }
const provider = providerOf(process.env.DATABASE_URL);
if (cmd === 'push') {
  const schema = generate();
  prisma(['db', 'push', '--schema', schema, '--skip-generate']);
} else {
  // applying migrations needs only the SQL files and a copy of the schema: it must not regenerate the client (a production image
  // runs as an unprivileged user that cannot write to node_modules, and the client was generated when the image was built)
  if (provider !== 'postgresql') { console.error('migrations are for PostgreSQL; use db:push for SQLite'); process.exit(2); }
  prisma(['migrate', 'deploy', '--schema', schemaFor('postgresql')]);
}
