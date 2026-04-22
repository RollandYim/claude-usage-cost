import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Must be declared before importing the module under test so that
// UsageLogReader resolves the mocked LOG_ROOT_PATHS() at call time. The
// factory closes over a mutable holder that beforeEach rewrites.
const rootHolder: { roots: string[] } = { roots: [] };
vi.mock('../src/config', async () => {
  const actual = await vi.importActual<typeof import('../src/config')>('../src/config');
  return {
    ...actual,
    LOG_ROOT_PATHS: () => rootHolder.roots,
  };
});

import { UsageLogReader } from '../src/cost/usageLogReader';

const mockLogger = {
  appendLine: (_msg: string) => { /* noop */ },
  append: (_msg: string) => { /* noop */ },
  show: () => { /* noop */ },
  hide: () => { /* noop */ },
  dispose: () => { /* noop */ },
  clear: () => { /* noop */ },
  replace: (_value: string) => { /* noop */ },
  name: 'test',
} as unknown as import('vscode').OutputChannel;

let tmpRoot: string;

function buildLine(overrides: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    type: 'assistant',
    message: {
      id: 'msg_01',
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        service_tier: 'standard',
      },
    },
    requestId: 'req_01',
    timestamp: '2026-04-21T08:00:00.000Z',
  };
  return JSON.stringify({ ...base, ...overrides });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-scan-range-'));
  const projects = path.join(tmpRoot, 'projects', 'proj-a');
  fs.mkdirSync(projects, { recursive: true });
  rootHolder.roots = [path.join(tmpRoot, 'projects')];
});

afterEach(() => {
  rootHolder.roots = [];
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeJsonl(filename: string, lines: string[]): string {
  const file = path.join(tmpRoot, 'projects', 'proj-a', filename);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe('UsageLogReader.scanDateRange', () => {
  it('returns only records whose local date falls within [fromLocalDate, toLocalDate]', async () => {
    const dates = [
      '2026-04-12T10:00:00.000Z', // out of window (before)
      '2026-04-15T10:00:00.000Z', // start of window
      '2026-04-18T10:00:00.000Z', // inside window
      '2026-04-21T10:00:00.000Z', // end of window
      '2026-04-22T10:00:00.000Z', // out of window (after)
    ];
    const lines = dates.map((ts, i) =>
      buildLine({
        message: {
          id: `msg_${i}`,
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 10, output_tokens: 5, service_tier: 'standard' },
        },
        requestId: `req_${i}`,
        timestamp: ts,
      }),
    );
    writeJsonl('a.jsonl', lines);

    const reader = new UsageLogReader(mockLogger, () => ({}));
    const result = await reader.scanDateRange('2026-04-15', '2026-04-21');

    expect(result.records).toHaveLength(3);
    const ids = result.records.map((r) => r.messageId).sort();
    expect(ids).toEqual(['msg_1', 'msg_2', 'msg_3']);
  });

  it('never produces updatedCursors (leaves incremental scan state untouched)', async () => {
    writeJsonl('a.jsonl', [
      buildLine({
        message: {
          id: 'msg_A',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1, output_tokens: 1, service_tier: 'standard' },
        },
        requestId: 'req_A',
        timestamp: '2026-04-20T10:00:00.000Z',
      }),
    ]);
    const reader = new UsageLogReader(mockLogger, () => ({}));
    const result = await reader.scanDateRange('2026-04-15', '2026-04-21');
    expect(result.updatedCursors).toEqual({});
  });

  it('dedupes records with identical messageId:requestId across files', async () => {
    const duplicated = buildLine({
      message: {
        id: 'dup_msg',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10, output_tokens: 10, service_tier: 'standard' },
      },
      requestId: 'dup_req',
      timestamp: '2026-04-20T10:00:00.000Z',
    });
    const unique = buildLine({
      message: {
        id: 'uniq_msg',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 1, output_tokens: 1, service_tier: 'standard' },
      },
      requestId: 'uniq_req',
      timestamp: '2026-04-20T10:00:00.000Z',
    });
    writeJsonl('a.jsonl', [duplicated, unique]);
    writeJsonl('b.jsonl', [duplicated]);

    const reader = new UsageLogReader(mockLogger, () => ({}));
    const result = await reader.scanDateRange('2026-04-15', '2026-04-21');

    expect(result.records).toHaveLength(2);
    const ids = result.records.map((r) => r.messageId).sort();
    expect(ids).toEqual(['dup_msg', 'uniq_msg']);
  });

  it('reads from offset 0 regardless of cursors (does not honor fileCursors)', async () => {
    const file = writeJsonl('a.jsonl', [
      buildLine({
        message: {
          id: 'early',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1, output_tokens: 1, service_tier: 'standard' },
        },
        requestId: 'req_early',
        timestamp: '2026-04-18T10:00:00.000Z',
      }),
      buildLine({
        message: {
          id: 'late',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 2, output_tokens: 2, service_tier: 'standard' },
        },
        requestId: 'req_late',
        timestamp: '2026-04-20T10:00:00.000Z',
      }),
    ]);
    // Pretend the incremental cursor has already consumed the whole file.
    const stat = fs.statSync(file);
    const reader = new UsageLogReader(mockLogger, () => ({
      [file]: { size: stat.size, cursor: stat.size, inode: Number(stat.ino) },
    }));

    const result = await reader.scanDateRange('2026-04-15', '2026-04-21');
    const ids = result.records.map((r) => r.messageId).sort();
    expect(ids).toEqual(['early', 'late']);
  });
});
