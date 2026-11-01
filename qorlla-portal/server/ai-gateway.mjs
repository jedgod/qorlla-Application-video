// Qorlla AI Gateway routes. Members see only "Qorlla AI" and whether it can answer; administrators see providers, tiers and health; no route ever returns a key.
// The per-workspace switch is the authorisation for content to leave the platform: it is OFF until an owner/admin turns it on, and every change is audited.
import { z } from 'zod';

export function registerAiGateway(app, { pool, cfg, auth, h, llm, flags = null }) {
  const { member, roles } = auth;
  const aiEnabled = async () => (flags ? flags.enabled('ai') : true);
  const platformAdmin = (req, res, next) => ((cfg.platformAdmins || []).includes(String(req.actor).toLowerCase()) ? next() : res.status(404).json({ error: 'Not found' }));
  const setting = async (ws) => !!(await pool.query('SELECT external_processing FROM portal.workspace_ai_settings WHERE workspace_id=$1', [ws])).rows[0]?.external_processing;

  app.get('/api/v1/ai/status', member, h(async (req, res) => {
    const s = llm.publicStatus ? llm.publicStatus() : { assistant: 'Qorlla AI', available: !!llm.available };
    res.set('Cache-Control', 'no-store').json({ ...s, available: s.available && await aiEnabled(), external_processing_authorised: await setting(req.workspace),
      note: 'Qorlla AI drafts suggestions for you to review. Nothing changes in your workspace until you accept it.' });
  }));

  app.put('/api/v1/ai/settings', member, roles('owner', 'admin'), h(async (req, res) => {
    const p = z.object({ external_processing: z.boolean() }).strict().parse(req.body);
    await pool.query(`INSERT INTO portal.workspace_ai_settings(workspace_id,external_processing,updated_by,updated_at) VALUES($1,$2,$3,now()) ON CONFLICT (workspace_id) DO UPDATE SET external_processing=EXCLUDED.external_processing, updated_by=EXCLUDED.updated_by, updated_at=now()`, [req.workspace, p.external_processing, req.actor]);
    await pool.query('INSERT INTO portal.audit_events(workspace_id,actor_id,action,object_id) VALUES($1,$2,$3,$4)', [req.workspace, req.actor, p.external_processing ? 'ai.external_processing_authorised' : 'ai.external_processing_withdrawn', req.workspace]);
    res.set('Cache-Control', 'no-store').json({ external_processing_authorised: p.external_processing });
  }));

  // platform administrators only: real provider identities, tiers and health (never keys)
  app.get('/api/v1/admin/ai/providers', member, platformAdmin, h(async (req, res) => {
    res.set('Cache-Control', 'no-store').json(llm.adminStatus ? llm.adminStatus() : { enabled: !!llm.available, providers: [] });
  }));
  app.get('/api/v1/admin/ai/audit', member, platformAdmin, h(async (req, res) => {
    const rows = (await pool.query('SELECT at,feature,actor_id,workspace_id,provider,tier,model,outcome,code,ms,input_chars,output_chars,input_tokens,output_tokens,prompt_hash FROM portal.ai_gateway_audit ORDER BY id DESC LIMIT 200')).rows;
    res.set('Cache-Control', 'no-store').json(rows);
  }));
}
