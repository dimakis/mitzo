import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexConversation, codexTurnFailureDiagnostic } from '../codex-conversation.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
import type { AccountBinding } from '@mitzo/protocol';
import { CodexRequestError } from '../codex-app-server-client.js';
import { tracer } from '../tracing.js';
import type { Span } from '@opentelemetry/api';
const cleanup: (() => void)[] = [];
const binding = {
  accountId: 'personal',
  accountLabel: 'ChatGPT',
  provider: 'openai' as const,
  model: 'test-model',
  profileRevision: 'chatgpt:test@example.com:test',
};
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.splice(0).forEach((f) => f());
});

it.each([
  ['completed', 'completed', 'none'],
  ['interrupted', 'interrupted', 'none'],
  ['failed', 'failed', 'provider'],
] as const)(
  'traces a subscription turn through %s exactly once',
  async (_case, status, failure) => {
    const span = { setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() };
    const start = vi.spyOn(tracer, 'startSpan').mockReturnValue(span as unknown as Span);
    const { c, callbacks } = await setup();
    await c.send({ id: 'traced', prompt: 'private text must stay out of spans' });
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0][0]).toBe('codex.turn');
    expect(span.end).not.toHaveBeenCalled();
    const notification = {
      threadId: 'provider-thread',
      turn: {
        id: 'turn-1',
        status,
        ...(status === 'failed' ? { error: { message: 'secret diagnostic' } } : {}),
      },
    };
    callbacks.onNotification('turn/completed', notification);
    callbacks.onNotification('turn/completed', notification);
    expect(span.end).toHaveBeenCalledOnce();
    expect(span.setAttribute).toHaveBeenCalledWith('mitzo.route', 'chatgpt-subscription');
    expect(span.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'test-model');
    expect(span.setAttribute).toHaveBeenCalledWith('mitzo.turn.status', status);
    expect(span.setAttribute).toHaveBeenCalledWith('mitzo.failure.category', failure);
    expect(JSON.stringify(span.setAttribute.mock.calls)).not.toContain('secret diagnostic');
    c.close();
    expect(span.end).toHaveBeenCalledOnce();
  },
);

