import { describe, it, expect, vi } from 'vitest';

// Minimal vscode stub so the module can be imported without a VS Code runtime.
vi.mock('vscode', () => ({
  workspace: { getConfiguration: vi.fn() },
  ConfigurationTarget: { Global: 1 },
}));

import { applyCycle, buildQuickPickItems } from '../src/displayModeController';

// applyCycle is a pure function — no vscode runtime required.

describe('applyCycle', () => {
  it('session → weekly', () => expect(applyCycle('session')).toBe('weekly'));
  it('weekly → both', () => expect(applyCycle('weekly')).toBe('both'));
  it('both → session (wraps around)', () => expect(applyCycle('both')).toBe('session'));
  it('unknown value falls back to session (idx=-1 → MODES[0])', () =>
    expect(applyCycle('unknown')).toBe('session'));
  it('empty string falls back to session', () => expect(applyCycle('')).toBe('session'));
});

describe('buildQuickPickItems', () => {
  it('returns three items in order session/weekly/both', () => {
    const items = buildQuickPickItems('session');
    expect(items.map((i) => i.mode)).toEqual(['session', 'weekly', 'both']);
    expect(items.map((i) => i.label)).toEqual(['Session', 'Weekly', 'Both']);
  });

  it('marks only the current item as picked and annotates its detail', () => {
    const items = buildQuickPickItems('weekly');
    const picked = items.filter((i) => i.picked);
    expect(picked).toHaveLength(1);
    expect(picked[0].mode).toBe('weekly');
    expect(picked[0].detail).toBe('● current');
    for (const i of items.filter((i) => i.mode !== 'weekly')) {
      expect(i.picked).toBe(false);
      expect(i.detail).toBeUndefined();
    }
  });

  it('unknown current value results in no picked item', () => {
    const items = buildQuickPickItems('unknown');
    expect(items.every((i) => i.picked === false)).toBe(true);
    expect(items.every((i) => i.detail === undefined)).toBe(true);
  });

  it('every item has a non-empty description', () => {
    for (const i of buildQuickPickItems('both')) {
      expect(i.description && i.description.length).toBeGreaterThan(0);
    }
  });
});
