import * as diagnosticsChannel from 'diagnostics_channel';
import type * as http from 'http';
import * as vscode from 'vscode';
import { DIAGNOSTICS_URL_PATTERN, MAX_INTERCEPT_BODY_BYTES } from './config';
import type { UsageStore } from './usageStore';

type DiagnosticsHandler = (message: unknown, name: string | symbol) => void;

/**
 * Passively observes every outbound Node `http` client request and, when the
 * Claude Code client queries the Anthropic usage endpoint, taps the response
 * body to keep `UsageStore` in sync — without ever issuing our own HTTP call.
 *
 * Uses Node's native diagnostics channels (`http.client.request.start` and
 * `http.client.response.finish`) rather than the undici-specific
 * `undici:request:create`, because Claude Code makes native `https` calls
 * and the response body must be tapped to get the usage JSON.
 */
export class DiagnosticsInterceptor implements vscode.Disposable {
  private readonly _pendingRequests = new WeakSet<http.ClientRequest>();
  private readonly _requestHandler: DiagnosticsHandler;
  private readonly _responseHandler: DiagnosticsHandler;
  private _disposed = false;
  private _loggedFirstIntercept = false;

  constructor(
    private readonly store: UsageStore,
    private readonly logger: vscode.OutputChannel,
  ) {
    this._requestHandler = (msg: unknown) => {
      try {
        const m = msg as { request?: http.ClientRequest };
        const request = m?.request;
        if (!request) return;
        const path = typeof request.path === 'string' ? request.path : '';
        const hostHeader = request.getHeader?.('host');
        const host = typeof hostHeader === 'string' ? hostHeader : '';
        if (!path.includes(DIAGNOSTICS_URL_PATTERN)) return;
        if (!host.includes('anthropic.com')) return;
        this._pendingRequests.add(request);
        if (!this._loggedFirstIntercept) {
          this._loggedFirstIntercept = true;
          this.logger.appendLine(
            `Passive interception: matched first usage request from ${host}${path}`,
          );
        }
      } catch (err) {
        // Never break Claude Code's HTTP pipeline over a diagnostics error.
        this.logger.appendLine(`Passive interception: request handler error (ignored): ${err}`);
      }
    };

    this._responseHandler = (msg: unknown) => {
      try {
        const m = msg as { request?: http.ClientRequest; response?: http.IncomingMessage };
        const request = m?.request;
        const response = m?.response;
        if (!request || !response) return;
        if (!this._pendingRequests.has(request)) return;
        this._pendingRequests.delete(request);
        if (response.statusCode !== 200) {
          this.logger.appendLine(
            `Passive interception: non-200 response (status=${response.statusCode}) — skipping body tap`,
          );
          return;
        }
        this._tapResponseBody(response);
      } catch (err) {
        this.logger.appendLine(`Passive interception: response handler error (ignored): ${err}`);
      }
    };

    try {
      diagnosticsChannel.subscribe('http.client.request.start', this._requestHandler);
      diagnosticsChannel.subscribe('http.client.response.finish', this._responseHandler);
      this.logger.appendLine('Passive interception is active');
    } catch (err) {
      this.logger.appendLine(`Passive interception failed to subscribe: ${err}`);
    }
  }

  /**
   * Register independent `data` / `end` listeners on the response to accumulate
   * the body (capped at `MAX_INTERCEPT_BODY_BYTES`) and feed it to
   * `UsageStore.update()`.  Each listener is wrapped in try/catch so any error
   * in our code never prevents Claude Code's own listeners from running.
   */
  private _tapResponseBody(res: http.IncomingMessage): void {
    let body = '';
    let oversize = false;

    res.on('data', (chunk: Buffer | string) => {
      try {
        if (!oversize) {
          const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          if (body.length + str.length > MAX_INTERCEPT_BODY_BYTES) {
            oversize = true;
            this.logger.appendLine(
              `Passive interception: response body exceeds ${MAX_INTERCEPT_BODY_BYTES} bytes — discarding`,
            );
          } else {
            body += str;
          }
        }
      } catch {
        // swallow — never break Claude Code's own data handler
      }
    });

    res.on('end', () => {
      try {
        if (!oversize && body.length > 0) {
          const parsed: unknown = JSON.parse(body);
          this.store.update(parsed);
          this.logger.appendLine(
            'Passive interception: usage data updated from response body',
          );
        }
      } catch (err) {
        this.logger.appendLine(
          `Passive interception: JSON parse error (ignored): ${err}`,
        );
      }
    });
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    try {
      diagnosticsChannel.unsubscribe('http.client.request.start', this._requestHandler);
      diagnosticsChannel.unsubscribe('http.client.response.finish', this._responseHandler);
    } catch {
      // channel may already be torn down during VS Code shutdown
    }
  }
}