it.each(['transport', 'close'] as const)('ends a subscription span on %s loss', async (loss) => {
  const span = { setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() };
  vi.spyOn(tracer, 'startSpan').mockReturnValue(span as unknown as Span);
  const { c, callbacks } = await setup();
  await c.send({ id: 'traced', prompt: 'hello' });
  if (loss === 'transport') callbacks.onClose(new Error('private transport detail'));
  else c.close();
  expect(span.end).toHaveBeenCalledOnce();
  expect(span.setAttribute).toHaveBeenCalledWith('mitzo.failure.category', loss);
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
  beforeReconnect?: () => Promise<void>,
  onActivity?: () => boolean,
  prepareTurn?: (
    turn: { providerPrompt: string; userIntent?: string; turnId: string },
    signal: AbortSignal,
  ) => Promise<string | void>,
  onProviderDispatch?: (commandId: string) => void,
  onProviderComplete?: (commandId: string, status: 'completed' | 'interrupted' | 'failed') => void,
) {
  const dir = mkdtempSync(join(tmpdir(), 'mitzo-codex-'));
  const store = existingStore ?? new CodexConversationStore(join(dir, 'private.db'));
  let callbacks!: CodexLifecycleTransport;
  let turn = 0;
  let threadStarts = 0;
  let threadGeneration = 0;
  let providerThread = 'provider-thread';
  const providerTurns = new Map<string, string>();
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
    initialize: vi.fn(async () => {}),
    close: vi.fn(),
    request: vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      requests.push({ method, params });
      if (method === 'config/read') return { config: {} };
      if (method === 'account/read')
        return { account: { type: 'chatgpt', email: 'test@example.com', planType: 'test' } };
      if (method === 'thread/turns/list')
        return {
          data: [...providerTurns].reverse().map(([id, status]) => ({ id, status, items: [] })),
          nextCursor: null,
        };
      if (method === 'thread/fork') {
        providerThread = `provider-thread-fork-${++threadGeneration}`;
        return { thread: { id: providerThread }, model: 'test-model', modelProvider: 'openai' };
      }
      if (method === 'thread/start') {
        if (threadStarts++) providerThread = `provider-thread-reset-${++threadGeneration}`;
        return { thread: { id: providerThread }, model: 'test-model', modelProvider: 'openai' };
      }
      if (method === 'thread/resume')
        return { thread: { id: providerThread }, model: 'test-model', modelProvider: 'openai' };
      if (method === 'turn/start') {
        const id = `turn-${++turn}`;
        callbacks.onNotification('turn/started', { threadId: providerThread, turn: { id } });
        return { turn: { id } };
      }
      if (method === 'turn/interrupt') {
        callbacks.onNotification('turn/completed', {
          threadId: providerThread,
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
    getMode: () => 'agent',
    webSearchDeploymentRevision: 'test-deployment-1',
    systemPrompt: 'context',
    displayToolName,
    beforeComplete,
    completionHookTimeoutMs,
    beforeReconnect,
    prepareTurn,
    onProviderDispatch,
    onProviderComplete,
    loadConversationHistory: () => [
      { role: 'user', text: 'Keep the existing workstream.' },
      { role: 'assistant', text: 'The workstream is active.' },
    ],
    onActivity,
    verifyBinding,
    tools: [{ name: 'Read', description: 'Read', input_schema: { type: 'object' } }],
    createClient: (cb) => {
      callbacks = {
        ...cb,
        onNotification: (method, params) => {
          if (method === 'turn/completed') {
            const completed = params.turn as { id?: unknown; status?: unknown } | undefined;
            if (typeof completed?.id === 'string' && typeof completed.status === 'string')
              providerTurns.set(completed.id, completed.status);
          }
          cb.onNotification(method, params);
        },
      };
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
    getBinding: () => (c as unknown as { binding: AccountBinding }).binding,
    getProviderThread: () => providerThread,
  };
}

it('preserves prior conversation text once when refreshing a stale tool surface', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mitzo-codex-stale-tools-'));
  const store = new CodexConversationStore(join(dir, 'private.db'));
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.create('app', binding, '/workspace');
  store.bindThread('app', binding, 'legacy-provider-thread');
  store.setWebSearchGrant('app', binding, 0, 'denied', 123);

  const first = await setup(store, undefined, undefined, undefined, async () => binding);

  expect(first.requests.filter(({ method }) => method === 'thread/resume')).toHaveLength(0);
  expect(first.requests.filter(({ method }) => method === 'thread/start')).toHaveLength(1);
  expect(first.requests.find(({ method }) => method === 'thread/start')?.params).toMatchObject({
    dynamicTools: [expect.objectContaining({ name: 'Read' })],
    config: { web_search: 'disabled' },
  });
  expect(store.read('app', binding)).toMatchObject({
    threadId: 'provider-thread',
    threadGeneration: 1,
    toolSurfaceRevision: expect.any(String),
    rolloverContext: expect.stringContaining('Keep the existing workstream.'),
  });

  // The handoff is durable across a server restart before the next user turn.
  first.c.close();
  const resumed = await setup(store, undefined, undefined, undefined, async () => binding);
  await resumed.c.send({ id: 'after-rollover', prompt: 'Continue.' });
  const firstTurn = resumed.requests.find(({ method }) => method === 'turn/start');
  expect(firstTurn?.params.additionalContext).toEqual({
    'mitzo.tool-surface-rollover': {
      kind: 'untrusted',
      value: expect.stringContaining('The workstream is active.'),
    },
  });
  expect(
    first.requests.some(
      ({ method, params }) => method === 'thread/turns/list' && params.itemsView === 'full',
    ),
  ).toBe(false);
  expect(store.read('app', binding).rolloverContext).toContain('Keep the existing workstream.');

  resumed.callbacks.onNotification('turn/completed', {
    threadId: resumed.getProviderThread(),
    turn: { id: 'turn-1', status: 'completed' },
  });
  expect(store.read('app', binding).rolloverContext).toBeNull();
  await resumed.c.send({ id: 'second-after-rollover', prompt: 'Again.' });
  const turns = resumed.requests.filter(({ method }) => method === 'turn/start');
  expect(turns).toHaveLength(2);
  expect(turns[1].params).not.toHaveProperty('additionalContext');
});

it('retains rollover context when the first replacement-thread turn fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mitzo-codex-rollover-failure-'));
  const store = new CodexConversationStore(join(dir, 'private.db'));
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.create('app', binding, '/workspace');
  store.bindThread('app', binding, 'legacy-provider-thread');
  const first = await setup(store, undefined, undefined, undefined, async () => binding);
  first.c.close();
  const resumed = await setup(store, undefined, undefined, undefined, async () => binding);

  await resumed.c.send({ id: 'first-after-rollover', prompt: 'Continue.' });
  expect(resumed.requests.find(({ method }) => method === 'turn/start')?.params).toHaveProperty(
    'additionalContext',
  );
  resumed.callbacks.onNotification('turn/completed', {
    threadId: resumed.getProviderThread(),
    turn: { id: 'turn-1', status: 'failed', error: { message: 'provider stream failed' } },
  });

  expect(store.read('app', binding).rolloverContext).toContain('Keep the existing workstream.');
  resumed.c.close();
});

it('reports the durable command boundary around provider dispatch', async () => {
  const onProviderDispatch = vi.fn();
  const onProviderComplete = vi.fn();
  const { c, callbacks } = await setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    onProviderDispatch,
    onProviderComplete,
  );

  await c.send({ id: 'closeout-command', prompt: 'close safely' });
  expect(onProviderDispatch).toHaveBeenCalledWith('closeout-command');
  expect(onProviderComplete).not.toHaveBeenCalled();

  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: { id: 'turn-1', status: 'completed' },
  });
  expect(onProviderComplete).toHaveBeenCalledWith('closeout-command', 'completed');
});

it('marks a dispatched command ambiguous when its transport is lost', async () => {
  const onProviderDispatch = vi.fn();
  const onProviderComplete = vi.fn();
  const { c, callbacks } = await setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    onProviderDispatch,
    onProviderComplete,
  );

  await c.send({ id: 'closeout-command', prompt: 'close safely' });
  callbacks.onClose(new Error('transport lost'));

  expect(onProviderDispatch).toHaveBeenCalledWith('closeout-command');
  expect(onProviderComplete).toHaveBeenCalledWith('closeout-command', 'failed');
  expect(c.queue()).toMatchObject([{ id: 'closeout-command', status: 'failed' }]);
  await expect(c.retryLatestFailed()).resolves.toBe('confirmation_required');
});

