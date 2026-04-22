import * as vscode from 'vscode';
import type { CostEntry, CostStoreData } from '../types';
import { COST_STORE_KEY } from '../config';

/** Default/empty store returned when nothing has been persisted yet. */
const DEFAULT_STORE: CostStoreData = {
  version: 0,
  mtime: 0,
  entries: {},
  processedIds: {},
  fileCursors: {},
};

/** Trim `processedIds` when it exceeds this count. */
const PROCESSED_IDS_MAX = 20_000;

/** Number of most-recent entries to keep after trimming. */
const PROCESSED_IDS_TRIM_TO = 10_000;

/**
 * Wraps VS Code's `globalState` memento to persist {@link CostStoreData}.
 *
 * ### Optimistic-lock protocol (multi-window safety)
 * Each `update` call reads the current `version`, applies the mutator, then
 * re-reads before writing to detect concurrent writes from other VS Code windows
 * sharing the same `globalState`.  On conflict the write is retried once; if
 * the second attempt also conflicts the update is abandoned and `false` is
 * returned.
 *
 * ### processedIds growth control
 * When `processedIds` exceeds {@link PROCESSED_IDS_MAX} entries the map is
 * trimmed to the most-recent {@link PROCESSED_IDS_TRIM_TO} entries (using
 * JavaScript object insertion order as a proxy for chronological order).
 */
export class CostStore {
  constructor(
    private readonly memento: vscode.Memento,
    private readonly logger: vscode.OutputChannel,
  ) {}

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Reads the current {@link CostStoreData} from the memento.
   * Returns a fresh copy of {@link DEFAULT_STORE} when nothing has been stored.
   */
  load(): CostStoreData {
    return this.memento.get<CostStoreData>(COST_STORE_KEY, { ...DEFAULT_STORE });
  }

  /**
   * Applies `mutator` to the current store data and writes the result back.
   *
   * The mutator receives a snapshot of the current data and must return a new
   * (immutable-style) object — it should not mutate the argument in place.
   *
   * @returns `true` on success; `false` when both optimistic-lock attempts fail.
   */
  async update(mutator: (current: CostStoreData) => CostStoreData): Promise<boolean> {
    const ok = await this.attemptUpdate(mutator);
    if (ok) return true;

    // Retry once after a detected conflict
    const ok2 = await this.attemptUpdate(mutator);
    if (ok2) return true;

    this.logger.appendLine('[CostStore] optimistic lock conflict, giving up');
    return false;
  }

  /** Returns the current persisted `version` number (used by multi-window detection). */
  getVersion(): number {
    return this.load().version;
  }

  /**
   * Returns the current per-file cursor map for use as the `getCursors` callback
   * passed to {@link UsageLogReader}.
   */
  getFileCursors(): Record<string, { inode: number; size: number; cursor: number }> {
    return this.load().fileCursors;
  }

  /**
   * Placeholder for future "freeze old account" logic.
   *
   * Currently a no-op: the old account's entries remain in the store and simply
   * stop receiving new writes once the account switches.  The method is kept in
   * the public API so that future callers can opt in to explicit freeze semantics
   * without a breaking change.
   */
  freezeCurrentAccount(): void {
    // Intentionally empty – old-account entries become read-only implicitly.
  }

  /**
   * Deletes today's cost entry for `newAccountUuid`, resetting its displayed
   * cost to $0.00 so the newly-active account starts accumulating from scratch.
   *
   * **`processedIds` is intentionally preserved.** Clearing it would risk
   * double-counting records that appear in both accounts' log directories during
   * or after an account switch (a single `requestId` can span multiple accounts).
   */
  async resetForAccount(newAccountUuid: string): Promise<void> {
    const todayLocalDate = new Date().toLocaleDateString('sv-SE');
    const key = `${newAccountUuid}:${todayLocalDate}`;
    await this.update((current) => {
      const entries: Record<string, CostEntry> = {};
      for (const [k, v] of Object.entries(current.entries)) {
        if (k !== key) {
          entries[k] = v;
        }
      }
      return { ...current, entries };
    });
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Performs a single optimistic-lock write attempt.
   *
   * 1. Reads the current data (`startData`).
   * 2. Computes `mutated = mutator(startData)`.
   * 3. Re-reads (`preWriteData`) to detect concurrent writes.
   * 4. If `preWriteData.version !== startData.version` → returns `false` (conflict).
   * 5. Otherwise writes `{ ...mutated, version: startData.version + 1, mtime: now }`.
   */
  private async attemptUpdate(
    mutator: (current: CostStoreData) => CostStoreData,
  ): Promise<boolean> {
    const startData = this.load();
    const mutated = mutator(startData);

    // Re-read before writing to detect concurrent writes from other VS Code windows.
    const preWriteData = this.load();
    if (preWriteData.version !== startData.version) {
      return false; // conflict detected — another window wrote between our read and write
    }

    const finalData = this.trimProcessedIds({
      ...mutated,
      version: startData.version + 1,
      mtime: Date.now(),
    });
    await this.memento.update(COST_STORE_KEY, finalData);
    return true;
  }

  /**
   * Trims `processedIds` to the most-recent {@link PROCESSED_IDS_TRIM_TO}
   * entries when the count exceeds {@link PROCESSED_IDS_MAX}.
   *
   * JavaScript object insertion order (ES2015+) is used as a proxy for
   * chronological insertion order.
   */
  private trimProcessedIds(data: CostStoreData): CostStoreData {
    const keys = Object.keys(data.processedIds);
    if (keys.length <= PROCESSED_IDS_MAX) {
      return data;
    }
    const kept = keys.slice(keys.length - PROCESSED_IDS_TRIM_TO);
    const trimmed: Record<string, true> = {};
    for (const k of kept) {
      trimmed[k] = true;
    }
    this.logger.appendLine(
      `[CostStore] trimmed processedIds from ${keys.length} → ${PROCESSED_IDS_TRIM_TO}`,
    );
    return { ...data, processedIds: trimmed };
  }
}
