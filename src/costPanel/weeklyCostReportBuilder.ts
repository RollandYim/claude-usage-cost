import * as vscode from 'vscode';
import type { TokenUsageRecord } from '../types';
import type { AccountIdentityService } from '../cost/accountIdentity';
import type { UsageLogReader } from '../cost/usageLogReader';
import type { PricingTable } from '../cost/pricingTable';
import type { CostStore } from '../cost/costStore';

/** Per-model breakdown within a single day. */
export interface WeeklyCostModelRow {
  /** Canonical model name as it appears in the log (or the store key). */
  model: string;
  /** Compact label for display, e.g. `opus-4.7`, `sonnet-4.6`. */
  shortLabel: string;
  /**
   * Primary-path token breakdown. In the fallback (store-only) path these four
   * fields stay 0 because `CostEntry.byModel` doesn't preserve per-category
   * tokens — the renderer marks them with `—` in that case.
   */
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
  /**
   * True when this row's per-category tokens were not available (fallback path).
   * The renderer uses this to replace individual token columns with `—`.
   */
  tokensBreakdownKnown: boolean;
}

export interface WeeklyCostRow {
  dateLocal: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
  /** Non-empty iff the day had usage. Sorted by `costUSD` descending. */
  byModel: WeeklyCostModelRow[];
}

export type WeeklyCostTotals = Omit<WeeklyCostRow, 'dateLocal' | 'byModel'>;

export interface WeeklyCostGroup {
  /** Display label for this group (e.g. "Last 7 days" or "2026-04"). */
  label: string;
  /** Rows ordered from newest to oldest. */
  rows: WeeklyCostRow[];
  /** Per-group subtotal (sum of every field across `rows`). */
  totals: WeeklyCostTotals;
}

export interface WeeklyCostReport {
  /**
   * One or more groups of per-day rows.
   *
   * - `mode: 'range'` → exactly one group covering the last N days (newest first).
   * - `mode: 'all'`   → one group per calendar month with recorded usage,
   *                     months ordered newest first; empty array if no data.
   */
  groups: WeeklyCostGroup[];
  /** Sum across every group — used for the "Grand Total" row in multi-group mode. */
  grandTotals: WeeklyCostTotals;
  accountUuid: string;
  accountEmail: string | null;
  generatedAt: number;
  /** `true` when `scanDateRange` threw and we fell back to `CostStore.entries`. */
  scanFailed: boolean;
  /** Report mode; the panel chooses layout hints from this flag. */
  mode: 'range' | 'all';
  /** Short human-readable summary of the window (e.g. "Last 7 days" / "All time"). */
  rangeLabel: string;
}

function newZeroRow(dateLocal: string): WeeklyCostRow {
  return {
    dateLocal,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUSD: 0,
    byModel: [],
  };
}

function newZeroModelRow(model: string): WeeklyCostModelRow {
  return {
    model,
    shortLabel: shortenModelName(model),
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUSD: 0,
    tokensBreakdownKnown: true,
  };
}

function newZeroTotals(): WeeklyCostTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUSD: 0,
  };
}

function addRowInto(acc: WeeklyCostTotals, r: WeeklyCostTotals): void {
  acc.inputTokens += r.inputTokens;
  acc.outputTokens += r.outputTokens;
  acc.cacheCreationTokens += r.cacheCreationTokens;
  acc.cacheReadTokens += r.cacheReadTokens;
  acc.totalTokens += r.totalTokens;
  acc.costUSD = round6(acc.costUSD + r.costUSD);
}

/** Returns the N local-timezone YYYY-MM-DD strings ending at `today` (oldest first). */
export function lastNLocalDates(n: number, today: Date): string[] {
  const size = Math.max(1, Math.floor(n));
  const out: string[] = [];
  for (let i = size - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    out.push(d.toLocaleDateString('sv-SE'));
  }
  return out;
}

/** Back-compat thin wrapper for existing callers / tests. */
export function lastSevenLocalDates(today: Date): string[] {
  return lastNLocalDates(7, today);
}

/**
 * Collapses a canonical model id into a compact UI label.
 *
 * Examples:
 *   - `claude-opus-4-7`             → `opus-4.7`
 *   - `claude-sonnet-4-6`           → `sonnet-4.6`
 *   - `claude-haiku-4-5`            → `haiku-4.5`
 *   - `claude-sonnet-4-5-20250929`  → `sonnet-4.5`  (strip trailing date suffix)
 *   - `opus`  / `sonnet`            → returned as-is (aliases)
 *   - anything unrecognized         → returned unchanged
 */