it('keeps an explicit interrupt ambiguous when transport loss occurs before completion', async () => {
  const onProviderComplete = vi.fn();
  const { c, callbacks, rpc } = await setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    onProviderComplete,
  );
  const request = rpc.request.getMockImplementation()!;
  rpc.request.mockImplementation(async (method, params) => {
    if (method === 'turn/interrupt') {
      callbacks.onClose(new Error('transport lost after explicit interrupt'));
      return {};
    }
    return request(method, params);
  });

  await c.send({ id: 'closeout-command', prompt: 'close safely' });
  await c.interrupt();

  expect(onProviderComplete).toHaveBeenCalledWith('closeout-command', 'failed');
  expect(c.queue()).toMatchObject([{ id: 'closeout-command', status: 'failed' }]);
  await expect(c.retryLatestFailed()).resolves.toBe('confirmation_required');
});

it('marks active work ambiguous when forced shutdown closes the runtime', async () => {
  const onProviderComplete = vi.fn();
  const { c, store, getBinding } = await setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    onProviderComplete,
  );

  await c.send({ id: 'closeout-command', prompt: 'close safely' });
  c.close();

  expect(onProviderComplete).toHaveBeenCalledWith('closeout-command', 'failed');
  expect(c.queue()).toMatchObject([{ id: 'closeout-command', status: 'failed' }]);
  expect(store.retryLatestFailed('app', getBinding())).toBe('confirmation_required');
});
it('does not persist queued work when lifecycle admission is fenced', async () => {
  const onActivity = vi.fn(() => false);
  const { c } = await setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    onActivity,
  );
  expect(() => c.enqueue({ id: 'fenced', prompt: 'wait' })).toThrow('lifecycle mutation');
  expect(onActivity).toHaveBeenCalledOnce();
  expect(c.queue()).toEqual([]);
});
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
it('prepares a turn from its raw user intent before sending its provider prompt', async () => {
  const prepareTurn = vi.fn(
    async (turn: { providerPrompt: string }) => `prepared: ${turn.providerPrompt}`,
  );
  const { c, requests } = await setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    prepareTurn,
  );
  await c.send({ id: 'a', prompt: 'context\nsearch Gmail', intent: 'write a summary' });
  expect(prepareTurn).toHaveBeenCalledWith(
    { providerPrompt: 'context\nsearch Gmail', userIntent: 'write a summary', turnId: 'a' },
    expect.any(AbortSignal),
  );
  expect(requests.find((request) => request.method === 'turn/start')?.params.input).toEqual([
    { type: 'text', text: 'prepared: context\nsearch Gmail' },
  ]);
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
  expect(thread?.params).toMatchObject({ config: { web_search: 'disabled' } });
});
it('applies explicit web-search consent by reopening the idle thread', async () => {
  const { c, requests, rpc } = await setup();
  await expect(c.setWebSearchGrant(0, 'allowed')).resolves.toMatchObject({
    grant: 'allowed',
    revision: 1,
  });
  expect(rpc.close).toHaveBeenCalledTimes(1);
  expect(requests.filter(({ method }) => method === 'thread/resume').at(-1)?.params).toMatchObject({
    threadId: 'provider-thread',
    config: { web_search: 'live' },
  });
  expect(() => c.assertPermissionModeChange('agent')).not.toThrow();
  expect(() => c.assertPermissionModeChange('ask')).toThrow('start a new conversation');
  await expect(c.setWebSearchGrant(1, 'denied')).resolves.toMatchObject({
    grant: 'denied',
    revision: 2,
  });
  expect(requests.filter(({ method }) => method === 'thread/resume').at(-1)?.params).toMatchObject({
    config: { web_search: 'disabled' },
  });
});
it('rejects stale or mid-turn web-search consent without reopening the thread', async () => {
  const { c, rpc } = await setup();
  await expect(c.setWebSearchGrant(1, 'allowed')).rejects.toThrow('concurrently');
  expect(rpc.close).not.toHaveBeenCalled();
  await c.send({ id: 'active', prompt: 'keep working' });
  await expect(c.setWebSearchGrant(0, 'allowed')).rejects.toThrow('between turns');
  expect(rpc.close).not.toHaveBeenCalled();
});
it('recovers after consent persistence fails following transport retirement', async () => {
  const { c, store, rpc, requests, getBinding } = await setup();
  vi.spyOn(store, 'setWebSearchGrant').mockImplementationOnce(() => {
    throw new Error('persistence failed');
  });
  await expect(c.setWebSearchGrant(0, 'allowed')).rejects.toThrow('persistence failed');
  expect(c.isPaused()).toBe(true);
  expect(store.readWebSearchGrant('app', getBinding()).grant).toBe('unresolved');
  await c.send({ id: 'after-failure', prompt: 'continue' });
  expect(c.isPaused()).toBe(false);
  expect(requests.filter(({ method }) => method === 'thread/resume').at(-1)?.params).toMatchObject({
    config: { web_search: 'disabled' },
  });
  expect(rpc.initialize).toHaveBeenCalledTimes(2);
});
it.each(['initialize', 'resume'] as const)(
  'recovers after consent %s fails with a persisted denial',
  async (failure) => {
    const { c, rpc, requests, store, getBinding } = await setup();
    await c.setWebSearchGrant(0, 'allowed');
    if (failure === 'initialize') {
      rpc.initialize.mockRejectedValueOnce(new Error('reopen failed'));
    } else {
      const originalRequest = rpc.request.getMockImplementation()!;
      let failed = false;
      rpc.request.mockImplementation(async (method, params) => {
        if (method === 'thread/resume' && !failed) {
          failed = true;
          throw new Error('reopen failed');
        }
        return originalRequest(method, params);
      });
    }
    await expect(c.setWebSearchGrant(1, 'denied')).rejects.toThrow('reopen failed');
    expect(c.isPaused()).toBe(true);
    expect(store.readWebSearchGrant('app', getBinding())).toMatchObject({
      grant: 'denied',
      revision: 2,
    });
    await c.send({ id: `after-${failure}`, prompt: 'continue' });
    expect(c.isPaused()).toBe(false);
    expect(
      requests.filter(({ method }) => method === 'thread/resume').at(-1)?.params,
    ).toMatchObject({
      config: { web_search: 'disabled' },
    });
  },
);
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

