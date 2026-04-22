export type DisplayMode = 'session' | 'weekly' | 'both';

// ─── Cost Tracking Types ────────────────────────────────────────────────────

/** Controls whether and how cost is shown in the status bar. */
export type CostDisplayMode = 'today' | 'off';

/**
 * Per-category token unit pricing for a model tier.
 * All prices are in **USD per 1 000 000 tokens** (USD/M tokens).
 */
export interface ModelPricing {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M cache-read tokens */
  cache_read: number;
  /** USD per 1M tokens for 5-minute ephemeral cache creation */
  cache_creation_5m: number;
  /** USD per 1M tokens for 1-hour ephemeral cache creation */
  cache_creation_1h: number;
}

/**
 * Service-tier identifier used to look up pricing.
 * Any value not in this union (e.g. `'batch'`) falls back to `'standard'`.
 */
export type PricingTier = 'standard' | 'priority';

/** Alias → canonical model-name mapping (e.g. `{ sonnet: 'claude-sonnet-4-6' }`). */
export type ModelAlias = { [alias: string]: string };

/** Complete in-memory pricing table; loaded from bundled JSON or remote URL. */
export interface PricingTable {
  /** ISO date string the table was last updated, e.g. `'2026-04-21'`. */
  lastUpdated: string;
  /** Short-name aliases resolved before pattern matching. */
  aliases: ModelAlias;
  /** Outer key: model pattern string; inner key: service tier. */
  models: Record<string, Record<PricingTier, ModelPricing>>;
  /** Canonical model name used when no match is found (conservative over-estimate). */
  fallbackModel: string;
}

/** Single usage record extracted from a Claude Code `.jsonl` log file. */
export interface TokenUsageRecord {
  messageId: string;
  requestId: string;
  /** ISO 8601 timestamp as written in the log line */
  timestamp: string;
  model: string;
  serviceTier: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  cacheRead: number;
  /**
   * Pre-computed cost from legacy Claude Code logs (`costUSD` top-level field).
   * When present and a valid positive number, this value takes precedence over
   * token-based calculation.
   */
  costUSD?: number;
}

/** Aggregated daily cost for one account; stored as a value in `CostStoreData.entries`. */
export interface CostEntry {
  /** Local calendar date in `YYYY-MM-DD` format. */
  dateLocal: string;
  accountUuid: string;
  totalCostUSD: number;
  /** Per-model breakdown: total tokens consumed and USD cost. */
  byModel: Record<string, { tokens: number; cost: number }>;
  /** Unix epoch ms of last write. */
  updatedAt: number;
}

/** Shape persisted to VS Code `globalState` under `COST_STORE_KEY`. */
export interface CostStoreData {
  /** Incremented on every successful write; used for multi-window conflict detection. */
  version: number;
  /** Unix epoch ms of last modification. */
  mtime: number;
  /** Key format: `'{accountUuid}:{dateLocal}'`. */
  entries: Record<string, CostEntry>;
  /** Dedup set; key format: `'messageId:requestId'`. */
  processedIds: Record<string, true>;
  /** Per-file read cursor; key is the absolute file path. */
  fileCursors: Record<string, { inode: number; size: number; cursor: number }>;
}

/** Resolved Claude Code account identity. */
export interface AccountIdentity {
  accountUuid: string;
  emailAddress: string | null;
  organizationUuid: string | null;
  /** How this identity was resolved. */
  source: 'primary' | 'secondary' | 'unknown';
}

export interface UsageWindow {
  utilization: number; // 0-100 after clamp
  resetsAt: Date;
}

export interface UsageData {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  sevenDaySonnet: UsageWindow | null;
  extraUsage: {
    isEnabled: boolean;
    monthlyLimit: number | null;
    usedCredits: number | null;
    utilization: number | null;
  } | null;
  fetchedAt: number; // epoch ms
}

/**
 * Remote usage API status derived from PollingService / bootstrap outcome.
 * Drives StatusBarRenderer fallback tooltip copy when `UsageStore.data` is null.
 * NOT persisted across restarts.
 */
export type RemoteUsageStatus = 'unknown' | 'ok' | 'unauthorized' | 'rate_limited' | 'offline';
