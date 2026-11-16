/** G.711 (ITU-T) mu-law (PCMU) and A-law (PCMA), 8 kHz, 16-bit linear PCM on the other side. Table-free, allocation-free per sample. */
const BIAS = 0x84, CLIP = 32635;
export function linearToUlaw(s: number): number {
  let sign = (s >> 8) & 0x80; if (sign) s = -s; if (s > CLIP) s = CLIP; s += BIAS;
  let exp = 7; for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1);
  return ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff;
}
export function ulawToLinear(u: number): number { u = ~u & 0xff; const exp = (u >> 4) & 7, t = (((u & 0x0f) << 3) + BIAS) << exp; return u & 0x80 ? BIAS - t : t - BIAS; }
const AEND = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
export function linearToAlaw(pcm: number): number {
  pcm >>= 3; let mask: number; if (pcm >= 0) mask = 0xd5; else { mask = 0x55; pcm = -pcm - 1; }
  let seg = 0; while (seg < 8 && pcm > AEND[seg]) seg++; if (seg >= 8) return 0x7f ^ mask;
  return (((seg << 4) | (seg < 2 ? (pcm >> 1) & 0x0f : (pcm >> seg) & 0x0f)) ^ mask) & 0xff;
}
export function alawToLinear(a: number): number {
  a ^= 0x55; let t = (a & 0x0f) << 4; const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8; else if (seg === 1) t += 0x108; else { t += 0x108; t <<= seg - 1; }
  return a & 0x80 ? t : -t;
}
export type G711 = 'PCMU' | 'PCMA';
export function encode(codec: G711, pcm: Int16Array): Buffer { const f = codec === 'PCMU' ? linearToUlaw : linearToAlaw, out = Buffer.allocUnsafe(pcm.length); for (let i = 0; i < pcm.length; i++) out[i] = f(pcm[i]); return out; }
export function decode(codec: G711, data: Uint8Array): Int16Array { const f = codec === 'PCMU' ? ulawToLinear : alawToLinear, out = new Int16Array(data.length); for (let i = 0; i < data.length; i++) out[i] = f(data[i]); return out; }
/** Linear PCM -> dBFS of the frame's RMS (-Infinity for pure silence). */
export function rmsDb(pcm: Int16Array): number { if (!pcm.length) return -Infinity; let s = 0; for (const v of pcm) s += v * v; const r = Math.sqrt(s / pcm.length) / 32768; return r === 0 ? -Infinity : 20 * Math.log10(r); }
