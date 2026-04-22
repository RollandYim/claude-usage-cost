import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  OUTPUT_CHANNEL_NAME,
  CONFIG_SECTION,
  LOCAL_REFRESH_DEFAULT_SECONDS,
  LOCAL_REFRESH_MIN,
  LOCAL_REFRESH_MAX,
} from './config';
import { initLogger } from './logger';
import { UsageStore } from './usageStore';
import { PollingService } from './pollingService';
import { DiagnosticsInterceptor } from './diagnosticsInterceptor';
import { FallbackFileWatcher } from './fallbackFileWatcher';
import { StatusBarRenderer } from './statusBarRenderer';
import { bootstrapFromKeychain } from './keychainBootstrap';
import { switchDisplayMode, setDisplayMode } from './displayModeController';
import { PricingTable } from './cost/pricingTable';
import { AccountIdentityService } from './cost/accountIdentity';
import { UsageLogReader } from './cost/usageLogReader';
import { CostAggregator } from './cost/costAggregator';
import { CostStore } from './cost/costStore';
import { CostService } from './cost/costService';
import { RemotePricingUpdater } from './cost/remotePricingUpdater';
import { CostConfigListener } from './cost/configListener';
import { WeeklyCostReportBuilder } from './costPanel/weeklyCostReportBuilder';
import { WeeklyCostPanel } from './costPanel/weeklyCostPanel';
import { createStatusBarClickLatch } from './statusBarClickLatch';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Step 1: Create output channel and initialise the shared logger
  const logger = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  initLogger(logger);
  context.subscriptions.push(logger);
  logger.appendLine('[activate] Output channel created — extension activating');

  // Step 2: Create UsageStore and restore persisted data from globalState
  const store = new UsageStore(context.globalState, logger);
  logger.appendLine('[activate] UsageStore created');
  store.restore();
  logger.appendLine('[activate] UsageStore.restore() complete');
  context.subscriptions.push(store);

  // Step 3: Create DiagnosticsInterceptor FIRST — subscribes to Node http
  // diagnostics channels as early as possible so we don't miss the very first
  // Claude Code request. Must precede anything that could issue an outbound
  // request (notably PollingService).
  const interceptor = new DiagnosticsInterceptor(store, logger);
  logger.appendLine('[activate] DiagnosticsInterceptor created and subscribed');
  context.subscriptions.push(interceptor);

  // Step 4: Create PollingService (not started yet)
  const pollingService = new PollingService(store, logger);
  logger.appendLine('[activate] PollingService created');
  context.subscriptions.push(pollingService);

  // Step 5: Create FallbackFileWatcher (starts watching and performs initial read on construction)
  const fallbackWatcher = new FallbackFileWatcher(store, logger);
  logger.appendLine('[activate] FallbackFileWatcher created');
  context.subscriptions.push(fallbackWatcher);

  // ── Cost Subsystem ─────────────────────────────────────────────────────────

  /**
   * Returns the configured local refresh interval in milliseconds,
   * clamped to [LOCAL_REFRESH_MIN, LOCAL_REFRESH_MAX] × 1000.
   */
  const getLocalRefreshMs = (): number => {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const raw = cfg.get<number>('cost.localRefreshSeconds', LOCAL_REFRESH_DEFAULT_SECONDS);
    const clamped = Math.max(LOCAL_REFRESH_MIN, Math.min(LOCAL_REFRESH_MAX, raw));
    return clamped * 1_000;
  };

  /**
   * Returns the configured remote pricing URL, or `undefined` when the
   * feature is disabled (empty / whitespace-only string).
   */
  const getRemoteUrl = (): string | undefined => {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const url = cfg.get<string>('cost.pricing.remoteUrl', '');
    return url && url.trim().length > 0 ? url.trim() : undefined;
  };

  let costService: CostService | undefined;
  let identitySvc: AccountIdentityService | undefined;
  let remoteUpdater: RemotePricingUpdater | undefined;
  let pricingLastUpdated = 'unknown';
  let pricingModelCount = 0;
  let weeklyBuilder: WeeklyCostReportBuilder | undefined;

  try {
    // 1) Load bundled pricing table.
    //    Using readFile + parseJson directly (rather than loadBundled) to capture
    //    metadata (lastUpdated, model count) for the activation summary log without
    //    reading the file a second time.
    const pricingPath = path.join(context.extensionUri.fsPath, 'resources', 'pricing.json');
    const pricingRaw = await fs.promises.readFile(pricingPath, 'utf-8');
    const pricingData = PricingTable.parseJson(pricingRaw);
    pricingLastUpdated = pricingData.lastUpdated;
    pricingModelCount = Object.keys(pricingData.models).length;
    const pricingTable = new PricingTable(pricingData, logger);
    logger.appendLine(
      `[activate] PricingTable loaded, lastUpdated=${pricingLastUpdated}, models=${pricingModelCount}`,
    );

    // 2) AccountIdentityService — reads credentials files and establishes fs.watch.
    identitySvc = new AccountIdentityService(logger);
    await identitySvc.initialize();
    // Push early so it is disposed LAST among cost services (LIFO order).
    context.subscriptions.push(identitySvc);
    logger.appendLine('[activate] AccountIdentityService initialized');

    // 3) CostStore — wraps globalState; each update() already persists immediately.
    //    No dispose() method; no timers/watchers to clean up.
    const costStore = new CostStore(context.globalState, logger);
    logger.appendLine('[activate] CostStore created');

    // 4) UsageLogReader — stateless; cursors are fetched from costStore on each scan.
    const logReader = new UsageLogReader(logger, () => costStore.getFileCursors());
    logger.appendLine('[activate] UsageLogReader created');

    // 5) CostAggregator — pure computation layer; no disposable resources.
    const aggregator = new CostAggregator(pricingTable, logger);
    logger.appendLine('[activate] CostAggregator created');

    // 6) RemotePricingUpdater — always created so CostConfigListener can restart it
    //    when the user configures a remoteUrl later. start() is a no-op when URL is empty.
    remoteUpdater = new RemotePricingUpdater(logger, getRemoteUrl, (newTable) => {
      aggregator.setPricing(newTable);
    });
    context.subscriptions.push(remoteUpdater);
    logger.appendLine('[activate] RemotePricingUpdater created');

    // 7) CostService — pushed AFTER remoteUpdater so it is disposed BEFORE identitySvc (LIFO).
    costService = new CostService(
      logger,
      identitySvc,
      logReader,
      aggregator,
      costStore,
      getLocalRefreshMs,
    );
    context.subscriptions.push(costService);
    logger.appendLine('[activate] CostService created');

    // 8) WeeklyCostReportBuilder — reuses the same pricingTable / logReader /
    //    costStore / identitySvc instances so opening the weekly-cost panel
    //    does not trigger duplicate I/O or a second identity watcher.
    weeklyBuilder = new WeeklyCostReportBuilder(
      identitySvc,
      logReader,
      pricingTable,
      costStore,
      logger,
    );
    logger.appendLine('[activate] WeeklyCostReportBuilder created');

  } catch (err) {
    logger.appendLine(`[activate] PricingTable load failed, cost disabled: ${err}`);
    // costService / identitySvc / remoteUpdater remain undefined.
    // StatusBarRenderer will render utilization-only (no cost segment).
  }

  // Step 6: Create StatusBarRenderer (shows item and starts 1 s tick on construction).
  // Pushed AFTER costService so it is disposed BEFORE costService in LIFO order — ensuring
  // the renderer's costService.onDidChangeCost subscription is cleaned up before the
  // EventEmitter inside CostService is disposed.
  const renderer = new StatusBarRenderer(store, logger, costService, identitySvc);
  logger.appendLine('[activate] StatusBarRenderer created');
  context.subscriptions.push(renderer);

  // Force an immediate render — guarantees the placeholder "$(loading~spin) Claude Usage"
  // is visible even before the first store update arrives.
  renderer.forceRender();
  logger.appendLine('[activate] forceRender() called — placeholder displayed');

  // Step 7: Create CostConfigListener (must be after renderer so we can reference it).
  // Adapts StatusBarRenderer.forceRender() to the Renderer.requestRender() interface.
  if (costService && remoteUpdater) {
    const configListener = new CostConfigListener(
      logger,
      costService,
      remoteUpdater,
      { requestRender: () => renderer.forceRender() },
    );
    configListener.start();
    context.subscriptions.push(configListener);
    logger.appendLine('[activate] CostConfigListener started');
  }

  // Step 8: Start the background polling timer
  pollingService.start();
  logger.appendLine('[activate] PollingService.start() called');

  // Step 9: Start cost services (non-blocking; errors are logged and silently dropped).
  if (costService) {
    costService.start().catch((err: unknown) => {
      logger.appendLine(`[activate] CostService.start() error: ${err}`);
    });
    logger.appendLine('[activate] CostService.start() called (non-blocking)');
  }

  if (remoteUpdater) {
    remoteUpdater.start();
    logger.appendLine('[activate] RemotePricingUpdater.start() called');
  }

  // Register command: claude-usage-cost.refresh
  const refreshCmd = vscode.commands.registerCommand(
    'claude-usage-cost.refresh',
    () => {
      logger.appendLine('[cmd:refresh] Refresh triggered by user');
      pollingService.refreshNow().catch((err: unknown) => {
        logger.appendLine(`[cmd:refresh] refreshNow error: ${err}`);
      });
      renderer.forceRender();
    },
  );
  context.subscriptions.push(refreshCmd);
  logger.appendLine('[activate] Command claude-usage-cost.refresh registered');

  // Register command: claude-usage-cost.switchDisplayMode
  const switchCmd = vscode.commands.registerCommand(
    'claude-usage-cost.switchDisplayMode',
    () => {
      logger.appendLine('[cmd:switchDisplayMode] Switch display mode triggered by user');
      switchDisplayMode(logger).catch((err: unknown) => {
        logger.appendLine(`[cmd:switchDisplayMode] error: ${err}`);
      });
      // StatusBarRenderer reacts automatically via its internal onDidChangeConfiguration
      // subscription — no direct renderer call required here.
    },
  );
  context.subscriptions.push(switchCmd);
  logger.appendLine('[activate] Command claude-usage-cost.switchDisplayMode registered');

  // Register command: claude-usage-cost.setDisplayMode — QuickPick to pick
  // a specific mode directly, as an alternative to the cyclic switchDisplayMode.
  const setCmd = vscode.commands.registerCommand(
    'claude-usage-cost.setDisplayMode',
    () => {
      logger.appendLine('[cmd:setDisplayMode] Triggered by user');
      setDisplayMode(logger).catch((err: unknown) => {
        logger.appendLine(`[cmd:setDisplayMode] error: ${err}`);
      });
    },
  );
  context.subscriptions.push(setCmd);
  logger.appendLine('[activate] Command claude-usage-cost.setDisplayMode registered');

  // Register command: claude-usage-cost.showLogs — a quick entry point to open
  // the Output channel for diagnostics.
  const showLogsCmd = vscode.commands.registerCommand(
    'claude-usage-cost.showLogs',
    () => {
      logger.show(true);
    },
  );
  context.subscriptions.push(showLogsCmd);
  logger.appendLine('[activate] Command claude-usage-cost.showLogs registered');

  // ── Weekly cost panel + status-bar click-latch ────────────────────────────
  //
  // The status-bar item binds to `claude-usage-cost.statusBarClick`; the
  // latch converts a stream of clicks into single/double semantics and then
  // dispatches to the real command (refresh / showWeeklyCostPanel).

  const clickLatch = createStatusBarClickLatch({
    now: () => Date.now(),
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h),
    onSingleClick: () => {
      void vscode.commands.executeCommand('claude-usage-cost.refresh');
    },
    onDoubleClick: () => {
      void vscode.commands.executeCommand('claude-usage-cost.showWeeklyCostPanel');
    },
    logger,
  });
  context.subscriptions.push({ dispose: () => clickLatch.dispose() });

  const statusBarClickCmd = vscode.commands.registerCommand(
    'claude-usage-cost.statusBarClick',
    () => clickLatch.onClick(),
  );
  context.subscriptions.push(statusBarClickCmd);
  logger.appendLine('[activate] Command claude-usage-cost.statusBarClick registered');

  const showWeeklyCmd = vscode.commands.registerCommand(
    'claude-usage-cost.showWeeklyCostPanel',
    async () => {
      if (!weeklyBuilder) {
        logger.appendLine(
          '[cmd:showWeeklyCostPanel] cost subsystem disabled — cannot open panel',
        );
        void vscode.window.showInformationMessage(
          'Claude Usage Cost: weekly cost panel is unavailable because cost tracking failed to initialize. See the output channel for details.',
        );
        return;
      }
      try {
        await WeeklyCostPanel.show(weeklyBuilder, logger);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(`[cmd:showWeeklyCostPanel] failed: ${msg}`);
        void vscode.window.showErrorMessage(
          `Claude Usage Cost: failed to open weekly cost panel — ${msg}`,
        );
      }
    },
  );
  context.subscriptions.push(showWeeklyCmd);
  logger.appendLine('[activate] Command claude-usage-cost.showWeeklyCostPanel registered');

  // Step 10: Trigger keychain bootstrap — fire-and-forget, must not block activation.
  bootstrapFromKeychain(store, pollingService, logger).catch((err: unknown) => {
    logger.appendLine(`[activate] bootstrapFromKeychain unexpected error (ignored): ${err}`);
  });
  logger.appendLine('[activate] bootstrapFromKeychain triggered (background, non-blocking)');

  // Self-diagnostic: if no data has arrived within 6 seconds, surface the Output channel
  // automatically so the user sees exactly which step failed.
  const diagTimer = setTimeout(() => {
    if (!store.data) {
      logger.appendLine(
        '[activate] No usage data after 6s — opening Output channel for diagnosis.',
      );
      logger.show(true);
    }
  }, 6_000);
  context.subscriptions.push({ dispose: () => clearTimeout(diagTimer) });

  // Activation summary log (email masked to `u***@domain` for safe logging).
  const rawEmail = identitySvc?.getCurrentIdentity().emailAddress ?? null;
  const maskedEmail = rawEmail
    ? `${rawEmail.slice(0, 1)}***${rawEmail.slice(Math.max(0, rawEmail.indexOf('@')))}`
    : 'unknown';
  const remoteActive = getRemoteUrl() !== undefined;
  logger.appendLine(
    `[activate] cost subsystem: enabled=${costService !== undefined}, ` +
    `pricing=bundled@${pricingLastUpdated}, models=${pricingModelCount}, ` +
    `account=${maskedEmail}, remoteUpdate=${remoteActive ? 'on' : 'off'}`,
  );

  logger.appendLine('[activate] Extension fully activated');
}

// VS Code disposes all context.subscriptions on deactivation in LIFO order:
//   diagTimer → commands → configListener → renderer → costService →
//   remoteUpdater → identitySvc → fallbackWatcher → pollingService →
//   interceptor → store → logger
// (Interceptor was constructed BEFORE pollingService in Step 3 so it is
//  disposed AFTER pollingService here — minimising the window during which
//  outbound polling requests could race against an unsubscribed channel.)
// No explicit cleanup is required here.
export function deactivate(): void {}
