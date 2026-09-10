import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexConversation } from '../codex-conversation.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
});
async function setup(
  existingStore?: CodexConversationStore,
  displayToolName?: (name: string) => string,
  beforeComplete?: (signal: AbortSignal) => Promise<void>,
  completionHookTimeoutMs?: number,
  verifyBinding?: () => Promise<{
    accountId: string;
    accountLabel: string;
    provider: 'openai';
    model: string;
    profileRevision: string;
  }>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'mitzo-codex-'));
  const store = existingStore ?? new CodexConversationStore(join(dir, 'private.db'));
  let callbacks!: CodexLifecycleTransport;
  let turn = 0;
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const events: Record<string, unknown>[] = [];
  const onClosed = vi.fn();
  const onError = vi.fn();
  const requestUserInput = vi.fn(async () => ({ answers: { q1: { answers: ['Work'] } } }));
  const execute = vi.fn(
    async (_name: string, _input: Record<string, unknown>, _signal: AbortSignal) => ({
      content: 'ok',
      isError: false,
    }),
  );
  const rpc = {
    initialize: async () => {},
    close: vi.fn(),
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === 'config/read') return { config: {} };
      if (method === 'account/read')
        return { account: { type: 'chatgpt', email: 'test@example.com', planType: 'test' } };
      if (method === 'thread/start' || method === 'thread/resume')
        return { thread: { id: 'provider-thread' }, model: 'test-model', modelProvider: 'openai' };
      if (method === 'turn/start') {
        const id = `turn-${++turn}`;
        callbacks.onNotification('turn/started', { threadId: 'provider-thread', turn: { id } });
        return { turn: { id } };
      }
      if (method === 'turn/interrupt') {
        callbacks.onNotification('turn/completed', {
          threadId: 'provider-thread',
          turn: { id: `turn-${turn}`, status: 'interrupted' },
        });
        return {};
      }
      return {};
    }),
  };
  const c = new CodexConversation({
    conversationId: 'app',
    cwd: '/workspace',
    profile: {
      accountId: 'personal',
      accountLabel: 'ChatGPT',
      credentialRef: '/login',
      email: 'test@example.com',
      planType: 'test',
      model: 'test-model',
    },
    store,
    systemPrompt: 'context',
    displayToolName,
    beforeComplete,
    completionHookTimeoutMs,
    verifyBinding,
    tools: [{ name: 'Read', description: 'Read', input_schema: { type: 'object' } }],
    createClient: (cb) => {
      callbacks = cb;
      return rpc;
    },
    emit: (e) => events.push(e),
    onClosed,
    onError,
    validateModel: (model: string) => {
      if (!['test-model', 'other-model'].includes(model)) throw new Error('Model unavailable');
    },
    executeTool: execute,
    requestUserInput,
  });
  cleanup.push(() => {
    c.close();
    if (!existingStore) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await c.initialize();
  return {
    c,
    store,
    callbacks,
    rpc,
    requests,
    events,
    execute,
    onClosed,
    onError,
    requestUserInput,
  };
}
it('runs queued turns sequentially, rechecks account and never uses SDK/provider IDs as application IDs', async () => {
  const { c, callbacks, requests, events } = await setup();
  await c.send({ id: 'a', prompt: 'hello' });
  await c.send({ id: 'b', prompt: 'next' });
  expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: { id: 'turn-1', status: 'completed' },
  });
  await vi.waitFor(() => expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(2));
  expect(requests.filter((r) => r.method === 'account/read')).toHaveLength(3);
  expect(events.find((e) => e.type === 'system')).toMatchObject({ session_id: 'app' });
  await c.send({ id: 'b', prompt: 'next' });
  expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
});
it('uses the injected binding verifier both at startup and before each turn', async () => {
  const verifyBinding = vi.fn(async () => ({
    accountId: 'api',
    accountLabel: 'API',
    provider: 'openai' as const,
    model: 'test-model',
    profileRevision: 'revision',
  }));
  const { c, requests } = await setup(undefined, undefined, undefined, undefined, verifyBinding);
  await c.send({ id: 'a', prompt: 'hello' });
  expect(verifyBinding).toHaveBeenCalledTimes(2);
  expect(requests.filter((r) => r.method === 'account/read')).toHaveLength(0);
  expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
});
it('does not send an empty environments override that disables built-in Codex tools', async () => {
  const { c, requests } = await setup();
  await c.send({ id: 'a', prompt: 'use the shell' });
  const thread = requests.find((request) => request.method === 'thread/start');
  const turn = requests.find((request) => request.method === 'turn/start');
  expect(thread?.params).not.toHaveProperty('environments');
  expect(turn?.params).not.toHaveProperty('environments');
});
it('rejects account changes and unsupported skill ceilings before model execution', async () => {
  const { c, rpc, requests } = await setup();
  await expect(
    c.send({ id: 'skill', prompt: 'restricted', allowedTools: ['Read'] }),
  ).rejects.toThrow('skill');
  rpc.request.mockImplementation(async () => ({
    account: { type: 'chatgpt', email: 'other@example.com', planType: 'test' },
  }));
  await expect(c.send({ id: 'a', prompt: 'hello' })).rejects.toThrow('account');
  expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(0);
});
it('checks thread and turn identity, rejects unknown tools, and executes a duplicate call at most once', async () => {
  const { c, callbacks, execute } = await setup();
  await c.send({ id: 'a', prompt: 'read' });
  const input = {
    threadId: 'provider-thread',
    turnId: 'turn-1',
    callId: 'call',
    namespace: null,
    tool: 'Read',
    arguments: { file_path: 'note' },
  };
  const signal = new AbortController().signal;
  await expect(
    callbacks.onRequest('item/tool/call', { ...input, threadId: 'other' }, signal),
  ).rejects.toThrow('identity');
  await expect(
    callbacks.onRequest('item/tool/call', { ...input, tool: 'Unknown' }, signal),
  ).rejects.toThrow('tool');
  expect(await callbacks.onRequest('item/tool/call', input, signal)).toMatchObject({
    success: true,
  });
  expect(await callbacks.onRequest('item/tool/call', input, signal)).toMatchObject({
    success: false,
  });
  expect(execute).toHaveBeenCalledOnce();
});
it('interrupts the current turn, keeps queued follow-ups paused, and cancels a pending host tool', async () => {
  const { c, callbacks, execute, requests } = await setup();
  await c.send({ id: 'a', prompt: 'read' });
  await c.send({ id: 'b', prompt: 'next' });
  let toolSignal!: AbortSignal;
  execute.mockImplementation((_name, _input, signal) => {
    toolSignal = signal;
    return new Promise((resolve) =>
      signal.addEventListener('abort', () => resolve({ content: 'cancelled', isError: true })),
    );
  });
  const tool = callbacks.onRequest(
    'item/tool/call',
    {
      threadId: 'provider-thread',
      turnId: 'turn-1',
      callId: 'call',
      namespace: null,
      tool: 'Read',
      arguments: {},
    },
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(toolSignal).toBeDefined());
  await c.interrupt();
  await tool;
  expect(toolSignal.aborted).toBe(true);
  expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  expect(c.queue().map((q) => q.status)).toEqual(['interrupted', 'queued']);
});

