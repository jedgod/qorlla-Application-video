// Verifiable Qorlla AI citations.
// A citation is created ONLY by the backend, from a source it has just read: the model may suggest a quote, a cell range or a slide number, but a suggestion that does not
// resolve to real content is dropped, and the model never supplies an identifier. A citation is a signed reference (ids, version, position, and a hash of the cited text);
// it does not contain the text. Opening one re-checks the caller's access, consent and retention, finds the text again, and compares the hash, so a citation can never
// show more than its reader may see today, and a changed or expired source is refused rather than shown.
import crypto from 'node:crypto';

const b64 = (b) => Buffer.from(b).toString('base64url');
export const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function createCitations({ secret }) {
  const key = crypto.createHash('sha256').update('qorlla-ai-citation|' + (secret || crypto.randomBytes(32).toString('hex'))).digest();
  const mac = (body) => crypto.createHmac('sha256', key).update(body).digest('base64url');
  /** ref: { ws, kind, id, ver?, loc, h, label, exp? } */
  const sign = (ref) => { const body = b64(JSON.stringify({ v: 1, ...ref })); return 'qc1.' + body + '.' + mac(body); };
  const verify = (token) => {
    const m = /^qc1\.([A-Za-z0-9_-]{4,6000})\.([A-Za-z0-9_-]{43})$/.exec(String(token || '')); if (!m) return null;
    const want = Buffer.from(mac(m[1])), got = Buffer.from(m[2]); if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    let ref; try { ref = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { return null; }
    if (ref.v !== 1 || (ref.exp && ref.exp < Date.now())) return null;
    return ref;
  };
  return { sign, verify };
}

// ---------------------------------------------------------------- locating text inside a source (used when creating AND when opening)
const colIndex = (s) => [...s].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
/** A1 notation, row 1 = the header row. Returns {c0,c1,r0,r1,range} or null when it is malformed or outside the sheet. */
export function parseRange(text, content) {
  const m = /^([A-Z]{1,2})(\d{1,4})(?::([A-Z]{1,2})(\d{1,4}))?$/.exec(String(text || '').trim().toUpperCase()); if (!m) return null;
  const c0 = colIndex(m[1]), r0 = Number(m[2]), c1 = m[3] ? colIndex(m[3]) : c0, r1 = m[4] ? Number(m[4]) : r0;
  if (c0 > c1 || r0 > r1 || r0 < 1) return null;
  if (c1 >= content.columns.length || r1 > content.rows.length + 1) return null;           // outside the real data: not a citation
  return { c0, c1, r0, r1, range: colName(c0) + r0 + (c0 === c1 && r0 === r1 ? '' : ':' + colName(c1) + r1) };
}
export function rangeText(content, { c0, c1, r0, r1 }) {
  const lines = []; for (let r = r0; r <= r1; r += 1) { const cells = r === 1 ? content.columns : (content.rows[r - 2] || []); lines.push(cells.slice(c0, c1 + 1).map((v) => (v == null ? '' : String(v))).join('\t')); }
  return lines.join('\n');
}
export const slideText = (content, n) => { const s = content.slides[n - 1]; return s ? [s.title, ...(s.bullets || []), s.notes || ''].filter(Boolean).join('\n') : null; };

/** The text a reference points to, from the CURRENT CONTENT OF THAT VERSION. Returns null when the position no longer exists. */
export function extract(kind, content, loc) {
  if (kind === 'document') return loc.t === 'passage' && typeof content.text === 'string' ? content.text.slice(loc.s, loc.e) || null : null;
  if (kind === 'sheet') { const r = parseRange(loc.range, content); return r ? rangeText(content, r) : null; }
  if (kind === 'slides') return loc.t === 'slide' ? slideText(content, loc.n) : null;
  return null;
}

/**
 * Turns what the model SUGGESTED as evidence into citations that really resolve. Anything that does not is counted in `dropped` and never shown.
 * evidence: [{ quote?, range?, slide? }]  content: the version's content  -> { cited: [{kind, loc, h, label}], dropped }
 */
export function verifiedEvidence({ kind, content, evidence = [], title = '' }) {
  const cited = [], seen = new Set(); let dropped = 0;
  for (const e of evidence.slice(0, 10)) {
    let c = null;
    if (kind === 'doc') {
      const q = String(e.quote || '').trim(); const i = q.length >= 8 && q.length <= 400 ? content.text.indexOf(q) : -1;
      if (i >= 0) c = { kind: 'document', loc: { t: 'passage', s: i, e: i + q.length }, h: sha(q), label: `${title || 'Document'}: "${q.length > 60 ? q.slice(0, 57) + '...' : q}"` };
    } else if (kind === 'sheet') {
      const r = e.range ? parseRange(e.range, content) : null;
      if (r) c = { kind: 'sheet', loc: { t: 'range', range: r.range }, h: sha(rangeText(content, r)), label: `${title || 'Sheet'}: ${r.range}` };
    } else if (kind === 'slides') {
      const n = Number.isInteger(e.slide) ? e.slide : 0; const t = n >= 1 ? slideText(content, n) : null;
      if (t) c = { kind: 'slides', loc: { t: 'slide', n }, h: sha(t), label: `${title || 'Slides'}: slide ${n}` };
    }
    const id = c && JSON.stringify([c.kind, c.loc]); if (!c || seen.has(id)) { dropped += c ? 0 : 1; continue; }
    seen.add(id); cited.push(c);
  }
  return { cited, dropped };
}

// ---------------------------------------------------------------- Meet: grounding a statement in the consented transcript, without asking the model for ids
const STOP = new Set('the a an and or but of to in on for with by at from is are was were be been will would should could can this that these those it its as we i you they he she not no yes do does did have has had'.split(' '));
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
/** Which transcript segments actually contain the content of `statement`? A segment supports it only if it shares at least `min` of the statement's content words (default 60%). */
export function groundStatement(statement, segments, { min = 0.6, max = 3 } = {}) {
  const need = [...new Set(words(statement))]; if (need.length < 2) return [];
  const scored = [];
  segments.forEach((s, i) => { const have = new Set(words(s.text)); const hit = need.filter((w) => have.has(w)).length; const score = hit / need.length; if (score >= min) scored.push({ i, score }); });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, max).map((x) => x.i);
}
