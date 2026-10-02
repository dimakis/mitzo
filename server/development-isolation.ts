/** Repository maintenance can be disabled only for an explicit non-production
 * development run. Production ignores the escape hatch.
 */
export function startupRepositoryMaintenanceEnabled(env: NodeJS.ProcessEnv = process.env) {
  return !(env.NODE_ENV !== 'production' && env.MITZO_DISABLE_REPO_MAINTENANCE === '1');
}

export type WorktreeCleanupPolicy = 'report' | 'execute';

/**
 * Worktree cleanup is contained by default in every environment. Restoring
 * mutations requires a deliberate configuration change that can be reviewed
 * independently from repository/session reconciliation.
 */
export function resolveWorktreeCleanupPolicy(
  env: NodeJS.ProcessEnv = process.env,
): WorktreeCleanupPolicy {
  return env.MITZO_WORKTREE_CLEANUP_POLICY === 'execute' ? 'execute' : 'report';
}
