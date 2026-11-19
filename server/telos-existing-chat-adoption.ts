import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TelosOrdinaryWorkRoleSetupIntent } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import { TelosWorkError, type TelosWorkActor, type TelosWorkStore } from './telos-work-store.js';
import { ordinaryOperatorOwnsConversation } from './ordinary-operator-identity.js';
import type { TelosRoleSettings } from './telos-role-settings.js';

type Selection = NonNullable<TelosOrdinaryWorkRoleSetupIntent['input']['adoption']>;
export type { TelosRoleSettings } from './telos-role-settings.js';

const CLAUDE_PROVIDERS: readonly string[] = [
  'anthropic-vertex',
  'anthropic-claude',
  'anthropic-api',
];
/** Stable named reasons an existing chat cannot be adopted. Each message starts
 * with its code so the proposing agent can act on it without a generic retry. */
export type TelosAdoptionBlocker =
  | 'existing_chat_openshell'
  | 'existing_chat_foreign_operator'
  | 'existing_chat_busy'
  | 'existing_chat_incompatible';
const ADOPTION_REFUSALS: Record<TelosAdoptionBlocker, string> = {
  existing_chat_openshell:
    'OpenShell chats cannot be adopted into a Telos role. Select an idle Local Mac Codex or Claude chat.',
  existing_chat_foreign_operator:
    'This chat was started by another operator login. Only its own operator can adopt it into a Telos role.',
  existing_chat_busy:
    'The selected chat is busy or has unfinished, queued or uncertain work. Wait until it is idle, then propose adoption again.',
  existing_chat_incompatible:
    'Select an idle Local Mac Codex chat in an ordinary workspace or an idle Local Mac Claude chat that has started its first turn.',
};
export class TelosAdoptionRefusal extends TelosWorkError {
  constructor(
    readonly startupBlocker: TelosAdoptionBlocker,
    detail?: string,
  ) {
    super('conflict', `${startupBlocker}: ${detail ?? ADOPTION_REFUSALS[startupBlocker]}`);
  }
}
export { qualifyTelosRoleWorkspace, telosRoleToolRoute } from './telos-role-settings.js';
/** Reviewed latest admitted settings for either supported existing-chat kind. */
export function telosAdoptionSettings(
  events: EventStore,
  conversationId: string,
): TelosRoleSettings | undefined {
  const session = events.getSession(conversationId);
  if (session?.repositoryWorkspaceId == null)
    return events.getOrdinaryWorkspaceConversationSettings(conversationId) ?? undefined;
  const binding = events.getSessionRuntimeBinding(conversationId);
  const admission = events.getLatestOrdinaryCommandAdmission(conversationId);
  if (
    binding?.version !== 2 ||
    !admission ||
    admission.state !== 'consumed' ||
    !isDeepStrictEqual(admission.binding, binding) ||
    admission.workspace.workspaceId !== session.repositoryWorkspaceId ||
    admission.workspace.cwd !== session.cwd
  )
    return undefined;
  return {
    version: 2,
    binding,
    selection: admission.selection,
    workspace: { kind: 'repository', workspaceId: session.repositoryWorkspaceId },
  };
}

/** Existing Local Mac Claude SDK chat: repository custody, SDK custody, current
 * operator and latest consumed admission must agree. Bounded identity only. */
function observeRepositoryClaudeTarget(
  events: EventStore,
  workspaces: RepositoryWorkspaces,
  conversationId: string,
  operatorAuthSessionId: string | undefined,
): Selection {
  const session = events.getSession(conversationId)!;
  const binding = events.getSessionRuntimeBinding(conversationId);
  if (binding?.execution.location === 'openshell')
    throw new TelosAdoptionRefusal('existing_chat_openshell');
  let custody: ReturnType<EventStore['getOrdinaryLocalVertexCustody']>;
  try {
    custody = events.getOrdinaryLocalVertexCustody(conversationId);
  } catch (cause) {
    // A retained but inconsistent SDK custody record is never adoptable. Keep
    // the original cause for diagnostics; the public reason stays bounded.
    throw Object.assign(new TelosAdoptionRefusal('existing_chat_incompatible'), { cause });
  }
  const settings = telosAdoptionSettings(events, conversationId);
  const workspace = workspaces.getForConversation(conversationId);
  if (
    !binding ||
    binding.harness.implementation !== 'claude-sdk' ||
    binding.execution.location !== 'local' ||
    !CLAUDE_PROVIDERS.includes(binding.account.provider) ||
    !session.accountBinding ||
    !custody ||
    !settings ||
    !workspace ||
    workspace.state !== 'claimed' ||
    workspace.sandbox ||
    workspace.id !== session.repositoryWorkspaceId ||
    workspace.directory !== session.cwd ||
    custody.repositoryWorkspaceId !== workspace.id ||
    custody.cwd !== workspace.directory ||
    !isDeepStrictEqual(custody.binding, binding) ||
    workspace.binding.accountId !== session.accountBinding.accountId ||
    workspace.binding.provider !== session.accountBinding.provider ||
    workspace.binding.profileRevision !== session.accountBinding.profileRevision
  )
    throw new TelosAdoptionRefusal('existing_chat_incompatible');
  if (!ordinaryOperatorOwnsConversation(custody.authSessionId, operatorAuthSessionId))
    throw new TelosAdoptionRefusal('existing_chat_foreign_operator');
  const custodyHash = createHash('sha256')
    .update(
      JSON.stringify({
        conversationId,
        workspace: {
          id: workspace.id,
          directory: workspace.directory,
          featureBranch: workspace.featureBranch,
          binding: workspace.binding,
        },
        settings,
        custody,
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
    workspaceKind: 'repository',
    expectedEpoch: events.contextTransitions.observe(conversationId).epoch,
    custodyHash,
  };
}
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
  operatorAuthSessionId?: string,
): Selection {
  const session = events.getSession(conversationId);
  if (
    session &&
    !session.isHidden &&
    session.sessionType !== 'symposium' &&
    session.conversationSource !== 'external_import' &&
    session.repositoryWorkspaceId != null &&
    session.ordinaryWorkspaceId == null
  )
    return observeRepositoryClaudeTarget(events, workspaces, conversationId, operatorAuthSessionId);
  if (
    session &&
    events.getSessionRuntimeBinding(conversationId)?.execution.location === 'openshell'
  )
    throw new TelosAdoptionRefusal('existing_chat_openshell');
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
    throw new TelosAdoptionRefusal('existing_chat_incompatible');
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
    const current = observeTelosAdoptionTarget(
      events,
      workspaces,
      selected.conversationId,
      input.actor.kind === 'operator' ? input.actor.id : undefined,
    );
    if (
      current.custodyHash !== selected.custodyHash ||
      current.workspaceId !== selected.workspaceId ||
      current.workspaceKind !== selected.workspaceKind
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
