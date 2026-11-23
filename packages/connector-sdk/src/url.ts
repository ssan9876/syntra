/**
 * `value` without trailing `/` characters.
 *
 * A loop, not `/\/+$/`: that regex retries at every position of a slash run
 * that does not reach the end, so a long run took quadratic time (CodeQL
 * js/polynomial-redos).
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end--;
  return value.slice(0, end);
}
