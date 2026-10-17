import {
  resolveTelosWorkRoleContext,
  resolveTelosWorkSystemPrompt,
} from './telos-work-role-context.js';
import { assembleSourceSnapshots } from './source-snapshot-context.js';
import { isDeepStrictEqual } from 'node:util';
import { OrdinaryCodexFirstCommandSchema } from '@mitzo/protocol';
import type { SessionTransport } from '@mitzo/harness';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { buildAgentProfilePrompt } from './agent-library-prompt.js';
import { hasPersistentRevocationAuthority } from './auth.js';
import { createOrdinaryOpenShellCodexEntryOwner } from './ordinary-openshell-codex-entry-owner.js';
import { OrdinaryLocalCodexCommandRequestSchema } from './ordinary-local-codex-admission.js';
import { getCodexConversationStore, getCodexRuntime } from './codex-chat-session.js';
import { eventStore, registry, prepareOwnedCodexChat, echoOwnedCodexCommand } from './chat.js';
import { custodianControllerMode, custodianOwnerMode } from './symposium-custodian-mode.js';

export const OrdinaryOpenShellCodexCommandRequestSchema = OrdinaryCodexFirstCommandSchema.refine(
  (request) => request.runOn === 'openshell',
);
type SessionUpsert = Parameters<typeof eventStore.upsertSession>[0];
const unavailable = () => new Error('Ordinary OpenShell Codex entry unavailable');

export function canResumeOwnedOpenShellCodexDriver(
  sessionId: string,
  authSessionId: string,
): boolean {
  try {
    if (
      !hasPersistentRevocationAuthority() ||
      process.env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED !== '1' ||
      custodianControllerMode ||
      custodianOwnerMode ||
      registry.findBySessionId(sessionId)
    )
      return false;
    const meta = eventStore.getSession(sessionId);
    const binding = eventStore.getSessionRuntimeBinding(sessionId);
    if (
      !meta?.accountBinding ||
      binding?.execution.location !== 'openshell' ||
      binding.harness.implementation !== 'codex'
    )
      return false;
    const native = getCodexConversationStore();
    const custody = native.readOpenShellCustody(sessionId, meta.accountBinding);
    return (
      custody?.authSessionId === authSessionId &&
      isDeepStrictEqual(custody.binding, binding) &&
      Boolean(native.read(sessionId, meta.accountBinding).threadId) &&
      !native.hasRunningCommand(sessionId, meta.accountBinding)
    );
  } catch {
    return false;
  }
}

/** Uses the existing ManagedSession, native FIFO, receipt and shared query loop. */
export async function sendOwnedOpenShellCodexCommand(input: {
  sessionId: string;
  command: unknown;
  operatorConnectionId: string;
  signal?: AbortSignal;
}) {
  const captured = captureAgentLibraryAuthorization(input.operatorConnectionId);
  captured.assertCurrent();
  const session = registry.findBySessionId(input.sessionId)?.session;
  const owner = session?.ordinaryRuntimeOwner;
  if (
    !owner ||
    owner.location !== 'openshell' ||
    owner.authSessionId !== captured.auth.id ||
    session?.ownedLocalAuthSessionId !== captured.auth.id
  )
    throw unavailable();
  const result = await owner.admit(structuredClone(input.command), input.signal);
  captured.assertCurrent();
  if (result.dispatched) {
    const native = getCodexRuntime(session);
    if (!native) throw unavailable();
    await native.resumeAfterExplicitSend();
  }
  return { ...result, sessionId: input.sessionId };
}

