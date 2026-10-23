import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SessionRegistry,
  buildPermissionHandler,
  resolvePending,
  type ManagedSession,
} from '@mitzo/harness';
import { ownedRuntimeFixture } from './fixtures/owned-local-codex-runtime.js';
import { login, authenticateToken, setAuthRevocationStore, revokeAuthSession } from '../auth.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { retainAgentContextAuthority } from '../agent-context-authority.js';
import {
  captureNativeHostToolContext,
  type NativeHostToolContext,
} from '../native-host-tool-context.js';
import { bindAgentToolSelection } from '../agent-tool-selection.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { EventStore } from '../event-store.js';
import { CodexConversation, type CodexConversationOptions } from '../codex-conversation.js';
import { composeOwnedLocalNativeExecutionPolicy } from '../owned-local-codex-native-policy.js';
import { createCodexNativeApprovalHandler } from '../codex-native-approvals.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
import {
  OrdinaryLocalCodexOwnedRuntime,
  type OrdinaryLocalCodexOwnedDispatch,
} from '../ordinary-local-codex-owned-runtime.js';
import {
  agentCommunicationDefinitions,
  sessionAgentCommunicationTools,
  recordAgentMessageAcceptance,
} from '../agent-communication-tools.js';

const cleanups: Array<() => void | Promise<void>> = [];
const revocations = new EventStore(':memory:');
type NativeCall = Parameters<CodexConversationOptions['executeTool']>[3];
type ReadScopeFault =
  | 'tuple'
  | 'call'
  | 'tool'
  | 'hash'
  | 'async-assertion'
  | 'async-capture'
  | 'getter-facet'
  | 'getter-data'
  | 'enumerable-facet';
