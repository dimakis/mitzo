import { resetOfflineUserEnvironment } from './fixtures/offline-user-home.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  OrdinaryCodexRetainedCommandObservationSchema,
  OrdinaryCodexFirstCommandSchema,
  RuntimeFailureSchema,
  runtimeFailureMessage,
} from '@mitzo/protocol';
import { ownedRuntimeFixture } from './fixtures/owned-local-codex-runtime.js';
import { OrdinaryLocalCodexOwnedRuntime } from '../ordinary-local-codex-owned-runtime.js';
import { OrdinaryLocalCodexSelectionOwner } from '../ordinary-local-codex-selection-owner.js';
import { OwnedCodexLifecycleBridge } from '../owned-codex-lifecycle-bridge.js';
import { CodexConversation } from '../codex-conversation.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { CodexTransportError, type CodexLifecycleTransport } from '../codex-app-server-client.js';
import { reportRetainedRuntimeFailure } from '../retained-runtime-failure.js';
import { findSessionRuntimeError } from '../session-runtime-error.js';
import { assembleCommandPrompt } from '../message-reply-context.js';
import { createMitzoStore } from '../../packages/client/src/store.js';
import { metadataConnection } from '../../packages/client/src/__tests__/fixtures/metadata-connection.js';

vi.mock('../auth.js', async (original) => ({
  ...(await original<typeof import('../auth.js')>()),
  hasPersistentRevocationAuthority: () => true,
}));
vi.mock('../../packages/client/src/sse-connection.js', async () => ({
  SseConnection: (
    await import('../../packages/client/src/__tests__/fixtures/metadata-connection.js')
  ).MetadataTestConnection,
}));

