// Qorlla AI citations in the page. A citation is a button; pressing it asks the server, which re-checks access, consent, retention and that the text is still what was cited.
// Nothing is cached: if access was withdrawn since the answer was written, the reader gets the reason instead of the text. All text is escaped.
import { esc, api } from './core.js';

const WHY = {
  citation_access_revoked: 'You no longer have access to this source.',
  consent_withdrawn: 'Consent for AI processing of this meeting was withdrawn, so the source is no longer shown.',
  participant_withdrew: 'The person who wrote this withdrew their consent, so it cannot be shown.',
  participant_consent_unverifiable: 'Participant consent could not be verified right now, so the source was not shown. Try again shortly.',
  source_expired: 'This source is no longer retained.', source_deleted: 'This source was deleted.', source_changed: 'This source changed after the answer was written, so it is not shown.',
  source_not_found: 'This source could not be found.', citation_not_found: 'This citation could not be found.', invalid_citation: 'This citation is not valid or has expired.'
};
export const citeChips = (items = []) => (items || []).map((c) => `<button type="button" class="cite" data-cite="${esc(c.ref)}" aria-label="Open source: ${esc(c.label)}">${esc(c.label)}</button>`).join(' ');

/** Wire once per container: clicks on any [data-cite] button open the source in a live region next to it. */
export function wireCitations(root) {
  root.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-cite]'); if (!b || !root.contains(b)) return;
    let view = root.querySelector('[data-cite-view]');
    if (!view) { view = document.createElement('div'); view.setAttribute('data-cite-view', ''); view.setAttribute('role', 'region'); view.setAttribute('aria-live', 'polite'); view.setAttribute('aria-label', 'Cited source'); root.append(view); }
    view.innerHTML = '<p class="muted">Checking the source…</p>';
    try {
      const o = await api('/ai/citations/' + encodeURIComponent(b.dataset.cite));
      const meta = [o.speaker, o.at ? new Date(o.at).toLocaleString() : (o.start_ms != null ? Math.floor(o.start_ms / 1000) + 's' : ''), o.title, o.version ? `version ${o.version}${o.is_current === false ? ' (an earlier version)' : ''}` : ''].filter(Boolean).map(esc).join(' · ');
      view.innerHTML = `<h3>${esc(o.label || 'Source')}</h3>${meta ? `<p class="muted" data-cite-meta>${meta}</p>` : ''}<blockquote class="ai-suggestion" data-cite-passage>${esc(o.passage)}</blockquote><p class="muted">This is the original text, checked just now against your current access.</p>`;
    } catch (e) { view.innerHTML = `<p class="warn" role="alert" data-cite-refused>${esc(WHY[e.body?.code] || e.message || 'This source cannot be shown.')}</p>`; }
    view.scrollIntoView?.({ block: 'nearest' });
  });
}