it('keeps the public conversation open on process loss and resumes through a fresh transport', async () => {
  const { c, callbacks, onClosed, requests } = await setup();
  await c.send({ id: 'a', prompt: 'hello' });
  await c.interrupt();
  expect(c.isPaused()).toBe(true);
  await c.send({ id: 'b', prompt: 'saved until acknowledgement' });
  expect(c.queue().map((q) => q.status)).toEqual(['interrupted', 'queued']);
  callbacks.onClose(new Error('process lost'));
  expect(onClosed).not.toHaveBeenCalled();
  await c.acknowledgeRecovery();
  expect(requests.filter((request) => request.method === 'thread/resume')).toHaveLength(1);
  expect(requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
});

it('pins an allowed model to each queued command while retaining the subscription binding', async () => {
  const { c, callbacks, requests } = await setup();
  await c.send({ id: 'first', prompt: 'one', model: 'test-model' });
  await c.send({ id: 'second', prompt: 'two', model: 'other-model' });
  expect(c.queue().map((q) => q.model)).toEqual(['test-model', 'other-model']);
  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: { id: 'turn-1', status: 'completed' },
  });
  await vi.waitFor(() => expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(2));
  expect(requests.filter((r) => r.method === 'turn/start').map((r) => r.params.model)).toEqual([
    'test-model',
    'other-model',
  ]);
  await expect(c.send({ id: 'bad', prompt: 'no', model: 'unavailable' })).rejects.toThrow(
    'unavailable',
  );
  expect(c.queue()).toHaveLength(2);
});

