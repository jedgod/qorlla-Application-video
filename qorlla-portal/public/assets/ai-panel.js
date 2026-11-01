// Qorlla AI Review Panel: one component for Docs, Sheets, Slides and QorllaMate.
// A suggestion is only ever PREVIEWED here. Nothing is saved until the person presses "Apply suggestion" and then confirms; the server re-checks permission and the document version at that moment.
// All text is escaped. Vendor names never appear: the choices are the Qorlla profiles returned by /ai/models.
import { $, esc, api, notice } from './core.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());

/** Line diff (longest common subsequence). Returns [{t:'same'|'add'|'del', s}]. Falls back to "all replaced" for very large inputs. */
export function diffLines(a, b) {
  const x = String(a ?? '').split('\n'), y = String(b ?? '').split('\n');
  if (x.length * y.length > 2_500_000) return [...x.map((s) => ({ t: 'del', s })), ...y.map((s) => ({ t: 'add', s }))];
  const m = x.length, n = y.length, L = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i -= 1) for (let j = n - 1; j >= 0; j -= 1) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < m && j < n) { if (x[i] === y[j]) { out.push({ t: 'same', s: x[i] }); i += 1; j += 1; } else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ t: 'del', s: x[i] }); i += 1; } else { out.push({ t: 'add', s: y[j] }); j += 1; } }
  while (i < m) out.push({ t: 'del', s: x[i++] }); while (j < n) out.push({ t: 'add', s: y[j++] });
  return out;
}
const ERR = {
  version_conflict: 'The document changed after this suggestion was made. Nothing was applied. Regenerate to work from the latest version.',
  read_only: 'You can view this document but not edit it, so the suggestion cannot be applied.',
  invalid_suggestion: 'This suggestion can no longer be applied. Regenerate it.',
  consent_required: 'This workspace has not authorised external AI processing. A workspace owner can turn it on in the AI settings.',
  private_unavailable: 'Qorlla AI Private is not available on this server, so nothing was sent. Choose Qorlla AI (Automatic) or ask an administrator.',
  ai_quota_exceeded: 'This workspace has reached its Qorlla AI limit for today.', ai_rate_limited: 'Qorlla AI is busy. Try again in a minute.', no_ai_provider: 'Qorlla AI is not available on this server. Nothing is simulated.', feature_disabled: 'Qorlla AI is switched off by the platform operators.'
};
const explain = (e) => ERR[e.body?.code] || (e.status === 404 ? 'That document no longer exists, or you no longer have access to it. Nothing was applied.' : e.status === 429 ? ERR.ai_rate_limited : [502, 503].includes(e.status) ? 'Qorlla AI is unavailable right now. Nothing was saved or charged.' : e.message || 'Something went wrong. Nothing was applied.');

/**
 * opts: { id, title?, mode: 'task'|'chat', tasks: [{task,label,needs?}], input(): {document_id?, text?}, current(): string, versionLabel?(): string, onApplied(result), heading? }
 * Returns { destroy() }.
 */
