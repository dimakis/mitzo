import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  authority: [] as string[],
  selectors: [] as string[],
  denied: ['/offline/account'],
}));
vi.mock('../account-profiles.js', () => ({
  loadAccountProfiles: () => ({ privateCodexRoots: () => [] }),
}));
vi.mock('../workspace-runtime-private-paths.js', () => ({
  workspaceRuntimeAuthorityPaths: () => state.authority,
  workspaceRuntimeSelectorEntries: () => state.selectors,
  workspaceRuntimePrivateFiles: () => [],
}));
vi.mock('../codex-private-path.js', async (original) => ({
  ...(await original<typeof import('../codex-private-path.js')>()),
  privateCodexRoots: () => state.denied,
}));
import { composeOwnedLocalNativeExecutionPolicy } from '../owned-local-codex-native-policy.js';
import type { ManagedSession } from '../session-registry.js';

it.each(['external', 'private'] as const)(
  'refuses a workspace containing the lexical selector even when its physical target is %s',
  (location) => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-native-selector-'));
    try {
      const workspace = join(root, 'task'),
        runtime = join(root, 'runtime');
      if (location === 'private') state.denied = [runtime];
      mkdirSync(workspace);
      mkdirSync(runtime);
      const target = join(runtime, 'provider');
      writeFileSync(target, 'fixture');
      const selector = join(workspace, 'provider');
      symlinkSync(target, selector);
      state.authority = [selector, target];
      state.selectors = [selector];
      const session = { cwd: workspace, mode: 'agent', worktreePaths: new Map() } as ManagedSession;
      expect(() =>
        composeOwnedLocalNativeExecutionPolicy({
          session,
          binding: { accountId: 'fixture', profileRevision: 'revision' } as never,
          assertCurrentSync: () => {},
        }),
      ).toThrow('Native workspace contains a runtime authority selector');
    } finally {
      state.authority = [];
      state.selectors = [];
      state.denied = ['/offline/account'];
      rmSync(root, { recursive: true, force: true });
    }
  },
);
