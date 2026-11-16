/**
 * A small fixed-depth jitter buffer for 20 ms G.711 frames. Reorders by (extended) sequence number, drops duplicates and frames that arrive after their playout slot, conceals a lost frame by repeating the last one
 * (then fading to silence) and reports what it did. The depth trades delay for resilience: depth * ptime of added latency. Pull model: the leg's playout clock calls `pop()` once per frame period.
 */
export type JitterStats = { received: number; played: number; lost: number; late: number; duplicates: number; concealed: number; reordered: number; jitterMs: number; depth: number };
export class JitterBuffer<T> {
  private frames = new Map<number, T>(); private next: number | null = null; private highest = -1; private lastSeq = -1;
  private started = false; private last: T | null = null; private repeat = 0; private readonly skipped = new Set<number>();
  readonly stats: JitterStats = { received: 0, played: 0, lost: 0, late: 0, duplicates: 0, concealed: 0, reordered: 0, jitterMs: 0, depth: 0 };
  private transit = NaN;
  constructor(private readonly depth = 3, private readonly maxConceal = 3, private readonly frameMs = 20) { this.stats.depth = depth; }
  /** Extends the 16-bit sequence number across wraps (delta from the highest seen, so reordering around a wrap stays correct). */
  private extend(seq: number): number {
    if (this.lastSeq < 0) { this.lastSeq = seq; return seq; }
    let delta = seq - (this.lastSeq & 0xffff); if (delta > 32768) delta -= 65536; else if (delta < -32768) delta += 65536;
    const ext = this.lastSeq + delta; if (ext > this.lastSeq) this.lastSeq = ext; return ext;
  }
  push(seq: number, frame: T, arrivalMs: number, rtpMs: number) {
    const s = this.extend(seq); this.stats.received++;
    const t = arrivalMs - rtpMs; if (!Number.isNaN(this.transit)) { const d = Math.abs(t - this.transit); this.stats.jitterMs += (d - this.stats.jitterMs) / 16; } this.transit = t;       // RFC 3550 interarrival jitter estimate
    if (this.next !== null && s < this.next) { this.stats.late++; return; }
    if (this.frames.has(s)) { this.stats.duplicates++; return; }
    if (s < this.highest) this.stats.reordered++; this.highest = Math.max(this.highest, s); this.frames.set(s, frame);
    if (this.next === null) this.next = s;
    if (this.frames.size > this.depth * 4) { const min = Math.min(...this.frames.keys()); this.frames.delete(min); this.stats.late++; }     // never grow without bound
  }
  /** A sequence number that carried something other than audio (an RFC 4733 DTMF event shares the RTP sequence space): it is not a lost frame. */
  skip(seq: number) { const s = this.extend(seq); if (this.next === null || s < this.next) return; this.highest = Math.max(this.highest, s); this.skipped.add(s); if (this.skipped.size > 256) this.skipped.delete(this.skipped.keys().next().value as number); }
  /** One playout tick. Returns the next frame, a concealment frame for a gap, or null while the buffer is still filling / the stream has stopped. */
  pop(): { frame: T; concealed: boolean } | null {
    if (this.next === null) return null;
    if (!this.started) { if (this.frames.size < this.depth) return null; this.started = true; }
    while (this.skipped.has(this.next)) { this.skipped.delete(this.next); this.next++; }
    const f = this.frames.get(this.next);
    if (f !== undefined) { this.frames.delete(this.next); this.next++; this.last = f; this.repeat = 0; this.stats.played++; return { frame: f, concealed: false }; }
    if (this.frames.size === 0) return null;                                                                                    // nothing newer is waiting: the stream is idle, not lossy
    const oldest = Math.min(...this.frames.keys());
    if (oldest - this.next > this.maxConceal + this.depth) { this.stats.lost += oldest - this.next; this.next = oldest; this.repeat = this.maxConceal; return null; }    // a long gap (the sender paused, or a burst was lost): resynchronise at once instead of stepping through it while live audio piles up
    if (this.highest - this.next < this.depth - 1) return null;                                                                 // not overdue yet: newer frames have not piled up, so this one may still arrive (reordering / jitter within the buffer depth)
    this.next++; this.stats.lost++;                                                                                              // `depth` newer frames have arrived and this one has not: it is lost
    if (this.last !== null && this.repeat < this.maxConceal) { this.repeat++; this.stats.concealed++; return { frame: this.last, concealed: true }; }
    return null;
  }
}
