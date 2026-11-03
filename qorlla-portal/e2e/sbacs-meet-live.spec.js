const { test, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { BASE, dbq, signUpWithWorkspace } = require('./helpers');

// SBACS enforcement inside Meet, LIVE: the real Meet server, the real portal entitlement API, real PostgreSQL, real container outages. Isolated "qsbacs" project only (SBACS_MODE=enforce on its Meet).
//   E2E_BASE=http://localhost:4100  E2E_MEET_INTERNAL=http://localhost:4102  E2E_BRIDGE_SECRET=<project secret>  E2E_DB_CONTAINER=qsbacs-main-db-1  E2E_MEET_DB_CONTAINER=qsbacs-meet-db-1  E2E_PORTAL_CONTAINER=qsbacs-qorlla-portal-1
// Never run against qiso, qtls, qclk or a production-default environment: it stops and starts the portal container.
const MEET = process.env.E2E_MEET_INTERNAL || 'http://localhost:4102', BRIDGE = process.env.E2E_BRIDGE_SECRET || '';
const MEET_DB = process.env.E2E_MEET_DB_CONTAINER || 'qsbacs-meet-db-1', PORTAL = process.env.E2E_PORTAL_CONTAINER || 'qsbacs-qorlla-portal-1';
const MIB = 1024 * 1024;
const mq = (sql) => execFileSync('docker', ['exec', MEET_DB, 'sh', '-c', `psql -U "\${POSTGRES_USER:-postgres}" -d "\${POSTGRES_DB:-postgres}" -tAc "${sql.replace(/"/g, '\\"')}"`], { encoding: 'utf8' }).trim();
const usage = (ws, f) => dbq(`SELECT coalesce(used,0)||'/'||coalesce(reserved,0) FROM portal.subscription_usage WHERE workspace_id='${ws}' AND feature='${f}'`) || '0/0';
const setPlan = (ws, plan) => dbq(`UPDATE portal.subscriptions SET plan_slug='${plan}', status='active', billing_interval='month', current_period_end=now()+interval '20 days' WHERE workspace_id='${ws}'`);
const portal = (cmd) => execFileSync('docker', [cmd, PORTAL], { encoding: 'utf8' });
const waitPortal = async () => { for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/v1/health')).ok) return; } catch { /* still down */ } await new Promise((r) => setTimeout(r, 1000)); } throw new Error('portal did not come back'); };
const until = async (fn, ms = 30000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 500)); } };

