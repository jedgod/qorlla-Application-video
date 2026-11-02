// Shared E2E helpers: real sign-up through MAIN, DB assertions through docker exec, control of the provider test double.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const BASE = process.env.E2E_BASE || 'https://localhost:18443';
const FAKE = process.env.E2E_FAKE_STRIPE_URL || 'http://127.0.0.1:19500';
const DB_CONTAINER = process.env.E2E_DB_CONTAINER;
const WEBHOOK_URL = BASE + '/api/v1/billing/webhook';

function dbq(sql) {
  if (!DB_CONTAINER) throw new Error('E2E_DB_CONTAINER is not set');
  return execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', 'qorlla_main', '-d', 'qorlla_main', '-tAc', sql], { encoding: 'utf8' }).trim();
}
const fakeJson = async (path, body) => (await fetch(FAKE + path, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined })).json();

/** Registers a brand-new MAIN account in this browser context (cookies are set exactly as a real sign-up sets them). */
async function signUp(context, label = 'e2e') {
  const username = (label + crypto.randomBytes(4).toString('hex')).toLowerCase().slice(0, 20);
  const r = await context.request.post('/api/auth/register', { data: { username, displayName: 'E2E ' + label, password: 'E2e-pass-' + crypto.randomBytes(5).toString('hex') + '!8' } });
  if (r.status() !== 201) throw new Error('register failed ' + r.status() + ' ' + (await r.text()));
  return { username, user: (await r.json()).user };
}
/** Sign-up + workspace (what the portal onboarding does). Returns workspace id. */
async function signUpWithWorkspace(context, label) {
  const me = await signUp(context, label);
  const cookies = await context.cookies(); const csrf = cookies.find((c) => c.name === 'qorlla_csrf').value;
  const w = await context.request.post('/api/v1/workspaces', { data: { name: 'E2E ' + label }, headers: { 'x-csrf-token': csrf, origin: BASE } });
  if (w.status() !== 201) throw new Error('workspace failed ' + w.status());
  return { ...me, workspaceId: (await w.json()).workspace_id, csrf };
}
/** Deliver the signed paid-invoice webhook the provider would send after the customer pays the given checkout. */
async function providerPays({ checkoutId, workspaceId, unitAmount, interval, quantity }) {
  const ev = await fakeJson('/__control/paid-event', { checkoutId, workspaceId, unitAmount, interval, quantity });
  return { ...(await redeliver(ev)), ev };
}
async function redeliver(ev) {
  const r = await fetch(WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': ev.signature }, body: ev.body });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const money = (cents) => '$' + (cents / 100).toFixed(2);
module.exports = { BASE, dbq, fakeJson, signUp, signUpWithWorkspace, providerPays, redeliver, money };
