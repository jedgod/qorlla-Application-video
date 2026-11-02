// Single-use hand-off codes between the Workplace server and the Meet page.
//   1. Workplace joins a person to the meeting (host with the host credential, others with the meeting secret) and asks for a code for THAT participant (bridge secret required).
//   2. The browser opens Meet with the code in the URL fragment. Meet removes it from the address bar at once and redeems it: POST /api/handoffs/redeem.
//   3. Redemption is one atomic UPDATE: a code works once, within HANDOFF_TTL_SECONDS (default 60), and only for a participant that still exists in a meeting that has not ended.
//      The session token is minted HERE from Meet's own participant row, so the role and name can never be chosen by the caller, and no long-lived token ever appears in a URL, a history entry or a log.
// A replayed, expired, unknown or malformed code gets the same answer (410): there is nothing to learn from it. Redemption attempts are limited per client address.
import crypto from 'node:crypto';

const TTL_S = Math.max(5, Math.min(300, Number(process.env.HANDOFF_TTL_SECONDS) || 60));
const hash = (c) => crypto.createHash('sha256').update(c).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GONE = 'This meeting link was already used or has expired.';

export function registerHandoff({ app, db, sign, fail, bridgeAuth, audit }) {
  const hits = new Map();                                                                         // ip -> recent redemption attempts
  const limited = (ip) => { const now = Date.now(), a = (hits.get(ip) || []).filter((t) => now - t < 60_000); a.push(now); hits.set(ip, a); return a.length > 30; };
  setInterval(() => { for (const [k, a] of hits) if (!a.some((t) => Date.now() - t < 60_000)) hits.delete(k); db.query("DELETE FROM handoffs WHERE expires_at < now() - interval '1 hour'").catch(() => {}); }, 300_000).unref();

  app.post('/api/integrations/handoffs', bridgeAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const { meetingId, participantId } = req.body || {};
      if (!UUID.test(String(meetingId)) || !UUID.test(String(participantId))) return fail(res, 400, 'Invalid request');
      const { rows: [p] } = await db.query('SELECT p.id, m.ended_at FROM participants p JOIN meetings m ON m.id=p.meeting_id WHERE p.id=$1 AND p.meeting_id=$2', [participantId, meetingId]);
      if (!p || p.ended_at) return fail(res, 404, 'Participant unavailable');
      const code = crypto.randomBytes(32).toString('base64url');
      await db.query("INSERT INTO handoffs(code_hash,meeting_id,participant_id,expires_at) VALUES($1,$2,$3, now() + ($4::int * interval '1 second'))", [hash(code), meetingId, participantId, TTL_S]);
      res.status(201).json({ code, expiresIn: TTL_S });
    } catch (e) { console.error('[handoff] issue failed:', e.message); fail(res, 503, 'Unavailable'); }
  });

  app.post('/api/handoffs/redeem', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (limited(req.ip)) { res.set('Retry-After', '60'); return fail(res, 429, 'Too many attempts. Try again in a minute.'); }
      const code = String((req.body || {}).code || '');
      if (!/^[A-Za-z0-9_-]{40,50}$/.test(code)) return fail(res, 410, GONE);
      const { rows: [h] } = await db.query('UPDATE handoffs SET redeemed_at=now() WHERE code_hash=$1 AND redeemed_at IS NULL AND expires_at > now() RETURNING meeting_id, participant_id', [hash(code)]);   // atomic: exactly one caller wins
      if (!h) return fail(res, 410, GONE);
      const { rows: [p] } = await db.query('SELECT p.role, p.display_name, m.ended_at FROM participants p JOIN meetings m ON m.id=p.meeting_id WHERE p.id=$1', [h.participant_id]);
      if (!p || p.ended_at) return fail(res, 410, GONE);
      audit(h.meeting_id, h.participant_id, 'handoff.redeemed', {});
      res.json({ token: sign({ meetingId: h.meeting_id, participantId: h.participant_id, role: p.role, name: p.display_name }), meetingId: h.meeting_id, participantId: h.participant_id });
    } catch (e) { console.error('[handoff] redeem failed:', e.message); fail(res, 503, 'Unavailable'); }
  });
}
