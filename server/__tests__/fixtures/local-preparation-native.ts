import {
  withLocalRepositoryPreparationEnvelope,
  type LocalRepositoryPreparationEnvelope,
} from '../../local-repository-preparation-operation.js';
import { expect, vi } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import { ownedRuntimeFixture } from './owned-local-codex-runtime.js';
import { login, authenticateToken } from '../../auth.js';
import { bindAgentLibraryTransport } from '../../agent-library-transport.js';
import { retainAgentContextAuthority } from '../../agent-context-authority.js';
import {
  captureNativeHostToolContext,
  type NativeHostToolContext,
} from '../../native-host-tool-context.js';
import { bindAgentToolSelection } from '../../agent-tool-selection.js';
import { CodexConversationStore } from '../../codex-conversation-store.js';
import { CodexConversation, type CodexConversationOptions } from '../../codex-conversation.js';
import type { CodexLifecycleTransport } from '../../codex-app-server-client.js';
import {
  OrdinaryLocalCodexOwnedRuntime,
  type OrdinaryLocalCodexOwnedDispatch,
} from '../../ordinary-local-codex-owned-runtime.js';
import { recordAgentMessageAcceptance } from '../../agent-communication-tools.js';
import { composeOwnedLocalNativeExecutionPolicy } from '../../owned-local-codex-native-policy.js';
import { createCodexNativeApprovalHandler } from '../../codex-native-approvals.js';
import type { PreparationAttemptDiagnostics } from './preparation-attempt-diagnostics.js';