it('keeps the last selected model for follow-ups that omit a model and deduplicates older retries', async () => {
  const { c } = await setup();
  await c.send({ id: 'first', prompt: 'one' });
  await c.send({ id: 'second', prompt: 'two', model: 'other-model' });
  await c.send({ id: 'third', prompt: 'three' });
  expect(c.queue().map((q) => q.model)).toEqual(['test-model', 'other-model', 'other-model']);
  await c.send({ id: 'first', prompt: 'one' });
  expect(c.queue()).toHaveLength(3);
});

it('retains early completion until the start response confirms its turn identity', async () => {
  const { c, rpc, callbacks } = await setup();
  const request = rpc.request.getMockImplementation()!;
  rpc.request.mockImplementation(async (method, params) => {
    if (method !== 'turn/start') return request(method, params);
    callbacks.onNotification('turn/completed', {
      threadId: 'provider-thread',
      turn: { id: 'early', status: 'completed' },
    });
    return { turn: { id: 'early' } };
  });
  await c.send({ id: 'early-command', prompt: 'hello' });
  expect(c.queue()[0].status).toBe('completed');
});

it('fails safely and recovers queued work after an unconfirmed stale completion', async () => {
  const { c, rpc, callbacks, requests } = await setup();
  const request = rpc.request.getMockImplementation()!;
  let first = true;
  rpc.request.mockImplementation(async (method, params) => {
    if (method !== 'turn/start' || !first) return request(method, params);
    first = false;
    requests.push({ method, params });
    callbacks.onNotification('turn/completed', {
      threadId: 'provider-thread',
      turn: { id: 'stale', status: 'completed' },
    });
    return { turn: { id: 'current' } };
  });
  c.enqueue({ id: 'current-command', prompt: 'hello' });
  c.enqueue({ id: 'next-command', prompt: 'recover me' });
  await expect(c.startQueued()).rejects.toThrow('identity mismatch');
  expect(c.queue().map((command) => command.status)).toEqual(['failed', 'queued']);
  expect(c.isPaused()).toBe(true);
  await c.acknowledgeRecovery();
  expect(requests.filter((entry) => entry.method === 'turn/start')).toHaveLength(2);
});

it('continues queued work only after recovery is explicitly acknowledged', async () => {
  const { c, callbacks, requests } = await setup();
  await c.send({ id: 'first', prompt: 'first' });
  await c.send({ id: 'second', prompt: 'second' });
  await c.interrupt();
  expect(c.isPaused()).toBe(true);
  expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  await c.acknowledgeRecovery();
  expect(c.isPaused()).toBe(false);
  expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: { id: 'turn-2', status: 'completed' },
  });
  expect(c.queue().map((q) => q.status)).toEqual(['interrupted', 'completed']);
});

it('tolerates the transport closing while interrupt is in flight', async () => {
  const { c, rpc } = await setup();
  await c.send({ id: 'first', prompt: 'hello' });
  rpc.request.mockImplementation(async () => {
    c.close();
    throw new Error('connection closed');
  });
  await expect(c.interrupt()).resolves.toBeUndefined();
});

it('resumes durable queued work after replacing the runtime and acknowledging recovery', async () => {
  const old = await setup();
  await old.c.send({ id: 'first', prompt: 'first' });
  await old.c.send({ id: 'next', prompt: 'next' });
  old.c.close();
  const resumed = await setup(old.store);
  expect(resumed.requests.some((r) => r.method === 'thread/resume')).toBe(true);
  expect(resumed.requests.some((r) => r.method === 'turn/start')).toBe(false);
  expect(resumed.c.isPaused()).toBe(true);
  await resumed.c.acknowledgeRecovery();
  expect(resumed.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  resumed.callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: { id: 'turn-1', status: 'completed' },
  });
  expect(resumed.c.queue().map((q) => q.status)).toEqual(['interrupted', 'completed']);
  resumed.c.close();
});

