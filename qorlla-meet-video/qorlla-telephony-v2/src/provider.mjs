export class TelephonyProvider {
  async listAvailableNumbers(_country) { throw new Error('NOT_IMPLEMENTED'); }
  async provisionNumber(_request) { throw new Error('NOT_IMPLEMENTED'); }
  async releaseNumber(_providerNumberId) { throw new Error('NOT_IMPLEMENTED'); }
  async startCall(_request) { throw new Error('NOT_IMPLEMENTED'); }
  async endCall(_providerCallId) { throw new Error('NOT_IMPLEMENTED'); }
  verifyWebhook(_request) { throw new Error('NOT_IMPLEMENTED'); }
  parseWebhook(_request) { throw new Error('NOT_IMPLEMENTED'); }
}

// This adapter is intentionally inert. Never report live carrier capability
// until a real provider adapter has passed sandbox and production certification.
export class UnconfiguredProvider extends TelephonyProvider {
  async listAvailableNumbers() { return []; }
  async provisionNumber() { throw new Error('PROVIDER_NOT_CONFIGURED'); }
  async releaseNumber() { throw new Error('PROVIDER_NOT_CONFIGURED'); }
  async startCall() { throw new Error('PROVIDER_NOT_CONFIGURED'); }
  async endCall() { throw new Error('PROVIDER_NOT_CONFIGURED'); }
  verifyWebhook() { return false; }
  parseWebhook() { throw new Error('PROVIDER_NOT_CONFIGURED'); }
}
