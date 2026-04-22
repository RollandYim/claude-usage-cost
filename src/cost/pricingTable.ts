import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { PricingTable as PricingTableData, ModelPricing, PricingTier, TokenUsageRecord } from '../types';

/** Shape of the raw parsed JSON (same as PricingTableData; alias for clarity in this module). */
type PricingTableJSON = PricingTableData;

/** Result of resolving a model + tier combination to concrete pricing. */
export interface ResolvedPricing {
  pricing: ModelPricing;
  resolvedModel: string;
  resolvedTier: PricingTier;
  source: 'exact' | 'alias' | 'prefix' | 'fallback';
}

/**
 * Wraps a loaded pricing table and provides model resolution + cost calculation.
 * Constructed with raw JSON data; use `PricingTable.loadBundled(extensionRoot)` to
 * obtain an instance from the bundled `resources/pricing.json`.
 */
export class PricingTable {
  private readonly data: PricingTableData;
  private readonly logger: vscode.OutputChannel;
  /** Tracks which model keys have already been logged to avoid log spam. */
  private readonly loggedKeys = new Set<string>();

  constructor(data: PricingTableData, logger: vscode.OutputChannel) {
    this.data = data;
    this.logger = logger;
  }

  // ─── Static factory methods ──────────────────────────────────────────────

  /**
   * Loads the bundled `resources/pricing.json` from `extensionRoot` and returns
   * a new PricingTable instance.  Callers (Batch E/H) pass `context.extensionUri.fsPath`.
   */
  static async loadBundled(extensionRoot: string, logger: vscode.OutputChannel): Promise<PricingTable> {
    const filePath = path.join(extensionRoot, 'resources', 'pricing.json');
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const data = PricingTable.parseJson(raw);
    return new PricingTable(data, logger);
  }

  /**
   * Parses a raw JSON string into a validated PricingTableJSON.
   * Throws if any required top-level field is missing.
   */
  static parseJson(raw: string): PricingTableJSON {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const required = ['lastUpdated', 'aliases', 'models', 'fallbackModel'] as const;
    for (const key of required) {
      if (!(key in obj) || obj[key] === undefined) {
        throw new Error(`pricing.json missing required field: "${key}"`);
      }
    }
    return obj as unknown as PricingTableJSON;
  }

  // ─── Core resolution ─────────────────────────────────────────────────────

  /**
   * Resolves model + serviceTier → concrete ModelPricing.
   * Match chain: exact → alias → startsWith prefix → fallback.
   * Any serviceTier not in PricingTier ('standard' | 'priority') falls back to 'standard'.
   */
  resolvePricing(model: string, serviceTier: string): ResolvedPricing {
    const tier = this.normalizeTier(serviceTier);
    const { models, aliases, fallbackModel } = this.data;

    // 1. Exact match
    if (models[model]) {
      const pricing = this.pickTier(models[model], tier);
      return { pricing, resolvedModel: model, resolvedTier: tier, source: 'exact' };
    }

    // 2. Alias match
    const aliasTarget = aliases[model];
    if (aliasTarget && models[aliasTarget]) {
      const pricing = this.pickTier(models[aliasTarget], tier);
      return { pricing, resolvedModel: aliasTarget, resolvedTier: tier, source: 'alias' };
    }

    // 3. startsWith prefix match (log model starts with a known key)
    for (const key of Object.keys(models)) {
      if (model.startsWith(key)) {
        const pricing = this.pickTier(models[key], tier);
        this.logOnce(`prefix:${model}`, `[PricingTable] prefix match: "${model}" → "${key}"`);
        return { pricing, resolvedModel: key, resolvedTier: tier, source: 'prefix' };
      }
    }

    // 4. Fallback
    const fallback = models[fallbackModel] ?? models[Object.keys(models)[0]];
    const pricing = this.pickTier(fallback, tier);
    this.logOnce(`fallback:${model}`, `[PricingTable] WARN unknown model "${model}", fallback to "${fallbackModel}"`);
    return { pricing, resolvedModel: fallbackModel, resolvedTier: tier, source: 'fallback' };
  }

  /**
   * Computes USD cost for a single TokenUsageRecord.
   * - Returns 0 for synthetic messages.
   * - Respects `costUSD` when present and a valid positive finite number.
   * - Otherwise computes from token counts × unit prices.
   */
  calculateCost(record: TokenUsageRecord): number {
    if (record.model === '<synthetic>') {
      return 0;
    }

    // Prefer pre-computed costUSD from legacy logs
    if (record.costUSD !== undefined && Number.isFinite(record.costUSD) && record.costUSD >= 0) {
      return record.costUSD;
    }
    if (record.costUSD !== undefined) {
      this.logOnce(`badCostUSD:${record.messageId}`, `[PricingTable] WARN invalid costUSD ${record.costUSD} for ${record.model}, recomputing`);
    }

    const { pricing } = this.resolvePricing(record.model, record.serviceTier);
    const M = 1_000_000;

    return (
      (record.inputTokens * pricing.input +
        record.outputTokens * pricing.output +
        record.cacheRead * pricing.cache_read +
        record.cacheCreation5m * pricing.cache_creation_5m +
        record.cacheCreation1h * pricing.cache_creation_1h) /
      M
    );
  }

  /**
   * Returns true if the model can be resolved without falling back.
   * (Matches via exact key, alias, or startsWith prefix.)
   */
  isKnownModel(model: string): boolean {
    const { models, aliases } = this.data;
    if (models[model]) { return true; }
    if (aliases[model] && models[aliases[model]]) { return true; }
    return Object.keys(models).some(key => model.startsWith(key));
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** Maps any serviceTier string to a valid PricingTier; unknown values → 'standard'. */
  private normalizeTier(serviceTier: string): PricingTier {
    if (serviceTier === 'standard' || serviceTier === 'priority') {
      return serviceTier;
    }
    return 'standard';
  }

  /** Returns the ModelPricing for the requested tier, falling back to standard if missing. */
  private pickTier(tierMap: Record<PricingTier, ModelPricing>, tier: PricingTier): ModelPricing {
    return tierMap[tier] ?? tierMap['standard'];
  }

  /** Appends a log line at most once per unique key to avoid flooding the output channel. */
  private logOnce(key: string, message: string): void {
    if (this.loggedKeys.has(key)) { return; }
    this.loggedKeys.add(key);
    this.logger.appendLine(message);
  }
}
