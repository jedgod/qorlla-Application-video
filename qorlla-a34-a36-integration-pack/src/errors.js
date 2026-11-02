export class VoiceError extends Error {
  constructor(code, status = 403) { super(code); this.name = 'VoiceError'; this.code = code; this.status = status; }
}
export const refuse = (code, status) => { throw new VoiceError(code, status); };
