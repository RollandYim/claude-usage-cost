import * as vscode from 'vscode';

/** Default gap within which a second click counts as a double-click. */
export const DEFAULT_DOUBLE_CLICK_WINDOW_MS = 350;

/** Default quiet window after a double-click to drop a stray third click. */
export const DEFAULT_QUIET_AFTER_DOUBLE_MS = 200;

export interface ClickLatchDeps {
  /** Returns current epoch ms. Override for fake timers in tests. */
  now: () => number;
  /** Schedule a deferred callback. Override to inject fake timers. */
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Cancel a scheduled callback. */
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  /** Invoked on the single-click path (after the double-click window elapses). */
  onSingleClick: () => void;
  /** Invoked on the double-click path (second click within the window). */
  onDoubleClick: () => void;
  /** Structured log sink. */
  logger: vscode.OutputChannel;
  /** Override double-click window (defaults to DEFAULT_DOUBLE_CLICK_WINDOW_MS). */
  doubleClickWindowMs?: number;
  /** Override quiet window (defaults to DEFAULT_QUIET_AFTER_DOUBLE_MS). */
  quietAfterDoubleMs?: number;
}

export interface ClickLatch {
  /** Invoke on every status-bar click event. */
  onClick: () => void;
  /** Clear any pending single-click timer. Idempotent and disposal-safe. */
  dispose: () => void;
}

/**
 * Builds a time-source-injectable click latch for the status-bar item.
 *
 * - Single click → fire `onSingleClick` after `doubleClickWindowMs`.
 * - Second click within the window → cancel the pending single-fire timer and
 *   invoke `onDoubleClick` synchronously; start a `quietAfterDoubleMs` window
 *   during which further clicks are dropped (drops a stray third click after
 *   a double-click).
 * - `dispose` cancels any pending timer so a disposed renderer never receives
 *   a late single-click callback.
 *
 * All external dependencies (`now` / `setTimeout` / `clearTimeout`) are
 * injected via `deps` so the factory can be unit-tested with fake timers
 * without pulling in VS Code APIs. Callback errors are caught and logged;
 * the latch itself never rethrows.
 */
export function createStatusBarClickLatch(deps: ClickLatchDeps): ClickLatch {
  const doubleWindow = deps.doubleClickWindowMs ?? DEFAULT_DOUBLE_CLICK_WINDOW_MS;
  const quietWindow = deps.quietAfterDoubleMs ?? DEFAULT_QUIET_AFTER_DOUBLE_MS;

  let pending: ReturnType<typeof setTimeout> | null = null;
  let quietUntil = 0;

  const onClick = (): void => {
    const now = deps.now();
    if (now < quietUntil) {
      deps.logger.appendLine('[clickLatch] ignored (inside quiet window)');
      return;
    }
    if (pending !== null) {
      deps.clearTimeout(pending);
      pending = null;
      quietUntil = now + quietWindow;
      deps.logger.appendLine('[clickLatch] double-click');
      try {
        deps.onDoubleClick();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.logger.appendLine(`[clickLatch] onDoubleClick threw: ${msg}`);
      }
      return;
    }
    pending = deps.setTimeout(() => {
      pending = null;
      deps.logger.appendLine('[clickLatch] single-click');
      try {
        deps.onSingleClick();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.logger.appendLine(`[clickLatch] onSingleClick threw: ${msg}`);
      }
    }, doubleWindow);
  };

  const dispose = (): void => {
    if (pending !== null) {
      deps.clearTimeout(pending);
      pending = null;
    }
  };

  return { onClick, dispose };
}
