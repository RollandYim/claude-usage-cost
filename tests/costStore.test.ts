/**
 * Unit tests for `src/cost/costStore.ts`.
 *
 * `vscode` is mocked below so that the module can be imported in a plain
 * Node/Vitest environment (no real VS Code runtime required).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ── vscode mock (must be hoisted before the module import) ────────────────────
vi.mock('vscode', () => ({
  EventEmitter: class {
    event = (_listener: unknown) => ({ dispose: () => {} });
    fire(_data: unknown) {}
    dispose() {}
  },
}));

import { CostStore } from '../src/cost/costStore';
import type { CostStoreData } from '../src/types';

// ─── InMemoryMemento ──────────────────────────────────────────────────────────

/**
 * Simple in-memory implementation of the `vscode.Memento` interface used
 * for straightforward read/write tests.
 */
class InMemoryMemento {
  private readonly store = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.store.has(key) ? this.store.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  keys(): readonly string[] {
    return Array.from(this.store.keys());
  }
}

/**
 * A controlled memento that returns pre-configured values on successive `get()`
 * calls, simulating concurrent writes from other VS Code windows.
 *
 * Once the sequence is exhausted, subsequent `get()` calls return the most
 * recently written value (or `defaultValue` if nothing has been written yet).
 */
class ConflictSimulatingMemento {
  private callIndex = 0;
  lastWritten: CostStoreData | null = null;

  constructor(private readonly sequence: CostStoreData[]) {}

  get<T>(_key: string, defaultValue: T): T {
    const value = this.sequence[this.callIndex];
    if (value !== undefined) {
      this.callIndex++;
      return value as unknown as T;
    }
    return (this.lastWritten ?? defaultValue) as T;
  }

  async update(_key: string, value: unknown): Promise<void> {
    this.lastWritten = value as CostStoreData;
  }

  keys(): readonly string[] {
    return [];
  }
}

// ─── Shared mock logger ───────────────────────────────────────────────────────

