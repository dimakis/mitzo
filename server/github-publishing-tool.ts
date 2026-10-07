import { realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { createLogger } from '@mitzo/harness';
import { safeGithubSeedFailure, githubSeedFailureMessage } from './github-seeded-source.js';
const publicationLog = createLogger('github-publication');
import {
  buildPermissionHandler,
  checkSkillPolicy,
  effectivePermissionMode,
  type SessionRegistry,
} from '@mitzo/harness';
import type { ToolDefinition } from '@mitzo/harness';
import { getConnectionsRuntime } from './connections-runtime.js';
import {
  bindLiveCapabilityConversation,
  clearLiveCapabilityConversationBinding,
  getLiveCapabilityConversationBinding,
} from './capability-conversation-binding.js';
import { capabilityApprovalForConversation } from './connections/capabilities/approval.js';
import { canonicalJson } from './connections/capabilities/input-validation.js';
export const REQUEST_GITHUB_PUBLISH = 'RequestGithubPublish';
// Shared across runtime replacements; closing one runtime cannot release its active operation.
const publishingAdmissions = new Set<string>();
const operatorPublishing = new Map<
  string,
  {
    registry: SessionRegistry;
    ownerId: string;
    session?: unknown;
    account?: unknown;
    execute: (
      input: unknown,
      signal: AbortSignal,
      call: { turnId: string; callId: string },
    ) => Promise<{ content: string; isError: boolean }>;
  }
>();
export async function requestOperatorGithubPublication(
  conversationId: string,
  registry: SessionRegistry,
  input: unknown,
  signal: AbortSignal,
) {
  const active = operatorPublishing.get(conversationId);
  if (!active || active.registry !== registry)
    throw new Error('No live publishing runtime is registered for this conversation');
  const current = registry.findBySessionId(conversationId);
  if (
    !current ||
    current.session !== active.session ||
    !isDeepStrictEqual(current.session.accountBinding, active.account)
  )
    throw new Error('The live publishing account or runtime changed');
  return active.execute(input, signal, {
    turnId: 'operator-' + randomUUID(),
    callId: randomUUID(),
  });
}
export const GithubPublishingFields = {
  repositoryPath: z.string().min(1).max(256),
  baseBranch: z.string().min(1).max(128),
  title: z.string().min(1).max(128),
  body: z.string().max(512),
  draft: z.boolean(),
};
const Input = z.object(GithubPublishingFields).strict();
export const githubPublishingDefinition: ToolDefinition = {
  name: REQUEST_GITHUB_PUBLISH,
  description:
    'Request approval to publish committed workspace changes to a GitHub feature branch and create or update its pull request. Mitzo resolves the GitHub repository from the current workspace and selects its configured connection for this session account. It asks the user for repository-specific access when needed. Credentials remain on the controller. Supply the absolute local repository path inside the current workspace, base branch, title, body and draft choice; do not use direct GitHub writes.',
  input_schema: z.toJSONSchema(Input),
};
export const GITHUB_PUBLISHING_INSTRUCTIONS =
  '\nUse RequestGithubPublish to publish committed local changes to a GitHub feature branch and pull request. This tool is available across account runtimes and routes the request to the user for approval. It resolves access for the current AI account; a provider being read-only does not mean this approval-backed tool is unavailable. If a managed GitHub connection is missing, explain the returned setup requirement and preserve the local commit. Do not substitute direct git push or gh API writes after denial.\n';
export type GithubPublishingSource =
  | { runtime: 'host'; workspace: string; gitStorageRoots: readonly string[] }
  | { runtime: 'openshell'; workspace: string; sandboxName: string };
export function createGithubPublishingTool(
  conversation: string | (() => string),
  registry: SessionRegistry,
  source: () => GithubPublishingSource | undefined,
) {
  const runtimeOwnerId = randomUUID();
  let closed = false;
  let bound:
    { conversationId: string; connectionId: string; connectionRevision: number } | undefined;
  const run = async (
    input: unknown,
    signal: AbortSignal,
    call: { turnId: string; callId: string },
  ) => {
    let stage = 'admission';
    const requestId = randomUUID();
    try {
      signal.throwIfAborted();
      const parsed = Input.safeParse(input);
      if (!parsed.success) return { content: 'Invalid GitHub publishing request', isError: true };
      const conversationId = typeof conversation === 'function' ? conversation() : conversation;
      const owner = registry.findBySessionId(conversationId);
      const account = owner?.session.accountBinding;
      const runtime = getConnectionsRuntime();
      if (!owner || !account || !runtime)
        return {
          content:
            'GitHub publishing needs a configured managed GitHub connection in Connections. Local changes are preserved.',
          isError: true,
        };
      if (runtime.githubPublishEnabled === false)
        return {
          content:
            'The controller GitHub publisher is not configured. Configure its GitHub authorization before granting publishing access. Local changes are preserved.',
          isError: true,
        };
      const identity = structuredClone(account);
      const sourceIdentity = structuredClone(source());
      const isCurrent = () =>
        !closed &&
        registry.get(owner.clientId) === owner.session &&
        registry.findBySessionId(conversationId)?.session === owner.session &&
        registry.findBySessionId(conversationId)?.clientId === owner.clientId &&
        isDeepStrictEqual(source(), sourceIdentity) &&
        isDeepStrictEqual(owner.session.accountBinding, identity) &&
        effectivePermissionMode(owner.session) !== 'ask' &&
        checkSkillPolicy(registry, owner.clientId, REQUEST_GITHUB_PUBLISH) !== 'deny';
      if (!isCurrent())
        return {
          content: 'Session permissions changed; retry the publishing request',
          isError: true,
        };
      if (!sourceIdentity || !runtime.resolveGithubPublishingRepository)
        return {
          content: 'The live repository cannot be resolved; reconnect before publishing',
          isError: true,
        };
      stage = 'repository_resolution';
      const repository = await runtime.resolveGithubPublishingRepository(
        sourceIdentity,
        parsed.data.repositoryPath,
        parsed.data.baseBranch,
        signal,
      );
      if (!isCurrent())
        return { content: 'Session permissions changed; retry publishing', isError: true };
      const connections = runtime.store
        .list('operator')
        .filter(
          (c) =>
            c.templateId === 'github-readonly' &&
            c.status === 'active' &&
            c.desiredAccountIds.includes(account.accountId) &&
            Array.isArray(c.publicConfig.allowedRepositories) &&
            c.publicConfig.allowedRepositories.some(
              (value) => typeof value === 'string' && value.toLowerCase() === repository,
            ),
        );
      if (connections.length !== 1)
        return {
          content:
            'Assign one active managed GitHub connection scoped to this repository and AI account in Connections before publishing. Local changes are preserved.',
          isError: true,
        };
      const connection = connections[0]!;
      stage = 'publisher_identity';
      if (
        !runtime.verifyGithubPublishingIdentity ||
        !(await runtime.verifyGithubPublishingIdentity(connection.id, signal, connection.revision))
      )
        return {
          content:
            'The controller GitHub publishing identity does not match this connection. Check its publishing authorization; local changes are preserved.',
          isError: true,
        };
      if (!isCurrent())
        return { content: 'Session permissions changed; retry publishing', isError: true };
      const currentConnection = () => {
        const current = runtime.store.get(connection.id);
        return (
          current?.status === 'active' &&
          current.revision === connection.revision &&
          current.desiredAccountIds.includes(identity.accountId)
        );
      };
      const grant = structuredClone(
        runtime.capabilityStore.getGrant(
          connection.id,
          connection.revision,
          'github.publish-pr',
          1,
        ),
      );
      const repositoryScope = {
        connectionId: connection.id,
        connectionRevision: connection.revision,
        accountId: identity.accountId,
        repository,
      };
      const hasAccountGrant =
        grant?.status === 'active' && grant.accountIds.includes(account.accountId);
      if (!hasAccountGrant || !runtime.capabilityStore.hasGithubRepositoryAccess(repositoryScope)) {
        const payload = {
          connectionId: connection.id,
          connectionRevision: connection.revision,
          accountId: account.accountId,
          githubIdentity: connection.identity,
          capability: 'github.publish-pr',
          repository,
          allowedBaseBranches: connection.publicConfig.allowedBaseBranches ?? [],
        };
        const decision = await buildPermissionHandler(owner.clientId, registry)(
          REQUEST_GITHUB_PUBLISH,
          payload,
          {
            signal,
            toolUseID: randomUUID(),
            forcePrompt: true,
            allowSessionGrant: false,
            approvalScope: 'request',
            title: `Allow publishing requests for ${repository}?`,
            description:
              'Enables the selected AI account to request publication for this repository within the configured branch scope. Each publication still requires its own approval.',
          },
        );
        signal.throwIfAborted();
        if (decision.behavior !== 'allow')
          return {
            content: 'GitHub publishing access declined. Local changes are preserved.',
            isError: true,
          };
        const approvedRepository = await runtime.resolveGithubPublishingRepository(
          sourceIdentity,
          parsed.data.repositoryPath,
          parsed.data.baseBranch,
          signal,
        );
        signal.throwIfAborted();
        if (
          !isCurrent() ||
          !currentConnection() ||
          approvedRepository !== repository ||
          !isDeepStrictEqual(
            runtime.capabilityStore.getGrant(
              connection.id,
              connection.revision,
              'github.publish-pr',
              1,
            ),
            grant,
          ) ||
          !isDeepStrictEqual(decision.updatedInput, payload)
        )
          return { content: 'Publishing access changed during approval; retry', isError: true };
        if (!hasAccountGrant)
          runtime.capabilities.setGrant({
            connectionId: connection.id,
            connectionRevision: connection.revision,
            capabilityId: 'github.publish-pr',
            capabilityVersion: 1,
            accountIds: [
              ...new Set([
                ...(grant?.status === 'active' ? grant.accountIds : []),
                identity.accountId,
              ]),
            ],
            status: 'active',
          });
        runtime.capabilityStore.approveGithubRepository(repositoryScope);
      }
      const resolved = source();
      if (!resolved || !isCurrent() || !currentConnection())
        return {
          content: 'The live publishing workspace is unavailable; reconnect before retrying',
          isError: true,
        };
      bound = {
        conversationId,
        connectionId: connection.id,
        connectionRevision: connection.revision,
      };
      bindLiveCapabilityConversation(conversationId, {
        ...resolved,
        runtimeOwnerId,
        accountId: identity.accountId,
        connectionId: connection.id,
        connectionRevision: connection.revision,
        gatewayProviderId: connection.gatewayProviderId,
      });
      stage = 'operation_recovery';
      const recovered = await runtime.capabilities.recoverPendingForConversation(
        identity.accountId,
        conversationId,
        signal,
      );
      const unresolved = recovered.filter((operation) =>
        ['pending_approval', 'running', 'verification_pending'].includes(operation.status),
      );
      if (unresolved.length)
        return {
          content: `An earlier publishing operation still needs verification: ${unresolved.map((operation) => operation.id).join(', ')}. Inspect its result before publishing again.`,
          isError: true,
        };
      const recoveredRepository = await runtime.resolveGithubPublishingRepository(
        sourceIdentity,
        parsed.data.repositoryPath,
        parsed.data.baseBranch,
        signal,
      );
      signal.throwIfAborted();
      if (
        !isCurrent() ||
        !currentConnection() ||
        !runtime.capabilityStore.hasGithubRepositoryAccess(repositoryScope) ||
        recoveredRepository !== repository
      )
        return { content: 'Publishing access changed during recovery; retry', isError: true };
      stage = 'operation_dispatch';
      const operation = await runtime.capabilities.invoke(
        {
          connectionId: connection.id,
          connectionRevision: connection.revision,
          capabilityId: 'github.publish-pr',
          capabilityVersion: 1,
          accountId: identity.accountId,
          conversationId,
          turnId: call.turnId,
          idempotencyKey: createHash('sha256')
            .update(
              canonicalJson({
                conversationId,
                account: identity,
                connectionId: connection.id,
                revision: connection.revision,
                call,
                input: parsed.data,
              }),
            )
            .digest('hex'),
          input: { ...parsed.data, connectionId: connection.id },
        },
        signal,
        capabilityApprovalForConversation(registry, conversationId),
      );
      return {
        content: JSON.stringify({
          operationId: operation.id,
          status: operation.status,
          result: operation.result,
          failureCode: operation.failureCode,
          ...(githubSeedFailureMessage(operation.failureCode)
            ? { message: githubSeedFailureMessage(operation.failureCode) }
            : {}),
        }),
        isError: operation.status !== 'succeeded',
      };
    } catch (error) {
      const failure = safeGithubSeedFailure(error) ?? {
        code: 'GITHUB_PUBLICATION_FAILED',
        message:
          'Publication failed during ' +
          stage +
          '. Use the diagnostic request ID to inspect controller logs before retrying.',
      };
      publicationLog.warn('GitHub publication failed', { requestId, stage, code: failure.code });
      return {
        content: JSON.stringify({
          requestId,
          stage,
          ...failure,
          operationRecorded:
            stage === 'operation_dispatch' || stage === 'operation_recovery' ? 'unknown' : false,
        }),
        isError: true,
      };
    }
  };
  const execute = async (...args: Parameters<typeof run>) => {
    const conversationId = typeof conversation === 'function' ? conversation() : conversation;
    if (publishingAdmissions.has(conversationId))
      return {
        content:
          'A publishing request is already in progress for this conversation. Wait for its result before retrying.',
        isError: true,
      };
    publishingAdmissions.add(conversationId);
    try {
      return await run(...args);
    } finally {
      publishingAdmissions.delete(conversationId);
    }
  };
  const operatorConversationId = typeof conversation === 'function' ? conversation() : conversation;
  const operatorOwner = registry.findBySessionId(operatorConversationId);
  operatorPublishing.set(operatorConversationId, {
    registry,
    ownerId: runtimeOwnerId,
    execute,
    session: operatorOwner?.session,
    account: structuredClone(operatorOwner?.session.accountBinding),
  });
  return Object.assign(execute, {
    runtimeOwnerId,
    close: () => {
      closed = true;
      if (operatorPublishing.get(operatorConversationId)?.ownerId === runtimeOwnerId)
        operatorPublishing.delete(operatorConversationId);
      if (
        bound &&
        getLiveCapabilityConversationBinding(bound.conversationId)?.runtimeOwnerId ===
          runtimeOwnerId
      )
        clearLiveCapabilityConversationBinding(bound.conversationId, bound);
      bound = undefined;
    },
  });
}

/** Caller supplies configured Git storage roots from host setup, never tool arguments. */
export function hostGithubPublishingSource(
  session: { cwd?: string },
  gitStorageRoots: readonly string[] = [],
): GithubPublishingSource | undefined {
  try {
    if (!session.cwd) return undefined;
    return {
      runtime: 'host',
      workspace: realpathSync(session.cwd),
      gitStorageRoots: gitStorageRoots.map((root) => realpathSync(root)),
    };
  } catch {
    return undefined;
  }
}