it('treats a new send as recovery acknowledgement, reconnects, resumes queued FIFO work, and skips interrupted work', async () => {
  const { c, callbacks, requests } = await setup();
  await c.send({ id: 'a', prompt: 'hello' });
  c.enqueue({ id: 'b', prompt: 'already sent' });
  callbacks.onClose(new Error('process lost'));
  expect(c.isPaused()).toBe(true);
  await c.send({ id: 'c', prompt: 'send now' });

  expect(requests.filter((request) => request.method === 'thread/resume')).toHaveLength(1);
  expect(requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
  expect(requests.filter((request) => request.method === 'turn/start')[1].params.input).toEqual([
    { type: 'text', text: 'already sent' },
  ]);
  expect(c.queue().map((q) => q.status)).toEqual(['failed', 'running', 'queued']);
  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: { id: 'turn-2', status: 'completed' },
  });
  await vi.waitFor(() =>
    expect(requests.filter((request) => request.method === 'turn/start')).toHaveLength(3),
  );
  expect(requests.filter((request) => request.method === 'turn/start')[2].params.input).toEqual([
    { type: 'text', text: 'send now' },
  ]);
});

it('retains the event mapper across same-thread reconnect so replayed reasoning is not duplicated', async () => {
  const { c, callbacks, rpc, events } = await setup();
  await c.send({ id: 'a', prompt: 'hello' });
  const started = {
    threadId: 'provider-thread',
    item: { type: 'reasoning', id: 'reasoning-1' },
  };
  callbacks.onNotification('item/started', started);
  callbacks.onNotification('item/reasoning/summaryTextDelta', {
    threadId: 'provider-thread',
    itemId: 'reasoning-1',
    summaryIndex: 0,
    delta: 'Checked ',
  });

  const request = rpc.request.getMockImplementation()!;
  rpc.request.mockImplementation(async (method, params) => {
    if (method === 'thread/resume') {
      callbacks.onNotification('item/started', started);
      callbacks.onNotification('item/reasoning/summaryTextDelta', {
        threadId: 'provider-thread',
        itemId: 'reasoning-1',
        summaryIndex: 0,
        delta: 'Checked ',
      });
      callbacks.onNotification('item/completed', {
        threadId: 'provider-thread',
        item: { type: 'reasoning', id: 'reasoning-1', summary: ['Checked the file'] },
      });
    }
    return request(method, params);
  });

  callbacks.onClose(new Error('process lost'));
  await c.send({ id: 'b', prompt: 'continue' });

  expect(events.filter((event) => event.type === 'assistant')).toEqual([
    expect.objectContaining({
      message: { content: [{ type: 'thinking', thinking: 'Checked the file' }] },
    }),
  ]);
  expect(
    events
      .filter((event) => event.type === 'stream_event')
      .map((event) => event.event as { type: string; delta?: { thinking?: string } })
      .filter((event) => event.type === 'content_block_delta')
      .map((event) => event.delta?.thinking),
  ).toEqual(['Checked ', 'the file']);
});

it('recovers an idle dead transport before persisting the explicit send', async () => {
  const beforeReconnect = vi.fn(async () => {});
  const { c, callbacks, rpc, requests } = await setup(
    undefined,
    undefined,
    undefined,
    undefined,
    async () => binding,
    beforeReconnect,
  );
  const request = rpc.request.getMockImplementation()!;
  let failProbe = true;
  rpc.request.mockImplementation(async (method, params) => {
    if (method === 'config/read' && failProbe) {
      failProbe = false;
      callbacks.onClose(new Error('idle relay broke on first write'));
      throw new Error('connection closed');
    }
    return request(method, params);
  });

  const onEnqueued = vi.fn(() => {
    expect(c.queue().map((command) => command.status)).toEqual(['queued']);
    expect(beforeReconnect).not.toHaveBeenCalled();
  });
  await c.send({ id: 'after-idle', prompt: 'continue' }, onEnqueued);

  expect(onEnqueued).toHaveBeenCalledOnce();
  expect(requests.filter((request) => request.method === 'thread/resume')).toHaveLength(1);
  expect(requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
  expect(beforeReconnect).toHaveBeenCalledOnce();
  expect(c.queue().map((command) => command.status)).toEqual(['running']);
  expect(c.isPaused()).toBe(false);
});

it('does not persist an explicit send cancelled during its transport probe', async () => {
  const beforeReconnect = vi.fn(async () => {});
  const { c, rpc } = await setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    beforeReconnect,
  );
  const request = rpc.request.getMockImplementation()!;
  let releaseProbe!: () => void;
  const probeBlocked = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  let blockNextProbe = true;
  rpc.request.mockImplementation(async (method, params) => {
    if (method === 'config/read' && blockNextProbe) {
      blockNextProbe = false;
      await probeBlocked;
    }
    return request(method, params);
  });

  const controller = new AbortController();
  const admission = c.admitExplicitSend(
    { id: 'cancelled', prompt: 'do not persist this' },
    controller.signal,
  );
  await vi.waitFor(() =>
    expect(rpc.request.mock.calls.some(([method]) => method === 'config/read')).toBe(true),
  );

  controller.abort();
  await expect(admission).rejects.toMatchObject({ name: 'AbortError' });
  await expect(c.admitExplicitSend({ id: 'next', prompt: 'admit immediately' })).resolves.toEqual({
    model: 'test-model',
    reasoningEffort: undefined,
  });
  expect(c.queue().map((command) => command.id)).toEqual(['next']);
  releaseProbe();
});

