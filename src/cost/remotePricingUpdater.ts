import * as vscode from 'vscode';
import {
  REMOTE_PRICING_FETCH_INTERVAL_MS,
  REMOTE_PRICING_TIMEOUT_MS,
} from '../config';
import type { PricingTable as PricingTableData, ModelPricing } from '../types';
import { PricingTable } from './pricingTable';

/** Maximum allowed response body size in bytes (256 KB). */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Periodically fetches a remote pricing JSON and calls `onPricingUpdate` on
 * success. Feature is disabled (zero network requests) when `getRemoteUrl()`
 * returns an empty string or `undefined`.
 *
 * ### Security constraints (D8)
 * - Only `https:` URLs are accepted; `http:`, `file:`, etc. are rejected.
 * - Response body is capped at 256 KB via `Content-Length` header check and
 *   streaming accumulation guard.
 * - Log output shows `origin + pathname` only — query strings are never logged
 *   (prevents token leakage when users embed secrets in the URL).
 * - JSON schema is validated before calling `onPricingUpdate`.
 */
export class RemotePricingUpdater implements vscode.Disposable {
  private timerHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly logger: vscode.OutputChannel,
    /** Returns the configured remote URL; empty / undefined disables the feature. */
    private readonly getRemoteUrl: () => string | undefined,
    /**
     * Called after a successful fetch + schema validation with the new
     * PricingTable instance. The caller (Batch H) should update the
     * CostAggregator via `aggregator.setPricing(newTable)`.
     */
    private readonly onPricingUpdate: (newTable: PricingTable) => void,
  ) {}

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Starts the updater: performs one immediate fetch attempt, then schedules
   * subsequent fetches every `REMOTE_PRICING_FETCH_INTERVAL_MS` (24 h).
   * Calling `start()` again is safe — it stops any existing timer first.
   */
  start(): void {
    this.stop();

    const url = this.getRemoteUrl();
    if (!url) {
      return; // feature disabled; zero network requests
    }

    try {
      const { hostname } = new URL(url);
      const intervalH = REMOTE_PRICING_FETCH_INTERVAL_MS / 3_600_000;
      this.logger.appendLine(
        `[RemotePricing] enabled, url=***${hostname}***, interval=${intervalH}h`,
      );
    } catch {
      // URL is syntactically invalid; fetchOnce will catch and log properly.
    }

    void this.fetchOnce();
    this.timerHandle = setInterval(
      () => void this.fetchOnce(),
      REMOTE_PRICING_FETCH_INTERVAL_MS,
    );
  }

  /** Stops the periodic fetch timer. */
  stop(): void {
    if (this.timerHandle !== null) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
  }

  dispose(): void {
    this.stop();
  }

  /**
   * Executes one fetch attempt:
   * 1. Validates the URL (non-empty + HTTPS).
   * 2. Fetches with a hard timeout.
   * 3. Enforces a 256 KB body cap.
   * 4. Parses JSON via `PricingTable.parseJson`.
   * 5. Validates schema (lastUpdated, models count, required numeric fields).
   * 6. On success calls `onPricingUpdate(newTable)`.
   *
   * Any failure is logged and returns silently without calling `onPricingUpdate`.
   */
  async fetchOnce(): Promise<void> {
    const url = this.getRemoteUrl();
    if (!url) {
      this.logger.appendLine('[RemotePricing] skipped: url is empty');
      return;
    }

    // ── Protocol guard ──────────────────────────────────────────────────────
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      this.logger.appendLine('[RemotePricing] rejected invalid url');
      return;
    }

    if (parsedUrl.protocol !== 'https:') {
      this.logger.appendLine(
        `[RemotePricing] rejected non-https url (protocol=${parsedUrl.protocol})`,
      );
      return;
    }

    // ── Fetch with timeout ──────────────────────────────────────────────────
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(REMOTE_PRICING_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.appendLine(`[RemotePricing] fetch error: ${msg}`);
      return;
    }

    if (!response.ok) {
      this.logger.appendLine(
        `[RemotePricing] fetch failed: HTTP ${response.status} ${response.statusText}`,
      );
      return;
    }

    // ── Body size guard + read ──────────────────────────────────────────────
    const raw = await this.readBodyWithSizeLimit(response);
    if (raw === null) {
      return; // size limit exceeded; already logged
    }

    // ── JSON parse ──────────────────────────────────────────────────────────
    let parsed: PricingTableData;
    try {
      parsed = PricingTable.parseJson(raw);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.appendLine(`[RemotePricing] JSON parse failed: ${msg}`);
      return;
    }

    // ── Schema validation ───────────────────────────────────────────────────
    const validationError = this.validateSchema(parsed);
    if (validationError !== null) {
      this.logger.appendLine(
        `[RemotePricing] schema validation failed: ${validationError}`,
      );
      return;
    }

    // ── Success ─────────────────────────────────────────────────────────────
    const newTable = new PricingTable(parsed, this.logger);
    this.onPricingUpdate(newTable);
    const modelCount = Object.keys(parsed.models).length;
    this.logger.appendLine(
      `[RemotePricing] updated, lastUpdated=${parsed.lastUpdated}, models=${modelCount}`,
    );
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Reads the response body with a 256 KB hard cap:
   *
   * 1. If `Content-Length` is present and exceeds the cap → reject immediately.
   * 2. If the response has a body stream → accumulate chunks; abort at cap.
   * 3. Fallback (`response.body` is null) → call `response.text()`.
   *
   * Returns `null` if the limit is exceeded (already logged).
   */
  private async readBodyWithSizeLimit(response: Response): Promise<string | null> {
    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader !== null) {
      const clBytes = parseInt(contentLengthHeader, 10);
      if (!Number.isNaN(clBytes) && clBytes > MAX_BODY_BYTES) {
        this.logger.appendLine(
          `[RemotePricing] rejected: Content-Length ${clBytes} exceeds 256 KB`,
        );
        return null;
      }
    }

    // Streaming read with accumulation guard
    if (!response.body) {
      // No ReadableStream (e.g. test mocks with null body); fall back to text().
      return await response.text();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let totalBytes = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        totalBytes += value.byteLength;
        if (totalBytes > MAX_BODY_BYTES) {
          this.logger.appendLine(
            `[RemotePricing] rejected: response body exceeds 256 KB`,
          );
          await reader.cancel();
          return null;
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode()); // flush remaining bytes
    } finally {
      reader.releaseLock();
    }

    return chunks.join('');
  }

  /**
   * Validates the essential schema of a parsed pricing table.
   *
   * Checks:
   * - `lastUpdated` matches `YYYY-MM-DD`.
   * - `models` has at least 1 entry.
   * - Every model entry has all 5 required numeric `standard` tier fields (> 0).
   *
   * @returns An error description string, or `null` if valid.
   */
  private validateSchema(data: PricingTableData): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.lastUpdated)) {
      return `invalid lastUpdated format: "${data.lastUpdated}"`;
    }

    const modelKeys = Object.keys(data.models);
    if (modelKeys.length === 0) {
      return 'models must contain at least one entry';
    }

    const requiredFields: ReadonlyArray<keyof ModelPricing> = [
      'input',
      'output',
      'cache_read',
      'cache_creation_5m',
      'cache_creation_1h',
    ];

    for (const modelKey of modelKeys) {
      const tierMap = data.models[modelKey];
      const std: ModelPricing | undefined = tierMap?.['standard'];
      if (!std) {
        return `model "${modelKey}" is missing the "standard" tier`;
      }
      for (const field of requiredFields) {
        // Cast via unknown to allow runtime typeof check on JSON-parsed data
        const val = std[field] as unknown;
        if (typeof val !== 'number' || val <= 0) {
          return `model "${modelKey}" standard.${field} must be a positive number`;
        }
      }
    }

    return null;
  }
}