const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(resetOfflineUserEnvironment);
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('delivers raw tool validation failure through owned custody, conversation and strict retained replay without releasing uncertain work', async () => {
  const f = await ownedRuntimeFixture(cleanups);
  const native = new CodexConversationStore(join(f.root, 'consumer-native.db'));
  cleanups.push(() => native.close());
  let lifecycle!: CodexLifecycleTransport;
  let conversation!: CodexConversation;
  let commandPrompt = '';
  let validationFails = false;
  const privateCause = Object.assign(Error('private/path secret-token'), { code: 'EPERM' });
  const validate = OrdinaryLocalCodexSelectionOwner.prototype.assertToolCurrent;
  vi.spyOn(OrdinaryLocalCodexSelectionOwner.prototype, 'assertToolCurrent').mockImplementation(
    async function (this: OrdinaryLocalCodexSelectionOwner, ...args) {
      if (validationFails) throw privateCause;
      return Reflect.apply(validate, this, args);
    },
  );
  const attach = OwnedCodexLifecycleBridge.prototype.attach;
  vi.spyOn(OwnedCodexLifecycleBridge.prototype, 'attach').mockImplementation(function (
    this: OwnedCodexLifecycleBridge,
    owner,
  ) {
    lifecycle = this.lifecycle;
    return Reflect.apply(attach, this, [owner]);
  });
  // Physical transport shutdown reenters the actual bridge with its generic
  // close error, as the native process does. The original cause must win.
  f.rpc.close.mockImplementation(() => lifecycle.onClose(new CodexTransportError('connection')));
  const originalRequest = f.rpc.request.getMockImplementation()!;
  f.rpc.request.mockImplementation(async (method, params) => {
    if (method === 'thread/start')
      return {
        thread: { id: 'consumer-thread' },
        model: f.request.selection.model,
        modelProvider: 'openai',
      };
    if (method === 'turn/start') return { turn: { id: 'consumer-turn' } };
    return originalRequest(method, params);
  });
  const executeTool = vi.fn(async () => ({ content: 'Must not execute', isError: false }));
  const errors: Error[] = [];
  const runtime = new OrdinaryLocalCodexOwnedRuntime({
    ...f.dependencies,
    dispatch: async (value) => {
      commandPrompt = assembleCommandPrompt(
        f.events,
        value.sessionId,
        value.commandId,
        value.payload,
      );
      value.admission.assertOptions({
        conversationId: value.sessionId,
        messageId: value.commandId,
        binding: value.lease.binding,
        profile: value.profile,
        session: { cwd: value.workspace.directory, mode: 'agent' },
        prompt: commandPrompt,
        systemPrompt: value.payload.systemPrompt,
        intent: value.payload.intent,
        images: value.payload.images,
        model: value.expected.selection.model,
        reasoningEffort: value.expected.selection.thinking,
        agentProfile: value.expected.agentProfile,
        agentContext: value.expected.agentContext,
        repositoryWorkspace: value.workspace,
      });
      conversation = new CodexConversation({
        conversationId: value.sessionId,
        cwd: value.workspace.directory!,
        systemPrompt: value.payload.systemPrompt,
        profile: value.profile,
        storedBinding: value.lease.binding,
        store: native,
        ownerKind: 'ordinary',
        transportClosure: 'terminal',
        enableCapacityRecovery: false,
        tools: [{ name: 'Write', description: 'Offline effect', input_schema: { type: 'object' } }],
        verifyBinding: async () => value.lease.binding,
        beforeThreadInitialization: () => value.admission.persistCustody(native),
        beforeEnqueue: (input) => value.admission.assertBeforeEnqueue(input),
        canClaimCommand: (id) => value.admission.canClaimCommand(id),
        onProviderDispatch: (id) => value.admission.assertBeforeDispatch(id),
        createClient: (owner) => value.admission.attach(owner),
        emit: () => {},
        onError: (error) => {
          errors.push(error);
          reportRetainedRuntimeFailure({ store: f.events, sessionId: value.sessionId, error });
        },
        executeTool,
      });
      cleanups.push(() => conversation.close());
      await conversation.initialize();
      await conversation.admitExplicitSend({
        id: value.commandId,
        prompt: commandPrompt,
        intent: value.payload.intent,
        model: value.expected.selection.model,
        reasoningEffort: value.expected.selection.thinking,
      });
    },
  });
  cleanups.push(() => runtime.close());
  await expect(runtime.admit(f.request)).resolves.toEqual({ dispatched: true });
  await conversation.resumeAfterExplicitSend();
  const sessionId = f.reservation.conversationId;
  const binding = f.reservation.binding;
  native.enqueue(sessionId, binding, {
    id: 'queued-successor',
    prompt: 'Continue the retained task',
  });
  validationFails = true;
  await expect(
    lifecycle.onRequest(
      'item/tool/call',
      {
        threadId: 'consumer-thread',
        turnId: 'consumer-turn',
        callId: 'failed-validation',
        tool: 'Write',
        arguments: {},
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow();

  expect(executeTool).not.toHaveBeenCalled();
  expect(errors).toHaveLength(1);
  expect(findSessionRuntimeError(errors[0])).toMatchObject({
    code: 'tool_validation_failed',
    cause: privateCause,
  });
  const saved = f.events.getLatestEvent(sessionId, 'error')!.payload;
  expect(saved).toMatchObject({ runtimeFailure: { runtimeFailureCode: 'tool_validation_failed' } });
  expect(saved.error).toContain('Mitzo could not validate the current tool operation');
  expect(saved.error).not.toContain('connection closed');
  expect(JSON.stringify(saved)).not.toMatch(/private\/path|secret-token/);
  const replay = OrdinaryCodexRetainedCommandObservationSchema.parse({
    ok: false,
    code: 'retained_command',
    clientMsgId: f.request.clientMsgId,
    sessionId,
    state: 'uncertain',
    error: saved.error,
    runtimeFailure: saved.runtimeFailure,
  });
  expect(
    'runtimeFailure' in replay &&
      runtimeFailureMessage(RuntimeFailureSchema.parse(replay.runtimeFailure)),
  ).toBe(saved.error);
  // Cold device receipt replay must render the reviewed code, preserve the
  // exact draft/request and end its Sending label without resubmitting work.
  let deviceStorage: string | null = null;
  const fetch = vi.fn(async (path: string) =>
    path === '/local/send' ? Response.json(replay, { status: 409 }) : Response.json([]),
  );
  const client = createMitzoStore({
    transport: { fetch },
    wsConfig: {
      buildUrl: () => '',
      createWebSocket: () => {
        throw Error('Inert SSE only');
      },
    },
    sseConfig: { baseUrl: '', fetch },
    localFirstCommandConfig: {
      url: '/local/send',
      storage: {
        getItem: () => deviceStorage,
        setItem: (_key, value) => {
          deviceStorage = value;
        },
      },
    },
  });
  metadataConnection.listener({ type: '_open' });
  const originalCommand = OrdinaryCodexFirstCommandSchema.parse({
    ...f.request,
    runOn: 'local' as const,
    repositoryWorkspaceId: f.reservation.id,
  });
  expect(
    client.getState().sendLocalFirstCommand(originalCommand, { draftId: 'retained-draft' }),
  ).toBe(true);
  await vi.waitFor(() => expect(client.getState().sendError).toBe(saved.error));
  expect(client.getState().messages.commandStates?.[f.request.clientMsgId]).toBe('uncertain');
  expect(client.getState().localCommand).toMatchObject({
    state: 'retained',
    request: originalCommand,
  });
  expect(JSON.parse(deviceStorage!)[0].body).toEqual(originalCommand);
  expect(fetch.mock.calls.filter(([path]) => path === '/local/send')).toHaveLength(1);
  metadataConnection.listener({ type: '_close' });
  expect(native.commandStatus(sessionId, binding, f.request.clientMsgId)).toBe('interrupted');
  expect(native.commandStatus(sessionId, binding, 'queued-successor')).toBe('queued');
  expect(native.continuationBlocker(sessionId, binding)).toBeDefined();
  expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  expect(f.rpc.close).toHaveBeenCalled();
});
