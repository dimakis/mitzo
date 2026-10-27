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
  inventory?: () => Promise<void>;
  onError: (label: string, phase: 'startup' | 'periodic', error: unknown) => void;
}

/** Build the single runner used by startup and periodic cleanup. */
export function runWorktreeCleanupForRepos(options: WorktreeCleanupRunnerOptions) {
  let pendingInventory: Promise<void> | undefined;
  return (phase: 'startup' | 'periodic'): Promise<void> => {
    const activeWtIds = options.collectActiveWtIds();
    for (const [label, repoPath] of options.repoEntries) {
      try {
        options.cleanup(repoPath, options.inboxDir, activeWtIds, options.cleanupPolicy);
      } catch (error: unknown) {
        options.onError(label, phase, error);
      }
    }
    if (options.inventory && !pendingInventory) {
      const inventory = options.inventory;
      // Start now, coalesce later ticks, and report failures without allowing a
      // rejected fire-and-forget task to escape the maintenance owner.
      try {
        pendingInventory = inventory()
          .catch((error: unknown) => {
            options.onError('workspace lifecycle inventory', phase, error);
          })
          .finally(() => {
            pendingInventory = undefined;
          });
      } catch (error: unknown) {
        options.onError('workspace lifecycle inventory', phase, error);
      }
    }
    return pendingInventory ?? Promise.resolve();
  };
}
