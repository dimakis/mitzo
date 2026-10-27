import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { freezePendingHostTaskData } from './pending-host-task.js';
import { PreparedRepositoryTransitionSchema, type AccountBinding } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import {
  preparedRepositoryResultSha256,
  type CodexConversationStore,
} from './codex-conversation-store.js';
import type {
  OwnedLocalCodexChatAdmission,
  CapturedPreparedRepositoryPrimarySource,
} from './owned-local-codex-chat-admission.js';
import type { OrdinaryLocalCodexAdmissionExpectation } from './ordinary-local-codex-admission.js';
import type {
  PreparedRepositoryTransitionFacts,
  PreparedRepositoryTransitionProof,
} from './prepared-repository-transition.js';

interface Owners {
  events: EventStore;
  native: CodexConversationStore;
  admission: OwnedLocalCodexChatAdmission;
  conversationId: string;
  binding: AccountBinding;
  expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>;
  /** Captured before repository lookup/digest awaits by the actual barrier.
   * The barrier also disposes it in finally if capture itself fails. */
  preparedPrimarySource?: CapturedPreparedRepositoryPrimarySource;
  queueFence?: import('./codex-conversation-store.js').PreparedRepositoryQueueFence;
  hasPendingExplicitCommands?(): boolean;
  assertCurrentSync(): void;
  /** Original retained-transport preclaim lifetime; contains no workspace assertion. */
  assertConversationCurrentSync(): void;
  /** Operator and selected native lease only: old workspace custody is no longer
   * current after the repository CAS and must not be asserted afterward. */
  assertOperatorAndLeaseCurrentSync(): void;
  prepareWorkspaceHandoff(
    facts: PreparedRepositoryTransitionFacts,
    expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>,
    childCommandId: string,
  ): { assertCurrentSync(): void; commit(): void };
}
function sync(result: unknown): void {
  if (result === undefined) return;
  void Promise.resolve(result).catch(() => {});
  throw Error('Prepared repository owner must provide synchronous proof');
}
async function settle(result: Promise<void>): Promise<void> {
  const checked: unknown = await result;
  if (checked !== undefined) throw Error('Prepared repository owner returned an invalid proof');
}
function assertFrozenFacts(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (!Object.isFrozen(value)) throw Error('Original prepared repository facts unavailable');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor))
      throw Error('Prepared repository facts must retain data identity');
    assertFrozenFacts(descriptor.value);
  }
}

/** Existing admission/FIFO operation, not a scheduler or authority producer.
 * Called only inside the original retained-transport preclaim barrier, using the
 * actual repository owner's fresh proof and current operator/native lease. */