it('reconnects an interrupted turn without replaying it when no later command is queued', async () => {
  const { c, callbacks, requests } = await setup();
  await c.send({ id: 'a', prompt: 'hello' });
  callbacks.onClose(new Error('process lost'));

  expect(c.queue().map((command) => command.status)).toEqual(['failed']);
  await c.acknowledgeRecovery();

  expect(requests.filter((request) => request.method === 'thread/resume')).toHaveLength(1);
  expect(requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
  expect(c.isPaused()).toBe(false);
});

it('reports workspace startup only until reconnect completes, not through the new turn', async () => {
  let release!: () => void;
  const beforeReconnect = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const { c, callbacks } = await setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    beforeReconnect,
  );
  await c.send({ id: 'first', prompt: 'first' });
  callbacks.onClose(new Error('process lost'));
  const send = c.send({ id: 'next', prompt: 'next' });
  await vi.waitFor(() => expect(c.getRecoveryPhase()).toBe('starting_workspace'));
  expect(c.isRecovering()).toBe(true);
  release();
  await send;
  expect(c.isRecovering()).toBe(false);
  expect(c.getRecoveryPhase()).toBeUndefined();
});

it('treats transport loss during turn startup as paused recovery instead of a fatal send', async () => {
  const { c, callbacks, onClosed, rpc, requests } = await setup();
  const request = rpc.request.getMockImplementation()!;
  let rejectPending!: (error: Error) => void;
  let first = true;
  rpc.request.mockImplementation(async (method, params) => {
    if (method !== 'turn/start' || !first) return request(method, params);
    first = false;
    requests.push({ method, params });
    return new Promise((_, reject) => {
      rejectPending = reject;
    });
  });

  const send = c.send({ id: 'pending-start', prompt: 'hello' });
  await vi.waitFor(() => expect(requests.some((r) => r.method === 'turn/start')).toBe(true));
  c.enqueue({ id: 'after-recovery', prompt: 'continue safely' });
  callbacks.onClose(new Error('transport lost during turn/start'));
  rejectPending(new Error('old transport request failed'));

  await expect(send).resolves.toBeUndefined();
  expect(c.isPaused()).toBe(true);
  expect(onClosed).not.toHaveBeenCalled();
  expect(c.queue().map((command) => command.status)).toEqual(['failed', 'queued']);

  await c.acknowledgeRecovery();
  expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
});

it('re-establishes the external sandbox before recreating a recovery transport', async () => {
  const beforeReconnect = vi.fn(async () => {});
  const { c, callbacks } = await setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    beforeReconnect,
  );
  callbacks.onClose(new Error('sandbox stopped'));
  await c.acknowledgeRecovery();
  expect(beforeReconnect).toHaveBeenCalledOnce();
});

it('shares one reconnect across concurrent recovery acknowledgements', async () => {
  let release!: () => void;
  const beforeReconnect = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const { c, callbacks, requests } = await setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    beforeReconnect,
  );
  callbacks.onClose(new Error('sandbox stopped'));

  const first = c.acknowledgeRecovery();
  const second = c.acknowledgeRecovery();
  await vi.waitFor(() => expect(beforeReconnect).toHaveBeenCalledOnce());
  release();
  await Promise.all([first, second]);

  expect(requests.filter((request) => request.method === 'thread/resume')).toHaveLength(1);
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

it('serializes rapid model-selection admission against the durable queue', async () => {
  const { c, rpc } = await setup();
  const request = rpc.request.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstProbe = true;
  rpc.request.mockImplementation(async (method, params) => {
    if (method === 'config/read' && firstProbe) {
      firstProbe = false;
      await gate;
    }
    return request(method, params);
  });

  const first = c.admitExplicitSend({
    id: 'model-switch',
    prompt: 'switch',
    model: 'other-model',
    reasoningEffort: 'high',
  });
  const second = c.admitExplicitSend({
    id: 'model-follow-up',
    prompt: 'continue',
    model: 'other-model',
  });
  release();

  await Promise.all([first, second]);
  expect(c.queue().map(({ model, reasoningEffort }) => ({ model, reasoningEffort }))).toEqual([
    { model: 'other-model', reasoningEffort: 'high' },
    { model: 'other-model', reasoningEffort: undefined },
  ]);
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

it('does not reconnect or replay interrupted work until a new send explicitly requests recovery', async () => {
  const { c, callbacks, requests } = await setup();
  await c.send({ id: 'first', prompt: 'first' });
  callbacks.onClose(new Error('process lost'));
  expect(c.isPaused()).toBe(true);
  expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  expect(requests.filter((r) => r.method === 'thread/resume')).toHaveLength(0);
  await c.send({ id: 'second', prompt: 'second' });
  expect(c.isPaused()).toBe(false);
  expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: { id: 'turn-2', status: 'completed' },
  });
  expect(c.queue().map((q) => q.status)).toEqual(['failed', 'completed']);
});

it('restarts a disconnected provider and runs an already queued follow-up exactly once', async () => {
  const beforeReconnect = vi.fn(async () => {});
  const { c, callbacks, requests, rpc } = await setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    beforeReconnect,
  );
  await c.send({ id: 'failed-turn', prompt: 'first' });
  await c.send({ id: 'saved-follow-up', prompt: 'second' });

  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: {
      id: 'turn-1',
      status: 'failed',
      error: { message: 'stream disconnected before completion' },
    },
  });

  await vi.waitFor(() =>
    expect(requests.filter((request) => request.method === 'turn/start')).toHaveLength(2),
  );
  expect(beforeReconnect).toHaveBeenCalledOnce();
  expect(rpc.close).toHaveBeenCalledOnce();
  expect(c.isPaused()).toBe(false);
  expect(c.queue().map(({ id, status }) => ({ id, status }))).toEqual([
    { id: 'failed-turn', status: 'failed' },
    { id: 'saved-follow-up', status: 'running' },
  ]);
  expect(
    requests.filter((request) => request.method === 'turn/start').map((request) => request.params),
  ).toEqual([
    expect.objectContaining({ input: [{ type: 'text', text: 'first' }] }),
    expect.objectContaining({ input: [{ type: 'text', text: 'second' }] }),
  ]);
});