export async function mountAiPanel(host, opts) {
  const id = opts.id || 'ai';
  const [status, models] = await Promise.all([api('/ai/status').catch(() => ({ available: false })), api('/ai/models').catch(() => [{ id: 'qorlla-ai', name: 'Qorlla AI', available: false }])]);
  let result = null, running = false, showDiff = false, confirming = false;
  host.innerHTML = `<section class="panel ai-panel" aria-labelledby="${id}-h" data-ai-panel>
    <h2 id="${id}-h">Qorlla AI <span class="muted">Workspace Assistant</span></h2>
    ${status.available ? '' : '<p class="warn" role="note">Qorlla AI is not available on this server. Nothing is simulated.</p>'}
    ${status.available && !status.external_processing_authorised ? '<p class="muted" data-ai-privacy>External AI processing is not authorised for this workspace, so only private models can answer.</p>' : ''}
    <div class="row">
      ${opts.mode === 'chat' ? `<label>Ask Qorlla AI<textarea data-ai-text rows="2" maxlength="4000" placeholder="Ask about your workspace"></textarea></label>`
        : `<label>What should Qorlla AI do?<select data-ai-task>${opts.tasks.map((t) => `<option value="${esc(t.task)}">${esc(t.label)}</option>`).join('')}</select></label>
           <label data-ai-text-wrap hidden>Your request<textarea data-ai-text rows="2" maxlength="4000"></textarea></label>
           <label data-ai-lang-wrap hidden>Language<input data-ai-lang maxlength="40" value="Spanish"></label>
           <label>Instruction (optional)<input data-ai-instr maxlength="1000"></label>`}
      <label>Model<select data-ai-model>${models.map((m) => `<option value="${esc(m.id)}" ${m.available ? '' : 'disabled'}>${esc(m.name)}${m.id === 'qorlla-ai' ? ' (Automatic)' : ' (Local only)'}${m.available ? '' : ' - unavailable'}</option>`).join('')}</select></label>
      <button type="button" data-ai-generate ${status.available ? '' : 'disabled'}>Generate</button>
    </div>
    <div data-ai-preview aria-live="polite" tabindex="-1"></div></section>`;
  const q = (s) => host.querySelector(s);
  const taskSel = q('[data-ai-task]');
  const needs = () => (opts.tasks || []).find((t) => t.task === taskSel?.value)?.needs || [];
  const syncNeeds = () => { if (!taskSel) return; q('[data-ai-text-wrap]').hidden = !needs().includes('text'); q('[data-ai-lang-wrap]').hidden = !needs().includes('language'); };
  taskSel?.addEventListener('change', syncNeeds); syncNeeds();

  const draw = () => {
    const box = q('[data-ai-preview]');
    if (!result) { box.innerHTML = ''; return; }
    const r = result, canApply = !!r.apply, chat = opts.mode === 'chat';
    const original = opts.current ? opts.current() : '';
    const changes = showDiff && canApply && r.apply.mode !== 'new_document' ? `<div class="ai-diff" data-ai-diff role="group" aria-label="Changes">${diffLines(original, opts.after ? opts.after(r) : r.suggestion).map((l) => `<div class="ai-${l.t}"><span aria-hidden="true">${l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' '}</span> ${esc(l.s) || '&nbsp;'}</div>`).join('')}</div>` : showDiff ? '<p class="muted" data-ai-diff>Nothing to compare: this suggestion creates a new document.</p>' : '';
    box.innerHTML = `<h3 tabindex="-1" data-ai-title>${chat ? 'AI-generated answer' : 'AI-generated suggestion'}</h3>
      <p class="muted" data-ai-saved>No changes have been saved.</p>
      <pre class="ai-suggestion" data-ai-suggestion>${esc(chat ? r.reply : r.suggestion)}</pre>
      ${(r.notes || []).length ? `<ul class="muted">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${chat && r.proposed_actions?.length ? `<p class="muted">Proposed (nothing was created): ${r.proposed_actions.map((a) => esc(a.title || a.kind)).join(', ')}. To act on a proposal, send it in a QorllaMate conversation, where you can approve it.</p>` : ''}
      ${chat && r.sources?.length ? `<p class="muted">Based on: ${r.sources.map(esc).join('; ')}</p>` : ''}
      ${changes}
      ${confirming ? `<div class="ai-confirm" role="alertdialog" aria-labelledby="${id}-c"><p id="${id}-c"><strong>Apply this suggestion?</strong> ${esc(opts.confirmText ? opts.confirmText(r) : 'It will be saved as an AI-assisted version. The previous version is kept in the history.')}</p><div class="row"><button type="button" data-ai-confirm>Confirm apply</button><button type="button" class="secondary" data-ai-cancel>Cancel</button></div></div>` : ''}
      <div class="row ai-actions">
        ${canApply ? `<button type="button" data-ai-apply ${confirming || running ? 'disabled' : ''}>Apply suggestion</button>` : ''}
        ${!canApply && !chat && !r.stale ? '<button type="button" class="secondary" data-ai-copy>Copy</button>' : ''}${chat ? '<button type="button" class="secondary" data-ai-copy>Copy</button>' : ''}
        ${canApply ? `<button type="button" class="secondary" data-ai-diffbtn aria-pressed="${showDiff}">View changes</button>` : ''}
        <button type="button" class="secondary" data-ai-regen ${running ? 'disabled' : ''}>Regenerate</button>
        <button type="button" class="secondary" data-ai-discard>Discard</button></div>
      ${r.stale ? '<p class="warn" role="alert" data-ai-stale>This suggestion is out of date, so it cannot be applied. Press Regenerate to work from the latest version.</p>' : !canApply && !chat ? '<p class="muted">This is advice, not an edit, so there is nothing to apply. Copy it if it helps.</p>' : ''}`;
    q('[data-ai-title]').focus?.();
  };
  const generate = async () => {
    if (running) return; running = true; confirming = false; result = null; draw(); notice('Qorlla AI is working…'); q('[data-ai-generate]').disabled = true;   // the old suggestion goes away at once: it must not stay actionable while a new one is being made
    try {
      const model = q('[data-ai-model]').value; const t = taskSel?.value;
      if (opts.mode === 'chat') { const content = q('[data-ai-text]').value.trim(); if (!content) { notice('Type a question first.'); return; } result = await api('/ai/qorllamate/chat', { method: 'POST', body: JSON.stringify({ content, model, idempotency_key: uid() }) }); }
      else {
        const body = { task: t, model, idempotency_key: uid(), ...(opts.input ? opts.input() : {}) }; const instr = q('[data-ai-instr]').value.trim(); if (instr) body.instruction = instr;
        if (needs().includes('language')) body.target_language = q('[data-ai-lang]').value.trim();
        if (needs().includes('text')) { body.text = q('[data-ai-text]').value.trim(); if (!body.text) { notice('Describe what you want first.'); return; } }
        result = await api('/ai/run', { method: 'POST', body: JSON.stringify(body) });
      }
      showDiff = false; notice('');
    } catch (e) { result = null; notice(explain(e)); } finally { running = false; q('[data-ai-generate]').disabled = !status.available; draw(); }
  };
  const apply = async () => {
    if (!result?.apply || running) return; running = true; draw();
    try {
      const a = result.apply; const out = await api('/ai/apply', { method: 'POST', body: JSON.stringify({ task: result.task, document_id: a.document_id || undefined, base_version: a.base_version || undefined, suggestion: result.suggestion, apply_token: a.token, title: opts.newTitle ? opts.newTitle() : undefined, confirm: true, idempotency_key: uid() }) });
      confirming = false; result = null; notice('Applied. The previous version is kept in the version history.'); draw(); if (opts.onApplied) await opts.onApplied(out);
    } catch (e) { confirming = false; notice(explain(e)); if (e.body?.code === 'version_conflict') { result.apply = null; result.stale = true; } }
    finally { running = false; draw(); }
  };
  host.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button'); if (!b || !host.contains(b)) return;
    if (b.matches('[data-ai-generate],[data-ai-regen]')) return generate();
    if (b.matches('[data-ai-discard]')) { result = null; confirming = false; showDiff = false; notice('Suggestion discarded. Nothing was changed.'); return draw(); }
    if (b.matches('[data-ai-apply]')) { if (running || !result?.apply) return; confirming = true; return draw(); }
    if (b.matches('[data-ai-cancel]')) { confirming = false; return draw(); }
    if (b.matches('[data-ai-confirm]')) return apply();
    if (b.matches('[data-ai-diffbtn]')) { showDiff = !showDiff; return draw(); }
    if (b.matches('[data-ai-copy]')) { try { await navigator.clipboard.writeText(opts.mode === 'chat' ? result.reply : result.suggestion); notice('Copied.'); } catch { notice('Select the text and copy it.'); } }
  });
  return { destroy() { host.innerHTML = ''; } };
}
