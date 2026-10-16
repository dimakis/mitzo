import {
  buildPermissionHandler,
  checkSkillPolicy,
  effectivePermissionMode,
  type ManagedSession,
  type SessionRegistry,
  type ToolDefinition,
} from '@mitzo/harness';
import { randomUUID } from 'node:crypto';
import { loadAccountProfiles } from './account-profiles.js';
import { getConnectionsRuntime } from './connections-runtime.js';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { canonicalRepositorySelection } from './github-repository-source.js';
import {
  getRepositoryWorkspaces,
  repositoryWorkspaceBinding,
  repositoryWorkspaceCatalog,
  repositoryWorkspacesEnabled,
} from './repository-workspace-runtime.js';
import type { RepositoryChatPreparation } from './repository-workspaces.js';

export const REPOSITORY_CHAT_INSTRUCTIONS =
  '\nFor repository work, call ListRepositories then PrepareRepositoryChat. If the requested repository is missing, call RequestRepositoryAccess to ask the user to confirm adding it to their existing GitHub connection, then prepare the repository chat. Never ask for credentials in chat. The user reviews the draft to start a separate chat. Call GetRepositoryChatPreparation once to recover a missing ID; omit preparationId. Never repeat preparation or repeatedly poll.\n';

export const repositoryChatSchemas = {
  ListRepositories: z.strictObject({}),
  RequestRepositoryAccess: z.strictObject({ repository: z.string().min(1).max(512) }),
  PrepareRepositoryChat: z.strictObject({
    repository: z.string().min(1).max(512),
    prompt: z
      .string()
      .min(1)
      .max(8000)
      .refine((value) => value.trim().length > 0),
  }),
  GetRepositoryChatPreparation: z.strictObject({ preparationId: z.uuid().optional() }),
};
const descriptions = {
  ListRepositories:
    'Discover repositories authorized for this chat’s current AI account. Returns repository names and connection labels, without credentials or filesystem paths.',
  RequestRepositoryAccess:
    'Ask the user to confirm adding a repository to the existing managed GitHub connection for this chat’s AI account. Supply owner/repository or its canonical GitHub HTTPS URL. The confirmation shows all affected accounts and allowed base branches. Reuses existing credentials; never supply secrets. Does not start a chat or grant publishing access. Requires Agent or Auto mode.',
  PrepareRepositoryChat:
    'Prepare a separate repository chat for a user-requested task. Supply only an authorized repository name or canonical GitHub HTTPS URL and the task prompt. Returns a draft review link; the user starts the new chat. Does not switch the current workspace, grant integration access, execute the task, or publish changes. Requires Agent or Auto mode.',
  GetRepositoryChatPreparation:
    'Read a repository-chat draft prepared by this source chat and its current AI account. Omit preparationId to recover the latest owned draft after a lost response. Returns public preparation status and the review link. Do not repeat preparation or repeatedly poll.',
};
export const repositoryChatToolDefinitions: ToolDefinition[] = Object.entries(
  repositoryChatSchemas,
).map(([name, schema]) => ({
  name,
  description: descriptions[name as keyof typeof descriptions],
  input_schema: z.toJSONSchema(schema),
}));

function publicPreparation(value: RepositoryChatPreparation) {
  const {
    id,
    sourceConversationId,
    repository,
    baseBranch,
    baseOid,
    featureBranch,
    state,
    accountId,
    model,
    prompt,
    setupUrl,
    conversationId,
  } = value;
  return {
    id,
    sourceConversationId,
    repository,
    baseBranch,
    baseOid,
    featureBranch,
    state,
    accountId,
    model,
    prompt,
    setupUrl,
    ...(conversationId ? { conversationId } : {}),
  };
}

