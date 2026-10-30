// Service adapters for the operations surfaces. Each is an interface that FAILS CLOSED until a real, certified implementation is injected; none contains simulated behaviour.
//   numberAuthority: read-only lookups. The Number Authority is the SOLE issuer; operations can only REQUEST (ops_number_requests), never assign.
//   shield:          Security Shield authorization for external calling ({ authorized }).
//   carrier:         certified carrier gateway ({ certified }). None exists yet.
//   meetings:        read-only diagnostics (state, participant COUNT, signaling health). There is no join/admit/mute/record action anywhere in operations.
export class AdapterUnavailable extends Error { constructor(name) { super(name + '_unavailable'); this.code = name + '_unavailable'; this.status = 503; } }
const need = (name, impl, method) => { if (!impl || typeof impl[method] !== 'function') throw new AdapterUnavailable(name); return impl; };
export const createAdapters = (given = {}) => ({
  numberAuthority: { lookupAssignment: (userId) => need('number_authority', given.numberAuthority, 'lookupAssignment').lookupAssignment(userId) },
  meetings: { health: async (meetingId) => {
    const raw = await need('meeting_diagnostics', given.meetings, 'getMeetingHealth').getMeetingHealth(meetingId);
    return { state: String(raw?.state ?? 'unknown').slice(0, 40), participants: Number.isInteger(raw?.participants) ? raw.participants : null, signalingHealthy: raw?.signalingHealthy === true };   // whitelist: nothing else an adapter returns can leak through
  } },
  shield: given.shield || null, carrier: given.carrier || null
});

/**
 * Whether external (PSTN) calling could be allowed for a customer. Every condition must hold; a payment failure (or anything else missing) denies. This is a DECISION only:
 * operations never turns calling on, it has no table or status for "active", and the PSTN gate stays under its own release controls.
 */
export function externalCallingDecision({ gates, invoice, shield, carrier }) {
  const reasons = [];
  if (!gates?.pstn) reasons.push('pstn_disabled');
  const paid = !!invoice && invoice.status === 'paid' && Number(invoice.amount_paid_cents) > 0 && Number(invoice.amount_refunded_cents || 0) === 0;
  if (!paid) reasons.push('payment_not_verified');
  if (shield?.authorized !== true) reasons.push('shield_not_authorized');
  if (carrier?.certified !== true) reasons.push('carrier_not_certified');
  return { allowed: reasons.length === 0, reasons, activation: 'not_performed_by_operations' };
}
