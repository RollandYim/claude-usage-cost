import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as vscode from 'vscode';
import type { TokenUsageRecord } from '../types';
import { LOG_ROOT_PATHS } from '../config';

/** Maximum number of .jsonl files collected in a single scan pass. */
const FILE_CAP = 10_000;

/** Maximum number of files processed concurrently to avoid FD exhaustion. */
const MAX_CONCURRENCY = 16;

/** Per-file processing timeout in milliseconds. */
const FILE_TIMEOUT_MS = 5_000;

/** Per-file cursor metadata persisted between scans. */
export interface FileCursor {
  inode: number;
  size: number;
  cursor: number;
}

/**
 * Result returned by {@link UsageLogReader.scanToday}.
 * Callers (Batch E) should merge `updatedCursors` into their `CostStoreData.fileCursors`.
 */
export interface ScanResult {
  /** Token usage records whose local-timezone date matches `todayLocalDate`. */
  records: TokenUsageRecord[];
  /**
   * Updated cursor state for every successfully processed file.
   * Persist these back to `CostStoreData.fileCursors` after aggregation.
   */
  updatedCursors: Record<string, FileCursor>;
  /** Files that were skipped due to errors or timeouts. */
  skippedFiles: Array<{ path: string; reason: string }>;
}

/**
 * Reads Claude Code `.jsonl` log files incrementally to extract token usage records.
 *
 * Maintains per-file `{inode, size, cursor}` state so only newly-appended bytes are
 * processed on subsequent scans. Handles file rotation (inode change) and truncation.
 */
export class UsageLogReader {
  constructor(
    private readonly logger: vscode.OutputChannel,
    private readonly getCursors: () => Record<string, FileCursor>,
  ) {}

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Scans today's log files and returns new records along with updated cursors.
   *
   * @param todayLocalDate - Local calendar date in `YYYY-MM-DD` format used to
   *   filter records by their `timestamp` field converted to local timezone.
   */
  async scanToday(todayLocalDate: string): Promise<ScanResult> {
    const startMs = Date.now();
    const files = await this.findAllJsonlFiles();
    this.logger.appendLine(`[UsageLogReader] scan start, files=${files.length}`);

    const cursors = this.getCursors();
    const allRecords: TokenUsageRecord[] = [];
    const updatedCursors: Record<string, FileCursor> = {};
    const skippedFiles: Array<{ path: string; reason: string }> = [];

    await this.runConcurrent(files, MAX_CONCURRENCY, async (absPath) => {
      try {
        const result = await Promise.race([
          this.processFile(absPath, cursors[absPath] ?? null, todayLocalDate),
          rejectAfter<ProcessFileResult>(FILE_TIMEOUT_MS, `timeout after ${FILE_TIMEOUT_MS}ms`),
        ]);
        for (const r of result.records) {
          allRecords.push(r);
        }
        updatedCursors[absPath] = result.cursor;
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.appendLine(`[UsageLogReader] skip ${absPath}: ${reason}`);
        skippedFiles.push({ path: absPath, reason });
      }
    });

    const tookMs = Date.now() - startMs;
    this.logger.appendLine(
      `[UsageLogReader] scan done, records=${allRecords.length}, files=${files.length}, skipped=${skippedFiles.length}, took=${tookMs}ms`,
    );

    return { records: allRecords, updatedCursors, skippedFiles };
  }

  /**
   * One-shot scan that walks every discovered jsonl file from offset 0 and
   * returns records whose local timezone date falls within the inclusive range
   * `[fromLocalDate, toLocalDate]`. Dedupes internally by `messageId:requestId`.
   *
   * Unlike {@link scanToday}, this method:
   * - does NOT read `getCursors()` (ignores persisted per-file cursor state);
   * - does NOT produce `updatedCursors` entries to be persisted;
   * - does NOT rely on any dedup set beyond the call-local one.
   *
   * Used by `WeeklyCostReportBuilder` to populate the 7-day panel without
   * polluting the incremental-scan state consumed by `CostService.refreshNow`.
   */
  async scanDateRange(
    fromLocalDate: string,
    toLocalDate: string,
  ): Promise<ScanResult> {
    const startMs = Date.now();
    const files = await this.findAllJsonlFiles();
    this.logger.appendLine(
      `[UsageLogReader] range scan start, files=${files.length}, from=${fromLocalDate}, to=${toLocalDate}`,
    );

    const seen: Record<string, true> = {};
    const allRecords: TokenUsageRecord[] = [];
    const skippedFiles: Array<{ path: string; reason: string }> = [];

    await this.runConcurrent(files, MAX_CONCURRENCY, async (absPath) => {
      try {
        const records = await Promise.race([
          this.processFileForDateRange(absPath, fromLocalDate, toLocalDate),
          rejectAfter<TokenUsageRecord[]>(
            FILE_TIMEOUT_MS,
            `timeout after ${FILE_TIMEOUT_MS}ms`,
          ),
        ]);
        for (const r of records) {
          const key = `${r.messageId}:${r.requestId}`;
          if (seen[key]) {
            continue;
          }
          seen[key] = true;
          allRecords.push(r);
        }
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.appendLine(
          `[UsageLogReader] range scan skip ${absPath}: ${reason}`,
        );
        skippedFiles.push({ path: absPath, reason });
      }
    });

    const tookMs = Date.now() - startMs;
    this.logger.appendLine(
      `[UsageLogReader] range scan done, records=${allRecords.length}, skipped=${skippedFiles.length}, took=${tookMs}ms`,
    );

    return { records: allRecords, updatedCursors: {}, skippedFiles };
  }

