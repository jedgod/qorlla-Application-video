import express from 'express';
import { createPhoneJoinRouter } from './server.js';
import type { MeetingAuthority, SipRtpBridge } from './admission.js';
/** Deliberately fail-closed example. Replace with real Qorlla authenticated adapters. */
const authority: MeetingAuthority = {
  async verifyPhoneJoin() { return {allowed:false, requiresHostApproval:true}; },
  async requestHostApproval() { return false; }
};
const bridge: SipRtpBridge = {
  async attach() { throw new Error('SIP/RTP bridge not installed'); },
  async disconnect() { /* no active media session */ }
};
const app = express();
app.disable('x-powered-by');
app.use('/api/v1/phone-join', createPhoneJoinRouter({
  readiness: async () => ({carrierConnected:false,inboundNumberCertified:false,gatewayHealthy:false,mediaBridgeCertified:false,billingCertified:false,productionApproved:false}),
  authority, bridge,
  authenticateGateway: (_req,res) => { res.status(401).json({code:'AUTH_REQUIRED'}); },
  verifyWebhook: (_req,res) => { res.status(401).json({code:'SIGNED_WEBHOOK_REQUIRED'}); },
  rateLimit: (_req,_res,next) => next() // REPLACE with existing Qorlla distributed limiter before deployment
}));
const port = Number(process.env.PORT || 6055);
app.listen(port, '127.0.0.1', () => console.log(`Fail-closed demo listening on localhost:${port}`));
