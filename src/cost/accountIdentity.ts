import * as fs from 'fs';
import * as vscode from 'vscode';
import type { AccountIdentity } from '../types';
import {
  CREDENTIALS_PRIMARY_PATH,
  CREDENTIALS_SECONDARY_PATH,
  CREDENTIALS_WATCH_RETRY_MS,
} from '../config';

// ─── Path overrides (used for unit testing) ───────────────────────────────────

/** Allows overriding credential file paths; primarily intended for tests. */
export interface CredentialPathOverrides {
  primaryPath?: string;
  secondaryPath?: string;
}

// ─── Internal JSON shapes ─────────────────────────────────────────────────────

interface OAuthAccountFields {
  accountUuid?: unknown;
  emailAddress?: unknown;
  organizationUuid?: unknown;
}

interface CredentialsFileJSON {
  oauthAccount?: OAuthAccountFields;
}

// ─── Pure helpers (exported for unit-testing) ─────────────────────────────────

/**
 * Attempts to parse an {@link AccountIdentity} from a raw credentials JSON value.
 *
 * Returns `null` when:
 * - The value is not an object.
 * - The `oauthAccount` key is missing.
 * - `oauthAccount.accountUuid` is not a non-empty string.
 *
 * @param raw    - The parsed JSON value (any shape accepted).
 * @param source - Which credential file was read.
 */
export function parseOAuthAccount(
  raw: unknown,
  source: 'primary' | 'secondary',
): AccountIdentity | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const creds = raw as CredentialsFileJSON;
  const oauth = creds.oauthAccount;
  if (!oauth || typeof oauth.accountUuid !== 'string' || oauth.accountUuid === '') {
    return null;
  }
  return {
    accountUuid: oauth.accountUuid,
    emailAddress: typeof oauth.emailAddress === 'string' ? oauth.emailAddress : null,
    organizationUuid: typeof oauth.organizationUuid === 'string' ? oauth.organizationUuid : null,
    source,
  };
}

/** Sentinel returned when no credential file yields a valid account identity. */
export const UNKNOWN_IDENTITY: AccountIdentity = Object.freeze({
  accountUuid: 'unknown',
  emailAddress: null,
  organizationUuid: null,
  source: 'unknown' as const,
});

/**
 * Attempts to read and parse a single credentials file.
 *
 * Returns `null` on any I/O error, JSON parse error, or when the file
 * does not contain a valid `oauthAccount` object.
 */
async function tryReadIdentity(
  filePath: string,
  source: 'primary' | 'secondary',
): Promise<AccountIdentity | null> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return parseOAuthAccount(JSON.parse(content), source);
  } catch {
    return null;
  }
}

/**
 * Resolves the current account identity by checking the primary credentials
 * file first, then the secondary.
 *
 * This is a **pure async function** with no side-effects—suitable for
 * direct unit testing with temporary files.
 *
 * @param primaryPath   - Absolute path to the primary credentials file.
 * @param secondaryPath - Absolute path to the secondary credentials file.
 * @returns The resolved identity, or {@link UNKNOWN_IDENTITY} when neither file
 *          yields a valid account.
 */
export async function resolveIdentity(
  primaryPath: string,
  secondaryPath: string,
): Promise<AccountIdentity> {
  const primary = await tryReadIdentity(primaryPath, 'primary');
  if (primary) return primary;
  const secondary = await tryReadIdentity(secondaryPath, 'secondary');
  if (secondary) return secondary;
  return { ...UNKNOWN_IDENTITY };
}

// ─── Log-masking helpers ──────────────────────────────────────────────────────

/**
 * Returns the first 8 characters of a UUID followed by `..` for safe logging.
 * Returns `'unknown'` verbatim for the sentinel value.
 */
function maskUuid(uuid: string): string {
  if (uuid === 'unknown') return 'unknown';
  return `${uuid.slice(0, 8)}..`;
}

/**
 * Masks an email address to `u***@domain` for safe logging.
 * Returns `'<none>'` when the address is `null`.
 */
function maskEmail(email: string | null): string {
  if (!email) return '<none>';
  const atIdx = email.indexOf('@');
  if (atIdx <= 0) return '***';
  return `${email[0]}***${email.slice(atIdx)}`;
}

// ─── AccountIdentityService ───────────────────────────────────────────────────

/**
 * Watches Claude Code credential files and exposes the current account identity.
 *
 * Fires {@link onDidChangeIdentity} whenever the active `accountUuid` or `source`
 * changes (e.g. when the user logs into a different account).
 *
 * **Watching strategy (primary file only):**
 * 1. On {@link initialize}, reads the current identity and calls `fs.watch` on
 *    {@link CREDENTIALS_PRIMARY_PATH}.
 * 2. If the file does not yet exist, a `setInterval` polls every
 *    {@link CREDENTIALS_WATCH_RETRY_MS} ms until it appears, then attaches a
 *    real `fs.watch` watcher.
 * 3. All watch events are debounced for **500 ms** to tolerate atomic
 *    write-then-rename patterns used by some credential managers.
 * 4. On a `rename` event (file replaced), the old watcher is closed and a new
 *    one is established after the debounce period.
 *
 * @example
 * ```ts
 * const svc = new AccountIdentityService(logger);
 * await svc.initialize();
 * svc.onDidChangeIdentity(id => costStore.resetForAccount(id));
 * context.subscriptions.push(svc);
 * ```
 */
export class AccountIdentityService implements vscode.Disposable {
  private readonly primaryPath: string;
  private readonly secondaryPath: string;