// Actual signed login, custody, admission, native callback and context factory.
// External process/RPC/model effects are synthetic; no production tool is registered.
export async function localPreparationNativeFixture(
  cleanups: Array<() => void | Promise<void>>,
  execute: (
    context: NativeHostToolContext,
    input: Record<string, unknown>,
    envelope?: Readonly<LocalRepositoryPreparationEnvelope>,
  ) => Promise<unknown>,
  options: {
    nativeBaseReads?: boolean;
    preparationEnvelope?: boolean;
    diagnostics?: PreparationAttemptDiagnostics;
    /** Private test-only raw ORIGINAL callback; never a product registration option. */
    executeOriginalCapture?: (
      capture: (signal: AbortSignal) => NativeHostToolContext,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<{ content: string; isError: boolean }>;
  } = {},
) {
  const f = await ownedRuntimeFixture(cleanups, {
    // Legacy default selection permits this private fixture-only dynamic tool.
  });
  f.detach();
  const token = await login(process.env.AUTH_PASSPHRASE!);
  const auth = (await authenticateToken(token!))!;
  const operatorConnectionId = f.dependencies.operatorConnectionId;
  cleanups.push(bindAgentLibraryTransport(operatorConnectionId, auth));
  const native = new CodexConversationStore(join(f.root, 'peer-native.db'));
  cleanups.push(() => native.close());
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
    const sessionId = selected.reservation.conversationId;
    const clientId = `${operatorConnectionId}:${sessionId}`;
    registry.register(clientId, {
      sessionId,
      ownerConnectionId: operatorConnectionId,
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
    bindAgentToolSelection(session, f.agentProfile.definition, 'codex-owned-local');
    let conversation!: CodexConversation;
    let callbacks!: CodexLifecycleTransport;
    let conversationOptions!: CodexConversationOptions;
    let turn = 0;
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const originalRequest = selected.rpc.request.getMockImplementation()!;
    selected.rpc.request.mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        requests.push({ method, params: params ?? {} });
        if (method === 'thread/start' || method === 'thread/resume')
          return {
            thread: { id: `thread-${sessionId}` },
            model: 'fixture-model',
            modelProvider: 'openai',
          };
        if (method === 'turn/start') return { turn: { id: `turn-${++turn}` } };
        return originalRequest(method);
      },
    );
    let initial!: OrdinaryLocalCodexOwnedDispatch;
    const driver = new OrdinaryLocalCodexOwnedRuntime({
      ...selected.dependencies,
      nativeStore: native,
      operatorConnectionId,
      dispatch: async (dispatch) => {
        initial = dispatch;
        session.cwd = dispatch.workspace.directory;
        session.accountBinding = structuredClone(dispatch.lease.binding);
        const contextAuthority = retainAgentContextAuthority(auth, session.abortController);
        cleanups.push(() => contextAuthority.release());
        const runtimeId = randomUUID();
        dispatch.admission.assertOptions({
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
        const selectedNativePolicy = () =>
          composeOwnedLocalNativeExecutionPolicy({
            session,
            binding: dispatch.lease.binding,
            assertCurrentSync: () => dispatch.admission.assertCurrentSync(),
          });
        const nativeExecution = options.nativeBaseReads ? selectedNativePolicy() : undefined;
        conversationOptions = {
          conversationId: sessionId,
          cwd: dispatch.workspace.directory!,
          profile: dispatch.profile,
          storedBinding: dispatch.lease.binding,
          enableCapacityRecovery: false,
          ...(nativeExecution
            ? {
                nativeExecution,
                resolveNativeExecutionPolicy: async () => selectedNativePolicy(),
                assertNativeExecutionCurrent: (policy: NonNullable<typeof nativeExecution>) => {
                  dispatch.admission.assertCurrentSync();
                  if (selectedNativePolicy().policyRevision !== policy.policyRevision)
                    throw Error('Original native preparation policy changed');
                },
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
          store: native,
          systemPrompt: dispatch.payload.systemPrompt,
          getMode: () => session.mode,
          tools: [
            {
              name: 'PrepareLocalRepository',
              description: 'Private offline fixture only',
              input_schema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
                additionalProperties: false,
              },
            },
          ],
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
            const capture = (ownedSignal: AbortSignal) => {
              const meta = f.events.getSession(sessionId)!;
              return captureNativeHostToolContext({
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
                signal: ownedSignal,
              });
            };
            if (options.executeOriginalCapture) {
              const invoke = () => options.executeOriginalCapture!(capture, input, signal);
              // The real adapter owns its genuine context and joined disposal.
              // Observe this outer callback without replacing immutable owners
              // or inferring an independently observed context cleanup outcome.
              return options.diagnostics
                ? options.diagnostics.capture('raw-callback', invoke)
                : invoke();
            }
            const run = async (
              ownedSignal: AbortSignal,
              envelope?: Readonly<LocalRepositoryPreparationEnvelope>,
            ) => {
              const scope = capture(ownedSignal);
              try {
                const value = options.diagnostics
                  ? await options.diagnostics.capture('callback', () =>
                      execute(scope, input, envelope),
                    )
                  : await execute(scope, input, envelope);
                const serialize = () => ({ content: JSON.stringify(value), isError: false });
                return options.diagnostics
                  ? options.diagnostics.captureSync('callback-serialization', serialize)
                  : serialize();
              } finally {
                if (options.diagnostics)
                  options.diagnostics.captureSync('context-dispose', () => scope.dispose());
                else scope.dispose();
              }
            };
            return options.preparationEnvelope
              ? withLocalRepositoryPreparationEnvelope(signal, (envelope) =>
                  run(envelope.signal, envelope),
                )
              : run(signal);
          },
        };
        conversation = new CodexConversation(conversationOptions);
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
    else await driver.admit(selected.request);
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
      sessionId,
      session,
      clientId,
      driver,
      conversation,
      requests,
      rpc: selected.rpc,
      initial,
      // Test-only installation on the ORIGINAL runtime options; the actual
      // conversation generates/expires its original preclaim lifetime fence.
      installPreparedBoundary(admit: (assertCurrentSync: () => void) => Promise<void>) {
        conversationOptions.beforeRuntimeAdmission = Object.freeze({
          kind: 'prepared-repository-primary',
          admit,
        });
      },
      async call(input: Record<string, unknown>, override?: Record<string, unknown>) {
        const response = await callbacks.onRequest(
          'item/tool/call',
          {
            threadId: `thread-${sessionId}`,
            turnId: `turn-${turn}`,
            callId: randomUUID(),
            namespace: null,
            tool: 'PrepareLocalRepository',
            arguments: input,
            ...override,
          },
          new AbortController().signal,
        );
        const item = (response.contentItems as Array<{ text: string }>)[0];
        return { response, value: response.success ? JSON.parse(item.text) : item.text };
      },
      async complete() {
        const running = native
          .commands(sessionId, initial.lease.binding)
          .find((c) => c.status === 'running')!;
        callbacks.onNotification('turn/completed', {
          threadId: `thread-${sessionId}`,
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