setAuthRevocationStore(revocations);
afterAll(() => revocations.close());
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// Actual signed login/revocation, physical host/login custody, repository owner,
// command admission, permission handler, native tool callback/FIFO/ACK and SQLite.
// Only external native process/RPC effects use the existing synthetic fixture.
async function fixture(
  options: {
    observe?: (scope: NativeHostToolContext, invocation: NativeCall) => void | Promise<void>;
    assertExtra?: () => unknown;
    cloneCall?: boolean;
    nativeBaseReads?: boolean;
    nativePolicyCheck?: () => unknown;
    /** Defensive fault injection inside a genuine verified callback. These
     * malformed server facets are not evidence of production authority. */
    readScopeFault?: ReadScopeFault;
    onReadScopeGetter?: () => void;
  } = {},
) {
  const f = await ownedRuntimeFixture(cleanups, {
    tools: [{ id: 'mitzo:AgentCommunication', version: 1 }],
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
    let tools!: ReturnType<typeof sessionAgentCommunicationTools>;
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
        if (options.observe || options.assertExtra)
          session.accountBinding = structuredClone(dispatch.lease.binding);
        const contextAuthority =
          options.observe || options.assertExtra
            ? retainAgentContextAuthority(auth, session.abortController)
            : undefined;
        if (contextAuthority) cleanups.push(() => contextAuthority.release());
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
        tools = sessionAgentCommunicationTools({
          events: f.events,
          native,
          registry,
          session,
          conversationId: sessionId,
          assertRuntimeCurrent: () => dispatch.admission.assertCurrent(),
          assertRuntimeCurrentSync: () => dispatch.admission.assertCurrentSync(),
          approve: (input, signal) =>
            buildPermissionHandler(clientId, registry)('AgentCommunication', input, {
              signal,
              toolUseID: randomUUID(),
              forcePrompt: true,
              allowSessionGrant: false,
            }),
          startQueued: async (target: ManagedSession) => {
            await handles.get(target.sessionId!)!.conversation.startQueued();
          },
        });
        const selectedNativePolicy = () =>
          composeOwnedLocalNativeExecutionPolicy({
            session,
            binding: dispatch.lease.binding,
            readableRoots: [dispatch.workspace.directory!],
            assertCurrentSync: () => dispatch.admission.assertCurrentSync(),
          });
        const nativeExecution = options.nativeBaseReads ? selectedNativePolicy() : undefined;
        conversation = new CodexConversation({
          conversationId: sessionId,
          cwd: dispatch.workspace.directory!,
          profile: dispatch.profile,
          storedBinding: dispatch.lease.binding,
          enableCapacityRecovery: false,
          store: native,
          systemPrompt: dispatch.payload.systemPrompt,
          getMode: () => session.mode,
          tools: agentCommunicationDefinitions,
          createClient: (cb) => {
            callbacks = cb;
            return dispatch.admission.attach(cb);
          },
          emit: (event) => f.events.append(sessionId, event.type as string, event),
          ...(nativeExecution
            ? {
                nativeExecution,
                resolveNativeExecutionPolicy: async () => selectedNativePolicy(),
                assertNativeExecutionCurrent: (policy: NonNullable<typeof nativeExecution>) => {
                  dispatch.admission.assertCurrentSync();
                  if (selectedNativePolicy().policyRevision !== policy.policyRevision)
                    throw Error('Original selected native read policy changed');
                  return options.nativePolicyCheck?.();
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
            if (!options.observe && !options.assertExtra)
              return {
                content: JSON.stringify(await tools.execute(input, signal, call)),
                isError: false,
              };
            const meta = f.events.getSession(sessionId)!;
            let contextCall = options.cloneCall ? Object.freeze(structuredClone(call)) : call;
            if (options.readScopeFault) {
              const capture = call.captureNativeBaseReadScope!;
              const faulty = { turnId: call.turnId, callId: call.callId };
              Object.defineProperty(
                faulty,
                'assertCurrentSync',
                Object.getOwnPropertyDescriptor(call, 'assertCurrentSync')!,
              );
              if (options.readScopeFault === 'getter-facet')
                Object.defineProperty(faulty, 'captureNativeBaseReadScope', {
                  get() {
                    options.onReadScopeGetter?.();
                    return capture;
                  },
                });
              else
                Object.defineProperty(faulty, 'captureNativeBaseReadScope', {
                  enumerable: options.readScopeFault === 'enumerable-facet',
                  value: Object.freeze(() => {
                    const original = capture.call(call);
                    if (options.readScopeFault === 'async-capture')
                      return Promise.resolve(original);
                    const value = { ...original };
                    if (options.readScopeFault === 'tuple')
                      value.nativeTarget = Object.freeze({
                        ...original.nativeTarget,
                        generation: original.nativeTarget.generation + 1,
                      });
                    if (options.readScopeFault === 'call') value.callId = 'different-call';
                    if (options.readScopeFault === 'tool') value.toolName = 'OtherTool';
                    if (options.readScopeFault === 'hash') value.requestHash = 'f'.repeat(64);
                    if (options.readScopeFault === 'async-assertion')
                      value.assertCurrentSync = Object.freeze(async () => {
                        original.assertCurrentSync();
                      });
                    if (options.readScopeFault === 'getter-data')
                      Object.defineProperty(value, 'readableRoots', {
                        get() {
                          options.onReadScopeGetter?.();
                          return original.readableRoots;
                        },
                      });
                    return Object.freeze(value);
                  }),
                });
              contextCall = Object.freeze(faulty) as NativeCall;
            }
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
                contextAuthority!.assertCurrent();
                return options.assertExtra?.();
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
              call: contextCall,
              signal,
            });
            try {
              await options.observe?.(scope, call);
              await scope.assertCurrent();
              return {
                content: JSON.stringify(await tools.execute(input, scope.signal, call)),
                isError: false,
              };
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
      async call(
        input: Record<string, unknown>,
        override?: Record<string, unknown>,
        callSignal?: AbortSignal,
      ) {
        const response = await callbacks.onRequest(
          'item/tool/call',
          {
            threadId: `thread-${sessionId}`,
            turnId: `turn-${turn}`,
            callId: randomUUID(),
            namespace: null,
            tool: 'AgentCommunication',
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
  const b = await start(await f.prepareSibling(), true);
  return {
    f,
    native,
    auth,
    a,
    b,
    registry,
    permissions,
    setPermissionAction(fn: typeof permissionAction) {
      permissionAction = fn;
    },
  };
}

it('routes a verified agent send through real approval/admission into a busy native FIFO, then ACKs and correlates an explicit reply', async () => {
  const f = await fixture();
  const listed = await f.a.call({ operation: 'list' });
  expect(listed.value.chats.map((c: { conversationId: string }) => c.conversationId)).toContain(
    f.b.sessionId,
  );
  const input = {
    operation: 'send',
    requestId: randomUUID(),
    recipientConversationId: f.b.sessionId,
    text: 'Can you review this result?',
  };
  const sent = await f.a.call(input);
  expect(sent.response.success).toBe(true);
  expect(sent.value.status).toBe('queued');
  expect(f.permissions).toHaveLength(1);
  expect(f.permissions[0]).toMatchObject({ toolName: 'AgentCommunication' });
  expect(f.b.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  expect(f.native.commands(f.b.sessionId, f.b.initial.lease.binding).map((c) => c.id)).toContain(
    sent.value.commandId,
  );
  await f.b.complete();
  await vi.waitFor(() =>
    expect(f.b.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2),
  );
  const receipt = await f.a.call({ operation: 'read', messageId: sent.value.messageId });
  expect(receipt.value.status).toBe('delivered');
  expect(f.native.capacityRecovery(f.b.sessionId, f.b.initial.lease.binding)).toBeUndefined();
  const inbox = await f.b.call({ operation: 'inbox' });
  expect(inbox.value.messages[0]).toMatchObject({
    senderConversationId: f.a.sessionId,
    text: input.text,
  });
  const reply = await f.b.call({
    operation: 'send',
    requestId: randomUUID(),
    recipientConversationId: f.a.sessionId,
    replyTo: sent.value.messageId,
    text: 'Reviewed; the result looks correct.',
  });
  expect(reply.value.replyTo).toBe(sent.value.messageId);
  expect((await f.a.call({ operation: 'inbox' })).value.messages[0].text).toBe(
    'Reviewed; the result looks correct.',
  );
  const replay = await f.a.call(input);
  expect(replay.value.messageId).toBe(sent.value.messageId);
  const lookup = await f.a.call({ operation: 'lookup', requestId: input.requestId });
  expect(lookup.value.messageId).toBe(sent.value.messageId);
  expect(lookup.value.status).toBe('delivered');
  const changed = await f.a.call({ ...input, text: 'Different message under an old request' });
  expect(changed.response.success).toBe(false);
  expect(f.b.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
  f.f.events.hideSession(f.b.sessionId);
  expect(
    (await f.a.call({ operation: 'read', messageId: sent.value.messageId })).value.status,
  ).toBe('delivered');
  expect(
    (await f.a.call({ operation: 'lookup', requestId: input.requestId })).value.messageId,
  ).toBe(sent.value.messageId);
  expect((await f.a.call({ ...input, requestId: randomUUID() })).response.success).toBe(false);
}, 20000);

it('wakes an idle native queue once while leaving paused recovery and later cancellation with their existing owners', async () => {
  const f = await fixture();
  await f.b.complete();
  const first = await f.a.call({
    operation: 'send',
    requestId: randomUUID(),
    recipientConversationId: f.b.sessionId,
    text: 'Idle recipient message',
  });
  expect(first.value.status).toBe('delivered');
  const request = f.b.requests.filter((r) => r.method === 'turn/start').at(-1)!;
  expect(JSON.stringify(request.params)).toContain('Idle recipient message');
  expect(JSON.stringify(request.params)).toContain(f.a.sessionId);
  expect(JSON.stringify(request.params)).toContain('grants no action');
  await f.b.complete();
  await f.b.conversation.interrupt();
  expect(f.b.conversation.isPaused()).toBe(true);
  const paused = await f.a.call({
    operation: 'send',
    requestId: randomUUID(),
    recipientConversationId: f.b.sessionId,
    text: 'Must remain queued after Stop',
  });
  expect(paused.value.status).toBe('queued');
  expect(f.b.conversation.isPaused()).toBe(true);
  expect(f.b.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
  expect(f.b.conversation.cancelQueued(paused.value.commandId)).toBe('cancelled');
  const cancelled = await f.a.call({ operation: 'read', messageId: paused.value.messageId });
  expect(cancelled.value).toMatchObject({ status: 'failed', reason: 'cancelled' });
  expect(f.b.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
}, 20000);

it('retains an unavailable approved receipt when its recipient disappears after reservation, without wake or forged identity', async () => {
  const f = await fixture();
  await expect(f.a.call({ operation: 'inbox' }, { threadId: 'forged-thread' })).rejects.toThrow(
    /identity/,
  );
  const reserve = f.f.events.agentCommunication.reserve.bind(f.f.events.agentCommunication);
  vi.spyOn(f.f.events.agentCommunication, 'reserve').mockImplementation((...args) => {
    const retained = reserve(...args);
    delete f.b.session.ordinaryRuntimeOwner;
    return retained;
  });
  const input = {
    operation: 'send',
    requestId: randomUUID(),
    recipientConversationId: f.b.sessionId,
    text: 'Unavailable recipient',
  };
  const sent = await f.a.call(input);
  expect(sent.value.status).toBe('unavailable');
  expect(
    (await f.a.call({ operation: 'lookup', requestId: input.requestId })).value.messageId,
  ).toBe(sent.value.messageId);
  expect(f.b.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  expect(f.native.commands(f.b.sessionId, f.b.initial.lease.binding)).toHaveLength(1);
}, 20000);

it('does not enqueue after signed operator revocation during exact-message approval', async () => {
  const f = await fixture();
  f.setPermissionAction((event) => {
    revokeAuthSession(f.auth);
    resolvePending(event.permId as string, 'once', undefined, event.sessionId as string);
  });
  const result = await f.a.call({
    operation: 'send',
    requestId: randomUUID(),
    recipientConversationId: f.b.sessionId,
    text: 'Do not deliver after logout',
  });
  expect(result.response.success).toBe(false);
  expect(f.f.events.agentCommunication.inbox(f.b.sessionId).messages).toEqual([]);
  expect(f.b.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
}, 20000);

it('retains uncertainty after recipient replacement during guarded admission and never retries that request as a fresh native turn', async () => {
  const f = await fixture();
  const initialRequest = f.f.events.getLatestOrdinaryCommandAdmission(f.b.sessionId)!;
  const old = f.b.session.ordinaryRuntimeOwner!;
  const original = f.b.driver.admitAgentMessage.bind(f.b.driver);
  f.b.session.ordinaryRuntimeOwner = {
    ...old,
    admitAgentMessage: async (id, current, signal) => {
      await Promise.resolve();
      f.b.session.ordinaryRuntimeOwner = old;
      return original(id, current, signal);
    },
  };
  const request = {
    operation: 'send',
    requestId: randomUUID(),
    recipientConversationId: f.b.sessionId,
    text: 'Retain this exact uncertain request',
  };
  const result = await f.a.call(request);
  expect(result.value.status).toBe('uncertain');
  const lookup = await f.a.call({ operation: 'lookup', requestId: request.requestId });
  expect(lookup.value.messageId).toBe(result.value.messageId);
  expect((await f.a.call(request)).value.messageId).toBe(result.value.messageId);
  expect(f.b.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  expect(f.f.events.getLatestOrdinaryCommandAdmission(f.b.sessionId)).toEqual(initialRequest);
  f.f.events.hideSession(f.b.sessionId);
  const retained = await f.a.call({ operation: 'lookup', requestId: request.requestId });
  expect(retained.value).toMatchObject({ messageId: result.value.messageId, status: 'uncertain' });
  expect(f.b.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
}, 20000);

it('repairs receipt projection from its exact durable native ACK without rerunning a delivered turn', async () => {
  const f = await fixture();
  await f.b.complete();
  const record = f.f.events.agentCommunication.recordForHost.bind(f.f.events.agentCommunication);
  const projection = vi
    .spyOn(f.f.events.agentCommunication, 'recordForHost')
    .mockImplementation((id, stage, reason) => {
      if (stage === 'delivered')
        throw Error('Offline injected receipt write failure after native ACK');
      return record(id, stage, reason);
    });
  const input = {
    operation: 'send',
    requestId: randomUUID(),
    recipientConversationId: f.b.sessionId,
    text: 'Retain ACK even if receipt projection fails',
  };
  const lost = await f.a.call(input);
  expect(lost.response.success).toBe(false);
  projection.mockRestore();
  const recovered = await f.a.call({ operation: 'lookup', requestId: input.requestId });
  expect(recovered.value.status).toBe('delivered');
  expect((await f.a.call(input)).value.messageId).toBe(recovered.value.messageId);
  expect(f.b.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
}, 20000);

it('reports uncertain native dispatch failure without treating it as queued or replaying the request', async () => {
  const f = await fixture();
  await f.b.complete();
  const request = f.b.rpc.request.getMockImplementation()!;
  f.b.rpc.request.mockImplementation(async (method) => {
    if (method === 'turn/start') throw Error('Offline injected lost native acceptance');
    return request(method);
  });
  const input = {
    operation: 'send',
    requestId: randomUUID(),
    recipientConversationId: f.b.sessionId,
    text: 'Unconfirmed native dispatch',
  };
  const result = await f.a.call(input);
  expect(result.value.status).toBe('uncertain');
  expect(
    (await f.a.call({ operation: 'lookup', requestId: input.requestId })).value.messageId,
  ).toBe(result.value.messageId);
  expect((await f.a.call(input)).value.status).toBe('uncertain');
  expect(f.native.commands(f.b.sessionId, f.b.initial.lease.binding)).toHaveLength(2);
}, 20000);

it.each(['user-closing', 'aborted', 'missing-owner', 'unsupported', 'foreign-login'] as const)(
  'does not advertise or prompt a fresh message to a known %s recipient and retains queued history',
  async (failure) => {
    const f = await fixture();
    const original = await f.a.call({
      operation: 'send',
      requestId: randomUUID(),
      recipientConversationId: f.b.sessionId,
      text: 'Original queued message',
    });
    expect(original.value.status).toBe('queued');
    const permissions = f.permissions.length;
    const commands = f.native.commands(f.b.sessionId, f.b.initial.lease.binding);
    if (failure === 'user-closing') f.registry.markUserClose(f.b.clientId);
    if (failure === 'aborted') f.b.session.abortController.abort();
    if (failure === 'missing-owner') delete f.b.session.ordinaryRuntimeOwner;
    if (failure === 'unsupported')
      f.b.session.ordinaryRuntimeOwner = {
        ...f.b.session.ordinaryRuntimeOwner!,
        admitAgentMessage: undefined,
      };
    if (failure === 'foreign-login')
      f.b.session.ordinaryRuntimeOwner = {
        ...f.b.session.ordinaryRuntimeOwner!,
        authSessionId: 'different-login',
      };
    const list = await f.a.call({ operation: 'list' });
    expect
      .soft(
        list.value.chats.find(
          (row: { conversationId: string }) => row.conversationId === f.b.sessionId,
        )?.availability,
      )
      .toBe('unavailable');
    const requestId = randomUUID();
    const result = await f.a.call({
      operation: 'send',
      requestId,
      recipientConversationId: f.b.sessionId,
      text: 'Do not prompt or reserve this new message',
    });
    expect.soft(result.response.success).toBe(false);
    expect.soft(f.permissions).toHaveLength(permissions);
    expect.soft(() => f.f.events.agentCommunication.byRequest(f.a.sessionId, requestId)).toThrow();
    const retained = await f.a.call({ operation: 'read', messageId: original.value.messageId });
    expect(retained.value).toMatchObject({ messageId: original.value.messageId, status: 'queued' });
    expect(f.native.commands(f.b.sessionId, f.b.initial.lease.binding)).toEqual(commands);
    expect(f.b.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
  },
  20000,
);

it('rechecks known recipient closure after asynchronous approval before reserving a new message', async () => {
  const f = await fixture();
  f.setPermissionAction((event) => {
    f.registry.markUserClose(f.b.clientId);
    resolvePending(event.permId as string, 'once', undefined, event.sessionId as string);
  });
  const requestId = randomUUID();
  const result = await f.a.call({
    operation: 'send',
    requestId,
    recipientConversationId: f.b.sessionId,
    text: 'Do not reserve after closure during approval',
  });
  expect(result.response.success).toBe(false);
  expect(f.permissions).toHaveLength(1);
  expect(() => f.f.events.agentCommunication.byRequest(f.a.sessionId, requestId)).toThrow();
  expect(f.native.commands(f.b.sessionId, f.b.initial.lease.binding)).toHaveLength(1);
  expect(f.b.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
}, 20000);

it('captures and disposes genuine signed host scope inside the existing native callback without another turn or capacity grant', async () => {
  let captured!: NativeHostToolContext;
  const f = await fixture({
    observe: async (scope) => {
      captured = scope;
      expect(Object.isFrozen(scope)).toBe(true);
      expect(Object.isFrozen(scope.accountBinding)).toBe(true);
      expect(Object.isFrozen(scope.profile)).toBe(true);
      scope.assertCurrentSync();
      await scope.assertCurrent();
    },
  });
  const priorAck = f.native.hasAcceptedProviderTurn(f.a.sessionId, f.a.initial.lease.binding);
  const priorCommands = f.native.commands(f.a.sessionId, f.a.initial.lease.binding);
  const command = priorCommands.find((entry) => entry.status === 'running')!;
  const expectedTarget = f.native.nativeTurnTarget(
    f.a.sessionId,
    f.a.initial.lease.binding,
    command.id,
    command.attempt,
  );
  const result = await f.a.call({ operation: 'list' });
  expect(result.response.success).toBe(true);
  expect(captured.nativeTarget).toEqual(expectedTarget);
  expect(Object.keys(captured.nativeTarget).sort()).toEqual(
    ['commandId', 'attempt', 'threadId', 'turnId', 'generation'].sort(),
  );
  expect(Object.isFrozen(captured.nativeTarget)).toBe(true);
  expect(Reflect.set(captured.nativeTarget, 'attempt', 999)).toBe(false);
  expect(captured.conversationId).toBe(f.a.sessionId);
  expect(captured.clientId).toBe(f.a.clientId);
  expect(captured.session).toBe(f.a.session);
  expect(captured.operatorId).toBe(f.auth.id);
  expect(captured.profile).toEqual(f.f.agentProfile);
  expect(captured.workspace.directory).toBe(f.a.session.cwd);
  expect(captured.signal.aborted).toBe(true);
  expect(() => captured.assertCurrentSync()).toThrow();
  expect(f.native.hasAcceptedProviderTurn(f.a.sessionId, f.a.initial.lease.binding)).toBe(priorAck);
  expect(f.native.commands(f.a.sessionId, f.a.initial.lease.binding)).toEqual(priorCommands);
  const forgedTarget = { ...expectedTarget, commandId: 'model-claimed', attempt: 999 };
  const forged = await f.a.call({ operation: 'list', nativeTarget: forgedTarget });
  expect(forged.response.success).toBe(false);
  expect(captured.nativeTarget).toEqual(expectedTarget);
  expect(captured.nativeTarget).not.toEqual(forgedTarget);
  expect(captured.signal.aborted).toBe(true);
  expect(() => captured.assertCurrentSync()).toThrow();
  expect(f.permissions).toHaveLength(0);
  expect(f.a.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
}, 20000);

it.each(['command-completed', 'thread-replaced', 'tool-completed'] as const)(
  'retains historical native target data but revokes %s pending proof',
  async (failure) => {
    let captured!: NativeHostToolContext;
    let entered!: () => void, release!: () => void;
    const executing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      observe: async (scope) => {
        captured = scope;
        entered();
        await held;
      },
    });
    const result = f.a.call({ operation: 'list' });
    const outcome = result.then(
      (value) => value.response.success,
      () => false,
    );
    await executing;
    try {
      captured.assertCurrentSync();
      const target = structuredClone(captured.nativeTarget);
      expect(target).toBeDefined();
      if (failure === 'command-completed')
        f.native.finish(
          f.a.sessionId,
          f.a.initial.lease.binding,
          target.commandId,
          'completed',
          target.turnId,
        );
      if (failure === 'thread-replaced')
        f.native.replaceThread(
          f.a.sessionId,
          f.a.initial.lease.binding,
          target.threadId,
          `${target.threadId}-replacement`,
          'provider_transport_failure',
        );
      if (failure === 'tool-completed')
        f.native.recordToolResult(
          f.a.sessionId,
          f.a.initial.lease.binding,
          target.commandId,
          captured.callId,
          {
            turnId: captured.turnId,
            toolName: captured.toolName,
            requestHash: captured.requestHash,
          },
          { content: 'Already completed', isError: false },
        );
      expect(() => captured.assertCurrentSync()).toThrow();
      await expect(captured.assertCurrent()).rejects.toThrow();
      expect(captured.nativeTarget).toEqual(target);
      expect(Object.isFrozen(captured.nativeTarget)).toBe(true);
    } finally {
      release();
    }
    expect(await outcome).toBe(false);
    expect(f.permissions).toHaveLength(0);
    expect(f.a.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  },
  20000,
);

it('retains qualified native base reads as private immutable original-call facts', async () => {
  let captured!: NativeHostToolContext;
  const f = await fixture({
    nativeBaseReads: true,
    observe: (context, invocation) => {
      captured = context;
      const original = invocation.captureNativeBaseReadScope!();
      original.assertCurrentSync();
      const scope = context.nativeBaseReadScope!;
      expect(scope).toBeDefined();
      expect(scope.nativeTarget).toEqual(context.nativeTarget);
      expect(scope.nativeTarget).toEqual(original.nativeTarget);
      expect(scope.nativeTarget).not.toBe(original.nativeTarget);
      for (const name of ['callId', 'toolName', 'requestHash'] as const)
        expect(scope[name]).toBe(context[name]);
      for (const name of ['bindingRevision', 'profileRevision', 'policyRevision'] as const)
        expect(scope[name]).toBe(original[name]);
      for (const name of ['readableRoots', 'workspaceRoots', 'deniedRoots'] as const) {
        expect(scope[name]).toEqual(original[name]);
        expect(scope[name]).not.toBe(original[name]);
        expect(Object.isFrozen(scope[name])).toBe(true);
      }
      expect(scope.readableRoots).not.toContain('/');
      expect(Object.isFrozen(scope)).toBe(true);
      expect(Object.isFrozen(scope.nativeTarget)).toBe(true);
      expect(Object.isFrozen(scope.assertCurrentSync)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(context, 'nativeBaseReadScope')).toMatchObject({
        enumerable: false,
        writable: false,
        configurable: false,
        value: scope,
      });
      expect({ ...context }).not.toHaveProperty('nativeBaseReadScope');
      const serialized = { ...context, session: undefined };
      expect(JSON.stringify(serialized)).not.toContain('nativeBaseReadScope');
      scope.assertCurrentSync();
    },
  });
  const result = await f.a.call({ operation: 'list' });
  expect(captured).toBeDefined();
  expect(captured.nativeBaseReadScope).toBeDefined();
  expect(result.response.success).toBe(true);
  expect(() => captured.nativeBaseReadScope!.assertCurrentSync()).toThrow();
  expect(f.permissions).toHaveLength(0);
  expect(f.a.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
}, 20000);

it('keeps signed history context usable when the original native read facet is absent', async () => {
  const observe = vi.fn((context: NativeHostToolContext, invocation: NativeCall) => {
    expect(invocation).not.toHaveProperty('captureNativeBaseReadScope');
    expect(context).not.toHaveProperty('nativeBaseReadScope');
    context.assertCurrentSync();
  });
  const f = await fixture({ observe });
  expect((await f.a.call({ operation: 'list' })).response.success).toBe(true);
  expect(observe).toHaveBeenCalledOnce();
});

it.each(['command', 'policy', 'mode', 'tuple', 'dispose', 'abort', 'async-assertion'] as const)(
  'revokes retained native base reads on %s without extending the original call lifetime',
  async (change) => {
    let captured!: NativeHostToolContext;
    let original!: ReturnType<NonNullable<NativeCall['captureNativeBaseReadScope']>>;
    let entered!: () => void, release!: () => void;
    const executing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let policyCurrent = true;
    let assertionResult: unknown;
    const f = await fixture({
      nativeBaseReads: true,
      nativePolicyCheck: () => {
        if (!policyCurrent) throw Error('Current native policy revoked');
        return assertionResult;
      },
      observe: async (context, invocation) => {
        captured = context;
        original = invocation.captureNativeBaseReadScope!();
        entered();
        await held;
      },
    });
    const controller = new AbortController();
    const result = f.a.call({ operation: 'list' }, undefined, controller.signal);
    const outcome = result.then(
      (value) => value.response.success,
      () => false,
    );
    await Promise.race([
      executing,
      outcome.then(() => {
        throw Error('Original native read scope was unavailable');
      }),
    ]);
    try {
      const scope = captured.nativeBaseReadScope!;
      expect(scope).toBeDefined();
      scope.assertCurrentSync();
      if (change === 'command')
        f.native.finish(
          f.a.sessionId,
          f.a.initial.lease.binding,
          scope.nativeTarget.commandId,
          'completed',
          scope.nativeTarget.turnId,
        );
      if (change === 'policy') policyCurrent = false;
      if (change === 'mode') f.registry.setMode(f.a.clientId, 'ask');
      if (change === 'tuple')
        f.native.replaceThread(
          f.a.sessionId,
          f.a.initial.lease.binding,
          scope.nativeTarget.threadId,
          `${scope.nativeTarget.threadId}-replacement`,
          'provider_transport_failure',
        );
      if (change === 'dispose') {
        captured.dispose();
        // The consumer's disposal narrows the lifetime even while the original
        // native producer remains current inside this held callback.
        expect(() => original.assertCurrentSync()).not.toThrow();
      }
      if (change === 'abort') controller.abort();
      if (change === 'async-assertion') assertionResult = Promise.resolve();
      expect(() => scope.assertCurrentSync()).toThrow();
      expect(() => captured.assertCurrentSync()).toThrow();
      await expect(captured.assertCurrent()).rejects.toThrow();
    } finally {
      release();
    }
    expect(await outcome).toBe(false);
    expect(f.permissions).toHaveLength(0);
    expect(f.a.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
  },
  20000,
);

it.each([
  'tuple',
  'call',
  'tool',
  'hash',
  'async-assertion',
  'async-capture',
  'getter-facet',
  'getter-data',
  'enumerable-facet',
] satisfies ReadScopeFault[])(
  'refuses malformed native read facet %s inside the actual verified callback',
  async (readScopeFault) => {
    const observe = vi.fn();
    const getter = vi.fn();
    const f = await fixture({
      nativeBaseReads: true,
      readScopeFault,
      onReadScopeGetter: getter,
      observe,
    });
    const result = await f.a.call({ operation: 'list' });
    expect(result.response.success).toBe(false);
    expect(observe).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(f.permissions).toHaveLength(0);
    expect(f.a.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
  },
  20000,
);

it.each(['logout', 'closing', 'root-changed'] as const)(
  'refuses %s signed host scope after its actual asynchronous native wait',
  async (failure) => {
    let captured!: NativeHostToolContext;
    let entered!: () => void, release!: () => void;
    const executing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      observe: async (scope) => {
        captured = scope;
        entered();
        await held;
      },
    });
    const result = f.a.call({ operation: 'list' });
    await executing;
    captured.assertCurrentSync();
    if (failure === 'logout') revokeAuthSession(f.auth);
    if (failure === 'closing') f.registry.markUserClose(f.a.clientId);
    if (failure === 'root-changed') f.a.session.cwd = join(f.f.root, 'different-root');
    expect(() => captured.assertCurrentSync()).toThrow();
    release();
    expect((await result).response.success).toBe(false);
    expect(f.permissions).toHaveLength(0);
    expect(f.a.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  },
  20000,
);

it.each(['async-resolve', 'async-reject', 'value', 'cloned-labels'] as const)(
  'refuses and drains a %s context assertion instead of accepting a void annotation',
  async (failure) => {
    const observe = vi.fn();
    const f = await fixture({
      observe,
      cloneCall: failure === 'cloned-labels',
      assertExtra:
        failure === 'cloned-labels'
          ? undefined
          : () =>
              failure === 'value'
                ? true
                : failure === 'async-reject'
                  ? Promise.reject(Error('Synthetic async authority failure'))
                  : Promise.resolve(),
    });
    const result = await f.a.call({ operation: 'list' });
    expect(result.response.success).toBe(false);
    expect(observe).not.toHaveBeenCalled();
    expect(f.permissions).toHaveLength(0);
    expect(f.a.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  },
  20000,
);
