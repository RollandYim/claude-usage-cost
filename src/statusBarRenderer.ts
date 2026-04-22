import * as vscode from 'vscode';
import { UsageStore } from './usageStore';
import { renderStatusBar, formatCountdown } from './formatUtils';
import {
  STATUS_BAR_PRIORITY,
  CONFIG_SECTION,
  THRESHOLD_WARNING_DEFAULT,
  THRESHOLD_ERROR_DEFAULT,
  COST_DISPLAY_DEFAULT,
} from './config';
import type { CostDisplayMode, DisplayMode, UsageData, UsageWindow } from './types';
import type { CostService } from './cost/costService';
import type { AccountIdentityService } from './cost/accountIdentity';
import { formatTokens, formatUSD, truncateModelName } from './cost/costFormatter';

// ── Pure helpers (also tested in isolation) ───────────────────────────────────

// Returns a copy of `data` where any UsageWindow whose resetsAt is in the past
// has its utilization zeroed out (display-layer expiry auto-reset).
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

// Returns the highest utilization among the windows relevant to the given mode.
function maxUtilization(data: UsageData, mode: DisplayMode): number {
  const s = mode !== 'weekly' ? (data.fiveHour?.utilization ?? 0) : 0;
  const w = mode !== 'session' ? (data.sevenDay?.utilization ?? 0) : 0;
  return Math.max(s, w);
}

