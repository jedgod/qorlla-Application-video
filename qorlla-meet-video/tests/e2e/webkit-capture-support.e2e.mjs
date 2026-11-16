// Safari-family check (v4.34): which audio recording formats do WebKit and Firefox offer, and does the transcript page pick one? This is Playwright's WebKit build, NOT Safari on a Mac or an iPhone:
// it shows the format choice works there, nothing more. iOS Safari still needs a physical device.
//   PLAYWRIGHT_DIR=<dir with playwright> node tests/e2e/webkit-capture-support.e2e.mjs
import { createRequire } from 'node:module';
import { join } from 'node:path';
import http from 'node:http';
const srv = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>x</title>'); }); await new Promise((r) => srv.listen(0, '127.0.0.1', r));          // localhost is a secure context: getUserMedia exists there (it does not on about:blank)
const ORIGIN = 'http://localhost:' + srv.address().port;
const pw = createRequire(join(process.env.PLAYWRIGHT_DIR || process.cwd(), 'package.json'))('playwright');
const CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];          // the same list, in the same order, as public/collab.js
const server = ['audio/webm', 'audio/ogg', 'audio/mp4'];                                                    // what server/transcripts.mjs accepts (parameters stripped)
let bad = 0;
for (const name of ['chromium', 'firefox', 'webkit']) {
  let browser; try { browser = await pw[name].launch(); } catch (e) { console.log(`SKIP ${name}: not installed (${String(e.message).split('\n')[0].slice(0, 60)})`); continue; }
  const page = await browser.newPage(); await page.goto(ORIGIN);
  const r = await page.evaluate((c) => ({ recorder: typeof MediaRecorder !== 'undefined', gum: !!navigator.mediaDevices?.getUserMedia, picked: typeof MediaRecorder === 'undefined' ? null : c.find((m) => MediaRecorder.isTypeSupported(m)) || null, supported: typeof MediaRecorder === 'undefined' ? [] : c.filter((m) => MediaRecorder.isTypeSupported(m)) }), CANDIDATES);
  if (!r.recorder) { console.log(`SKIP ${name}: this Playwright build has no MediaRecorder at all (the Windows WebKit port), so Safari cannot be judged here: it needs a Mac or an iPhone`); await browser.close(); continue; }
  const ok = r.recorder && r.gum && r.picked && server.includes(r.picked.split(';')[0]); if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: MediaRecorder ${r.recorder}, getUserMedia ${r.gum}, chosen format ${r.picked}, supported ${JSON.stringify(r.supported)}${ok ? '' : ' (the page would say the browser cannot record)'}`);
  await browser.close();
}
console.log(bad ? `\n${bad} browser(s) cannot record in a format the server accepts` : '\nevery installed browser has a usable format (decoding of those chunks by the engine is NOT tested here)'); srv.close(); process.exit(bad ? 1 : 0);
