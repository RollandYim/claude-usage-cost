/**
 * Unit tests for `src/cost/configListener.ts`.
 *
 * Tests that configuration changes trigger the correct downstream actions:
 * - `cost.display` → `renderer.requestRender()`
 * - `cost.localRefreshSeconds` → `costService.restartTimer()`
 * - `cost.pricing.remoteUrl` → `remoteUpdater.stop()` + `remoteUpdater.start()`
 * - `thresholds.warning` → `renderer.requestRender()`
 * - `thresholds.error` → `renderer.requestRender()`
 * - Unrelated key → no action taken
 *
 * `vscode.workspace.onDidChangeConfiguration` is mocked so the handler can
 * be invoked directly in each test without a real VS Code runtime.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type * as vscode from 'vscode';

// ── vscode mock ───────────────────────────────────────────────────────────────
//
// We keep a reference to the most recently registered configuration-change
// handler so tests can simulate VS Code firing the event.

type ConfigChangeHandler = (e: vscode.ConfigurationChangeEvent) => void;
const _registeredHandlers: ConfigChangeHandler[] = [];

vi.mock('vscode', () => ({
  workspace: {
    onDidChangeConfiguration: vi.fn((handler: ConfigChangeHandler) => {
      _registeredHandlers.push(handler);
      return {
        dispose: () => {
          const idx = _registeredHandlers.indexOf(handler);
          if (idx >= 0) { _registeredHandlers.splice(idx, 1); }
        },
      };
    }),
  },
}));

import { CostConfigListener } from '../src/cost/configListener';
import type { Renderer } from '../src/cost/configListener';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Fires the most recently registered onDidChangeConfiguration handler. */
function fireConfigChange(affectedKeys: string[]): void {
  const handler = _registeredHandlers[_registeredHandlers.length - 1];
  if (!handler) { throw new Error('No handler registered; call listener.start() first'); }
  const event: vscode.ConfigurationChangeEvent = {
    affectsConfiguration: (section: string) => affectedKeys.includes(section),
  };
  handler(event);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeMockLogger() {
  return {
    appendLine: vi.fn(),
    append: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    clear: vi.fn(),
    replace: vi.fn(),
    name: 'test',
  } as unknown as import('vscode').OutputChannel;
}

function makeMockCostService() {
  return {
    restartTimer: vi.fn(),
  } as unknown as import('../src/cost/costService').CostService;
}

function makeMockRemoteUpdater() {
  return {
    stop: vi.fn(),
    start: vi.fn(),
    dispose: vi.fn(),
  } as unknown as import('../src/cost/remotePricingUpdater').RemotePricingUpdater;
}

function makeMockRenderer(): Renderer {
  return { requestRender: vi.fn() };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CostConfigListener', () => {
  let logger: ReturnType<typeof makeMockLogger>;
  let costService: ReturnType<typeof makeMockCostService>;
  let remoteUpdater: ReturnType<typeof makeMockRemoteUpdater>;
  let renderer: Renderer;
  let listener: CostConfigListener;

  beforeEach(() => {
    _registeredHandlers.length = 0; // clear between tests
    vi.clearAllMocks();

    logger = makeMockLogger();
    costService = makeMockCostService();
    remoteUpdater = makeMockRemoteUpdater();
    renderer = makeMockRenderer();

    listener = new CostConfigListener(logger, costService, remoteUpdater, renderer);
    listener.start();
  });

  afterEach(() => {
    listener.dispose();
  });

  // ── cost.display ──────────────────────────────────────────────────────────

  it('cost.display change → renderer.requestRender() is called', () => {
    fireConfigChange(['claudeUsageCost.cost.display']);
    expect(renderer.requestRender).toHaveBeenCalledOnce();
    expect(costService.restartTimer).not.toHaveBeenCalled();
    expect(remoteUpdater.stop).not.toHaveBeenCalled();
    expect(remoteUpdater.start).not.toHaveBeenCalled();
  });

  it('cost.display change → [ConfigListener] cost.display changed is logged', () => {
    fireConfigChange(['claudeUsageCost.cost.display']);
    expect(logger.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('[ConfigListener] cost.display changed'),
    );
  });

  // ── cost.localRefreshSeconds ──────────────────────────────────────────────

  it('cost.localRefreshSeconds change → costService.restartTimer() is called', () => {
    fireConfigChange(['claudeUsageCost.cost.localRefreshSeconds']);
    expect(costService.restartTimer).toHaveBeenCalledOnce();
    expect(renderer.requestRender).not.toHaveBeenCalled();
    expect(remoteUpdater.stop).not.toHaveBeenCalled();
  });

  it('cost.localRefreshSeconds change → [ConfigListener] cost.localRefreshSeconds changed is logged', () => {
    fireConfigChange(['claudeUsageCost.cost.localRefreshSeconds']);
    expect(logger.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('[ConfigListener] cost.localRefreshSeconds changed'),
    );
  });

  // ── cost.pricing.remoteUrl ────────────────────────────────────────────────

  it('cost.pricing.remoteUrl change → remoteUpdater.stop() then start() are called', () => {
    fireConfigChange(['claudeUsageCost.cost.pricing.remoteUrl']);
    expect(remoteUpdater.stop).toHaveBeenCalledOnce();
    expect(remoteUpdater.start).toHaveBeenCalledOnce();
    expect(renderer.requestRender).not.toHaveBeenCalled();
    expect(costService.restartTimer).not.toHaveBeenCalled();
  });

  it('cost.pricing.remoteUrl change → stop is called before start', () => {
    const callOrder: string[] = [];
    vi.mocked(remoteUpdater.stop).mockImplementation(() => { callOrder.push('stop'); });
    vi.mocked(remoteUpdater.start).mockImplementation(() => { callOrder.push('start'); });

    fireConfigChange(['claudeUsageCost.cost.pricing.remoteUrl']);
    expect(callOrder).toEqual(['stop', 'start']);
  });

  // ── thresholds ────────────────────────────────────────────────────────────

  it('thresholds.warning change → renderer.requestRender() is called', () => {
    fireConfigChange(['claudeUsageCost.thresholds.warning']);
    expect(renderer.requestRender).toHaveBeenCalledOnce();
    expect(costService.restartTimer).not.toHaveBeenCalled();
  });

  it('thresholds.error change → renderer.requestRender() is called', () => {
    fireConfigChange(['claudeUsageCost.thresholds.error']);
    expect(renderer.requestRender).toHaveBeenCalledOnce();
    expect(costService.restartTimer).not.toHaveBeenCalled();
  });

  it('both threshold keys changing simultaneously → renderer.requestRender() called once', () => {
    fireConfigChange([
      'claudeUsageCost.thresholds.warning',
      'claudeUsageCost.thresholds.error',
    ]);
    // The handler checks both in a single if-branch with OR, so requestRender
    // is called once for the combined check.
    expect(renderer.requestRender).toHaveBeenCalledOnce();
  });

  // ── Unrelated keys ────────────────────────────────────────────────────────

  it('unrelated key change → no action taken', () => {
    fireConfigChange(['claudeUsageCost.displayMode']);
    expect(renderer.requestRender).not.toHaveBeenCalled();
    expect(costService.restartTimer).not.toHaveBeenCalled();
    expect(remoteUpdater.stop).not.toHaveBeenCalled();
    expect(remoteUpdater.start).not.toHaveBeenCalled();
  });

  it('completely unrelated extension key → no action taken', () => {
    fireConfigChange(['editor.fontSize']);
    expect(renderer.requestRender).not.toHaveBeenCalled();
    expect(costService.restartTimer).not.toHaveBeenCalled();
  });

  // ── dispose ───────────────────────────────────────────────────────────────

  it('after dispose(), configuration changes no longer trigger actions', () => {
    listener.dispose();
    // After dispose the handler is removed from _registeredHandlers
    expect(_registeredHandlers).toHaveLength(0);
  });

  it('dispose() is idempotent — calling twice does not throw', () => {
    expect(() => {
      listener.dispose();
      listener.dispose();
    }).not.toThrow();
  });
});
