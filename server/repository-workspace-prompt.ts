import type { RepositoryWorkspace } from './repository-workspaces.js';

/** Describe the retained checkout facts rather than the engine's preferred layout. */
export function repositoryWorkspacePrompt(
  cwd: string,
  workspace: Pick<RepositoryWorkspace, 'taskIdentity'>,
) {
  const topology = workspace.taskIdentity?.linkedGit
    ? 'This is a linked worktree with shared Git storage. Use TaskExecution with operation commit, this directory as cwd, and selected files for local commits; native Git writes outside this directory remain fenced.'
    : workspace.taskIdentity
      ? 'This is an independent checkout with its own Git storage. Native Git commits stay inside this directory.'
      : 'Use the assigned repository task and branch. Its Git storage layout has not been established by this context.';
  return `# Repository task workspace
${topology} Work inside ${cwd} for code edits, dependency setup and tests. Use the dedicated Mitzo integrations for network access and publication. Do not switch to the configured default repository.
`;
}
