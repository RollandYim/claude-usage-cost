import { describe, it, expect } from 'vitest';
import { formatTokens, formatUSD, truncateModelName } from '../src/cost/costFormatter';

// ── formatTokens ──────────────────────────────────────────────────────────────

describe('formatTokens', () => {
  it('returns "0" for 0', () => expect(formatTokens(0)).toBe('0'));
  it('returns plain number for values < 1 000', () => expect(formatTokens(999)).toBe('999'));
  it('formats 1 234 as "1.2k"', () => expect(formatTokens(1_234)).toBe('1.2k'));
  it('formats 1 000 as "1.0k"', () => expect(formatTokens(1_000)).toBe('1.0k'));
  it('formats 9 999 as "10.0k"', () => expect(formatTokens(9_999)).toBe('10.0k'));
  it('formats 1 234 567 as "1.2M"', () => expect(formatTokens(1_234_567)).toBe('1.2M'));
  it('formats 1 000 000 as "1.0M"', () => expect(formatTokens(1_000_000)).toBe('1.0M'));
  it('formats 12 345 678 as "12.3M"', () => expect(formatTokens(12_345_678)).toBe('12.3M'));
});

// ── formatUSD ─────────────────────────────────────────────────────────────────

describe('formatUSD', () => {
  it('formats 0.1 with 2 decimal places', () => expect(formatUSD(0.1, 2)).toBe('$0.10'));
  it('formats 3.47 with 2 decimal places', () => expect(formatUSD(3.47, 2)).toBe('$3.47'));
  it('formats 0 with 2 decimal places', () => expect(formatUSD(0, 2)).toBe('$0.00'));
  it('formats 123.456 with 2 decimal places (rounds)', () => expect(formatUSD(123.456, 2)).toBe('$123.46'));
  it('formats 0.123456 with 4 decimal places', () => expect(formatUSD(0.123456, 4)).toBe('$0.1235'));
  it('formats 0.1 with 4 decimal places', () => expect(formatUSD(0.1, 4)).toBe('$0.1000'));
  it('formats 0 with 4 decimal places', () => expect(formatUSD(0, 4)).toBe('$0.0000'));
});

// ── truncateModelName ─────────────────────────────────────────────────────────

describe('truncateModelName', () => {
  it('returns the name unchanged when shorter than max', () => {
    expect(truncateModelName('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('returns the name unchanged when exactly max length', () => {
    const name = 'a'.repeat(32);
    expect(truncateModelName(name)).toBe(name);
  });

  it('truncates and appends ellipsis when longer than max', () => {
    const name = 'a'.repeat(33);
    const result = truncateModelName(name);
    expect(result).toHaveLength(32);
    expect(result.endsWith('\u2026')).toBe(true);
  });

  it('respects a custom max', () => {
    const result = truncateModelName('hello-world', 8);
    expect(result).toHaveLength(8);
    expect(result).toBe('hello-w\u2026');
  });
});
