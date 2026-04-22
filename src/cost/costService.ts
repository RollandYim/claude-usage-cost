import * as vscode from 'vscode';
import type { AccountIdentity } from '../types';
import type { AccountIdentityService } from './accountIdentity';
import type { UsageLogReader } from './usageLogReader';
import type { CostAggregator } from './costAggregator';
import type { CostStore } from './costStore';

/**
 * Orchestrates the cost-tracking pipeline end-to-end:
 *
 * ```
 * identity → log scanning → aggregation → persistence → UI notification
 * ```
 *
 * ### Lifecycle
 * 1. Call `start()` once after construction.  It performs an initial scan and
 *    launches the periodic refresh timer.
 * 2. Subscribe to `onDidChangeCost` to repaint the status bar on each update.
 * 3. Call `dispose()` (or push to `context.subscriptions`) to stop the timer.
 *
 * ### Concurrency guard
 * `_inFlight` prevents overlapping `refreshNow()` calls — if the previous
 * scan is still in progress when the timer fires, the tick is skipped.
 *
 * ### Identity change handling
 * When `AccountIdentityService` fires `onDidChangeIdentity`, the new account's
 * today entry is reset to $0.00 and a fresh scan is triggered immediately.
 *
 * ### Timer interval
 * The refresh interval is read once at `start()` time via `getRefreshIntervalMs()`.
 * Batch F will add a configuration-change listener that disposes and restarts the
 * timer with the updated interval.
 */
export class CostService implements vscode.Disposable {
  private readonly _onDidChangeCost = new vscode.EventEmitter<void>();

  /** Subscribe to repaint the cost display whenever the today entry changes. */
  readonly onDidChangeCost: vscode.Event<void> = this._onDidChangeCost.event;

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private _inFlight = false;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  constructor(
    private readonly logger: vscode.OutputChannel,
    private readonly identity: AccountIdentityService,
    private readonly logReader: UsageLogReader,
    private readonly aggregator: CostAggregator,
    private readonly store: CostStore,
    /** Called once at `start()` to determine the polling interval in ms. */
    private readonly getRefreshIntervalMs: () => number,
  ) {}

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Performs an initial scan and starts the periodic refresh timer.
   * Must be called exactly once after construction.
   */
  async start(): Promise<void> {
    // Subscribe to account switches.
    const identitySub = this.identity.onDidChangeIdentity(
      (newId: AccountIdentity) => void this.handleIdentityChange(newId),
    );
    this.disposables.push(identitySub);

    // Start periodic refresh; interval is fixed at start time (Batch F adds hot-reload).
    const intervalMs = this.getRefreshIntervalMs();
    this.intervalHandle = setInterval(() => {
      void this.refreshNow();
    }, intervalMs);

    // Perform initial scan synchronously with `start()`.
    await this.refreshNow();
  }

  /**
   * Triggers an immediate log-scan + aggregation cycle.
   *
   * Concurrent calls while a scan is already in progress are silently dropped
   * (the `_inFlight` guard prevents overlapping scans).
   */
  async refreshNow(): Promise<void> {
    if (this._inFlight) return;
    this._inFlight = true;
    try {
      await this.doRefresh();
    } finally {
      this._inFlight = false;
    }
  }

  /**
   * Returns the current account's today cost summary for UI rendering.
   *
   * Returns a zeroed summary when:
   * - The identity source is `'unknown'`.
   * - No entry exists for today's date yet.
   */
  getTodaySummary(): {
    totalUSD: number;
    byModel: Record<string, { tokens: number; cost: number }>;
    lastUpdated: number;
  } {
    const accountId = this.identity.getCurrentIdentity();
    const todayLocalDate = new Date().toLocaleDateString('sv-SE');
    const key = `${accountId.accountUuid}:${todayLocalDate}`;
    const data = this.store.load();
    const entry = data.entries[key];
    if (!entry) {
      return { totalUSD: 0, byModel: {}, lastUpdated: 0 };
    }
    return {
      totalUSD: entry.totalCostUSD,
      byModel: entry.byModel,
      lastUpdated: entry.updatedAt,
    };
  }

  /**
   * Clears the current refresh timer and restarts it using the latest value
   * from `getRefreshIntervalMs()`.  Called by `CostConfigListener` when the
   * `cost.localRefreshSeconds` setting changes.
   *
   * No-op after `dispose()` has been called.
   */
  public restartTimer(): void {
    if (this.disposed) { return; }
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    const intervalMs = this.getRefreshIntervalMs();
    this.intervalHandle = setInterval(() => {
      void this.refreshNow();
    }, intervalMs);
    this.logger.appendLine(`[CostService] timer restarted, interval=${intervalMs}ms`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeCost.dispose();
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Handles an identity-change event: resets the new account's today entry then refreshes. */
  private async handleIdentityChange(newId: AccountIdentity): Promise<void> {
    this.logger.appendLine(
      `[CostService] identity changed → ${newId.accountUuid.slice(0, 8)}.., resetting today entry`,
    );
    await this.store.resetForAccount(newId.accountUuid);
    // refreshNow fires onDidChangeCost internally on success.
    await this.refreshNow();
  }

  /**
   * Core refresh pipeline: scan → aggregate → persist → notify.
   *
   * Any error in any stage is caught and logged; the UI is never notified of a
   * failed refresh (it keeps showing the last known cost).
   */
  private async doRefresh(): Promise<void> {
    try {
      const todayLocalDate = new Date().toLocaleDateString('sv-SE');
      const accountId = this.identity.getCurrentIdentity();

      if (accountId.source === 'unknown') {
        this.logger.appendLine(
          '[CostService] identity unknown, aggregating under "unknown" accountUuid',
        );
      }

      const scan = await this.logReader.scanToday(todayLocalDate);
      const key = `${accountId.accountUuid}:${todayLocalDate}`;

      await this.store.update((current) => {
        const existingEntry = current.entries[key];
        const result = this.aggregator.aggregate({
          records: scan.records,
          accountUuid: accountId.accountUuid,
          todayLocalDate,
          existingEntry,
          existingProcessedIds: current.processedIds,
        });

        return {
          ...current,
          entries: { ...current.entries, [key]: result.updatedEntry },
          processedIds: { ...current.processedIds, ...result.newProcessedIds },
          fileCursors: { ...current.fileCursors, ...scan.updatedCursors },
        };
      });

      this._onDidChangeCost.fire();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.appendLine(`[CostService] refresh failed: ${msg}`);
    }
  }
}
