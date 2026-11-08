// The PLACEHOLDER renderer. It is not an avatar: there is no speech or face model in this project. It makes a short title-card video
// (dark background, a clear "placeholder" label, the presenter's name, the draft's title and a few lines of its script, silent audio) so the
// whole pipeline (queue -> render -> storage -> Ready -> preview -> save to My clips) runs for real. A real renderer replaces this file only.
//
// Safety: ffmpeg is started with an argument ARRAY (no shell), and every piece of user text goes through a text FILE (drawtext's
// textfile=), never into the filter string, so a title cannot inject filter options or commands.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * How long the placeholder runs. A real presenter takes as long as the speech does, so the length follows the script at about 2.5 words a
 * second (150 a minute): never shorter than `min`, never longer than `max` (the avatar tier's limit, set by the API; 90 s for Basic).
 */
export function renderSeconds(script, max, min = 6) {
  const words = String(script ?? '').trim().split(/\s+/).filter(Boolean).length;
  return Math.min(max, Math.max(min, Math.ceil(words / 2.5)));
}

export const LABEL = 'PLACEHOLDER RENDER - NOT A REAL AVATAR VIDEO';

/** Printable text only, wrapped to `width` columns, at most `maxLines` lines (an ellipsis marks anything cut). */
export function wrapText(input, width, maxLines) {
  const words = String(input ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = []; let cur = '';
  for (let w of words) {
    while (w.length > width) { if (cur) { lines.push(cur); cur = ''; } lines.push(w.slice(0, width)); w = w.slice(width); }
    if (!cur) cur = w; else if ((cur + ' ' + w).length <= width) cur += ' ' + w; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { const kept = lines.slice(0, maxLines); kept[maxLines - 1] = kept[maxLines - 1].slice(0, Math.max(0, width - 1)) + '…'; return kept.join('\n'); }
  return lines.join('\n');
}

/** Step 1: the card, one picture. Pure, so it can be tested without ffmpeg. File names are relative to the working directory ffmpeg runs in. */
export function cardArgs({ font, hasScript }) {
  const t = (file, size, y, color) => `drawtext=fontfile=${font}:textfile=${file}:reload=0:fontcolor=${color}:fontsize=${size}:x=(w-text_w)/2:y=${y}:line_spacing=10`;
  const filters = [t('label.txt', 24, 70, '0xf5b942'), t('name.txt', 38, 160, '0x9fb3ff'), t('title.txt', 54, 250, 'white')];
  if (hasScript) filters.push(t('script.txt', 30, 460, '0xd5dbea'));
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x0b1020:s=1280x720:d=1',
    '-vf', filters.join(','), '-frames:v', '1', 'card.png',
  ];
}

/** Step 2: the picture as a video of exactly `seconds` seconds, with silent audio. A still image at 5 frames a second is tiny and cheap to encode, even on a busy machine. */
export function videoArgs({ seconds }) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-loop', '1', '-framerate', '5', '-i', 'card.png',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', String(seconds),
    '-c:v', 'libx264', '-tune', 'stillimage', '-profile:v', 'main', '-preset', 'ultrafast', '-threads', '2', '-crf', '28', '-pix_fmt', 'yuv420p', '-r', '5',
    '-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart',
    'out.mp4',
  ];
}

function runFfmpeg(ffmpeg, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { cwd, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`ffmpeg timed out after ${timeoutMs} ms`)); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(`could not start ffmpeg: ${e.message}`)); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${err.trim().slice(-500)}`)); });
  });
}

/**
 * Renders one placeholder video and returns { file, bytes, dir, seconds }. The caller removes `dir` when it is done with the file.
 * Rejects when ffmpeg fails, produces nothing, or takes longer than timeoutMs (it is killed).
 */
export async function renderPlaceholder({ ffmpeg = 'ffmpeg', font = '/usr/share/fonts/dejavu/DejaVuSans.ttf', title, avatarName, script, maxSeconds = 300, timeoutMs = 300000, baseDir = os.tmpdir() }) {
  const seconds = renderSeconds(script, maxSeconds);
  const dir = await mkdtemp(path.join(baseDir, 'avatar-render-'));
  try {
    const files = { 'label.txt': LABEL, 'name.txt': wrapText(avatarName, 40, 1), 'title.txt': wrapText(title, 30, 3), 'script.txt': wrapText(script, 56, 5) };
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text, 'utf8');
    // Two steps, because the card never changes: draw it ONCE as a picture, then turn the picture into a video of the wanted length.
    // (Drawing the text on every frame of a 90 s video took longer than the time limit; this takes about a second at any length.)
    await runFfmpeg(ffmpeg, cardArgs({ font, hasScript: !!files['script.txt'] }), dir, timeoutMs);
    await runFfmpeg(ffmpeg, videoArgs({ seconds }), dir, timeoutMs);
    const file = path.join(dir, 'out.mp4');
    const { size } = await stat(file);
    if (!(size > 0)) throw new Error('ffmpeg produced an empty file');
    return { file, bytes: size, dir, seconds };
  } catch (e) { await rm(dir, { recursive: true, force: true }); throw e; }
}