async function owner(browser, label, plan = 'pro') {
  const ctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true }); const w = await signUpWithWorkspace(ctx, label); if (plan !== 'basic') setPlan(w.workspaceId, plan);
  return { ctx, ws: w.workspaceId, account: w.user.id };
}
const bridge = async (account, sourceId = 'live-' + crypto.randomBytes(5).toString('hex')) => {
  const r = await fetch(MEET + '/api/integrations/scheduled-meetings', { method: 'POST', headers: { 'content-type': 'application/json', 'x-qorlla-bridge-secret': BRIDGE }, body: JSON.stringify({ sourceId, title: 'SBACS live', ownerName: 'Host', ...(account ? { hostAccountId: account } : {}) }) });
  return { status: r.status, sourceId, body: await r.json().catch(() => ({})) };
};
const host = async (m) => { const r = await fetch(`${MEET}/api/meetings/${m.body.meetingId}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Host', hostSecret: m.body.hostSecret }) }); const b = await r.json(); return { status: r.status, token: b.token, pid: b.participantId, id: m.body.meetingId }; };
const call = async (h, path, method = 'GET', body) => { const r = await fetch(`${MEET}/api/v1/meetings/${h.id}${path}`, { method, headers: { authorization: 'Bearer ' + h.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const alive = async (h) => (await fetch(`${MEET}/api/meetings/${h.id}`, { headers: { authorization: 'Bearer ' + h.token } })).status;     // the meeting itself, as any participant sees it
const chunk = async (h, rid, seq, bytes) => { const r = await fetch(`${MEET}/api/v1/meetings/${h.id}/recordings/${rid}/chunks?seq=${seq}`, { method: 'POST', headers: { authorization: 'Bearer ' + h.token, 'content-type': 'application/octet-stream' }, body: crypto.randomBytes(bytes) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const REQ = { purpose: 'SBACS live test', recipients: 'The team', retentionDays: 30, privacyContact: 'privacy@example.test', controller: 'Test host' };
async function startedRecording(h) { const rq = await call(h, '/recording/request', 'POST', REQ); if (rq.status !== 201) return { rq }; const st = await call(h, '/recording/start', 'POST'); return { rq, st, rid: st.body.recordingId }; }

test.describe('Meet + SBACS (live, isolated stack)', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => { expect(BRIDGE).not.toBe(''); await until(() => mq('select count(*) from sbacs_outbox where settled_at is null') === '0'); });   // anything left from an earlier run has settled
  test.afterAll(async () => { try { portal('start'); } catch { /* already running */ } await waitPortal(); });

  test('meeting creation: entitlement per host account; no account, no workspace and suspension are refused; a retry of an existing meeting is never refused; consent-free flows are untouched', async ({ browser }) => {
    const pro = await owner(browser, 'mcPro'), free = await owner(browser, 'mcFree', 'basic'); const loner = await signUpWithWorkspace(await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true }), 'mcNone');
    dbq(`DELETE FROM portal.members WHERE workspace_id='${loner.workspaceId}'`);                                                // an account that belongs to no workspace
    expect((await bridge(pro.account)).status).toBe(201); expect((await bridge(free.account)).status).toBe(201);
    const none = await bridge(loner.user.id); expect([none.status, none.body.reason]).toEqual([403, 'no_workspace']); const anon = await bridge(null); expect([anon.status, anon.body.reason]).toEqual([403, 'no_account']);
    const m = await bridge(pro.account); expect(m.status).toBe(201);
    dbq(`UPDATE portal.workspaces SET suspended_at=now() WHERE id='${pro.ws}'`);
    const susp = await bridge(pro.account); expect([susp.status, susp.body.reason]).toEqual([403, 'account_suspended']);
    const again = await bridge(pro.account, m.sourceId); expect([again.status, again.body.created]).toEqual([200, false]);                       // the same meeting, asked again: not a new meeting
    const h = await host(m); expect(h.status).toBe(200);                                                                                      // and a meeting that exists can still be joined
    dbq(`UPDATE portal.workspaces SET suspended_at=NULL WHERE id='${pro.ws}'`); expect((await bridge(pro.account)).status).toBe(201);
    for (const x of [pro, free]) await x.ctx.close();
  });

  test('recording: Free is refused at the request, Professional may request and start; one metered recording per started session; consent flow unchanged', async ({ browser }) => {
    const free = await owner(browser, 'recFree', 'basic'), pro = await owner(browser, 'recPro');
    const hf = await host(await bridge(free.account)); const no = await call(hf, '/recording/request', 'POST', REQ); expect([no.status, no.body.error, no.body.reason]).toEqual([403, 'subscription_access_denied', 'not_in_plan']);
    const hp = await host(await bridge(pro.account)); const r = await startedRecording(hp); expect([r.rq.status, r.st.status]).toEqual([201, 200]); expect(usage(pro.ws, 'meet.recording')).toBe('1/0');
    const again = await call(hp, '/recording/start', 'POST'); expect(again.status).toBe(409); expect(usage(pro.ws, 'meet.recording')).toBe('1/0');   // a second start is refused by Meet itself and charges nothing
    for (const x of [free, pro]) await x.ctx.close();
  });

  test('storage: bytes are reserved before they are accepted and finalized when stored, in 1 MiB blocks; a retried chunk is not charged twice; quota refuses new media and keeps what is stored', async ({ browser }) => {
    const pro = await owner(browser, 'stor'); const h = await host(await bridge(pro.account)); const { rid } = await startedRecording(h);
    const sizes = [400_000, 700_000, 1_200_000]; for (const [i, s] of sizes.entries()) expect((await chunk(h, rid, i, s)).status).toBe(201);
    const total = sizes.reduce((a, b) => a + b, 0); expect(usage(pro.ws, 'storage.mb')).toBe(`${Math.ceil(total / MIB)}/0`);
    const dup = await chunk(h, rid, 1, 700_000); expect([dup.status, dup.body.duplicate]).toEqual([200, true]); expect(usage(pro.ws, 'storage.mb')).toBe(`${Math.ceil(total / MIB)}/0`);
    dbq(`INSERT INTO portal.entitlement_overrides(workspace_id,feature,enabled,quota,reason,created_by) VALUES('${pro.ws}','storage.mb',true,3,'live test ceiling','${crypto.randomUUID()}')`);
    const over = await chunk(h, rid, 3, 2 * MIB); expect([over.status, over.body.error]).toEqual([403, 'storage_quota_reached']);
    const status = await fetch(`${MEET}/api/v1/meetings/${h.id}/recordings/${rid}/status`, { headers: { authorization: 'Bearer ' + h.token } }); expect(Number((await status.json()).bytes)).toBe(total);   // what was stored is untouched
    expect(usage(pro.ws, 'storage.mb')).toBe(`${Math.ceil(total / MIB)}/0`); await pro.ctx.close();
  });

  test('suspension in the middle of a recording: media keeps being stored within the grace and is recorded afterwards; a new meeting is refused; the meeting is not interrupted', async ({ browser }) => {
    const pro = await owner(browser, 'susp'); const h = await host(await bridge(pro.account)); const { rid } = await startedRecording(h);
    expect((await chunk(h, rid, 0, 1 * MIB)).status).toBe(201); expect(usage(pro.ws, 'storage.mb')).toBe('1/0');
    dbq(`UPDATE portal.workspaces SET suspended_at=now() WHERE id='${pro.ws}'`);
    expect((await chunk(h, rid, 1, 2 * MIB)).status).toBe(201);                                                                               // already authorised: not cut off
    const refused = await bridge(pro.account); expect([refused.status, refused.body.reason]).toEqual([403, 'account_suspended']);
    expect(await alive(h)).toBe(200);                                                                                              // the meeting itself carries on
    expect((await chunk(h, rid, 2, 3 * MIB)).status).toBe(403);                                                                                // 2 + 3 MiB deferred > the 4 MiB grace: refused
    await until(() => mq(`select count(*) from sbacs_outbox where settled_at is null`) === '0'); expect(usage(pro.ws, 'storage.mb')).toBe('3/0');      // delivered media recorded, once
    dbq(`UPDATE portal.workspaces SET suspended_at=NULL WHERE id='${pro.ws}'`); await pro.ctx.close();
  });

  test('entitlement service outage in the middle of a recording: new meetings fail closed (503), the live recording and meeting continue within the grace, and usage is settled exactly once after recovery', async ({ browser }) => {
    const pro = await owner(browser, 'outage'); const m = await bridge(pro.account); const h = await host(m); const { rid } = await startedRecording(h);
    expect((await chunk(h, rid, 0, 1 * MIB)).status).toBe(201); expect(usage(pro.ws, 'storage.mb')).toBe('1/0');
    portal('stop');
    try {
      const down = await bridge(pro.account); expect([down.status, down.body.error, down.body.retryable]).toEqual([503, 'entitlement_service_unavailable', true]);
      expect((await bridge(pro.account, m.sourceId)).status).toBe(200);                                                                        // the existing meeting is still the same meeting
      expect((await chunk(h, rid, 1, 2 * MIB)).status).toBe(201); expect(await alive(h)).toBe(200);                                 // media accepted, meeting unaffected
      expect((await chunk(h, rid, 2, 3 * MIB)).status).toBe(503);                                                                              // beyond the grace: fail closed
      expect(mq(`select count(*) from sbacs_outbox where settled_at is null`)).toBe('1');
    } finally { portal('start'); await waitPortal(); }
    await until(() => mq(`select count(*) from sbacs_outbox where settled_at is null`) === '0', 60000);
    expect(usage(pro.ws, 'storage.mb')).toBe('3/0');                                                                                           // 1 + 2 MiB, once
    expect((await bridge(pro.account)).status).toBe(201);                                                                                      // recovered: new meetings work again
    await pro.ctx.close();
  });
});
