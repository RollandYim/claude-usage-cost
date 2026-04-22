/**
 * Formatting helpers for cost-tracking display.
 *
 * Kept pure (no VS Code imports) so they can be unit-tested in a plain Node environment.
 */

/**
 * Formats a token count into a compact human-readable string.
 *
 * @example
 * formatTokens(0)         // '0'
 * formatTokens(1_234)     // '1.2k'
 * formatTokens(1_234_567) // '1.2M'
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Formats a USD amount prefixed with `$`.
 *
 * @param n      - Amount in US dollars.
 * @param digits - Number of decimal places: `2` for status-bar display, `4` for tooltip detail.
 *
 * @example
 * formatUSD(0.1, 2)        // '$0.10'
 * formatUSD(0.123456, 4)   // '$0.1235'
 */
export function formatUSD(n: number, digits: 2 | 4): string {
  return `$${n.toFixed(digits)}`;
}

/**
 * Truncates a model name to at most `max` characters, appending `…` when truncated.
 *
 * @param name - The original model name.
 * @param max  - Maximum allowed character length (default: 32).
 */
export function truncateModelName(name: string, max = 32): string {
  if (name.length <= max) return name;
  return `${name.slice(0, max - 1)}\u2026`;
}
