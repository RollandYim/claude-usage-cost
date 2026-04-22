import * as vscode from 'vscode';
import { clampUtilization, parseResetsAt } from './formatUtils';
import { GLOBAL_STATE_KEY } from './config';
import type { UsageData, UsageWindow, RemoteUsageStatus } from './types';

interface RawWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

interface RawApiResponse {
  five_hour?: RawWindow;
  seven_day?: RawWindow;
  seven_day_sonnet?: RawWindow;
  extra_usage?: {
    is_enabled?: unknown;
    monthly_limit?: unknown;
    used_credits?: unknown;
    utilization?: unknown;
  };
}

function parseWindow(
  raw: RawWindow | undefined,
  logger?: vscode.OutputChannel,
): UsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const rawUtil = typeof raw.utilization === 'number' ? raw.utilization : 0;
  if (logger && typeof raw.utilization === 'number' && (raw.utilization < 0 || raw.utilization > 100)) {
    logger.appendLine(`[UsageStore] out-of-range utilization ${raw.utilization}, clamped to [0, 100]`);
  }
  const utilization = clampUtilization(rawUtil);
  const resetsAt =
    typeof raw.resets_at === 'string' || typeof raw.resets_at === 'number'
      ? parseResetsAt(raw.resets_at as string | number)
      : new Date(0);
  return { utilization, resetsAt };
}

function reviveUsageData(raw: unknown): UsageData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const reviveWin = (w: unknown): UsageWindow | null => {
    if (!w || typeof w !== 'object') return null;
    const obj = w as Record<string, unknown>;
    return {
      utilization: typeof obj.utilization === 'number' ? obj.utilization : 0,
      resetsAt: new Date(typeof obj.resetsAt === 'string' ? obj.resetsAt : 0),
    };
  };
  return {
    fiveHour: reviveWin(r.fiveHour),
    sevenDay: reviveWin(r.sevenDay),
    sevenDaySonnet: reviveWin(r.sevenDaySonnet),
    extraUsage: null,
    fetchedAt: typeof r.fetchedAt === 'number' ? r.fetchedAt : 0,
  };
}

export class UsageStore {
  private _data: UsageData | null = null;
  private readonly _onDidChange = new vscode.EventEmitter<UsageData>();
  readonly onDidChange: vscode.Event<UsageData> = this._onDidChange.event;
  private _remoteStatus: RemoteUsageStatus = 'unknown';
  private readonly _onDidChangeStatus = new vscode.EventEmitter<RemoteUsageStatus>();
  readonly onDidChangeStatus: vscode.Event<RemoteUsageStatus> = this._onDidChangeStatus.event;

  constructor(
    private readonly globalState: vscode.Memento,
    private readonly logger: vscode.OutputChannel,
  ) {}

  get data(): UsageData | null {
    return this._data;
  }

  get remoteStatus(): RemoteUsageStatus {
    return this._remoteStatus;
  }

  // Parse raw API JSON, clamp utilization, update in-memory state and persist.
  update(raw: unknown): void {
    const r = raw as RawApiResponse;
    const newData: UsageData = {
      fiveHour: parseWindow(r?.five_hour, this.logger),
      sevenDay: parseWindow(r?.seven_day, this.logger),
      sevenDaySonnet: parseWindow(r?.seven_day_sonnet, this.logger),
      extraUsage: r?.extra_usage
        ? {
            isEnabled: Boolean(r.extra_usage.is_enabled),
            monthlyLimit:
              typeof r.extra_usage.monthly_limit === 'number'
                ? r.extra_usage.monthly_limit
                : null,
            usedCredits:
              typeof r.extra_usage.used_credits === 'number'
                ? r.extra_usage.used_credits
                : null,
            utilization:
              typeof r.extra_usage.utilization === 'number'
                ? clampUtilization(r.extra_usage.utilization)
                : null,
          }
        : null,
      fetchedAt: Date.now(),
    };
    this._data = newData;
    this._onDidChange.fire(newData);
    this.persist();
    // Intentional order: fire data event first (subscribers with data !== null
    // don't read remoteStatus), then broadcast status. StatusBarRenderer only
    // reads remoteStatus when data === null (fallback path), so the brief
    // window where onDidChange sees stale status is harmless.
    this.setRemoteStatus('ok');
  }

  /**
   * Sets the remote usage API status and fires `onDidChangeStatus` if changed.
   * Called by {@link PollingService} on 401/429/5xx outcomes, by the keychain
   * bootstrap on auth failures, and implicitly by {@link update} on success.
   * Value is NOT persisted across restarts.
   */
  setRemoteStatus(status: RemoteUsageStatus): void {
    if (this._remoteStatus === status) return;
    this._remoteStatus = status;
    this._onDidChangeStatus.fire(status);
  }

  restore(): void {
    try {
      const stored = this.globalState.get<unknown>(GLOBAL_STATE_KEY);
      const revived = reviveUsageData(stored);
      if (revived) {
        this._data = revived;
        this._onDidChange.fire(revived);
        this.logger.appendLine('Usage data restored from globalState');
      }
    } catch (err) {
      this.logger.appendLine(`Failed to restore usage data: ${err}`);
    }
  }

  persist(): void {
    if (!this._data) return;
    // Serialize Dates as ISO strings for JSON round-trip.
    const serializable = {
      fiveHour: this._data.fiveHour
        ? { utilization: this._data.fiveHour.utilization, resetsAt: this._data.fiveHour.resetsAt.toISOString() }
        : null,
      sevenDay: this._data.sevenDay
        ? { utilization: this._data.sevenDay.utilization, resetsAt: this._data.sevenDay.resetsAt.toISOString() }
        : null,
      sevenDaySonnet: this._data.sevenDaySonnet
        ? { utilization: this._data.sevenDaySonnet.utilization, resetsAt: this._data.sevenDaySonnet.resetsAt.toISOString() }
        : null,
      extraUsage: this._data.extraUsage,
      fetchedAt: this._data.fetchedAt,
    };
    this.globalState.update(GLOBAL_STATE_KEY, serializable).then(
      () => {},
      (err: unknown) => this.logger.appendLine(`Failed to persist usage data: ${err}`),
    );
  }

  dispose(): void {
    this._onDidChange.dispose();
    this._onDidChangeStatus.dispose();
  }
}
