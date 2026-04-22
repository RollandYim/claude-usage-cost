import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  return { EventEmitter };
});

import { UsageStore } from '../src/usageStore';
import type { UsageData } from '../src/types';

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

function makeMemento(initial?: unknown) {
  const data: Record<string, unknown> = {};
  if (initial !== undefined) {
    data['lastKnownUsage'] = initial;
  }
  return {
    get: <T>(key: string): T | undefined => data[key] as T | undefined,
    update: (key: string, value: unknown): Promise<void> => {
      data[key] = value;
      return Promise.resolve();
    },
    keys: (): readonly string[] => Object.keys(data),
    setKeysForSync: vi.fn(),
  };
}

function makeStore(mementoInit?: unknown) {
  const logger = makeLogger();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = new UsageStore(makeMemento(mementoInit) as any, logger as any);
  return { store, logger };
}

const SAVED_SNAPSHOT = {
  fiveHour: { utilization: 42, resetsAt: '2026-04-30T00:00:00Z' },
  sevenDay: { utilization: 15, resetsAt: '2026-05-05T00:00:00Z' },
  sevenDaySonnet: null,
  extraUsage: null,
  fetchedAt: 1745000000000,
};

// ── restore() ─────────────────────────────────────────────────────────────────

describe('UsageStore.restore()', () => {
  it('fires onDidChange exactly once with revived data', () => {
    const { store } = makeStore(SAVED_SNAPSHOT);
    const fired: UsageData[] = [];
    store.onDidChange((d) => fired.push(d));

    store.restore();

    expect(fired).toHaveLength(1);
    expect(fired[0].fiveHour?.utilization).toBe(42);
  });

  it('does NOT fire onDidChange when globalState is empty', () => {
    const { store } = makeStore(); // no snapshot
    const fired: UsageData[] = [];
    store.onDidChange((d) => fired.push(d));

    store.restore();

    expect(fired).toHaveLength(0);
  });

  it('populates store.data after restore', () => {
    const { store } = makeStore(SAVED_SNAPSHOT);

    store.restore();

    expect(store.data?.fiveHour?.utilization).toBe(42);
    expect(store.data?.sevenDay?.utilization).toBe(15);
  });
});

// ── update() ──────────────────────────────────────────────────────────────────

describe('UsageStore.update()', () => {
  let store: UsageStore;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    ({ store, logger } = makeStore());
  });

  it('fires onDidChange with parsed API data', () => {
    const fired: UsageData[] = [];
    store.onDidChange((d) => fired.push(d));

    store.update({
      five_hour: { utilization: 37, resets_at: '2026-04-30T00:00:00Z' },
      seven_day: { utilization: 26, resets_at: '2026-05-05T00:00:00Z' },
    });

    expect(fired).toHaveLength(1);
    expect(fired[0].fiveHour?.utilization).toBe(37);
    expect(fired[0].sevenDay?.utilization).toBe(26);
  });

  it('clamps utilization > 100 and logs a warning', () => {
    store.update({
      five_hour: { utilization: 120, resets_at: '2026-04-30T00:00:00Z' },
    });

    expect(store.data?.fiveHour?.utilization).toBe(100);
    expect(logger.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('out-of-range utilization 120'),
    );
  });

  it('clamps utilization < 0 and logs a warning', () => {
    store.update({
      five_hour: { utilization: -5, resets_at: '2026-04-30T00:00:00Z' },
    });

    expect(store.data?.fiveHour?.utilization).toBe(0);
    expect(logger.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('out-of-range utilization -5'),
    );
  });
});

// ── remoteStatus ──────────────────────────────────────────────────────────────

describe('UsageStore.remoteStatus', () => {
  it('defaults to unknown', () => {
    const { store } = makeStore();
    expect(store.remoteStatus).toBe('unknown');
  });

  it('setRemoteStatus updates getter and fires onDidChangeStatus exactly once', () => {
    const { store } = makeStore();
    const fired: string[] = [];
    store.onDidChangeStatus((s) => fired.push(s));

    store.setRemoteStatus('unauthorized');

    expect(store.remoteStatus).toBe('unauthorized');
    expect(fired).toEqual(['unauthorized']);
  });

  it('setRemoteStatus with identical value does NOT fire event', () => {
    const { store } = makeStore();
    const fired: string[] = [];
    store.onDidChangeStatus((s) => fired.push(s));

    store.setRemoteStatus('ok');
    store.setRemoteStatus('ok');
    store.setRemoteStatus('ok');

    expect(fired).toEqual(['ok']);
  });

  it('update() automatically sets remoteStatus to ok and fires event', () => {
    const { store } = makeStore();
    const fired: string[] = [];
    store.onDidChangeStatus((s) => fired.push(s));

    store.update({
      five_hour: { utilization: 37, resets_at: '2026-04-30T00:00:00Z' },
    });

    expect(store.remoteStatus).toBe('ok');
    expect(fired).toEqual(['ok']);
  });

  it('update() when remoteStatus already ok does NOT re-fire', () => {
    const { store } = makeStore();
    store.setRemoteStatus('ok');

    const fired: string[] = [];
    store.onDidChangeStatus((s) => fired.push(s));

    store.update({ five_hour: { utilization: 10, resets_at: '2026-04-30T00:00:00Z' } });

    expect(fired).toEqual([]);
  });

  it('dispose() cleans up both emitters without throwing', () => {
    const { store } = makeStore();
    expect(() => store.dispose()).not.toThrow();
    // second dispose should also be safe
    expect(() => store.dispose()).not.toThrow();
  });
});
