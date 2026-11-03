import express from 'express';
import { z } from 'zod';
import { admitTelephoneCall, telephoneReady, UNAVAILABLE_MESSAGE, type AdmissionOptions, type MeetingAuthority, type Readiness, type SipRtpBridge } from './admission.js';

/** Integrate behind Qorlla's authenticated gateway; never expose call admission publicly. */
export function createPhoneJoinRouter(deps: {
  readiness: () => Promise<Readiness>;
  authority: MeetingAuthority;
  bridge: SipRtpBridge;
  authenticateGateway: express.RequestHandler;
  rateLimit: express.RequestHandler;
  verifyWebhook: express.RequestHandler;
  /** Durable call-id ledger and timeouts; see AdmissionOptions. Production must supply a ledger. */
  admission?: AdmissionOptions;
}) {
  const router = express.Router();
  router.get('/capabilities', deps.authenticateGateway, deps.rateLimit, async (_req, res) => {
    try {
      const ready = telephoneReady(await deps.readiness());
      res.setHeader('Cache-Control', 'no-store');
      res.json({ telephoneJoin: ready, message: ready ? 'Telephone join enabled' : UNAVAILABLE_MESSAGE });
    } catch { res.status(503).json({ telephoneJoin: false, message: UNAVAILABLE_MESSAGE }); }
  });
  const schema = z.object({ meetingId: z.string(), passcode: z.string(), callId: z.string(), dialedNumber: z.string(), callerNumber: z.string().optional() }).strict();
  router.post('/inbound/admit', deps.verifyWebhook, deps.rateLimit, express.json({limit:'8kb'}), async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ code: 'INVALID_REQUEST' });
    let readiness: Readiness;
    try { readiness = await deps.readiness(); } catch { return void res.status(503).json({ code: 'PHONE_JOIN_UNAVAILABLE', announcement: UNAVAILABLE_MESSAGE }); }
    res.setHeader('Cache-Control', 'no-store');
    const result = await admitTelephoneCall(parsed.data, readiness, deps.authority, deps.bridge, deps.admission);
    res.status(result.status).json(result);
  });
  // Malformed JSON, an oversized body or any other parser failure: a plain JSON refusal, no stack trace and no HTML error page.
  router.use((err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err && typeof err.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 400;
    res.status(status).json({ code: 'INVALID_REQUEST' });
  });
  return router;
}
