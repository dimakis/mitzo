import type { WorktreeCleanupPolicy } from './development-isolation.js';
import type { WorktreeCleanupSummary } from './worktree.js';

type Cleanup = (
  repoPath: string,
  inboxDir: string | undefined,
  activeWtIds: ReadonlySet<string>,
  policy: WorktreeCleanupPolicy,
) => WorktreeCleanupSummary | void;

interface WorktreeCleanupRunnerOptions {
  repoEntries: ReadonlyArray<readonly [string, string]>;
  inboxDir?: string;
  cleanupPolicy: WorktreeCleanupPolicy;
  collectActiveWtIds: () => ReadonlySet<string>;
  cleanup: Cleanup;
  onError: (label: string, phase: 'startup' | 'periodic', error: unknown) => void;
}

/** Build the single runner used by startup and periodic cleanup. */
export function runWorktreeCleanupForRepos(options: WorktreeCleanupRunnerOptions) {
  return (phase: 'startup' | 'periodic'): void => {
    const activeWtIds = options.collectActiveWtIds();
    for (const [label, repoPath] of options.repoEntries) {
      try {
        options.cleanup(repoPath, options.inboxDir, activeWtIds, options.cleanupPolicy);
      } catch (error: unknown) {
        options.onError(label, phase, error);
      }
    }
  };
}
