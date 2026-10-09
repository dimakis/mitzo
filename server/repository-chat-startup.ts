import type { AccountBinding } from '@mitzo/protocol';
export interface RepositoryChatWorkspace {
  id: string;
  repository: string;
  baseBranch: string;
  baseOid: string;
  featureBranch: string;
  directory?: string;
  seed?: string;
  sandbox?: boolean;
  binding?: AccountBinding;
}
export async function selectRepositoryChatWorkspace(
  options: {
    repositoryWorkspaceId?: string;
    conversationId: string;
    resume?: boolean;
    binding: AccountBinding;
    sandbox: boolean;
    taskRoot: string;
  },
  deps: {
    getForConversation(id: string): RepositoryChatWorkspace | undefined;
    claim(
      id: string,
      binding: AccountBinding,
      conversationId: string,
      taskRoot: string,
      sandbox: boolean,
    ): Promise<RepositoryChatWorkspace>;
  },
) {
  if (options.resume && options.repositoryWorkspaceId)
    throw new Error('Repository selection cannot replace an existing conversation workspace');
  if (options.repositoryWorkspaceId)
    return deps.claim(
      options.repositoryWorkspaceId,
      options.binding,
      options.conversationId,
      options.taskRoot,
      options.sandbox,
    );
  return options.resume ? deps.getForConversation(options.conversationId) : undefined;
}
export function repositoryChatContext(workspace: RepositoryChatWorkspace | undefined) {
  return workspace
    ? `Mitzo repository workspace ${workspace.id}: ${workspace.repository}. Starting branch ${workspace.baseBranch}, pinned commit ${workspace.baseOid}; task branch ${workspace.featureBranch}. Work in the supplied task workspace. Source acquisition did not install dependencies or run project setup.\n\n`
    : '';
}
