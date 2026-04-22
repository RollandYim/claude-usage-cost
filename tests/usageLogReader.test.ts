import { describe, it, expect } from 'vitest';
import { UsageLogReader, toLocalDateString } from '../src/cost/usageLogReader';

// ─── Minimal vscode.OutputChannel mock ───────────────────────────────────────

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

// ─── Reader factory ───────────────────────────────────────────────────────────

function makeReader() {
  return new UsageLogReader(mockLogger, () => ({}));
}

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/** Builds a minimal valid assistant JSONL line. */
function buildAssistantLine(overrides: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    type: 'assistant',
    message: {
      id: 'msg_01abc',
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        service_tier: 'standard',
      },
    },
    requestId: 'req_xyz',
    timestamp: '2026-04-21T13:46:09.846Z',
  };
  return JSON.stringify({ ...base, ...overrides });
}

// ─── parseLine — success cases ────────────────────────────────────────────────

describe('UsageLogReader.parseLine', () => {
  it('parses a typical assistant message correctly', () => {
    const reader = makeReader();
    const line = buildAssistantLine();
    const record = reader.parseLine(line);

    expect(record).not.toBeNull();
    expect(record!.messageId).toBe('msg_01abc');
    expect(record!.requestId).toBe('req_xyz');
    expect(record!.timestamp).toBe('2026-04-21T13:46:09.846Z');
    expect(record!.model).toBe('claude-sonnet-4-6');
    expect(record!.serviceTier).toBe('standard');
    expect(record!.inputTokens).toBe(100);
    expect(record!.outputTokens).toBe(200);
    expect(record!.cacheRead).toBe(0);
    expect(record!.cacheCreation5m).toBe(0);
    expect(record!.cacheCreation1h).toBe(0);
  });

  it('reads service_tier from usage object', () => {
    const reader = makeReader();
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_tier',
        model: 'claude-opus-4-7',
        usage: { input_tokens: 10, output_tokens: 5, service_tier: 'priority' },
      },
      requestId: 'req_tier',
      timestamp: '2026-04-21T10:00:00.000Z',
    });
    const record = reader.parseLine(line);
    expect(record).not.toBeNull();
    expect(record!.serviceTier).toBe('priority');
  });

  it('defaults serviceTier to "standard" when service_tier is absent', () => {
    const reader = makeReader();
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_notier',
        model: 'claude-haiku-4-5-20251001',
        usage: { input_tokens: 5, output_tokens: 3 },
      },
      requestId: 'req_notier',
      timestamp: '2026-04-21T10:00:00.000Z',
    });
    const record = reader.parseLine(line);
    expect(record).not.toBeNull();
    expect(record!.serviceTier).toBe('standard');
  });

  it('reads optional costUSD when present', () => {
    const reader = makeReader();
    const line = buildAssistantLine({ costUSD: 0.0042 });
    const record = reader.parseLine(line);
    expect(record).not.toBeNull();
    expect(record!.costUSD).toBeCloseTo(0.0042);
  });

  it('omits costUSD field when not present in source', () => {
    const reader = makeReader();
    const line = buildAssistantLine();
    const record = reader.parseLine(line);
    expect(record).not.toBeNull();
    expect('costUSD' in record!).toBe(false);
  });
});

// ─── parseLine — null cases ───────────────────────────────────────────────────

