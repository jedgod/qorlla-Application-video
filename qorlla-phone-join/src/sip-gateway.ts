import type { CallLedger, MeetingAuthority, Readiness } from './admission.js';
import { meetConfirmedBridge, type MediaReporter } from './meet-media.js';
import { SipMediaGateway, type MeetingAudio } from './media/sip-media-gateway.js';
import { TelephoneController, type ControllerConfig } from './telephone-controller.js';
import { UdpSipIngress, type IngressConfig } from './sip/udp-ingress.js';
import { DigestAuthenticator, type DigestAlgorithm } from './sip/digest.js';
import type { Logger } from './sip/adapter.js';

/**
 * Assembles the SIP telephone gateway - and REFUSES to, unless everything it needs is present. Telephone dial-in stays OFF by default: `enabled` must be explicitly true, the digest secret must be long, there must be
 * at least one credential and a non-empty source allowlist, media must be encrypted (plain RTP only in an explicit lab mode that also cannot be combined with a public bind), and the RTP port range must be sane.
 * Secrets arrive as values at start-up (from the deployment's secret store); nothing here reads a file or the environment, and nothing secret is logged.
 */
export type SipGatewayConfig = {
  enabled: boolean;
  labMode?: boolean;                                                           // plain RTP / ACL-only digest relaxations for isolated lab runs; never for a deployment that faces a network
  sip: Omit<IngressConfig, 'digest' | 'requireDigest' | 'log'>;
  digest: { secret: Buffer; ha1ByUser: Readonly<Record<string, string>>; algorithms?: readonly DigestAlgorithm[] };
  media: ControllerConfig['media'];
  limits?: { maxCalls?: number };
};
const PRIVATE_OR_LOOPBACK = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
/** Every reason this configuration must not start. Empty means it may. */
export function configProblems(c: SipGatewayConfig | null | undefined): string[] {
  const p: string[] = []; if (!c || typeof c !== 'object') return ['no configuration'];
  if (c.enabled !== true) p.push('telephone dial-in is not enabled (enabled must be true)');
  if (!Buffer.isBuffer(c.digest?.secret) || c.digest.secret.length < 32) p.push('the digest nonce secret must be at least 32 bytes');
  const users = Object.entries(c.digest?.ha1ByUser ?? {}); if (!users.length) p.push('no SIP credentials are configured');
  if (users.some(([u, h]) => !/^[A-Za-z0-9._-]{1,64}$/.test(u) || !/^[0-9a-f]{32,128}$/i.test(h))) p.push('credentials must be a user name and a hex HA1 hash, never a password');
  if (!c.sip?.allowedSources?.length) p.push('the source allowlist is empty (nobody could reach the gateway)');
  if (c.sip?.allowedSources?.some((s) => s === '0.0.0.0/0' || s.endsWith('/0')) && !c.labMode) p.push('an allowlist that admits every address is only allowed in lab mode');
  if (!c.sip?.realm) p.push('no digest realm'); if (!(c.sip?.maxCalls > 0 && c.sip.maxCalls <= 1000)) p.push('maxCalls must be between 1 and 1000');
  const [lo, hi] = c.media?.portRange ?? [0, 0]; if (!(lo >= 1024 && hi <= 65535 && hi >= lo)) p.push('the RTP port range is invalid (1024-65535)'); else if (hi - lo + 1 < 2 * (c.sip?.maxCalls ?? 1)) p.push('the RTP port range is smaller than twice maxCalls');
  if (c.media?.allowPlainRtp && !c.labMode) p.push('plain RTP is only allowed in lab mode');
  if (c.labMode && c.media?.publicHost && !PRIVATE_OR_LOOPBACK.test(c.media.publicHost)) p.push('lab mode cannot be combined with a publicly routable media address');
  if (!c.media?.bindHost || !c.media?.publicHost) p.push('media bindHost and publicHost are required');
  return p;
}
export type SipGatewayDeps = { authority: MeetingAuthority; reporter: MediaReporter; meeting: MeetingAudio; readiness: () => Promise<Readiness>; ledger?: CallLedger; log?: Logger; onEnded?: ControllerConfig['onEnded'] };
export function createSipGateway(c: SipGatewayConfig, d: SipGatewayDeps) {
  const problems = configProblems(c); if (problems.length) throw new Error('telephone gateway not started: ' + problems.join('; '));
  const digest = new DigestAuthenticator({ realm: c.sip.realm, secret: c.digest.secret, lookup: (u) => (Object.prototype.hasOwnProperty.call(c.digest.ha1ByUser, u) ? c.digest.ha1ByUser[u] : undefined), algorithms: c.digest.algorithms });
  const ingress = new UdpSipIngress({ ...c.sip, digest, requireDigest: true, log: d.log }), gateway = new SipMediaGateway({ meeting: d.meeting, log: d.log });
  const bridge = meetConfirmedBridge({ gateway, meet: d.reporter });
  const controller = new TelephoneController({ ingress, gateway, bridge, authority: d.authority, readiness: d.readiness, media: c.media, admission: { ledger: d.ledger }, onEnded: d.onEnded, log: d.log });
  return {
    ingress, gateway, bridge, controller,
    async start() { controller.start(); return ingress.start(); },
    async stop() { await ingress.stop(); await gateway.closeAll('shutdown'); },
    health: () => ({ sip: ingress.health(), activeLegs: gateway.activeLegs() }),
    /** What the heartbeat reports: healthy only while the SIP ingress is really listening; the media bridge (RTP legs and the mesh audio peer) is part of this object, so it is present exactly when the gateway is. */
    probe: () => ({ healthy: ingress.health().listening === true, mediaBridge: true })
  };
}
