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

const sandbox = { sandboxName: 'symposium1', workdir: '/sandbox/workspaces/mgmt' };
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

  it('refuses a registry outside a private host directory', () => {
    expect(() => new SymposiumAttemptRegistry('/private/tmp/public-claims.db')).toThrow(
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
});
