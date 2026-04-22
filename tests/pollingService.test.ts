import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Minimal vscode mock ───────────────────────────────────────────────────────

vi.mock('vscode', () => {
  class EventEmitter {
    private _listeners: Array<(e: unknown) => void> = [];
    event = (listener: (e: unknown) => void): { dispose: () => void } => {
      this._listeners.push(listener);
      return {
        dispose: () => {
          this._listeners = this._listeners.filter((l) => l !== listener);
        },
      };
    };
    fire(e: unknown): void {
      this._listeners.forEach((l) => l(e));
    }
    dispose(): void {
      this._listeners = [];
    }
  }
  const workspace = {
    getConfiguration: (): { get: <T>(key: string, fallback: T) => T } => ({
      get: <T>(_key: string, fallback: T): T => fallback,
    }),
    onDidChangeConfiguration: (): { dispose: () => void } => ({ dispose: () => undefined }),
  };
  return { EventEmitter, workspace };
});

import { PollingService } from '../src/pollingService';
import type { UsageStore } from '../src/usageStore';
import type { RemoteUsageStatus } from '../src/types';
import {
  POLL_JITTER_MS,
  POLL_JITTER_FRACTION,
  RETRY_AFTER_BUFFER_MS,
  DEFAULT_REFRESH_INTERVAL_SECONDS,
} from '../src/config';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    name: 'test',
    append: vi.fn(),
    appendLine: vi.fn(),
    replace: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeStore() {
  const update = vi.fn();
  const setRemoteStatus = vi.fn();
  const store = {
    update,
    setRemoteStatus,
    data: null,
  } as unknown as UsageStore;
  return { store, update, setRemoteStatus };
}