export async function performPreparedRepositoryPrimaryTransition(
  proof: PreparedRepositoryTransitionProof,
  owners: Owners,
) {
  let primarySource: CapturedPreparedRepositoryPrimarySource | undefined =
    owners.preparedPrimarySource;
  let childCommandId: string | undefined;
  try {
    const facts = proof.facts;
    const assertProof = proof.assertCurrentSync;
    const revalidate = proof.revalidate;
    const adopt = proof.adopt;
    assertFrozenFacts(facts);
    const request = facts.request;
    if (
      facts.version !== 'prepared-repository-transition-v1' ||
      request.conversationId !== owners.conversationId ||
      !isDeepStrictEqual(request.binding, owners.binding) ||
      !isDeepStrictEqual(request.runtimeBinding, owners.expected.binding) ||
      !isDeepStrictEqual(
        owners.events.getSessionRuntimeBinding(owners.conversationId),
        request.runtimeBinding,
      ) ||
      facts.oldWorkspace.id !== owners.expected.workspace.workspaceId ||
      facts.oldWorkspace.directory !== owners.expected.workspace.cwd
    )
      throw Error('Original prepared repository binding unavailable');
    const providedPrimarySource = owners.preparedPrimarySource;
    if (providedPrimarySource) sync(providedPrimarySource.assertCurrentSync());
    const originalConversationFence = owners.assertConversationCurrentSync;
    const assertConversation = () => {
      if (owners.assertConversationCurrentSync !== originalConversationFence)
        throw Error('Original conversation fence changed');
      sync(Reflect.apply(originalConversationFence, owners, []));
    };
    primarySource =
      owners.preparedPrimarySource ??
      owners.admission.capturePreparedRepositoryPrimarySource(
        request.nativeTarget,
        assertConversation,
        owners.queueFence,
      );
    if (primarySource) sync(primarySource.assertCurrentSync());
    const priorPrimaryCommandId = owners.admission.currentPreparedRepositoryPrimaryCommandId();
    const transition = PreparedRepositoryTransitionSchema.parse({
      version: 1,
      preparationId: request.id,
      runtimeId: request.runtimeId,
      ...(priorPrimaryCommandId ? { priorPrimaryCommandId } : {}),
      source: {
        ...request.nativeTarget,
        callId: request.prepareCallId,
        requestHash: request.requestHash,
        resultSha256: facts.resultSha256,
      },
      oldWorkspace: facts.oldWorkspace,
      newWorkspace: {
        kind: facts.newWorkspace.kind,
        id: facts.newWorkspace.id,
        directory: facts.newWorkspace.directory,
        featureBranch: facts.newWorkspace.featureBranch,
        baseOid: facts.newWorkspace.baseOid,
        taskIdentitySha256: createHash('sha256')
          .update(JSON.stringify(facts.newWorkspace.taskIdentity))
          .digest('hex'),
      },
      consumedScopeSha256: facts.consumedScopeSha256,
      materializedRecordSha256: facts.materializedRecordSha256,
    });
    const source = { ...transition.source, toolName: 'PrepareLocalRepository' as const };
    const assertNativeSource = () => {
      if (owners.preparedPrimarySource !== providedPrimarySource)
        throw Error('Original prepared primary source changed');
      owners.native.assertCompletedPreparedRepositorySource(
        owners.conversationId,
        owners.binding,
        source,
        primarySource,
        owners.queueFence,
      );
    };
    const assertOriginal = () => {
      if (
        proof.facts !== facts ||
        proof.assertCurrentSync !== assertProof ||
        proof.revalidate !== revalidate ||
        proof.adopt !== adopt
      )
        throw Error('Original prepared repository proof changed');
      assertConversation();
      sync(owners.assertCurrentSync());
      sync(Reflect.apply(assertProof, proof, []));
      assertNativeSource();
    };
    assertOriginal();
    await settle(Reflect.apply(revalidate, proof, []));
    assertOriginal();
    const reserved = owners.events.reservePreparedRepositoryContinuation(
      owners.conversationId,
      transition,
    );
    childCommandId = reserved.childCommandId;
    if (!reserved.fresh) throw Error('Prepared repository continuation requires reconciliation');
    primarySource?.bindOutgoing(childCommandId);
    const expected = {
      ...structuredClone(owners.expected),
      workspace: reserved.admission.workspace,
      selection: reserved.admission.selection,
    };
    const commitAdmission = owners.admission.preparePreparedRepositoryPrimary(
      childCommandId,
      expected,
      transition,
    );
    const handoff = owners.prepareWorkspaceHandoff(facts, expected, childCommandId);
    assertOriginal();
    await settle(Reflect.apply(adopt, proof, [childCommandId]));
    // The repository effect invalidates the old owner. Only the unchanged
    // operator/lease, exact native source, and new physical custody apply here.
    assertConversation();
    sync(owners.assertOperatorAndLeaseCurrentSync());
    assertNativeSource();
    sync(handoff.assertCurrentSync());
    owners.events.commitPreparedRepositoryContinuation(
      owners.conversationId,
      childCommandId,
      transition,
    );
    owners.native.adoptPreparedRepositoryWorkspace(
      owners.conversationId,
      owners.binding,
      source,
      facts.oldWorkspace.directory,
      facts.newWorkspace.directory,
      primarySource,
      owners.queueFence,
    );
    const queued = owners.native
      .commands(owners.conversationId, owners.binding)
      .filter((command) => command.status === 'queued');
    if (owners.queueFence)
      owners.events.rebindPreparedRepositoryQueuedCommands(
        owners.conversationId,
        childCommandId,
        transition,
        queued.map((command) => command.id),
      );
    sync(handoff.commit());
    sync(commitAdmission());
    if (owners.queueFence && (queued.length || owners.hasPendingExplicitCommands?.())) {
      // A workspace revision does not require a provider command. New explicit
      // steering wins; retain the transition anchor only as custody evidence.
      owners.events.finalizePreparedRepositoryContinuation(
        owners.conversationId,
        childCommandId,
        transition,
        () => {
          owners.queueFence!.assertCurrentSync();
          if (
            owners.native.read(owners.conversationId, owners.binding).cwd !==
            facts.newWorkspace.directory
          )
            throw Error('Prepared repository native projection incomplete');
        },
      );
      owners.native.completePreparedRepositoryTransition(
        owners.conversationId,
        owners.binding,
        owners.queueFence,
        childCommandId,
        facts.newWorkspace.directory,
      );
      return { childCommandId, workspace: facts.newWorkspace };
    }
    const input = {
      id: childCommandId,
      prompt: reserved.payload.text,
      intent: reserved.payload.intent,
      model: reserved.admission.selection.model,
      reasoningEffort: reserved.admission.selection.thinking,
    };
    owners.admission.assertBeforeEnqueue(input);
    if (
      !owners.native.enqueuePreparedRepositoryContinuation(
        owners.conversationId,
        owners.binding,
        source,
        input,
        primarySource,
        owners.queueFence,
      )
    )
      throw Error('Prepared repository child enqueue requires reconciliation');
    owners.events.finalizePreparedRepositoryContinuation(
      owners.conversationId,
      childCommandId,
      transition,
      () =>
        owners.native.assertQueuedPreparedRepositoryContinuation(
          owners.conversationId,
          owners.binding,
          source,
          input,
          primarySource,
          owners.queueFence,
        ),
    );
    if (owners.queueFence)
      owners.native.completePreparedRepositoryTransition(
        owners.conversationId,
        owners.binding,
        owners.queueFence,
        childCommandId,
        facts.newWorkspace.directory,
      );
    return { childCommandId, workspace: facts.newWorkspace };
  } catch (error) {
    // Includes an enqueue that persisted the native row before throwing. Current
    // claim/cold resume must see uncertainty rather than infer runnable authority.
    if (childCommandId) owners.events.markPreparedRepositoryContinuationUncertain(childCommandId);
    throw error;
  } finally {
    primarySource?.dispose();
  }
}