export async function startOwnedOpenShellCodexCommand(
  transport: SessionTransport,
  clientId: string,
  input: {
    command: unknown;
    meta: SessionUpsert;
    taskRoot: string;
    operatorConnectionId: string;
    ownerConnectionId: string;
    signal: AbortSignal;
    resume?: boolean;
    preparationOperationId?: string;
  },
) {
  if (
    process.env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED !== '1' ||
    custodianControllerMode ||
    custodianOwnerMode ||
    !input.meta.accountBinding ||
    !input.meta.repositoryWorkspaceId
  )
    throw unavailable();
  const preparationOperationId = input.preparationOperationId;
  const requestedResume = input.resume;
  const resume = requestedResume === true;
  if (
    (preparationOperationId !== undefined &&
      (typeof preparationOperationId !== 'string' ||
        preparationOperationId.length > 200 ||
        !/^\S+$/.test(preparationOperationId))) ||
    (requestedResume !== undefined && typeof requestedResume !== 'boolean') ||
    (resume && preparationOperationId !== undefined)
  )
    throw unavailable();
  const captured = captureAgentLibraryAuthorization(input.operatorConnectionId);
  captured.assertCurrent();
  const sessionId = input.meta.sessionId;
  const account = structuredClone(input.meta.accountBinding);
  const nativeStore = getCodexConversationStore();
  const assertRoleCurrent = () => resolveTelosWorkRoleContext(eventStore, sessionId, account);
  let prepared: Awaited<ReturnType<typeof prepareOwnedCodexChat>> | undefined;
  let closed = false;
  let composed: ReturnType<typeof createOrdinaryOpenShellCodexEntryOwner> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    const live = registry.findBySessionId(sessionId)?.session;
    if (live && composed && live.ordinaryRuntimeOwner?.identity === composed.driver)
      delete live.ordinaryRuntimeOwner;
    composed?.driver.close();
    prepared?.close();
  };
  const derive = (raw: unknown) => {
    const request = OrdinaryLocalCodexCommandRequestSchema.parse(raw);
    if (!input.meta.agentProfile) throw unavailable();
    const command = {
      ...request,
      payload: {
        ...request.payload,
        systemPrompt: resolveTelosWorkSystemPrompt(
          eventStore,
          sessionId,
          account,
          buildAgentProfilePrompt(input.meta.agentProfile.definition),
        ),
      },
    };
    const meta = {
      ...structuredClone(input.meta),
      agentContext: eventStore.getSession(sessionId)?.agentContext ?? input.meta.agentContext,
      selectedModel: request.selection.model,
      reasoningEffort: request.selection.thinking,
      mode: request.selection.permission.mode,
    };
    return { command, meta };
  };
  const liveOwner = registry.findBySessionId(sessionId)?.session.ordinaryRuntimeOwner;
  const initial = derive(input.command);
  if (liveOwner) {
    if (
      liveOwner.location !== 'openshell' ||
      liveOwner.authSessionId !== captured.auth.id ||
      liveOwner.initialCommandId !== initial.command.clientMsgId ||
      liveOwner.initialPreparationOperationId !== preparationOperationId ||
      (liveOwner.initialResume ?? false) !== resume
    )
      throw unavailable();
    return { ...(await liveOwner.retryInitial(input.command)), sessionId };
  }
  try {
    composed = createOrdinaryOpenShellCodexEntryOwner({
      events: eventStore,
      nativeStore,
      account,
      sessionId,
      workspaceId: input.meta.repositoryWorkspaceId,
      taskRoot: input.taskRoot,
      operatorConnectionId: input.operatorConnectionId,
      signal: input.signal,
      resume,
      selectedModel: initial.command.selection.model,
      readRetained: () => {
        try {
          return nativeStore.readArtifactRuntime(sessionId, account) ?? undefined;
        } catch {
          return undefined;
        }
      },
      dispatch: async (dispatch) => {
        assertRoleCurrent();
        if (prepared || closed) throw unavailable();
        prepared = await prepareOwnedCodexChat(transport, clientId, dispatch, {
          ownerConnectionId: input.ownerConnectionId,
          ownerAuthSessionId: captured.auth.id,
          onEnded: close,
        });
        assertRoleCurrent();
      },
      dispatchContinuation: async (dispatch) => {
        assertRoleCurrent();
        const live = registry.findBySessionId(sessionId)?.session;
        const native = live && getCodexRuntime(live);
        if (closed || !live || !native || live.ownedLocalAuthSessionId !== captured.auth.id)
          throw unavailable();
        await native.admitExplicitSend(
          {
            id: dispatch.commandId,
            prompt: assembleSourceSnapshots(
              dispatch.payload.text,
              dispatch.payload.sourceSnapshots,
            ),
            intent: dispatch.payload.intent ?? dispatch.payload.text,
            images: dispatch.payload.images,
            model: dispatch.expected.selection.model,
            reasoningEffort: dispatch.expected.selection.thinking,
          },
          dispatch.preparationSignal
            ? AbortSignal.any([live.abortController.signal, dispatch.preparationSignal])
            : live.abortController.signal,
        );
        dispatch.preparationSignal?.throwIfAborted();
        echoOwnedCodexCommand(sessionId, dispatch.commandId, dispatch.payload);
      },
      close,
    });
    const result =
      preparationOperationId !== undefined
        ? await composed.driver.admitPreparedFirst(
            preparationOperationId,
            initial.meta,
            initial.command,
          )
        : await composed.driver.admit(initial.meta, initial.command);
    if (!result.dispatched) {
      close();
      return result;
    }
    assertRoleCurrent();
    const session = registry.findBySessionId(sessionId)?.session;
    if (!session || !prepared || closed) throw unavailable();
    const driver = composed.driver;
    session.ordinaryRuntimeOwner = {
      location: 'openshell',
      authSessionId: captured.auth.id,
      identity: driver,
      initialCommandId: initial.command.clientMsgId,
      initialPreparationOperationId: preparationOperationId,
      initialResume: resume,
      admit: (raw, signal) => {
        const next = derive(raw);
        return driver.admit(next.meta, next.command, signal);
      },
      retryInitial: (raw) => {
        const next = derive(raw);
        return preparationOperationId !== undefined
          ? driver.admitPreparedFirst(preparationOperationId, next.meta, next.command)
          : driver.admit(next.meta, next.command);
      },
      close,
    };
    void prepared.run().catch(() => {
      try {
        prepared?.close();
      } finally {
        close();
      }
    });
    return result;
  } catch {
    try {
      prepared?.close();
    } finally {
      close();
    }
    throw unavailable();
  }
}
