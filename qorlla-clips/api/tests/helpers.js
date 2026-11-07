import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let seq = 0;
export const uniq = (p = 'x') => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

export const prisma = new PrismaClient();

export function configFor(over = {}) {
  return { ...loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, AUTH_MODE: 'dev' }), rateLimitPerMinute: 100000, ...over };
}

export async function start(over = {}, fetchImpl) {
  const app = createApp({ prisma, config: configFor(over), fetchImpl });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** A dev-mode caller in an organization (created on first use). */
export const who = (email, org, role) => ({ email, org, role });

export async function call(base, caller, method, path, body, extra = {}) {
  const headers = { 'x-requested-with': 'qorlla-clips', ...extra };
  if (caller) { headers['x-dev-user'] = caller.email; if (caller.org) headers['x-dev-org'] = caller.org; if (caller.role) headers['x-dev-role'] = caller.role; }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: r.status, body: json, text, headers: r.headers };
}

/** A fresh organization with an admin and two members. */
export async function world(base, { plan } = {}) {
  const org = uniq('org');
  const a = who(`admin-${org}@t.test`, org, 'admin'), m1 = who(`ann-${org}@t.test`, org), m2 = who(`bob-${org}@t.test`, org);
  for (const u of [a, m1, m2]) await call(base, u, 'GET', '/api/me');
  if (plan) await prisma.organization.update({ where: { slug: org }, data: { plan } });
  return { org, a, m1, m2 };
}
