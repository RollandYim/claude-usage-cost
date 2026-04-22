import * as vscode from 'vscode';
import type { WeeklyCostReportBuilder } from './weeklyCostReportBuilder';
import { renderWeeklyCostHtml, makeNonce } from './weeklyCostHtml';
import {
  CONFIG_SECTION,
  WEEKLY_COST_DAYS_KEY,
  WEEKLY_COST_DAYS_DEFAULT,
  parseWeeklyCostDays,
} from '../config';

const VIEW_TYPE = 'claudeUsageCost.weeklyCost';

function readConfiguredDays(): number | 'all' {
  const raw = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string | number>(WEEKLY_COST_DAYS_KEY, String(WEEKLY_COST_DAYS_DEFAULT));
  return parseWeeklyCostDays(raw);
}

/**
 * Singleton Webview that displays cost for the current account.
 *
 * Layout:
 *   - Range mode (`claudeUsageCost.weeklyCostPanel.days` = integer): one
 *     table covering the last N local days, newest first.
 *   - All mode (`claudeUsageCost.weeklyCostPanel.days` = `"all"`): one table
 *     per calendar month with recorded usage, months newest first; a
 *     "Grand Total" row at the bottom.
 *
 * Lifecycle:
 *   - `show()` creates the panel on first invocation, reveals it thereafter.
 *   - On open, a minimal loading placeholder is rendered; the real HTML is
 *     swapped in once `WeeklyCostReportBuilder.build()` resolves.
 *   - Reacts to changes to `claudeUsageCost.weeklyCostPanel.days` by
 *     re-rendering with the new window.
 *   - `onDidDispose` clears the singleton slot, so the next `show()` creates a
 *     fresh panel.
 *
 * Security:
 *   - `enableScripts: false` and `localResourceRoots: []`; CSP forbids
 *     `script-src` entirely. Only inline styles are allowed.
 */
export class WeeklyCostPanel {
  private static current: WeeklyCostPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private readonly subscriptions: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly builder: WeeklyCostReportBuilder,
    private readonly logger: vscode.OutputChannel,
  ) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.subscriptions);

    const watchKey = `${CONFIG_SECTION}.${WEEKLY_COST_DAYS_KEY}`;
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(watchKey)) {
          this.logger.appendLine(
            `[WeeklyCostPanel] config ${watchKey} changed → refreshing`,
          );
          void this.refresh();
        }
      }),
    );
  }

  static async show(
    builder: WeeklyCostReportBuilder,
    logger: vscode.OutputChannel,
  ): Promise<void> {
    const column =
      vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (WeeklyCostPanel.current !== undefined) {
      WeeklyCostPanel.current.panel.reveal(column);
      await WeeklyCostPanel.current.refresh();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'Claude Weekly Cost',
      column,
      {
        enableScripts: false,
        retainContextWhenHidden: false,
        localResourceRoots: [],
      },
    );

    WeeklyCostPanel.current = new WeeklyCostPanel(panel, builder, logger);
    panel.webview.html = WeeklyCostPanel.renderLoading(panel.webview.cspSource);
    await WeeklyCostPanel.current.refresh();
  }

  /** Test hook: returns the active singleton, if any. */
  static peek(): WeeklyCostPanel | undefined {
    return WeeklyCostPanel.current;
  }

  private async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      const days = readConfiguredDays();
      const report = await this.builder.build(new Date(), days);
      if (this.disposed) {
        return;
      }
      const nonce = makeNonce();
      this.panel.webview.html = renderWeeklyCostHtml(
        report,
        this.panel.webview.cspSource,
        nonce,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.appendLine(`[WeeklyCostPanel] render failed: ${msg}`);
      if (!this.disposed) {
        this.panel.webview.html = WeeklyCostPanel.renderError(
          this.panel.webview.cspSource,
          msg,
        );
      }
    }
  }

  private static renderLoading(cspSource: string): string {
    const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src ${cspSource};`;
    return `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>body{font-family:var(--vscode-editor-font-family,monospace);background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);padding:16px;}</style>
</head><body><p>Loading weekly cost…</p></body></html>`;
  }

  private static renderError(cspSource: string, message: string): string {
    const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src ${cspSource};`;
    const safe = message
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>body{font-family:var(--vscode-editor-font-family,monospace);background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);padding:16px;}.err{color:var(--vscode-errorForeground);}</style>
</head><body><p class="err">Failed to build weekly cost report: ${safe}</p></body></html>`;
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    WeeklyCostPanel.current = undefined;
    for (const d of this.subscriptions) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}
