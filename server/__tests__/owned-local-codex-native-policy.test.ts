import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  authority: [] as string[],
  selectors: [] as string[],
  denied: ['/offline/account'],
  configured: [] as string[],
  broken: false,
  loads: 0,
}));
vi.mock('../account-profiles.js', () => ({
  loadAccountProfiles: () => {
    state.loads++;
    return { privateCodexRoots: () => state.denied };
  },
}));
vi.mock('../knowledge-library-private-paths.js', () => ({
  configuredKnowledgeLibraryPrivatePaths: () => {
    if (state.broken) throw Error('Fixture configuration unreadable');
    return state.configured;
  },
}));
vi.mock('../workspace-runtime-private-paths.js', () => ({
  workspaceRuntimeAuthorityPaths: () => state.authority,
  workspaceRuntimeSelectorEntries: () => state.selectors,
  workspaceRuntimePrivateFiles: () => [],
}));
import * as privatePaths from '../codex-private-path.js';
import { composeOwnedLocalNativeExecutionPolicy } from '../owned-local-codex-native-policy.js';
import type { ManagedSession } from '../session-registry.js';

it('takes one fresh complete denial snapshot per composition, retaining aliases and observed retired roots', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-native-snapshot-')));
  const snapshot = vi.spyOn(privatePaths, 'privateCodexPathSnapshot');
  try {
    const workspace = join(root, 'task'),
      first = join(root, 'first-private'),
      next = join(root, 'next-private'),
      alias = join(root, 'private-alias'),
      safe = join(root, 'safe-authority');
    for (const directory of [workspace, first, next, safe]) mkdirSync(directory);
    symlinkSync(first, alias);
    state.configured = [first];
    state.denied = [];
    state.authority = [alias, safe];
    state.loads = 0;
    const guard = vi.fn();
    const input = {
      session: { cwd: workspace, mode: 'agent', worktreePaths: new Map() } as ManagedSession,
      binding: { accountId: 'fixture', profileRevision: 'revision' } as never,
      assertCurrentSync: guard,
    };
    const firstPolicy = composeOwnedLocalNativeExecutionPolicy(input);
    expect(firstPolicy.deniedRoots).toContain(first);
    expect(firstPolicy.writeProtectedRoots).toEqual([safe]);
    expect(firstPolicy.readableRoots).toEqual(['/']);
    expect(firstPolicy.workspaceRoots).toEqual([workspace]);
    state.configured = []; // Removing enrollment never publishes observed storage.
    state.denied = [next]; // A new account root is captured by the NEXT composition.
    const nextPolicy = composeOwnedLocalNativeExecutionPolicy(input);
    expect(nextPolicy.deniedRoots).toEqual(expect.arrayContaining([first, next]));
    expect(nextPolicy.writeProtectedRoots).toEqual([safe]);
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(state.loads).toBe(2);
    expect(guard).toHaveBeenCalledTimes(4);
    state.broken = true;
    expect(() => composeOwnedLocalNativeExecutionPolicy(input)).toThrow(
      'Fixture configuration unreadable',
    );
  } finally {
    snapshot.mockRestore();
    state.authority = [];
    state.configured = [];
    state.denied = ['/offline/account'];
    state.broken = false;
    rmSync(root, { recursive: true, force: true });
  }
});

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
