/**
 * Web-tier client for the internal administration service. The web process verifies the user's LIVE session first (the main
 * application's own getUser), then signs a short-lived assertion for exactly one route and calls the service. The web process
 * never holds qorlla_sub_admin and never touches the administration tables.
 */

import { createHash } from 'node:crypto';
import { signAssertion } from './assertion.js';
import { ROUTES, fillPath } from './adminRoutes.js';

const sha256 = (v) => createHash('sha256').update(v).digest('hex');

/** The session identifier the step-up grants are bound to: sha256 of the session cookie token (the same value auth.js stores). */
export function sessionHashOf(req, cookieName = 'qs') {
  const header = req?.headers?.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === cookieName) {
      const token = decodeURIComponent(part.slice(i + 1).trim());
      return token ? sha256(token) : null;
    }
  }
  return null;
}

export function createAdminClient({ baseUrl, key, fetchImpl = globalThis.fetch, ttlMs = 30_000 }) {
  if (!baseUrl) throw new Error('baseUrl required');
  if (typeof key !== 'string' || key.length < 32) throw new Error('key must be at least 32 characters');
  return {
    /**
     * @param {keyof typeof ROUTES} name
     * @param {{userId:string, sessionHash:string, customerId?:string, params?:object, body?:object}} c
     */
    async call(name, { userId, sessionHash, customerId, params = {}, body }) {
      const route = ROUTES[name];
      if (!route) throw new Error(`unknown admin route ${name}`);
      const token = signAssertion({ sub: userId, sid: sessionHash, act: route.act, cid: customerId, ttlMs }, key);
      const res = await fetchImpl(baseUrl + fillPath(route, { cid: customerId, ...params }), {
        method: route.method,
        headers: { 'content-type': 'application/json', 'x-qorlla-assertion': token },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
  };
}