it('interrupts a turn that is created while turn/start is still in flight', async () => {
  const { c, rpc, requests } = await setup();
  const request = rpc.request.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  rpc.request.mockImplementation(async (method, params) => {
    if (method !== 'turn/start') return request(method, params);
    requests.push({ method, params });
    await gate;
    return { turn: { id: 'late-turn' } };
  });
  const send = c.send({ id: 'late', prompt: 'hello' });
  await vi.waitFor(() => expect(requests.some((r) => r.method === 'turn/start')).toBe(true));
  await c.interrupt();
  release();
  await send;
  expect(requests).toContainEqual({
    method: 'turn/interrupt',
    params: { threadId: 'provider-thread', turnId: 'late-turn' },
  });
  expect(c.queue()[0].status).toBe('interrupted');
});

it('drains an early completion when interrupt races with the turn/start response', async () => {
  const { c, rpc, callbacks, requests } = await setup();
  const request = rpc.request.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  rpc.request.mockImplementation(async (method, params) => {
    if (method !== 'turn/start' || !first) return request(method, params);
    first = false;
    requests.push({ method, params });
    callbacks.onNotification('turn/completed', {
      threadId: 'provider-thread',
      turn: { id: 'early-interrupted', status: 'completed' },
    });
    await gate;
    return { turn: { id: 'early-interrupted' } };
  });
  const send = c.send({ id: 'first', prompt: 'hello' });
  await vi.waitFor(() =>
    expect(requests.some((entry) => entry.method === 'turn/start')).toBe(true),
  );
  c.enqueue({ id: 'second', prompt: 'continue later' });
  await c.interrupt();
  release();
  await send;
  await c.acknowledgeRecovery();
  expect(requests.filter((entry) => entry.method === 'turn/start')).toHaveLength(2);
  expect(c.queue().map((command) => command.status)).toEqual(['interrupted', 'running']);
});

it('does not throw from a transport close callback when recovery persistence fails', async () => {
  const { c, callbacks, store, onClosed, onError } = await setup();
  await c.send({ id: 'active', prompt: 'hello' });
  vi.spyOn(store, 'pauseForRecovery').mockImplementation(() => {
    throw new Error('disk unavailable');
  });
  expect(() => callbacks.onClose(new Error('transport lost'))).not.toThrow();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk unavailable' }));
  expect(onClosed).not.toHaveBeenCalled();
});

it('marks failed provider turns as errors and pauses the queue', async () => {
  const { c, callbacks, events, onError } = await setup();
  await c.send({ id: 'failed', prompt: 'hello' });
  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: { id: 'turn-1', status: 'failed' },
  });
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'result', session_id: 'app', is_error: true }),
  );
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Codex turn failed' }));
  expect(c.isPaused()).toBe(true);
});

it('uses canonical display names while executing the original wire tool', async () => {
  const { c, callbacks, events, execute } = await setup(undefined, () => 'mcp__work__read');
  await c.send({ id: 'read', prompt: 'read' });
  await callbacks.onRequest(
    'item/tool/call',
    { threadId: 'provider-thread', turnId: 'turn-1', callId: 'tool', tool: 'Read', arguments: {} },
    new AbortController().signal,
  );
  expect(execute).toHaveBeenCalledWith('Read', {}, expect.anything());
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'stream_event',
      event: expect.objectContaining({
        content_block: expect.objectContaining({ name: 'mcp__work__read' }),
      }),
    }),
  );
});

