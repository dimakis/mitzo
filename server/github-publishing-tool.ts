import { retainedNativeHostToolOperator } from './native-host-tool-operator.js';
import { isAuthSessionCurrent } from './auth.js';
import { githubRepositoryConnections } from './github-repository-connections.js';
import { GITHUB_PR_DESCRIPTION_MAX_LENGTH } from './github-publication-approval.js';
import { createHash, randomUUID } from 'node:crypto';
import { toolFailure, toolFailureAction } from '@mitzo/protocol';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { toolInputError } from './tool-input-error.js';
import type { PreparedGithubBase } from './github-host-source.js';
import { createLogger } from '@mitzo/harness';
import { safeGithubSeedFailure, githubSeedFailureMessage } from './github-seeded-source.js';
import {
  GithubPublicationReviewError,
  safeGithubPublicationReviewFailure,
  githubPublicationReviewFailureMessage,
} from './github-publication-review-failure.js';
const publicationLog = createLogger('github-publication');
import {
  buildPermissionHandler,
  permissionRefusalContent,
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
import { canonicalRepositoryPath } from './connections/capabilities/github-publish-pr.js';
import { GithubPublicationValidationError } from './github-publication-preflight.js';
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
class PublicationOwnerError extends GithubPublicationReviewError {
  constructor(
    readonly reason:
      | 'runtime_changed'
      | 'session_unavailable'
      | 'operator_unavailable'
      | 'operator_mismatch'
      | 'native_call_stale'
      | 'native_call_required'
      | 'owner_changed'
      | 'binding_changed'
      | 'source_changed',
  ) {
    super('PUBLICATION_AUTHORITY_CHANGED', { stage: 'authority', reason });
  }
}
/** Capture the signed publisher and exact live call, independently of any model. */
function captureGithubPublicationOwner(runtimeId: string, conversationId: string, turnId?: string) {
  const active = operatorPublishing.get(runtimeId);
  if (!active || active.conversationId() !== conversationId)
    throw new PublicationOwnerError('runtime_changed');
  const assertRuntimeCurrent = active.assertRuntimeCurrent;
  const current = active.registry.findBySessionId(conversationId);
  const session = current?.session;
  const retainedOperator = session && retainedNativeHostToolOperator(session);
  const operatorConnectionId = retainedOperator ?? session?.ownerConnectionId;
  if (!session || !operatorConnectionId || session !== active.session || !session.accountBinding)
    throw new PublicationOwnerError('session_unavailable');
  const authorization = (() => {
    try {
      return captureAgentLibraryAuthorization(
        operatorConnectionId,
        retainedOperator ? undefined : { lifetime: 'operation' },
      );
    } catch {
      throw new PublicationOwnerError('operator_unavailable');
    }
  })();
  const authSessionId = authorization.auth.id;
  const ownedAuth = session.ownedLocalAuthSessionId ?? session.ordinaryRuntimeOwner?.authSessionId;
  if (ownedAuth && !ordinaryOperatorOwnsConversation(ownedAuth, authSessionId))
    throw new PublicationOwnerError('operator_mismatch');
  const binding = structuredClone(session.accountBinding);
  const invocation = turnId === undefined ? undefined : active.activeInvocation;
  if (turnId !== undefined && (!invocation || invocation.turnId !== turnId))
    throw new PublicationOwnerError('native_call_stale');
  const assertSync = () => {
    try {
      authorization.assertCurrent();
      if (retainedOperator && !isAuthSessionCurrent(authorization.auth))
        throw Error('Publishing login revoked');
    } catch {
      throw new PublicationOwnerError('operator_unavailable');
    }
    try {
      invocation?.assertCurrentSync?.();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new PublicationOwnerError('native_call_stale');
    }
    if (
      operatorPublishing.get(runtimeId) !== active ||
      active.assertRuntimeCurrent !== assertRuntimeCurrent ||
      retainedNativeHostToolOperator(session) !== retainedOperator ||
      active.registry.findBySessionId(conversationId)?.session !== session ||
      !isDeepStrictEqual(session.accountBinding, binding) ||
      !isDeepStrictEqual(active.account, binding) ||
      (turnId !== undefined && active.activeInvocation !== invocation) ||
      (session.ownedLocalAuthSessionId ?? session.ordinaryRuntimeOwner?.authSessionId) !==
        ownedAuth ||
      effectivePermissionMode(session) === 'ask' ||
      checkSkillPolicy(active.registry, current!.clientId, REQUEST_GITHUB_PUBLISH) === 'deny'
    )
      throw new PublicationOwnerError('owner_changed');
  };
  assertSync();
  const owner = Object.freeze({
    authSessionId,
    operatorConnectionId,
    binding: Object.freeze(binding),
    assertCurrentSync: assertSync,
    assertCurrent: async () => {
      assertSync();
      try {
        await assertRuntimeCurrent?.();
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new PublicationOwnerError('runtime_changed');
      }
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
    throw new PublicationOwnerError('binding_changed');
  const assertBinding = () => {
    if (getLiveCapabilityConversationBinding(operation.conversationId) !== live)
      throw new PublicationOwnerError('source_changed');
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
    try {
      if (callerCurrent && !reuse) await callerCurrent();
      callerSync?.();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new PublicationOwnerError('native_call_stale');
    }
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
    'Publish committed workspace changes to a GitHub feature branch and create or update its pull request after publication authorization. This tool performs no AI code review and does not require a review model. Mitzo resolves the repository and configured GitHub connection for this session account; credentials remain on the controller. Supply the absolute repository path in the current workspace, base branch, title, body and draft choice. Native Local Mac git/gh publication under its existing approvals is also supported; this managed tool does not adopt another workspace.',
  input_schema: z.toJSONSchema(Input),
};
export const GITHUB_PUBLISHING_INSTRUCTIONS =
  '\nFor Local Mac native development, prefer native git/gh for branch and PR publication through the existing filesystem and network approvals. Honor the user-selected repository and destination; when the user requests the CLI, use it directly. RequestGithubPublish is the managed alternative, and the publication route for runtimes without authorized native GitHub tools; it requires the repository to be inside the admitted chat workspace. Choose one authorized route before mutation; do not run both or bypass a policy or authorization denial. An uncertain write requires read-only inspection of the existing branch/PR before any repeat mutation. Reuse unchanged local metadata and successful receipts; keep fresh authorization at mutation and delivery boundaries. Publish only the selected committed work and preserve staged, unstaged and untracked files. PR creation needs no AI code review or review-model selection; normal code review and CI follow publication. Prefer a draft unless requested otherwise. Opening a PR does not authorize merging or deployment. Preserve failed/pending results without claiming success.\n';
export type GithubPublishingSource =
  | {
      runtime: 'host';
      workspace: string;
      gitStorageRoots: readonly string[];
      preparedBase?: PreparedGithubBase;
    }
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
      if (!sourceIdentity)
        return {
          content: JSON.stringify({
            code: 'GITHUB_PUBLICATION_SOURCE_UNAVAILABLE',
            message:
              'The managed publisher could not capture the current workspace or required Git storage. Check the retained workspace and storage before retrying. Local commits are preserved.',
            operationRecorded: false,
          }),
          isError: true,
        };
      if (!runtime.resolveGithubPublishingRepository)
        return {
          content: JSON.stringify({
            code: 'GITHUB_PUBLICATION_RUNTIME_UNAVAILABLE',
            message: 'The managed GitHub publisher is unavailable for this runtime.',
            operationRecorded: false,
          }),
          isError: true,
        };
      try {
        canonicalRepositoryPath(sourceIdentity.workspace, parsed.data.repositoryPath);
      } catch (error) {
        if (
          !(error instanceof GithubPublicationValidationError) ||
          error.message !== 'Repository path escapes workspace'
        )
          throw error;
        return {
          content: JSON.stringify({
            code: 'GITHUB_PUBLICATION_WORKSPACE_MISMATCH',
            message:
              'This repository is outside the admitted workspace for managed publication. In a Local Mac native chat, use native git/gh with its existing filesystem and network approvals, or complete a managed workspace handoff first.',
            operationRecorded: false,
          }),
          isError: true,
        };
      }
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
            content: permissionRefusalContent(decision),
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
          phase: operation.phase,
          result: operation.result,
          failureCode: operation.failureCode,
          ...(operation.failureCode === 'APPROVAL_EXPIRED'
            ? {
                failure: toolFailure('approval_expired', 'approval', 'not_started'),
                message: toolFailureAction(
                  toolFailure('approval_expired', 'approval', 'not_started'),
                ),
              }
            : {}),
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
      const reason = error instanceof PublicationOwnerError ? error.reason : undefined;
      publicationLog.warn('GitHub publication failed', {
        requestId,
        stage,
        code: failure.code,
        ...(reason ? { reason } : {}),
      });
      return {
        content: JSON.stringify({
          requestId,
          stage,
          ...failure,
          ...(reason ? { reason } : {}),
          operationRecorded:
            stage === 'operation_dispatch' || stage === 'operation_recovery' ? 'unknown' : false,
        }),
        isError: true,
      };
    }
  };
  const execute = async (input: unknown, signal: AbortSignal, call: PublicationCall) => {
    const requestId = randomUUID();
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
        throw new PublicationOwnerError('native_call_required');
      const owner = captureGithubPublicationOwner(runtimeOwnerId, conversationId, call.turnId);
      return await run(input, signal, call, owner.assertCurrent);
    } catch (error) {
      const reason = error instanceof PublicationOwnerError ? error.reason : 'owner_capture_failed';
      publicationLog.warn('GitHub publication owner capture failed', {
        requestId,
        stage: 'owner_capture',
        reason,
        code: 'GITHUB_PUBLICATION_FAILED',
      });
      return {
        content: JSON.stringify({
          code: 'GITHUB_PUBLICATION_FAILED',
          requestId,
          stage: 'owner_capture',
          reason,
          message:
            'Mitzo could not capture the live publishing owner. Use the diagnostic request ID to inspect controller logs; this result does not establish that GitHub access was revoked.',
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

export {
  hostGithubPublishingSource,
  githubPublishingGitStorageRoots,
} from './github-publishing-source.js';
