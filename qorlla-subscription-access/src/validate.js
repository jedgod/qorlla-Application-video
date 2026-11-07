/**
 * Strict quantity validation. One place, used by the service, the middleware, the Meet guard and the example, so the number that
 * is CHECKED is exactly the number that is CONSUMED. There are no fallbacks: a missing or malformed count is an error, never "1".
 *
 * Accepted: a JavaScript number that is a whole number from 1 up to the configured maximum.
 * Rejected: undefined/null (when required), strings (including "5"), booleans, arrays, objects, NaN, Infinity (also 1e999 from JSON),
 *           fractions, zero, negatives, and anything above the maximum.
 */

import { InvalidQuantityError, QuantityRequiredError, QuantityTooLargeError } from './errors.js';

/** Safety ceiling for any single request quantity (the largest plan limits are far below this). */
export const DEFAULT_MAX_QUANTITY = 1_000_000;

/**
 * @param {unknown} value
 * @param {{ required?: boolean, max?: number, name?: string }} [o]
 * @returns {number|undefined} the validated integer, or undefined when the value is absent and not required
 */
export function strictQuantity(value, { required = true, max = DEFAULT_MAX_QUANTITY, name = 'quantity' } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new QuantityRequiredError(name);
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) throw new InvalidQuantityError();
  if (value > max) throw new QuantityTooLargeError(name, max);
  return value;
}

/** For values that can only arrive as text (query strings, headers): plain decimal digits, no sign, no exponent, no leading zero. */
export function quantityFromText(text, o) {
  if (typeof text !== 'string' || !/^[1-9][0-9]{0,15}$/.test(text)) {
    if (text === undefined || text === null) return strictQuantity(text, o);
    throw new InvalidQuantityError();
  }
  return strictQuantity(Number(text), o);
}
