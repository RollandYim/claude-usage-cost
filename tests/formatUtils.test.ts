import { describe, it, expect } from 'vitest';
import {
  clampUtilization,
  parseResetsAt,
  formatCountdown,
  renderStatusBar,
} from '../src/formatUtils';
import type { UsageData, UsageWindow } from '../src/types';

// ── clampUtilization ──────────────────────────────────────────────────────────

describe('clampUtilization', () => {
  it('returns 0 for input 0', () => expect(clampUtilization(0)).toBe(0));
  it('returns 50 for input 50', () => expect(clampUtilization(50)).toBe(50));
  it('returns 100 for input 100', () => expect(clampUtilization(100)).toBe(100));
  it('clamps 105 to 100', () => expect(clampUtilization(105)).toBe(100));
  it('clamps 105.3 to 100', () => expect(clampUtilization(105.3)).toBe(100));
  it('clamps -1 to 0', () => expect(clampUtilization(-1)).toBe(0));
  it('returns 0 for NaN', () => expect(clampUtilization(NaN)).toBe(0));
  it('clamps Infinity to 100', () => expect(clampUtilization(Infinity)).toBe(100));
  it('clamps -Infinity to 0', () => expect(clampUtilization(-Infinity)).toBe(0));
  it('returns positive 0 for -0', () => expect(Object.is(clampUtilization(-0), 0)).toBe(true));
});

// ── parseResetsAt ─────────────────────────────────────────────────────────────

describe('parseResetsAt', () => {
  it('parses ISO string', () => {
    const d = parseResetsAt('2026-04-21T15:30:00Z');
    expect(d.getTime()).toBe(new Date('2026-04-21T15:30:00Z').getTime());
  });

  it('parses epoch milliseconds (>1e12)', () => {
    const ms = new Date('2026-04-21T15:30:00Z').getTime();
    expect(parseResetsAt(ms).getTime()).toBe(ms);
  });

  it('parses epoch seconds (<1e12)', () => {
    const ms = new Date('2026-04-21T15:30:00Z').getTime();
    const sec = Math.floor(ms / 1000);
    expect(parseResetsAt(sec).getTime()).toBe(sec * 1000);
  });
});

// ── formatCountdown ───────────────────────────────────────────────────────────

describe('formatCountdown', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  const ms = (h: number, m = 0, s = 0) =>
    new Date(now.getTime() + (h * 3600 + m * 60 + s) * 1000).getTime();

  it('returns 0m when time has already passed', () => {
    expect(formatCountdown(ms(-1), now)).toBe('0m');
  });

  it('returns 0m when exactly at now', () => {
    expect(formatCountdown(now.getTime(), now)).toBe('0m');
  });

  it('returns 25m for 25 minutes', () => {
    expect(formatCountdown(ms(0, 25), now)).toBe('25m');
  });

  it('returns 1h 15m for 1h15m', () => {
    expect(formatCountdown(ms(1, 15), now)).toBe('1h 15m');
  });

  it('returns 5h 30m for 5h30m', () => {
    expect(formatCountdown(ms(5, 30), now)).toBe('5h 30m');
  });

  it('returns 23h 59m for 23h59m', () => {
    expect(formatCountdown(ms(23, 59), now)).toBe('23h 59m');
  });

  it('returns 1d for exactly 24h (remHours=0)', () => {
    expect(formatCountdown(ms(24, 0), now)).toBe('1d');
  });

  it('returns 2d for exactly 48h', () => {
    expect(formatCountdown(ms(48, 0), now)).toBe('2d');
  });

  it('returns 5d23h for 5d23h', () => {
    expect(formatCountdown(ms(5 * 24 + 23), now)).toBe('5d23h');
  });

  it('accepts ISO string input (same result as epoch ms)', () => {
    const resetIso = '2026-01-01T01:15:00Z';
    const resetMs = new Date(resetIso).getTime();
    expect(formatCountdown(resetIso, now)).toBe('1h 15m');
    expect(formatCountdown(resetMs, now)).toBe('1h 15m');
  });

  it('accepts epoch seconds (detects via magnitude)', () => {
    const resetMs = new Date('2026-01-01T01:15:00Z').getTime();
    const resetSec = Math.floor(resetMs / 1000);
    expect(formatCountdown(resetSec, now)).toBe('1h 15m');
  });
});

// ── renderStatusBar ───────────────────────────────────────────────────────────

describe('renderStatusBar', () => {
  const makeWin = (utilization: number, hoursAhead: number): UsageWindow => ({
    utilization,
    resetsAt: new Date(Date.now() + hoursAhead * 3600_000),
  });

  const baseData = (fiveHour: UsageWindow | null, sevenDay: UsageWindow | null): UsageData => ({
    fiveHour,
    sevenDay,
    sevenDaySonnet: null,
    extraUsage: null,
    fetchedAt: Date.now(),
  });

  it('session mode: renders S：prefix with 0%', () => {
    const data = baseData(makeWin(0, 1), null);
    expect(renderStatusBar(data, 'session')).toMatch(/^S：0% · /);
  });

  it('session mode: renders S：prefix with 100%', () => {
    const data = baseData(makeWin(100, 1), null);
    expect(renderStatusBar(data, 'session')).toMatch(/^S：100% · /);
  });

  it('weekly mode: renders W：prefix with 22%', () => {
    const data = baseData(null, makeWin(22, 24));
    expect(renderStatusBar(data, 'weekly')).toMatch(/^W：22% · /);
  });

  it('weekly mode with injected now: full format 5d23h', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const resetAt = new Date('2026-01-06T23:00:00Z'); // exactly 5d23h ahead
    const data = baseData(null, { utilization: 22, resetsAt: resetAt });
    expect(renderStatusBar(data, 'weekly', now)).toBe('W：22% · 5d23h');
  });

  it('both mode: starts with S：', () => {
    const data = baseData(makeWin(50, 2), makeWin(30, 5));
    expect(renderStatusBar(data, 'both')).toMatch(/^S：/);
  });

  it('both mode: contains W：', () => {
    const data = baseData(makeWin(50, 2), makeWin(30, 5));
    expect(renderStatusBar(data, 'both')).toMatch(/W：/);
  });

  it('both mode: exactly 2 spaces between S and W segments', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const resetS = new Date('2026-01-01T01:00:00Z'); // 1h
    const resetW = new Date('2026-01-06T23:00:00Z'); // 5d23h
    const data = baseData(
      { utilization: 10, resetsAt: resetS },
      { utilization: 22, resetsAt: resetW },
    );
    const result = renderStatusBar(data, 'both', now);
    // Split on the double-space separator between segments
    const parts = result.split('  ');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^S：/);
    expect(parts[1]).toMatch(/^W：/);
  });

  it('both mode: full deterministic output', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const resetS = new Date('2026-01-01T01:00:00Z');
    const resetW = new Date('2026-01-06T23:00:00Z');
    const data = baseData(
      { utilization: 10, resetsAt: resetS },
      { utilization: 22, resetsAt: resetW },
    );
    expect(renderStatusBar(data, 'both', now)).toBe('S：10% · 1h 0m  W：22% · 5d23h');
  });
});
