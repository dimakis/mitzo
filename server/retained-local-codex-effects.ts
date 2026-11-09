import { assertPreparedRepositoryAdmissionFacts } from './prepared-repository-transition.js';
import { freezePendingHostTaskData } from './pending-host-task.js';
import { PreparedRepositoryWorkspaceOwner } from './prepared-repository-workspace-owner.js';
import { withPreparedRepositoryLeaseRead } from './prepared-repository-workspace-read.js';
import { OwnedCodexLifecycleBridge } from './owned-codex-lifecycle-bridge.js';
import type { SessionRuntimeBindingV2 } from '@mitzo/protocol';
import { isDeepStrictEqual } from 'node:util';
import type { EventStore } from './event-store.js';
import type { CodexConversationStore } from './codex-conversation-store.js';
import type { AgentLibraryStore } from './agent-library-store.js';
import type {
  RepositoryWorkspaces,
  HostRepositoryReservationInput,
} from './repository-workspaces.js';
import type { LocalWorkspaceKind, LocalWorkspaceRecord } from './ordinary-local-workspace-owner.js';
import type { OrdinaryLocalCodexHostRuntime } from './ordinary-local-codex-host-runtime.js';
import { OrdinaryLocalCodexSelectionOwner } from './ordinary-local-codex-selection-owner.js';
import { ordinaryLocalCodexBootstrapId } from './ordinary-local-codex-admission.js';
import { ordinaryOperatorOwnsConversation } from './ordinary-operator-identity.js';
import { loadAccountProfiles } from './account-profiles.js';
import { FrozenHostCodexBootstrapAuthority } from './frozen-host-codex-bootstrap.js';
import type { FrozenHostCodexClient } from './frozen-host-codex-login.js';
import type { FrozenHostCodexExecutable } from './frozen-host-codex-executable.js';
import { composeOwnedLocalNativeExecutionPolicyForWorkspace } from './owned-local-codex-native-policy.js';
import { observeNativeRecoveryTurn } from './codex-interrupted-effects.js';

const unavailable = () => Error('Original local turn effects require further inspection');
/** Query-loop timing can finish after the live owner retires. Those counters
 * do not change custody; all selection, lifecycle and execution fields remain. */
