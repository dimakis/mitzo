import { loadAccountProfiles } from './account-profiles.js';
import { VertexAdcCustody } from './ordinary-local-vertex-custody.js';
import { registerWorkspaceRuntimeAuthorityPaths } from './workspace-runtime-private-paths.js';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SessionTransport } from '@mitzo/harness';
import { hasPersistentRevocationAuthority } from './auth.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
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
const unavailable = () => Error('Owned Local Claude runtime unavailable');
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
      !process.env.MITZO_ACCOUNT_PROFILES_FILE ||
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
    VertexAdcCustody.reopen(custody.credentialAuthority, env);
    return (
      !!meta &&
      !!custody &&
      custody.authSessionId === authSessionId &&
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
}) {
  const captured = captureAgentLibraryAuthorization(input.operatorConnectionId);
  captured.assertCurrent();
  const owner = registry.findBySessionId(input.sessionId)?.session.ordinaryRuntimeOwner;
  if (
    !owner ||
    owner.authSessionId !== captured.auth.id ||
    eventStore.getSessionRuntimeBinding(input.sessionId)?.harness.implementation !== 'claude-sdk'
  )
    throw unavailable();
  return { ...(await owner.admit(input.command, input.signal)), sessionId: input.sessionId };
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
      live.authSessionId !== captured.auth.id ||
      live.authSessionId !== options.ownerAuthSessionId ||
      live.initialCommandId !== command.clientMsgId ||
      options.resume ||
      eventStore.getSessionRuntimeBinding(sessionId)?.harness.implementation !== 'claude-sdk'
    )
      throw unavailable();
    return { ...(await live.retryInitial(options.command)), sessionId };
  }
  if (!process.env.MITZO_ACCOUNT_PROFILES_FILE) throw unavailable();
  registerWorkspaceRuntimeAuthorityPaths(
    [join(BASE_REPO, '.mitzo'), process.env.MITZO_ACCOUNT_PROFILES_FILE],
    [join(BASE_REPO, '.mitzo'), process.env.MITZO_ACCOUNT_PROFILES_FILE],
  );
  const controller = new AbortController();
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
      custody.authSessionId !== options.ownerAuthSessionId ||
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
        ...(selected.resume ? { resume: sessionId } : { initialSessionId: sessionId }),
        repositoryWorkspaceId: selected.workspace.id,
        cwd: selected.workspace.directory,
        accountId: selected.binding.accountId,
        model: firstSelection.model,
        reasoningEffort: firstSelection.thinking,
        mode: selected.expected.selection.permission.mode,
        agentProfile: selected.expected.selection.agent,
        images: selected.payload.images,
        sourceSnapshots: selected.payload.sourceSnapshots,
        clientMsgId: selected.commandId,
        operatorConnectionId: options.ownerConnectionId,
        ordinarySdkAuthority: authority,
        ordinarySdkCommandOwner: (nativeQuery, push, reopen) => {
          queue = new OrdinaryLocalVertexCommandOwner({
            store: eventStore,
            sessionId,
            assertCurrent: () => authority.assertCurrent(owner.signal),
            ownsClaim: (id) => owner.hasPendingCommand(id),
            onTerminal: (id) => owner.commandTerminal(id),
            settings: (selection) => ({ model: selection.model, thinkingTokens: null }),
            query: {
              applySettings: reopen,
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
          session.ordinaryRuntimeOwner = {
            location: 'local',
            authSessionId: owner.authSessionId,
            identity: owner,
            initialCommandId: command.clientMsgId,
            admit: (input, signal) => owner.admitContinuation(input, signal),
            retryInitial: (input) => owner.admit(input),
            close: () => {
              session.abortController.abort();
              owner.close();
            },
          };
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