const mockLogger = {
  appendLine: vi.fn(),
  append: (_msg: string) => {},
  show: () => {},
  hide: () => {},
  dispose: () => {},
  clear: () => {},
  replace: (_value: string) => {},
  name: 'test',
} as unknown as import('vscode').OutputChannel;

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeStoreData(version: number): CostStoreData {
  return { version, mtime: 0, entries: {}, processedIds: {}, fileCursors: {} };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CostStore', () => {
  let memento: InMemoryMemento;
  let store: CostStore;

  beforeEach(() => {
    vi.clearAllMocks();
    memento = new InMemoryMemento();
    store = new CostStore(memento as unknown as import('vscode').Memento, mockLogger);
  });

  // ── load() ─────────────────────────────────────────────────────────────────

  describe('load()', () => {
    it('returns the default empty object when nothing is stored', () => {
      const data = store.load();
      expect(data.version).toBe(0);
      expect(data.mtime).toBe(0);
      expect(data.entries).toEqual({});
      expect(data.processedIds).toEqual({});
      expect(data.fileCursors).toEqual({});
    });

    it('returns stored data after a successful update', async () => {
      await store.update((c) => ({
        ...c,
        processedIds: { 'msg-a:req-a': true },
      }));
      const data = store.load();
      expect(data.processedIds['msg-a:req-a']).toBe(true);
    });
  });

  // ── update() ───────────────────────────────────────────────────────────────

  describe('update()', () => {
    it('increments version by 1 on a simple update', async () => {
      const ok = await store.update((c) => c);
      expect(ok).toBe(true);
      expect(store.load().version).toBe(1);
    });

    it('increments version on each successive update', async () => {
      await store.update((c) => c);
      await store.update((c) => c);
      expect(store.load().version).toBe(2);
    });

    it('persists the mutated data', async () => {
      await store.update((c) => ({
        ...c,
        processedIds: { 'x:y': true, 'a:b': true },
      }));
      const data = store.load();
      expect(data.processedIds['x:y']).toBe(true);
      expect(data.processedIds['a:b']).toBe(true);
    });

    it('sets mtime to a recent timestamp', async () => {
      const before = Date.now();
      await store.update((c) => c);
      const after = Date.now();
      const mtime = store.load().mtime;
      expect(mtime).toBeGreaterThanOrEqual(before);
      expect(mtime).toBeLessThanOrEqual(after);
    });

    it('detects an optimistic lock conflict and retries successfully', async () => {
      // Sequence of `get()` return values simulating a mid-flight write by
      // another VS Code window (the second call returns version=6 instead of 5).
      const conflictMemento = new ConflictSimulatingMemento([
        makeStoreData(5), // attempt 1 – initial load
        makeStoreData(6), // attempt 1 – pre-write check → conflict (another window wrote)
        makeStoreData(6), // attempt 2 (retry) – initial load with fresh data
        makeStoreData(6), // attempt 2 – pre-write check → no conflict
      ]);
      const conflictStore = new CostStore(
        conflictMemento as unknown as import('vscode').Memento,
        mockLogger,
      );

      const ok = await conflictStore.update((c) => ({ ...c, processedIds: { 'x:y': true } }));

      expect(ok).toBe(true);
      // Retry wrote version 6 + 1 = 7
      expect(conflictMemento.lastWritten?.version).toBe(7);
    });

    it('gives up and returns false after two consecutive conflicts', async () => {
      const conflictMemento = new ConflictSimulatingMemento([
        makeStoreData(5), // attempt 1 – initial load
        makeStoreData(6), // attempt 1 – pre-write check → conflict
        makeStoreData(6), // attempt 2 – initial load
        makeStoreData(7), // attempt 2 – pre-write check → conflict again
      ]);
      const conflictStore = new CostStore(
        conflictMemento as unknown as import('vscode').Memento,
        mockLogger,
      );

      const ok = await conflictStore.update((c) => c);

      expect(ok).toBe(false);
      expect(mockLogger.appendLine).toHaveBeenCalledWith(
        '[CostStore] optimistic lock conflict, giving up',
      );
    });
  });

  // ── resetForAccount() ──────────────────────────────────────────────────────

  describe('resetForAccount()', () => {
    it("removes today's entry for the given account but preserves historical entries", async () => {
      const today = new Date().toLocaleDateString('sv-SE');
      const historical = '2026-01-01';

      await store.update((c) => ({
        ...c,
        entries: {
          [`new-uuid:${today}`]: {
            dateLocal: today,
            accountUuid: 'new-uuid',
            totalCostUSD: 5.0,
            byModel: {},
            updatedAt: 0,
          },
          [`new-uuid:${historical}`]: {
            dateLocal: historical,
            accountUuid: 'new-uuid',
            totalCostUSD: 10.0,
            byModel: {},
            updatedAt: 0,
          },
        },
        processedIds: { 'msg-1:req-1': true },
      }));

      await store.resetForAccount('new-uuid');

      const data = store.load();
      expect(data.entries[`new-uuid:${today}`]).toBeUndefined();
      expect(data.entries[`new-uuid:${historical}`]).toBeDefined();
    });

    it('does NOT clear processedIds (to avoid cross-account dedup false positives)', async () => {
      const today = new Date().toLocaleDateString('sv-SE');

      await store.update((c) => ({
        ...c,
        entries: {
          [`uuid-x:${today}`]: {
            dateLocal: today,
            accountUuid: 'uuid-x',
            totalCostUSD: 1.0,
            byModel: {},
            updatedAt: 0,
          },
        },
        processedIds: { 'kept-msg:kept-req': true },
      }));

      await store.resetForAccount('uuid-x');

      const data = store.load();
      expect(data.processedIds['kept-msg:kept-req']).toBe(true);
    });
  });

  // ── getFileCursors() ───────────────────────────────────────────────────────

  describe('getFileCursors()', () => {
    it('returns an empty object when nothing is stored', () => {
      expect(store.getFileCursors()).toEqual({});
    });

    it('returns persisted cursors after an update', async () => {
      await store.update((c) => ({
        ...c,
        fileCursors: { '/some/file.jsonl': { inode: 42, size: 100, cursor: 100 } },
      }));
      expect(store.getFileCursors()['/some/file.jsonl']).toEqual({
        inode: 42,
        size: 100,
        cursor: 100,
      });
    });
  });
});
