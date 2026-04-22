import { describe, it, expect, vi } from 'vitest';
import {
  WeeklyCostReportBuilder,
  lastSevenLocalDates,
  lastNLocalDates,
  shortenModelName,
} from '../src/costPanel/weeklyCostReportBuilder';
import type { TokenUsageRecord, CostStoreData } from '../src/types';
import type { AccountIdentityService } from '../src/cost/accountIdentity';
import type { UsageLogReader, ScanResult } from '../src/cost/usageLogReader';
import type { PricingTable } from '../src/cost/pricingTable';
import type { CostStore } from '../src/cost/costStore';

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

function makeIdentity(
  accountUuid = 'acc-1',
  emailAddress: string | null = 'user@example.com',
): AccountIdentityService {
  return {
    getCurrentIdentity: () => ({
      accountUuid,
      emailAddress,
      organizationUuid: null,
      source: 'primary' as const,
    }),
  } as unknown as AccountIdentityService;
}

function makeReader(
  scanDateRange: (from: string, to: string) => Promise<ScanResult>,
): UsageLogReader {
  return {
    scanDateRange,
  } as unknown as UsageLogReader;
}

function makePricing(costPerRecord = 0.001): PricingTable {
  return {
    calculateCost: (_r: TokenUsageRecord) => costPerRecord,
  } as unknown as PricingTable;
}

function makeStore(data: CostStoreData): CostStore {
  return {
    load: () => data,
  } as unknown as CostStore;
}

function buildRecord(overrides: Partial<TokenUsageRecord> = {}): TokenUsageRecord {
  return {
    messageId: overrides.messageId ?? `m-${Math.random()}`,
    requestId: overrides.requestId ?? `r-${Math.random()}`,
    timestamp: overrides.timestamp ?? '2026-04-21T08:00:00Z',
    model: overrides.model ?? 'claude-sonnet-4-6',
    serviceTier: overrides.serviceTier ?? 'standard',
    inputTokens: overrides.inputTokens ?? 100,
    outputTokens: overrides.outputTokens ?? 50,
    cacheCreation5m: overrides.cacheCreation5m ?? 0,
    cacheCreation1h: overrides.cacheCreation1h ?? 0,
    cacheRead: overrides.cacheRead ?? 0,
    ...(overrides.costUSD !== undefined ? { costUSD: overrides.costUSD } : {}),
  };
}

describe('shortenModelName', () => {
  it('collapses `claude-<family>-N-M` into `<family>-N.M`', () => {
    expect(shortenModelName('claude-opus-4-7')).toBe('opus-4.7');
    expect(shortenModelName('claude-sonnet-4-6')).toBe('sonnet-4.6');
    expect(shortenModelName('claude-haiku-4-5')).toBe('haiku-4.5');
  });

  it('strips trailing date suffix', () => {
    expect(shortenModelName('claude-sonnet-4-5-20250929')).toBe('sonnet-4.5');
    expect(shortenModelName('claude-opus-4-7-20260101')).toBe('opus-4.7');
  });

  it('returns unknown models unchanged (lightly trimmed)', () => {
    expect(shortenModelName('opus')).toBe('opus');
    expect(shortenModelName('sonnet')).toBe('sonnet');
    expect(shortenModelName('gpt-5')).toBe('gpt-5');
    expect(shortenModelName('')).toBe('');
  });
});

describe('lastSevenLocalDates / lastNLocalDates', () => {
  it('lastSevenLocalDates returns 7 entries ending at the given local date', () => {
    const dates = lastSevenLocalDates(new Date(2026, 3, 21, 12, 0, 0));
    expect(dates).toEqual([
      '2026-04-15',
      '2026-04-16',
      '2026-04-17',
      '2026-04-18',
      '2026-04-19',
      '2026-04-20',
      '2026-04-21',
    ]);
  });

  it('lastSevenLocalDates crosses month boundaries correctly', () => {
    const dates = lastSevenLocalDates(new Date(2026, 4, 2, 12, 0, 0)); // 2026-05-02
    expect(dates[0]).toBe('2026-04-26');
    expect(dates[6]).toBe('2026-05-02');
  });

  it('lastNLocalDates returns N entries ending at the given local date', () => {
    const d = lastNLocalDates(3, new Date(2026, 3, 21, 12, 0, 0));
    expect(d).toEqual(['2026-04-19', '2026-04-20', '2026-04-21']);
  });

  it('lastNLocalDates clamps non-positive N to 1', () => {
    expect(lastNLocalDates(0, new Date(2026, 3, 21))).toEqual(['2026-04-21']);
    expect(lastNLocalDates(-5, new Date(2026, 3, 21))).toEqual(['2026-04-21']);
  });
});

