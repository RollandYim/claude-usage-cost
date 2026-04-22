import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as diagnosticsChannel from 'diagnostics_channel';

// ── Minimal vscode mock ───────────────────────────────────────────────────────

vi.mock('vscode', () => {
  class VscEventEmitter {
    private _listeners: Array<(e: unknown) => void> = [];
    event = (listener: (e: unknown) => void): { dispose: () => void } => {
      this._listeners.push(listener);
      return {
        dispose: () => {
          this._listeners = this._listeners.filter((l) => l !== listener);
        },
      };
    };
    fire(e: unknown): void {
      this._listeners.forEach((l) => l(e));
    }
    dispose(): void {
      this._listeners = [];
    }
  }
  return { EventEmitter: VscEventEmitter };
});

import { DiagnosticsInterceptor } from '../src/diagnosticsInterceptor';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    name: 'test',
    append: vi.fn(),
    appendLine: vi.fn(),
    replace: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeStoreStub() {
  return {
    update: vi.fn(),
    setRemoteStatus: vi.fn(),
    data: null,
    remoteStatus: 'unknown',
    onDidChange: vi.fn(),
    onDidChangeStatus: vi.fn(),
    restore: vi.fn(),
    persist: vi.fn(),
    dispose: vi.fn(),
  };
}

interface FakeRequest {
  path: string;
  getHeader: (name: string) => string | undefined;
}

function makeRequest(path: string, host: string | undefined): FakeRequest {
  return {
    path,
    getHeader: (name: string) => (name.toLowerCase() === 'host' ? host : undefined),
  };
}

class FakeResponse extends EventEmitter {
  statusCode: number;
  constructor(statusCode = 200) {
    super();
    this.statusCode = statusCode;
  }
}

function publishStart(request: FakeRequest) {
  diagnosticsChannel.channel('http.client.request.start').publish({ request });
}