function recoveryMetadata({
  durationMs: _durationMs,
  lastStateChange: _lastStateChange,
  updatedAt: _updatedAt,
  ...meta
}: NonNullable<ReturnType<EventStore['getSession']>>) {
  return meta;
}
function capture(
  events: EventStore,
  native: CodexConversationStore,
  id: string,
  auth: string,
  workspace: RepositoryWorkspaces,
) {
  const meta = events.getSession(id);
  const binding = meta?.accountBinding;
  const runtime = events.getSessionRuntimeBinding(id);
  if (
    !meta ||
    !binding ||
    meta.symposiumConfig ||
    meta.telosTaskId ||
    events.getLatestEvent(id, 'adviser_task_scope') ||
    events.getLatestEvent(id, 'telos_work_role_context') ||
    events.getLatestEvent(id, 'contributor_guidance') ||
    events.getLatestEvent(id, 'contributor_execution') ||
    events.getLatestEvent(id, 'ordinary_task_worker_allocation') ||
    meta.isHidden ||
    runtime?.version !== 2 ||
    runtime.harness.implementation !== 'codex' ||
    runtime.execution.location !== 'local' ||
    events.hasUncertainOrdinaryCommand(id) ||
    native.hasRunningCommand(id, binding)
  )
    throw unavailable();
  const descriptor = meta.ordinaryWorkspaceId
    ? workspace.getOrdinaryWorkspace(meta.ordinaryWorkspaceId)
    : meta.repositoryWorkspaceId
      ? workspace.get(meta.repositoryWorkspaceId)
      : undefined;
  if (!descriptor) throw unavailable();
  const prepared =
    'qualifiedLocalPreparation' in descriptor && descriptor.qualifiedLocalPreparation
      ? descriptor.preparedRepositoryTransitionAdoption
      : undefined;
  if (
    'qualifiedLocalPreparation' in descriptor &&
    descriptor.qualifiedLocalPreparation &&
    !prepared
  )
    throw unavailable();
  native.assertNoPendingThreadDispatch(id, binding);
  native.assertNoPendingThreadOwnership(id, binding);
  if (prepared)
    assertPreparedRepositoryAdmissionFacts(
      prepared.facts,
      events.observePreparedRepositoryContinuation(prepared.childCommandId),
      id,
      binding,
    );
  const custody = native.readHostCustody(id, binding);
  const target =
    native.completionPhaseRecoveryTarget(id, binding) ?? native.nativeRecoveryTarget(id, binding);
  const phase = target && native.completionPhase(id, binding, target.commandId, target.attempt);
  if (
    !custody ||
    !ordinaryOperatorOwnsConversation(custody.authSessionId, auth) ||
    !target ||
    native.continuationBlocker(id, binding)?.commandId !== target.commandId ||
    (phase && (phase.observedOutcome !== 'completed' || phase.priorEffectsUnknown)) ||
    native.commandStatus(id, binding, target.commandId) !== 'interrupted' ||
    !isDeepStrictEqual(native.nativeRecoveryTarget(id, binding), target)
  )
    throw unavailable();
  const execution = native.readNativeExecution(id, binding, {
    id: target.commandId,
    attempt: target.attempt,
  });
  if (
    execution?.phase !== 'accepted' ||
    execution.threadId !== target.threadId ||
    execution.turnId !== target.turnId ||
    execution.generation !== target.generation ||
    execution.policy.cwd !== meta.cwd ||
    (phase && execution.policy.policyRevision !== phase.policyRevision)
  )
    throw unavailable();
  const admission = events.getOrdinaryLocalCommandExecutionAdmission(target.commandId);
  const send = events.getSendCommand(target.commandId);
  if (
    !admission ||
    admission.state !== 'consumed' ||
    (!prepared &&
      (admission.preparedRepositoryTransition || admission.preparedRepositoryPrimaryCommandId)) ||
    (prepared &&
      (admission.preparedRepositoryTransition
        ? target.commandId !== prepared.childCommandId
        : admission.preparedRepositoryPrimaryCommandId !== prepared.childCommandId)) ||
    !isDeepStrictEqual(admission.binding, runtime) ||
    admission.workspace.cwd !== meta.cwd ||
    admission.workspace.workspaceId !== (meta.ordinaryWorkspaceId ?? meta.repositoryWorkspaceId) ||
    send?.sessionId !== id ||
    send.error ||
    native.read(id, binding).cwd !== meta.cwd
  )
    throw unavailable();
  return {
    meta: recoveryMetadata(meta),
    binding,
    runtime,
    custody,
    target,
    phase,
    execution,
    admission,
    send,
    prepared,
  };
}
/** One original reservation projection for both undispatched-input recovery and
 * inspection-only recovery. Ordinary roots retain their allocation fingerprint. */
export function retainedLocalCodexRecoveryReservation(
  meta: NonNullable<ReturnType<EventStore['getSession']>>,
  workspace: LocalWorkspaceRecord<LocalWorkspaceKind>,
  binding: SessionRuntimeBindingV2,
): Omit<HostRepositoryReservationInput, 'signal'> {
  const taskRoot = workspace.hostReservation?.taskRoot;
  if (!meta.accountBinding || !taskRoot) throw unavailable();
  return {
    id: workspace.id,
    conversationId: meta.sessionId,
    binding: meta.accountBinding,
    taskRoot,
    runtimeBinding: binding,
    ...('kind' in workspace && workspace.kind === 'ordinary'
      ? { commandFingerprint: workspace.preparationFingerprint }
      : {}),
  };
}

/** Read-only action support. Resolve optional persistence inside qualification:
 * absent state hides the action without breaking metadata. This grants neither
 * Send nor authority to settle effects. */
export function reconcilableLocalCodexCommand(
  events: EventStore,
  native: CodexConversationStore,
  id: string,
  auth: string,
  workspace: RepositoryWorkspaces | (() => RepositoryWorkspaces),
): string | undefined {
  try {
    return capture(
      events,
      native,
      id,
      auth,
      typeof workspace === 'function' ? workspace() : workspace,
    ).target.commandId;
  } catch {
    return undefined;
  }
}

/** Reopen only the original account/physical workspace to inspect an exact native
 * terminal. No chat runtime, input admission, thread/start, turn/start or queue pump. */
