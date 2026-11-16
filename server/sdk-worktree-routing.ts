import type { OnDemandCreateFn } from '@mitzo/harness';

export const REPOSITORY_TASK_CLONE_HINT =
  'This chat can write only inside its current workspace. To work on another repository, ' +
  'clone it there, for example `gh repo clone OWNER/REPO .claude/repository-tasks/<name>`, ' +
  'and work in that clone.';

/** Worktree-guard wiring for SDK chats. An OS-sandboxed ordinary SDK launch
 * freezes its write roots (launch cwd, scratch, account) at spawn, so an
 * on-demand worktree in another configured repository would be created where
 * the provider cannot write. Such chats get a plain refusal with the in-workspace
 * clone route instead; every other route keeps its existing behaviour. */
export function sdkWorktreePermissionOptions(input: {
  repositoryWorkspace: boolean;
  ordinarySdk: boolean;
  osSandboxed: boolean;
  createOnDemand: () => OnDemandCreateFn;
}): { onDemandCreate?: OnDemandCreateFn; outOfRootHint?: string } {
  if (input.repositoryWorkspace && !input.ordinarySdk) return {};
  if (input.ordinarySdk && input.osSandboxed) return { outOfRootHint: REPOSITORY_TASK_CLONE_HINT };
  return { onDemandCreate: input.createOnDemand() };
}
