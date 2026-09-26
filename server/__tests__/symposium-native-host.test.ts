import { chmodSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeSymposiumNativeHost } from '../symposium-native-host.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function privateRoot() {
  const root = mkdtempSync(join(tmpdir(), 'symposium-host-'));
  roots.push(root);
  return root;
}

describe('native Symposium host startup', () => {
  it('quarantines unsettled claims on boot without contacting a sandbox', () => {
    const directory = join(privateRoot(), 'attempts');
    const first = initializeSymposiumNativeHost(directory);
    first.registry.reserve({
      claimToken: 'claim-1',
      sessionId: 'session-1',
      sandbox: { sandboxName: 'sandbox1', workdir: '/sandbox/workspaces/mgmt' },
    });
    first.registry.close();

    const restarted = initializeSymposiumNativeHost(directory);
    expect(restarted.quarantinedClaims).toEqual(['claim-1']);
    expect(restarted.registry.get('claim-1')?.state).toBe('uncertain');
    expect(() => restarted.registry.assertSandboxAvailable('sandbox1')).toThrow(/quarantined/);
    restarted.registry.close();
  });

  it('requires an explicit private host directory outside the sandbox', () => {
    expect(() => initializeSymposiumNativeHost('relative')).toThrow(/absolute host path/);
    expect(() => initializeSymposiumNativeHost('/sandbox/.symposium-control')).toThrow(
      /shared sandbox/,
    );
    const root = privateRoot();
    const publicDir = join(root, 'public');
    const host = initializeSymposiumNativeHost(publicDir);
    host.registry.close();
    chmodSync(publicDir, 0o755);
    expect(() => initializeSymposiumNativeHost(publicDir)).toThrow(/not private/);
    const symlink = join(root, 'link');
    symlinkSync(publicDir, symlink);
    expect(() => initializeSymposiumNativeHost(symlink)).toThrow(/not private/);
  });
});
