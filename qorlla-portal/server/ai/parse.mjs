// Transcript import: plain text ("Speaker: words"), WebVTT and SRT -> speaker-labelled segments.
// Speaker labels exist only when the file carries them; they are display names typed by people, so they are always "unverified".
export const MAX_TRANSCRIPT_CHARS = 500_000;
export const MAX_SEGMENTS = 20_000;

const clean = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\r\n?/g, '\n');
const SPEAKER = /^([^:\n]{1,60}):\s+(.+)$/;
const tsMs = (t) => { const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(t.trim()); return m ? ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, '0')) : null; };

function finish(segments) {
  if (!segments.length) throw Object.assign(new Error('The transcript has no readable text.'), { code: 'empty_transcript' });
  if (segments.length > MAX_SEGMENTS) throw Object.assign(new Error('The transcript is too long.'), { code: 'transcript_too_large' });
  const labelled = segments.filter((s) => s.speaker).length;
  const speakerLabels = labelled / segments.length >= 0.5 ? 'unverified' : 'none';
  const norm = segments.map((s) => ({ speaker: speakerLabels === 'none' ? null : (s.speaker || 'Unknown'), text: s.text, ...(s.start_ms != null ? { start_ms: s.start_ms } : {}), ...(s.at ? { at: s.at } : {}) }));
  return { segments: norm, speakerLabels, fullText: norm.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join('\n') };
}
function splitSpeaker(text) { const m = SPEAKER.exec(text.trim()); return m ? { speaker: m[1].trim(), text: m[2].trim() } : { speaker: null, text: text.trim() }; }

export function parseTranscript(format, raw) {
  if (typeof raw !== 'string') throw Object.assign(new Error('Transcript text is required.'), { code: 'bad_transcript' });
  if (raw.length > MAX_TRANSCRIPT_CHARS) throw Object.assign(new Error('The transcript is too long.'), { code: 'transcript_too_large' });
  const text = clean(raw);
  if (/\u0000/.test(raw)) throw Object.assign(new Error('Binary data is not a transcript.'), { code: 'bad_transcript' });
  const segments = [];
  if (format === 'txt') {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const { speaker, text: t } = splitSpeaker(line);
      const last = segments[segments.length - 1];
      if (!speaker && last && last.speaker && !SPEAKER.test(line)) { last.text += ' ' + t; continue; }   // wrapped line continues the previous speaker
      segments.push({ speaker, text: t });
    }
  } else if (format === 'vtt' || format === 'srt') {
    const blocks = text.replace(/^WEBVTT[^\n]*\n/, '').split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.split('\n').filter((l) => l.trim());
      const ti = lines.findIndex((l) => l.includes('-->')); if (ti < 0) continue;
      const start = tsMs(lines[ti].split('-->')[0]);
      const body = lines.slice(ti + 1).join(' ').trim(); if (!body) continue;
      const voice = /^<v\s+([^>]{1,60})>(.*)$/.exec(body);
      const sp = voice ? { speaker: voice[1].trim(), text: voice[2].replace(/<\/v>/g, '').trim() } : splitSpeaker(body.replace(/<[^>]+>/g, ''));
      if (sp.text) segments.push({ ...sp, start_ms: start });
    }
  } else throw Object.assign(new Error('Unsupported transcript format.'), { code: 'bad_format' });
  return finish(segments);
}

/** Meet chat export -> segments (speakers are the display names participants typed: unverified). */
export function segmentsFromMeetChat(messages) {
  const segs = (messages || []).filter((m) => m && typeof m.text === 'string' && m.text.trim()).map((m) => ({ speaker: String(m.speaker || 'Unknown').slice(0, 70), text: clean(m.text).trim().slice(0, 4000), at: m.at }));
  if (!segs.length) throw Object.assign(new Error('The meeting chat has no messages to process.'), { code: 'no_content' });
  return finish(segs.map((s) => ({ ...s })));
}
