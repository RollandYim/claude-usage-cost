import * as vscode from 'vscode';
import {
  USAGE_API_URL,
  ANTHROPIC_BETA_HEADER,
  CONFIG_SECTION,
  DEFAULT_REFRESH_INTERVAL_SECONDS,
  MIN_REFRESH_INTERVAL_SECONDS,
  FETCH_TIMEOUT_MS,
  BACKOFF_INITIAL_MS,
  BACKOFF_MAX_MS,
  BACKOFF_FACTOR,
  POLL_JITTER_MS,
  POLL_JITTER_FRACTION,
  RETRY_AFTER_BUFFER_MS,
} from './config';
import type { UsageStore } from './usageStore';

function readIntervalMs(): number {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const raw = cfg.get<number>('refreshIntervalSeconds', DEFAULT_REFRESH_INTERVAL_SECONDS);
  const seconds = typeof raw === 'number' && isFinite(raw) ? raw : DEFAULT_REFRESH_INTERVAL_SECONDS;
  const clamped = Math.max(MIN_REFRESH_INTERVAL_SECONDS, Math.floor(seconds));
  return clamped * 1000;
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!isNaN(seconds) && seconds > 0) return seconds * 1000;
  // HTTP-date format
  const date = new Date(header);
  if (!isNaN(date.getTime())) {
    const diff = date.getTime() - Date.now();
    return diff > 0 ? diff : null;
  }
  return null;
}

/**
 * Background fallback that periodically GETs the Anthropic usage API as a
 * safety net when passive diagnostics interception has not yet captured a
 * response. Also serves the manual "refresh now" command and the bootstrap
 * hydration on activation.
 *
 * Passive interception writes to `UsageStore` directly and does NOT go through
 * this service — therefore no cross-path concurrency concern with the
 * interceptor exists here.
 */
export class PollingService implements vscode.Disposable {
  private _token: string | null = null;
  private _timer: NodeJS.Timeout | null = null;
  private _backoffMs = BACKOFF_INITIAL_MS;
  private _backoffActive = false;
  private _inFlight = false;
  private _disposed = false;
  private _started = false;
  private _intervalMs: number = readIntervalMs();
  private readonly _configSub: vscode.Disposable;

  /**
   * Whether a fetch initiated by this service is currently in flight.
   * Used to prevent concurrent refresh attempts from the timer, bootstrap,
   * and manual refresh command. Passive interception does NOT consult this flag
   * (the interceptor writes to the store directly and never initiates HTTP).
   */
  isInFlight(): boolean {
    return this._inFlight;
  }