function publishFinish(request: FakeRequest, response: FakeResponse) {
  diagnosticsChannel.channel('http.client.response.finish').publish({ request, response });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiagnosticsInterceptor', () => {
  let store: ReturnType<typeof makeStoreStub>;
  let logger: ReturnType<typeof makeLogger>;
  let interceptor: DiagnosticsInterceptor;

  beforeEach(() => {
    store = makeStoreStub();
    logger = makeLogger();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    interceptor = new DiagnosticsInterceptor(store as any, logger as any);
  });

  afterEach(() => {
    interceptor.dispose();
  });

  it('matching request → 200 response → store.update called with parsed body', () => {
    const req = makeRequest('/api/oauth/usage', 'api.anthropic.com');
    const res = new FakeResponse(200);

    publishStart(req);
    publishFinish(req, res);

    const body = JSON.stringify({ five_hour: { utilization: 42, resets_at: '2026-04-30T00:00:00Z' } });
    res.emit('data', Buffer.from(body, 'utf8'));
    res.emit('end');

    expect(store.update).toHaveBeenCalledTimes(1);
    expect(store.update).toHaveBeenCalledWith({ five_hour: { utilization: 42, resets_at: '2026-04-30T00:00:00Z' } });
  });

  it('non-200 response → store.update NOT called and body tap skipped', () => {
    const req = makeRequest('/api/oauth/usage', 'api.anthropic.com');
    const res = new FakeResponse(401);

    publishStart(req);
    publishFinish(req, res);

    // Even if Claude Code somehow emits data, we never registered the data listener.
    res.emit('data', Buffer.from('{"x":1}', 'utf8'));
    res.emit('end');

    expect(store.update).not.toHaveBeenCalled();
  });

  it('wrong host → request not tracked → store.update NOT called', () => {
    const req = makeRequest('/api/oauth/usage', 'evil.example.com');
    const res = new FakeResponse(200);

    publishStart(req);
    publishFinish(req, res);
    res.emit('data', Buffer.from('{"x":1}', 'utf8'));
    res.emit('end');

    expect(store.update).not.toHaveBeenCalled();
  });

  it('missing host header → request ignored', () => {
    const req = makeRequest('/api/oauth/usage', undefined);
    const res = new FakeResponse(200);

    publishStart(req);
    publishFinish(req, res);
    res.emit('data', Buffer.from('{"x":1}', 'utf8'));
    res.emit('end');

    expect(store.update).not.toHaveBeenCalled();
  });

  it('body > 1 MB → discarded, store.update NOT called', () => {
    const req = makeRequest('/api/oauth/usage', 'api.anthropic.com');
    const res = new FakeResponse(200);

    publishStart(req);
    publishFinish(req, res);

    // 2 MB payload in two chunks
    const chunk = Buffer.alloc(700_000, 'a'); // 700 KB of 'a'
    res.emit('data', chunk);
    res.emit('data', chunk); // 1.4 MB cumulative — still under cap on first, oversize triggers here
    res.emit('data', chunk); // pushes it over 2 MB
    res.emit('end');

    expect(store.update).not.toHaveBeenCalled();
    expect(logger.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('exceeds 1048576 bytes'),
    );
  });

  // NOTE: Independent listener strategy — our `data`/`end` listeners are registered
  // as separate EventEmitter callbacks rather than monkey-patched over Claude Code's
  // listeners. EventEmitter broadcasts chunks to all listeners and an error in one
  // callback does NOT short-circuit the others. This makes the "error isolation"
  // contract (tap exception must not break Claude Code) a property of EventEmitter
  // itself, not of our forwarding code. The next two tests verify the contract in
  // both the `end` path (JSON parse / store.update throws) and the `data` path
  // (oversize-log path throws) — if the implementation ever reverts to monkey-patch,
  // these tests become meaningful again in the forwarding sense.

  it('store.update throws inside our end listener → Claude Code listeners still run', () => {
    store.update.mockImplementation(() => {
      throw new Error('boom');
    });

    const req = makeRequest('/api/oauth/usage', 'api.anthropic.com');
    const res = new FakeResponse(200);

    publishStart(req);
    publishFinish(req, res);

    const originalEnd = vi.fn();
    const originalData = vi.fn();
    res.on('data', originalData);
    res.on('end', originalEnd);

    res.emit('data', Buffer.from('{"five_hour":{"utilization":1,"resets_at":"2026-04-30T00:00:00Z"}}', 'utf8'));
    res.emit('end');

    expect(originalData).toHaveBeenCalledTimes(1);
    expect(originalEnd).toHaveBeenCalledTimes(1);
    // store.update was invoked but threw — interceptor must swallow it
    expect(store.update).toHaveBeenCalledTimes(1);
  });

  it('logger.appendLine throws inside our data listener (oversize branch) → Claude Code data listener still runs', () => {
    let throwOnOversizeLog = false;
    logger.appendLine.mockImplementation((msg: string) => {
      if (throwOnOversizeLog && msg.includes('exceeds')) {
        throw new Error('log failure');
      }
    });

    const req = makeRequest('/api/oauth/usage', 'api.anthropic.com');
    const res = new FakeResponse(200);

    publishStart(req);
    publishFinish(req, res);

    const originalData = vi.fn();
    res.on('data', originalData);

    throwOnOversizeLog = true;
    const chunk = Buffer.alloc(700_000, 'a');
    res.emit('data', chunk);
    res.emit('data', chunk);
    res.emit('data', chunk); // triggers oversize log, which throws

    // Claude Code's data listener received every chunk independently
    expect(originalData).toHaveBeenCalledTimes(3);
  });

  it('dispose → subsequent events do not call store.update', () => {
    interceptor.dispose();

    const req = makeRequest('/api/oauth/usage', 'api.anthropic.com');
    const res = new FakeResponse(200);

    publishStart(req);
    publishFinish(req, res);
    res.emit('data', Buffer.from('{"x":1}', 'utf8'));
    res.emit('end');

    expect(store.update).not.toHaveBeenCalled();
  });

  it('dispose is idempotent', () => {
    expect(() => {
      interceptor.dispose();
      interceptor.dispose();
    }).not.toThrow();
  });

  it('first matching request logs "matched first usage request", subsequent ones do NOT', () => {
    const req1 = makeRequest('/api/oauth/usage', 'api.anthropic.com');
    const req2 = makeRequest('/api/oauth/usage', 'api.anthropic.com');

    publishStart(req1);
    publishStart(req2);

    const firstHitLogs = logger.appendLine.mock.calls.filter((c: unknown[]) =>
      String(c[0]).startsWith('Passive interception: matched first usage request'),
    );
    expect(firstHitLogs).toHaveLength(1);
  });
});
