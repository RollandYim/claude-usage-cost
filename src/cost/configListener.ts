import * as vscode from 'vscode';
import { CONFIG_SECTION } from '../config';
import type { CostService } from './costService';
import type { RemotePricingUpdater } from './remotePricingUpdater';

/**
 * Minimal interface for any object that can request a UI re-render.
 * Using an interface rather than a concrete type keeps this module decoupled
 * from the Batch G / H renderer implementation.
 */
export interface Renderer {
  requestRender(): void;
}

/**
 * Subscribes to VS Code workspace configuration changes and dispatches to the
 * appropriate cost sub-system handler.
 *
 * ### Handled keys (all under `claudeUsageCost.*`)
 * | Key | Action |
 * |-----|--------|
 * | `cost.display` | `renderer.requestRender()` |
 * | `cost.localRefreshSeconds` | `costService.restartTimer()` |
 * | `cost.pricing.remoteUrl` | `remoteUpdater.stop()` + `start()` |
 * | `thresholds.warning` / `thresholds.error` | `renderer.requestRender()` |
 *
 * Keys managed elsewhere (`displayMode`, `refreshIntervalSeconds`, …) are
 * intentionally NOT handled here to avoid double-handling.
 */
export class CostConfigListener implements vscode.Disposable {
  private subscription: vscode.Disposable | null = null;

  constructor(
    private readonly logger: vscode.OutputChannel,
    private readonly costService: CostService,
    private readonly remoteUpdater: RemotePricingUpdater,
    private readonly renderer: Renderer,
  ) {}

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Subscribes to `workspace.onDidChangeConfiguration`.
   * Must be called exactly once after construction; safe to push the returned
   * instance into `context.subscriptions` for automatic cleanup.
   */
  start(): void {
    this.subscription = vscode.workspace.onDidChangeConfiguration((e) => {
      this.handleConfigChange(e);
    });
  }

  dispose(): void {
    if (this.subscription !== null) {
      this.subscription.dispose();
      this.subscription = null;
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private handleConfigChange(e: vscode.ConfigurationChangeEvent): void {
    if (e.affectsConfiguration(`${CONFIG_SECTION}.cost.display`)) {
      this.logger.appendLine('[ConfigListener] cost.display changed');
      this.renderer.requestRender();
    }

    if (e.affectsConfiguration(`${CONFIG_SECTION}.cost.localRefreshSeconds`)) {
      this.logger.appendLine('[ConfigListener] cost.localRefreshSeconds changed');
      this.costService.restartTimer();
    }

    if (e.affectsConfiguration(`${CONFIG_SECTION}.cost.pricing.remoteUrl`)) {
      this.logger.appendLine('[ConfigListener] cost.pricing.remoteUrl changed');
      this.remoteUpdater.stop();
      this.remoteUpdater.start();
    }

    if (
      e.affectsConfiguration(`${CONFIG_SECTION}.thresholds.warning`) ||
      e.affectsConfiguration(`${CONFIG_SECTION}.thresholds.error`)
    ) {
      this.logger.appendLine('[ConfigListener] thresholds changed');
      this.renderer.requestRender();
    }
  }
}