it('moves an old conversation to a new thread generation before accepting the next turn', async () => {
  const beforeReconnect = vi.fn(async () => {});
  const { c, callbacks, requests, rpc, store, getProviderThread } = await setup(
    undefined,
    undefined,
    undefined,
    undefined,
    async () => binding,
    beforeReconnect,
  );
  store.setWebSearchGrant('app', binding, 0, 'denied', 123);
  await c.send({ id: 'good', prompt: 'establish context' });
  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: { id: 'turn-1', status: 'completed' },
  });
  await c.send({ id: 'poisoned', prompt: 'partly execute tools' });
  callbacks.onNotification('turn/completed', {
    threadId: getProviderThread(),
    turn: {
      id: 'turn-2',
      status: 'failed',
      error: { message: 'stream disconnected before completion' },
    },
  });

  expect(store.read('app', binding)).toMatchObject({
    threadId: 'provider-thread',
    threadGeneration: 0,
    lastCompletedTurnId: 'turn-1',
    recoveryStrategy: 'fork',
  });

  await c.send({ id: 'after-rollover', prompt: 'continue safely' });

  expect(beforeReconnect).toHaveBeenCalledOnce();
  expect(rpc.close).toHaveBeenCalledOnce();
  expect(requests.find((request) => request.method === 'thread/fork')?.params).toMatchObject({
    threadId: 'provider-thread',
    lastTurnId: 'turn-1',
    config: { web_search: 'disabled' },
  });
  expect(store.read('app', binding)).toMatchObject({
    threadId: 'provider-thread-fork-1',
    threadGeneration: 1,
    lastCompletedTurnId: 'turn-1',
    recoveryStrategy: 'resume',
  });
  expect(
    requests.filter((request) => request.method === 'turn/start').map((request) => request.params),
  ).toEqual([
    expect.objectContaining({ input: [{ type: 'text', text: 'establish context' }] }),
    expect.objectContaining({ input: [{ type: 'text', text: 'partly execute tools' }] }),
    expect.objectContaining({
      threadId: 'provider-thread-fork-1',
      input: [{ type: 'text', text: 'continue safely' }],
    }),
  ]);
  expect(c.queue().map(({ id, status }) => ({ id, status }))).toEqual([
    { id: 'good', status: 'completed' },
    { id: 'poisoned', status: 'failed' },
    { id: 'after-rollover', status: 'running' },
  ]);
});

it('forks from the provider latest completion when the durable ledger missed its notification', async () => {
  const { c, callbacks, rpc, requests, store } = await setup(
    undefined,
    undefined,
    undefined,
    undefined,
    async () => binding,
    async () => {},
  );
  await c.send({ id: 'persisted', prompt: 'persist this completion' });
  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: { id: 'turn-1', status: 'completed' },
  });
  await c.send({ id: 'failed', prompt: 'trigger recovery' });
  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: {
      id: 'turn-2',
      status: 'failed',
      error: { message: 'stream disconnected before completion' },
    },
  });
  const request = rpc.request.getMockImplementation()!;
  rpc.request.mockImplementation(async (method, params) => {
    const result = await request(method, params);
    if (method !== 'thread/turns/list') return result;
    if (!params.cursor)
      return {
        data: [
          { id: 'turn-2', status: 'failed' },
          { id: 'newer-incomplete-turn', status: 'interrupted' },
        ],
        nextCursor: 'older-page',
      };
    return {
      data: [
        { id: 'provider-only-completion', status: 'completed' },
        { id: 'turn-1', status: 'completed' },
      ],
      nextCursor: null,
    };
  });

  await c.send({ id: 'after-rollover', prompt: 'continue from provider truth' });

  expect(requests.find(({ method }) => method === 'thread/fork')?.params).toMatchObject({
    threadId: 'provider-thread',
    lastTurnId: 'provider-only-completion',
    excludeTurns: true,
  });
  expect(requests.filter(({ method }) => method === 'thread/turns/list')).toEqual([
    {
      method: 'thread/turns/list',
      params: {
        threadId: 'provider-thread',
        limit: 64,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      },
    },
    {
      method: 'thread/turns/list',
      params: {
        threadId: 'provider-thread',
        limit: 64,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
        cursor: 'older-page',
      },
    },
  ]);
  expect(requests.some(({ method }) => method === 'thread/read')).toBe(false);
  expect(store.read('app', binding)).toMatchObject({
    threadId: 'provider-thread-fork-1',
    lastCompletedTurnId: 'provider-only-completion',
  });
});