/** Reconcile only projections of the existing authoritative custody marker.
 * Safe before cold bootstrap: current operator authorization is required here,
 * and the normal admission owner still obtains fresh physical/runtime proofs
 * before any provider dispatch. No allocation, transfer or automatic turn. */
export function reconcilePreparedRepositoryTransitionProjection(owners: {
  workspace: Pick<
    import('./repository-workspaces.js').RepositoryWorkspaces,
    | 'getForConversation'
    | 'getOrdinaryWorkspaceForConversation'
    | 'findPreparedRepositoryTransitionCandidate'
    | 'assertPreparedRepositoryTransitionAdopted'
  >;
  events: EventStore;
  native: CodexConversationStore;
  conversationId: string;
  binding: AccountBinding;
  assertCurrentSync(): void;
}) {
  const assertCurrent = owners.assertCurrentSync;
  const current = () => {
    if (owners.assertCurrentSync !== assertCurrent)
      throw Error('Prepared repository recovery owner changed');
    sync(Reflect.apply(assertCurrent, owners, []));
  };
  current();
  const record = owners.workspace.getForConversation(owners.conversationId);
  const marker = record?.preparedRepositoryTransitionAdoption;
  const held = owners.native.preparedRepositoryTransitionHold(
    owners.conversationId,
    owners.binding,
  );
  const ordinary =
    !record && owners.workspace.getOrdinaryWorkspaceForConversation(owners.conversationId);
  const oldWorkspace = record
    ? { kind: 'repository' as const, id: record.id, directory: record.directory! }
    : ordinary
      ? { kind: 'ordinary' as const, id: ordinary.id, directory: ordinary.directory }
      : undefined;
  if (held && oldWorkspace && held.fromCwd === oldWorkspace.directory) {
    const candidate = owners.workspace.findPreparedRepositoryTransitionCandidate({
      binding: owners.binding,
      conversationId: owners.conversationId,
      sourceTarget: held.source,
      oldWorkspace,
    });
    if (candidate) {
      const request = candidate.request;
      const result = owners.native.replayToolResult(
        owners.conversationId,
        owners.binding,
        held.source.commandId,
        request.prepareCallId,
        {
          turnId: held.source.turnId,
          toolName: 'PrepareLocalRepository',
          requestHash: request.requestHash,
        },
      );
      if (!result || result.isError) throw Error('Untransferred repository result unavailable');
      const source = {
        ...held.source,
        callId: request.prepareCallId,
        requestHash: request.requestHash,
        resultSha256: preparedRepositoryResultSha256(result),
      };
      current();
      const fence = owners.native.reconcilePreparedRepositoryWorkspaceProjection(
        owners.conversationId,
        owners.binding,
        { ...source, toolName: 'PrepareLocalRepository' },
        oldWorkspace.directory,
        oldWorkspace.directory,
      );
      owners.events.suspendUntransferredPreparedRepositoryContinuation(
        owners.conversationId,
        source,
        oldWorkspace,
        request.id,
      );
      owners.native.suspendUntransferredPreparedRepositoryTransition(
        owners.conversationId,
        owners.binding,
        fence,
      );
      current();
      return undefined;
    }
    if (!marker) throw Error('Untransferred repository candidate requires inspection');
  }
  if (!record || !marker) return undefined;
  const facts = freezePendingHostTaskData(structuredClone(marker.facts));
  owners.workspace.assertPreparedRepositoryTransitionAdopted(facts, marker.childCommandId);
  const anchor = owners.events.observePreparedRepositoryContinuation(marker.childCommandId);
  const transition = anchor.preparedRepositoryTransition!;
  if (
    facts.request.conversationId !== owners.conversationId ||
    !isDeepStrictEqual(facts.request.binding, owners.binding) ||
    !isDeepStrictEqual(anchor.binding, facts.request.runtimeBinding) ||
    !isDeepStrictEqual(transition.source, {
      ...facts.request.nativeTarget,
      callId: facts.request.prepareCallId,
      requestHash: facts.request.requestHash,
      resultSha256: facts.resultSha256,
    }) ||
    !isDeepStrictEqual(transition.oldWorkspace, facts.oldWorkspace) ||
    transition.newWorkspace.id !== facts.newWorkspace.id ||
    transition.newWorkspace.directory !== facts.newWorkspace.directory ||
    transition.newWorkspace.featureBranch !== facts.newWorkspace.featureBranch ||
    transition.newWorkspace.baseOid !== facts.newWorkspace.baseOid ||
    transition.newWorkspace.taskIdentitySha256 !==
      createHash('sha256').update(JSON.stringify(facts.newWorkspace.taskIdentity)).digest('hex') ||
    transition.consumedScopeSha256 !== facts.consumedScopeSha256 ||
    transition.materializedRecordSha256 !== facts.materializedRecordSha256
  )
    throw Error('Prepared repository recovery evidence changed');
  const meta = owners.events.getSession(owners.conversationId);
  const native = owners.native.read(owners.conversationId, owners.binding);
  if (
    anchor.state === 'consumed' &&
    meta?.cwd === facts.newWorkspace.directory &&
    meta.repositoryWorkspaceId === facts.newWorkspace.id &&
    native.cwd === facts.newWorkspace.directory &&
    !owners.native.hasPreparedRepositoryTransitionHold(owners.conversationId, owners.binding)
  )
    return record;
  // Validate the complete decreasing historical source chain before repairing
  // descriptive projections. Neither a path nor a model-selected ID is enough.
  let root = marker.childCommandId;
  let rootCommand: string | undefined;
  for (let depth = 0; depth < 100; depth++) {
    const edge =
      owners.events.observePreparedRepositoryContinuation(root).preparedRepositoryTransition!;
    if (!edge.priorPrimaryCommandId) {
      rootCommand = edge.source.commandId;
      break;
    }
    root = edge.priorPrimaryCommandId;
  }
  if (!rootCommand) throw Error('Prepared repository recovery lineage unavailable');
  owners.events.observePreparedRepositoryBootstrapAdmission(marker.childCommandId, rootCommand);
  current();
  const fence = owners.native.reconcilePreparedRepositoryWorkspaceProjection(
    owners.conversationId,
    owners.binding,
    { ...transition.source, toolName: 'PrepareLocalRepository' },
    facts.oldWorkspace.directory,
    facts.newWorkspace.directory,
  );
  owners.events.reconcilePreparedRepositoryContinuation(
    owners.conversationId,
    marker.childCommandId,
    transition,
  );
  const queued = owners.native
    .commands(owners.conversationId, owners.binding)
    .filter((command) => command.status === 'queued' && command.id !== marker.childCommandId);
  owners.events.rebindPreparedRepositoryQueuedCommands(
    owners.conversationId,
    marker.childCommandId,
    transition,
    queued.map((command) => command.id),
  );
  // An unexecuted old automatic child cannot run ahead of explicit recovery.
  if (
    owners.native.commandStatus(owners.conversationId, owners.binding, marker.childCommandId) ===
    'queued'
  )
    owners.native.cancelQueued(owners.conversationId, owners.binding, marker.childCommandId);
  current();
  owners.workspace.assertPreparedRepositoryTransitionAdopted(facts, marker.childCommandId);
  if (anchor.state !== 'consumed')
    owners.events.finalizePreparedRepositoryContinuation(
      owners.conversationId,
      marker.childCommandId,
      transition,
      () => fence.assertCurrentSync(),
    );
  owners.native.completePreparedRepositoryTransition(
    owners.conversationId,
    owners.binding,
    fence,
    marker.childCommandId,
    facts.newWorkspace.directory,
  );
  current();
  return owners.workspace.getForConversation(owners.conversationId)!;
}
