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
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sdk-peer-receipt-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'events.db');
  let events = new EventStore(path);
  cleanup.push(() => events.close());
  events.upsertSession({ sessionId: 'sender' });
  events.upsertSession({ sessionId: 'worker' });
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
  const create = () =>
    new SdkAgentMessageRuntime({
      events,
      session,
      identity,
      operatorAuthSessionId: 'operator',
      assertCurrent,
      activeCommandId: () => active,
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