it('replaces provider thread state after a rejected turn admission', async () => {
  const beforeReconnect = vi.fn(async () => {});
  const { c, rpc, requests, store } = await setup(
    undefined,
    undefined,
    undefined,
    undefined,
    async () => binding,
    beforeReconnect,
  );
  const request = rpc.request.getMockImplementation()!;
  let rejectTurn = true;
  rpc.request.mockImplementation(async (method, params) => {
    if (method === 'turn/start' && rejectTurn) {
      rejectTurn = false;
      throw new CodexRequestError('turn/start', 'thread_state', -32000);
    }
    return request(method, params);
  });

  await expect(c.send({ id: 'rejected', prompt: 'first' })).rejects.toBeInstanceOf(
    CodexRequestError,
  );
  expect(store.read('app', binding).recoveryStrategy).toBe('fork');

  await c.send({ id: 'after-rejection', prompt: 'continue' });

  expect(beforeReconnect).toHaveBeenCalledOnce();
  expect(requests.filter(({ method }) => method === 'thread/turns/list')).toHaveLength(1);
  expect(store.read('app', binding)).toMatchObject({
    threadId: 'provider-thread-reset-1',
    threadGeneration: 1,
    recoveryStrategy: 'resume',
  });
  expect(requests.filter(({ method }) => method === 'thread/start')[1]?.params).toMatchObject({
    dynamicTools: [
      {
        type: 'function',
        name: 'Read',
        description: 'Read',
        inputSchema: { type: 'object' },
      },
    ],
  });
  expect(c.queue().map(({ id, status }) => ({ id, status }))).toEqual([
    { id: 'rejected', status: 'failed' },
    { id: 'after-rejection', status: 'running' },
  ]);
});

it('automatically probes only one saved follow-up during a persistent provider outage', async () => {
  const beforeReconnect = vi.fn(async () => {});
  const { c, callbacks, requests, rpc, getProviderThread } = await setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    beforeReconnect,
  );
  await c.send({ id: 'first', prompt: 'first' });
  await c.send({ id: 'probe', prompt: 'second' });
  await c.send({ id: 'preserved', prompt: 'third' });

  callbacks.onNotification('turn/completed', {
    threadId: getProviderThread(),
    turn: {
      id: 'turn-1',
      status: 'failed',
      error: { message: 'stream disconnected before completion' },
    },
  });
  await vi.waitFor(() =>
    expect(requests.filter((request) => request.method === 'turn/start')).toHaveLength(2),
  );

  callbacks.onNotification('turn/completed', {
    threadId: getProviderThread(),
    turn: {
      id: 'turn-2',
      status: 'failed',
      error: { message: 'stream disconnected before completion' },
    },
  });
  await Promise.resolve();

  expect(beforeReconnect).toHaveBeenCalledOnce();
  expect(rpc.close).toHaveBeenCalledTimes(2);
  expect(requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
  expect(requests.filter((request) => request.method === 'thread/resume')).toHaveLength(0);
  expect(c.isPaused()).toBe(true);
  expect(c.queue().map(({ id, status }) => ({ id, status }))).toEqual([
    { id: 'first', status: 'failed' },
    { id: 'probe', status: 'failed' },
    { id: 'preserved', status: 'queued' },
  ]);

  await c.acknowledgeRecovery();
  expect(beforeReconnect).toHaveBeenCalledTimes(2);
  expect(requests.filter((request) => request.method === 'thread/resume')).toHaveLength(0);
  expect(requests.filter((request) => request.method === 'turn/start')).toHaveLength(3);
  expect(c.isPaused()).toBe(false);
  expect(c.queue().map(({ id, status }) => ({ id, status }))).toEqual([
    { id: 'first', status: 'failed' },
    { id: 'probe', status: 'failed' },
    { id: 'preserved', status: 'running' },
  ]);
});

it('keeps non-transport provider failures paused for explicit review', async () => {
  const { c, callbacks, requests, rpc } = await setup();
  await c.send({ id: 'failed-turn', prompt: 'first' });
  await c.send({ id: 'saved-follow-up', prompt: 'second' });

  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: {
      id: 'turn-1',
      status: 'failed',
      error: { message: 'context_length_exceeded' },
    },
  });
  await Promise.resolve();

  expect(rpc.close).not.toHaveBeenCalled();
  expect(requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
  expect(c.isPaused()).toBe(true);
  expect(c.queue().map((command) => command.status)).toEqual(['failed', 'queued']);
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
  old.store.setWebSearchGrant('app', old.getBinding(), 0, 'allowed', 123);
  await old.c.send({ id: 'first', prompt: 'first' });
  await old.c.send({ id: 'next', prompt: 'next' });
  old.c.close();
  const resumed = await setup(old.store);
  expect(resumed.requests.some((r) => r.method === 'thread/resume')).toBe(true);
  expect(resumed.requests.find((r) => r.method === 'thread/resume')?.params).toMatchObject({
    config: { web_search: 'live' },
  });
  expect(resumed.requests.find((r) => r.method === 'thread/resume')?.params).not.toHaveProperty(
    'dynamicTools',
  );
  expect(resumed.requests.some((r) => r.method === 'turn/start')).toBe(false);
  expect(resumed.c.isPaused()).toBe(true);
  await resumed.c.acknowledgeRecovery();
  expect(resumed.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  resumed.callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: { id: 'turn-1', status: 'completed' },
  });
  expect(resumed.c.queue().map((q) => q.status)).toEqual(['failed', 'completed']);
  resumed.c.close();
});

