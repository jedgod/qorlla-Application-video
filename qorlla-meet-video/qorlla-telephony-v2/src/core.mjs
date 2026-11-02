import crypto from 'node:crypto';

export function normalizeMeetingId(input) {
  const digits = String(input ?? '').replace(/[\s-]/g, '');
  if (!/^\d{11}$/.test(digits)) throw new Error('INVALID_MEETING_ID');
  return digits;
}
export function normalizeE164(input) {
  const value = String(input ?? '').replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(value)) throw new Error('INVALID_E164');
  return value;
}
export function assertWorkspaceRole(actor, workspaceId, allowedRoles) {
  if (!actor || actor.workspaceId !== workspaceId || !allowedRoles.includes(actor.role)) {
    throw new Error('FORBIDDEN');
  }
}
export function verifyWebhookHmac({ rawBody, signature, secret }) {
  if (!Buffer.isBuffer(rawBody) || !secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}
export function deriveCapabilityState({ providerConnected, provisionedDialInCount, assignedNumberCount, carrierCertified, bridgeCertified, billingCertified }) {
  return {
    provider: providerConnected ? 'connected' : 'not_connected',
    dialIn: providerConnected && provisionedDialInCount > 0 ? 'provisioned' : 'unavailable',
    carrier: providerConnected && carrierCertified ? 'enabled' : 'disabled',
    assignedNumber: assignedNumberCount > 0 ? 'assigned' : 'unassigned',
    bridge: bridgeCertified ? 'certified' : 'not_certified',
    billing: billingCertified ? 'connected' : 'not_connected',
    phoneMeetingJoinEnabled: Boolean(providerConnected && provisionedDialInCount > 0 && bridgeCertified),
  };
}
export function canJoinOccurrence({ meeting, now = new Date() }) {
  if (!meeting || !meeting.phoneAccessEnabled || meeting.locked || meeting.endedAt) return false;
  const start = new Date(meeting.startsAt).getTime();
  const end = new Date(meeting.endsAt).getTime();
  const time = now.getTime();
  return Number.isFinite(start) && Number.isFinite(end) && time >= start - 15*60_000 && time < end;
}
