import * as fs from 'fs';
import * as vscode from 'vscode';
import { FALLBACK_FILE_PATH } from './config';
import { clampUtilization, parseResetsAt } from './formatUtils';
import type { UsageStore } from './usageStore';

interface FallbackFileData {
  five_hour?: { utilization?: unknown; resets_at?: unknown };
  seven_day?: { utilization?: unknown; resets_at?: unknown };
  seven_day_sonnet?: { utilization?: unknown; resets_at?: unknown };
}

export class FallbackFileWatcher implements vscode.Disposable {
  private _watcher: vscode.FileSystemWatcher;

  constructor(
    private readonly store: UsageStore,
    private readonly logger: vscode.OutputChannel,
  ) {
    // vscode.GlobPattern accepts a plain string absolute path (treated as glob)
    this._watcher = vscode.workspace.createFileSystemWatcher(FALLBACK_FILE_PATH);
    this._watcher.onDidChange(() => this._readAndUpdate());
    this._watcher.onDidCreate(() => this._readAndUpdate());

    // Attempt initial read if the file already exists at activation time
    this._readAndUpdate();
  }

  private _readAndUpdate(): void {
    try {
      if (!fs.existsSync(FALLBACK_FILE_PATH)) return;
      const raw = fs.readFileSync(FALLBACK_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as FallbackFileData;

      const parseWindow = (section: FallbackFileData['five_hour']) => {
        if (!section) return null;
        const rawUtil = typeof section.utilization === 'number' ? section.utilization : 0;
        const clamped = clampUtilization(rawUtil);
        if (rawUtil !== clamped) {
          this.logger.appendLine(
            `Fallback file: utilization out of range (${rawUtil}) — clamped to ${clamped}`,
          );
        }
        const resetsAt =
          section.resets_at !== undefined &&
          (typeof section.resets_at === 'string' || typeof section.resets_at === 'number')
            ? parseResetsAt(section.resets_at)
            : new Date(0);
        return { utilization: clamped, resetsAt };
      };

      // Wrap as a minimal API response shape so UsageStore.update() can handle it
      const apiShape = {
        five_hour: parseWindow(parsed.five_hour)
          ? {
              utilization: parseWindow(parsed.five_hour)!.utilization,
              resets_at: parseWindow(parsed.five_hour)!.resetsAt.toISOString(),
            }
          : undefined,
        seven_day: parseWindow(parsed.seven_day)
          ? {
              utilization: parseWindow(parsed.seven_day)!.utilization,
              resets_at: parseWindow(parsed.seven_day)!.resetsAt.toISOString(),
            }
          : undefined,
        seven_day_sonnet: parseWindow(parsed.seven_day_sonnet)
          ? {
              utilization: parseWindow(parsed.seven_day_sonnet)!.utilization,
              resets_at: parseWindow(parsed.seven_day_sonnet)!.resetsAt.toISOString(),
            }
          : undefined,
      };

      this.store.update(apiShape);
      this.logger.appendLine('Fallback file loaded successfully');
    } catch (err) {
      this.logger.appendLine(`Fallback file parse error (ignored): ${err}`);
    }
  }

  dispose(): void {
    this._watcher.dispose();
  }
}