it('interrupts a turn that is created while turn/start is still in flight', async () => {
  const { c, callbacks, rpc, requests } = await setup();
  const request = rpc.request.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  rpc.request.mockImplementation(async (method, params) => {
    if (method === 'turn/interrupt') {
      requests.push({ method, params });
      callbacks.onNotification('turn/completed', {
        threadId: 'provider-thread',
        turn: { id: 'late-turn', status: 'interrupted' },
      });
      return {};
    }
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
  expect(c.queue().map((command) => command.status)).toEqual(['completed', 'running']);
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

it('marks failed provider turns as errors without exposing provider diagnostics', async () => {
  const { c, callbacks, events, onError } = await setup();
  await c.send({ id: 'failed', prompt: 'hello' });
  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: {
      id: 'turn-1',
      status: 'failed',
      error: { message: 'request failed for /private/credentials.json?token=secret' },
    },
  });
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'result', session_id: 'app', is_error: true }),
  );
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'The provider did not complete the turn.' }),
  );
  expect(c.isPaused()).toBe(true);
});

it('attaches a sanitized typed failure to a failed provider result', async () => {
  const { c, callbacks, events, onError } = await setup();
  await c.send({ id: 'overloaded', prompt: 'hello' });
  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: {
      id: 'turn-1',
      status: 'failed',
      error: {
        message: 'We are experiencing high demand. Bearer sk-secret https://private.example',
        type: 'service_unavailable_error',
        code: 'server_is_overloaded',
        retry_after: 9,
      },
    },
  });

  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'result',
      session_id: 'app',
      is_error: true,
      provider_failure: {
        category: 'overloaded',
        code: 'server_is_overloaded',
        retryable: true,
        ambiguous: true,
        attempt: 1,
        correlationId: 'turn-1',
        retryAfterMs: 9_000,
        message:
          'OpenAI is temporarily overloaded. This turn is saved and can be retried when capacity is available.',
      },
    }),
  );
  expect(onError.mock.calls[0]?.[0]).toMatchObject({
    failure: expect.objectContaining({ category: 'overloaded', correlationId: 'turn-1' }),
  });
  expect(await c.retryLatestFailed()).toBe('too_early');
  expect(JSON.stringify(events)).not.toContain('sk-secret');
  expect(JSON.stringify(events)).not.toContain('private.example');
});

it('retries the saved failed command only after an explicit request', async () => {
  const { c, callbacks, requests, events } = await setup();
  await c.send({ id: 'retry-me', prompt: 'hello' });
  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: {
      id: 'turn-1',
      status: 'failed',
      error: { message: 'high demand', code: 'server_is_overloaded' },
    },
  });
  expect(requests.filter(({ method }) => method === 'turn/start')).toHaveLength(1);

  expect(await c.retryLatestFailed(true)).toBe('queued');

  expect(requests.filter(({ method }) => method === 'turn/start')).toHaveLength(2);
  expect(c.queue().find(({ id }) => id === 'retry-me')?.status).toBe('running');
  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: {
      id: 'turn-2',
      status: 'failed',
      error: { message: 'high demand', code: 'server_is_overloaded' },
    },
  });
  expect(events.at(-1)).toMatchObject({ provider_failure: { attempt: 2 } });
});

it('maps known failed-turn provider diagnostics without exposing provider payloads', () => {
  expect(
    codexTurnFailureDiagnostic({
      message: 'POST request body credential traffic denied for api.openai.com:443',
    }),
  ).toBe(
    'OpenShell denied the provider request because its credential-bearing body could not be inspected.',
  );
  expect(codexTurnFailureDiagnostic({ message: 'stream disconnected before completion' })).toBe(
    'The provider stream disconnected before completion.',
  );
  expect(
    codexTurnFailureDiagnostic({ message: 'Bearer sk-secret at https://private.example' }),
  ).toBe('The provider did not complete the turn.');
});

it('uses canonical display names while executing the original wire tool', async () => {
  const { c, callbacks, events, execute } = await setup(undefined, () => 'mcp__work__read');
  await c.send({ id: 'read', prompt: 'read' });
  await callbacks.onRequest(
    'item/tool/call',
    { threadId: 'provider-thread', turnId: 'turn-1', callId: 'tool', tool: 'Read', arguments: {} },
    new AbortController().signal,
  );
  expect(execute).toHaveBeenCalledWith(
    'Read',
    {},
    expect.anything(),
    expect.objectContaining({ turnId: 'turn-1', callId: 'tool' }),
  );
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
  expect(c.queue()[0].status).toBe('failed');
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
  expect(c.queue()[0].status).toBe('failed');
});

it('persists the selected reasoning effort and sends it to Codex', async () => {
  const { c, requests } = await setup();
  await c.send({ id: 'effort', prompt: 'Think carefully', reasoningEffort: 'high' });
  expect(c.queue()[0].reasoningEffort).toBe('high');
  expect(requests.find((r) => r.method === 'turn/start')?.params.effort).toBe('high');
});
it('persists an explicit model-default reset and omits the Codex effort override', async () => {
  const { c, requests } = await setup();
  await c.send({ id: 'default', prompt: 'Use the model default', reasoningEffort: null });
  expect(c.queue().at(-1)?.reasoningEffort).toBeNull();
  expect(requests.find((r) => r.method === 'turn/start')?.params).not.toHaveProperty('effort');
});
it('clears a stale thinking override when switching to a model without an effort selection', async () => {
  const { c } = await setup();
  await c.send({ id: 'effort', prompt: 'Think carefully', reasoningEffort: 'high' });
  await c.send({ id: 'other-model', prompt: 'Switch models', model: 'other-model' });

  expect(c.queue().at(-1)?.model).toBe('other-model');
  expect(c.queue().at(-1)?.reasoningEffort).toBeNull();
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
