import { describe, expect, it, vi } from 'vitest';
import {
  collectSessionWorkspaceClaims,
  dedupeRepoEntriesByPath,
  reportWorkspaceLifecycleInventory,
  runWorktreeCleanupForRepos,
} from '../repository-maintenance.js';
import type { WorkspaceLifecycleInventory } from '../workspace-lifecycle.js';

describe('repository maintenance', () => {
  it('uses the same cleanup policy for startup and periodic runs', () => {
    const cleanup = vi.fn();
    const run = runWorktreeCleanupForRepos({
      repoEntries: [['primary', '/repo']],
      inboxDir: '/inbox',
      cleanupPolicy: 'report',
      collectActiveWtIds: () => new Set(['active']),
      cleanup,
      onError: vi.fn(),
    });

    run('startup');
    run('periodic');

    expect(cleanup).toHaveBeenNthCalledWith(1, '/repo', '/inbox', new Set(['active']), 'report');
    expect(cleanup).toHaveBeenNthCalledWith(2, '/repo', '/inbox', new Set(['active']), 'report');
  });
});

it('runs bounded lifecycle reconciliation alongside legacy inventory and coalesces overlapping runs', async () => {
  let finish!: () => void;
  const inventory = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const onError = vi.fn();
  const run = runWorktreeCleanupForRepos({
    repoEntries: [],
    cleanupPolicy: 'report',
    collectActiveWtIds: () => new Set(),
    cleanup: vi.fn(),
    inventory,
    onError,
  });
  const first = run('startup');
  const second = run('periodic');
  expect(inventory).toHaveBeenCalledOnce();
  finish();
  await Promise.all([first, second]);
  expect(onError).not.toHaveBeenCalled();
});

it('scans a repository configured under two labels only once', () => {
  const resolvePath = (path: string) => path.replace(/\/$/, '').replace('/link', '/repo');
  expect(
    dedupeRepoEntriesByPath(
      [
        ['primary', '/repo'],
        ['mgmt', '/link/'],
        ['other', '/other'],
      ],
      resolvePath,
    ),
  ).toEqual([
    ['primary', '/repo'],
    ['other', '/other'],
  ]);
});

it('yields to the event loop while correlating many sessions with worktree records', async () => {
  let lookups = 0;
  let lookupsBeforeImmediate: number | undefined;
  setImmediate(() => {
    lookupsBeforeImmediate = lookups;
  });
  const claims = await collectSessionWorkspaceClaims({
    claims: [],
    sessions: Array.from({ length: 120 }, (_, index) => ({
      sessionId: `s-${index}`,
      cwd: null,
      isActive: false,
    })),
    repoLabels: ['primary'],
    latestWorktreePath: (sessionId) => {
      lookups++;
      return `/repo/.claude/worktrees/${sessionId}`;
    },
    yieldEvery: 50,
  });
  expect(claims).toHaveLength(120);
  expect(lookupsBeforeImmediate).toBe(50);
});

it('logs a bounded inventory summary instead of every entry', async () => {
  const root = '/repo/.claude/worktrees';
  const result: WorkspaceLifecycleInventory = {
    entries: Array.from({ length: 2000 }, (_, index) => ({
      directory: `${root}/${'x'.repeat(150)}-${index}`,
      claimId: `claim-${index}`,
      disposition: 'protected',
      reasons: ['resume-history-reference', 'lease-unreconciled'],
    })),
    truncated: false,
    diagnostics: [],
  };
  const log = vi.fn();
  await reportWorkspaceLifecycleInventory({
    roots: [root],
    claims: [],
    sessionsTruncated: true,
    inventory: async () => result,
    log,
  });
  expect(log).toHaveBeenCalledOnce();
  const [message, fields] = log.mock.calls[0];
  expect(message).toBe('workspace lifecycle inventory');
  expect(fields).not.toHaveProperty('entries');
  expect(fields).toMatchObject({ total: 2000, truncated: true, byRoot: { [root]: 2000 } });
  expect(fields.durationMs).toEqual(expect.any(Number));
  expect(JSON.stringify(fields).length).toBeLessThan(16 * 1024);
});
