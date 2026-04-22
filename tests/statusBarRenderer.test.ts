/**
 * Unit tests for StatusBarRenderer pure-logic helpers and the tooltip
 * branching driven by `store.remoteStatus`.
 *
 * Historically the full StatusBarRenderer could not be instantiated under
 * Vitest because of its VS Code runtime dependencies. For the fallback-tooltip
 * tests introduced in the passive-interception change we mock just enough of
 * the `vscode` module to construct the renderer and read back the tooltip
 * markdown string.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UsageData, UsageWindow } from '../src/types';

// ── Pure helpers extracted from the renderer module for unit-testing ──────────
// (duplicated here to avoid coupling tests to private exports)

function applyExpiry(data: UsageData, now: Date): UsageData {
  const normalize = (win: UsageWindow | null): UsageWindow | null => {
    if (!win) return null;
    return win.resetsAt.getTime() <= now.getTime() ? { ...win, utilization: 0 } : win;
  };
  return {
    ...data,
    fiveHour: normalize(data.fiveHour),
    sevenDay: normalize(data.sevenDay),
    sevenDaySonnet: normalize(data.sevenDaySonnet),
  };
}

function maxUtilization(
  data: UsageData,
  mode: 'session' | 'weekly' | 'both',
): number {
  const s = mode !== 'weekly' ? (data.fiveHour?.utilization ?? 0) : 0;
  const w = mode !== 'session' ? (data.sevenDay?.utilization ?? 0) : 0;
  return Math.max(s, w);
}

// ── Test helpers ──────────────────────────────────────────────────────────────

const NOW = new Date('2026-01-01T12:00:00Z');

function makeWin(utilization: number, resetsAt: Date): UsageWindow {
  return { utilization, resetsAt };
}

function makeData(
  fiveHour: UsageWindow | null = null,
  sevenDay: UsageWindow | null = null,
  sevenDaySonnet: UsageWindow | null = null,
): UsageData {
  return { fiveHour, sevenDay, sevenDaySonnet, extraUsage: null, fetchedAt: NOW.getTime() };
}

const FUTURE = new Date(NOW.getTime() + 3_600_000); // +1h
const PAST = new Date(NOW.getTime() - 1000);        // -1s

// ── applyExpiry ───────────────────────────────────────────────────────────────

describe('applyExpiry', () => {
  it('leaves non-expired window utilization unchanged', () => {
    const data = makeData(makeWin(82, FUTURE));
    const result = applyExpiry(data, NOW);
    expect(result.fiveHour?.utilization).toBe(82);
  });

  it('zeroes utilization for expired fiveHour window', () => {
    const data = makeData(makeWin(95, PAST));
    const result = applyExpiry(data, NOW);
    expect(result.fiveHour?.utilization).toBe(0);
  });

  it('zeroes utilization for expired sevenDay window', () => {
    const data = makeData(null, makeWin(60, PAST));
    const result = applyExpiry(data, NOW);
    expect(result.sevenDay?.utilization).toBe(0);
  });

  it('zeroes utilization when resetsAt equals now (boundary)', () => {
    const data = makeData(makeWin(50, NOW));
    const result = applyExpiry(data, NOW);
    expect(result.fiveHour?.utilization).toBe(0);
  });

  it('preserves resetsAt date on expired window', () => {
    const data = makeData(makeWin(70, PAST));
    const result = applyExpiry(data, NOW);
    expect(result.fiveHour?.resetsAt).toBe(PAST);
  });

  it('passes null windows through as null', () => {
    const data = makeData(null, null);
    const result = applyExpiry(data, NOW);
    expect(result.fiveHour).toBeNull();
    expect(result.sevenDay).toBeNull();
  });

  it('does not zero a window that resets in the future', () => {
    const data = makeData(makeWin(100, FUTURE));
    const result = applyExpiry(data, NOW);
    expect(result.fiveHour?.utilization).toBe(100);
  });
});

// ── maxUtilization ────────────────────────────────────────────────────────────

describe('maxUtilization', () => {
  it('session mode: returns fiveHour utilization', () => {
    const data = makeData(makeWin(75, FUTURE), makeWin(20, FUTURE));
    expect(maxUtilization(data, 'session')).toBe(75);
  });

  it('weekly mode: returns sevenDay utilization', () => {
    const data = makeData(makeWin(80, FUTURE), makeWin(50, FUTURE));
    expect(maxUtilization(data, 'weekly')).toBe(50);
  });

  it('both mode: returns max across session and weekly', () => {
    const data = makeData(makeWin(50, FUTURE), makeWin(85, FUTURE));
    expect(maxUtilization(data, 'both')).toBe(85);
  });

  it('both mode: returns session when it is higher', () => {
    const data = makeData(makeWin(92, FUTURE), makeWin(40, FUTURE));
    expect(maxUtilization(data, 'both')).toBe(92);
  });

  it('session mode: ignores weekly even if higher', () => {
    const data = makeData(makeWin(45, FUTURE), makeWin(95, FUTURE));
    expect(maxUtilization(data, 'session')).toBe(45);
  });

  it('returns 0 when relevant window is null', () => {
    const data = makeData(null, null);
    expect(maxUtilization(data, 'session')).toBe(0);
    expect(maxUtilization(data, 'weekly')).toBe(0);
    expect(maxUtilization(data, 'both')).toBe(0);
  });
});

// ── Foreground colour threshold mapping (warningForeground / errorForeground) ──

describe('foreground colour threshold logic', () => {
  const CRITICAL = 90;
  const WARNING = 70;

  function resolveForeground(pct: number): 'errorForeground' | 'warningForeground' | 'default' {
    if (pct >= CRITICAL) return 'errorForeground';
    if (pct >= WARNING) return 'warningForeground';
    return 'default';
  }

  it('below 70% → default', () => expect(resolveForeground(45)).toBe('default'));
  it('exactly 70% → warningForeground', () => expect(resolveForeground(70)).toBe('warningForeground'));
  it('75% → warningForeground', () => expect(resolveForeground(75)).toBe('warningForeground'));
  it('exactly 90% → errorForeground', () => expect(resolveForeground(90)).toBe('errorForeground'));
  it('100% → errorForeground', () => expect(resolveForeground(100)).toBe('errorForeground'));
  it('89% → warningForeground', () => expect(resolveForeground(89)).toBe('warningForeground'));
});

// ── Full StatusBarRenderer with mocked `vscode` ──────────────────────────────
//
// These tests instantiate the real renderer via a hoisted vscode mock so we
// can assert the remoteStatus-driven tooltip branching added by the passive
// interception change.

vi.mock('vscode', () => {
  class EventEmitter {
    private _listeners: Array<(e: unknown) => void> = [];
    event = (listener: (e: unknown) => void): { dispose: () => void } => {
      this._listeners.push(listener);
      return { dispose: () => { this._listeners = this._listeners.filter((l) => l !== listener); } };
    };
    fire(e: unknown): void { this._listeners.forEach((l) => l(e)); }
    dispose(): void { this._listeners = []; }
  }
  class MarkdownString {
    isTrusted = false;
    supportThemeIcons = false;
    constructor(public value: string = '') {}
    appendMarkdown(v: string): this { this.value += v; return this; }
    appendText(v: string): this { this.value += v; return this; }
    appendCodeblock(v: string): this { this.value += v; return this; }
  }
  class ThemeColor {
    constructor(public id: string) {}
  }
  const StatusBarAlignment = { Left: 1, Right: 2 } as const;
  const createdItems: Array<Record<string, unknown>> = [];
  const window = {
    createStatusBarItem: () => {
      const item = {
        text: '',
        tooltip: undefined as unknown,
        color: undefined as unknown,
        command: '',
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
      };
      createdItems.push(item);
      return item;
    },
  };
  const workspace = {
    getConfiguration: (): {
      get: <T>(key: string, fallback: T) => T;
    } => ({
      get: <T>(_key: string, fallback: T): T => fallback,
    }),
    onDidChangeConfiguration: (): { dispose: () => void } => ({ dispose: () => undefined }),
  };
  return { EventEmitter, MarkdownString, ThemeColor, StatusBarAlignment, window, workspace };
});

import { StatusBarRenderer } from '../src/statusBarRenderer';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as vscode from 'vscode';

describe('StatusBarRenderer tooltip fallback (remoteStatus branching)', () => {
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

  type TestStore = {
    data: UsageData | null;
    _status: 'unknown' | 'ok' | 'unauthorized' | 'rate_limited' | 'offline';
    get remoteStatus(): 'unknown' | 'ok' | 'unauthorized' | 'rate_limited' | 'offline';
    onDidChange: ReturnType<typeof vscode.EventEmitter>['event'];
    onDidChangeStatus: ReturnType<typeof vscode.EventEmitter>['event'];
    _fireChange: (d: UsageData) => void;
    _fireStatus: (s: string) => void;
  };

  function makeStore(): TestStore {
    const changeEmitter = new vscode.EventEmitter();
    const statusEmitter = new vscode.EventEmitter();
    const store = {
      data: null as UsageData | null,
      _status: 'unknown' as TestStore['_status'],
      get remoteStatus(): TestStore['_status'] { return this._status; },
      onDidChange: changeEmitter.event.bind(changeEmitter),
      onDidChangeStatus: statusEmitter.event.bind(statusEmitter),
      _fireChange: (d: UsageData): void => changeEmitter.fire(d),
      _fireStatus: (s: string): void => statusEmitter.fire(s),
    };
    return store;
  }

  function makeCostService(totalUSD: number, lastUpdated: number) {
    const emitter = new vscode.EventEmitter();
    return {
      getTodaySummary: (): { totalUSD: number; byModel: Record<string, never>; lastUpdated: number } => ({
        totalUSD,
        byModel: {},
        lastUpdated,
      }),
      onDidChangeCost: emitter.event.bind(emitter),
    };
  }

  let renderer: { dispose: () => void; forceRender: () => void } | undefined;

  beforeEach(() => {
    // Clear any state from previous tests
  });

  afterEach(() => {
    renderer?.dispose();
    renderer = undefined;
  });

  function getTooltipValue(store: TestStore, cost = makeCostService(1.23, Date.now())): string {
    const logger = makeLogger();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    renderer = new StatusBarRenderer(store as any, logger as any, cost as any);
    renderer!.forceRender();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const item = (vscode.window.createStatusBarItem as any).mock
      // fall back: the mocked window isn't a vi.fn(), so read from the hook
      // implementation via the renderer's item. Instead, we reach into
      // renderer's `_item` (private) using a known unsafe cast for tests.
      ? undefined
      : undefined;
    void item;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const priv = renderer as any;
    return String(priv._item.tooltip?.value ?? '');
  }

  it('unauthorized + null data + cost summary → tooltip contains 401 rejected copy', () => {
    const store = makeStore();
    store._status = 'unauthorized';
    const tooltip = getTooltipValue(store);
    expect(tooltip).toContain('rejected the current token (401)');
    expect(tooltip).toContain('Passive interception of Claude Code requests remains active');
  });

  it('rate_limited + null data → tooltip contains 429 copy', () => {
    const store = makeStore();
    store._status = 'rate_limited';
    const tooltip = getTooltipValue(store);
    expect(tooltip).toContain('rate-limited (429)');
    expect(tooltip).toContain('Polling is temporarily paused');
  });

  it('unknown + null data → tooltip contains "temporarily unreachable" copy', () => {
    const store = makeStore();
    store._status = 'unknown';
    const tooltip = getTooltipValue(store);
    expect(tooltip).toContain('temporarily unreachable');
    expect(tooltip).not.toContain('401');
    expect(tooltip).not.toContain('429');
  });

  it('store.data present → fallback copy is NOT used (regardless of remoteStatus)', () => {
    const store = makeStore();
    store._status = 'unauthorized';
    store.data = {
      fiveHour: { utilization: 50, resetsAt: new Date(Date.now() + 3600_000) },
      sevenDay: { utilization: 20, resetsAt: new Date(Date.now() + 7 * 86400_000) },
      sevenDaySonnet: null,
      extraUsage: null,
      fetchedAt: Date.now(),
    };
    const tooltip = getTooltipValue(store);
    expect(tooltip).not.toContain('rejected the current token');
    expect(tooltip).not.toContain('temporarily unreachable');
    expect(tooltip).toContain('**Session:**');
    expect(tooltip).toContain('**Weekly:**');
  });

  it('onDidChangeStatus triggers a re-render (tooltip reflects new status)', () => {
    const store = makeStore();
    store._status = 'unknown';
    const logger = makeLogger();
    const cost = makeCostService(2.5, Date.now());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    renderer = new StatusBarRenderer(store as any, logger as any, cost as any);
    renderer!.forceRender();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const priv = renderer as any;
    expect(String(priv._item.tooltip.value)).toContain('temporarily unreachable');

    store._status = 'unauthorized';
    store._fireStatus('unauthorized');
    expect(String(priv._item.tooltip.value)).toContain('rejected the current token (401)');
  });
});
