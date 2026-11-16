/**
 * The meeting code a caller keys in (Gate A5.3). Two lengths are legitimate and both resolve exactly: 11 digits (the main application's meeting ID, registered in Meet as an alias) and 12 digits (Meet's own primary code).
 * A code is a STRING, never a number: leading zeros are significant. Only the display separators a person types (a space or a hyphen) are removed; any other character makes the input invalid. Nothing is padded, truncated,
 * reinterpreted or converted: the digits that come out are exactly the digits that went in.
 */
export const MEETING_CODE_LENGTHS = [11, 12] as const;
export function normalizeMeetingCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 40) return null;
  const digits = input.replace(/[ -]/g, '');
  return /^\d{11,12}$/.test(digits) ? digits : null;
}
