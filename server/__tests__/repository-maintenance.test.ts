import { describe, expect, it, vi } from 'vitest';
import { runWorktreeCleanupForRepos } from '../repository-maintenance.js';

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
