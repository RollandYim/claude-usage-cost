/**
 * Unit tests for `src/cost/remotePricingUpdater.ts`.
 *
 * Covers:
 * - Empty / undefined URL → fetch never called
 * - Non-HTTPS URL (http, file) → rejected without fetch
 * - Fetch error / timeout (AbortError) → callback not called, error logged
 * - Non-2xx response → callback not called, error logged
 * - Valid JSON response → callback called exactly once with a PricingTable
 * - Invalid JSON → callback not called, parse-error logged
 * - Missing / empty models → schema validation failure logged
 * - Content-Length exceeding 256 KB → rejected, callback not called
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── vscode mock ───────────────────────────────────────────────────────────────
vi.mock('vscode', () => ({
  EventEmitter: class {
    event = (_listener: unknown) => ({ dispose: () => {} });
    fire(_data: unknown) {}
    dispose() {}
  },
}));

import { RemotePricingUpdater } from '../src/cost/remotePricingUpdater';
import { PricingTable } from '../src/cost/pricingTable';
import type { PricingTable as PricingTableData } from '../src/types';

// ─── Mock logger ──────────────────────────────────────────────────────────────

const mockLogger = {
  appendLine: vi.fn(),
  append: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
  clear: vi.fn(),
  replace: vi.fn(),
  name: 'test',
} as unknown as import('vscode').OutputChannel;

// ─── Valid pricing fixture ────────────────────────────────────────────────────

const VALID_PRICING: PricingTableData = {
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
  },
  fallbackModel: 'claude-opus-4-7',
};

const VALID_JSON = JSON.stringify(VALID_PRICING);

// ─── Helper: build a minimal mock Response ────────────────────────────────────

function makeResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `Error ${status}`,
    headers: {
      get: (key: string): string | null => headers[key.toLowerCase()] ?? null,
    },
    /** body=null forces the implementation to call response.text(). */
    body: null,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RemotePricingUpdater.fetchOnce', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let onPricingUpdate: ReturnType<typeof vi.fn>;
  let updater: RemotePricingUpdater;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    onPricingUpdate = vi.fn();
  });

  afterEach(() => {
    updater?.dispose();
    fetchSpy.mockRestore();
  });

  // ── URL guards ─────────────────────────────────────────────────────────────

  it('skips when URL is empty string — fetch never called', async () => {
    updater = new RemotePricingUpdater(mockLogger, () => '', onPricingUpdate);
    await updater.fetchOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onPricingUpdate).not.toHaveBeenCalled();
  });

  it('skips when URL is undefined — fetch never called', async () => {
    updater = new RemotePricingUpdater(mockLogger, () => undefined, onPricingUpdate);
    await updater.fetchOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onPricingUpdate).not.toHaveBeenCalled();
  });

  it('rejects http:// URL without calling fetch', async () => {
    updater = new RemotePricingUpdater(
      mockLogger,
      () => 'http://example.com/pricing.json',
      onPricingUpdate,
    );
    await updater.fetchOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onPricingUpdate).not.toHaveBeenCalled();
    expect(mockLogger.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('[RemotePricing] rejected non-https url'),
    );
  });

  it('rejects file:// URL without calling fetch', async () => {
    updater = new RemotePricingUpdater(
      mockLogger,
      () => 'file:///etc/pricing.json',
      onPricingUpdate,
    );
    await updater.fetchOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onPricingUpdate).not.toHaveBeenCalled();
    expect(mockLogger.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('[RemotePricing] rejected non-https url'),
    );
  });

  it('rejects syntactically invalid URL', async () => {
    updater = new RemotePricingUpdater(
      mockLogger,
      () => 'not-a-url',
      onPricingUpdate,
    );
    await updater.fetchOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onPricingUpdate).not.toHaveBeenCalled();
  });

  // ── Network errors ─────────────────────────────────────────────────────────

  it('handles fetch timeout (AbortError) — callback not called, error logged', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    fetchSpy.mockRejectedValueOnce(abortError);

    updater = new RemotePricingUpdater(
      mockLogger,
      () => 'https://example.com/pricing.json',
      onPricingUpdate,
    );
    await updater.fetchOnce();

    expect(onPricingUpdate).not.toHaveBeenCalled();
    expect(mockLogger.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('[RemotePricing] fetch error'),
    );
  });

  it('handles generic network error — callback not called', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    updater = new RemotePricingUpdater(
      mockLogger,
      () => 'https://example.com/pricing.json',
      onPricingUpdate,
    );
    await updater.fetchOnce();

    expect(onPricingUpdate).not.toHaveBeenCalled();
    expect(mockLogger.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('[RemotePricing] fetch error: ECONNREFUSED'),
    );
  });

  it('handles non-2xx response (404) — callback not called, error logged', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse('Not Found', 404) as never);

    updater = new RemotePricingUpdater(
      mockLogger,
      () => 'https://example.com/pricing.json',
      onPricingUpdate,
    );
    await updater.fetchOnce();

    expect(onPricingUpdate).not.toHaveBeenCalled();
    expect(mockLogger.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('[RemotePricing] fetch failed: HTTP 404'),
    );
  });

  // ── Body size guard ────────────────────────────────────────────────────────

  it('rejects response with Content-Length > 256 KB', async () => {
    const resp = makeResponse(VALID_JSON, 200, {
      'content-length': String(256 * 1024 + 1),
    });
    fetchSpy.mockResolvedValueOnce(resp as never);

    updater = new RemotePricingUpdater(
      mockLogger,
      () => 'https://example.com/pricing.json',
      onPricingUpdate,
    );
    await updater.fetchOnce();

    expect(onPricingUpdate).not.toHaveBeenCalled();
    expect(mockLogger.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('rejected: Content-Length'),
    );
  });

  it('accepts response with Content-Length exactly at 256 KB', async () => {
    const resp = makeResponse(VALID_JSON, 200, {
      'content-length': String(256 * 1024),
    });
    fetchSpy.mockResolvedValueOnce(resp as never);

    updater = new RemotePricingUpdater(
      mockLogger,
      () => 'https://example.com/pricing.json',
      onPricingUpdate,
    );
    await updater.fetchOnce();

    // Content-Length is exactly at the limit; should proceed and call callback
    expect(onPricingUpdate).toHaveBeenCalledOnce();
  });

  // ── JSON parse / schema validation ────────────────────────────────────────

  it('skips when response body is invalid JSON — parse error logged', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse('this-is-not-json') as never);

    updater = new RemotePricingUpdater(
      mockLogger,
      () => 'https://example.com/pricing.json',
      onPricingUpdate,
    );
    await updater.fetchOnce();

    expect(onPricingUpdate).not.toHaveBeenCalled();
    expect(mockLogger.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('[RemotePricing] JSON parse failed'),
    );
  });

  it('skips when models object is empty — schema validation failure logged', async () => {
    const noModels = JSON.stringify({
      lastUpdated: '2026-04-21',
      aliases: {},
      models: {},
      fallbackModel: 'claude-opus-4-7',
    });
    fetchSpy.mockResolvedValueOnce(makeResponse(noModels) as never);

    updater = new RemotePricingUpdater(
      mockLogger,
      () => 'https://example.com/pricing.json',
      onPricingUpdate,
    );
    await updater.fetchOnce();

    expect(onPricingUpdate).not.toHaveBeenCalled();
    expect(mockLogger.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('[RemotePricing] schema validation failed'),
    );
  });

  it('skips when model entry is missing standard tier', async () => {
    const noStandard = JSON.stringify({
      lastUpdated: '2026-04-21',
      aliases: {},
      models: {
        'claude-opus-4-7': {
          // missing 'standard' tier
          priority: {
            input: 15, output: 75, cache_read: 1.5,
            cache_creation_5m: 18.75, cache_creation_1h: 3.75,
          },
        },
      },
      fallbackModel: 'claude-opus-4-7',
    });
    fetchSpy.mockResolvedValueOnce(makeResponse(noStandard) as never);

    updater = new RemotePricingUpdater(
      mockLogger,
      () => 'https://example.com/pricing.json',
      onPricingUpdate,
    );
    await updater.fetchOnce();

    expect(onPricingUpdate).not.toHaveBeenCalled();
    expect(mockLogger.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('[RemotePricing] schema validation failed'),
    );
  });

  it('skips when standard tier has a non-positive field (input = 0)', async () => {
    const badPricing = JSON.stringify({
      lastUpdated: '2026-04-21',
      aliases: {},
      models: {
        'claude-opus-4-7': {
          standard: {
            input: 0, // invalid: must be > 0
            output: 75,
            cache_read: 1.5,
            cache_creation_5m: 18.75,
            cache_creation_1h: 3.75,
          },
          priority: {
            input: 15, output: 75, cache_read: 1.5,
            cache_creation_5m: 18.75, cache_creation_1h: 3.75,
          },
        },
      },
      fallbackModel: 'claude-opus-4-7',
    });
    fetchSpy.mockResolvedValueOnce(makeResponse(badPricing) as never);

    updater = new RemotePricingUpdater(
      mockLogger,
      () => 'https://example.com/pricing.json',
      onPricingUpdate,
    );
    await updater.fetchOnce();

    expect(onPricingUpdate).not.toHaveBeenCalled();
    expect(mockLogger.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('[RemotePricing] schema validation failed'),
    );
  });

  it('skips when lastUpdated has invalid format', async () => {
    const badDate = JSON.stringify({
      ...VALID_PRICING,
      lastUpdated: '21-04-2026', // not YYYY-MM-DD
    });
    fetchSpy.mockResolvedValueOnce(makeResponse(badDate) as never);

    updater = new RemotePricingUpdater(
      mockLogger,
      () => 'https://example.com/pricing.json',
      onPricingUpdate,
    );
    await updater.fetchOnce();

    expect(onPricingUpdate).not.toHaveBeenCalled();
    expect(mockLogger.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('[RemotePricing] schema validation failed'),
    );
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('calls onPricingUpdate exactly once with a PricingTable on valid response', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(VALID_JSON) as never);

    updater = new RemotePricingUpdater(
      mockLogger,
      () => 'https://example.com/pricing.json',
      onPricingUpdate,
    );
    await updater.fetchOnce();

    expect(onPricingUpdate).toHaveBeenCalledOnce();
    expect(onPricingUpdate.mock.calls[0]![0]).toBeInstanceOf(PricingTable);
    expect(mockLogger.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('[RemotePricing] updated, lastUpdated=2026-04-21'),
    );
  });
});