  /**
   * Discovers all `.jsonl` files under every `LOG_ROOT_PATHS()` entry.
   *
   * - Skips root paths that do not exist.
   * - Skips symbolic links to avoid directory-traversal loops.
   * - Caps total results at {@link FILE_CAP} and logs a warning if the cap is hit.
   */
  async findAllJsonlFiles(): Promise<string[]> {
    const results: string[] = [];
    let capHit = false;

    for (const root of LOG_ROOT_PATHS()) {
      if (capHit) {
        break;
      }
      // Skip root paths that do not exist
      try {
        await fs.promises.access(root);
      } catch {
        continue;
      }

      await this.collectJsonlFiles(root, results, () => {
        capHit = true;
      });
    }

    if (capHit) {
      this.logger.appendLine('[UsageLogReader] file cap hit');
    }

    return results;
  }

  /**
   * Parses a single `.jsonl` line and returns a `TokenUsageRecord` or `null`.
   *
   * Returns `null` when:
   * - The line is empty or not valid JSON.
   * - `type !== 'assistant'`.
   * - `message.usage` is absent.
   * - `message.id` or `requestId` is absent (required for dedup).
   * - `message.model` is `'<synthetic>'`.
   * - `timestamp` is absent.
   */
  parseLine(line: string): TokenUsageRecord | null {
    if (!line.trim()) {
      return null;
    }

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }

    // Only assistant-type records contain token usage
    if (obj['type'] !== 'assistant') {
      return null;
    }

    const message = obj['message'] as Record<string, unknown> | undefined;
    if (!message || typeof message !== 'object') {
      return null;
    }

    const usage = message['usage'] as Record<string, unknown> | undefined;
    if (!usage || typeof usage !== 'object') {
      return null;
    }

    const messageId = message['id'];
    if (typeof messageId !== 'string' || !messageId) {
      return null;
    }

    const requestId = obj['requestId'];
    if (typeof requestId !== 'string' || !requestId) {
      return null;
    }

    const timestamp = obj['timestamp'];
    if (typeof timestamp !== 'string' || !timestamp) {
      return null;
    }

    const model = typeof message['model'] === 'string' ? message['model'] : '';

    // Synthetic messages have no real token consumption
    if (model === '<synthetic>') {
      return null;
    }

    const serviceTier =
      typeof usage['service_tier'] === 'string' ? usage['service_tier'] : 'standard';

    const inputTokens =
      typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0;
    const outputTokens =
      typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0;
    const cacheRead =
      typeof usage['cache_read_input_tokens'] === 'number'
        ? usage['cache_read_input_tokens']
        : 0;

    // Prefer the granular cache_creation sub-object (2026+ format).
    // Fall back to the top-level cache_creation_input_tokens as 5m-only
    // (conservative: 5m price ~5× higher than 1h; intentional over-estimate).
    const cacheCreationObj = usage['cache_creation'];
    let cacheCreation5m: number;
    let cacheCreation1h: number;

    if (cacheCreationObj !== null && typeof cacheCreationObj === 'object') {
      const cc = cacheCreationObj as Record<string, unknown>;
      cacheCreation5m =
        typeof cc['ephemeral_5m_input_tokens'] === 'number'
          ? cc['ephemeral_5m_input_tokens']
          : 0;
      cacheCreation1h =
        typeof cc['ephemeral_1h_input_tokens'] === 'number'
          ? cc['ephemeral_1h_input_tokens']
          : 0;
    } else {
      // Legacy format: no cache_creation sub-object
      cacheCreation5m =
        typeof usage['cache_creation_input_tokens'] === 'number'
          ? usage['cache_creation_input_tokens']
          : 0;
      cacheCreation1h = 0;
    }

    // Optional backward-compatible costUSD from older Claude Code logs
    const costUSD =
      typeof obj['costUSD'] === 'number' ? obj['costUSD'] : undefined;

    const record: TokenUsageRecord = {
      messageId,
      requestId,
      timestamp,
      model,
      serviceTier,
      inputTokens,
      outputTokens,
      cacheCreation5m,
      cacheCreation1h,
      cacheRead,
    };