/** Clamps `v` to the inclusive range [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ── StatusBarRenderer ─────────────────────────────────────────────────────────

export class StatusBarRenderer implements vscode.Disposable {
  private readonly _item: vscode.StatusBarItem;
  private readonly _disposables: vscode.Disposable[] = [];
  private _mode: DisplayMode;
  private _tickTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * @param store           - Usage data store (required).
   * @param logger          - VS Code output channel for diagnostics.
   * @param costService     - Optional cost service; when omitted the cost segment
   *                          and cost tooltip section are suppressed.
   * @param accountIdentity - Optional account-identity service; when omitted the
   *                          `Account:` line is omitted from the tooltip.
   */
  constructor(
    private readonly store: UsageStore,
    private readonly logger: vscode.OutputChannel,
    private readonly costService?: CostService,
    private readonly accountIdentity?: AccountIdentityService,
  ) {
    this._item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      STATUS_BAR_PRIORITY,
    );
    // Click routes through the click-latch command in extension.ts so we can
    // distinguish single vs double click (single → refresh, double → weekly panel).
    this._item.command = 'claude-usage-cost.statusBarClick';

    this._mode = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<DisplayMode>('displayMode', 'session');

    // Re-render whenever the usage store receives new data.
    this._disposables.push(store.onDidChange(() => this._render()));

    // Re-render whenever remote API health changes (affects the fallback tooltip
    // branch when `store.data` is still null).
    this._disposables.push(store.onDidChangeStatus(() => this._render()));

    // Re-render whenever the cost store is updated.
    if (costService) {
      this._disposables.push(costService.onDidChangeCost(() => this._render()));
    }

    // Re-render whenever the account identity changes (tooltip account line).
    if (accountIdentity) {
      this._disposables.push(accountIdentity.onDidChangeIdentity(() => this._render()));
    }

    // Re-render when relevant configuration changes.
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        const watched = [
          `${CONFIG_SECTION}.displayMode`,
          `${CONFIG_SECTION}.thresholds.warning`,
          `${CONFIG_SECTION}.thresholds.error`,
          `${CONFIG_SECTION}.cost.display`,
        ];
        if (watched.some(key => e.affectsConfiguration(key))) {
          if (e.affectsConfiguration(`${CONFIG_SECTION}.displayMode`)) {
            this._mode = vscode.workspace
              .getConfiguration(CONFIG_SECTION)
              .get<DisplayMode>('displayMode', 'session');
            this.logger.appendLine(`[StatusBarRenderer] displayMode changed to: ${this._mode}`);
          }
          this._render();
        }
      }),
    );

    // 1-second tick: keeps countdown text fresh and triggers expiry-zero without an API hit.
    this._tickTimer = setInterval(() => this._render(), 1000);

    this._render();
    this._item.show();
  }

  /** Called by the refresh command to force an immediate visual update. */
  forceRender(): void {
    this._render();
  }

  private _render(): void {
    const raw = this.store.data;
    const now = new Date();

    // Graceful degradation when the remote usage endpoint is unavailable
    // (e.g. 429 rate-limited, network error, or keychain bootstrap still
    // pending). Without this fallback the status bar would spin forever
    // even though the local cost subsystem already has today's numbers.
    if (!raw) {
      const fallback = this._buildFallbackSegments();
      if (fallback) {
        this._item.text = fallback.text;
        this._item.color = undefined;
        this._item.tooltip = fallback.tooltip;
        return;
      }
      this._item.text = '$(loading~spin) Claude Usage';
      this._item.tooltip = 'Loading usage…';
      this._item.color = undefined;
      return;
    }

    const data = applyExpiry(raw, now);

    let text = renderStatusBar(data, this._mode, now);
    text += this._buildCostSegment();

    this._item.text = text;
    this._item.color = this._resolveForeground(data);
    this._item.tooltip = this._buildTooltip(data, now);
  }

  /**
   * Builds the status-bar text and tooltip used when the remote usage API is
   * unavailable but the local cost subsystem already has today's numbers.
   *
   * Returns `null` when there is nothing useful to show yet (cost disabled,
   * no costService wired, or no local data scanned yet) — the caller then
   * falls back to the classic loading spinner.
   */
  private _buildFallbackSegments(): { text: string; tooltip: vscode.MarkdownString } | null {
    const costMode = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<CostDisplayMode>('cost.display', COST_DISPLAY_DEFAULT);
    if (costMode === 'off' || !this.costService) return null;

    const summary = this.costService.getTodaySummary();
    if (summary.lastUpdated === 0) return null;

    const text = `Claude Usage \u00b7 $${summary.totalUSD.toFixed(2)}`;

    const lines: string[] = [];
    const status = this.store.remoteStatus;
    if (status === 'unauthorized') {
      lines.push('**Remote usage API rejected the current token (401)**');
      lines.push('');
      lines.push(
        'The OAuth token used for polling is invalid or expired. ' +
        'Local cost tracking is unaffected. ' +
        'Passive interception of Claude Code requests remains active.',
      );
    } else if (status === 'rate_limited') {
      lines.push('**Remote usage API is rate-limited (429)**');
      lines.push('');
      lines.push(
        'Polling is temporarily paused. Will retry automatically. ' +
        'Local cost tracking is unaffected.',
      );
    } else {
      lines.push('**Remote usage unavailable**');
      lines.push('');
      lines.push(
        'The Anthropic usage endpoint is temporarily unreachable ' +
        '(offline or still authenticating). ' +
        'Polling will resume automatically. ' +
        'Local cost tracking is unaffected.',
      );
    }
    this._appendCostSectionTo(lines);
    lines.push('');
    lines.push('Click to refresh');
    const md = new vscode.MarkdownString(lines.join('\n\n'));
    md.isTrusted = false;
    return { text, tooltip: md };
  }

  // ── Color threshold helpers ────────────────────────────────────────────────

  /**
   * Reads warning/error thresholds from VS Code configuration.
   *
   * Falls back to defaults when either value is outside [0, 100] or
   * when `warning >= error` (non-sensical range).
   */
  private _getThresholds(): { warning: number; error: number } {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const warning = clamp(
      cfg.get<number>('thresholds.warning', THRESHOLD_WARNING_DEFAULT),
      0,
      100,
    );
    const error = clamp(
      cfg.get<number>('thresholds.error', THRESHOLD_ERROR_DEFAULT),
      0,
      100,
    );
    if (error <= warning) {
      this.logger.appendLine(
        `[StatusBarRenderer] invalid thresholds (warning=${warning} >= error=${error}), ` +
        `falling back to defaults ${THRESHOLD_WARNING_DEFAULT}/${THRESHOLD_ERROR_DEFAULT}`,
      );
      return { warning: THRESHOLD_WARNING_DEFAULT, error: THRESHOLD_ERROR_DEFAULT };
    }
    return { warning, error };
  }

  private _resolveForeground(data: UsageData): vscode.ThemeColor | undefined {
    const pct = maxUtilization(data, this._mode);
    const { warning, error } = this._getThresholds();
    if (pct >= error) {
      return new vscode.ThemeColor('statusBarItem.errorForeground');
    }
    if (pct >= warning) {
      return new vscode.ThemeColor('statusBarItem.warningForeground');
    }
    return undefined;
  }

  // ── Cost segment ──────────────────────────────────────────────────────────

  /**
   * Builds the cost suffix appended to the status bar text.
   *
   * Returns an empty string when `cost.display = 'off'` or `costService` is absent.
   */
  private _buildCostSegment(): string {
    const mode = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<CostDisplayMode>('cost.display', COST_DISPLAY_DEFAULT);
    if (mode === 'off' || !this.costService) return '';
    const { totalUSD } = this.costService.getTodaySummary();
    return ` \u00b7 $${totalUSD.toFixed(2)}`;
  }

  // ── Tooltip ───────────────────────────────────────────────────────────────

  private _buildTooltip(data: UsageData, now: Date): vscode.MarkdownString {
    const lines: string[] = [];

    if (data.fiveHour) {
      const pct = Math.round(data.fiveHour.utilization);
      const cd = formatCountdown(data.fiveHour.resetsAt.getTime(), now);
      lines.push(`**Session:** ${pct}% · resets in ${cd}`);
    }

    if (data.sevenDay) {
      const pct = Math.round(data.sevenDay.utilization);
      const cd = formatCountdown(data.sevenDay.resetsAt.getTime(), now);
      lines.push(`**Weekly:** ${pct}% · resets in ${cd}`);
    }

    if (data.sevenDaySonnet) {
      const pct = Math.round(data.sevenDaySonnet.utilization);
      const cd = formatCountdown(data.sevenDaySonnet.resetsAt.getTime(), now);
      lines.push(`**Weekly (Sonnet):** ${pct}% · resets in ${cd}`);
    }

    if (data.extraUsage?.isEnabled) {
      const used = data.extraUsage.usedCredits ?? 0;
      const limit = data.extraUsage.monthlyLimit ?? '?';
      const pct =
        data.extraUsage.utilization !== null
          ? `${Math.round(data.extraUsage.utilization)}%`
          : '—';
      lines.push(`**Extra Usage:** ${used} / ${limit} credits (${pct})`);
    }

    lines.push('');
    lines.push(`*Last updated: ${new Date(data.fetchedAt).toLocaleTimeString()}*`);

    this._appendCostSectionTo(lines);

    lines.push('');
    lines.push('Click to refresh');

    const md = new vscode.MarkdownString(lines.join('\n\n'));
    md.isTrusted = false;
    return md;
  }

  /**
   * Appends the "Today (local) / per-model / Account" cost block to the
   * given tooltip line buffer. No-op when cost display is off or the cost
   * service is absent. Shared by both the normal tooltip and the fallback
   * (remote-unavailable) tooltip.
   */
  private _appendCostSectionTo(lines: string[]): void {
    const costMode = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<CostDisplayMode>('cost.display', COST_DISPLAY_DEFAULT);
    if (costMode === 'off' || !this.costService) return;

    lines.push('');
    lines.push('---');

    const s = this.costService.getTodaySummary();
    lines.push(`**Today (local):** ${formatUSD(s.totalUSD, 4)}`);

    const sorted = Object.entries(s.byModel).sort((a, b) => b[1].cost - a[1].cost);
    const top = sorted.slice(0, 5);
    for (const [model, detail] of top) {
      lines.push(
        `- ${truncateModelName(model)}: ${formatTokens(detail.tokens)} tokens, ${formatUSD(detail.cost, 4)}`,
      );
    }
    if (sorted.length > 5) {
      lines.push(`- (+${sorted.length - 5} more)`);
    }

    if (s.lastUpdated > 0) {
      const t = new Date(s.lastUpdated);
      lines.push(`_Last updated: ${t.toLocaleTimeString()}_`);
    }

    if (this.accountIdentity) {
      const id = this.accountIdentity.getCurrentIdentity();
      lines.push(`**Account:** ${id.emailAddress ?? 'unknown'}`);
    }
  }

  dispose(): void {
    if (this._tickTimer !== undefined) {
      clearInterval(this._tickTimer);
      this._tickTimer = undefined;
    }
    this._item.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
  }
}
