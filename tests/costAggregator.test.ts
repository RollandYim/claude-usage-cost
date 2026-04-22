/**
 * Unit tests for `src/cost/costAggregator.ts`.
 *
 * Covers: empty records, basic accumulation, dedup by messageId+requestId,
 * <synthetic> filtering, incremental merge onto an existing entry, and
 * 6-decimal-place rounding of USD totals.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ── vscode mock ───────────────────────────────────────────────────────────────
vi.mock('vscode', () => ({
  EventEmitter: class {
    event = (_listener: unknown) => ({ dispose: () => {} });
    fire(_data: unknown) {}
    dispose() {}
  },
}));

import { CostAggregator } from '../src/cost/costAggregator';
import { PricingTable } from '../src/cost/pricingTable';
import type { CostEntry, PricingTable as PricingTableData, TokenUsageRecord } from '../src/types';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const PRICING_DATA: PricingTableData = {
  lastUpdated: '2026-04-21',
  aliases: {},
  models: {
    'claude-opus-4-7': {
      standard: {
        input: 15,
        output: 75,
        cache_read: 1.5,
        cache_creation_5m: 18.75,
        cache_creation_1h: 3.75,
      },
      priority: {
        input: 15,
        output: 75,
        cache_read: 1.5,
        cache_creation_5m: 18.75,
        cache_creation_1h: 3.75,
      },
    },
    'claude-sonnet-4-6': {
      standard: {
        input: 3,
        output: 15,
        cache_read: 0.3,
        cache_creation_5m: 3.75,
        cache_creation_1h: 0.75,
      },
      priority: {
        input: 3,
        output: 15,
        cache_read: 0.3,
        cache_creation_5m: 3.75,
        cache_creation_1h: 0.75,
      },
    },
  },
  fallbackModel: 'claude-opus-4-7',
};

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

function makeRecord(overrides: Partial<TokenUsageRecord> = {}): TokenUsageRecord {
  return {
    messageId: 'msg-1',
    requestId: 'req-1',
    timestamp: '2026-04-21T10:00:00.000Z',
    model: 'claude-opus-4-7',
    serviceTier: 'standard',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    cacheRead: 0,
    ...overrides,
  };
}

const TODAY = '2026-04-21';
const ACCOUNT = 'test-account-uuid';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CostAggregator', () => {
  let pricing: PricingTable;
  let aggregator: CostAggregator;

  beforeEach(() => {
    vi.clearAllMocks();
    pricing = new PricingTable(PRICING_DATA, mockLogger);
    aggregator = new CostAggregator(pricing, mockLogger);
  });

  // ── Empty input ─────────────────────────────────────────────────────────────

  it('returns a zero-cost entry when records is empty', () => {
    const out = aggregator.aggregate({
      records: [],
      accountUuid: ACCOUNT,
      todayLocalDate: TODAY,
      existingProcessedIds: {},
    });

    expect(out.updatedEntry.totalCostUSD).toBe(0);
    expect(out.updatedEntry.byModel).toEqual({});
    expect(out.totalDeltaUSD).toBe(0);
    expect(out.skippedRecords).toBe(0);
    expect(out.newProcessedIds).toEqual({});
    expect(out.updatedEntry.dateLocal).toBe(TODAY);
    expect(out.updatedEntry.accountUuid).toBe(ACCOUNT);
  });

  // ── Basic accumulation ──────────────────────────────────────────────────────

  it('correctly accumulates cost for two distinct records', () => {
    // r1: 1 M input tokens → $15  (Opus, $15/M input)
    // r2: 1 M output tokens → $75  (Opus, $75/M output)
    const r1 = makeRecord({
      messageId: 'msg-1',
      requestId: 'req-1',
      model: 'claude-opus-4-7',
      inputTokens: 1_000_000,
    });
    const r2 = makeRecord({
      messageId: 'msg-2',
      requestId: 'req-2',
      model: 'claude-opus-4-7',
      outputTokens: 1_000_000,
    });

    const out = aggregator.aggregate({
      records: [r1, r2],
      accountUuid: ACCOUNT,
      todayLocalDate: TODAY,
      existingProcessedIds: {},
    });

    expect(out.updatedEntry.totalCostUSD).toBeCloseTo(15 + 75, 5);
    expect(out.skippedRecords).toBe(0);
    expect(Object.keys(out.newProcessedIds)).toHaveLength(2);
    expect(out.newProcessedIds['msg-1:req-1']).toBe(true);
    expect(out.newProcessedIds['msg-2:req-2']).toBe(true);
  });

  it('populates byModel with token counts and cost', () => {
    const r = makeRecord({
      messageId: 'msg-1',
      requestId: 'req-1',
      model: 'claude-opus-4-7',
      inputTokens: 500_000,
      outputTokens: 200_000,
    });

    const out = aggregator.aggregate({
      records: [r],
      accountUuid: ACCOUNT,
      todayLocalDate: TODAY,
      existingProcessedIds: {},
    });

    const modelEntry = out.updatedEntry.byModel['claude-opus-4-7'];
    expect(modelEntry).toBeDefined();
    expect(modelEntry.tokens).toBe(700_000); // input + output
    expect(modelEntry.cost).toBeGreaterThan(0);
  });

  // ── Deduplication ───────────────────────────────────────────────────────────

  it('deduplicates two records with the same messageId + requestId (in-batch)', () => {
    const r1 = makeRecord({ messageId: 'dup', requestId: 'dup-req', inputTokens: 1_000_000 });
    const r2 = makeRecord({ messageId: 'dup', requestId: 'dup-req', inputTokens: 1_000_000 });

    const out = aggregator.aggregate({
      records: [r1, r2],
      accountUuid: ACCOUNT,
      todayLocalDate: TODAY,
      existingProcessedIds: {},
    });

    // Only the first record is processed
    expect(out.skippedRecords).toBe(1);
    expect(out.updatedEntry.totalCostUSD).toBeCloseTo(15, 5); // $15 for 1 M input tokens
    expect(Object.keys(out.newProcessedIds)).toHaveLength(1);
  });

  it('skips records whose key already exists in existingProcessedIds', () => {
    const r = makeRecord({ messageId: 'known', requestId: 'known-req', inputTokens: 1_000_000 });

    const out = aggregator.aggregate({
      records: [r],
      accountUuid: ACCOUNT,
      todayLocalDate: TODAY,
      existingProcessedIds: { 'known:known-req': true },
    });

    expect(out.skippedRecords).toBe(1);
    expect(out.totalDeltaUSD).toBe(0);
    expect(out.newProcessedIds['known:known-req']).toBeUndefined();
  });

  // ── <synthetic> filtering ───────────────────────────────────────────────────

  it('silently skips <synthetic> records and does not add them to byModel', () => {
    const synth = makeRecord({
      messageId: 'syn-1',
      requestId: 'syn-req',
      model: '<synthetic>',
      inputTokens: 999_999,
    });
    const real = makeRecord({
      messageId: 'real-1',
      requestId: 'real-req',
      model: 'claude-opus-4-7',
      inputTokens: 1_000_000,
    });

    const out = aggregator.aggregate({
      records: [synth, real],
      accountUuid: ACCOUNT,
      todayLocalDate: TODAY,
      existingProcessedIds: {},
    });

    expect(Object.keys(out.updatedEntry.byModel)).not.toContain('<synthetic>');
    expect(out.updatedEntry.totalCostUSD).toBeCloseTo(15, 5);
    // synthetic is NOT counted as skippedRecords (separate category)
    expect(out.skippedRecords).toBe(0);
    // synthetic is NOT added to newProcessedIds
    expect(Object.keys(out.newProcessedIds)).toHaveLength(1);
    expect(out.newProcessedIds['real-1:real-req']).toBe(true);
  });

  // ── Incremental merge ───────────────────────────────────────────────────────

  it('incrementally merges a new batch onto an existing CostEntry', () => {
    const existingEntry: CostEntry = {
      dateLocal: TODAY,
      accountUuid: ACCOUNT,
      totalCostUSD: 10.0,
      byModel: {
        'claude-opus-4-7': { tokens: 500_000, cost: 7.5 },
      },
      updatedAt: 1_000,
    };

    const r = makeRecord({
      messageId: 'new-1',
      requestId: 'new-req',
      model: 'claude-opus-4-7',
      inputTokens: 1_000_000, // $15
    });

    const out = aggregator.aggregate({
      records: [r],
      accountUuid: ACCOUNT,
      todayLocalDate: TODAY,
      existingEntry,
      existingProcessedIds: {},
    });

    // Total: 10.0 (existing) + 15.0 (new) = 25.0
    expect(out.updatedEntry.totalCostUSD).toBeCloseTo(25.0, 5);
    // Tokens: 500 000 (existing) + 1 000 000 (new) = 1 500 000
    expect(out.updatedEntry.byModel['claude-opus-4-7'].tokens).toBe(1_500_000);
    // Cost: 7.5 (existing) + 15.0 (new) = 22.5
    expect(out.updatedEntry.byModel['claude-opus-4-7'].cost).toBeCloseTo(22.5, 5);
  });

  it('merges byModel across different models independently', () => {
    const existingEntry: CostEntry = {
      dateLocal: TODAY,
      accountUuid: ACCOUNT,
      totalCostUSD: 3.0,
      byModel: {
        'claude-sonnet-4-6': { tokens: 1_000_000, cost: 3.0 }, // $3/M input
      },
      updatedAt: 0,
    };

    const r = makeRecord({
      messageId: 'opus-1',
      requestId: 'opus-req',
      model: 'claude-opus-4-7',
      inputTokens: 1_000_000, // $15
    });

    const out = aggregator.aggregate({
      records: [r],
      accountUuid: ACCOUNT,
      todayLocalDate: TODAY,
      existingEntry,
      existingProcessedIds: {},
    });

    expect(Object.keys(out.updatedEntry.byModel)).toHaveLength(2);
    expect(out.updatedEntry.byModel['claude-sonnet-4-6'].tokens).toBe(1_000_000);
    expect(out.updatedEntry.byModel['claude-opus-4-7'].tokens).toBe(1_000_000);
    expect(out.updatedEntry.totalCostUSD).toBeCloseTo(18.0, 5);
  });

  // ── Numerical precision ─────────────────────────────────────────────────────

  it('rounds totalCostUSD to at most 6 decimal places', () => {
    // 1 input token × $15/M = $0.000015; accumulate 3 records
    const records = [
      makeRecord({ messageId: 'a', requestId: 'ra', inputTokens: 1 }),
      makeRecord({ messageId: 'b', requestId: 'rb', inputTokens: 1 }),
      makeRecord({ messageId: 'c', requestId: 'rc', inputTokens: 1 }),
    ];

    const out = aggregator.aggregate({
      records,
      accountUuid: ACCOUNT,
      todayLocalDate: TODAY,
      existingProcessedIds: {},
    });

    const str = out.updatedEntry.totalCostUSD.toString();
    const decimals = (str.split('.')[1] ?? '').length;
    expect(decimals).toBeLessThanOrEqual(6);

    // Exact expected value via the same round6 formula
    const expected = Math.round(3 * (1 * 15 / 1_000_000) * 1_000_000) / 1_000_000;
    expect(out.updatedEntry.totalCostUSD).toBe(expected);
  });

  it('rounds totalDeltaUSD to 6 decimal places', () => {
    const r = makeRecord({ messageId: 'm', requestId: 'r', inputTokens: 1 });

    const out = aggregator.aggregate({
      records: [r],
      accountUuid: ACCOUNT,
      todayLocalDate: TODAY,
      existingProcessedIds: {},
    });

    const str = out.totalDeltaUSD.toString();
    const decimals = (str.split('.')[1] ?? '').length;
    expect(decimals).toBeLessThanOrEqual(6);
  });

  // ── updatedAt ───────────────────────────────────────────────────────────────

  it('sets updatedAt to a recent timestamp', () => {
    const before = Date.now();
    const out = aggregator.aggregate({
      records: [],
      accountUuid: ACCOUNT,
      todayLocalDate: TODAY,
      existingProcessedIds: {},
    });
    const after = Date.now();
    expect(out.updatedEntry.updatedAt).toBeGreaterThanOrEqual(before);
    expect(out.updatedEntry.updatedAt).toBeLessThanOrEqual(after);
  });
});