export function shortenModelName(model: string): string {
  let name = model;
  if (name.startsWith('claude-')) {
    name = name.slice('claude-'.length);
  }
  // Strip an 8-digit date suffix like `-20250929`.
  name = name.replace(/-\d{8}$/, '');
  // Turn trailing `-N-M` (1–3 digit components) into `-N.M`.
  name = name.replace(/-(\d{1,3})-(\d{1,3})$/, '-$1.$2');
  return name;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function toLocalDateFromIso(iso: string): string {
  return new Date(iso).toLocaleDateString('sv-SE');
}

function monthOf(dateLocal: string): string {
  return dateLocal.slice(0, 7);
}

function compareDateDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * Builds a {@link WeeklyCostReport} for the current account.
 *
 * Modes:
 *   - **Range** (default; `days` is a positive integer): shows the last N local
 *     days ending `today`, one single group, rows ordered newest first.
 *   - **All**: scans every recorded day for the current account and returns one
 *     group per calendar month (newest month first).
 *
 * Each {@link WeeklyCostRow} carries a `byModel` array — a per-model breakdown
 * sorted by cost descending, so the panel can show **which models** drove the
 * day's spend (Opus vs Sonnet etc.). In the scan (primary) path the breakdown
 * preserves full per-category token counts; in the store fallback path only
 * `totalTokens` and `costUSD` are known (the persisted `CostEntry.byModel`
 * schema omits per-category tokens).
 *
 * Primary path:
 *   1. Decide the scan window. For range mode: `[today-(N-1) .. today]`.
 *      For all-mode: `['0001-01-01' .. today]` which is effectively "no lower bound".
 *   2. Call `UsageLogReader.scanDateRange` (independent of `scanToday`; does not
 *      touch `fileCursors` / `processedIds`).
 *   3. Group records by `(dateLocal, model)`, accumulate tokens, compute cost via
 *      `PricingTable.calculateCost` (or `record.costUSD` if present and valid).
 *   4. Sort each day's models by cost desc, reorder day rows newest first,
 *      group by month when mode === 'all'.
 *
 * Fallback path (triggered when `scanDateRange` throws):
 *   - Populate `costUSD` / `totalTokens` from `CostStoreData.entries.byModel`
 *     for the current account. Per-category token columns remain 0 and model
 *     rows are tagged `tokensBreakdownKnown: false`. `scanFailed` flag lets
 *     the view render a notice.
 *
 * The report is a pure in-memory view and is never persisted.
 */
export class WeeklyCostReportBuilder {
  constructor(
    private readonly identity: AccountIdentityService,
    private readonly logReader: UsageLogReader,
    private readonly pricing: PricingTable,
    private readonly store: CostStore,
    private readonly logger: vscode.OutputChannel,
  ) {}

  async build(
    now: Date = new Date(),
    days: number | 'all' = 7,
  ): Promise<WeeklyCostReport> {
    const identity = this.identity.getCurrentIdentity();
    const todayLocal = now.toLocaleDateString('sv-SE');
    const mode: 'range' | 'all' = days === 'all' ? 'all' : 'range';

    let windowDates: string[] | null = null;
    let fromDate: string;
    let toDate: string;
    if (mode === 'range') {
      const n = typeof days === 'number' ? days : 7;
      windowDates = lastNLocalDates(n, now);
      fromDate = windowDates[0];
      toDate = windowDates[windowDates.length - 1];
    } else {
      fromDate = '0001-01-01';
      toDate = todayLocal;
    }

    let scanFailed = false;
    let records: TokenUsageRecord[] = [];
    try {
      const scan = await this.logReader.scanDateRange(fromDate, toDate);
      records = scan.records;
    } catch (err: unknown) {
      scanFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.appendLine(
        `[WeeklyCostReportBuilder] scanDateRange failed, falling back to entries: ${msg}`,
      );
    }

    // ── Aggregate ──────────────────────────────────────────────────────────
    const rowsByDate: Record<string, WeeklyCostRow> = {};
    /** Nested aggregator: dateLocal → model → WeeklyCostModelRow */
    const modelBuckets: Record<string, Record<string, WeeklyCostModelRow>> = {};

    const ensureRow = (dateLocal: string): WeeklyCostRow => {
      let row = rowsByDate[dateLocal];
      if (!row) {
        row = newZeroRow(dateLocal);
        rowsByDate[dateLocal] = row;
        modelBuckets[dateLocal] = {};
      }
      return row;
    };

    const ensureModelRow = (dateLocal: string, model: string): WeeklyCostModelRow => {
      const bucket = modelBuckets[dateLocal];
      let mr = bucket[model];
      if (!mr) {
        mr = newZeroModelRow(model);
        bucket[model] = mr;
      }
      return mr;
    };

    if (!scanFailed) {
      if (mode === 'range' && windowDates) {
        for (const d of windowDates) {
          ensureRow(d);
        }
      }
      for (const r of records) {
        const dateLocal = toLocalDateFromIso(r.timestamp);
        if (mode === 'range' && windowDates && !windowDates.includes(dateLocal)) {
          continue;
        }
        const row = ensureRow(dateLocal);
        const cacheCreation = r.cacheCreation5m + r.cacheCreation1h;
        const cost =
          typeof r.costUSD === 'number' && r.costUSD >= 0
            ? r.costUSD
            : this.pricing.calculateCost(r);

        // Day totals
        row.inputTokens += r.inputTokens;
        row.outputTokens += r.outputTokens;
        row.cacheCreationTokens += cacheCreation;
        row.cacheReadTokens += r.cacheRead;
        row.costUSD = round6(row.costUSD + cost);

        // Per-model totals
        const mr = ensureModelRow(dateLocal, r.model);
        mr.inputTokens += r.inputTokens;
        mr.outputTokens += r.outputTokens;
        mr.cacheCreationTokens += cacheCreation;
        mr.cacheReadTokens += r.cacheRead;
        mr.costUSD = round6(mr.costUSD + cost);
      }
      for (const [date, row] of Object.entries(rowsByDate)) {
        row.totalTokens =
          row.inputTokens +
          row.outputTokens +
          row.cacheCreationTokens +
          row.cacheReadTokens;
        const models = Object.values(modelBuckets[date] ?? {});
        for (const mr of models) {
          mr.totalTokens =
            mr.inputTokens +
            mr.outputTokens +
            mr.cacheCreationTokens +
            mr.cacheReadTokens;
        }
        row.byModel = models.sort(compareModelRows);
      }
    } else {
      const data = this.store.load();
      if (mode === 'range' && windowDates) {
        for (const d of windowDates) {
          ensureRow(d);
        }
      }
      const prefix = `${identity.accountUuid}:`;
      for (const [key, entry] of Object.entries(data.entries)) {
        if (!key.startsWith(prefix)) {
          continue;
        }
        const d = key.slice(prefix.length);
        if (mode === 'range' && windowDates && !windowDates.includes(d)) {
          continue;
        }
        const row = ensureRow(d);
        let tokens = 0;
        const models: WeeklyCostModelRow[] = [];
        for (const [model, info] of Object.entries(entry.byModel)) {
          tokens += info.tokens;
          models.push({
            model,
            shortLabel: shortenModelName(model),
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalTokens: info.tokens,
            costUSD: info.cost,
            tokensBreakdownKnown: false,
          });
        }
        row.costUSD = entry.totalCostUSD;
        row.totalTokens = tokens;
        row.byModel = models.sort(compareModelRows);
      }
    }

    // ── Build groups ───────────────────────────────────────────────────────
    const groups: WeeklyCostGroup[] = [];
    if (mode === 'range') {
      const n = typeof days === 'number' ? days : 7;
      const dates = windowDates ?? lastNLocalDates(n, now);
      const rows = [...dates]
        .sort(compareDateDesc)
        .map((d) => rowsByDate[d] ?? newZeroRow(d));
      const totals = newZeroTotals();
      for (const r of rows) {
        addRowInto(totals, toTotals(r));
      }
      groups.push({ label: `Last ${n} day${n === 1 ? '' : 's'}`, rows, totals });
    } else {
      const allDates = Object.keys(rowsByDate).sort(compareDateDesc);
      const byMonth = new Map<string, WeeklyCostRow[]>();
      for (const d of allDates) {
        const m = monthOf(d);
        let bucket = byMonth.get(m);
        if (!bucket) {
          bucket = [];
          byMonth.set(m, bucket);
        }
        bucket.push(rowsByDate[d]);
      }
      for (const [label, rows] of byMonth) {
        const totals = newZeroTotals();
        for (const r of rows) {
          addRowInto(totals, toTotals(r));
        }
        groups.push({ label, rows, totals });
      }
    }

    const grandTotals = newZeroTotals();
    for (const g of groups) {
      addRowInto(grandTotals, g.totals);
    }

    const rangeLabel =
      mode === 'all'
        ? 'All time'
        : `Last ${typeof days === 'number' ? days : 7} day${(typeof days === 'number' ? days : 7) === 1 ? '' : 's'}`;

    return {
      groups,
      grandTotals,
      accountUuid: identity.accountUuid,
      accountEmail: identity.emailAddress,
      generatedAt: Date.now(),
      scanFailed,
      mode,
      rangeLabel,
    };
  }
}

function toTotals(row: WeeklyCostRow): WeeklyCostTotals {
  return {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    cacheReadTokens: row.cacheReadTokens,
    totalTokens: row.totalTokens,
    costUSD: row.costUSD,
  };
}

/** Sort model rows by cost desc, then tokens desc, then name asc — stable & deterministic. */
function compareModelRows(a: WeeklyCostModelRow, b: WeeklyCostModelRow): number {
  if (b.costUSD !== a.costUSD) return b.costUSD - a.costUSD;
  if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
  return a.shortLabel < b.shortLabel ? -1 : a.shortLabel > b.shortLabel ? 1 : 0;
}
