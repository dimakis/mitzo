import {
  checkSkillPolicy,
  effectivePermissionMode,
  type ManagedSession,
  type SessionRegistry,
  type ToolDefinition,
} from '@mitzo/harness';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  canonicalRepositorySelection,
  RepositorySourceLimitError,
  RepositorySpaceError,
} from './github-repository-source.js';
import {
  getRepositoryWorkspaces,
  repositoryWorkspaceBinding,
  repositoryWorkspaceCatalog,
  repositoryWorkspacesEnabled,
} from './repository-workspace-runtime.js';
import type { RepositoryChatPreparation } from './repository-workspaces.js';

export const REPOSITORY_CHAT_INSTRUCTIONS =
  '\nRepository work: ListRepositories then PrepareRepositoryChat; user reviews a separate chat draft. On input validation rejection, correct and retry once. Otherwise use GetRepositoryChatPreparation once for a missing ID; omit preparationId. Do not repeat execution or poll.\n';

// Retained build briefs must fit alongside the handoff instructions. Keep a
// bounded input, but do not force ordinary documents through an 8,000-char cap.
const MAX_REPOSITORY_CHAT_PROMPT_CHARACTERS = 64_000;

export const repositoryChatSchemas = {
  ListRepositories: z.strictObject({}),
  PrepareRepositoryChat: z.strictObject({
    repository: z.string().min(1).max(512),
    prompt: z
      .string()
      .min(1)
      .max(MAX_REPOSITORY_CHAT_PROMPT_CHARACTERS)
      .refine((value) => value.trim().length > 0),
  }),
  GetRepositoryChatPreparation: z.strictObject({ preparationId: z.uuid().optional() }),
};
const descriptions = {
  ListRepositories:
    'Discover repositories authorized for this chat’s current AI account. Returns repository names and connection labels, without credentials or filesystem paths.',
  PrepareRepositoryChat: `Prepare a separate repository chat for a user-requested task. Supply only an authorized repository name or canonical GitHub HTTPS URL and the task prompt (at most ${MAX_REPOSITORY_CHAT_PROMPT_CHARACTERS} characters). For longer briefs, include their Telos artifact IDs and revisions for retrieval. Returns a draft review link; the user starts the new chat. Does not switch the current workspace, grant integration access, execute the task, or publish changes. Requires Agent or Auto mode.`,
  GetRepositoryChatPreparation:
    'Read a repository-chat draft prepared by this source chat and its current AI account. Omit preparationId to recover the latest owned draft after a lost response. Returns public preparation status and the review link. Do not repeat preparation or repeatedly poll.',
};

const inputRemedies = {
  ListRepositories: 'Supply an empty object: {}.',
  PrepareRepositoryChat: `Supply only repository (1–512 characters) and prompt (non-blank text, at most ${MAX_REPOSITORY_CHAT_PROMPT_CHARACTERS} characters). For longer briefs, include their Telos artifact IDs and revisions for retrieval. Repository preparation was not started by this call. Correct the input and retry PrepareRepositoryChat once; do not use draft recovery for this validation failure.`,
  GetRepositoryChatPreparation:
    'Supply only preparationId as a UUID, or omit it to recover the latest owned draft.',
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
    failure,
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
    ...(failure ? { failure } : {}),
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
      if (!parsed.success)
        return {
          // Fixed guidance never echoes rejected prompts, routing values or keys.
          content: `Invalid repository tool input for ${name}. ${inputRemedies[name as keyof typeof inputRemedies]}`,
          isError: true,
        };
      if (name === 'PrepareRepositoryChat' && effectivePermissionMode(session) === 'ask')
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
          (name === 'PrepareRepositoryChat' && effectivePermissionMode(session) === 'ask')
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
                isError: preparation.state === 'failed',
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
          isError: preparation.state === 'failed',
        };
      } catch (error) {
        if (!current()) return unavailable();
        if (error instanceof RepositorySourceLimitError || error instanceof RepositorySpaceError)
          return { content: error.message, isError: true };
        return {
          content:
            name === 'PrepareRepositoryChat'
              ? 'Repository chat preparation could not complete. Use GetRepositoryChatPreparation once to inspect any existing draft before preparing another. Preserve running or interrupted preparations for inspection; clear only an unused ready or failed draft. If no draft exists, check repository access through ListRepositories.'
              : 'Repository chat preparation is unavailable for this account and source chat. Check the draft selection and retry.',
          isError: true,
        };
      }
    },
  };
}
