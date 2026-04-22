import type { DisplayMode, UsageData, UsageWindow } from './types';

// ── Utilization ───────────────────────────────────────────────────────────────

export function clampUtilization(raw: number): number {
  if (isNaN(raw)) return 0;
  if (Object.is(raw, -0)) return 0;
  if (raw < 0) return 0;
  if (raw > 100) return 100;
  return raw;
}

// ── Date parsing ──────────────────────────────────────────────────────────────

// Detects epoch-seconds vs epoch-milliseconds by magnitude threshold (year ~2001 in ms ≈ 1e12).
export function parseResetsAt(value: string | number): Date {
  if (typeof value === 'string') return new Date(value);
  return value > 1e12 ? new Date(value) : new Date(value * 1000);
}

// ── Countdown formatting ──────────────────────────────────────────────────────

// formatCountdown EBNF (D5):
//   ≥24h, remHours>0  →  "NdNh"  (compact, e.g. "5d23h")
//   ≥24h, remHours=0  →  "Nd"
//   <24h, ≥1h         →  "Nh Nm" (space before m, e.g. "4h 8m")
//   <1h               →  "Nm"
//   ≤0                →  "0m"
export function formatCountdown(resetAt: number | string, now: Date = new Date()): string {
  const resetsAt = parseResetsAt(resetAt);
  const diffMs = resetsAt.getTime() - now.getTime();
  if (diffMs <= 0) return '0m';
  const totalMin = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMin / 60);
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  const remMin = totalMin % 60;
  if (days > 0) return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
  if (hours > 0) return `${hours}h ${remMin}m`;
  return `${totalMin}m`;
}

// ── Cost formatting ───────────────────────────────────────────────────────────

/**
 * Formats a USD amount for the status bar (two decimal places, `$` prefix).
 *
 * @example
 * formatCost(0)      // '$0.00'
 * formatCost(3.47)   // '$3.47'
 * formatCost(123.456) // '$123.46'
 */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

// ── Status bar rendering ──────────────────────────────────────────────────────

function renderSegment(prefix: string, win: UsageWindow | null, now: Date): string {
  if (!win) return `${prefix}：—`;
  const pct = Math.round(win.utilization);
  const countdown = formatCountdown(win.resetsAt.getTime(), now);
  return `${prefix}：${pct}% · ${countdown}`;
}

// Returns the status bar text string.
// Callers should display "$(loading~spin) Claude Usage" when UsageData is not yet available.
// Format (D2):
//   session  →  "S：82% · 1h 12m"
//   weekly   →  "W：26% · 5d23h"
//   both     →  "S：82% · 1h 12m  W：26% · 5d23h"  (two half-width spaces between segments)
export function renderStatusBar(
  data: UsageData,
  mode: DisplayMode,
  now: Date = new Date(),
): string {
  if (mode === 'session') return renderSegment('S', data.fiveHour, now);
  if (mode === 'weekly') return renderSegment('W', data.sevenDay, now);
  return `${renderSegment('S', data.fiveHour, now)}  ${renderSegment('W', data.sevenDay, now)}`;
}
