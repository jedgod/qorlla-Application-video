import { normalizeE164, assertWorkspaceRole, deriveCapabilityState } from './core.mjs';

// Dependencies must be backed by authenticated Qorlla session, a real DB transaction
// layer, and a certified provider. Never use client-supplied workspace identity.
export class PhoneService {
  constructor({ repository, provider, policy }) {
    this.repository = repository;
    this.provider = provider;
    this.policy = policy;
  }
  async requestNumber({ actor, workspaceId, country, idempotencyKey }) {
    assertWorkspaceRole(actor, workspaceId, ['owner', 'admin']);
    if (!/^[A-Z]{2}$/.test(country)) throw new Error('INVALID_COUNTRY');
    if (!idempotencyKey) throw new Error('IDEMPOTENCY_REQUIRED');
    await this.policy.assertNumberProvisioningAllowed({ actor, workspaceId, country });
    // Reservation and provider provisioning require an asynchronous saga:
    // persist request -> provider action -> verified callback -> assign number.
    return this.repository.createProvisioningRequest({ workspaceId, country, actorId: actor.id, idempotencyKey });
  }
  async startCall({ actor, workspaceId, fromNumberId, to, idempotencyKey }) {
    assertWorkspaceRole(actor, workspaceId, ['owner', 'admin', 'member']);
    const destination = normalizeE164(to);
    if (!idempotencyKey) throw new Error('IDEMPOTENCY_REQUIRED');
    await this.policy.assertOutboundCallAllowed({ actor, workspaceId, fromNumberId, destination });
    // DB reserves an authorized intent and deduplicates it. A worker places the
    // provider call and reconciles callbacks; no duplicate external calls on retry.
    return this.repository.createCallIntent({ workspaceId, actorId: actor.id, fromNumberId, destination, idempotencyKey });
  }
  async capabilities({ workspaceId }) {
    const state = await this.repository.readCapabilityEvidence(workspaceId);
    return deriveCapabilityState(state);
  }
}
