import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SessionRegistry,
  buildPermissionHandler,
  resolvePending,
  type ManagedSession,
} from '@mitzo/harness';
import { ownedOrdinaryRuntimeFixture } from './fixtures/owned-ordinary-workspace-runtime.js';
import { setAuthRevocationStore } from '../auth.js';
import { bindAgentToolSelection } from '../agent-tool-selection.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { EventStore } from '../event-store.js';
import { CodexConversation } from '../codex-conversation.js';
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

vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));

const cleanups: Array<() => void | Promise<void>> = [];
const revocations = new EventStore(':memory:');
setAuthRevocationStore(revocations);
afterAll(() => revocations.close());
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// Combined-source qualification: actual non-Git private workspace/custody,
// signed operator, native tool/FIFO/ACK and SQLite; external process/RPC fake.
async function fixture() {
  const f = await ownedOrdinaryRuntimeFixture(cleanups, {
    tools: [{ id: 'mitzo:AgentCommunication', version: 1 }],
  });
  const auth = f.auth;
  const operatorConnectionId = f.operatorConnectionId;
  cleanups.push(() => expect(f.forbidden).not.toHaveBeenCalled());
  const native = new CodexConversationStore(join(f.root, 'peer-native.db'));
  cleanups.push(() => native.close());
  const registry = new SessionRegistry();
  cleanups.push(() => registry.dispose());
  const handles = new Map<string, Awaited<ReturnType<typeof start>>>();
  const permissions: Array<Record<string, unknown>> = [];
  let permissionAction: (event: Record<string, unknown>) => void = (event) => {
    resolvePending(event.permId as string, 'once', undefined, event.sessionId as string);
  };

  async function start(selected: Awaited<ReturnType<typeof f.prepareSibling>>) {
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
    let initial!: OrdinaryLocalCodexOwnedDispatch<'ordinary'>;
    const driver = new OrdinaryLocalCodexOwnedRuntime<'ordinary'>({
      ...selected.dependencies,
      nativeStore: native,
      operatorConnectionId,
      dispatch: async (dispatch) => {
        initial = dispatch;
        session.cwd = dispatch.workspace.directory;
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
          ordinaryWorkspace: dispatch.workspace,
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
          executeTool: async (_name, input, signal, call) => ({
            content: JSON.stringify(await tools.execute(input, signal, call)),
            isError: false,
          }),
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
    await driver.admitPreparedFirst(selected.receipt.allocationOperationId, selected.request);
    expect(f.events.getSession(sessionId)?.ordinaryWorkspaceId).toBe(selected.reserved.id);
    expect(f.events.getSession(sessionId)?.repositoryWorkspaceId).toBeUndefined();
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
      async call(input: Record<string, unknown>, override?: Record<string, unknown>) {
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
  const a = await start(f.first);
  const b = await start(await f.prepareSibling());
  expect(a.session.cwd).not.toBe(b.session.cwd);
  return {
    f,
    native,
    auth,
    a,
    b,
    permissions,
    setPermissionAction(fn: typeof permissionAction) {
      permissionAction = fn;
    },
  };
}

it('non-Git: routes a verified agent send through real approval/admission into a busy native FIFO, then ACKs and correlates an explicit reply', async () => {
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

it('non-Git: wakes an idle native queue once while leaving paused recovery and later cancellation with their existing owners', async () => {
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
