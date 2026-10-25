import { expect, vi } from 'vitest';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { codexDynamicToolsOption } from '../../codex-ordinary-packet.js';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import { ownedRuntimeFixture } from './owned-local-codex-runtime.js';
import { login, authenticateToken } from '../../auth.js';
import { bindAgentLibraryTransport } from '../../agent-library-transport.js';
import { retainAgentContextAuthority } from '../../agent-context-authority.js';
import {
  captureNativeHostToolContext,
  retainNativeHostToolOperator,
  type NativeHostToolContext,
} from '../../native-host-tool-context.js';
import { bindAgentToolSelection } from '../../agent-tool-selection.js';
import { CodexConversationStore } from '../../codex-conversation-store.js';
import { CodexConversation } from '../../codex-conversation.js';
import type { CodexLifecycleTransport } from '../../codex-app-server-client.js';
import {
  OrdinaryLocalCodexOwnedRuntime,
  type OrdinaryLocalCodexOwnedDispatch,
} from '../../ordinary-local-codex-owned-runtime.js';
import { recordAgentMessageAcceptance } from '../../agent-communication-tools.js';
import { localRepositoryToolDefinitions } from '../../session-local-repository-tools.js';
import { createCodexNativeApprovalHandler } from '../../codex-native-approvals.js';
import { composeOwnedLocalNativeExecutionPolicy } from '../../owned-local-codex-native-policy.js';

