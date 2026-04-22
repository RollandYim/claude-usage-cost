import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { KEYCHAIN_SERVICE, KEYCHAIN_TIMEOUT_MS } from './config';
import type { UsageStore } from './usageStore';
import type { PollingService } from './pollingService';

// Reads the Claude Code OAuth token from macOS Keychain.
// Returns the accessToken string, or null if unavailable / not on macOS.
export async function getKeychainToken(logger: vscode.OutputChannel): Promise<string | null> {
  if (process.platform !== 'darwin') {
    logger.appendLine('Keychain bootstrap skipped: not macOS');
    return null;
  }

  return new Promise((resolve) => {
    const child = execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: KEYCHAIN_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err || stderr.trim()) {
          logger.appendLine(`Keychain lookup failed: ${err?.message ?? stderr.trim()}`);
          resolve(null);
          return;
        }
        try {
          const json = JSON.parse(stdout.trim()) as Record<string, unknown>;
          // Claude Code stores credentials as:
          //   { "claudeAiOauth": { "accessToken": "...", ... }, "mcpOAuth": {...} }
          // Older/alternative formats may expose accessToken at the root.
          const nested =
            typeof json.claudeAiOauth === 'object' && json.claudeAiOauth !== null
              ? (json.claudeAiOauth as Record<string, unknown>)
              : null;
          const token =
            (nested && typeof nested.accessToken === 'string' ? nested.accessToken : null) ??
            (typeof json.accessToken === 'string' ? json.accessToken : null);
          if (!token) {
            logger.appendLine(
              `Keychain entry found but accessToken is missing (top-level keys: ${Object.keys(json).join(', ')})`,
            );
          } else {
            logger.appendLine(
              `Keychain token retrieved (len=${token.length}, prefix=${token.slice(0, 15)}...)`,
            );
          }
          resolve(token);
        } catch (parseErr) {
          logger.appendLine(`Keychain entry is not valid JSON: ${parseErr}`);
          resolve(null);
        }
      },
    );
    // execFile timeout option handles kill, but resolve null on unexpected close
    child.on('error', (err) => {
      logger.appendLine(`Keychain execFile error: ${err.message}`);
      resolve(null);
    });
  });
}

// Bootstraps initial usage data on activation:
//   1. Retrieves OAuth token from macOS Keychain.
//   2. Registers it with the polling service via setToken().
//   3. Triggers an immediate refreshNow() so PollingService fetches and writes store.
//   4. Returns the token (for caller awareness), or null on any failure.
//
// _store is retained in the signature per tasks.md contract; actual store mutation
// happens inside pollingService.refreshNow() to avoid duplicating HTTP logic.
export async function bootstrapFromKeychain(
  _store: UsageStore,
  pollingService: PollingService,
  logger: vscode.OutputChannel,
): Promise<string | null> {
  const token = await getKeychainToken(logger);
  if (!token) {
    logger.appendLine('bootstrapFromKeychain: no token — will rely on fallback/diagnostics');
    return null;
  }

  try {
    pollingService.setToken(token);
    logger.appendLine('bootstrapFromKeychain: token registered, calling refreshNow()');
    await pollingService.refreshNow();
    logger.appendLine('Keychain bootstrap completed');
    return token;
  } catch (err) {
    logger.appendLine(`bootstrapFromKeychain error: ${err}`);
    return null;
  }
}
