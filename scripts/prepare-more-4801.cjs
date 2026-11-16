// Prepare, never deploy, a compact renderer for the existing localhost build.
const fs = require('node:fs');
const crypto = require('node:crypto');
const dir = 'evidence/more-localhost-4801';
fs.mkdirSync(dir + '/candidate', { recursive: true });
let js = fs.readFileSync(dir + '/original/collab.js', 'utf8');
function once(before, after) {
  if (!js.includes(before) || js.indexOf(before) !== js.lastIndexOf(before)) throw Error('Unexpected live renderer: ' + before.slice(0, 70));
  js = js.replace(before, after);
}
once("const t = $('tab-more'); t.textContent = '';", "const t = $('tab-more'); t.textContent = ''; t.classList.add('more-v41-compact');\n    const banner = el('div', 'more-v41-heading'); banner.append(el('strong', '', 'Meeting tools'), el('span', 'more-v41-badge', 'V4.1')); t.append(banner);");
once("note: note || 'Planned for v4.1'", "note: note || 'Unavailable'");
once("...(state.role === 'host' || (state.tools && state.tools.whiteboard) ? [soon('Whiteboard')] : []), ...(state.role === 'host' || (state.tools && state.tools.breakout) ? [soon('Breakout rooms')] : [])", "soon('Whiteboard'), soon('Breakout rooms')");
once("[soon('AI meeting summary', 'Planned v4.2 — needs its own consent'), soon('Live transcription', 'Planned v4.2 — needs its own consent'), soon('Translated captions', 'Planned v4.2')]", "[soon('AI summary', 'Unavailable — verified access and consent required'), soon('Live captions'), soon('Live transcript', 'Unavailable — consent and transcript service required'), soon('Action items'), soon('QorllaMate AI', 'Unavailable — private gateway and verified access required')]");
once('Recordings are not stored by Qorlla.', 'Recording availability and storage follow the verified recording service.');
once("hb.append(el('span', '', g.title), el('span', 'mg-chev'", "hb.append(el('span', 'more-v41-icon', ['♧','✧','▦','♢','☷'][gi], { 'aria-hidden': 'true' }), el('span', '', g.title), el('span', 'mg-chev'");
once('Items marked “Planned” are not available yet.', 'Unavailable tools stay disabled until their meeting services and privacy requirements are verified.');
fs.writeFileSync(dir + '/candidate/collab.js', js);
const css = fs.readFileSync(dir + '/original/styles.css', 'utf8') + `
/* More V4.1 live-build adapter: retain chat, docking and recording consent. */
#tab-more.more-v41-compact{padding:12px!important;font-size:12px}.more-v41-heading{display:flex;align-items:center;justify-content:space-between;margin:0 0 10px;font-size:13px}.more-v41-badge{font-size:10px;color:#afd2ff;padding:2px 6px;border:1px solid #365c92;border-radius:6px;background:#183251}
#tab-more.more-v41-compact .mg{border:1px solid #344158;border-radius:12px;margin:0 0 8px;overflow:hidden;background:linear-gradient(120deg,#18202d,#111722)}
#tab-more.more-v41-compact .mg-h{display:flex;align-items:center;justify-content:flex-start;gap:9px;padding:10px 12px!important;min-height:42px;font-size:13px!important;background:transparent!important;width:100%;text-align:left;border:0;border-radius:0}
#tab-more.more-v41-compact .more-v41-icon{font-size:22px;line-height:1;color:#6ab7ff;width:24px;text-align:center;flex:none}#tab-more.more-v41-compact .mg-chev{margin-left:auto;font-size:12px}
#tab-more.more-v41-compact .mg-b{padding:7px!important;gap:5px;border-top:1px solid #2b394f}#tab-more.more-v41-compact .mg-b[hidden]{display:none!important}#tab-more.more-v41-compact .mg-b>p{margin:0 0 6px;font-size:12px}
#tab-more.more-v41-compact .mg-i{display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:8px;margin:0!important;padding:8px 10px!important;min-height:36px;font-size:12px!important;line-height:1.35;border:1px solid #344158;border-radius:8px;background:#1b2433;width:100%;text-align:left}
#tab-more.more-v41-compact .mg-i:disabled{opacity:.7;cursor:not-allowed}#tab-more.more-v41-compact .mg-i small{font-size:10px!important;max-width:45%;text-align:right;line-height:1.3}
#tab-more.more-v41-compact .emoji{display:flex;gap:5px;margin:0 0 7px}#tab-more.more-v41-compact .emoji button{font-size:17px;padding:5px!important;min-width:32px;min-height:32px;border-radius:8px}
#tab-more.more-v41-compact .mg-info{font-size:11px;padding:7px 9px;margin:5px 0;border:1px solid #344158;border-radius:8px}#tab-more.more-v41-compact .mg-info p{font-size:11px;margin:4px 0}
#tab-more.more-v41-compact>.muted{font-size:10px;margin:7px 2px;line-height:1.4}#tab-more.more-v41-compact .rc-check{font-size:12px;padding:6px 2px;margin:4px 0}
@media(max-width:600px){#tab-more.more-v41-compact{padding:9px!important}#tab-more.more-v41-compact .mg-h{padding:9px!important}.more-v41-heading{margin-bottom:7px}}
`;
fs.writeFileSync(dir + '/candidate/styles.css', css);
fs.writeFileSync(dir + '/deployment-plan.json', JSON.stringify({ target: 'http://localhost:4801', container: 'qlaunch-meet-1', destination: '/app/public', files: ['collab.js','styles.css'], restartRequired: false, backendChanged: false, databaseMigrationApplied: false, qaAvailable: false, status: 'prepared; not installed; requires approval under earlier no-deploy instruction', originalHashes: ['collab.js','styles.css'].map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(dir + '/original/' + file)).digest('hex') })) }, null, 2) + '\n');
console.log('Prepared a two-file adapter and rollback originals; no running files changed.');