describe('WeeklyCostReportBuilder.build — range mode (default 7 days)', () => {
  it('buckets records by local date and fills all 7 rows, newest first', async () => {
    const records: TokenUsageRecord[] = [
      buildRecord({
        messageId: 'm1',
        requestId: 'r1',
        timestamp: '2026-04-15T12:00:00Z',
        inputTokens: 100,
        outputTokens: 50,
        cacheCreation5m: 5,
        cacheCreation1h: 5,
        cacheRead: 20,
      }),
      buildRecord({
        messageId: 'm2',
        requestId: 'r2',
        timestamp: '2026-04-21T08:00:00Z',
        inputTokens: 200,
        outputTokens: 70,
        cacheCreation5m: 10,
        cacheCreation1h: 0,
        cacheRead: 0,
      }),
    ];
    const reader = makeReader(async () => ({
      records,
      updatedCursors: {},
      skippedFiles: [],
    }));
    const builder = new WeeklyCostReportBuilder(
      makeIdentity(),
      reader,
      makePricing(0.002),
      makeStore({ version: 0, mtime: 0, entries: {}, processedIds: {}, fileCursors: {} }),
      mockLogger,
    );

    const report = await builder.build(new Date(2026, 3, 21, 15, 0, 0));

    expect(report.mode).toBe('range');
    expect(report.rangeLabel).toBe('Last 7 days');
    expect(report.groups).toHaveLength(1);
    const g = report.groups[0];
    expect(g.label).toBe('Last 7 days');
    expect(g.rows).toHaveLength(7);
    // Rows ordered newest-first.
    expect(g.rows.map((r) => r.dateLocal)).toEqual([
      '2026-04-21',
      '2026-04-20',
      '2026-04-19',
      '2026-04-18',
      '2026-04-17',
      '2026-04-16',
      '2026-04-15',
    ]);
    expect(report.scanFailed).toBe(false);
    expect(report.accountUuid).toBe('acc-1');
    expect(report.accountEmail).toBe('user@example.com');

    const d21 = g.rows[0];
    expect(d21.inputTokens).toBe(200);
    expect(d21.outputTokens).toBe(70);
    expect(d21.cacheCreationTokens).toBe(10);
    expect(d21.cacheReadTokens).toBe(0);
    expect(d21.totalTokens).toBe(280);
    expect(d21.costUSD).toBeCloseTo(0.002, 6);

    // Empty bucket in the middle.
    const d17 = g.rows[4];
    expect(d17.dateLocal).toBe('2026-04-17');
    expect(d17.inputTokens).toBe(0);
    expect(d17.totalTokens).toBe(0);
    expect(d17.costUSD).toBe(0);

    const d15 = g.rows[6];
    expect(d15.inputTokens).toBe(100);
    expect(d15.outputTokens).toBe(50);
    expect(d15.cacheCreationTokens).toBe(10);
    expect(d15.cacheReadTokens).toBe(20);
    expect(d15.totalTokens).toBe(180);
    expect(d15.costUSD).toBeCloseTo(0.002, 6);

    expect(g.totals.inputTokens).toBe(300);
    expect(g.totals.outputTokens).toBe(120);
    expect(g.totals.cacheCreationTokens).toBe(20);
    expect(g.totals.cacheReadTokens).toBe(20);
    expect(g.totals.totalTokens).toBe(460);
    expect(g.totals.costUSD).toBeCloseTo(0.004, 6);

    expect(report.grandTotals.costUSD).toBeCloseTo(0.004, 6);
    expect(report.grandTotals.totalTokens).toBe(460);
  });

  it('groups per-day records by model, with byModel sorted by cost descending', async () => {
    const records: TokenUsageRecord[] = [
      buildRecord({
        messageId: 'm1',
        requestId: 'r1',
        timestamp: '2026-04-21T08:00:00Z',
        model: 'claude-sonnet-4-6',
        inputTokens: 100,
        outputTokens: 100,
      }),
      buildRecord({
        messageId: 'm2',
        requestId: 'r2',
        timestamp: '2026-04-21T09:00:00Z',
        model: 'claude-sonnet-4-6',
        inputTokens: 50,
        outputTokens: 50,
      }),
      buildRecord({
        messageId: 'm3',
        requestId: 'r3',
        timestamp: '2026-04-21T10:00:00Z',
        model: 'claude-opus-4-7',
        inputTokens: 10,
        outputTokens: 10,
      }),
    ];
    const reader = makeReader(async () => ({
      records,
      updatedCursors: {},
      skippedFiles: [],
    }));
    // Opus cost > sonnet cost so the model row for opus should come first
    // even though sonnet has far more tokens.
    const pricing = {
      calculateCost: (r: TokenUsageRecord) =>
        r.model === 'claude-opus-4-7' ? 5 : 0.1,
    } as unknown as PricingTable;
    const builder = new WeeklyCostReportBuilder(
      makeIdentity(),
      reader,
      pricing,
      makeStore({ version: 0, mtime: 0, entries: {}, processedIds: {}, fileCursors: {} }),
      mockLogger,
    );
    const report = await builder.build(new Date(2026, 3, 21, 15, 0, 0));
    const d21 = report.groups[0].rows[0];
    expect(d21.dateLocal).toBe('2026-04-21');
    // Two models on the same day.
    expect(d21.byModel).toHaveLength(2);
    // Sorted by cost desc: opus (1×$5) first, then sonnet (2×$0.1 = $0.2).
    expect(d21.byModel[0].model).toBe('claude-opus-4-7');
    expect(d21.byModel[0].shortLabel).toBe('opus-4.7');
    expect(d21.byModel[0].costUSD).toBeCloseTo(5, 6);
    expect(d21.byModel[0].totalTokens).toBe(20);
    expect(d21.byModel[0].tokensBreakdownKnown).toBe(true);
    expect(d21.byModel[1].model).toBe('claude-sonnet-4-6');
    expect(d21.byModel[1].shortLabel).toBe('sonnet-4.6');
    expect(d21.byModel[1].costUSD).toBeCloseTo(0.2, 6);
    // Sonnet merges m1+m2 → 150 input, 150 output, 300 tokens.
    expect(d21.byModel[1].inputTokens).toBe(150);
    expect(d21.byModel[1].outputTokens).toBe(150);
    expect(d21.byModel[1].totalTokens).toBe(300);
    // Day totals still match sum across models.
    expect(d21.totalTokens).toBe(320);
    expect(d21.costUSD).toBeCloseTo(5.2, 6);
    // Empty-usage days carry no model rows.
    const emptyDay = report.groups[0].rows[1];
    expect(emptyDay.dateLocal).toBe('2026-04-20');
    expect(emptyDay.byModel).toEqual([]);
  });

  it('honors a custom positive day count', async () => {
    const spy = vi.fn(async () => ({ records: [], updatedCursors: {}, skippedFiles: [] }));
    const builder = new WeeklyCostReportBuilder(
      makeIdentity(),
      { scanDateRange: spy } as unknown as UsageLogReader,
      makePricing(),
      makeStore({ version: 0, mtime: 0, entries: {}, processedIds: {}, fileCursors: {} }),
      mockLogger,
    );
    const report = await builder.build(new Date(2026, 3, 21, 15, 0, 0), 3);
    expect(spy).toHaveBeenCalledWith('2026-04-19', '2026-04-21');
    expect(report.mode).toBe('range');
    expect(report.rangeLabel).toBe('Last 3 days');
    expect(report.groups[0].rows.map((r) => r.dateLocal)).toEqual([
      '2026-04-21',
      '2026-04-20',
      '2026-04-19',
    ]);
  });

  it('prefers record.costUSD when present over PricingTable.calculateCost', async () => {
    const records = [
      buildRecord({
        messageId: 'm1',
        requestId: 'r1',
        timestamp: '2026-04-21T08:00:00Z',
        costUSD: 0.5,
      }),
    ];
    const calc = vi.fn(() => 999);
    const reader = makeReader(async () => ({ records, updatedCursors: {}, skippedFiles: [] }));
    const builder = new WeeklyCostReportBuilder(
      makeIdentity(),
      reader,
      { calculateCost: calc } as unknown as PricingTable,
      makeStore({ version: 0, mtime: 0, entries: {}, processedIds: {}, fileCursors: {} }),
      mockLogger,
    );
    const report = await builder.build(new Date(2026, 3, 21, 15, 0, 0));
    expect(calc).not.toHaveBeenCalled();
    // Newest row is today (2026-04-21).
    expect(report.groups[0].rows[0].costUSD).toBeCloseTo(0.5, 6);
  });

  it('calls scanDateRange with the correct 7-day window', async () => {
    const spy = vi.fn(async () => ({ records: [], updatedCursors: {}, skippedFiles: [] }));
    const builder = new WeeklyCostReportBuilder(
      makeIdentity(),
      { scanDateRange: spy } as unknown as UsageLogReader,
      makePricing(),
      makeStore({ version: 0, mtime: 0, entries: {}, processedIds: {}, fileCursors: {} }),
      mockLogger,
    );
    await builder.build(new Date(2026, 3, 21, 15, 0, 0));
    expect(spy).toHaveBeenCalledWith('2026-04-15', '2026-04-21');
  });
});

