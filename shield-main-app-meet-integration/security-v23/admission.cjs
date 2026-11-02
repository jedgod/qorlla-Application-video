'use strict';
// Enforce the existing one-time media capability before permitting any P2P signaling.
// IMPORTANT: signaling revocation alone cannot stop already-established P2P media.
function createAdmissionGuard({ client, enabled = false } = {}) {
  if (!client || typeof client.consumeMedia !== 'function') throw Error('SHIELD_CLIENT_REQUIRED');
  return async function guard({ meetingId, mediaCredential, guest, account, verified }) {
    if (!enabled) return { allow: false, reason: 'SHIELD_NOT_ENABLED' };
    if (!meetingId || typeof meetingId !== 'string') return { allow: false, reason: 'INVALID_MEETING' };
    if (guest) {
      if (account || !mediaCredential || typeof mediaCredential !== 'string') return { allow: false, reason: 'GUEST_CREDENTIAL_REQUIRED' };
      try {
        const result = await client.consumeMedia({ token: mediaCredential, meetingId });
        return result && result.valid === true && Array.isArray(result.capabilities) && result.capabilities.includes('meeting.media.join')
          ? { allow: true, role: 'guest' } : { allow: false, reason: 'INVALID_MEDIA_CREDENTIAL' };
      } catch { return { allow: false, reason: 'SHIELD_UNAVAILABLE' }; }
    }
    if (!account || !verified) return { allow: false, reason: 'VERIFICATION_REQUIRED' };
    return { allow: true, role: 'member' }; // Additional tenant/meeting policy must be checked by caller.
  };
}
module.exports = { createAdmissionGuard };
