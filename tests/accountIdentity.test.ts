/**
 * Unit tests for the pure helpers in `src/cost/accountIdentity.ts`.
 *
 * `AccountIdentityService` itself depends on `vscode.EventEmitter` and
 * `fs.watch`, so it is NOT instantiated here.  All tests exercise the
 * exported pure functions:
 *
 *   - `parseOAuthAccount` — JSON parsing logic
 *   - `resolveIdentity`   — file-read + fallback chain
 *
 * `vscode` is mocked below so that importing the module does not fail in the
 * Node/Vitest environment (which has no real VS Code runtime).
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// ── vscode mock (hoisted before the module import below) ─────────────────────
vi.mock('vscode', () => ({
  EventEmitter: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event = (_listener: (e: unknown) => void) => ({ dispose: () => {} });
    fire(_data: unknown) {}
    dispose() {}
  },
}));

import {
  parseOAuthAccount,
  resolveIdentity,
  UNKNOWN_IDENTITY,
} from '../src/cost/accountIdentity';

// ── parseOAuthAccount ─────────────────────────────────────────────────────────

describe('parseOAuthAccount', () => {
  it('returns null for null input', () => {
    expect(parseOAuthAccount(null, 'primary')).toBeNull();
  });

  it('returns null for non-object primitives', () => {
    expect(parseOAuthAccount('string', 'primary')).toBeNull();
    expect(parseOAuthAccount(42, 'primary')).toBeNull();
    expect(parseOAuthAccount(true, 'primary')).toBeNull();
  });

  it('returns null when oauthAccount is missing', () => {
    expect(parseOAuthAccount({}, 'primary')).toBeNull();
    expect(parseOAuthAccount({ other: 'field' }, 'primary')).toBeNull();
  });

  it('returns null when oauthAccount.accountUuid is missing', () => {
    expect(parseOAuthAccount({ oauthAccount: {} }, 'primary')).toBeNull();
  });

  it('returns null when oauthAccount.accountUuid is empty string', () => {
    expect(parseOAuthAccount({ oauthAccount: { accountUuid: '' } }, 'primary')).toBeNull();
  });

  it('returns null when oauthAccount.accountUuid is not a string', () => {
    expect(parseOAuthAccount({ oauthAccount: { accountUuid: 123 } }, 'primary')).toBeNull();
    expect(parseOAuthAccount({ oauthAccount: { accountUuid: null } }, 'primary')).toBeNull();
  });

  it('returns valid identity with source=primary for a well-formed object', () => {
    const result = parseOAuthAccount(
      {
        oauthAccount: {
          accountUuid: 'uuid-abc-123',
          emailAddress: 'user@example.com',
          organizationUuid: 'org-xyz',
        },
      },
      'primary',
    );
    expect(result).toEqual({
      accountUuid: 'uuid-abc-123',
      emailAddress: 'user@example.com',
      organizationUuid: 'org-xyz',
      source: 'primary',
    });
  });

  it('returns valid identity with source=secondary', () => {
    const result = parseOAuthAccount(
      { oauthAccount: { accountUuid: 'sec-uuid' } },
      'secondary',
    );
    expect(result?.source).toBe('secondary');
    expect(result?.accountUuid).toBe('sec-uuid');
  });

  it('sets emailAddress=null when field is absent', () => {
    const result = parseOAuthAccount(
      { oauthAccount: { accountUuid: 'uuid-1' } },
      'primary',
    );
    expect(result?.emailAddress).toBeNull();
  });

  it('sets emailAddress=null when field is not a string', () => {
    const result = parseOAuthAccount(
      { oauthAccount: { accountUuid: 'uuid-1', emailAddress: 99 } },
      'primary',
    );
    expect(result?.emailAddress).toBeNull();
  });

  it('sets organizationUuid=null when field is absent', () => {
    const result = parseOAuthAccount(
      { oauthAccount: { accountUuid: 'uuid-1' } },
      'primary',
    );
    expect(result?.organizationUuid).toBeNull();
  });

  it('sets organizationUuid=null when field is not a string', () => {
    const result = parseOAuthAccount(
      { oauthAccount: { accountUuid: 'uuid-1', organizationUuid: true } },
      'primary',
    );
    expect(result?.organizationUuid).toBeNull();
  });
});

// ── resolveIdentity ───────────────────────────────────────────────────────────

describe('resolveIdentity', () => {
  let tmpDir: string;
  let primaryPath: string;
  let secondaryPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-identity-test-'));
    primaryPath = path.join(tmpDir, 'primary.json');
    secondaryPath = path.join(tmpDir, 'secondary.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── primary happy path ──────────────────────────────────────────────────

  it('returns primary identity when primary file is valid', async () => {
    fs.writeFileSync(
      primaryPath,
      JSON.stringify({
        oauthAccount: {
          accountUuid: 'prim-uuid-001',
          emailAddress: 'alice@example.com',
          organizationUuid: 'org-111',
        },
      }),
    );
    const id = await resolveIdentity(primaryPath, secondaryPath);
    expect(id.accountUuid).toBe('prim-uuid-001');
    expect(id.emailAddress).toBe('alice@example.com');
    expect(id.organizationUuid).toBe('org-111');
    expect(id.source).toBe('primary');
  });

  it('returns primary identity even when secondary file also exists', async () => {
    fs.writeFileSync(primaryPath, JSON.stringify({ oauthAccount: { accountUuid: 'prim-wins' } }));
    fs.writeFileSync(secondaryPath, JSON.stringify({ oauthAccount: { accountUuid: 'sec-loses' } }));
    const id = await resolveIdentity(primaryPath, secondaryPath);
    expect(id.accountUuid).toBe('prim-wins');
    expect(id.source).toBe('primary');
  });

  // ── secondary fallback ──────────────────────────────────────────────────

  it('falls back to secondary when primary does not exist', async () => {
    fs.writeFileSync(secondaryPath, JSON.stringify({
      oauthAccount: { accountUuid: 'sec-uuid-002', emailAddress: 'bob@example.com' },
    }));
    const id = await resolveIdentity(primaryPath, secondaryPath);
    expect(id.accountUuid).toBe('sec-uuid-002');
    expect(id.emailAddress).toBe('bob@example.com');
    expect(id.source).toBe('secondary');
  });

  it('falls back to secondary when primary lacks oauthAccount', async () => {
    fs.writeFileSync(primaryPath, JSON.stringify({ unrelated: true }));
    fs.writeFileSync(secondaryPath, JSON.stringify({
      oauthAccount: { accountUuid: 'sec-uuid-003' },
    }));
    const id = await resolveIdentity(primaryPath, secondaryPath);
    expect(id.accountUuid).toBe('sec-uuid-003');
    expect(id.source).toBe('secondary');
  });

  it('falls back to secondary when primary has oauthAccount but no accountUuid', async () => {
    fs.writeFileSync(primaryPath, JSON.stringify({ oauthAccount: {} }));
    fs.writeFileSync(secondaryPath, JSON.stringify({
      oauthAccount: { accountUuid: 'sec-uuid-004' },
    }));
    const id = await resolveIdentity(primaryPath, secondaryPath);
    expect(id.accountUuid).toBe('sec-uuid-004');
  });

  it('falls back to secondary when primary JSON is malformed', async () => {
    fs.writeFileSync(primaryPath, 'not { valid json');
    fs.writeFileSync(secondaryPath, JSON.stringify({
      oauthAccount: { accountUuid: 'sec-uuid-005' },
    }));
    const id = await resolveIdentity(primaryPath, secondaryPath);
    expect(id.accountUuid).toBe('sec-uuid-005');
    expect(id.source).toBe('secondary');
  });

  // ── unknown fallback ────────────────────────────────────────────────────

  it('returns UNKNOWN_IDENTITY when neither file exists', async () => {
    const id = await resolveIdentity(primaryPath, secondaryPath);
    expect(id.accountUuid).toBe('unknown');
    expect(id.emailAddress).toBeNull();
    expect(id.organizationUuid).toBeNull();
    expect(id.source).toBe('unknown');
  });

  it('returns UNKNOWN_IDENTITY when both files lack oauthAccount', async () => {
    fs.writeFileSync(primaryPath, JSON.stringify({}));
    fs.writeFileSync(secondaryPath, JSON.stringify({}));
    const id = await resolveIdentity(primaryPath, secondaryPath);
    expect(id).toEqual(UNKNOWN_IDENTITY);
  });

  it('returns UNKNOWN_IDENTITY when both files have malformed JSON', async () => {
    fs.writeFileSync(primaryPath, 'bad');
    fs.writeFileSync(secondaryPath, 'worse');
    const id = await resolveIdentity(primaryPath, secondaryPath);
    expect(id.source).toBe('unknown');
  });

  // ── null field handling ─────────────────────────────────────────────────

  it('returns null emailAddress when field is absent in primary', async () => {
    fs.writeFileSync(primaryPath, JSON.stringify({ oauthAccount: { accountUuid: 'uuid-x' } }));
    const id = await resolveIdentity(primaryPath, secondaryPath);
    expect(id.emailAddress).toBeNull();
  });

  it('returns null organizationUuid when field is absent in primary', async () => {
    fs.writeFileSync(primaryPath, JSON.stringify({ oauthAccount: { accountUuid: 'uuid-y' } }));
    const id = await resolveIdentity(primaryPath, secondaryPath);
    expect(id.organizationUuid).toBeNull();
  });

  // ── returned object is not the frozen UNKNOWN_IDENTITY ─────────────────

  it('returns a fresh object (not the frozen sentinel) for unknown', async () => {
    const id = await resolveIdentity(primaryPath, secondaryPath);
    expect(id).toEqual(UNKNOWN_IDENTITY);
    // Must be a copy, not the same frozen reference
    expect(id).not.toBe(UNKNOWN_IDENTITY);
  });
});