describe('UsageLogReader.parseLine — returns null', () => {
  it('returns null for type=user', () => {
    const reader = makeReader();
    const line = JSON.stringify({ type: 'user', message: {}, requestId: 'r', timestamp: 't' });
    expect(reader.parseLine(line)).toBeNull();
  });

  it('returns null for type=system', () => {
    const reader = makeReader();
    const line = JSON.stringify({ type: 'system', content: 'hello' });
    expect(reader.parseLine(line)).toBeNull();
  });

  it('returns null when message.usage is absent', () => {
    const reader = makeReader();
    const line = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg_x', model: 'claude-sonnet-4-6' },
      requestId: 'req_x',
      timestamp: '2026-04-21T00:00:00Z',
    });
    expect(reader.parseLine(line)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(makeReader().parseLine('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(makeReader().parseLine('   ')).toBeNull();
  });

  it('returns null for non-JSON text', () => {
    expect(makeReader().parseLine('not json at all')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(makeReader().parseLine('{type: "assistant"')).toBeNull();
  });

  it('returns null when requestId is absent', () => {
    const reader = makeReader();
    const line = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg_a', model: 'm', usage: { input_tokens: 1 } },
      timestamp: '2026-04-21T00:00:00Z',
      // no requestId
    });
    expect(reader.parseLine(line)).toBeNull();
  });

  it('returns null when message.id is absent', () => {
    const reader = makeReader();
    const line = JSON.stringify({
      type: 'assistant',
      message: { model: 'm', usage: { input_tokens: 1 } },
      requestId: 'req_a',
      timestamp: '2026-04-21T00:00:00Z',
    });
    expect(reader.parseLine(line)).toBeNull();
  });

  it('returns null when timestamp is absent', () => {
    const reader = makeReader();
    const line = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg_a', model: 'm', usage: {} },
      requestId: 'req_a',
      // no timestamp
    });
    expect(reader.parseLine(line)).toBeNull();
  });

  it('returns null for <synthetic> model', () => {
    const reader = makeReader();
    const line = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg_s', model: '<synthetic>', usage: { input_tokens: 0 } },
      requestId: 'req_s',
      timestamp: '2026-04-21T00:00:00Z',
    });
    expect(reader.parseLine(line)).toBeNull();
  });
});

// ─── parseLine — cache_creation field resolution ──────────────────────────────

describe('UsageLogReader.parseLine — cache_creation token resolution', () => {
  it('uses ephemeral_5m and ephemeral_1h when cache_creation sub-object is present', () => {
    const reader = makeReader();
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_cc',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 6,
          output_tokens: 19,
          cache_read_input_tokens: 73376,
          // sub-object takes precedence
          cache_creation: {
            ephemeral_5m_input_tokens: 400,
            ephemeral_1h_input_tokens: 333,
          },
          // top-level field should be ignored when sub-object is present
          cache_creation_input_tokens: 999,
        },
      },
      requestId: 'req_cc',
      timestamp: '2026-04-21T13:00:00Z',
    });

    const record = reader.parseLine(line);
    expect(record).not.toBeNull();
    expect(record!.cacheCreation5m).toBe(400);
    expect(record!.cacheCreation1h).toBe(333);
    expect(record!.cacheRead).toBe(73376);
  });

  it('falls back to top-level cache_creation_input_tokens as 5m-only when sub-object is absent', () => {
    const reader = makeReader();
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_legacy',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 733,
          cache_read_input_tokens: 0,
          // no cache_creation sub-object
        },
      },
      requestId: 'req_legacy',
      timestamp: '2026-04-21T13:00:00Z',
    });

    const record = reader.parseLine(line);
    expect(record).not.toBeNull();
    expect(record!.cacheCreation5m).toBe(733);
    expect(record!.cacheCreation1h).toBe(0);
  });

  it('treats a null cache_creation as absent and falls back to top-level field', () => {
    const reader = makeReader();
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_null_cc',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation: null,
          cache_creation_input_tokens: 50,
        },
      },
      requestId: 'req_null_cc',
      timestamp: '2026-04-21T13:00:00Z',
    });

    const record = reader.parseLine(line);
    expect(record).not.toBeNull();
    expect(record!.cacheCreation5m).toBe(50);
    expect(record!.cacheCreation1h).toBe(0);
  });

  it('returns 0 for cache_creation5m and 1h when no relevant fields present', () => {
    const reader = makeReader();
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_nocache',
        model: 'claude-haiku-4-5-20251001',
        usage: { input_tokens: 5, output_tokens: 3 },
      },
      requestId: 'req_nocache',
      timestamp: '2026-04-21T10:00:00Z',
    });

    const record = reader.parseLine(line);
    expect(record).not.toBeNull();
    expect(record!.cacheCreation5m).toBe(0);
    expect(record!.cacheCreation1h).toBe(0);
    expect(record!.cacheRead).toBe(0);
  });
});

// ─── toLocalDateString helper ────────────────────────────────────────────────

describe('toLocalDateString', () => {
  it('returns a YYYY-MM-DD string for a known UTC timestamp', () => {
    // The result depends on the local timezone of the test runner, but the
    // format must always be YYYY-MM-DD (10 characters, dashes at positions 4 and 7).
    const result = toLocalDateString('2026-04-21T13:46:09.846Z');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
