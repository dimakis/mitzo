import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TelosOrdinaryWorkRoleSetupIntent } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import { TelosWorkError, type TelosWorkActor, type TelosWorkStore } from './telos-work-store.js';

type Selection = NonNullable<TelosOrdinaryWorkRoleSetupIntent['input']['adoption']>;
export function telosAdoptionTransition(setup: TelosOrdinaryWorkRoleSetupIntent) {
  return {
    sessionId: setup.input.adoption!.conversationId,
    operationId: setup.allocationOperationId,
    fingerprint: createHash('sha256').update(JSON.stringify(setup)).digest('hex'),
    expectedEpoch: setup.input.adoption!.expectedEpoch,
  };
}
export interface TelosAdoptionRuntime {
  assertQuiescent(conversationId: string, operationId: string): void;
  assertRetirable?(conversationId: string, operationId: string): void;
  retire(
    conversationId: string,
    assertCurrent: () => void,
    signal: AbortSignal,
    operationId: string,
  ): Promise<void>;
}

/** Bounded identity only: never copies transcript, credentials, grants or drafts. */
export function observeTelosAdoptionTarget(
  events: EventStore,
  workspaces: RepositoryWorkspaces,
  conversationId: string,
): Selection {
  const session = events.getSession(conversationId);
  const workspace = workspaces.validateRetainedOrdinaryWorkspace(conversationId);
  const settings = events.getOrdinaryWorkspaceConversationSettings(conversationId);
  if (
    !session ||
    session.isHidden ||
    session.sessionType === 'symposium' ||
    session.conversationSource === 'external_import' ||
    !workspace ||
    !settings ||
    session.repositoryWorkspaceId != null ||
    session.ordinaryWorkspaceId !== workspace.id ||
    session.cwd !== workspace.directory ||
    !session.accountBinding ||
    settings.binding.harness.implementation !== 'codex' ||
    settings.binding.execution.location !== 'local' ||
    !isDeepStrictEqual(workspace.binding, session.accountBinding) ||
    !isDeepStrictEqual(workspace.settings.binding, settings.binding)
  )
    throw new TelosWorkError('conflict', 'Compatible retained Local Mac Codex chat required');
  const custodyHash = createHash('sha256')
    .update(
      JSON.stringify({
        conversationId,
        workspace,
        settings,
        binding: session.accountBinding,
        model: session.selectedModel,
        thinking: session.reasoningEffort,
        mode: session.mode,
        profile: session.agentProfile,
        context: session.agentContext,
      }),
    )
    .digest('hex');
  return {
    conversationId,
    workspaceId: workspace.id,
    expectedEpoch: events.contextTransitions.observe(conversationId).epoch,
    custodyHash,
  };
}

/** Composes canonical role, context, workspace and command owners. The existing
 * role intent is the durable journal; its operation ID also owns the enduring
 * command hold. No allocation/provider dispatch port exists here. */
export async function adoptTelosExistingChat(input: {
  actor: TelosWorkActor;
  setup: TelosOrdinaryWorkRoleSetupIntent;
  work: TelosWorkStore;
  events: EventStore;
  workspaces: RepositoryWorkspaces;
  runtime: TelosAdoptionRuntime;
  signal: AbortSignal;
  authorize(): Promise<void>;
  assertCurrent(): void;
  retainContext(conversationId: string): Promise<void>;
}) {
  const { setup, events, work, workspaces, runtime, signal } = input;
  const selected = setup.input.adoption!;
  const transition = telosAdoptionTransition(setup);
  const assertCustody = () => {
    signal.throwIfAborted();
    input.assertCurrent();
    const current = observeTelosAdoptionTarget(events, workspaces, selected.conversationId);
    if (
      current.custodyHash !== selected.custodyHash ||
      current.workspaceId !== selected.workspaceId
    )
      throw new TelosWorkError('conflict', 'Reviewed existing-chat custody changed');
  };
  await input.authorize();
  assertCustody();
  const retained = work.ordinaryRoleSetupForHost(setup.input.requestId, input.actor);
  if (retained?.receipt) {
    // Assignment is committed under the hold before context. Its immutable
    // receipt permits recovery after partial context writes or a work edit.
    await input.retainContext(selected.conversationId);
    await input.authorize();
    events.contextTransitions.release(transition, 'committed', () => {
      assertCustody();
    });
    return retained.receipt;
  }
  const assertIdle = () => {
    assertCustody();
    events.assertOrdinaryContextQuiescent(selected.conversationId);
    runtime.assertQuiescent(selected.conversationId, transition.operationId);
    work.assertConversationAvailableForAdoption(selected.conversationId);
  };
  events.contextTransitions.withAdmissionLock(() => {
    assertIdle();
    if (!events.contextTransitions.hasRetirement(transition))
      runtime.assertRetirable?.(selected.conversationId, transition.operationId);
    if (
      !events.contextTransitions.read(transition.operationId) &&
      events
        .getOrdinaryContributorContextEvents(selected.conversationId)
        .some((event) => ['contributor_guidance', 'telos_work_role_context'].includes(event.type))
    )
      throw new TelosWorkError(
        'conflict',
        'Existing immutable contributor context cannot be replaced',
      );
    const held = events.contextTransitions.begin(transition);
    if (held.phase !== 'held')
      throw new TelosWorkError('conflict', 'Original adoption was released');
  });
  // Cancellation or retirement failure retains the same hold and journal.
  if (!events.contextTransitions.hasRetirement(transition)) {
    await runtime.retire(selected.conversationId, assertCustody, signal, transition.operationId);
    events.contextTransitions.retainRetirement(transition, assertIdle);
  }
  await input.authorize();
  assertIdle();
  const receipt = work.completeOrdinaryRoleSetup(
    setup,
    selected.conversationId,
    input.actor,
    assertIdle,
  );
  await input.retainContext(selected.conversationId);
  await input.authorize();
  events.contextTransitions.release(transition, 'committed', () => {
    assertCustody();
    if (!work.ordinaryRoleSetupForHost(setup.input.requestId, input.actor)?.receipt)
      throw new TelosWorkError('conflict', 'Original assignment receipt required');
  });
  return receipt;
}
