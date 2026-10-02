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
