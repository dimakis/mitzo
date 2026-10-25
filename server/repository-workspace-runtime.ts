import {
  captureOrdinaryRepositoryPreparation,
  assertOrdinaryRepositoryPreparation,
  assertOrdinarySilentPreparationAuthority,
} from './ordinary-repository-preparation-authority.js';
import { githubRepositoryConnections } from './github-repository-connections.js';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadRepoConfig } from './repo-config.js';
import type { AccountBinding } from '@mitzo/protocol';
import { loadAccountProfiles } from './account-profiles.js';
import { getConnectionsRuntime } from './connections-runtime.js';
import { codexPrivateDirectory } from './codex-private-path.js';
import { RepositoryWorkspaces } from './repository-workspaces.js';

let service: RepositoryWorkspaces | undefined;
let idleReleased = false;
/** Release only the existing idle singleton; never create persistence to close it. */
export function closeIdleRepositoryWorkspaces(): void {
  if (!service) return;
  service.closeIdle();
  idleReleased = true;
}
export function repositoryWorkspacesEnabled() {
  return process.env.MITZO_REPOSITORY_WORKSPACES_ENABLED === '1';
}
export function repositoryWorkspaceBinding(accountId: string, model: string) {
  const profiles = loadAccountProfiles();
  const binding = profiles.resolve(accountId, model);
  if (
    !['openai', 'openai-codex'].includes(binding.provider) &&
    !(
      binding.provider === 'anthropic-vertex' &&
      process.env.MITZO_ORDINARY_LOCAL_VERTEX_ENABLED === '1' &&
      profiles
        .ordinaryLocalVertexInventory()
        .some(
          (entry) =>
            entry.account.accountId === binding.accountId &&
            entry.account.profileRevision === binding.profileRevision,
        )
    ) &&
    !(
      binding.provider === 'google-vertex' &&
      process.env.MITZO_ORDINARY_LOCAL_GEMINI_ENABLED === '1' &&
      profiles
        .ordinaryLocalGeminiInventory()
        .some(
          (entry) =>
            entry.account.accountId === binding.accountId &&
            entry.account.profileRevision === binding.profileRevision,
        )
    )
  )
    throw new Error('Selected account is unavailable for repository chats');
  if (binding.provider === 'openai-codex' && profiles.codexProfile(binding).nativeAuth)
    throw new Error('Native Symposium accounts are unavailable for ordinary repository chats');
  return binding;
}
export function configuredLocalRepositories(): Readonly<Record<string, string>> {
  const base = process.env.REPO_PATH;
  return base ? { ...loadRepoConfig(base).repos, primary: base } : {};
}
function localRepositoryWorkspacesEnabled() {
  return ['CODEX', 'RESPONSES', 'VERTEX', 'GEMINI'].some(
    (harness) => process.env[`MITZO_ORDINARY_LOCAL_${harness}_ENABLED`] === '1',
  );
}
export function repositoryWorkspaceCatalog(binding: AccountBinding, runOn?: 'local' | 'openshell') {
  if (runOn === 'local')
    return {
      location: 'local',
      available: localRepositoryWorkspacesEnabled(),
      repositories: localRepositoryWorkspacesEnabled()
        ? Object.entries(configuredLocalRepositories())
            .filter(([id]) => /^[A-Za-z0-9._-]+$/.test(id))
            .map(([repositoryId, path]) => ({
              repositoryId,
              connectionId: 'local',
              repository: `local/${repositoryId.toLowerCase()}`,
              label: basename(path),
            }))
        : [],
    };
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
function workspaceOwner(readOnly = false, ordinary = false, local = false) {
  if (idleReleased) throw Error('Repository workspace owner released');
  if (
    !readOnly &&
    (local
      ? !localRepositoryWorkspacesEnabled()
      : ordinary
        ? process.env.MITZO_ORDINARY_LOCAL_CODEX_ENABLED !== '1' &&
          process.env.MITZO_ORDINARY_LOCAL_VERTEX_ENABLED !== '1' &&
          process.env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED !== '1'
        : !repositoryWorkspacesEnabled())
  )
    throw new Error(
      ordinary
        ? 'Ordinary local workspaces are not enabled'
        : 'Repository-backed chats are not enabled',
    );
  if (
    readOnly &&
    !service &&
    !existsSync(join(codexPrivateDirectory(), 'repository-sources', 'workspaces.db'))
  )
    throw new Error('Repository preparation state is unavailable');
  service ??= new RepositoryWorkspaces(join(codexPrivateDirectory(), 'repository-sources'), {
    localRepositories: configuredLocalRepositories,
    ordinaryPreparation: {
      capture: captureOrdinaryRepositoryPreparation,
      assert: assertOrdinaryRepositoryPreparation,
      assertSilent: assertOrdinarySilentPreparationAuthority,
    },
    authorize: async (binding, connectionId, repository, signal) => {
      const profiles = loadAccountProfiles();
      profiles.resumeRouting(binding);
      if (
        (!['openai', 'openai-codex'].includes(binding.provider) &&
          !(
            binding.provider === 'anthropic-vertex' &&
            process.env.MITZO_ORDINARY_LOCAL_VERTEX_ENABLED === '1' &&
            profiles
              .ordinaryLocalVertexInventory()
              .some(
                (entry) =>
                  entry.account.accountId === binding.accountId &&
                  entry.account.profileRevision === binding.profileRevision,
              )
          ) &&
          !(
            binding.provider === 'google-vertex' &&
            process.env.MITZO_ORDINARY_LOCAL_GEMINI_ENABLED === '1' &&
            profiles
              .ordinaryLocalGeminiInventory()
              .some(
                (entry) =>
                  entry.account.accountId === binding.accountId &&
                  entry.account.profileRevision === binding.profileRevision,
              )
          )) ||
        (binding.provider === 'openai-codex' && profiles.codexRoutingProfile(binding).nativeAuth)
      )
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
      return {
        revision: connection.revision,
        allowedBaseBranches: Array.isArray(current.publicConfig.allowedBaseBranches)
          ? current.publicConfig.allowedBaseBranches
          : [],
      };
    },
  });
  return service;
}

export function readRepositoryWorkspaceForConversation(
  conversationId: string,
  expectedWorkspaceId?: string | null,
) {
  if (idleReleased) throw Error('Repository workspace owner released');
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

/** Existing repository callers keep their original enrollment gate. */
export function getRepositoryWorkspaces(readOnly = false) {
  return workspaceOwner(readOnly);
}
/** Source review reads existing custody without enrolling another workspace. */
export function getRepositoryWorkspaceCustody() {
  return getRepositoryWorkspaces(true);
}
/** Local selection reuses configured checkouts and the existing workspace ledger. */
export function getLocalRepositoryWorkspaces() {
  return workspaceOwner(false, false, true);
}
/** Same allocation/custody owner and SQLite, without requiring a Git feature grant. */
export function getOrdinaryWorkspaces(readOnly = false) {
  return workspaceOwner(readOnly, true);
}
