import { ordinaryOperatorOwnsConversation } from './ordinary-operator-identity.js';
import { resolveTelosWorkSystemPrompt } from './telos-work-role-context.js';
import { assertOrdinaryCodexSnapshotCustody } from './ordinary-codex-agent-context.js';
import { buildAgentProfilePrompt } from './agent-library-prompt.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  OrdinaryWorkspaceFirstCommandSchema,
  type OrdinaryWorkspaceFirstCommand,
  OrdinaryRuntimeFirstCommandSchema,
  OrdinaryRuntimeContinuationCommandSchema,
} from '@mitzo/protocol';
import type { z } from 'zod';
import type { EventStore } from './event-store.js';
import {
  ordinaryLocalCommandFingerprint,
  ordinaryLocalCodexBootstrapId,
} from './ordinary-local-codex-admission.js';
import { canonicalJson } from './connections/capabilities/input-validation.js';
import { getCodexConversationStore } from './codex-chat-session.js';
import { getNativeResponsesStore } from './responses-chat-session.js';
import { openShellPhysicalCustodyFingerprint } from './openshell-codex-custody.js';
import { loadAccountProfiles } from './account-profiles.js';
import { getRepositoryWorkspaces, getOrdinaryWorkspaces } from './repository-workspace-runtime.js';

