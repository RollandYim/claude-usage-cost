import { describe, it, expect } from 'vitest';
import { parseWeeklyCostDays, WEEKLY_COST_DAYS_DEFAULT } from '../src/config';

describe('parseWeeklyCostDays', () => {
  it('returns "all" for the literal "all" (any casing)', () => {
    expect(parseWeeklyCostDays('all')).toBe('all');
    expect(parseWeeklyCostDays('ALL')).toBe('all');
    expect(parseWeeklyCostDays(' All ')).toBe('all');
  });

  it('returns the numeric value for positive integer strings', () => {
    expect(parseWeeklyCostDays('7')).toBe(7);
    expect(parseWeeklyCostDays('14')).toBe(14);
    expect(parseWeeklyCostDays('90')).toBe(90);
  });

  it('returns the numeric value for positive integer numbers', () => {
    expect(parseWeeklyCostDays(7)).toBe(7);
    expect(parseWeeklyCostDays(30)).toBe(30);
  });

  it('falls back to default for invalid / non-positive values', () => {
    expect(parseWeeklyCostDays(0)).toBe(WEEKLY_COST_DAYS_DEFAULT);
    expect(parseWeeklyCostDays(-5)).toBe(WEEKLY_COST_DAYS_DEFAULT);
    expect(parseWeeklyCostDays('abc')).toBe(WEEKLY_COST_DAYS_DEFAULT);
    expect(parseWeeklyCostDays('')).toBe(WEEKLY_COST_DAYS_DEFAULT);
    expect(parseWeeklyCostDays(null)).toBe(WEEKLY_COST_DAYS_DEFAULT);
    expect(parseWeeklyCostDays(undefined)).toBe(WEEKLY_COST_DAYS_DEFAULT);
    expect(parseWeeklyCostDays(NaN)).toBe(WEEKLY_COST_DAYS_DEFAULT);
    expect(parseWeeklyCostDays(3.5)).toBe(WEEKLY_COST_DAYS_DEFAULT);
  });
});
