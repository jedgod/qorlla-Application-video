import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { configProblems, createSipGateway, type SipGatewayConfig } from '../src/sip-gateway.js';
import { ha1 } from '../src/sip/digest.js';
import type { Readiness } from '../src/admission.js';
import { SyntheticPhone } from './helpers/synthetic-phone.js';

const good = (): SipGatewayConfig => ({ enabled: true, sip: { host: '127.0.0.1', port: 0, realm: 'qorlla-gw', allowedSources: ['127.0.0.1'], maxCalls: 4 }, digest: { secret: crypto.randomBytes(32), ha1ByUser: { trunk1: ha1('SHA-256', 'trunk1', 'qorlla-gw', 'trunk-secret') } },
  media: { bindHost: '127.0.0.1', publicHost: '127.0.0.1', portRange: [32000, 32100] } });
const deps = (ready: Partial<Readiness> = {}) => ({ authority: { verifyPhoneJoin: async () => ({ allowed: false, requiresHostApproval: false }), requestHostApproval: async () => false }, reporter: { reportMedia: async () => ({ result: 'rejected' }) },
  meeting: { open: async () => { throw new Error('no meeting audio in this test'); } }, readiness: async () => ({ carrierConnected: false, inboundNumberCertified: false, gatewayHealthy: false, mediaBridgeCertified: false, billingCertified: false, productionApproved: false, ...ready }) });

test('a complete configuration has no problems; every missing or unsafe part is named and stops the gateway from starting', () => {
  assert.deepEqual(configProblems(good()), []);
  const bad: [string, (c: SipGatewayConfig) => void, RegExp][] = [
    ['disabled by default', (c) => { c.enabled = false; }, /not enabled/], ['short secret', (c) => { c.digest.secret = crypto.randomBytes(8); }, /at least 32 bytes/], ['no credentials', (c) => { c.digest.ha1ByUser = {}; }, /no SIP credentials/],
    ['a plaintext password as a credential', (c) => { c.digest.ha1ByUser = { trunk1: 'trunk-secret' }; }, /HA1 hash, never a password/], ['empty allowlist', (c) => { c.sip.allowedSources = []; }, /allowlist is empty/],
    ['allow everyone outside lab mode', (c) => { c.sip.allowedSources = ['0.0.0.0/0']; }, /every address/], ['no realm', (c) => { c.sip.realm = ''; }, /no digest realm/], ['too many calls', (c) => { c.sip.maxCalls = 5000; }, /maxCalls/],
    ['bad port range', (c) => { c.media.portRange = [80, 90]; }, /port range is invalid/], ['range too small for the call limit', (c) => { c.sip.maxCalls = 100; c.media.portRange = [32000, 32010]; }, /smaller than twice/],
    ['plain RTP outside lab mode', (c) => { c.media.allowPlainRtp = true; }, /plain RTP is only allowed in lab mode/], ['lab mode on a routable address', (c) => { c.labMode = true; c.media.publicHost = '203.0.113.9'; }, /publicly routable/],
    ['no media hosts', (c) => { c.media.bindHost = ''; }, /bindHost and publicHost/]];
  for (const [name, mutate, re] of bad) { const c = good(); mutate(c); const p = configProblems(c); assert.ok(p.some((x) => re.test(x)), name + ': ' + p.join(' | ')); assert.throws(() => createSipGateway(c, deps()), /telephone gateway not started/, name); }
  assert.deepEqual(configProblems(null), ['no configuration']); const lab = good(); lab.labMode = true; lab.media.allowPlainRtp = true; assert.deepEqual(configProblems(lab), [], 'lab mode on a private address may relax encryption');
});
test('an enabled and complete gateway still serves nobody while readiness evidence is missing: every call is refused 503 and no media port is opened', async () => {
  const gw = createSipGateway(good(), deps()), addr = await gw.start(); try {
    const phone = await SyntheticPhone.create({ gateway: addr }); try { assert.equal((await phone.invite()).status, 503); assert.equal(gw.health().activeLegs, 0); assert.equal(phone.responses(200).length, 0); } finally { phone.close(); }
    assert.equal(gw.health().sip.invitesAccepted, 1, 'the call was authenticated and then refused by readiness, not by chance');
  } finally { await gw.stop(); }
  assert.equal(gw.health().sip.listening, false);
});
test('credentials are looked up as own properties only (a prototype name is not a user), and only the configured trunk authenticates', async () => {
  const gw = createSipGateway(good(), deps()), addr = await gw.start(); try {
    const stranger = await SyntheticPhone.create({ gateway: addr, username: 'constructor', password: 'x' }); try { const r = await stranger.invite(); assert.equal(r.status, 403); } finally { stranger.close(); }
    const stranger2 = await SyntheticPhone.create({ gateway: addr, username: '__proto__', password: 'x' }); try { assert.equal((await stranger2.invite()).status, 403); } finally { stranger2.close(); }
  } finally { await gw.stop(); }
});
