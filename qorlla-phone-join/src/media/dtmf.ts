/**
 * DTMF over RTP (RFC 4733 telephone-event) and the entry of a meeting ID / PIN. A digit is reported ONCE however many times its packets are repeated (the end packet is sent three times and may arrive twice or not at all);
 * only '0'-'9' are entry digits, '#' ends an entry and '*' restarts it. Every limit is enforced here, so a caller cannot hold the line with a never-ending entry.
 */
const SYMBOLS = '0123456789*#ABCD';
export class DtmfDecoder {
  private last = new Map<number, number>();                                              // ssrc -> RTP timestamp of the last event reported
  /** Returns the digit for the first packet of a new event, else null (repeats of the same event, malformed or out-of-range payloads). */
  decode(ssrc: number, rtpTimestamp: number, payload: Buffer): string | null {
    if (payload.length < 4) return null; const event = payload[0], volume = payload[1] & 0x3f; if (event > 15 || volume > 63) return null;
    if (this.last.get(ssrc) === rtpTimestamp) return null; this.last.set(ssrc, rtpTimestamp); if (this.last.size > 4) this.last.delete(this.last.keys().next().value as number);
    return SYMBOLS[event];
  }
}
/** Builds a telephone-event payload (tests and synthetic phones). */
export const dtmfPayload = (digit: string, durationSamples: number, end: boolean, volume = 10): Buffer => { const e = SYMBOLS.indexOf(digit); if (e < 0) throw new Error('not a DTMF symbol'); const b = Buffer.alloc(4); b[0] = e; b[1] = (end ? 0x80 : 0) | (volume & 0x3f); b.writeUInt16BE(durationSamples & 0xffff, 2); return b; };

export type EntryResult = { ok: true; digits: string } | { ok: false; reason: 'timeout' | 'too_long' | 'too_short' | 'cancelled' };
/** requireTerminator: the entry ends ONLY with '#' (never by reaching a length), so a length range is unambiguous; a digit beyond maxDigits is refused (`too_long`) and is never carried into the next prompt. */
export type EntryRules = { minDigits: number; maxDigits: number; interDigitMs: number; totalMs: number; requireTerminator?: boolean };
export const RULES = { meetingId: { minDigits: 11, maxDigits: 12, interDigitMs: 6000, totalMs: 30_000, requireTerminator: true }, pin: { minDigits: 4, maxDigits: 32, interDigitMs: 6000, totalMs: 40_000 } } as const satisfies Record<string, EntryRules>;
/** Collects one entry. Feed digits with `push`; the promise settles exactly once. */
export class DtmfEntry {
  private digits = ''; private done = false; private idle?: NodeJS.Timeout; private total?: NodeJS.Timeout; private resolve!: (r: EntryResult) => void;
  readonly result: Promise<EntryResult> = new Promise((r) => { this.resolve = r; });
  constructor(private readonly rules: EntryRules, signal?: AbortSignal) {
    this.total = setTimeout(() => this.settle({ ok: false, reason: 'timeout' }), rules.totalMs); this.arm(); signal?.addEventListener('abort', () => this.settle({ ok: false, reason: 'cancelled' }), { once: true });
    if (signal?.aborted) this.settle({ ok: false, reason: 'cancelled' });
  }
  private arm() { clearTimeout(this.idle); this.idle = setTimeout(() => this.settle({ ok: false, reason: 'timeout' }), this.rules.interDigitMs); }
  private settle(r: EntryResult) { if (this.done) return; this.done = true; clearTimeout(this.idle); clearTimeout(this.total); this.digits = ''; this.resolve(r); }    // the digits (a PIN) are not kept after the entry ends
  push(d: string) {
    if (this.done) return; this.arm();
    if (d === '*') { this.digits = ''; return; }
    if (d === '#') return this.digits.length >= this.rules.minDigits ? this.settle({ ok: true, digits: this.digits }) : this.settle({ ok: false, reason: 'too_short' });
    if (d >= '0' && d <= '9') { this.digits += d; if (this.digits.length > this.rules.maxDigits) this.settle({ ok: false, reason: 'too_long' }); else if (!this.rules.requireTerminator && this.rules.minDigits === this.rules.maxDigits && this.digits.length === this.rules.maxDigits) this.settle({ ok: true, digits: this.digits }); }
  }
  cancel() { this.settle({ ok: false, reason: 'cancelled' }); }
}