  private currentIdentity: AccountIdentity = { ...UNKNOWN_IDENTITY };

  private readonly emitter = new vscode.EventEmitter<AccountIdentity>();

  /** Fires whenever `accountUuid` or `source` changes. */
  readonly onDidChangeIdentity: vscode.Event<AccountIdentity> = this.emitter.event;

  private fsWatcher: fs.FSWatcher | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Guards against overlapping `tryEstablishWatch` async calls. */
  private watchPending = false;
  private disposed = false;

  constructor(
    private readonly logger: vscode.OutputChannel,
    overrides?: CredentialPathOverrides,
  ) {
    this.primaryPath = overrides?.primaryPath ?? CREDENTIALS_PRIMARY_PATH;
    this.secondaryPath = overrides?.secondaryPath ?? CREDENTIALS_SECONDARY_PATH;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Performs the initial credential read and establishes file-system watchers.
   *
   * Must be called exactly once after construction.  Awaiting the returned
   * promise ensures the identity is populated before the caller continues.
   */
  async initialize(): Promise<void> {
    this.currentIdentity = await resolveIdentity(this.primaryPath, this.secondaryPath);
    this.logger.appendLine(
      `[AccountIdentity] initialized, source=${this.currentIdentity.source}, ` +
      `accountUuid=${maskUuid(this.currentIdentity.accountUuid)}, ` +
      `email=${maskEmail(this.currentIdentity.emailAddress)}`,
    );
    void this.tryEstablishWatch();
  }

  /** Returns the most-recently resolved identity. May have `source='unknown'`. */
  getCurrentIdentity(): AccountIdentity {
    return this.currentIdentity;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tearDownWatchers();
    this.emitter.dispose();
  }

  // ── Watcher lifecycle ──────────────────────────────────────────────────────

  /**
   * Async entry point for the watch-setup state machine.
   *
   * - Checks whether the primary credentials file exists via `fs.stat`.
   * - If it exists: attaches a real `fs.watch` watcher.
   * - If not: logs a notice and falls back to interval polling.
   */
  private async tryEstablishWatch(): Promise<void> {
    if (this.disposed || this.watchPending) return;
    this.watchPending = true;
    try {
      await fs.promises.stat(this.primaryPath);
      this.attachFsWatcher();
    } catch {
      this.logger.appendLine(
        `[AccountIdentity] primary credentials not found; ` +
        `retrying every ${CREDENTIALS_WATCH_RETRY_MS}ms`,
      );
      this.scheduleRetry();
    } finally {
      this.watchPending = false;
    }
  }

  /**
   * Attaches `fs.watch` to the primary credentials file.
   *
   * Clears any previously-running watcher or retry interval before attaching.
   * Falls back to interval polling if `fs.watch` itself throws.
   */
  private attachFsWatcher(): void {
    this.clearFsWatcher();
    this.clearRetryTimer();

    try {
      this.fsWatcher = fs.watch(
        this.primaryPath,
        { persistent: false },
        (eventType) => {
          this.scheduleReread();
          if (eventType === 'rename') {
            // File was replaced via rename; the watcher handle is now stale.
            this.clearFsWatcher();
            void this.tryEstablishWatch();
          }
        },
      );
      this.fsWatcher.on('error', (err) => {
        this.logger.appendLine(`[AccountIdentity] watcher error: ${String(err)}`);
        this.clearFsWatcher();
        this.scheduleRetry();
      });
    } catch (err) {
      this.logger.appendLine(`[AccountIdentity] fs.watch failed: ${String(err)}`);
      this.scheduleRetry();
    }
  }

  /**
   * Starts the polling fallback interval.
   *
   * On each tick, {@link tryEstablishWatch} is called.  Once the primary file
   * appears, `attachFsWatcher` clears this interval automatically.
   */
  private scheduleRetry(): void {
    if (this.retryTimer || this.disposed) return;
    this.retryTimer = setInterval(() => {
      if (this.disposed) {
        this.clearRetryTimer();
        return;
      }
      void this.tryEstablishWatch();
    }, CREDENTIALS_WATCH_RETRY_MS);
  }

  /**
   * Debounces a credential re-read by 500 ms.
   *
   * Resets the timer on every call so rapid watch events collapse into a
   * single read.
   */
  private scheduleReread(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.reread();
    }, 500);
  }

  /**
   * Re-reads credentials and fires {@link onDidChangeIdentity} when the
   * account UUID or source has changed.
   *
   * Also re-attaches a watcher if none is currently active (e.g. after a
   * rename event destroyed the previous watcher).
   */
  private async reread(): Promise<void> {
    if (this.disposed) return;
    const next = await resolveIdentity(this.primaryPath, this.secondaryPath);
    const prev = this.currentIdentity;
    if (next.accountUuid !== prev.accountUuid || next.source !== prev.source) {
      this.logger.appendLine(
        `[AccountIdentity] identity changed, ` +
        `old=${maskUuid(prev.accountUuid)}, new=${maskUuid(next.accountUuid)}`,
      );
      this.currentIdentity = next;
      this.emitter.fire(next);
    }
    // Re-establish watch if it was lost during a rename/replace.
    if (!this.fsWatcher && !this.retryTimer) {
      void this.tryEstablishWatch();
    }
  }

  // ── Cleanup helpers ────────────────────────────────────────────────────────

  private clearFsWatcher(): void {
    if (this.fsWatcher) {
      try { this.fsWatcher.close(); } catch { /* ignore close errors */ }
      this.fsWatcher = null;
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private tearDownWatchers(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.clearFsWatcher();
    this.clearRetryTimer();
  }
}
