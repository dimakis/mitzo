import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PreparedRepositoryTransitionSchema, type AccountBinding } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { CodexConversationStore } from './codex-conversation-store.js';
import type { OwnedLocalCodexChatAdmission } from './owned-local-codex-chat-admission.js';
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
  assertCurrentSync(): void;
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
  const transition = PreparedRepositoryTransitionSchema.parse({
    version: 1,
    preparationId: request.id,
    runtimeId: request.runtimeId,
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
  const assertNativeSource = () =>
    owners.native.assertCompletedPreparedRepositorySource(
      owners.conversationId,
      owners.binding,
      source,
    );
  const assertOriginal = () => {
    if (
      proof.facts !== facts ||
      proof.assertCurrentSync !== assertProof ||
      proof.revalidate !== revalidate ||
      proof.adopt !== adopt
    )
      throw Error('Original prepared repository proof changed');
    sync(owners.assertCurrentSync());
    sync(assertProof.call(proof));
    assertNativeSource();
  };
  let childCommandId: string | undefined;
  try {
    assertOriginal();
    await settle(revalidate.call(proof));
    assertOriginal();
    const reserved = owners.events.reservePreparedRepositoryContinuation(
      owners.conversationId,
      transition,
    );
    childCommandId = reserved.childCommandId;
    if (!reserved.fresh) throw Error('Prepared repository continuation requires reconciliation');
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
    await settle(adopt.call(proof, childCommandId));
    // The repository effect invalidates the old owner. Only the unchanged
    // operator/lease, exact native source, and new physical custody apply here.
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
    );
    sync(handoff.commit());
    sync(commitAdmission());
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
        ),
    );
    return { childCommandId, workspace: facts.newWorkspace };
  } catch (error) {
    // Includes an enqueue that persisted the native row before throwing. Current
    // claim/cold resume must see uncertainty rather than infer runnable authority.
    if (childCommandId) owners.events.markPreparedRepositoryContinuationUncertain(childCommandId);
    throw error;
  }
}