export function sessionRepositoryTools(
  sessionId: string,
  session: ManagedSession,
  registry: SessionRegistry,
  toolPrefix = '',
  assertRuntimeCurrent?: () => Promise<void>,
  assertRuntimeCurrentSync?: () => void,
) {
  const allowed = (name: string) => {
    assertRuntimeCurrentSync?.();
    const owner = registry.findBySessionId(sessionId);
    return (
      !!owner &&
      owner.session === session &&
      !session.abortController.signal.aborted &&
      !registry.isClosingOut(owner.clientId) &&
      !registry.isUserClose(owner.clientId) &&
      // iOS suspension buffers transport events; it does not revoke the running
      // turn's authority to prepare a draft. Starting that draft still needs Send.
      checkSkillPolicy(registry, owner.clientId, toolPrefix + name) !== 'deny'
    );
  };
  const unavailable = () => ({
    content:
      'Repository tools are unavailable under current session permissions. Continue in the owning active chat.',
    isError: true,
  });
  const askRemedy = () => ({
    content:
      'Repository preparation requires Agent or Auto mode. Change the chat mode, then retry the requested repository task.',
    isError: true,
  });
  return {
    definitions: repositoryChatToolDefinitions,
    async execute(
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<{ content: string; isError: boolean } | undefined> {
      if (!Object.hasOwn(repositoryChatSchemas, name)) return undefined;
      if (signal.aborted || !allowed(name)) return unavailable();
      const parsed =
        repositoryChatSchemas[name as keyof typeof repositoryChatSchemas].safeParse(input);
      if (!parsed.success) return { content: 'Invalid repository tool input', isError: true };
      const changesAccess = name === 'RequestRepositoryAccess';
      if (
        (name === 'PrepareRepositoryChat' || changesAccess) &&
        effectivePermissionMode(session) === 'ask'
      )
        return askRemedy();
      if (!repositoryWorkspacesEnabled())
        return {
          content: 'Repository chats are unavailable in this deployment.',
          isError: true,
        };
      if (!session.accountBinding)
        return {
          content:
            'Repository chats require a selected ordinary OpenAI account. Select a supported account and retry.',
          isError: true,
        };
      const liveBinding = structuredClone(session.accountBinding);
      const model = session.model ?? liveBinding.model;
      let binding;
      try {
        binding = repositoryWorkspaceBinding(liveBinding.accountId, model);
      } catch {
        return {
          content:
            'Repository chats require a supported ordinary OpenAI account. Select one and retry.',
          isError: true,
        };
      }
      const combined = AbortSignal.any([
        signal,
        session.abortController.signal,
        AbortSignal.timeout(120000),
      ]);
      const current = () => {
        if (
          combined.aborted ||
          !allowed(name) ||
          !repositoryWorkspacesEnabled() ||
          !isDeepStrictEqual(session.accountBinding, liveBinding) ||
          (session.model ?? session.accountBinding?.model) !== model ||
          ((name === 'PrepareRepositoryChat' || changesAccess) &&
            effectivePermissionMode(session) === 'ask')
        )
          return false;
        try {
          return isDeepStrictEqual(
            repositoryWorkspaceBinding(liveBinding.accountId, model),
            binding,
          );
        } catch {
          return false;
        }
      };
      const selectConnection = (repository: string) => {
        const catalog = repositoryWorkspaceCatalog(binding);
        if (!catalog.available) throw new Error('Repository catalog unavailable');
        const matching = catalog.repositories.filter(
          (entry) => canonicalRepositorySelection(entry.repository) === repository,
        );
        if (matching.length !== 1) throw new Error('Repository selection unavailable or ambiguous');
        return matching[0].connectionId;
      };
      try {
        if (!current()) return unavailable();
        if (name === 'ListRepositories') {
          const catalog = repositoryWorkspaceCatalog(binding);
          return current() ? { content: JSON.stringify(catalog), isError: false } : unavailable();
        }
        if (name === 'RequestRepositoryAccess') {
          const repository = canonicalRepositorySelection(
            repositoryChatSchemas.RequestRepositoryAccess.parse(parsed.data).repository,
          );
          const runtime = getConnectionsRuntime();
          const matches = runtime?.service
            .catalog('operator')
            .filter(
              (connection) =>
                connection.templateId === 'github-readonly' &&
                connection.templateVersion === 1 &&
                connection.status === 'active' &&
                connection.verifiedAt !== null &&
                connection.identity &&
                connection.gatewayProviderId &&
                connection.desiredAccountIds.includes(binding.accountId),
            );
          if (!runtime || matches?.length !== 1)
            return {
              content:
                'A single verified GitHub connection must be assigned to this account. Open Connections to set it up, then request repository access again. Never send credentials in chat.',
              isError: true,
            };
          const connection = structuredClone(matches[0]);
          const unchanged = () =>
            current() &&
            getConnectionsRuntime() === runtime &&
            isDeepStrictEqual(runtime.store.get(connection.id), connection);
          if (!unchanged()) return unavailable();
          const repositories = connection.publicConfig.allowedRepositories;
          if (Array.isArray(repositories) && repositories.includes(repository))
            return {
              content: JSON.stringify({ repository, authorized: true, alreadyAuthorized: true }),
              isError: false,
            };
          const accounts = loadAccountProfiles().catalog();
          const accountLabels = connection.desiredAccountIds.map(
            (id) => accounts.find((account) => account.id === id)?.label ?? id,
          );
          const approvalInput = {
            repository,
            connectionId: connection.id,
            revision: connection.revision,
            affectedAccountIds: [...connection.desiredAccountIds],
            allowedBaseBranches: connection.publicConfig.allowedBaseBranches,
          };
          await assertRuntimeCurrent?.();
          if (!unchanged()) return unavailable();
          const owner = registry.findBySessionId(sessionId)!;
          const decision = await buildPermissionHandler(owner.clientId, registry)(
            toolPrefix + name,
            approvalInput,
            {
              signal: combined,
              toolUseID: randomUUID(),
              forcePrompt: true,
              allowSessionGrant: false,
              rememberSessionGrant: false,
              approvalScope: 'request',
              title: `Add ${repository} to GitHub access?`,
              description: `Use ${connection.label} (${connection.identity}). This shared connection grants repository access to these accounts: ${accountLabels.join(', ')}. Allowed base branches: ${String(connection.publicConfig.allowedBaseBranches)}. Existing repository access is retained. Publishing changes still requires separate approval.`,
            },
          );
          if (decision.behavior !== 'allow')
            return {
              content: 'Repository access was not approved. No repository was added.',
              isError: true,
            };
          await assertRuntimeCurrent?.();
          if (!unchanged() || !isDeepStrictEqual(decision.updatedInput, approvalInput))
            return {
              content:
                'The connection or session changed. Request repository access again to review its current scope.',
              isError: true,
            };
          await runtime.service.addGithubRepository(
            connection.id,
            connection.revision,
            repository,
            'operator',
            combined,
            () => {
              if (!unchanged()) throw new Error('Repository approval is no longer current');
            },
          );
          return {
            content: JSON.stringify({ repository, authorized: true, connectionId: connection.id }),
            isError: false,
          };
        }
        if (name === 'GetRepositoryChatPreparation') {
          const { preparationId } = repositoryChatSchemas.GetRepositoryChatPreparation.parse(
            parsed.data,
          );
          const preparation = getRepositoryWorkspaces(true).chatPreparation(
            preparationId,
            binding,
            sessionId,
          );
          return current()
            ? {
                content: JSON.stringify({ repositoryChat: publicPreparation(preparation) }),
                isError: false,
              }
            : unavailable();
        }
        const { repository: selected, prompt } = repositoryChatSchemas.PrepareRepositoryChat.parse(
          parsed.data,
        );
        const repository = canonicalRepositorySelection(selected);
        const connectionId = selectConnection(repository);
        if (!current()) return unavailable();
        await assertRuntimeCurrent?.();
        const preparation = await getRepositoryWorkspaces().prepareChat(
          binding,
          sessionId,
          connectionId,
          repository,
          prompt,
          combined,
        );
        if (!current() || selectConnection(repository) !== connectionId) return unavailable();
        return {
          content: JSON.stringify({ repositoryChat: publicPreparation(preparation) }),
          isError: false,
        };
      } catch {
        if (!current()) return unavailable();
        return {
          content:
            name === 'RequestRepositoryAccess'
              ? 'Repository access could not be confirmed. Call ListRepositories once to check whether it was added before requesting approval again. Existing repositories and credentials are retained.'
              : name === 'PrepareRepositoryChat'
                ? 'Repository chat preparation could not complete. Use GetRepositoryChatPreparation once to inspect any existing draft before preparing another. Preserve running or interrupted preparations for inspection; clear only an unused ready or failed draft. If no draft exists, check repository access through ListRepositories.'
                : 'Repository chat preparation is unavailable for this account and source chat. Check the draft selection and retry.',
          isError: true,
        };
      }
    },
  };
}
