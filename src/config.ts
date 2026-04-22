import * as os from 'os';
import * as path from 'path';

export const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
export const ANTHROPIC_BETA_HEADER = 'oauth-2025-04-20';
export const KEYCHAIN_SERVICE = 'Claude Code-credentials';
export const FALLBACK_FILE_PATH = path.join(os.homedir(), '.claude', 'usage-bar-data.json');
export const DEFAULT_REFRESH_INTERVAL_SECONDS = 60; // 1 min default
export const MIN_REFRESH_INTERVAL_SECONDS = 30;
export const POLL_INTERVAL_MS = DEFAULT_REFRESH_INTERVAL_SECONDS * 1000;
export const FETCH_TIMEOUT_MS = 30_000; // 30s hard timeout per fetch call
export const KEYCHAIN_TIMEOUT_MS = 3_000; // 3s timeout for security execFile
export const BACKOFF_INITIAL_MS = 30_000; // 30s
export const BACKOFF_MAX_MS = 600_000; // 10 min
export const BACKOFF_FACTOR = 1.5;
export const MAX_INTERCEPT_BODY_BYTES = 1_048_576; // 1 MB hard limit for intercepted response body
/**
 * Hard ceiling on random polling jitter (ms). The actual jitter applied each
 * tick is `min(POLL_JITTER_MS, floor(intervalMs * POLL_JITTER_FRACTION))` so
 * the spread stays proportional to the configured interval — otherwise a
 * short interval (e.g. 30s) would be dominated by a fixed 60s jitter and
 * starve fresh refreshes.
 */
export const POLL_JITTER_MS = 60_000;
/** Max jitter as a fraction of the current polling interval. */
export const POLL_JITTER_FRACTION = 0.2;
export const RETRY_AFTER_BUFFER_MS = 30_000;       // 30s extra buffer after Retry-After pause
export const DIAGNOSTICS_URL_PATTERN = '/api/oauth/usage';
export const GLOBAL_STATE_KEY = 'lastKnownUsage';
export const OUTPUT_CHANNEL_NAME = 'Claude Usage Cost';
export const STATUS_BAR_PRIORITY = 100;

/** Configuration namespace for this extension's settings. */
export const CONFIG_SECTION = 'claudeUsageCost';

// ─── Cost Tracking Constants ─────────────────────────────────────────────────

/** Default value for the `claudeUsageCost.cost.display` setting. */
export const COST_DISPLAY_DEFAULT = 'today' as const;

/** Default local log-scan interval in seconds. */
export const LOCAL_REFRESH_DEFAULT_SECONDS = 10;

/** Minimum allowed local log-scan interval in seconds. */
export const LOCAL_REFRESH_MIN = 5;

/** Maximum allowed local log-scan interval in seconds. */
export const LOCAL_REFRESH_MAX = 60;

/** How often the remote pricing URL is re-fetched (24 h in ms). */
export const REMOTE_PRICING_FETCH_INTERVAL_MS = 86_400_000;

/** Hard timeout for a single remote pricing fetch in ms. */
export const REMOTE_PRICING_TIMEOUT_MS = 10_000;

/** `globalState` key under which `CostStoreData` is persisted. */
export const COST_STORE_KEY = 'costStore';

/** Primary Claude Code credentials file path. */
export const CREDENTIALS_PRIMARY_PATH = path.join(os.homedir(), '.claude.json');

/** Secondary Claude Code credentials file path (fallback). */
export const CREDENTIALS_SECONDARY_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

/**
 * Returns candidate Claude Code log root paths in priority order:
 * 1. `$CLAUDE_CONFIG_DIR/projects/` (when the env var is set)
 * 2. `~/.claude/projects/`
 * 3. `~/.config/claude/projects/`
 *
 * Callers should try each path in order and use the first that exists.
 */
export const LOG_ROOT_PATHS = (): string[] => {
  const defaults = [
    path.join(os.homedir(), '.claude', 'projects'),
    path.join(os.homedir(), '.config', 'claude', 'projects'),
  ];
  const envDir = process.env['CLAUDE_CONFIG_DIR'];
  if (envDir) {
    return [path.join(envDir, 'projects'), ...defaults];
  }
  return defaults;
};

/** Model name used as a conservative fallback when a record's model is unknown. */
export const UNKNOWN_MODEL_FALLBACK = 'claude-opus-4-7';

/** Interval in ms for retrying `fs.watch` on credentials files that don't yet exist. */
export const CREDENTIALS_WATCH_RETRY_MS = 60_000;

/** Default utilization % threshold for warning color (yellow). Used by Batch G. */
export const THRESHOLD_WARNING_DEFAULT = 80;

/** Default utilization % threshold for error color (red). Used by Batch G. */
export const THRESHOLD_ERROR_DEFAULT = 95;

// ─── Weekly cost panel ───────────────────────────────────────────────────────

/** Config key name (without section prefix) for the weekly-cost-panel day window. */
export const WEEKLY_COST_DAYS_KEY = 'weeklyCostPanel.days';

/** Default value for {@link WEEKLY_COST_DAYS_KEY}. */
export const WEEKLY_COST_DAYS_DEFAULT = 7;

/**
 * Parses a raw configuration value for the weekly-cost day window into either a
 * positive integer or the literal `'all'`.
 *
 * - `'all'` (case-insensitive) → `'all'`.
 * - `'7'` / `7` / `'14'` / `14` etc. → the corresponding positive integer.
 * - Anything else (including negative, zero, NaN, unknown strings) →
 *   {@link WEEKLY_COST_DAYS_DEFAULT}.
 */
export function parseWeeklyCostDays(raw: unknown): number | 'all' {
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'all') {
    return 'all';
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    return WEEKLY_COST_DAYS_DEFAULT;
  }
  return n;
}
