import { githubRepositoryConnections } from './github-repository-connections.js';
import { GITHUB_PR_DESCRIPTION_MAX_LENGTH } from './github-publication-approval.js';
import { realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { toolInputError } from './tool-input-error.js';
import { createLogger } from '@mitzo/harness';
import { safeGithubSeedFailure, githubSeedFailureMessage } from './github-seeded-source.js';
import {
  safeGithubPublicationReviewFailure,
  githubPublicationReviewFailureMessage,
} from './github-publication-review-failure.js';
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
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { ordinaryOperatorOwnsConversation } from './ordinary-operator-identity.js';
import type {
  CapabilityCurrentAssertion,
  CapabilityOperation,
} from './connections/capabilities/types.js';
export const REQUEST_GITHUB_PUBLISH = 'RequestGithubPublish';
// Shared across runtime replacements; closing one runtime cannot release its active operation.
const publishingAdmissions = new Set<string>();
interface PublicationCall {
  turnId: string;
  callId: string;
  assertCurrentSync?(): void;
}
const operatorCalls = new WeakSet<PublicationCall>();
// Private producer provenance permits reusing an already qualified publishing
// assertion; arbitrary caller callbacks cannot stand in for signed authority.
const publicationAssertions = new WeakMap<
  () => Promise<void>,
  {
    runtimeId: string;
    conversationId: string;
    accountId: string;
    turnId?: string;
    assertCurrentSync(): void;
  }
>();
interface OperatorPublishingRegistration {
  registry: SessionRegistry;
  conversationId: () => string;
  session?: unknown;
  account?: unknown;
  assertRuntimeCurrent?: () => Promise<void>;
  activeInvocation?: PublicationCall;
  execute: (
    input: unknown,
    signal: AbortSignal,
    call: PublicationCall,
  ) => Promise<{ content: string; isError: boolean }>;
}
// Runtime identity is stable before an SDK assigns its conversation ID.
const operatorPublishing = new Map<string, OperatorPublishingRegistration>();
/** Capture the signed publisher and exact live call, independently of any model. */
function captureGithubPublicationOwner(runtimeId: string, conversationId: string, turnId?: string) {
  const active = operatorPublishing.get(runtimeId);
  if (!active || active.conversationId() !== conversationId)
    throw Error('Exact live publishing runtime required');
  const assertRuntimeCurrent = active.assertRuntimeCurrent;
  const current = active.registry.findBySessionId(conversationId);
  const session = current?.session;
  const operatorConnectionId = session?.ownerConnectionId;
  if (!session || !operatorConnectionId || session !== active.session || !session.accountBinding)
    throw Error('Authenticated original publishing owner required for publication');
  const authorization = captureAgentLibraryAuthorization(operatorConnectionId);
  const authSessionId = authorization.auth.id;
  const ownedAuth = session.ownedLocalAuthSessionId ?? session.ordinaryRuntimeOwner?.authSessionId;
  if (ownedAuth && !ordinaryOperatorOwnsConversation(ownedAuth, authSessionId))
    throw Error('Original publishing operator required for publication');
  const binding = structuredClone(session.accountBinding);
  const invocation = turnId === undefined ? undefined : active.activeInvocation;
  if (turnId !== undefined && (!invocation || invocation.turnId !== turnId))
    throw Error('Exact active publication invocation required for publication');
  const assertSync = () => {
    authorization.assertCurrent();
    invocation?.assertCurrentSync?.();
    if (
      operatorPublishing.get(runtimeId) !== active ||
      active.assertRuntimeCurrent !== assertRuntimeCurrent ||
      active.registry.findBySessionId(conversationId)?.session !== session ||
      session.ownerConnectionId !== operatorConnectionId ||
      !isDeepStrictEqual(session.accountBinding, binding) ||
      !isDeepStrictEqual(active.account, binding) ||
      (turnId !== undefined && active.activeInvocation !== invocation) ||
      (session.ownedLocalAuthSessionId ?? session.ordinaryRuntimeOwner?.authSessionId) !==
        ownedAuth ||
      effectivePermissionMode(session) === 'ask' ||
      checkSkillPolicy(active.registry, current!.clientId, REQUEST_GITHUB_PUBLISH) === 'deny'
    )
      throw Error('Original publishing owner changed');
  };
  assertSync();
  const owner = Object.freeze({
    authSessionId,
    operatorConnectionId,
    binding: Object.freeze(binding),
    assertCurrentSync: assertSync,
    assertCurrent: async () => {
      assertSync();
      await assertRuntimeCurrent?.();
      assertSync();
    },
  });
  publicationAssertions.set(owner.assertCurrent, {
    runtimeId,
    conversationId,
    accountId: binding.accountId,
    turnId,
    assertCurrentSync: owner.assertCurrentSync,
  });
  return owner;
}
/** The ordinary service captures this once before any async operation work.
 * HTTP and capability aliases must retain the same signed publisher/source as
 * RequestGithubPublish; read-only reconciliation does not create new authority. */
export function captureGithubPublicationOperationAuthority(
  operation: CapabilityOperation,
  callerCurrent?: CapabilityCurrentAssertion,
): () => Promise<void> {
  const live = getLiveCapabilityConversationBinding(operation.conversationId);
  if (
    !live?.runtimeOwnerId ||
    live.accountId !== operation.accountId ||
    live.connectionId !== operation.connectionId ||
    live.connectionRevision !== operation.connectionRevision
  )
    throw Error('Exact live publishing binding required');
  const assertBinding = () => {
    if (getLiveCapabilityConversationBinding(operation.conversationId) !== live)
      throw Error('Original publishing source changed');
  };
  const produced = callerCurrent && publicationAssertions.get(callerCurrent);
  const reuse =
    produced?.runtimeId === live.runtimeOwnerId &&
    produced.conversationId === operation.conversationId &&
    produced.accountId === operation.accountId &&
    produced.turnId === operation.turnId;
  const owner = reuse
    ? { assertCurrent: callerCurrent!, assertCurrentSync: produced!.assertCurrentSync }
    : captureGithubPublicationOwner(live.runtimeOwnerId, operation.conversationId);
  const callerSync = callerCurrent?.assertCurrentSync;
  assertBinding();
  return async () => {
    assertBinding();
    await owner.assertCurrent();
    if (callerCurrent && !reuse) await callerCurrent();
    callerSync?.();
    owner.assertCurrentSync();
    assertBinding();
  };
}
export async function requestOperatorGithubPublication(
  conversationId: string,
  registry: SessionRegistry,
  input: unknown,
  signal: AbortSignal,
) {
  let active: OperatorPublishingRegistration | undefined;
  for (const registered of operatorPublishing.values()) {
    if (registered.registry === registry && registered.conversationId() === conversationId)
      active = registered;
  }
  if (!active) throw new Error('No live publishing runtime is registered for this conversation');
  const current = registry.findBySessionId(conversationId);
  if (
    !current ||
    current.session !== active.session ||
    !isDeepStrictEqual(current.session.accountBinding, active.account)
  )
    throw new Error('The live publishing account or runtime changed');
  const call = { turnId: 'operator-' + randomUUID(), callId: randomUUID() };
  operatorCalls.add(call);
  try {
    return await active.execute(input, signal, call);
  } finally {
    operatorCalls.delete(call);
  }
}
export const GithubPublishingFields = {
  repositoryPath: z.string().min(1).max(256),
  baseBranch: z.string().min(1).max(128),
  title: z.string().min(1).max(128),
  body: z.string().max(GITHUB_PR_DESCRIPTION_MAX_LENGTH).describe('Pull request description'),
  draft: z.boolean(),
};
const Input = z.object(GithubPublishingFields).strict();
export const githubPublishingDefinition: ToolDefinition = {
  name: REQUEST_GITHUB_PUBLISH,
  description:
    'Publish committed workspace changes to a GitHub feature branch and create or update its pull request after publication authorization. This tool performs no AI code review and does not require a review model. Mitzo resolves the repository and configured GitHub connection for this session account; credentials remain on the controller. Supply the absolute repository path in the current workspace, base branch, title, body and draft choice; do not use direct GitHub writes.',
  input_schema: z.toJSONSchema(Input),
};
export const GITHUB_PUBLISHING_INSTRUCTIONS =
  '\nUse RequestGithubPublish to publish committed local changes to a GitHub feature branch and pull request. PR creation and updates require no AI code review or review-model selection. Code review, CI and merge approval happen through the normal PR workflow; opening a PR does not authorize merging or deployment. Preserve a failed or pending result without claiming publication succeeded. Prefer a draft PR unless the user requested a ready PR. This tool is available across account runtimes and resolves access for the current AI account; a provider being read-only does not mean this approval-backed tool is unavailable. If a managed GitHub connection is missing, explain the returned setup requirement and preserve the local commit. Do not substitute direct git push or gh API writes after denial.\n';
export type GithubPublishingSource =
  | { runtime: 'host'; workspace: string; gitStorageRoots: readonly string[] }
  | { runtime: 'openshell'; workspace: string; sandboxName: string };
export function createGithubPublishingTool(
  conversation: string | (() => string),
  registry: SessionRegistry,
  source: () => GithubPublishingSource | undefined,
  ownerSession?: ReturnType<SessionRegistry['get']>,
  assertRuntimeCurrent?: () => Promise<void>,
  requireNativeCall = false,
) {
  const runtimeOwnerId = randomUUID();
  let closed = false;
  let bound:
    { conversationId: string; connectionId: string; connectionRevision: number } | undefined;
  const run = async (
    input: unknown,
    signal: AbortSignal,
    call: PublicationCall,
    assertCurrent: () => Promise<void>,
  ) => {
    let stage = 'admission';
    const requestId = randomUUID();
    try {
      await assertCurrent();
      signal.throwIfAborted();
      const parsed = Input.safeParse(input);
      if (!parsed.success) return toolInputError('GitHub publishing request', Input, parsed.error);
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
      await assertCurrent();
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
      await assertCurrent();
      if (!isCurrent())
        return { content: 'Session permissions changed; retry publishing', isError: true };
      const connections = githubRepositoryConnections(
        runtime.store.list('operator'),
        account.accountId,
        repository,
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
      await assertCurrent();
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
            rememberSessionGrant: false,
            approvalScope: 'session',
            sessionGrantDescription: `Publishing requests for ${repository} through this exact managed GitHub connection and its configured branch scope. Each publication rechecks workspace, repository, branch, account, and connection policy.`,
            title: `Allow publishing requests for ${repository}?`,
            description:
              'Enables the selected AI account to request publication for this repository within the configured branch scope. You may also allow the publication operation scope for this session when approving a publication.',
          },
        );
        await assertCurrent();
        signal.throwIfAborted();
        if (decision.behavior !== 'allow')
          return {
            content: `${decision.message}. Local changes are preserved.`,
            isError: true,
          };
        const approvedRepository = await runtime.resolveGithubPublishingRepository(
          sourceIdentity,
          parsed.data.repositoryPath,
          parsed.data.baseBranch,
          signal,
        );
        await assertCurrent();
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
      await assertCurrent();
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
        assertCurrent,
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
      await assertCurrent();
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
                call: { turnId: call.turnId, callId: call.callId },
                input: parsed.data,
              }),
            )
            .digest('hex'),
          input: { ...parsed.data, connectionId: connection.id },
        },
        signal,
        capabilityApprovalForConversation(registry, conversationId),
        assertCurrent,
      );
      return {
        content: JSON.stringify({
          operationId: operation.id,
          status: operation.status,
          result: operation.result,
          failureCode: operation.failureCode,
          ...(githubSeedFailureMessage(operation.failureCode)
            ? { message: githubSeedFailureMessage(operation.failureCode) }
            : githubPublicationReviewFailureMessage(operation.failureCode)
              ? { message: githubPublicationReviewFailureMessage(operation.failureCode) }
              : {}),
        }),
        isError: operation.status !== 'succeeded',
      };
    } catch (error) {
      const failure = safeGithubPublicationReviewFailure(error) ??
        safeGithubSeedFailure(error) ?? {
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
  const execute = async (input: unknown, signal: AbortSignal, call: PublicationCall) => {
    const conversationId = typeof conversation === 'function' ? conversation() : conversation;
    if (publishingAdmissions.has(conversationId))
      return {
        content:
          'A publishing request is already in progress for this conversation. Wait for its result before retrying.',
        isError: true,
      };
    publishingAdmissions.add(conversationId);
    registration.activeInvocation = call;
    try {
      if (
        requireNativeCall &&
        !operatorCalls.has(call) &&
        typeof call.assertCurrentSync !== 'function'
      )
        throw Error('Original native publication call required');
      const owner = captureGithubPublicationOwner(runtimeOwnerId, conversationId, call.turnId);
      return await run(input, signal, call, owner.assertCurrent);
    } catch {
      return {
        content: JSON.stringify({
          code: 'GITHUB_PUBLICATION_FAILED',
          message: 'The publishing account, operator or active call is no longer authorized.',
          operationRecorded: false,
        }),
        isError: true,
      };
    } finally {
      registration.activeInvocation = undefined;
      publishingAdmissions.delete(conversationId);
    }
  };
  const conversationId = () => (typeof conversation === 'function' ? conversation() : conversation);
  const operatorSession = ownerSession ?? registry.findBySessionId(conversationId())?.session;
  for (const [id, registered] of operatorPublishing) {
    if (
      operatorSession &&
      registered.registry === registry &&
      registered.session === operatorSession
    )
      operatorPublishing.delete(id);
  }
  const registration: OperatorPublishingRegistration = {
    registry,
    conversationId,
    execute,
    session: operatorSession,
    account: structuredClone(operatorSession?.accountBinding),
    assertRuntimeCurrent,
  };
  operatorPublishing.set(runtimeOwnerId, registration);
  return Object.assign(execute, {
    runtimeOwnerId,
    close: () => {
      closed = true;
      operatorPublishing.delete(runtimeOwnerId);
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