describe('WeeklyCostReportBuilder.build — all mode', () => {
  it('groups dates by month (newest month first) and computes grand totals', async () => {
    const records: TokenUsageRecord[] = [
      buildRecord({
        messageId: 'm1',
        requestId: 'r1',
        timestamp: '2026-02-10T05:00:00Z',
        inputTokens: 10,
        outputTokens: 10,
      }),
      buildRecord({
        messageId: 'm2',
        requestId: 'r2',
        timestamp: '2026-03-05T05:00:00Z',
        inputTokens: 20,
        outputTokens: 20,
      }),
      buildRecord({
        messageId: 'm3',
        requestId: 'r3',
        timestamp: '2026-03-20T05:00:00Z',
        inputTokens: 30,
        outputTokens: 30,
      }),
      buildRecord({
        messageId: 'm4',
        requestId: 'r4',
        timestamp: '2026-04-21T05:00:00Z',
        inputTokens: 40,
        outputTokens: 40,
      }),
    ];
    const reader = makeReader(async () => ({
      records,
      updatedCursors: {},
      skippedFiles: [],
    }));
    const builder = new WeeklyCostReportBuilder(
      makeIdentity(),
      reader,
      makePricing(0.01),
      makeStore({ version: 0, mtime: 0, entries: {}, processedIds: {}, fileCursors: {} }),
      mockLogger,
    );

    const report = await builder.build(new Date(2026, 3, 21, 12, 0, 0), 'all');

    expect(report.mode).toBe('all');
    expect(report.rangeLabel).toBe('All time');
    expect(report.groups.map((g) => g.label)).toEqual(['2026-04', '2026-03', '2026-02']);

    const apr = report.groups[0];
    expect(apr.rows).toHaveLength(1);
    expect(apr.rows[0].dateLocal).toBe('2026-04-21');
    expect(apr.totals.totalTokens).toBe(80);
    expect(apr.totals.costUSD).toBeCloseTo(0.01, 6);

    const mar = report.groups[1];
    // Newest first within the month.
    expect(mar.rows.map((r) => r.dateLocal)).toEqual(['2026-03-20', '2026-03-05']);
    expect(mar.totals.totalTokens).toBe(100);
    expect(mar.totals.costUSD).toBeCloseTo(0.02, 6);

    const feb = report.groups[2];
    expect(feb.rows).toHaveLength(1);
    expect(feb.rows[0].dateLocal).toBe('2026-02-10');
    expect(feb.totals.totalTokens).toBe(20);

    expect(report.grandTotals.totalTokens).toBe(200);
    expect(report.grandTotals.costUSD).toBeCloseTo(0.04, 6);
  });

  it('calls scanDateRange with no lower date bound', async () => {
    const spy = vi.fn(async () => ({ records: [], updatedCursors: {}, skippedFiles: [] }));
    const builder = new WeeklyCostReportBuilder(
      makeIdentity(),
      { scanDateRange: spy } as unknown as UsageLogReader,
      makePricing(),
      makeStore({ version: 0, mtime: 0, entries: {}, processedIds: {}, fileCursors: {} }),
      mockLogger,
    );
    await builder.build(new Date(2026, 3, 21, 12, 0, 0), 'all');
    expect(spy).toHaveBeenCalledTimes(1);
    const [from, to] = spy.mock.calls[0];
    expect(from).toBe('0001-01-01');
    expect(to).toBe('2026-04-21');
  });

  it('returns empty groups when there are no records', async () => {
    const reader = makeReader(async () => ({ records: [], updatedCursors: {}, skippedFiles: [] }));
    const builder = new WeeklyCostReportBuilder(
      makeIdentity(),
      reader,
      makePricing(),
      makeStore({ version: 0, mtime: 0, entries: {}, processedIds: {}, fileCursors: {} }),
      mockLogger,
    );
    const report = await builder.build(new Date(2026, 3, 21, 12, 0, 0), 'all');
    expect(report.mode).toBe('all');
    expect(report.groups).toEqual([]);
    expect(report.grandTotals.totalTokens).toBe(0);
    expect(report.grandTotals.costUSD).toBe(0);
  });
});