export async function reconcileRetainedLocalCodexEffects(options: {
  eventStore: EventStore;
  native: CodexConversationStore;
  library: AgentLibraryStore;
  workspace: RepositoryWorkspaces;
  workspaceKind?: LocalWorkspaceKind;
  reservation: Omit<HostRepositoryReservationInput, 'signal'>;
  commandId: string;
  authSessionId: string;
  runtime: OrdinaryLocalCodexHostRuntime;
  signal: AbortSignal;
  nativeExecutionReadRoots?: readonly string[];
  assertCurrent(): void;
  privateRoot?: string;
  env?: Readonly<NodeJS.ProcessEnv>;
  launch?: (home: string, executable: FrozenHostCodexExecutable) => FrozenHostCodexClient;
  launchApi?: ConstructorParameters<typeof FrozenHostCodexBootstrapAuthority>[0]['launchApi'];
}) {
  const {
    eventStore: events,
    native,
    reservation,
    authSessionId: auth,
    runtime,
    workspace,
  } = options;
  options.assertCurrent();
  const id = reservation.conversationId;
  const original = capture(events, native, id, auth, workspace);
  if (original.target.commandId !== options.commandId) throw unavailable();
  const declaration = runtime.continuationDeclaration(original.runtime.execution.targetRevision);
  const expected = {
    binding: original.admission.binding,
    workspace: original.admission.workspace,
    selection: original.admission.selection,
    agentProfile: original.meta.agentProfile,
    agentContext: original.meta.agentContext,
    bootstrapId: ordinaryLocalCodexBootstrapId(id, original.admission.requestFingerprint),
    hostId: declaration.hostId,
    runtimeContractRevision: declaration.runtimeContractRevision,
    capabilityRevision: 'retained-effects-reconciliation',
  };
  const originalPrepared =
    original.prepared && freezePendingHostTaskData(structuredClone(original.prepared));
  const preparedWitness =
    originalPrepared &&
    native.assertPreparedRepositoryRecovery(id, original.binding, originalPrepared.childCommandId);
  const assertPrepared = () => {
    options.assertCurrent();
    options.signal.throwIfAborted();
    if (!originalPrepared) return;
    const { facts, childCommandId } = originalPrepared;
    options.workspace.assertPreparedRepositoryTransitionAdopted(facts, childCommandId);
    let ancestor = childCommandId,
      qualified = false;
    for (let depth = 0; depth < 100; depth++) {
      const edge =
        events.observePreparedRepositoryContinuation(ancestor).preparedRepositoryTransition!;
      if (!edge.priorPrimaryCommandId) {
        events.observePreparedRepositoryBootstrapAdmission(childCommandId, edge.source.commandId);
        qualified = true;
        break;
      }
      ancestor = edge.priorPrimaryCommandId;
    }
    const revision = native.preparedRepositoryWorkspaceTransition(
      id,
      original.binding,
      childCommandId,
    );
    if (
      !qualified ||
      !revision ||
      !isDeepStrictEqual(revision.source, facts.request.nativeTarget) ||
      revision.fromCwd !== facts.oldWorkspace.directory ||
      revision.toCwd !== facts.newWorkspace.directory
    )
      throw unavailable();
    const primary = native
      .commands(id, original.binding)
      .find((command) => command.id === childCommandId);
    const source = facts.request.nativeTarget;
    if (
      original.target.commandId === childCommandId &&
      (!primary ||
        !isDeepStrictEqual(primary.environmentContinuation, {
          sourceCommandId: source.commandId,
          sourceThreadId: source.threadId,
          sourceTurnId: source.turnId,
          sourceGeneration: source.generation,
        }))
    )
      throw unavailable();
    preparedWitness?.assertCurrentSync();
  };
  const preparedOwner =
    originalPrepared &&
    new PreparedRepositoryWorkspaceOwner(
      workspace,
      originalPrepared.facts,
      originalPrepared.childCommandId,
      {
        assertCurrentSync: assertPrepared,
        withReadAccess: async (signal, action) =>
          withPreparedRepositoryLeaseRead(
            () => {
              const lease = bootstrap?.currentLease();
              if (!lease) throw unavailable();
              return lease;
            },
            AbortSignal.any([options.signal, signal]),
            options.commandId,
            (owner) =>
              composeOwnedLocalNativeExecutionPolicyForWorkspace(
                {
                  binding: owner.binding,
                  readableRoots: options.nativeExecutionReadRoots,
                  assertCurrentSync: () => owner.assertCurrentSync(),
                },
                () => ({
                  cwd: expected.workspace.cwd,
                  workspaceRoots: [expected.workspace.cwd],
                  mode: expected.selection.permission.mode,
                  authSessionId: auth,
                }),
                original.execution.policy.bindingRevision,
              ),
            action,
          ),
      },
    );
  assertPrepared();
  const selection = new OrdinaryLocalCodexSelectionOwner({
    events,
    library: options.library,
    workspace: options.workspace,
    workspaceKind: options.workspaceKind,
    reservation,
    operator: { assertCurrent: options.assertCurrent },
    signal: options.signal,
    commandId: options.commandId,
    continuation: true,
    qualifiedColdPrimary: preparedOwner
      ? { commandId: originalPrepared!.childCommandId, workspace: preparedOwner }
      : undefined,
  });
  const current = () => {
    options.signal.throwIfAborted();
    options.assertCurrent();
    selection.assertCurrentSync(expected);
    if (!isDeepStrictEqual(capture(events, native, id, auth, workspace), original))
      throw unavailable();
  };
  const bridge = new OwnedCodexLifecycleBridge(() => bootstrap?.currentLease());
  const bootstrap: FrozenHostCodexBootstrapAuthority = new FrozenHostCodexBootstrapAuthority({
    loadProfiles: loadAccountProfiles,
    lifecycle: bridge.lifecycle,
    ...(preparedOwner ? { assertQualifiedColdSelectionBeforeBootstrapSync: () => current() } : {}),
    observeRuntime: () => runtime.observe(),
    assertRuntimeCurrentSync: () => runtime.assertCurrentSync(),
    assertSelectionCurrent: (value) => selection.assertCurrent(value),
    assertSelectionCurrentSync: (value) => selection.assertCurrentSync(value),
    assertToolSelectionCurrent: (value, signal) => selection.assertToolCurrent(value, signal),
    retainedCustody: original.custody,
    retainedAccountBinding: original.binding,
    isSelectionPending: () => false,
    pendingSelections: () => [],
    signal: options.signal,
    privateRoot: options.privateRoot,
    baseEnv: options.env,
    launch: options.launch,
    launchApi: options.launchApi,
  });
  try {
    const reconciled = await bootstrap.withBootstrap(
      expected,
      () => {
        current();
        return true;
      },
      async (lease) => {
        const authority = () => {
          options.signal.throwIfAborted();
          options.assertCurrent();
          lease.assertCurrentSync();
          selection.assertCurrentSync(expected);
        };
        const policy = composeOwnedLocalNativeExecutionPolicyForWorkspace(
          {
            binding: original.binding,
            readableRoots: options.nativeExecutionReadRoots,
            assertCurrentSync: authority,
          },
          () => ({
            cwd: expected.workspace.cwd,
            mode: expected.selection.permission.mode,
            workspaceRoots: [expected.workspace.cwd],
            authSessionId: auth,
          }),
          original.execution.policy.bindingRevision,
        );
        // Native metadata/items do not read checkout contents. Reuse the
        // original lease's account-only I/O fence for those reads; revalidate
        // physical topology once more at the final mutation boundary below.
        const withReadOwner = lease.withQualifiedWorkspaceReadOwner;
        if (!withReadOwner) throw unavailable();
        const observation: { value?: Awaited<ReturnType<typeof observeNativeRecoveryTurn>> } = {};
        await Reflect.apply(withReadOwner, lease, [
          options.signal,
          async (
            owner: import('./frozen-host-codex-bootstrap.js').FrozenHostQualifiedWorkspaceReadOwner,
          ) => {
            current();
            owner.assertCurrentSync();
            observation.value = await observeNativeRecoveryTurn(
              (method, params) => owner.client.request(method, params),
              id,
              original.target,
              true,
              async () => {
                current();
                await owner.revalidate();
                current();
              },
              original.execution.policy.cwd,
            );
            current();
          },
        ]);
        const observed = observation.value;
        if (
          lease.withQualifiedWorkspaceReadOwner !== withReadOwner ||
          !observed ||
          !(
            observed.status === 'completed' ||
            (observed.status === 'interrupted' && observed.settledEffects)
          )
        )
          throw unavailable();
        current();
        await lease.assertCurrent();
        current();
        authority();
        native.reconcileRetainedNativeEffects(
          id,
          original.binding,
          original.target,
          original.phase,
          policy,
          observed.status,
          observed.settledEffects,
          authority,
          current,
          () => {
            if (observed.status === 'completed')
              preparedWitness?.observeNativeCompletion(original.target);
          },
        );
        return true;
      },
    );
    if (!reconciled) throw unavailable();
  } finally {
    bootstrap.currentLease()?.close();
  }
}
