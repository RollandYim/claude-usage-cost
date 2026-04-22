import * as vscode from 'vscode';
import { CONFIG_SECTION } from './config';
import type { DisplayMode } from './types';

const MODES: DisplayMode[] = ['session', 'weekly', 'both'];

/**
 * Extracts the cycle logic as a pure function so it can be unit-tested
 * without a VS Code runtime.
 *
 * Returns the next mode in the cycle: session → weekly → both → session.
 * Falls back to 'weekly' (the first step) for any unrecognised value.
 */
export function applyCycle(current: DisplayMode | string): DisplayMode {
  const idx = MODES.indexOf(current as DisplayMode);
  return MODES[(idx === -1 ? 0 : idx + 1) % MODES.length];
}

/**
 * Cycles `claudeUsageCost.displayMode` through session → weekly → both →
 * session and persists the new value to global VS Code settings.
 *
 * The StatusBarRenderer reacts automatically via its onDidChangeConfiguration
 * subscription — no direct renderer call is needed here.
 */
export async function switchDisplayMode(logger: vscode.OutputChannel): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const current = config.get<DisplayMode>('displayMode', 'session');
  const next = applyCycle(current);
  await config.update('displayMode', next, vscode.ConfigurationTarget.Global);
  logger.appendLine(`[DisplayMode] Cycled ${current} → ${next}`);
}

export interface QuickPickItemLite {
  label: string;
  description?: string;
  detail?: string;
  mode: DisplayMode;
  picked?: boolean;
}

/**
 * Builds the QuickPick item list, pure for unit testing.
 * The item matching `current` gets `picked: true` so VS Code renders the check mark.
 */
export function buildQuickPickItems(current: DisplayMode | string): QuickPickItemLite[] {
  const meta: Record<DisplayMode, { label: string; description: string }> = {
    session: { label: 'Session', description: 'Show 5-hour window only' },
    weekly: { label: 'Weekly', description: 'Show 7-day window only' },
    both: { label: 'Both', description: 'Show both session and weekly' },
  };
  return MODES.map((m) => ({
    label: meta[m].label,
    description: meta[m].description,
    detail: m === current ? '● current' : undefined,
    mode: m,
    picked: m === current,
  }));
}

/**
 * Presents a QuickPick so the user picks a specific Display Mode directly
 * (instead of cycling through them). The selected value is persisted to global
 * settings; cancelling the QuickPick is a no-op.
 */
export async function setDisplayMode(logger: vscode.OutputChannel): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const current = config.get<DisplayMode>('displayMode', 'session');
  const items = buildQuickPickItems(current);
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Claude Usage: Set Display Mode',
    placeHolder: `Current: ${current}. Pick a mode.`,
    matchOnDescription: true,
  });
  if (!picked) {
    logger.appendLine('[DisplayMode] Set cancelled');
    return;
  }
  if (picked.mode === current) {
    logger.appendLine(`[DisplayMode] Set unchanged (${current})`);
    return;
  }
  await config.update('displayMode', picked.mode, vscode.ConfigurationTarget.Global);
  logger.appendLine(`[DisplayMode] Set ${current} → ${picked.mode}`);
}