// Actual signed login, custody, admission, native callback and base-scope producer.
// Based on the committed preparation fixture; only external RPC/process effects
// are synthetic. No provider/model or production configuration is used.
export async function localRepositoryNativeToolFixture(
  cleanups: Array<() => void | Promise<void>>,
  execute: (
    context: NativeHostToolContext,
    input: Record<string, unknown>,
  ) => Promise<{ content: string; isError: boolean }>,
  options: {
    api?: boolean;
    separateViewer?: boolean;
    nativeBaseReads?: boolean;
    readableRoots?: readonly string[];
    registeredExecutablePath?: string;
    resumeFromPreviousLogin?: boolean;
  } = {},
) {
  const f = await ownedRuntimeFixture(cleanups, {
    api: options.api,
    localRepository: options.api,
    // Legacy default selection permits these actual read tools.
    ...(options.registeredExecutablePath
      ? { chatRoute: true, nativeExecutablePath: options.registeredExecutablePath }
      : {}),
  });
  const native = options.registeredExecutablePath
    ? (await import('../../codex-chat-session.js')).getCodexConversationStore()
    : new CodexConversationStore(join(f.root, 'peer-native.db'));
  cleanups.push(() => native.close());
  if (options.resumeFromPreviousLogin) {
    const previous = f.create();
    await previous.admit(f.request);
    const dispatch = f.dispatch.mock.calls[0][0];
    const surfaceRevision = createHash('sha256')
      .update(JSON.stringify(codexDynamicToolsOption(localRepositoryToolDefinitions)))
      .digest('hex');
    native.create(
      dispatch.sessionId,
      dispatch.lease.binding,
      dispatch.workspace.directory!,
      surfaceRevision,
    );
    dispatch.admission.persistCustody(native);
    native.bindThread(dispatch.sessionId, dispatch.lease.binding, `thread-${dispatch.sessionId}`);
    previous.close();
  }
  f.detach();
  const token = await login(process.env.AUTH_PASSPHRASE!);
  const auth = (await authenticateToken(token!))!;
  const operatorConnectionId = f.dependencies.operatorConnectionId;
  cleanups.push(bindAgentLibraryTransport(operatorConnectionId, auth));
  const viewerConnectionId = options.separateViewer ? randomUUID() : operatorConnectionId;
  const detachViewer = options.separateViewer
    ? bindAgentLibraryTransport(viewerConnectionId, auth)
    : () => {};
  cleanups.push(detachViewer);
  const registry = new SessionRegistry();
  cleanups.push(() => registry.dispose());
  const handles = new Map<string, Awaited<ReturnType<typeof start>>>();
  const permissions: Array<Record<string, unknown>> = [];
  const permissionEvents: Array<Record<string, unknown>> = [];
  let permissionAction: (event: Record<string, unknown>) => void = (event) => {
    resolvePending(event.permId as string, 'once', undefined, event.sessionId as string);
  };

  async function start(
    selected: typeof f | Awaited<ReturnType<typeof f.prepareSibling>>,
    prepared = false,
  ) {
    const request = options.resumeFromPreviousLogin
      ? { ...selected.request, clientMsgId: randomUUID() }
      : selected.request;
    const sessionId = selected.reservation.conversationId;
    const clientId = `${operatorConnectionId}:${sessionId}`;
    registry.register(clientId, {
      sessionId,
      ownerConnectionId: viewerConnectionId,
      ownedLocalAuthSessionId: auth.id,
      transport: {
        isOpen: () => true,
        send: (event) => {
          permissionEvents.push(event);
          if (event.type === 'permission_request') {
            permissions.push(event);
            queueMicrotask(() => permissionAction(event));
          }
        },
      },
      abortController: new AbortController(),
      sessionAllowList: new Set(),
      mode: 'agent',
      cwd: selected.reserved.directory,
    });
    const session = registry.get(clientId)!;
    const releaseNativeOperator = options.separateViewer
      ? retainNativeHostToolOperator(session, operatorConnectionId)
      : () => {};
    cleanups.push(releaseNativeOperator);
    bindAgentToolSelection(session, f.agentProfile.definition, 'codex-owned-local');
    let conversation!: CodexConversation;
    let callbacks!: CodexLifecycleTransport;
    let turn = 0;
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const originalRequest = selected.rpc.request.getMockImplementation()!;
    selected.rpc.request.mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        requests.push({ method, params: params ?? {} });
        if (method === 'thread/start' || method === 'thread/resume')
          return {
            thread: {
              id:
                options.resumeFromPreviousLogin && method === 'thread/start'
                  ? `thread-${sessionId}-replacement`
                  : `thread-${sessionId}`,
            },
            model: 'fixture-model',
            modelProvider: 'openai',
          };
        if (method === 'turn/start') return { turn: { id: `turn-${++turn}` } };
        return originalRequest(method);
      },
    );
    const metrics = { syncCalls: 0, syncMs: 0, asyncCalls: 0, asyncMs: 0 };
    let initial!: OrdinaryLocalCodexOwnedDispatch;
    const driver = new OrdinaryLocalCodexOwnedRuntime({
      ...selected.dependencies,
      commandId: request.clientMsgId,
      ...(options.resumeFromPreviousLogin
        ? { launch: () => selected.rpc, launchApi: async () => selected.rpc }
        : {}),
      nativeStore: native,
      operatorConnectionId,
      dispatch: async (dispatch) => {
        initial = dispatch;
        const originalSync = dispatch.admission.assertCurrentSync;
        vi.spyOn(dispatch.admission, 'assertCurrentSync').mockImplementation(() => {
          const start = performance.now();
          metrics.syncCalls++;
          try {
            return originalSync.call(dispatch.admission);
          } finally {
            metrics.syncMs += performance.now() - start;
          }
        });
        const originalAsync = dispatch.admission.assertCurrent;
        vi.spyOn(dispatch.admission, 'assertCurrent').mockImplementation(async () => {
          const start = performance.now();
          metrics.asyncCalls++;
          try {
            return await originalAsync.call(dispatch.admission);
          } finally {
            metrics.asyncMs += performance.now() - start;
          }
        });
        session.cwd = dispatch.workspace.directory;
        session.accountBinding = structuredClone(dispatch.lease.binding);
        const contextAuthority = retainAgentContextAuthority(auth, session.abortController);
        cleanups.push(() => contextAuthority.release());
        const runtimeId = randomUUID();
        if (!options.registeredExecutablePath)
          dispatch.admission.assertOptions({
            resume: dispatch.resume,
            conversationId: sessionId,
            messageId: dispatch.commandId,
            binding: dispatch.lease.binding,
            profile: dispatch.profile,
            session,
            prompt: dispatch.payload.text,
            systemPrompt: dispatch.payload.systemPrompt,
            intent: dispatch.payload.intent,
            model: dispatch.expected.selection.model,
            reasoningEffort: dispatch.expected.selection.thinking,
            agentProfile: dispatch.expected.agentProfile,
            agentContext: dispatch.expected.agentContext,
            repositoryWorkspace: dispatch.workspace,
          });
        const selectedPolicy = () =>
          composeOwnedLocalNativeExecutionPolicy({
            session,
            binding: dispatch.lease.binding,
            readableRoots: options.readableRoots ?? ['/'],
            assertCurrentSync: () => dispatch.admission.assertCurrentSync(),
          });
        const nativeExecution =
          options.nativeBaseReads === false || options.registeredExecutablePath
            ? undefined
            : selectedPolicy();
        if (options.registeredExecutablePath) {
          const { openCodexChat, getCodexRuntime } = await import('../../codex-chat-session.js');
          const attach = dispatch.admission.attach;
          vi.spyOn(dispatch.admission, 'attach').mockImplementation((cb) => {
            callbacks = cb;
            return attach.call(dispatch.admission, cb);
          });
          const query = await openCodexChat({
            resume: dispatch.resume,
            conversationId: sessionId,
            messageId: dispatch.commandId,
            ownedLocal: dispatch.admission,
            eventStore: f.events,
            registry,
            session,
            binding: dispatch.lease.binding,
            profile: dispatch.profile,
            prompt: dispatch.payload.text,
            systemPrompt: dispatch.payload.systemPrompt,
            intent: dispatch.payload.intent,
            model: dispatch.expected.selection.model,
            reasoningEffort: dispatch.expected.selection.thinking,
            agentProfile: dispatch.expected.agentProfile,
            agentContext: dispatch.expected.agentContext,
            repositoryWorkspace: dispatch.workspace,
            env: {},
            mcpServers: {},
            assertAgentContextAuthorization: () => contextAuthority.assertCurrent(),
          });
          cleanups.push(() => query.close());
          conversation = getCodexRuntime(session)!;
          expect(conversation).toBeDefined();
          await conversation.startQueued();
          expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(0);
          return;
        }
        conversation = new CodexConversation({
          conversationId: sessionId,
          cwd: dispatch.workspace.directory!,
          profile: dispatch.profile,
          storedBinding: dispatch.lease.binding,
          enableCapacityRecovery: false,
          store: native,
          systemPrompt: dispatch.payload.systemPrompt,
          getMode: () => session.mode,
          tools: localRepositoryToolDefinitions,
          ...(nativeExecution
            ? {
                nativeExecution,
                resolveNativeExecutionPolicy: async () => selectedPolicy(),
                assertNativeExecutionCurrent: () => dispatch.admission.assertCurrentSync(),
                requestNativeApproval: createCodexNativeApprovalHandler({
                  clientId,
                  registry,
                  runtimeId,
                  environmentId: 'local',
                  deniedRoots: nativeExecution.deniedRoots,
                  writeProtectedRoots: nativeExecution.writeProtectedRoots,
                }),
              }
            : {}),
          createClient: (cb) => {
            callbacks = cb;
            return dispatch.admission.attach(cb);
          },
          emit: (event) => f.events.append(sessionId, event.type as string, event),
          verifyBinding: async () => {
            await dispatch.admission.assertCurrent();
            return dispatch.lease.binding;
          },
          beforeThreadInitialization: (store) => dispatch.admission.persistCustody(store),
          beforeEnqueue: (input) => dispatch.admission.assertBeforeEnqueue(input),
          canClaimCommand: (id) => dispatch.admission.canClaimCommand(id),
          onProviderDispatch: (id) => dispatch.admission.assertBeforeDispatch(id),
          onProviderAccepted: (id, threadId, turnId) =>
            recordAgentMessageAcceptance(
              f.events,
              native,
              sessionId,
              dispatch.lease.binding,
              auth.id,
              id,
              threadId,
              turnId,
            ),
          executeTool: async (name, input, signal, call) => {
            const meta = f.events.getSession(sessionId)!;
            const scope = captureNativeHostToolContext({
              events: f.events,
              native,
              registry,
              session,
              conversationId: sessionId,
              binding: dispatch.lease.binding,
              runtime: conversation,
              runtimeId,
              currentRuntime: () => conversation,
              admission: dispatch.admission,
              assertAgentContextAuthorization: () => {
                contextAuthority.assertCurrent();
              },
              profile: dispatch.expected.agentProfile,
              agentContext: dispatch.expected.agentContext,
              workspace: {
                kind: meta.ordinaryWorkspaceId ? 'ordinary' : 'repository',
                id: dispatch.workspace.id,
                directory: dispatch.workspace.directory!,
              },
              toolName: name,
              input,
              call,
              signal,
            });
            try {
              return await execute(scope, input);
            } finally {
              scope.dispose();
            }
          },
        });
        cleanups.push(() => conversation.close());
        await conversation.initialize();
        await conversation.admitExplicitSend({
          id: dispatch.commandId,
          prompt: dispatch.payload.text,
          intent: dispatch.payload.intent,
          model: dispatch.expected.selection.model,
          reasoningEffort: dispatch.expected.selection.thinking,
        });
        // The first pump can race coordinator completion. It must leave the
        // original queued head untouched and issue no RPC while uncertain.
        await conversation.startQueued();
        expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(0);
      },
      dispatchContinuation: async (dispatch) => {
        await conversation.admitExplicitSend(
          {
            id: dispatch.commandId,
            prompt: dispatch.payload.text,
            intent: dispatch.payload.intent,
            model: dispatch.expected.selection.model,
            reasoningEffort: dispatch.expected.selection.thinking,
          },
          dispatch.preparationSignal,
        );
      },
    });
    cleanups.push(() => driver.close());
    if (prepared)
      await driver.admitPreparedFirst(
        selected.preparation!.receipt.allocationOperationId,
        selected.request,
      );
    else if (options.resumeFromPreviousLogin) await driver.admitResume(request);
    else await driver.admit(request);
    session.ordinaryRuntimeOwner = {
      location: 'local',
      authSessionId: auth.id,
      identity: driver,
      initialCommandId: selected.request.clientMsgId,
      admit: (command, signal) => driver.admitContinuation(command, signal),
      admitAgentMessage: (id, assertCurrent, signal) =>
        driver.admitAgentMessage(id, assertCurrent, signal),
      retryInitial: (command) => driver.admit(command),
      close: () => driver.close(),
    };
    const result = {
      releaseNativeOperator,
      sessionId,
      session,
      clientId,
      driver,
      conversation,
      requests,
      metrics,
      rpc: selected.rpc,
      initial,
      async call(
        input: Record<string, unknown>,
        override?: Record<string, unknown>,
        callSignal?: AbortSignal,
      ) {
        const response = await callbacks.onRequest(
          'item/tool/call',
          {
            threadId: native.read(sessionId, initial.lease.binding).threadId,
            turnId: `turn-${turn}`,
            callId: randomUUID(),
            namespace: null,
            tool: 'DiscoverLocalRepository',
            arguments: input,
            ...override,
          },
          callSignal ?? new AbortController().signal,
        );
        const item = (response.contentItems as Array<{ text: string }>)[0];
        return { response, value: response.success ? JSON.parse(item.text) : item.text };
      },
      async complete() {
        const running = native
          .commands(sessionId, initial.lease.binding)
          .find((c) => c.status === 'running')!;
        callbacks.onNotification('turn/completed', {
          threadId: native.read(sessionId, initial.lease.binding).threadId,
          turn: { id: `turn-${turn}`, status: 'completed' },
        });
        await vi.waitFor(() =>
          expect(native.commandStatus(sessionId, initial.lease.binding, running.id)).toBe(
            'completed',
          ),
        );
      },
    };
    handles.set(sessionId, result);
    await conversation.startQueued();
    return result;
  }
  const a = await start(f);
  return {
    detachViewer,
    f,
    native,
    auth,
    a,
    registry,
    permissions,
    permissionEvents,
    setPermissionAction(fn: typeof permissionAction) {
      permissionAction = fn;
    },
  };
}
