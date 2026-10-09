import { githubRepositoryConnections } from './github-repository-connections.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AccountBinding } from '@mitzo/protocol';
import { loadAccountProfiles } from './account-profiles.js';
import { getConnectionsRuntime } from './connections-runtime.js';
import { codexPrivateDirectory } from './codex-private-path.js';
import { RepositoryWorkspaces } from './repository-workspaces.js';

let service: RepositoryWorkspaces | undefined;
export function repositoryWorkspacesEnabled() {
  return process.env.MITZO_REPOSITORY_WORKSPACES_ENABLED === '1';
}
export function repositoryWorkspaceBinding(accountId: string, model: string) {
  const profiles = loadAccountProfiles();
  const binding = profiles.resolve(accountId, model);
  if (!['openai', 'openai-codex'].includes(binding.provider))
    throw new Error('Initial repository chats require an OpenAI account');
  if (binding.provider === 'openai-codex' && profiles.codexProfile(binding).nativeAuth)
    throw new Error('Native Symposium accounts are unavailable for ordinary repository chats');
  return binding;
}
export function repositoryWorkspaceCatalog(binding: AccountBinding) {
  if (!repositoryWorkspacesEnabled()) return { available: false, repositories: [] };
  const runtime = getConnectionsRuntime();
  const connections = runtime?.store.list('operator') ?? [];
  const repositories = connections.flatMap((connection) => {
    if (
      connection.templateId !== 'github-readonly' ||
      connection.status !== 'active' ||
      !connection.desiredAccountIds.includes(binding.accountId) ||
      !connection.identity ||
      !Array.isArray(connection.publicConfig.allowedRepositories)
    )
      return [];
    return [
      ...new Set(
        connection.publicConfig.allowedRepositories
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.toLowerCase()),
      ),
    ]
      .filter(
        (repository) =>
          githubRepositoryConnections(connections, binding.accountId, repository).length === 1,
      )
      .map((repository) => ({ connectionId: connection.id, label: connection.label, repository }));
  });
  return { available: true, repositories };
}
/** Lazy, explicit enrollment: importing the app performs no source acquisition or metadata writes. */
export function getRepositoryWorkspaces(readOnly = false) {
  if (!repositoryWorkspacesEnabled() && !readOnly)
    throw new Error('Repository-backed chats are not enabled');
  if (
    readOnly &&
    !service &&
    !existsSync(join(codexPrivateDirectory(), 'repository-sources', 'workspaces.db'))
  )
    throw new Error('Repository preparation state is unavailable');
  service ??= new RepositoryWorkspaces(join(codexPrivateDirectory(), 'repository-sources'), {
    authorize: async (binding, connectionId, repository, signal) => {
      if (!isDeepStrictEqual(repositoryWorkspaceBinding(binding.accountId, binding.model), binding))
        throw new Error('Repository AI account changed');
      const runtime = getConnectionsRuntime();
      const connection = runtime?.store.get(connectionId);
      if (
        !runtime ||
        !connection ||
        connection.templateId !== 'github-readonly' ||
        connection.status !== 'active' ||
        !connection.desiredAccountIds.includes(binding.accountId) ||
        !Array.isArray(connection.publicConfig.allowedRepositories) ||
        !connection.publicConfig.allowedRepositories.some(
          (value) => typeof value === 'string' && value.toLowerCase() === repository,
        ) ||
        githubRepositoryConnections(runtime.store.list('operator'), binding.accountId, repository)
          .length !== 1 ||
        !(await runtime.verifyGithubPublishingIdentity?.(connectionId, signal, connection.revision))
      )
        throw new Error(
          'Selected GitHub connection does not authorize this repository and account',
        );
      const current = runtime.store.get(connectionId);
      if (
        current?.revision !== connection.revision ||
        current.status !== 'active' ||
        githubRepositoryConnections(runtime.store.list('operator'), binding.accountId, repository)
          .length !== 1
      )
        throw new Error('GitHub connection changed');
      return { revision: connection.revision };
    },
  });
  return service;
}

export function readRepositoryWorkspaceForConversation(
  conversationId: string,
  expectedWorkspaceId?: string | null,
) {
  const directory = join(codexPrivateDirectory(), 'repository-sources');
  if (!existsSync(join(directory, 'workspaces.db'))) {
    if (expectedWorkspaceId)
      throw new Error('Repository claim ledger is unavailable; preserve the conversation');
    return undefined;
  }
  const record = getRepositoryWorkspaces(true).getForConversation(conversationId);
  if (expectedWorkspaceId && record?.id !== expectedWorkspaceId)
    throw new Error('Repository claim ledger is unavailable or changed; preserve the conversation');
  return record;
}
