import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventStore } from '../event-store.js';
import { SessionRegistry } from '@mitzo/harness';
import { agentMessagePrompt } from '@mitzo/protocol';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { SdkAgentMessageRuntime } from '../sdk-agent-message-runtime.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../async-queue.js';
import {
  createOrdinaryLocalVertexSdkQuery,
  SdkHookLifetime,
} from '../ordinary-local-vertex-sdk-query.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runQueryLoop } from '../query-loop.js';
import { OrdinaryLocalVertexCommandOwner } from '../ordinary-local-vertex-command-owner.js';
import * as nativeHistory from '../ordinary-local-vertex-native-history.js';
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

function fixture(prepareWorker?: (events: EventStore) => void) {
  const root = mkdtempSync(join(tmpdir(), 'sdk-peer-receipt-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'events.db');
  let events = new EventStore(path);
  cleanup.push(() => events.close());
  events.upsertSession({ sessionId: 'sender' });
  if (prepareWorker) prepareWorker(events);
  else events.upsertSession({ sessionId: 'worker' });
  const registry = new SessionRegistry();
  cleanup.push(() => registry.dispose());
  const identity = {};
  registry.register('operator:worker', {
    sessionId: 'worker',
    transport: { send() {}, isOpen: () => true },
    abortController: new AbortController(),
    mode: 'agent',
    sessionAllowList: new Set(),
    ordinaryRuntimeOwner: {
      location: 'local',
      authSessionId: 'operator',
      identity,
      initialCommandId: 'original',
      admit: vi.fn(),
      retryInitial: vi.fn(),
      close() {},
    },
  });
  const session = registry.get('operator:worker')!;
  const message = events.agentCommunication.reserve(
    'sender',
    'operator',
    { turnId: 'sender-turn', callId: 'sender-call' },
    {
      requestId: randomUUID(),
      recipientConversationId: 'worker',
      text: 'Keep your existing task; account for this correction.',
    },
  );
  events.agentCommunication.claim(message.messageId);
  let active: string | undefined = 'original';
  let paused = false;
  const push = vi.fn<(input: SDKUserMessage) => void>();
  const assertCurrent = vi.fn();
  const enqueue = vi.fn(async () => {});
  const create = (activeCommandId = () => active) =>
    new SdkAgentMessageRuntime({
      events,
      session,
      identity,
      operatorAuthSessionId: 'operator',
      assertCurrent,
      activeCommandId,
      stopped: () => paused,
      push,
      enqueue,
    });
  return {
    get events() {
      return events;
    },
    reopen: () => {
      events.close();
      events = new EventStore(path);
    },
    session,
    registry,
    message,
    push,
    assertCurrent,
    enqueue,
    create,
    setActive: (id: string | undefined) => {
      active = id;
    },
    stop: () => {
      paused = true;
    },
  };
}

const originalInputId = '00000000-0000-4000-8000-000000000001';
const successorInputId = '00000000-0000-4000-8000-000000000002';

it('retains idle admission authority until real SDK stdin and refuses lost live guards after reopen', async () => {
  const f = fixture();
  f.setActive(undefined);
  const runtime = f.create();
  let allowed = true;
  const current = () => {
    if (!allowed) throw Error('Peer grant revoked');
  };
  await runtime.enqueue(f.message, current, new AbortController().signal, {
    id: 'operator',
    expiresAt: Date.now() + 60000,
  });
  const ordinaryInput = {
    type: 'user' as const,
    parent_tool_use_id: null,
    mitzoMessageId: f.message.commandId,
    message: { role: 'user' as const, content: agentMessagePrompt(f.message) },
  };
  allowed = false;
  expect(() => runtime.beforeInput(ordinaryInput)).toThrow();
  expect(f.events.agentCommunication.read('sender', f.message.messageId)).toMatchObject({
    status: 'failed',
    reason: 'before_provider_submission',
  });
  f.reopen();
  expect(() => f.create().beforeInput(ordinaryInput)).toThrow();
});

it('requires exact submitted idle input acknowledgement and rejects replay after SQLite reopen', async () => {
  const f = fixture();
  f.setActive(undefined);
  const runtime = f.create();
  await runtime.enqueue(f.message, () => {}, new AbortController().signal, {
    id: 'operator',
    expiresAt: Date.now() + 60000,
  });
  f.setActive(f.message.commandId);
  const input: SDKUserMessage & { mitzoMessageId: string } = {
    type: 'user',
    parent_tool_use_id: null,
    mitzoMessageId: f.message.commandId,
    message: { role: 'user', content: `Context\n${agentMessagePrompt(f.message)}` },
  };
  expect(runtime.beforeInput(input)).toBe(true);
  const ack = { type: 'user', uuid: input.uuid, message: input.message };
  expect(runtime.observe({ ...ack, uuid: randomUUID() })).toBe(true);
  expect(runtime.observe({ ...ack, message: { content: 'Wrong text' } })).toBe(true);
  expect(f.events.agentCommunication.read('sender', f.message.messageId).status).not.toBe(
    'delivered',
  );
  expect(runtime.observe(ack)).toBe(false);
  expect(f.events.agentCommunication.read('sender', f.message.messageId).status).toBe('delivered');
  expect(runtime.observe(ack)).toBe(true);
  const correction = f.events.agentCommunication.reserve(
    'sender',
    'operator',
    { turnId: 'second-turn', callId: 'second-call' },
    {
      requestId: randomUUID(),
      recipientConversationId: 'worker',
      text: 'Correct the now active peer command.',
    },
  );
  f.events.agentCommunication.claim(correction.messageId);
  await runtime.steer(correction, () => {}, new AbortController().signal);
  const correctionInput = f.push.mock.calls.at(-1)![0];
  expect(runtime.beforeInput(correctionInput)).toBe(true);
  expect(
    runtime.observe({ type: 'user', uuid: correctionInput.uuid, message: correctionInput.message }),
  ).toBe(true);
  expect(f.events.agentCommunication.read('sender', correction.messageId).status).toBe('delivered');
  f.reopen();
  expect(f.create().observe(ack)).toBe(true);
});

async function composedFixture() {
  const binding = {
    version: 2 as const,
    account: {
      accountId: 'vertex',
      provider: 'anthropic-vertex' as const,
      profileRevision: 'exact-profile',
    },
    harness: { implementation: 'claude-sdk' as const },
    execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'exact-target' },
  };
  const meta = {
    sessionId: 'worker',
    repositoryWorkspaceId: 'workspace',
    cwd: '/fixture',
    accountBinding: { ...binding.account, accountLabel: 'Vertex', model: 'offline' },
  };
  const command = (id: string) => ({
    clientMsgId: id,
    requestFingerprint: `exact-${id}`,
    payload: { text: id },
    selection: {
      version: 1 as const,
      agent: { profileId: 'published', revision: 1 },
      context: { source: 'none' as const, revision: null },
      permission: { mode: 'ask' as const, revision: 0 },
      model: 'offline',
      thinking: null,
    },
  });
  const f = fixture((store) =>
    store.admitOrdinaryLocalVertexCommand(meta, binding, command('original')),
  );
  const events = new AsyncQueue<Record<string, unknown>>();
  let stdin!: AsyncIterable<SDKUserMessage>;
  vi.mocked(query).mockImplementation((request) => {
    stdin = request.prompt as typeof stdin;
    return {
      close: () => events.close(),
      [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    } as never;
  });
  let state!: { completing: boolean };
  const controller = f.session.abortController;
  cleanup.push(() => controller.abort());
  const sdk = createOrdinaryLocalVertexSdkQuery<
    AsyncIterable<Record<string, unknown>> & { close(): void }
  >({
    options: {},
    input: new AsyncQueue<SDKUserMessage>(),
    lifetime: new SdkHookLifetime(),
    sdkSessionId: 'worker',
    cwd: '/fixture',
    controller,
    authorize: async () => f.assertCurrent(),
    authorizeSync: () => f.assertCurrent(),
    adapt: (q) => q as never,
    settings: () => ({}),
    inputChanged: () => {},
    peerMessages: () => runtime,
    mcpServers: (current) => {
      state = current;
      return {};
    },
  });
  const abort = vi.fn(() => controller.abort());
  const push = vi.fn((id: string) => {
    sdk.push({
      type: 'user',
      uuid: id === 'original' ? originalInputId : successorInputId,
      parent_tool_use_id: null,
      message: { role: 'user', content: id },
    });
  });
  const commands = new OrdinaryLocalVertexCommandOwner({
    store: f.events,
    sessionId: 'worker',
    assertCurrent: f.assertCurrent,
    query: {
      setModel: async () => {},
      setMaxThinkingTokens: async () => {},
      push,
      abort,
    },
    settings: () => ({ model: 'offline', thinkingTokens: null }),
  });
  const runtime = f.create(() => commands.peerTurnTarget());
  f.push.mockImplementation((input) => sdk.push(input));
  await commands.enqueue('original');
  f.events.admitOrdinaryLocalVertexContinuation(meta, binding, command('successor'));
  await commands.enqueue('successor');
  const inputs = stdin[Symbol.asyncIterator]();
  expect((await inputs.next()).value?.uuid).toBe(originalInputId);
  const observedInputs = vi.fn((id: string) => commands.inputObserved(id));
  const afterAssistant = vi.fn();
  async function* observedQuery() {
    for await (const event of sdk.query) {
      yield event;
      if (event.type === 'assistant') afterAssistant();
    }
  }
  const resultIds: Array<string | undefined> = [];
  const settlements: Array<Promise<string>> = [];
  const loop = runQueryLoop(
    observedQuery(),
    'operator:worker',
    f.registry,
    controller,
    undefined,
    undefined,
    {
      onUserInput: (_clientId, id) => observedInputs(id),
      onResult: (_clientId, result, id) => {
        resultIds.push(id);
        settlements.push(
          commands.resultObserved(id, result.is_error === true).then(
            () => 'completed',
            () => 'refused',
          ),
        );
      },
    },
  );
  events.push({
    type: 'user',
    session_id: 'worker',
    uuid: originalInputId,
    message: { role: 'user', content: 'Original task' },
  });
  events.push({
    type: 'stream_event',
    session_id: 'worker',
    event: { type: 'message_start', message: { id: 'original-assistant' } },
  });
  await vi.waitFor(() => expect(commands.peerTurnTarget()).toBe('original'));
  return {
    ...f,
    runtime,
    commands,
    sdk,
    inputs,
    stream: events,
    observedInputs,
    afterAssistant,
    resultIds,
    settlements,
    ordinaryPush: push,
    abort,
    state: () => state,
    finish: async () => {
      sdk.query.close();
      await loop;
    },
  };
}

it('consumes a user correction ACK before the ordinary owner and releases its successor only on the original result', async () => {
  const f = await composedFixture();
  const correction = {
    requestId: randomUUID(),
    targetCommandId: 'original',
    text: 'Preserve the current task and correct its order.',
  };
  expect(await f.runtime.steerUser(correction, f.assertCurrent)).toEqual({ status: 'uncertain' });
  const input = (await f.inputs.next()).value!;
  expect(input).toMatchObject({ priority: 'now', message: { content: correction.text } });
  f.stream.push({ type: 'user', session_id: 'worker', uuid: input.uuid, message: input.message });
  f.stream.push({
    type: 'assistant',
    session_id: 'worker',
    message: { id: 'original-assistant', content: [] },
  });
  await vi.waitFor(() => expect(f.afterAssistant).toHaveBeenCalledOnce());
  expect(await f.runtime.steerUser(correction, f.assertCurrent)).toEqual({ status: 'accepted' });
  expect(f.observedInputs.mock.calls).toEqual([[originalInputId]]);
  expect(f.commands.activeCommandId()).toBe('original');
  expect(f.ordinaryPush.mock.calls.map(([id]) => id)).toEqual(['original']);
  expect(f.resultIds).toEqual([]);
  expect(f.state().completing).toBe(false);
  f.stream.push({ type: 'result', session_id: 'worker', uuid: 'original-result', is_error: false });
  await vi.waitFor(() => expect(f.resultIds).toEqual([originalInputId]));
  expect(await f.settlements[0]).toBe('completed');
  expect(f.ordinaryPush.mock.calls.map(([id]) => id)).toEqual(['original', 'successor']);
  expect(f.abort).not.toHaveBeenCalled();
  await f.finish();
});

it('keeps a submitted user correction uncertain when a successor SDK query replays its ACK', async () => {
  const f = await composedFixture();
  const correction = {
    requestId: randomUUID(),
    targetCommandId: 'original',
    text: 'Keep this correction on the original query.',
  };
  await f.runtime.steerUser(correction, f.assertCurrent);
  const input = (await f.inputs.next()).value!;
  f.stream.push({ type: 'result', session_id: 'worker', uuid: 'original-result', is_error: false });
  await vi.waitFor(() => expect(f.resultIds).toEqual([originalInputId]));
  expect(await f.settlements[0]).toBe('completed');
  const nextEvents = new AsyncQueue<Record<string, unknown>>();
  vi.mocked(query).mockImplementationOnce(
    () =>
      ({
        close: () => nextEvents.close(),
        [Symbol.asyncIterator]: () => nextEvents[Symbol.asyncIterator](),
      }) as never,
  );
  const selection = f.events.getOrdinaryLocalVertexCommandAdmission('successor')!.selection;
  await f.sdk.apply(selection);
  const history = vi
    .spyOn(nativeHistory, 'assertOrdinaryLocalVertexHistory')
    .mockResolvedValueOnce();
  try {
    await f.sdk.apply(selection);
  } finally {
    history.mockRestore();
  }
  nextEvents.push({ type: 'user', session_id: 'worker', uuid: input.uuid, message: input.message });
  nextEvents.push({
    type: 'assistant',
    session_id: 'worker',
    message: { id: 'successor-assistant', content: [] },
  });
  await vi.waitFor(() => expect(f.afterAssistant).toHaveBeenCalledOnce());
  expect(await f.runtime.steerUser(correction, f.assertCurrent)).toEqual({ status: 'uncertain' });
  expect(f.observedInputs.mock.calls).toEqual([[originalInputId]]);
  await f.finish();
});

it.each(['exact', 'wrong-text', 'foreign-uuid'] as const)(
  'keeps the active ordinary command and successor fenced through a %s peer ACK and the original result',
  async (ack) => {
    const f = await composedFixture();
    await f.runtime.steer(f.message, () => {}, f.session.abortController.signal);
    const input = (await f.inputs.next()).value!;
    f.stream.push({
      type: 'user',
      session_id: 'worker',
      uuid: ack === 'foreign-uuid' ? 'stale-foreign-input' : input.uuid,
      message: ack === 'wrong-text' ? { role: 'user', content: 'Wrong input' } : input.message,
    });
    // This event follows the ACK in the real wrapper/consumer, providing a
    // deterministic barrier without relying on a timer to prove no completion.
    f.stream.push({
      type: 'assistant',
      session_id: 'worker',
      message: { id: 'original-assistant', content: [] },
    });
    await vi.waitFor(() => expect(f.afterAssistant).toHaveBeenCalledOnce());
    expect(f.observedInputs.mock.calls).toEqual([[originalInputId]]);
    expect(f.commands.activeCommandId()).toBe('original');
    expect(f.events.getSession('worker')?.executionPhase).toBe('RUNNING');
    expect(f.ordinaryPush.mock.calls.map(([id]) => id)).toEqual(['original']);
    expect(f.resultIds).toEqual([]);
    expect(f.state().completing).toBe(false);
    expect(f.events.agentCommunication.read('sender', f.message.messageId).status).toBe(
      ack === 'exact' ? 'delivered' : 'uncertain',
    );
    if (ack !== 'exact') {
      expect(await f.runtime.steer(f.message, () => {}, f.session.abortController.signal)).toBe(
        'uncertain',
      );
      expect(f.push).toHaveBeenCalledOnce();
    }
    f.stream.push({
      type: 'result',
      session_id: 'worker',
      uuid: 'original-result',
      is_error: false,
    });
    await vi.waitFor(() => expect(f.resultIds).toHaveLength(1));
    expect(f.resultIds).toEqual([ack === 'foreign-uuid' ? undefined : originalInputId]);
    expect(await f.settlements[0]).toBe(ack === 'foreign-uuid' ? 'refused' : 'completed');
    expect(f.state().completing).toBe(true);
    expect(f.ordinaryPush.mock.calls.map(([id]) => id)).toEqual(
      ack === 'foreign-uuid' ? ['original'] : ['original', 'successor'],
    );
    expect(f.abort).toHaveBeenCalledTimes(ack === 'foreign-uuid' ? 1 : 0);
    await f.finish();
  },
);

it('drops a revoked peer correction at real stdin yield while the original result alone releases its successor', async () => {
  const f = await composedFixture();
  let allowed = true;
  const current = () => {
    if (!allowed) throw Error('Messaging grant revoked');
  };
  await f.runtime.steer(f.message, current, f.session.abortController.signal);
  allowed = false;
  const nextInput = f.inputs.next();
  await vi.waitFor(() =>
    expect(f.events.agentCommunication.read('sender', f.message.messageId)).toMatchObject({
      status: 'failed',
      reason: 'before_provider_submission',
    }),
  );
  expect(f.commands.activeCommandId()).toBe('original');
  expect(f.state().completing).toBe(false);
  expect(f.observedInputs.mock.calls).toEqual([[originalInputId]]);
  expect(f.ordinaryPush.mock.calls.map(([id]) => id)).toEqual(['original']);
  expect(f.resultIds).toEqual([]);
  await expect(
    f.runtime.steer(f.message, current, f.session.abortController.signal),
  ).rejects.toThrow('Messaging grant revoked');
  expect(f.push).toHaveBeenCalledOnce();
  f.stream.push({ type: 'result', session_id: 'worker', uuid: 'original-result', is_error: false });
  await vi.waitFor(() => expect(f.resultIds).toEqual([originalInputId]));
  expect(await f.settlements[0]).toBe('completed');
  expect((await nextInput).value?.uuid).toBe(successorInputId);
  expect(f.abort).not.toHaveBeenCalled();
  await f.finish();
});

it('keeps the original command unsettled and never replays it when recipient authority is revoked before its result', async () => {
  const f = await composedFixture();
  await f.runtime.steer(f.message, () => {}, f.session.abortController.signal);
  const input = (await f.inputs.next()).value!;
  f.stream.push({
    type: 'user',
    session_id: 'worker',
    uuid: input.uuid,
    message: input.message,
  });
  await vi.waitFor(() =>
    expect(f.events.agentCommunication.read('sender', f.message.messageId).status).toBe(
      'delivered',
    ),
  );
  f.assertCurrent.mockImplementation(() => {
    throw Error('Original recipient authority revoked');
  });
  f.stream.push({ type: 'result', session_id: 'worker', uuid: 'original-result', is_error: false });
  await f.finish();
  expect(f.resultIds).toEqual([]);
  expect(f.commands.activeCommandId()).toBe('original');
  expect(f.events.getSession('worker')?.executionPhase).toBe('RUNNING');
  await expect(f.commands.enqueue('original')).rejects.toThrow(
    'Original recipient authority revoked',
  );
  expect(f.ordinaryPush.mock.calls.map(([id]) => id)).toEqual(['original']);
  expect(f.push).toHaveBeenCalledOnce();
  expect(f.abort).toHaveBeenCalledOnce();
});
it('uses priority-now stdin input, and accepts only its exact replay ACK without consuming the original command input or result', async () => {
  const f = fixture();
  const runtime = f.create();
  expect(await runtime.steer(f.message, () => {}, new AbortController().signal)).toBe('uncertain');
  const input = f.push.mock.calls[0][0];
  expect(input).toMatchObject({
    uuid: f.message.messageId,
    priority: 'now',
    message: { content: agentMessagePrompt(f.message) },
  });
  expect(runtime.beforeInput(input)).toBe(true);
  expect(
    runtime.observe({
      type: 'user',
      uuid: 'original-input',
      message: { content: 'Original task' },
    }),
  ).toBe(false);
  expect(runtime.observe({ type: 'user', uuid: f.message.messageId, message: input.message })).toBe(
    true,
  );
  expect(f.events.agentCommunication.read('sender', f.message.messageId).status).toBe('delivered');
  expect(runtime.observe({ type: 'result', uuid: 'original-result' })).toBe(false);
  expect(f.push).toHaveBeenCalledTimes(1);
});
it('refuses a peer input bound to a completing or retired SDK query even while its ordinary command is still active', async () => {
  const f = fixture();
  const runtime = f.create();
  await runtime.steer(f.message, () => {}, new AbortController().signal);
  expect(runtime.beforeInput(f.push.mock.calls[0][0], false)).toBe(false);
  expect(f.events.agentCommunication.read('sender', f.message.messageId)).toMatchObject({
    status: 'failed',
    reason: 'before_provider_submission',
  });
});

it.each(['revoked', 'expired', 'stopped', 'successor'] as const)(
  'refuses %s authority/target at stdin yield and retains positive evidence of no submission',
  async (reason) => {
    const f = fixture();
    const runtime = f.create();
    let allowed = true;
    const current = () => {
      if (!allowed) throw Error(reason);
    };
    await runtime.steer(f.message, current, new AbortController().signal);
    if (reason === 'stopped') f.stop();
    else if (reason === 'successor') f.setActive('successor');
    else allowed = false;
    expect(runtime.beforeInput(f.push.mock.calls[0][0])).toBe(false);
    expect(f.events.agentCommunication.read('sender', f.message.messageId)).toMatchObject({
      status: 'failed',
      reason: 'before_provider_submission',
    });
  },
);

it('leaves a lost ACK uncertain and reconciles the exact retained replay after restart without resending', async () => {
  const f = fixture();
  const runtime = f.create();
  await runtime.steer(f.message, () => {}, new AbortController().signal);
  const input = f.push.mock.calls[0][0];
  runtime.beforeInput(input);
  expect(f.events.agentCommunication.read('sender', f.message.messageId).status).toBe('uncertain');
  f.reopen();
  const restarted = f.create();
  expect(
    restarted.observe({ type: 'user', uuid: f.message.messageId, message: input.message }),
  ).toBe(true);
  expect(f.events.agentCommunication.read('sender', f.message.messageId).status).toBe('delivered');
  expect(f.push).toHaveBeenCalledTimes(1);
});

it('passes peer replay through the SDK adapter and real query consumer without changing original result correlation', async () => {
  const f = fixture();
  let stdin!: AsyncIterable<SDKUserMessage>;
  const events = new AsyncQueue<Record<string, unknown>>();
  vi.mocked(query).mockImplementation((request) => {
    stdin = request.prompt as typeof stdin;
    return {
      close: vi.fn(),
      [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    } as never;
  });
  const controller = new AbortController();
  cleanup.push(() => controller.abort());
  const runtime = f.create();
  const owner = createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
    options: {},
    input: new AsyncQueue<SDKUserMessage>(),
    lifetime: new SdkHookLifetime(),
    sdkSessionId: 'worker',
    cwd: '/task',
    controller,
    authorize: async () => {},
    authorizeSync: () => {},
    adapt: (q) => q as never,
    settings: () => ({}),
    inputChanged: () => {},
    peerMessages: () => runtime,
  });
  f.push.mockImplementation((message) => owner.push(message));
  await runtime.steer(f.message, () => {}, controller.signal);
  const input = (await stdin[Symbol.asyncIterator]().next()).value!;
  const original = {
    type: 'user',
    session_id: 'worker',
    uuid: 'original-input',
    message: { content: 'Original task' },
  };
  events.push(original);
  events.push({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'original-turn' } },
  });
  events.push({
    type: 'user',
    session_id: 'worker',
    uuid: input.uuid,
    message: input.message,
  });
  events.push({ type: 'result', session_id: 'worker', is_error: false });
  const onUserInput = vi.fn();
  const onResult = vi.fn();
  // Stop consuming after the result: the live SDK owner deliberately remains
  // open for a later ordinary command and must not be closed to complete this one.
  const currentTurn = async function* () {
    for await (const event of owner.query) {
      yield event;
      if (event.type === 'result') return;
    }
  };
  await runQueryLoop(
    currentTurn(),
    'operator:worker',
    f.registry,
    controller,
    undefined,
    undefined,
    {
      onUserInput,
      onResult,
    },
  );
  expect(onUserInput).toHaveBeenCalledExactlyOnceWith('operator:worker', 'original-input');
  expect(onResult).toHaveBeenCalledExactlyOnceWith(
    'operator:worker',
    expect.objectContaining({ is_error: false }),
    'original-input',
  );
  expect(f.events.agentCommunication.read('sender', f.message.messageId).status).toBe('delivered');
  expect(f.push).toHaveBeenCalledOnce();
});

it('retains uncertainty for a mismatched ACK instead of contaminating original command correlation', async () => {
  const f = fixture();
  const runtime = f.create();
  await runtime.steer(f.message, () => {}, new AbortController().signal);
  runtime.beforeInput(f.push.mock.calls[0][0]);
  expect(
    runtime.observe({
      type: 'user',
      uuid: f.message.messageId,
      message: { content: 'Different input' },
    }),
  ).toBe(true);
  expect(f.events.agentCommunication.read('sender', f.message.messageId).status).toBe('uncertain');
});

it('uses guarded ordinary admission for idle delivery and never resumes a stopped owner', async () => {
  const f = fixture();
  f.setActive(undefined);
  const runtime = f.create();
  const auth = { id: 'operator', expiresAt: Date.now() + 60_000 };
  expect(await runtime.enqueue(f.message, () => {}, new AbortController().signal, auth)).toBe(
    'queued',
  );
  expect(f.enqueue).toHaveBeenCalledTimes(1);
  expect(f.push).not.toHaveBeenCalled();
  f.stop();
  expect(await runtime.enqueue(f.message, () => {}, new AbortController().signal, auth)).toBe(
    'rejected',
  );
  expect(f.enqueue).toHaveBeenCalledTimes(1);
});