/** Read-only acknowledgement. A consumed receipt proves acceptance, never permission to replay. */
function assertHistoricalAcknowledgement(
  events: EventStore,
  sessionId: string,
  authSessionId: string,
  input:
    | z.infer<typeof OrdinaryRuntimeFirstCommandSchema>
    | z.infer<typeof OrdinaryRuntimeContinuationCommandSchema>
    | OrdinaryWorkspaceFirstCommand,
  first: boolean,
  ordinary = false,
): boolean {
  const workspaceId =
    'workspace' in input ? input.workspace.workspaceId : input.repositoryWorkspaceId;
  const receipt = events.getOrdinaryCommandAdmission(input.clientMsgId);
  if (!receipt) return false;
  const reject = (why = 'identity') => {
    throw Error('Historical command identity unavailable: ' + why);
  };
  const send = events.getSendCommand(input.clientMsgId);
  const meta = events.getSession(sessionId);
  const binding = events.getSessionRuntimeBinding(sessionId);
  if (
    receipt.state !== 'consumed' ||
    send?.error ||
    send?.sessionId !== sessionId ||
    !meta?.accountBinding ||
    !binding ||
    binding.version !== 2 ||
    !isDeepStrictEqual(receipt.binding, binding) ||
    (ordinary
      ? meta.ordinaryWorkspaceId !== workspaceId || meta.repositoryWorkspaceId != null
      : meta.repositoryWorkspaceId !== workspaceId || meta.ordinaryWorkspaceId != null) ||
    receipt.workspace.workspaceId !== workspaceId ||
    receipt.workspace.cwd !== meta.cwd ||
    !isDeepStrictEqual(binding.account, input.runtime.account) ||
    binding.execution.location !== input.runOn ||
    binding.execution.targetId !== input.runtime.targetId ||
    binding.harness.implementation !== input.runtime.harness ||
    !isDeepStrictEqual(receipt.selection, input.selection) ||
    !isDeepStrictEqual(
      send.payload,
      meta.agentProfile
        ? {
            ...input.payload,
            systemPrompt:
              ordinary || (input.runOn === 'local' && input.runtime.harness === 'codex')
                ? resolveTelosWorkSystemPrompt(
                    events,
                    sessionId,
                    meta.accountBinding,
                    buildAgentProfilePrompt(meta.agentProfile.definition),
                  )
                : buildAgentProfilePrompt(meta.agentProfile.definition),
          }
        : input.payload,
    )
  )
    return reject();
  // Account routing can revoke historical authority; retired models/display metadata cannot.
  loadAccountProfiles().resumeRouting(meta.accountBinding);
  if (Object.hasOwn(input.payload, 'systemPrompt')) return reject();
  if (first !== (events.getOrdinaryInitialCommandId(sessionId) === input.clientMsgId))
    return reject();
  const request = {
    clientMsgId: input.clientMsgId,
    capabilityRevision: input.capabilityRevision,
    runtime: input.runtime,
    selection: input.selection,
    payload: send.payload,
  };
  const expected = {
    binding,
    workspace: receipt.workspace,
    selection: receipt.selection,
    agentProfile: meta.agentProfile,
    // Local Codex initially fingerprints intent before compiling its pinned context.
    agentContext:
      input.runOn === 'local' &&
      input.runtime.harness === 'codex' &&
      events.getOrdinaryInitialCommandId(sessionId) === input.clientMsgId
        ? undefined
        : meta.agentContext,
  };
  const fingerprint =
    input.runOn === 'local'
      ? ordinaryLocalCommandFingerprint(input.runtime.harness, request, expected)
      : `ordinary-openshell-codex-v1:${createHash('sha256')
          .update(
            canonicalJson(
              JSON.parse(
                JSON.stringify({
                  request,
                  expected: {
                    ...expected,
                    agentContext: meta.agentProfile?.definition.contextRecipe
                      ? undefined
                      : meta.agentContext,
                  },
                }),
              ),
            ),
          )
          .digest('hex')}`;
  if (fingerprint !== receipt.requestFingerprint) return reject('fingerprint');
  if (ordinary) {
    const workspace = getOrdinaryWorkspaces(true).validateOrdinaryWorkspace(sessionId, meta.cwd!);
    const prepared = events.getOrdinaryWorkspaceSessionPreparation(workspace.allocationOperationId);
    if (
      workspace.id !== workspaceId ||
      !prepared ||
      (first && prepared.firstCommandId !== input.clientMsgId) ||
      prepared.workspaceId !== workspaceId
    )
      return reject();
  } else if (first) {
    const workspace = getRepositoryWorkspaces(true).get(workspaceId);
    const frozen = workspace.ordinaryFirstReservation;
    const prepared = events.getOrdinarySessionPreparationForConversation(sessionId);
    if (
      prepared &&
      (prepared.sessionId !== sessionId ||
        prepared.workspaceId !== workspaceId ||
        prepared.firstCommandId !== input.clientMsgId ||
        !isDeepStrictEqual(prepared.settings.binding, binding) ||
        !isDeepStrictEqual(prepared.settings.selection, input.selection))
    )
      return reject('preparation');
    const reservationFingerprint =
      prepared?.preparationFingerprint ??
      createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if (
      events.getOrdinaryInitialCommandId(sessionId) !== input.clientMsgId ||
      (frozen &&
        (frozen.conversationId !== sessionId ||
          frozen.commandFingerprint !== reservationFingerprint)) ||
      (workspace.ordinaryPreparation && !frozen)
    )
      return reject();
  }
  if (input.runtime.harness === 'claude-sdk') {
    const custody = events.getOrdinaryLocalVertexCustody(sessionId);
    if (
      !custody ||
      custody.authSessionId !== authSessionId ||
      !isDeepStrictEqual(custody.binding, binding) ||
      custody.cwd !== receipt.workspace.cwd ||
      custody.repositoryWorkspaceId !== workspaceId
    )
      return reject();
  } else if (input.runtime.harness === 'responses' || input.runtime.harness === 'gemini') {
    const custody = getNativeResponsesStore().readOrdinaryCustody(sessionId, meta.accountBinding);
    if (
      !custody ||
      custody.authSessionId !== authSessionId ||
      !isDeepStrictEqual(custody.binding, binding) ||
      !isDeepStrictEqual(custody.workspace, receipt.workspace)
    )
      return reject();
  } else {
    const native = getCodexConversationStore();
    if (input.runOn === 'openshell') {
      const custody = native.readOpenShellCustody(sessionId, meta.accountBinding);
      const artifact = native.readArtifactRuntime(sessionId, meta.accountBinding);
      if (
        !custody ||
        !ordinaryOperatorOwnsConversation(custody.authSessionId, authSessionId) ||
        !isDeepStrictEqual(custody.binding, binding) ||
        !isDeepStrictEqual(custody.workspace, receipt.workspace) ||
        !artifact ||
        custody.physicalIdentitySha256 !== openShellPhysicalCustodyFingerprint(artifact)
      )
        return reject();
      assertOrdinaryCodexSnapshotCustody(custody, meta.agentProfile, meta.agentContext);
    } else {
      const custody = native.readHostCustody(sessionId, meta.accountBinding);
      const initialId = events.getOrdinaryInitialCommandId(sessionId);
      const initial = initialId && events.getOrdinaryCommandAdmission(initialId);
      if (
        !custody ||
        !ordinaryOperatorOwnsConversation(custody.authSessionId, authSessionId) ||
        !initial ||
        initial.state !== 'consumed' ||
        !isDeepStrictEqual(initial.binding, binding) ||
        !isDeepStrictEqual(initial.workspace, receipt.workspace) ||
        custody.bootstrapId !== ordinaryLocalCodexBootstrapId(sessionId, initial.requestFingerprint)
      )
        return reject();
      assertOrdinaryCodexSnapshotCustody(custody, meta.agentProfile, meta.agentContext);
    }
    // Native read independently checks its serialized original account binding.
    const conversation = native.read(sessionId, meta.accountBinding);
    if (
      !conversation.threadId ||
      conversation.conversationId !== sessionId ||
      conversation.cwd !== receipt.workspace.cwd
    )
      return reject();
  }
  return true;
}

/** Legacy repository wire remains strict and unchanged. */
export function assertOrdinaryHistoricalAcknowledgement(
  events: EventStore,
  sessionId: string,
  authSessionId: string,
  input:
    | z.infer<typeof OrdinaryRuntimeFirstCommandSchema>
    | z.infer<typeof OrdinaryRuntimeContinuationCommandSchema>,
  first: boolean,
): boolean {
  return assertHistoricalAcknowledgement(events, sessionId, authSessionId, input, first);
}
/** V2 acknowledges retained intent without borrowing repository authority. */
export function assertOrdinaryWorkspaceHistoricalAcknowledgement(
  events: EventStore,
  sessionId: string,
  authSessionId: string,
  input: OrdinaryWorkspaceFirstCommand,
  first: boolean,
): boolean {
  return assertHistoricalAcknowledgement(
    events,
    sessionId,
    authSessionId,
    OrdinaryWorkspaceFirstCommandSchema.parse(input),
    first,
    true,
  );
}
