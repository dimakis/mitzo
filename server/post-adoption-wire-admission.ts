import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  LocalCodexContinuationCommandSchema,
  type LocalCodexContinuationCommand,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import { getCodexConversationStore } from './codex-chat-session.js';
import { getRepositoryWorkspaces } from './repository-workspace-runtime.js';
import { ordinaryOperatorOwnsConversation } from './ordinary-operator-identity.js';
import { ordinaryLocalCommandFingerprint } from './ordinary-local-codex-admission.js';
import { freezePendingHostTaskData } from './pending-host-task.js';
import { canonicalJson } from './connections/capabilities/input-validation.js';

export const ordinaryWireFingerprint = (wire: unknown) =>
  createHash('sha256').update(canonicalJson(wire)).digest('hex');

/** Prove a historical discovery revision was actually admitted by this session,
 * then let the normal route requalify every selected choice against today's catalog. */
export function isKnownPostAdoptionCapability(
  events: EventStore,
  wire: LocalCodexContinuationCommand,
  primaryCommandId: string,
): boolean {
  try {
    const initialId = events.getOrdinaryInitialCommandId(wire.sessionId);
    if (!initialId) return false;
    const initial = events.observePreparedRepositoryBootstrapAdmission(primaryCommandId, initialId);
    const send = events.getSendCommand(initialId);
    const meta = events.getSession(wire.sessionId);
    if (!send || !meta?.agentProfile || initial.state !== 'consumed') return false;
    return (
      ordinaryLocalCommandFingerprint(
        'codex',
        {
          clientMsgId: initialId,
          capabilityRevision: wire.capabilityRevision,
          runtime: {
            account: initial.binding.account,
            harness: 'codex',
            targetId: initial.binding.execution.targetId,
            mode: initial.selection.permission.mode,
          },
          selection: initial.selection,
          payload: send.payload,
        },
        { workspace: initial.workspace, agentProfile: meta.agentProfile, agentContext: undefined },
      ) === initial.requestFingerprint
    );
  } catch {
    return false;
  }
}

/** A read-only receipt uses only already stored exact-wire bridge evidence. */
export function observePostAdoptionWire(events: EventStore, raw: unknown) {
  const wire = LocalCodexContinuationCommandSchema.parse(raw);
  const observed = events.observePostAdoptionWireAdmission(
    wire.clientMsgId,
    ordinaryWireFingerprint(wire),
  );
  if (!observed) return undefined;
  if (
    observed.sessionId !== wire.sessionId ||
    !observed.bridge ||
    observed.bridge.requestedWorkspace.workspaceId !== wire.repositoryWorkspaceId
  )
    throw Error('Post-adoption wire conversation changed');
  return observed;
}

/** Only explicit POST admission can capture a new bridge. Neither metadata nor
 * this identity alone grants execution: the existing native owner admits it. */
export function capturePostAdoptionWire(events: EventStore, raw: unknown, authSessionId: string) {
  const wire = LocalCodexContinuationCommandSchema.parse(raw);
  const meta = events.getSession(wire.sessionId);
  if (
    !meta?.accountBinding ||
    !meta.repositoryWorkspaceId ||
    meta.ordinaryWorkspaceId != null ||
    meta.repositoryWorkspaceId === wire.repositoryWorkspaceId ||
    events.getSendCommand(wire.clientMsgId)
  )
    throw Error('Fresh post-adoption wire admission unavailable');
  const workspaces = getRepositoryWorkspaces(true);
  const workspace = workspaces.getForConversation(wire.sessionId);
  const marker = workspace?.preparedRepositoryTransitionAdoption;
  if (!workspace || workspace.id !== meta.repositoryWorkspaceId || !marker)
    throw Error('Canonical post-adoption workspace unavailable');
  const facts = freezePendingHostTaskData(structuredClone(marker.facts));
  const target = events.preparedRepositoryWireTarget(
    wire.sessionId,
    wire.repositoryWorkspaceId,
    marker.childCommandId,
  );
  const native = getCodexConversationStore();
  const state = native.read(wire.sessionId, meta.accountBinding);
  const custody = native.readHostCustody(wire.sessionId, meta.accountBinding);
  const expectedCustody = structuredClone(custody);
  if (
    !custody ||
    !ordinaryOperatorOwnsConversation(custody.authSessionId, authSessionId) ||
    !isDeepStrictEqual(target.binding.account, wire.runtime.account) ||
    target.binding.execution.targetId !== wire.runtime.targetId ||
    !isDeepStrictEqual(target.agent, wire.selection.agent) ||
    !isDeepStrictEqual(target.context, wire.selection.context) ||
    !isDeepStrictEqual(target.permission, wire.selection.permission)
  )
    throw Error('Post-adoption wire selection changed');
  const assertCurrentSync = () => {
    workspaces.assertPreparedRepositoryTransitionAdopted(facts, marker.childCommandId);
    if (
      !isDeepStrictEqual(
        target,
        events.preparedRepositoryWireTarget(
          wire.sessionId,
          wire.repositoryWorkspaceId,
          marker.childCommandId,
        ),
      )
    )
      throw Error('Post-adoption primary changed');
    const current = native.read(wire.sessionId, meta.accountBinding!);
    if (
      current.cwd !== target.executionWorkspace.cwd ||
      current.threadId !== state.threadId ||
      current.threadGeneration !== state.threadGeneration ||
      !isDeepStrictEqual(
        native.readHostCustody(wire.sessionId, meta.accountBinding!),
        expectedCustody,
      )
    )
      throw Error('Post-adoption native owner changed');
    native.assertNoPendingThreadDispatch(wire.sessionId, meta.accountBinding!);
    native.assertNoPendingThreadOwnership(wire.sessionId, meta.accountBinding!);
    const revision = native.preparedRepositoryWorkspaceTransition(
      wire.sessionId,
      meta.accountBinding!,
      marker.childCommandId,
    );
    if (
      !revision ||
      revision.toCwd !== target.executionWorkspace.cwd ||
      !isDeepStrictEqual(revision.source, marker.facts.request.nativeTarget)
    )
      throw Error('Post-adoption native workspace proof changed');
  };
  assertCurrentSync();
  return {
    target,
    assertCurrentSync,
    knownCapability: isKnownPostAdoptionCapability(events, wire, marker.childCommandId),
  };
}
