/**
 * Display name for a repository directory, including conventional isolated
 * worktrees. Opaque managed workspace paths require their validated repository
 * metadata instead; this helper does not infer a repository from generated IDs.
 */
export function repositoryNameFromCwd(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/');
  const worktreeMatch = normalized.match(/^(.+)\/\.(claude|cursor)\/worktrees\//);
  const base = worktreeMatch ? worktreeMatch[1] : normalized;
  return base.split('/').filter(Boolean).at(-1) || 'unknown';
}
