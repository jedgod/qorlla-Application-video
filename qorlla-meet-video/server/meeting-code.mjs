// The meeting code a telephone caller keys in (Gate A5.3). Two lengths are legitimate and both resolve exactly: 11 digits (the main application's meeting ID, registered here as an alias) and 12 digits (Meet's own primary code).
// A code is a STRING, never a number: leading zeros are significant. Only the separators a person types (a space or a hyphen) are removed; any other character makes the input invalid. No padding, truncation or conversion.
// (The browser join path keeps its own, wider, resolver: existing 10-digit aliases must keep resolving there until their existence is established.)
export function normalizePhoneMeetingCode(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > 40) return null;
  const digits = input.replace(/[ -]/g, '');
  return /^\d{11,12}$/.test(digits) ? digits : null;
}
