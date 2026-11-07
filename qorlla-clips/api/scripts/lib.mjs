// Picks the database provider from DATABASE_URL and runs Prisma against a COPY of schema.prisma with that provider,
// so the committed schema (postgresql) is never edited and the same code runs on SQLite (tests) and PostgreSQL (production).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function providerOf(url) {
  if (!url) throw new Error('DATABASE_URL is required');
  if (/^file:/i.test(url)) return 'sqlite';
  if (/^postgres(ql)?:/i.test(url)) return 'postgresql';
  throw new Error('DATABASE_URL must start with file: (SQLite) or postgresql:// (PostgreSQL)');
}

/** Writes prisma/schema.generated.<provider>.prisma and returns its path. */
export function schemaFor(provider) {
  const src = readFileSync(path.join(root, 'prisma', 'schema.prisma'), 'utf8');
  const out = src.replace(/(datasource db \{[^}]*provider\s*=\s*)"[a-z]+"/, `$1"${provider}"`);
  if (out === src && provider !== 'postgresql') throw new Error('could not set the provider in schema.prisma');
  // beside schema.prisma, because Prisma looks for the migrations/ folder next to the schema file it is given
  const dir = path.join(root, 'prisma');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `schema.generated.${provider}.prisma`);
  writeFileSync(file, out);
  return file;
}

export function prisma(args, env = process.env) {
  const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma');
  const r = spawnSync(bin, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`prisma ${args.join(' ')} failed (${r.status})`);
}

/** Generates the client for the provider of DATABASE_URL. */
export function generate(env = process.env) {
  const schema = schemaFor(providerOf(env.DATABASE_URL));
  prisma(['generate', '--schema', schema], env);
  return schema;
}