function makeResponse(init: {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
}): Response {
  const headers = new Headers(init.headers ?? {});
  const body = init.json !== undefined ? JSON.stringify(init.json) : '';
  return new Response(body, { status: init.status, headers }) as unknown as Response;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const intervalMs = DEFAULT_REFRESH_INTERVAL_SECONDS * 1000;

describe('PollingService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;
  let originalRandom: () => number;

  beforeEach(() => {
    vi.useFakeTimers();
    originalFetch = global.fetch;
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof global.fetch;
    originalRandom = Math.random;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    Math.random = originalRandom;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('401 → _token cleared, remoteStatus=unauthorized, timer stopped, no further scheduling', async () => {
    const { store, setRemoteStatus } = makeStore();
    const logger = makeLogger();
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 401 }));

    const svc = new PollingService(store, logger as never);
    svc.setToken('t');
    Math.random = (): number => 0; // deterministic jitter = 0
    svc.start();

    // fire the first scheduled poll
    await vi.advanceTimersByTimeAsync(intervalMs);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setRemoteStatus).toHaveBeenCalledWith('unauthorized' satisfies RemoteUsageStatus);

    // Advance far beyond any possible poll interval — MUST NOT issue another fetch
    await vi.advanceTimersByTimeAsync(intervalMs * 10 + POLL_JITTER_MS * 10);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Manual refresh after 401 → still skipped (no token), no new fetch
    await svc.refreshNow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const skipLog = logger.appendLine.mock.calls.find((c: unknown[]) =>
      String(c[0]).startsWith('No cached OAuth token'),
    );
    expect(skipLog).toBeDefined();

    svc.dispose();
  });

  it('429 + Retry-After → pause = (Retry-After * 1000) + RETRY_AFTER_BUFFER_MS, sets rate_limited', async () => {
    const { store, setRemoteStatus } = makeStore();
    const logger = makeLogger();
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({ status: 429, headers: { 'Retry-After': '60' } }),
      )
      .mockResolvedValueOnce(makeResponse({ status: 200, json: { five_hour: null, seven_day: null } }));

    const svc = new PollingService(store, logger as never);
    svc.setToken('t');
    Math.random = (): number => 0;
    svc.start();

    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setRemoteStatus).toHaveBeenCalledWith('rate_limited' satisfies RemoteUsageStatus);

    // pauseFor = 60_000 + RETRY_AFTER_BUFFER_MS. Just before resume: still 1 call.
    await vi.advanceTimersByTimeAsync(60_000 + RETRY_AFTER_BUFFER_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Cross past the resume boundary + one full interval+jitterCap window: a
    // second fetch MUST have fired. We use the *actual* jitter cap
    // (min(POLL_JITTER_MS, intervalMs × POLL_JITTER_FRACTION)) so the window
    // only fits exactly one post-resume fetch — if we see 3+ here either the
    // pause schedule was duplicated (regression of the `_scheduleNext`
    // `_timer`-guard) or the jitter cap regressed upward.
    const jitterCapMs = Math.min(POLL_JITTER_MS, Math.floor(intervalMs * POLL_JITTER_FRACTION));
    await vi.advanceTimersByTimeAsync(1 + intervalMs + jitterCapMs);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    svc.dispose();
  });

  it('5xx → remoteStatus=offline, backoff pause', async () => {
    const { store, setRemoteStatus } = makeStore();
    const logger = makeLogger();
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 503 }));

    const svc = new PollingService(store, logger as never);
    svc.setToken('t');
    Math.random = (): number => 0;
    svc.start();

    await vi.advanceTimersByTimeAsync(intervalMs);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setRemoteStatus).toHaveBeenCalledWith('offline' satisfies RemoteUsageStatus);

    svc.dispose();
  });

  it('jitter is re-drawn per tick and capped at min(POLL_JITTER_MS, intervalMs × POLL_JITTER_FRACTION)', async () => {
    const { store } = makeStore();
    const logger = makeLogger();
    fetchMock.mockResolvedValue(
      makeResponse({ status: 200, json: { five_hour: null, seven_day: null } }),
    );

    const svc = new PollingService(store, logger as never);
    svc.setToken('t');

    const randoms = [0.1, 0.5, 0.9];
    let rIdx = 0;
    Math.random = (): number => randoms[rIdx++ % randoms.length] ?? 0;

    svc.start();

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(intervalMs + POLL_JITTER_MS + 10);
    }

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);

    const jitterLogs = logger.appendLine.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((s) => s.startsWith('[PollingService] next poll in'));
    const jitterSeconds = jitterLogs.map((s) => {
      const match = s.match(/jitter=(\d+)s/);
      return match ? Number(match[1]) : NaN;
    });

    // ≥2 distinct values drawn
    expect(new Set(jitterSeconds).size).toBeGreaterThanOrEqual(2);

    // Every draw capped by min(POLL_JITTER_MS, intervalMs * POLL_JITTER_FRACTION)
    const expectedCapSec = Math.ceil(
      Math.min(POLL_JITTER_MS, intervalMs * POLL_JITTER_FRACTION) / 1000,
    );
    for (const s of jitterSeconds) {
      expect(s).toBeLessThanOrEqual(expectedCapSec);
    }

    svc.dispose();
  });

  // Regression: when user configures a short interval (≈30 s), jitter MUST NOT
  // dominate the interval, otherwise "I set 30 s but nothing updated for a
  // minute" happens (actual delay used to be 30-90 s with the old fixed cap).
  it('short interval → jitter stays ≤ intervalMs × POLL_JITTER_FRACTION (not the 60 s global cap)', async () => {
    const { store } = makeStore();
    const logger = makeLogger();
    fetchMock.mockResolvedValue(
      makeResponse({ status: 200, json: { five_hour: null, seven_day: null } }),
    );

    // Override the workspace config to return 30 s (mirrors user setting).
    const vscodeMock = await import('vscode');
    vi.spyOn(vscodeMock.workspace, 'getConfiguration').mockReturnValue({
      get: <T>(_key: string, fallback: T): T => 30 as unknown as T ?? fallback,
    } as never);

    const svc = new PollingService(store, logger as never);
    svc.setToken('t');
    Math.random = (): number => 0.99; // max jitter draw
    svc.start();

    const shortIntervalMs = 30_000;
    // At 30s interval the cap is 30_000 * 0.2 = 6_000 ms → total delay ≤ 36 s.
    // Advancing 36_001 ms MUST be enough for one poll. If the old bug were
    // present, delay could be up to 90 s and the fetch would not have fired.
    await vi.advanceTimersByTimeAsync(shortIntervalMs + 6_001);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const jitterLog = logger.appendLine.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .find((s) => s.startsWith('[PollingService] next poll in'));
    expect(jitterLog).toBeDefined();
    const match = jitterLog!.match(/jitter=(\d+)s/);
    expect(match).toBeTruthy();
    const jitterSec = Number(match![1]);
    // Cap is 6s → with random=0.99 the draw rounds down to floor(6000*0.99)=5940 ms = 5 s rounded.
    expect(jitterSec).toBeLessThanOrEqual(6);

    svc.dispose();
  });

  it('200 → store.update called with JSON; _scheduleNext triggers next tick', async () => {
    const { store, update } = makeStore();
    const logger = makeLogger();
    const payload = { five_hour: null, seven_day: null };
    fetchMock.mockResolvedValue(makeResponse({ status: 200, json: payload }));

    const svc = new PollingService(store, logger as never);
    svc.setToken('t');
    Math.random = (): number => 0;
    svc.start();

    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(update).toHaveBeenCalledWith(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    svc.dispose();
  });

  // Regression: production activation order is pollingService.start() FIRST
  // (no token yet) then bootstrapFromKeychain → setToken(). Before the fix,
  // the initial _scheduleNext() inside start() bailed out on the `!_token`
  // guard and setToken() never re-armed the timer, so the only refresh the
  // user ever got was the one bootstrap invoked manually — "Last updated"
  // froze at that timestamp forever.
  it('start() before setToken() → setToken kicks off continuous polling', async () => {
    const { store } = makeStore();
    const logger = makeLogger();
    fetchMock.mockResolvedValue(
      makeResponse({ status: 200, json: { five_hour: null, seven_day: null } }),
    );

    const svc = new PollingService(store, logger as never);
    Math.random = (): number => 0; // deterministic jitter = 0
    svc.start();                     // token still null — must NOT fetch
    await vi.advanceTimersByTimeAsync(intervalMs * 3);
    expect(fetchMock).not.toHaveBeenCalled();

    svc.setToken('t');               // simulates bootstrapFromKeychain

    // First scheduled tick after token becomes available.
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // And the chain keeps going — this is the bit that used to break.
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    svc.dispose();
  });

  it('dispose prevents further scheduling', async () => {
    const { store } = makeStore();
    const logger = makeLogger();
    fetchMock.mockResolvedValue(
      makeResponse({ status: 200, json: { five_hour: null, seven_day: null } }),
    );

    const svc = new PollingService(store, logger as never);
    svc.setToken('t');
    Math.random = (): number => 0;
    svc.start();

    svc.dispose();

    await vi.advanceTimersByTimeAsync(intervalMs * 5);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshNow without token → no fetch, logs skip reason', async () => {
    const { store } = makeStore();
    const logger = makeLogger();

    const svc = new PollingService(store, logger as never);
    await svc.refreshNow();

    expect(fetchMock).not.toHaveBeenCalled();
    const skipLog = logger.appendLine.mock.calls.find((c: unknown[]) =>
      String(c[0]).startsWith('No cached OAuth token'),
    );
    expect(skipLog).toBeDefined();

    svc.dispose();
  });

  it('refreshNow in-flight guard prevents overlapping fetches', async () => {
    const { store } = makeStore();
    const logger = makeLogger();

    let resolveFetch: (r: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    fetchMock.mockReturnValueOnce(pending);

    const svc = new PollingService(store, logger as never);
    svc.setToken('t');

    const p1 = svc.refreshNow();
    const p2 = svc.refreshNow();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(makeResponse({ status: 200, json: { five_hour: null, seven_day: null } }));
    await p1;
    await p2;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    svc.dispose();
  });
});