describe('WeeklyCostReportBuilder.build — fallback path', () => {
  it('range mode: falls back to CostStore.entries filtered by current account', async () => {
    const reader = makeReader(async () => {
      throw new Error('disk unavailable');
    });
    const storeData: CostStoreData = {
      version: 1,
      mtime: Date.now(),
      processedIds: {},
      fileCursors: {},
      entries: {
        'acc-1:2026-04-15': {
          dateLocal: '2026-04-15',
          accountUuid: 'acc-1',
          totalCostUSD: 0.15,
          byModel: {
            'claude-sonnet-4-6': { tokens: 500, cost: 0.15 },
          },
          updatedAt: Date.now(),
        },
        'acc-1:2026-04-21': {
          dateLocal: '2026-04-21',
          accountUuid: 'acc-1',
          totalCostUSD: 0.21,
          byModel: {
            'claude-opus-4-7': { tokens: 700, cost: 0.12 },
            'claude-sonnet-4-6': { tokens: 300, cost: 0.09 },
          },
          updatedAt: Date.now(),
        },
        // Out-of-window date — must be excluded.
        'acc-1:2026-04-10': {
          dateLocal: '2026-04-10',
          accountUuid: 'acc-1',
          totalCostUSD: 77,
          byModel: { 'claude-opus-4-7': { tokens: 77, cost: 77 } },
          updatedAt: Date.now(),
        },
        // Other account — must be ignored.
        'acc-2:2026-04-21': {
          dateLocal: '2026-04-21',
          accountUuid: 'acc-2',
          totalCostUSD: 99,
          byModel: { 'claude-opus-4-7': { tokens: 9999, cost: 99 } },
          updatedAt: Date.now(),
        },
      },
    };
    const builder = new WeeklyCostReportBuilder(
      makeIdentity('acc-1'),
      reader,
      makePricing(),
      makeStore(storeData),
      mockLogger,
    );

    const report = await builder.build(new Date(2026, 3, 21, 15, 0, 0));

    expect(report.scanFailed).toBe(true);
    expect(report.groups).toHaveLength(1);
    const rows = report.groups[0].rows;
    expect(rows).toHaveLength(7);

    const byDate: Record<string, typeof rows[number]> = {};
    for (const r of rows) byDate[r.dateLocal] = r;

    expect(byDate['2026-04-15'].costUSD).toBeCloseTo(0.15, 6);
    expect(byDate['2026-04-15'].totalTokens).toBe(500);
    expect(byDate['2026-04-21'].costUSD).toBeCloseTo(0.21, 6);
    expect(byDate['2026-04-21'].totalTokens).toBe(1000);

    expect(report.grandTotals.costUSD).toBeCloseTo(0.36, 6);
    expect(report.grandTotals.totalTokens).toBe(1500);
    // Out-of-window and other-account entries must not leak in.
    expect(report.grandTotals.costUSD).not.toBeCloseTo(99);
    expect(report.grandTotals.costUSD).not.toBeCloseTo(77);

    // Per-model breakdown should be populated from CostStore.byModel,
    // with tokensBreakdownKnown=false so the renderer can mark unknown
    // per-category columns with an em-dash.
    const d21 = byDate['2026-04-21'];
    expect(d21.byModel).toHaveLength(2);
    // Sorted by cost desc: opus first.
    expect(d21.byModel[0].model).toBe('claude-opus-4-7');
    expect(d21.byModel[0].shortLabel).toBe('opus-4.7');
    expect(d21.byModel[0].costUSD).toBeCloseTo(0.12, 6);
    expect(d21.byModel[0].totalTokens).toBe(700);
    expect(d21.byModel[0].tokensBreakdownKnown).toBe(false);
    expect(d21.byModel[0].inputTokens).toBe(0);
    expect(d21.byModel[0].outputTokens).toBe(0);
    expect(d21.byModel[1].model).toBe('claude-sonnet-4-6');
    expect(d21.byModel[1].costUSD).toBeCloseTo(0.09, 6);
    expect(d21.byModel[1].totalTokens).toBe(300);
  });

  it('range mode: produces empty rows when fallback store has no entries for this account', async () => {
    const reader = makeReader(async () => {
      throw new Error('nope');
    });
    const builder = new WeeklyCostReportBuilder(
      makeIdentity('acc-1'),
      reader,
      makePricing(),
      makeStore({ version: 0, mtime: 0, entries: {}, processedIds: {}, fileCursors: {} }),
      mockLogger,
    );
    const report = await builder.build(new Date(2026, 3, 21, 15, 0, 0));
    expect(report.scanFailed).toBe(true);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0].rows).toHaveLength(7);
    expect(report.grandTotals.costUSD).toBe(0);
    expect(report.grandTotals.totalTokens).toBe(0);
  });

  it('all mode: falls back to CostStore.entries, grouping by month', async () => {
    const reader = makeReader(async () => {
      throw new Error('disk unavailable');
    });
    const storeData: CostStoreData = {
      version: 1,
      mtime: Date.now(),
      processedIds: {},
      fileCursors: {},
      entries: {
        'acc-1:2026-02-10': {
          dateLocal: '2026-02-10',
          accountUuid: 'acc-1',
          totalCostUSD: 0.1,
          byModel: { 'claude-sonnet-4-6': { tokens: 10, cost: 0.1 } },
          updatedAt: Date.now(),
        },
        'acc-1:2026-04-20': {
          dateLocal: '2026-04-20',
          accountUuid: 'acc-1',
          totalCostUSD: 0.2,
          byModel: { 'claude-sonnet-4-6': { tokens: 20, cost: 0.2 } },
          updatedAt: Date.now(),
        },
        'acc-2:2026-04-21': {
          dateLocal: '2026-04-21',
          accountUuid: 'acc-2',
          totalCostUSD: 99,
          byModel: { 'claude-opus-4-7': { tokens: 99, cost: 99 } },
          updatedAt: Date.now(),
        },
      },
    };
    const builder = new WeeklyCostReportBuilder(
      makeIdentity('acc-1'),
      reader,
      makePricing(),
      makeStore(storeData),
      mockLogger,
    );
    const report = await builder.build(new Date(2026, 3, 21, 15, 0, 0), 'all');
    expect(report.scanFailed).toBe(true);
    expect(report.mode).toBe('all');
    expect(report.groups.map((g) => g.label)).toEqual(['2026-04', '2026-02']);
    expect(report.grandTotals.costUSD).toBeCloseTo(0.3, 6);
  });
});
