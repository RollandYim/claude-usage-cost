import { describe, it, expect, beforeEach } from 'vitest';
import { PricingTable } from '../src/cost/pricingTable';
import type { PricingTable as PricingTableData, TokenUsageRecord } from '../src/types';

// ─── Minimal mock for vscode.OutputChannel ───────────────────────────────────
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

// ─── Shared fixture ──────────────────────────────────────────────────────────
const FIXTURE_DATA: PricingTableData = {
  lastUpdated: '2026-04-21',
  aliases: {
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-7',
    haiku: 'claude-haiku-4-5-20251001',
  },
  models: {
    'claude-opus-4-7': {
      standard: { input: 15, output: 75, cache_read: 1.5, cache_creation_5m: 18.75, cache_creation_1h: 3.75 },
      priority: { input: 15, output: 75, cache_read: 1.5, cache_creation_5m: 18.75, cache_creation_1h: 3.75 },
    },
    'claude-sonnet-4-6': {
      standard: { input: 3, output: 15, cache_read: 0.3, cache_creation_5m: 3.75, cache_creation_1h: 0.75 },
      priority: { input: 3, output: 15, cache_read: 0.3, cache_creation_5m: 3.75, cache_creation_1h: 0.75 },
    },
    'claude-haiku-4-5-20251001': {
      standard: { input: 1, output: 5, cache_read: 0.1, cache_creation_5m: 1.25, cache_creation_1h: 0.25 },
      priority: { input: 1, output: 5, cache_read: 0.1, cache_creation_5m: 1.25, cache_creation_1h: 0.25 },
    },
  },
  fallbackModel: 'claude-opus-4-7',
};

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

// ─── Tests ───────────────────────────────────────────────────────────────────
describe('PricingTable', () => {
  let table: PricingTable;

  beforeEach(() => {
    table = new PricingTable(FIXTURE_DATA, mockLogger);
  });

  describe('resolvePricing', () => {
    it('exact match: claude-opus-4-7 standard', () => {
      const result = table.resolvePricing('claude-opus-4-7', 'standard');
      expect(result.source).toBe('exact');
      expect(result.resolvedModel).toBe('claude-opus-4-7');
      expect(result.resolvedTier).toBe('standard');
      expect(result.pricing.input).toBe(15);
      expect(result.pricing.output).toBe(75);
    });

    it('alias: "sonnet" → claude-sonnet-4-6', () => {
      const result = table.resolvePricing('sonnet', 'standard');
      expect(result.source).toBe('alias');
      expect(result.resolvedModel).toBe('claude-sonnet-4-6');
      expect(result.pricing.input).toBe(3);
      expect(result.pricing.output).toBe(15);
    });

    it('unknown model falls back to claude-opus-4-7', () => {
      const result = table.resolvePricing('claude-future-unknown-9', 'standard');
      expect(result.source).toBe('fallback');
      expect(result.resolvedModel).toBe('claude-opus-4-7');
      expect(result.pricing.input).toBe(15);
    });

    it('unknown service tier "batch" falls back to standard', () => {
      const result = table.resolvePricing('claude-opus-4-7', 'batch');
      expect(result.resolvedTier).toBe('standard');
      expect(result.pricing.input).toBe(15);
    });

    it('undefined/empty service tier falls back to standard', () => {
      const result = table.resolvePricing('claude-opus-4-7', '');
      expect(result.resolvedTier).toBe('standard');
    });

    it('prefix match: "claude-sonnet-4-6-20260101" → claude-sonnet-4-6', () => {
      const result = table.resolvePricing('claude-sonnet-4-6-20260101', 'standard');
      expect(result.source).toBe('prefix');
      expect(result.resolvedModel).toBe('claude-sonnet-4-6');
      expect(result.pricing.input).toBe(3);
    });
  });

  describe('calculateCost', () => {
    it('<synthetic> model returns 0', () => {
      const record = makeRecord({ model: '<synthetic>' });
      expect(table.calculateCost(record)).toBe(0);
    });

    it('uses costUSD when present and valid', () => {
      const record = makeRecord({ costUSD: 0.0042 });
      expect(table.calculateCost(record)).toBe(0.0042);
    });

    it('ignores invalid costUSD and computes from tokens', () => {
      const record = makeRecord({
        model: 'claude-opus-4-7',
        serviceTier: 'standard',
        inputTokens: 1_000_000,
        costUSD: -1,
      });
      // 1M input tokens × $15/M = $15
      expect(table.calculateCost(record)).toBeCloseTo(15, 6);
    });

    it('computes cost from tokens when costUSD absent', () => {
      const record = makeRecord({
        model: 'claude-sonnet-4-6',
        serviceTier: 'standard',
        inputTokens: 1_000_000,  // $3
        outputTokens: 1_000_000, // $15
      });
      expect(table.calculateCost(record)).toBeCloseTo(18, 6);
    });

    it('computes full 5-token-type cost correctly', () => {
      const record = makeRecord({
        model: 'claude-opus-4-7',
        serviceTier: 'standard',
        inputTokens: 6,
        outputTokens: 19,
        cacheCreation5m: 733,
        cacheCreation1h: 0,
        cacheRead: 73_376,
      });
      // (6*15 + 19*75 + 733*18.75 + 0*3.75 + 73376*1.5) / 1_000_000
      const expected = (6 * 15 + 19 * 75 + 733 * 18.75 + 73_376 * 1.5) / 1_000_000;
      expect(table.calculateCost(record)).toBeCloseTo(expected, 8);
    });
  });

  describe('isKnownModel', () => {
    it('returns true for exact match', () => {
      expect(table.isKnownModel('claude-opus-4-7')).toBe(true);
    });

    it('returns true for alias', () => {
      expect(table.isKnownModel('sonnet')).toBe(true);
    });

    it('returns true for prefix match', () => {
      expect(table.isKnownModel('claude-sonnet-4-6-new')).toBe(true);
    });

    it('returns false for fully unknown model', () => {
      expect(table.isKnownModel('gpt-4o')).toBe(false);
    });
  });

  describe('parseJson', () => {
    it('throws on missing required field', () => {
      const bad = JSON.stringify({ lastUpdated: '2026-01-01', aliases: {}, models: {} });
      expect(() => PricingTable.parseJson(bad)).toThrow('fallbackModel');
    });

    it('parses valid JSON successfully', () => {
      const raw = JSON.stringify(FIXTURE_DATA);
      const parsed = PricingTable.parseJson(raw);
      expect(parsed.fallbackModel).toBe('claude-opus-4-7');
    });
  });
});