    if (costUSD !== undefined) {
      record.costUSD = costUSD;
    }

    return record;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Recursively walks `dir` and appends `.jsonl` absolute paths to `results`.
   * Skips symbolic links; calls `onCapHit` and returns early when FILE_CAP is reached.
   */
  private async collectJsonlFiles(
    dir: string,
    results: string[],
    onCapHit: () => void,
  ): Promise<void> {
    if (results.length >= FILE_CAP) {
      onCapHit();
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= FILE_CAP) {
        onCapHit();
        return;
      }

      const fullPath = path.join(dir, entry.name);

      // Use lstat to detect symlinks (avoids circular traversal)
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(fullPath);
      } catch {
        continue;
      }

      if (stat.isSymbolicLink()) {
        continue;
      }

      if (stat.isDirectory()) {
        await this.collectJsonlFiles(fullPath, results, onCapHit);
      } else if (stat.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }
  }

  /** Processes one file incrementally and returns new records + updated cursor. */
  private async processFile(
    absPath: string,
    prevCursor: FileCursor | null,
    todayLocalDate: string,
  ): Promise<ProcessFileResult> {
    const stat = await fs.promises.stat(absPath);
    const ino = stat.ino;
    const size = stat.size;

    let startOffset = 0;

    if (prevCursor !== null) {
      if (prevCursor.inode !== ino) {
        // File replaced / rotated — re-read from the beginning
        startOffset = 0;
      } else if (prevCursor.size > size) {
        // File truncated — re-read from the beginning
        startOffset = 0;
      } else if (prevCursor.cursor >= size) {
        // No new data since last scan
        return { records: [], cursor: { inode: ino, size, cursor: size } };
      } else {
        startOffset = prevCursor.cursor;
      }
    }

    const records: TokenUsageRecord[] = [];

    if (size > startOffset) {
      const stream = fs.createReadStream(absPath, {
        start: startOffset,
        end: size - 1,
      });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      await new Promise<void>((resolve, reject) => {
        rl.on('line', (line) => {
          try {
            const record = this.parseLine(line);
            if (record !== null && toLocalDateString(record.timestamp) === todayLocalDate) {
              records.push(record);
            }
          } catch {
            // Skip malformed lines silently; the scan must not be interrupted
          }
        });
        rl.on('close', resolve);
        rl.on('error', reject);
        stream.on('error', reject);
      });
    }

    return { records, cursor: { inode: ino, size, cursor: size } };
  }

  /**
   * Reads `absPath` from offset 0 and returns every record whose local date is
   * in `[fromLocalDate, toLocalDate]`. No cursor tracking. Used by
   * {@link scanDateRange} exclusively.
   */
  private async processFileForDateRange(
    absPath: string,
    fromLocalDate: string,
    toLocalDate: string,
  ): Promise<TokenUsageRecord[]> {
    const records: TokenUsageRecord[] = [];
    const stream = fs.createReadStream(absPath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    await new Promise<void>((resolve, reject) => {
      rl.on('line', (line) => {
        try {
          const record = this.parseLine(line);
          if (record === null) {
            return;
          }
          const d = toLocalDateString(record.timestamp);
          if (d >= fromLocalDate && d <= toLocalDate) {
            records.push(record);
          }
        } catch {
          // Skip malformed lines silently
        }
      });
      rl.on('close', resolve);
      rl.on('error', reject);
      stream.on('error', reject);
    });
    return records;
  }

  /**
   * Runs `fn` over `items` with at most `concurrency` simultaneous invocations.
   * Uses a pull-from-queue approach to avoid spawning more workers than items.
   */
  private async runConcurrent<T>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }
    const queue = [...items];
    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      () =>
        (async () => {
          while (queue.length > 0) {
            const item = queue.shift();
            if (item !== undefined) {
              await fn(item);
            }
          }
        })(),
    );
    await Promise.all(workers);
  }
}

// ─── Module-private helpers ───────────────────────────────────────────────────

/** Internal type for processFile return value. */
interface ProcessFileResult {
  records: TokenUsageRecord[];
  cursor: FileCursor;
}

/**
 * Converts an ISO 8601 timestamp to a local-timezone `YYYY-MM-DD` date string.
 *
 * Uses the `sv-SE` locale which always produces `YYYY-MM-DD` format, unlike
 * `toISOString()` which would return the UTC date and could differ by ±1 day.
 */
export function toLocalDateString(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleDateString('sv-SE');
}

/**
 * Returns a promise that rejects with `Error(message)` after `ms` milliseconds.
 * Used with `Promise.race` to enforce per-file processing timeouts.
 */
function rejectAfter<T>(ms: number, message: string): Promise<T> {
  return new Promise<T>((_, reject) =>
    setTimeout(() => reject(new Error(message)), ms),
  );
}
