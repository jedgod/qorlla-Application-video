#!/usr/bin/env node
// Imports a LOCAL ringtone library folder (no internet) into assets/ringtones/library/ as a separate "Library" group of ringtones, next to the eight original tones.
//   node scripts/import-ringtone-library.mjs --from "C:/path/to/ringtoneslibrary" [--max-mp3-kb 450] [--max-seconds 6] [--dry-run]
// The folder is expected to hold local copies of  Music-DJ-main/ (MIDI melodies in playback/samples)  and  awesome-ringtone-main/ (MP3 tones in one folder per brand).
//   * MIDI melodies are converted to short note patterns (frequency + seconds) that the app plays with its own synthesizer. Drum parts are skipped.
//   * MP3 tones are copied only when they are short enough to be a sensible ringtone (--max-mp3-kb); longer songs are left out so the repository and the app image stay small.
//   * manifest.json records, for every item, where it came from (project, path, sha256) and its rights status. NOTHING here verifies that Qorlla may redistribute the audio: the material is
//     third-party (Music-DJ recreates a Sony Ericsson app and uses its original samples; the MP3s are phone-brand tones). The owner of Qorlla accepted that risk when choosing to import it; see docs/RINGTONES.md.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const FROM = arg('from', process.env.RINGTONE_LIBRARY_DIR || ''), DRY = process.argv.includes('--dry-run');
const MAX_MP3 = Number(arg('max-mp3-kb', 450)) * 1024, MAX_SEC = Number(arg('max-seconds', 6));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), OUT = path.join(root, 'assets', 'ringtones', 'library');
if (!FROM || !fs.existsSync(FROM)) { console.error('Give the library folder: --from "<path to ringtoneslibrary>"'); process.exit(2); }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const slug = (s) => String(s).toLowerCase().replace(/\.mp3$/i, '').replace(/^\d{4}\s*-\s*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tone';

// ---- minimal Standard MIDI File reader: tempo, program, note on/off per channel (everything else is ignored)
function readMidi(buf) {
  let p = 0; const u32 = () => { const v = buf.readUInt32BE(p); p += 4; return v; }, u16 = () => { const v = buf.readUInt16BE(p); p += 2; return v; };
  if (buf.toString('latin1', 0, 4) !== 'MThd') throw new Error('not a MIDI file'); p = 4; const hl = u32(); const fmt = u16(), ntr = u16(), div = u16(); p = 8 + hl;
  if (div & 0x8000) throw new Error('SMPTE time not supported');
  const notes = [], tempos = [[0, 500000]], names = [], programs = new Map();
  for (let t = 0; t < ntr && p < buf.length; t++) {
    if (buf.toString('latin1', p, p + 4) !== 'MTrk') break; p += 4; const len = u32(), end = p + len; let tick = 0, run = 0; const on = new Map();
    const vlq = () => { let v = 0, b; do { b = buf[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && p < end); return v; };
    while (p < end) {
      tick += vlq(); let st = buf[p]; if (st & 0x80) { p++; if (st < 0xf0) run = st; } else st = run;
      if (st === 0xff) { const type = buf[p++], l = vlq(); const d = buf.subarray(p, p + l); p += l; if (type === 0x51 && l === 3) tempos.push([tick, d.readUIntBE(0, 3)]); if (type === 0x03) names.push(d.toString('latin1').replace(/\0/g, '').trim()); if (type === 0x2f) break; }
      else if (st === 0xf0 || st === 0xf7) { p += vlq(); }
      else { const hi = st & 0xf0, ch = st & 0x0f; const a = buf[p++], b2 = hi === 0xc0 || hi === 0xd0 ? 0 : buf[p++];
        if (hi === 0xc0) programs.set(ch, a);
        else if (hi === 0x90 && b2 > 0) on.set(ch + ':' + a, tick);
        else if (hi === 0x80 || (hi === 0x90 && b2 === 0)) { const k = ch + ':' + a; if (on.has(k)) { notes.push({ ch, key: a, start: on.get(k), end: tick, track: t }); on.delete(k); } } }
    }
    p = end;
  }
  tempos.sort((x, y) => x[0] - y[0]); return { div, tempos, notes: notes.sort((x, y) => x.start - y.start || y.key - x.key), names, programs };
}
const tickToSec = (m, tick) => { let sec = 0, last = 0, tempo = 500000; for (const [t, us] of m.tempos) { if (t >= tick) break; sec += ((t - last) * tempo) / 1e6 / m.div; last = t; tempo = us; } return sec + ((tick - last) * tempo) / 1e6 / m.div; };
const hz = (k) => Math.round(440 * 2 ** ((k - 69) / 12) * 10) / 10;
const waveFor = (prog) => (prog === undefined ? 'triangle' : prog < 8 ? 'triangle' : prog >= 24 && prog < 32 ? 'sawtooth' : prog >= 56 && prog < 64 ? 'sawtooth' : 'sine');

/** Reduce to ONE melody line (a ringtone is monophonic), skipping drums (channel 10), capped at MAX_SEC; returns null when there is no usable melody. */
function melodyOf(m) {
  const pitched = m.notes.filter((n) => n.ch !== 9); if (pitched.length < 3) return null;
  const byTrack = new Map(); for (const n of pitched) byTrack.set(n.track + ':' + n.ch, (byTrack.get(n.track + ':' + n.ch) || 0) + 1);
  const lead = [...byTrack.entries()].sort((a, b) => b[1] - a[1])[0][0]; const line = pitched.filter((n) => n.track + ':' + n.ch === lead);
  const seq = []; let t = 0;
  for (const n of line) {
    const s = tickToSec(m, n.start), e = tickToSec(m, n.end); if (s < t - 0.001) continue;                                  // overlapping note: the line stays monophonic
    if (e - 0 > MAX_SEC) break; if (s > t + 0.02) seq.push([0, Math.round((s - t) * 100) / 100]);
    seq.push([hz(n.key), Math.max(0.08, Math.round((e - s) * 100) / 100)]); t = e;
  }
  if (seq.filter((x) => x[0]).length < 3) return null;
  return { notes: seq, seconds: Math.round(t * 10) / 10, wave: waveFor(m.programs.get(Number(lead.split(':')[1]))) };
}

const items = [], skipped = { midi: [], mp3: [] };
// ---- MIDI melodies (Music-DJ)
const samples = path.join(FROM, 'Music-DJ-main', 'playback', 'samples');
if (fs.existsSync(samples)) for (const f of fs.readdirSync(samples).filter((x) => /^sample_\d+_\d+\.mid$/i.test(x)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
  const buf = fs.readFileSync(path.join(samples, f)); const [, set, n] = /^sample_(\d+)_(\d+)\./.exec(f);
  try { const m = melodyOf(readMidi(buf)); if (!m) { skipped.midi.push(f + ' (no melody)'); continue; }
    items.push({ id: `lib-m${set}-${String(n).padStart(2, '0')}`, label: `Melody ${Number(set) + 1}.${n}`, group: 'Library melodies', type: 'notes', wave: m.wave, gain: 0.14, notes: m.notes, seconds: m.seconds,
      source: { project: 'Music-DJ', path: 'playback/samples/' + f, sha256: sha(buf) } }); } catch (e) { skipped.midi.push(f + ' (' + e.message + ')'); }
}
// ---- MP3 tones (awesome-ringtone): short ones only
const ar = path.join(FROM, 'awesome-ringtone-main'); const used = new Set(items.map((i) => i.id));
if (fs.existsSync(ar)) for (const brand of fs.readdirSync(ar, { withFileTypes: true }).filter((d) => d.isDirectory() && !/^(_media|\.github|node_modules)$/.test(d.name)).map((d) => d.name).sort()) {
  for (const f of fs.readdirSync(path.join(ar, brand)).filter((x) => /\.mp3$/i.test(x)).sort()) {
    const full = path.join(ar, brand, f), size = fs.statSync(full).size; if (size > MAX_MP3) { skipped.mp3.push(`${brand}/${f} (${Math.round(size / 1024)} KB)`); continue; }
    let id = `lib-a-${slug(brand)}-${slug(f)}`; for (let i = 2; used.has(id); i++) id = `lib-a-${slug(brand)}-${slug(f)}-${i}`; used.add(id);
    const buf = fs.readFileSync(full), file = id + '.mp3';
    items.push({ id, label: `${brand} - ${f.replace(/\.mp3$/i, '').replace(/^\d{4}\s*-\s*/, '')}`, group: 'Library tones', type: 'audio', file, bytes: size, source: { project: 'awesome-ringtone', path: `${brand}/${f}`, sha256: sha(buf) }, _buf: buf });
  }
}
const manifest = { version: 1, generatedAt: new Date().toISOString(), notice: 'Third-party material imported from a local library folder at the owner\'s request. Rights to redistribute it are NOT verified (Music-DJ recreates a Sony Ericsson app and uses its original samples; the MP3s are phone-brand tones). See docs/RINGTONES.md.',
  rights: 'unverified', items: items.map(({ _buf, ...i }) => ({ ...i, rights: 'unverified' })) };
console.log(`melodies: ${items.filter((i) => i.type === 'notes').length} (skipped ${skipped.midi.length})  |  mp3 tones: ${items.filter((i) => i.type === 'audio').length} (skipped as too long/large: ${skipped.mp3.length})  |  mp3 bytes: ${(items.reduce((a, i) => a + (i.bytes || 0), 0) / 1048576).toFixed(1)} MB`);
if (DRY) { console.log('dry run: nothing written'); process.exit(0); }
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
for (const i of items) if (i._buf) fs.writeFileSync(path.join(OUT, i.file), i._buf);
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n'); console.log('wrote ' + path.relative(root, OUT));