it('routes native user input with active thread/turn identity and abort lifetime', async () => {
  const { c, callbacks, requestUserInput } = await setup();
  await c.send({ id: 'question', prompt: 'ask' });
  const params = {
    threadId: 'provider-thread',
    turnId: 'turn-1',
    itemId: 'question-1',
    isBlocking: true,
    autoResolutionMs: null,
    questions: [
      {
        id: 'q1',
        header: 'Account',
        question: 'Which account?',
        isSecret: false,
        isOther: false,
        options: [{ label: 'Work', description: 'Work account' }],
      },
    ],
  };
  const response = await callbacks.onRequest(
    'item/tool/requestUserInput',
    params,
    new AbortController().signal,
  );
  expect(response).toEqual({ answers: { q1: { answers: ['Work'] } } });
  expect(requestUserInput).toHaveBeenCalledWith(params, expect.any(AbortSignal));
  await expect(
    callbacks.onRequest(
      'item/tool/requestUserInput',
      { ...params, turnId: 'other' },
      new AbortController().signal,
    ),
  ).rejects.toThrow('identity');
  expect(requestUserInput).toHaveBeenCalledTimes(1);
});

it('waits for completion hooks before releasing queued turns', async () => {
  let release!: () => void;
  const hook = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { c, callbacks, requests } = await setup(undefined, undefined, () => hook);
  await c.send({ id: 'first', prompt: 'first' });
  await c.send({ id: 'second', prompt: 'second' });
  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: { id: 'turn-1', status: 'completed' },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  release();
  await vi.waitFor(() => expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(2));
});

it('closes and reports a completion hook that exceeds its deadline', async () => {
  let hookSignal!: AbortSignal;
  const { c, callbacks, onClosed, onError } = await setup(
    undefined,
    undefined,
    (signal) => {
      hookSignal = signal;
      return new Promise(() => {});
    },
    5,
  );
  await c.send({ id: 'first', prompt: 'first' });
  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: { id: 'turn-1', status: 'completed' },
  });
  await vi.waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
  expect(hookSignal.aborted).toBe(true);
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
  expect(c.queue()[0].status).toBe('interrupted');
});

it('does not report a late turn-start failure after close owns recovery', async () => {
  const { c, rpc, requests, onClosed, onError } = await setup();
  const request = rpc.request.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  rpc.request.mockImplementation(async (method, params) => {
    if (method !== 'turn/start') return request(method, params);
    requests.push({ method, params });
    await gate;
    throw new Error('late start failure');
  });
  const send = c.send({ id: 'first', prompt: 'first' });
  await vi.waitFor(() =>
    expect(requests.some((entry) => entry.method === 'turn/start')).toBe(true),
  );
  c.close();
  release();
  await expect(send).resolves.toBeUndefined();
  expect(onClosed).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
  expect(c.queue()[0].status).toBe('interrupted');
});

it('persists the selected reasoning effort and sends it to Codex', async () => {
  const { c, requests } = await setup();
  await c.send({ id: 'effort', prompt: 'Think carefully', reasoningEffort: 'high' });
  expect(c.queue()[0].reasoningEffort).toBe('high');
  expect(requests.find((r) => r.method === 'turn/start')?.params.effort).toBe('high');
});
it('sends attached images as native image input and retains them for recovery', async () => {
  const { c, requests } = await setup();
  const images = [{ data: 'aGVsbG8=', mediaType: 'image/png' }];
  await c.send({ id: 'image', prompt: 'Describe this', images });
  expect(c.queue()[0].images).toEqual(images);
  expect(requests.find((r) => r.method === 'turn/start')?.params.input).toEqual([
    { type: 'text', text: 'Describe this' },
    { type: 'image', url: 'data:image/png;base64,aGVsbG8=' },
  ]);
});
it('does not force low thinking when the client leaves it at the model default', async () => {
  const { c, requests } = await setup();
  await c.send({ id: 'default-effort', prompt: 'Hello' });
  expect(requests.find((r) => r.method === 'turn/start')?.params).not.toHaveProperty('effort');
});
it('rejects unsupported image types before persisting or starting work', async () => {
  const { c, requests } = await setup();
  expect(() =>
    c.enqueue({
      id: 'invalid-image',
      prompt: 'Describe',
      images: [{ data: 'aGVsbG8=', mediaType: 'image/svg+xml' }],
    }),
  ).toThrow();
  expect(c.queue()).toEqual([]);
  expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
});
