import Database from 'better-sqlite3';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SymposiumAttemptRegistry } from '../symposium-attempt-registry.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function registryPath() {
  const dir = mkdtempSync(join(tmpdir(), 'symposium-attempt-'));
  dirs.push(dir);
  return join(dir, 'claims.db');
}

const sandbox = {
  sandboxName: 'symposium1',
  workdir: '/sandbox/workspaces/mgmt',
  cli: 'openshell',
  gateway: 'test-gateway',
  workspace: 'test-workspace',
  gatewayInsecure: false,
};
const claim = { claimToken: 'claim-1', sessionId: 'session-1', sandbox };

describe('durable native attempt registry', () => {
  it('reserves before launch and keeps a sandbox quarantined after restart', () => {
    const path = registryPath();
    const first = new SymposiumAttemptRegistry(path);
    first.reserve(claim);
    expect(first.pending()).toEqual([
      { claimToken: claim.claimToken, sessionId: claim.sessionId, ...sandbox, state: 'reserved' },
    ]);
    expect(() => first.reserve({ ...claim, claimToken: 'claim-2' })).toThrow(/quarantined/);
    first.close();

    const reopened = new SymposiumAttemptRegistry(path);
    expect(reopened.get(claim.claimToken)?.sandboxName).toBe(sandbox.sandboxName);
    expect(() => reopened.assertSandboxAvailable(sandbox.sandboxName)).toThrow(/quarantined/);
    reopened.close();
  });

  it('keeps observer loss uncertain, then releases only after exact controller confirmation', async () => {
    const registry = new SymposiumAttemptRegistry(registryPath());
    registry.reserve(claim);
    const lostObserver = vi.fn().mockRejectedValue(new Error('observer lost'));
    await expect(registry.recover(claim.claimToken, lostObserver)).rejects.toThrow(/quarantined/);
    expect(registry.get(claim.claimToken)?.state).toBe('uncertain');
    expect(() => registry.assertSandboxAvailable(sandbox.sandboxName)).toThrow(/quarantined/);

    const exactProof = vi.fn().mockResolvedValue(undefined);
    await registry.recover(claim.claimToken, exactProof);
    expect(exactProof).toHaveBeenCalledWith(sandbox, claim.claimToken);
    expect(registry.pending()).toEqual([]);
    expect(() => registry.assertSandboxAvailable(sandbox.sandboxName)).not.toThrow();
    registry.close();
  });

  it('repeats preparation only for the same open session claim', async () => {
    const registry = new SymposiumAttemptRegistry(registryPath());
    registry.prepare(claim);
    expect(() => registry.prepare(claim)).not.toThrow();
    expect(() => registry.prepare({ ...claim, sessionId: 'other-session' })).toThrow(
      /another session/,
    );
    await registry.recover(claim.claimToken);
    expect(() => registry.prepare(claim)).toThrow(/closed/);
    const launched = { ...claim, claimToken: 'launched-claim' };
    registry.prepare(launched);
    registry.reserve(launched);
    expect(() => registry.prepare(launched)).toThrow(/already exists/);
    registry.close();
  });

  it('cannot treat a transport launch failure as a never-launched preparation', async () => {
    const confirm = vi.fn().mockRejectedValue(new Error('No exact proof'));
    const registry = new SymposiumAttemptRegistry(registryPath(), {
      launch: vi.fn(() => {
        throw new Error('Launch response lost');
      }),
      confirm,
    });
    registry.prepare(claim);
    expect(() =>
      registry.launch({ ...claim, access: 'read', command: ['/usr/bin/test-controller'] }),
    ).toThrow(/quarantined/);
    await expect(registry.recover(claim.claimToken)).rejects.toThrow(/quarantined/);
    expect(confirm).toHaveBeenCalledWith(sandbox, claim.claimToken);
    expect(registry.get(claim.claimToken)?.state).toBe('uncertain');
    registry.close();
  });

  it('refuses a registry outside a private host directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'symposium-public-attempt-'));
    dirs.push(dir);
    chmodSync(dir, 0o755);
    expect(() => new SymposiumAttemptRegistry(join(dir, 'claims.db'))).toThrow(
      /private host directory/,
    );
  });

  it('refuses an existing database made public between host starts', () => {
    const path = registryPath();
    const registry = new SymposiumAttemptRegistry(path);
    registry.close();
    chmodSync(path, 0o644);
    expect(() => new SymposiumAttemptRegistry(path)).toThrow(/file is not private/);
  });
  it('retains the exact non-default gateway route across restart and cancellation', async () => {
    const path = registryPath();
    const selected = {
      ...sandbox,
      cli: '/opt/openshell',
      gateway: 'personal',
      workspace: 'personal-only',
      gatewayEndpoint: 'https://127.0.0.1:8443',
      cliEnvironment: {
        HOME: '/private/host',
        XDG_CONFIG_HOME: '/private/config',
        PATH: '/usr/bin:/bin',
      },
      gatewayInsecure: false,
    };
    const first = new SymposiumAttemptRegistry(path);
    first.reserve({ ...claim, sandbox: selected });
    first.close();
    const confirm = vi.fn().mockResolvedValue(undefined);
    const reopened = new SymposiumAttemptRegistry(path, { launch: vi.fn() as never, confirm });
    await reopened.recover(claim.claimToken);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(selected, claim.claimToken);
    expect(reopened.get(claim.claimToken)?.state).toBe('confirmed');
    reopened.close();
  });

  it('migrates legacy claims without guessing their gateway or accepting cleanup', async () => {
    const path = registryPath();
    const old = new Database(path);
    old.exec(`CREATE TABLE symposium_native_attempts (
      claim_token TEXT PRIMARY KEY, session_id TEXT NOT NULL, sandbox_name TEXT NOT NULL,
      workdir TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); INSERT INTO symposium_native_attempts VALUES ('legacy', 'session', 'same-name', '/sandbox/workspaces/mgmt', 'reserved', 1, 1);`);
    old.close();
    chmodSync(path, 0o600);
    const confirm = vi.fn().mockResolvedValue(undefined);
    const reopened = new SymposiumAttemptRegistry(path, { launch: vi.fn() as never, confirm });
    await expect(reopened.recover('legacy')).rejects.toThrow('quarantined');
    expect(confirm).not.toHaveBeenCalled();
    expect(reopened.get('legacy')?.state).toBe('uncertain');
    expect(() => reopened.assertSandboxAvailable('same-name')).toThrow('quarantined');
    reopened.close();
  });
});