// ─── start / stop ─────────────────────────────────────────────────────────────

describe('RemotePricingUpdater.start/stop', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let onPricingUpdate: ReturnType<typeof vi.fn>;
  let updater: RemotePricingUpdater;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    onPricingUpdate = vi.fn();
  });

  afterEach(() => {
    updater?.dispose();
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it('does NOT call fetch when URL is empty, even after timer fires', () => {
    vi.useFakeTimers();
    updater = new RemotePricingUpdater(mockLogger, () => '', onPricingUpdate);
    updater.start();
    vi.runAllTimers();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('logs enabled message with masked hostname on start', () => {
    vi.useFakeTimers();
    fetchSpy.mockResolvedValue(makeResponse(VALID_JSON) as never);

    updater = new RemotePricingUpdater(
      mockLogger,
      () => 'https://pricing.example.com/data.json?token=secret',
      onPricingUpdate,
    );
    updater.start();

    expect(mockLogger.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('[RemotePricing] enabled, url=***pricing.example.com***'),
    );
    // Query string must NOT appear in the log
    expect(mockLogger.appendLine).not.toHaveBeenCalledWith(
      expect.stringContaining('token=secret'),
    );
  });

  it('stop() prevents further fetch calls', async () => {
    vi.useFakeTimers();
    fetchSpy.mockResolvedValue(makeResponse(VALID_JSON) as never);

    updater = new RemotePricingUpdater(
      mockLogger,
      () => 'https://example.com/pricing.json',
      onPricingUpdate,
    );
    updater.start();
    updater.stop();
    // Advance time past one interval
    vi.advanceTimersByTime(86_400_001);
    // Only the initial fetchOnce (before stop) may have been queued; the timer
    // should NOT fire again after stop().
    await Promise.resolve(); // flush microtasks
    // At most 1 fetch from the initial fetchOnce; 0 additional from timer
    const callCount = fetchSpy.mock.calls.length;
    expect(callCount).toBeLessThanOrEqual(1);
  });
});