  constructor(
    private readonly store: UsageStore,
    private readonly logger: vscode.OutputChannel,
  ) {
    this._configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.refreshIntervalSeconds`)) {
        const next = readIntervalMs();
        if (next !== this._intervalMs) {
          this.logger.appendLine(
            `[PollingService] refreshIntervalSeconds changed: ${Math.round(this._intervalMs / 1000)}s → ${Math.round(next / 1000)}s`,
          );
          this._intervalMs = next;
          if (this._timer) {
            this._clearTimer();
            this._scheduleNext();
          }
        }
      }
    });
  }

  setToken(token: string): void {
    const wasEmpty = !this._token;
    this._token = token;
    // When `start()` ran before the token was available (the normal activation
    // order: pollingService.start() → bootstrapFromKeychain → setToken), the
    // initial `_scheduleNext()` inside `start()` early-returned because of the
    // `!this._token` guard and NO timer was armed. Without this kick-off the
    // only refresh the user ever gets is the one bootstrap does manually, and
    // the status bar's "Last updated" freezes at that single timestamp.
    //
    // Guard against re-entry when a token is replaced mid-cycle (e.g. future
    // re-auth) — only trigger scheduling on the first non-null transition and
    // when nothing is armed yet.
    if (this._started && wasEmpty && !this._timer && !this._disposed) {
      this._scheduleNext();
    }
  }

  start(): void {
    if (this._timer || this._disposed) return;
    this._started = true;
    this.logger.appendLine(
      `[PollingService] start — interval=${Math.round(this._intervalMs / 1000)}s (+ 0-${Math.round(this._jitterCapMs() / 1000)}s jitter per tick)`,
    );
    this._scheduleNext();
  }

  /**
   * Upper bound for jitter added to `_intervalMs` each tick.
   *
   * Scales jitter with the current interval (never exceeding `POLL_JITTER_MS`)
   * so a 30 s interval does not wait up to 90 s for the next poll — which was
   * the cause of "I set 30s but nothing updates for a minute" reports before
   * this cap was introduced.
   */
  private _jitterCapMs(): number {
    return Math.min(POLL_JITTER_MS, Math.floor(this._intervalMs * POLL_JITTER_FRACTION));
  }

  async refreshNow(): Promise<void> {
    if (this._disposed) return;
    if (!this._token) {
      this.logger.appendLine(
        'No cached OAuth token — skipping refresh (remote API previously returned 401; passive interception remains active)',
      );
      return;
    }

    // Concurrency guard: prevent timer/bootstrap/manual-refresh from issuing
    // overlapping HTTP requests. Passive interception never calls this path.
    if (this._inFlight) {
      this.logger.appendLine('refreshNow: skip (fetch already in flight)');
      return;
    }

    this._inFlight = true;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      this.logger.appendLine(`refreshNow: GET ${USAGE_API_URL}`);
      const response = await fetch(USAGE_API_URL, {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this._token}`,
          'anthropic-beta': ANTHROPIC_BETA_HEADER,
        },
      });
      this.logger.appendLine(`refreshNow: response status=${response.status}`);

      if (response.status === 401) {
        this.logger.appendLine(
          'Remote usage API returned 401 — disabling proactive polling (passive interception remains active)',
        );
        this._token = null;
        this._clearTimer();
        this.store.setRemoteStatus('unauthorized');
        return;
      }

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
        const wait = (retryAfterMs ?? this._intervalMs) + RETRY_AFTER_BUFFER_MS;
        this.logger.appendLine(
          `429 rate limit — pausing ${Math.round(wait / 1000)}s (includes ${RETRY_AFTER_BUFFER_MS / 1000}s buffer)`,
        );
        this.store.setRemoteStatus('rate_limited');
        this._pauseFor(wait);
        return;
      }

      if (response.status >= 500) {
        this.logger.appendLine(`5xx error (${response.status}) — backing off ${Math.round(this._backoffMs / 1000)}s`);
        this._backoffActive = true;
        this.store.setRemoteStatus('offline');
        this._pauseFor(this._backoffMs);
        this._backoffMs = Math.min(this._backoffMs * BACKOFF_FACTOR, BACKOFF_MAX_MS);
        return;
      }

      if (!response.ok) {
        this.logger.appendLine(`Unexpected status ${response.status}`);
        return;
      }

      const json: unknown = await response.json();
      // `store.update()` internally calls `setRemoteStatus('ok')` — no extra call needed.
      this.store.update(json);
      const snapshot = this.store.data;
      this.logger.appendLine(
        `refreshNow: store updated — 5h=${snapshot?.fiveHour?.utilization ?? 'null'}% 7d=${snapshot?.sevenDay?.utilization ?? 'null'}%`,
      );

      if (this._backoffActive) {
        this._backoffMs = BACKOFF_INITIAL_MS;
        this._backoffActive = false;
      }
    } catch (err) {
      this.logger.appendLine(`Fetch error: ${err}`);
      // Network / abort errors also trigger backoff.
      this._backoffActive = true;
      this.store.setRemoteStatus('offline');
      this._pauseFor(this._backoffMs);
      this._backoffMs = Math.min(this._backoffMs * BACKOFF_FACTOR, BACKOFF_MAX_MS);
    } finally {
      clearTimeout(timeoutHandle);
      this._inFlight = false;
    }
  }

  private _scheduleNext(): void {
    // Short-circuit on no token: after a 401 terminal state the `.finally()`
    // below still invokes `_scheduleNext()`. Without this guard every tick
    // would re-enter, still skip the HTTP request (no token), and reschedule —
    // an infinite no-op loop that violates the "401 → no further scheduling"
    // contract in the spec.
    //
    // Short-circuit on existing timer: when `refreshNow()` hits 429 / 5xx /
    // catch, it calls `_pauseFor(wait)` which sets `_timer` to the pause
    // handle BEFORE returning. The `.finally()` below then re-enters here
    // — without this guard we would overwrite `_timer` with a fresh
    // `_scheduleNext` handle, orphan the pause timer, and effectively bypass
    // `Retry-After` / backoff. Both handles would then fire, doubling the
    // request rate and accumulating on every subsequent 429/5xx.
    if (this._disposed || !this._token || this._timer) return;
    const jitterMs = Math.floor(Math.random() * this._jitterCapMs());
    const delay = this._intervalMs + jitterMs;
    this.logger.appendLine(
      `[PollingService] next poll in ${Math.round(delay / 1000)}s (interval=${Math.round(this._intervalMs / 1000)}s + jitter=${Math.round(jitterMs / 1000)}s)`,
    );
    this._timer = setTimeout(() => {
      this._timer = null;
      this.refreshNow()
        .catch((err: unknown) => this.logger.appendLine(`Polling error: ${err}`))
        .finally(() => this._scheduleNext());
    }, delay);
  }

  private _pauseFor(ms: number): void {
    this._clearTimer();
    this._timer = setTimeout(() => {
      this._timer = null;
      this.logger.appendLine('[PollingService] pause elapsed — issuing post-pause refresh');
      // The pause itself is the full cooldown window — do NOT insert another
      // `intervalMs + jitter` wait here. Fire `refreshNow()` directly; its
      // `.finally` re-enters `_scheduleNext()` to drive the next normal tick.
      this.refreshNow()
        .catch((err: unknown) => this.logger.appendLine(`Polling error (after pause): ${err}`))
        .finally(() => this._scheduleNext());
    }, ms);
  }

  private _clearTimer(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  dispose(): void {
    this._disposed = true;
    this._clearTimer();
    this._configSub.dispose();
  }
}
