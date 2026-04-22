import * as vscode from 'vscode';
import type { CostEntry, TokenUsageRecord } from '../types';
import type { PricingTable } from './pricingTable';

// ─── Public interfaces ────────────────────────────────────────────────────────

/** Input to {@link CostAggregator.aggregate}. */
export interface AggregateInput {
  /** Token usage records whose local date matches `todayLocalDate` (pre-filtered by UsageLogReader). */
  records: TokenUsageRecord[];
  accountUuid: string;
  /** Local calendar date in `YYYY-MM-DD` format. */
  todayLocalDate: string;
  /** Existing today entry to increment; `undefined` when no entry exists yet. */
  existingEntry?: CostEntry;
  /** Already-persisted dedup set; combined with this batch to detect duplicates. */
  existingProcessedIds: Record<string, true>;
}

/** Output of {@link CostAggregator.aggregate}. */
export interface AggregateOutput {
  /** Fully updated `CostEntry` (merged from `existingEntry` + this batch). */
  updatedEntry: CostEntry;
  /** New dedup keys added by this batch (to be merged into `CostStoreData.processedIds`). */
  newProcessedIds: Record<string, true>;
  /** Per-model token + cost deltas contributed by this batch only. */
  perModelDelta: Record<string, { tokens: number; cost: number }>;
  /** Sum of all new costs in this batch (USD, rounded to 6 dp). */
  totalDeltaUSD: number;
  /** Number of records skipped due to dedup (does NOT count `<synthetic>` skips). */
  skippedRecords: number;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Pure aggregation layer: deduplicates and prices a batch of token usage records,
 * then merges the result into the running daily {@link CostEntry}.
 *
 * Has no VS Code API dependencies beyond the logger; all persistence is delegated
 * to {@link CostStore} by the caller.
 */
export class CostAggregator {
  constructor(
    private pricing: PricingTable,
    private readonly logger: vscode.OutputChannel,
  ) {}

  /**
   * Replaces the pricing table used for subsequent `aggregate()` calls.
   *
   * Called by `RemotePricingUpdater.onPricingUpdate` (wired in Batch H) when a
   * remote pricing update succeeds.  Thread safety note: `aggregate()` is always
   * called from the single JS event-loop thread, so no locking is required.
   */
  public setPricing(newTable: PricingTable): void {
    this.pricing = newTable;
    this.logger.appendLine('[CostAggregator] pricing table replaced (remote update)');
  }

  /**
   * Processes `input.records`, applies deduplication, calculates costs via the
   * injected `PricingTable`, and returns an updated `CostEntry` plus metadata.
   *
   * ### Aggregation rules
   * 1. Records with `model === '<synthetic>'` are silently skipped (not added to
   *    `byModel` or `newProcessedIds`).
   * 2. Records whose `messageId:requestId` key already appears in
   *    `existingProcessedIds` or was seen earlier in this batch are counted as
   *    `skippedRecords` and excluded from cost totals.
   * 3. Cost for non-duplicate records is delegated to `pricing.calculateCost`.
   * 4. `totalCostUSD` and per-model `cost` values are rounded to 6 decimal places
   *    using `Math.round(x * 1e6) / 1e6` to prevent floating-point drift.
   */
  aggregate(input: AggregateInput): AggregateOutput {
    const { records, accountUuid, todayLocalDate, existingEntry, existingProcessedIds } = input;

    const newProcessedIds: Record<string, true> = {};
    const perModelDelta: Record<string, { tokens: number; cost: number }> = {};
    let totalDeltaUSD = 0;
    let skippedRecords = 0;

    for (const record of records) {
      // Synthetic messages carry no real token cost; exclude from byModel entirely.
      if (record.model === '<synthetic>') {
        continue;
      }

      const dupKey = `${record.messageId}:${record.requestId}`;

      // Dedup: skip records already processed in this batch or from a prior scan.
      if (existingProcessedIds[dupKey] || newProcessedIds[dupKey]) {
        skippedRecords++;
        continue;
      }

      const cost = this.pricing.calculateCost(record);
      const tokens =
        record.inputTokens +
        record.outputTokens +
        record.cacheRead +
        record.cacheCreation5m +
        record.cacheCreation1h;

      if (!perModelDelta[record.model]) {
        perModelDelta[record.model] = { tokens: 0, cost: 0 };
      }
      perModelDelta[record.model].tokens += tokens;
      perModelDelta[record.model].cost += cost;

      totalDeltaUSD += cost;
      newProcessedIds[dupKey] = true;
    }

    // Start from the existing entry or a zero baseline for this account/date.
    const baseEntry: CostEntry = existingEntry ?? {
      dateLocal: todayLocalDate,
      accountUuid,
      totalCostUSD: 0,
      byModel: {},
      updatedAt: 0,
    };

    // Merge this batch's per-model delta into the running byModel totals.
    const byModel: Record<string, { tokens: number; cost: number }> = { ...baseEntry.byModel };
    for (const [model, delta] of Object.entries(perModelDelta)) {
      const prev = byModel[model] ?? { tokens: 0, cost: 0 };
      byModel[model] = {
        tokens: prev.tokens + delta.tokens,
        cost: round6(prev.cost + delta.cost),
      };
    }

    const roundedDelta = round6(totalDeltaUSD);
    const updatedEntry: CostEntry = {
      ...baseEntry,
      totalCostUSD: round6(baseEntry.totalCostUSD + totalDeltaUSD),
      byModel,
      updatedAt: Date.now(),
    };

    this.logger.appendLine(
      `[CostAggregator] processed=${Object.keys(newProcessedIds).length}, ` +
      `skipped=${skippedRecords}, delta=$${roundedDelta.toFixed(6)}`,
    );

    return {
      updatedEntry,
      newProcessedIds,
      perModelDelta,
      totalDeltaUSD: roundedDelta,
      skippedRecords,
    };
  }
}

// ─── Module-private helpers ───────────────────────────────────────────────────

/**
 * Rounds `n` to 6 decimal places using multiply-round-divide to avoid
 * floating-point drift that accumulates across many small cost additions.
 */
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
