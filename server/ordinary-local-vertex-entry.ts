import { loadAccountProfiles } from './account-profiles.js';
import { reopenClaudeSdkCredentials } from './claude-sdk-credentials.js';
import { registerWorkspaceRuntimeAuthorityPaths } from './workspace-runtime-private-paths.js';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SessionTransport, ManagedSession } from '@mitzo/harness';
import { hasPersistentRevocationAuthority } from './auth.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { retainNativeHostToolOperator } from './native-host-tool-operator.js';
import { getAgentLibrary } from './agent-library-runtime.js';
import { getRepositoryWorkspaces } from './repository-workspace-runtime.js';
import type { HostRepositoryReservationInput } from './repository-workspaces.js';
import { eventStore, registry, startChat, BASE_REPO } from './chat.js';
import {
  OrdinaryLocalVertexOwnedRuntime,
  type OrdinaryLocalVertexOwnedDispatch,
} from './ordinary-local-vertex-owned-runtime.js';
import { OrdinaryLocalVertexSdkAuthority } from './ordinary-local-vertex-sdk-authority.js';
import { OrdinaryLocalVertexCommandOwner } from './ordinary-local-vertex-command-owner.js';
import { OrdinarySdkTurnEvidence } from './ordinary-sdk-turn-evidence.js';
import type { OrdinaryTurnLifecycle } from './ordinary-turn-lifecycle.js';
import { OrdinaryLocalVertexCommandRequestSchema } from './ordinary-local-codex-admission.js';
import { assertOwnedVertexQueueControl } from './ordinary-local-vertex-queue.js';
import { ordinaryOperatorOwnsConversation } from './ordinary-operator-identity.js';
import type { AuthSession } from './auth.js';
const unavailable = () => Error('Owned Local Claude runtime unavailable');
export async function continueOwnedLocalVertexQueue(
  sessionId: string,
  authorization: AuthSession | undefined,
  connectionId?: string,
) {
  assertOwnedVertexQueueControl(eventStore, sessionId, authorization);
  if (!connectionId) throw unavailable();
  const captured = captureAgentLibraryAuthorization(connectionId);
  captured.assertCurrent();
  const owner = registry.findBySessionId(sessionId)?.session.ordinaryRuntimeOwner;
  if (
    !owner?.sdkTurns ||
    !ordinaryOperatorOwnsConversation(owner.authSessionId, authorization?.id) ||
    captured.auth.id !== authorization.id
  )
    throw unavailable();
  await owner.sdkTurns.resumeQueue();
}
export function canResumeOwnedLocalVertexDriver(sessionId: string, authSessionId: string): boolean {
  try {
    if (
      process.env.MITZO_ORDINARY_LOCAL_VERTEX_ENABLED !== '1' ||
      !hasPersistentRevocationAuthority()
    )
      return false;
    const meta = eventStore.getSession(sessionId),
      custody = eventStore.getOrdinaryLocalVertexCustody(sessionId);
    if (
      !meta?.accountBinding ||
      !custody ||
      !isDeepStrictEqual(custody.binding, eventStore.getSessionRuntimeBinding(sessionId)) ||
      !isDeepStrictEqual(
        {
          accountId: meta.accountBinding.accountId,
          provider: meta.accountBinding.provider,
          profileRevision: meta.accountBinding.profileRevision,
        },
        custody.binding.account,
      )
    )
      return false;
    const profiles = loadAccountProfiles();
    profiles.resumeRouting(meta.accountBinding);
    const env = profiles.sdkEnv(
      meta.accountBinding,
      Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    );
    reopenClaudeSdkCredentials(custody.credentialAuthority, env);
    return (
      !!meta &&
      !!custody &&
      ordinaryOperatorOwnsConversation(custody.authSessionId, authSessionId) &&
      !eventStore.hasUncertainOrdinaryCommand(sessionId) &&
      (!meta.executionPhase || meta.executionPhase === 'TERMINAL')
    );
  } catch {
    return false;
  }
}
export async function sendOwnedLocalVertexCommand(input: {
  sessionId: string;
  command: unknown;
  operatorConnectionId: string;
  signal?: AbortSignal;
  ordinaryTurnLifecycle?: OrdinaryTurnLifecycle;
  assertCurrent?(): void;
}) {
  const captured = captureAgentLibraryAuthorization(input.operatorConnectionId);
  captured.assertCurrent();
  const owner = registry.findBySessionId(input.sessionId)?.session.ordinaryRuntimeOwner;
  if (
    !owner ||
    !ordinaryOperatorOwnsConversation(owner.authSessionId, captured.auth.id) ||
    eventStore.getSessionRuntimeBinding(input.sessionId)?.harness.implementation !== 'claude-sdk'
  )
    throw unavailable();
  input.assertCurrent?.();
  return {
    ...(await owner.admit(
      input.command,
      input.signal,
      input.assertCurrent,
      input.ordinaryTurnLifecycle,
    )),
    sessionId: input.sessionId,
  };
}
export async function startOwnedLocalVertexCommand(
  transport: SessionTransport,
  clientId: string,
  options: {
    command: unknown;
    reservation: Omit<HostRepositoryReservationInput, 'signal'>;
    operatorConnectionId: string;
    ownerConnectionId?: string;
    ownerAuthSessionId: string;
    resume?: boolean;
    signal?: AbortSignal;
    ordinaryTurnLifecycle?: OrdinaryTurnLifecycle;
    preparationOperationId?: string;
    onSessionPrepared?(session: ManagedSession): void;
  },
) {
  options.signal?.throwIfAborted();
  const command = options.command as { clientMsgId: string },
    sessionId = options.reservation.conversationId;
  const live = registry.findBySessionId(sessionId)?.session.ordinaryRuntimeOwner;
  if (live) {
    const captured = captureAgentLibraryAuthorization(options.operatorConnectionId);
    captured.assertCurrent();
    if (
      !ordinaryOperatorOwnsConversation(live.authSessionId, captured.auth.id) ||
      captured.auth.id !== options.ownerAuthSessionId ||
      live.initialCommandId !== command.clientMsgId ||
      options.resume ||
      eventStore.getSessionRuntimeBinding(sessionId)?.harness.implementation !== 'claude-sdk'
    )
      throw unavailable();
    return { ...(await live.retryInitial(options.command)), sessionId };
  }
  const profileFiles = process.env.MITZO_ACCOUNT_PROFILES_FILE
    ? [process.env.MITZO_ACCOUNT_PROFILES_FILE]
    : [];
  registerWorkspaceRuntimeAuthorityPaths(
    [join(BASE_REPO, '.mitzo'), ...profileFiles],
    [join(BASE_REPO, '.mitzo'), ...profileFiles],
  );
  const controller = new AbortController();
  const turnLifecycles = new Map<string, OrdinaryTurnLifecycle>();
  if (options.ordinaryTurnLifecycle)
    turnLifecycles.set(command.clientMsgId, options.ordinaryTurnLifecycle);
  let queue: OrdinaryLocalVertexCommandOwner | undefined;
  let started = false;
  const dispatch = async (selected: OrdinaryLocalVertexOwnedDispatch) => {
    await selected.owner.assertSetup(selected.commandId);
    if (started) {
      if (!queue) throw unavailable();
      await queue.enqueue(selected.commandId, selected.preparationSignal);
      return;
    }
    if (selected.resume) await owner.restoreAcknowledgedQueue();
    const custody = eventStore.getOrdinaryLocalVertexCustody(sessionId);
    if (
      !custody ||
      !ordinaryOperatorOwnsConversation(custody.authSessionId, options.ownerAuthSessionId) ||
      !isDeepStrictEqual(custody.binding, selected.expected.binding)
    )
      throw unavailable();
    const authority = new OrdinaryLocalVertexSdkAuthority({
      store: eventStore,
      signal: owner.signal,
      custody,
      commandId: selected.commandId,
      environment: () => owner.environment(),
      assertCurrent: async (signal) => {
        signal.throwIfAborted();
        const active = queue?.activeCommandId();
        if (active || !queue) await owner.assertEffect(active ?? selected.commandId);
        else await owner.assertIdle(owner.activeCommandId() ?? selected.commandId);
      },
      assertCurrentSync: (signal) => {
        signal.throwIfAborted();
        const active = queue?.activeCommandId();
        if (active || !queue) owner.assertStart(active ?? selected.commandId);
        else owner.assertIdleSync(owner.activeCommandId() ?? selected.commandId);
      },
      sourceWriteRoots: process.env.MITZO_ACCOUNT_PROFILES_FILE
        ? [dirname(process.env.MITZO_ACCOUNT_PROFILES_FILE)]
        : [],
    });
    const oldest = eventStore.getPendingOrdinaryLocalVertexCommandIds(sessionId)[0];
    const firstSelection = oldest
      ? eventStore.getOrdinaryLocalVertexCommandAdmission(oldest)!.selection
      : selected.expected.selection;
    started = true;
    const admission = new Promise<void>((resolve, reject) => {
      const task = startChat(transport, clientId, selected.payload.text, {
        ...(selected.resume && !selected.startWithoutHistory
          ? { resume: sessionId }
          : { initialSessionId: sessionId }),
        repositoryWorkspaceId: selected.workspace.id,
        cwd: selected.workspace.directory,
        accountId: selected.binding.accountId,
        model: firstSelection.model,
        reasoningEffort: firstSelection.thinking,
        mode: selected.expected.selection.permission.mode,
        agentProfile: selected.expected.selection.agent,
        images: selected.payload.images,
        sourceSnapshots: selected.payload.sourceSnapshots,
        replyToMessageId: selected.payload.replyToMessageId,
        clientMsgId: selected.commandId,
        operatorConnectionId: options.ownerConnectionId,
        ordinarySdkAuthority: authority,
        ordinarySdkCommandOwner: (nativeQuery, push, reopen, control) => {
          queue = new OrdinaryLocalVertexCommandOwner({
            store: eventStore,
            sessionId,
            assertCurrent: () => authority.assertCurrent(owner.signal),
            assertCurrentSync: () => authority.assertCurrentSync(owner.signal),
            turnEvidence: new OrdinarySdkTurnEvidence(
              eventStore,
              sessionId,
              authority.sdkSessionId(),
            ),
            turnLifecycle: (id) => turnLifecycles.get(id),
            ownsClaim: (id) => owner.hasPendingCommand(id),
            onTerminal: (id) => {
              owner.commandTerminal(id);
              turnLifecycles.delete(id);
            },
            settings: (selection) => ({ model: selection.model, thinkingTokens: null }),
            query: {
              applySettings: reopen,
              captureInterruptTarget: () => control.captureInterruptTarget(),
              interruptIfCurrent: (target) => control.interruptIfCurrent(target),
              setModel: (model) => nativeQuery.setModel(model),
              setMaxThinkingTokens: (tokens) => nativeQuery.setMaxThinkingTokens(tokens),
              push,
              abort: () => {
                registry.findBySessionId(sessionId)?.session.abortController.abort();
                owner.close();
              },
            },
          });
          const session = registry.findBySessionId(sessionId)?.session;
          if (!session) throw unavailable();
          session.ownedLocalAuthSessionId = owner.authSessionId;
          retainNativeHostToolOperator(session, options.operatorConnectionId);
          session.ordinaryRuntimeOwner = {
            location: 'local',
            authSessionId: owner.authSessionId,
            identity: owner,
            initialCommandId: command.clientMsgId,
            admit: (input, signal, current, lifecycle) => {
              const parsed = OrdinaryLocalVertexCommandRequestSchema.parse(input);
              if (lifecycle) {
                const old = turnLifecycles.get(parsed.clientMsgId);
                if (old && old !== lifecycle)
                  throw Error('Original SDK turn observer already retained');
                turnLifecycles.set(parsed.clientMsgId, lifecycle);
              }
              return owner.admitContinuation(input, signal, current).catch((error) => {
                if (!eventStore.getSendCommand(parsed.clientMsgId))
                  turnLifecycles.delete(parsed.clientMsgId);
                throw error;
              });
            },
            sdkTurns: {
              stop: (requestId) => queue!.stop(requestId),
              resumeQueue: () => queue!.resumeQueue(),
              captureInterruptTarget: () => queue!.captureInterruptTarget(),
              interruptIfCurrent: (requestId, target) =>
                queue!.interruptIfCurrent(requestId, target),
            },
            retryInitial: (input) => owner.admit(input),
            close: () => {
              session.abortController.abort();
              owner.close();
              turnLifecycles.clear();
            },
          };
          options.onSessionPrepared?.(session);
          return queue;
        },
        onStartupAdmission: (error) => (error ? reject(error) : resolve()),
      });
      void task.catch((error) => reject(error)).finally(() => owner.close());
    });
    await admission;
  };
  const owner = new OrdinaryLocalVertexOwnedRuntime({
    enabled: process.env.MITZO_ORDINARY_LOCAL_VERTEX_ENABLED === '1',
    eventStore,
    library: getAgentLibrary(),
    workspace: getRepositoryWorkspaces(true),
    reservation: options.reservation,
    commandId: command.clientMsgId,
    ...(!options.resume && options.preparationOperationId
      ? { preparationOperationId: options.preparationOperationId }
      : {}),
    operatorConnectionId: options.operatorConnectionId,
    signal: controller.signal,
    dispatch,
    dispatchContinuation: dispatch,
  });
  owner.signal.addEventListener(
    'abort',
    () => registry.findBySessionId(sessionId)?.session.abortController.abort(),
    { once: true },
  );
  // Entry cancellation governs preparation only; the admitted owner retains its
  // existing lifetime after a successful HTTP acknowledgement.
  const abortPreparation = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortPreparation, { once: true });
  if (options.signal?.aborted) abortPreparation();
  let release: (() => void) | undefined;
  try {
    release = eventStore.reserveOrdinaryStartup([sessionId]);
    const result = await (options.resume
      ? owner.admitResume(options.command)
      : owner.admit(options.command));
    if (!result.dispatched && !started) owner.close();
    return { ...result, sessionId };
  } catch {
    owner.close();
    throw unavailable();
  } finally {
    options.signal?.removeEventListener('abort', abortPreparation);
    release?.();
  }
}
