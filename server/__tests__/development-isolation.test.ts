import { describe, expect, it } from 'vitest';
import {
  resolveWorktreeCleanupPolicy,
  startupRepositoryMaintenanceEnabled,
} from '../development-isolation.js';

describe('development isolation', () => {
  it('disables repository maintenance only for an explicit non-production run', () => {
    expect(
      startupRepositoryMaintenanceEnabled({
        NODE_ENV: 'development',
        MITZO_DISABLE_REPO_MAINTENANCE: '1',
      }),
    ).toBe(false);
    expect(
      startupRepositoryMaintenanceEnabled({
        NODE_ENV: 'production',
        MITZO_DISABLE_REPO_MAINTENANCE: '1',
      }),
    ).toBe(true);
    expect(startupRepositoryMaintenanceEnabled({ NODE_ENV: 'development' })).toBe(true);
  });

  it('defaults production worktree cleanup to report-only', () => {
    expect(resolveWorktreeCleanupPolicy({ NODE_ENV: 'production' })).toBe('report');
  });

  it('requires an explicit execute policy to enable mutations', () => {
    expect(
      resolveWorktreeCleanupPolicy({
        NODE_ENV: 'production',
        MITZO_WORKTREE_CLEANUP_POLICY: 'execute',
      }),
    ).toBe('execute');
    expect(
      resolveWorktreeCleanupPolicy({
        NODE_ENV: 'production',
        MITZO_WORKTREE_CLEANUP_POLICY: 'unexpected',
      }),
    ).toBe('report');
  });
});
