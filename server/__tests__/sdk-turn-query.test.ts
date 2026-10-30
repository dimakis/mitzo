import { expect, it, vi } from 'vitest';
import { AsyncQueue } from '../async-queue.js';
import { createSdkTurnQuery } from '../sdk-turn-query.js';
import { SdkHookLifetime } from '../ordinary-local-vertex-sdk-query.js';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWebAccessSdkServer } from '../web-access-sdk.js';
import { SessionRegistry } from '@mitzo/harness';
import { EventStore } from '../event-store.js';

function fixture() {
  const inputs = new AsyncQueue<SDKUserMessage>();
  const runs: Array<{
    options: Options;
    events: AsyncQueue<Record<string, unknown>>;
    child: EventEmitter;
    close: ReturnType<typeof vi.fn>;
    interrupt: ReturnType<typeof vi.fn>;
    work: <T>(f: () => Promise<T>) => Promise<T>;
  }> = [];
  let finish!: () => void;
  const permission = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { behavior: 'allow', updatedInput: {} };
  });
  const controller = new AbortController();
  const history = vi.fn(async () => {});
  const unsent = vi.fn();
  let work!: <T>(f: () => Promise<T>) => Promise<T>;
  const create = vi.fn((request: { options: Options; prompt: AsyncIterable<SDKUserMessage> }) => {
    const events = new AsyncQueue<Record<string, unknown>>();
    const child = request.options.spawnClaudeCodeProcess!({
      signal: controller.signal,
    } as never) as unknown as EventEmitter;
    const close = vi.fn(() => {
      events.close();
    });
    const interrupt = vi.fn(async () => {});
    runs.push({ options: request.options, events, child, close, work, interrupt });
    void request.prompt[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    return { close, interrupt, [Symbol.asyncIterator]: () => events[Symbol.asyncIterator]() };
  });
  const q = createSdkTurnQuery<AsyncIterable<Record<string, unknown>>>({
    input: inputs,
    controller,
    lifetime: new SdkHookLifetime(),
    sdkSessionId: 'retained',
    cwd: '/offline',
    authorize: async () => {},
    assertHistory: history,
    onUnsent: unsent,
    options: (state) => {
      work = state.runCallback;
      return {
        resume: 'retained',
        mcpServers: {},
        canUseTool: permission as never,
        spawnClaudeCodeProcess: () => new EventEmitter() as never,
      };
    },
    create: create as never,
    adapt: (query) => query as never,
  });
  const message = (content: string) =>
    inputs.push({ message: { role: 'user', content }, mitzoMessageId: content } as never);
  return {
    q,
    inputs,
    runs,
    message,
    controller,
    create,
    history,
    unsent,
    permission,
    finish: () => finish(),
  };
}
it.each([false, true])(
  'preserves cumulative accounting through successive SDK queries (second failure: %s)',
  async (failed) => {
    const goals = await import('../goal-client.js');
    const report = vi.spyOn(goals, 'reportUsage').mockResolvedValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw Error('Offline accounting test forbids network/model calls');
      }),
    );
    const { runQueryLoop } = await import('../query-loop.js');
    const f = fixture();
    const store = new EventStore(':memory:');
    const registry = new SessionRegistry();
    const sent: Record<string, unknown>[] = [];
    registry.register('sdk-accounting', {
      sessionId: 'retained',
      cwd: '/offline',
      mode: 'agent',
      abortController: f.controller,
      transport: {
        isOpen: () => true,
        send: (event: Record<string, unknown>) => {
          sent.push(event);
        },
      },
    } as never);
    store.upsertSession({ sessionId: 'retained', cwd: '/offline', goalId: 'offline-goal' });
    const first = {
      type: 'result',
      session_id: 'retained',
      uuid: 'first-result',
      is_error: false,
      usage: {
        input_tokens: 1000,
        output_tokens: 300,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 50,
      },
      total_cost_usd: 0.8,
      num_turns: 4,
      duration_ms: 9000,
      duration_api_ms: 7000,
    };
    const second = {
      type: 'result',
      session_id: 'retained',
      uuid: 'second-result',
      is_error: failed,
      subtype: failed ? 'error_max_turns' : 'success',
      errors: failed ? ['Offline maximum reached'] : [],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
      total_cost_usd: 0.1,
      num_turns: 1,
      duration_ms: 1000,
      duration_api_ms: 800,
    };
    f.message('first');
    f.message('second');
    f.runs[0].events.push(first);
    const running = runQueryLoop(f.q, 'sdk-accounting', registry, f.controller, store);
    try {
      await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(f.runs[0].close).toHaveBeenCalledOnce());
      f.runs[0].child.emit('close');
      await vi.waitFor(() => expect(f.runs).toHaveLength(2));
      f.inputs.close();
      f.runs[1].events.push(second);
      await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(f.runs[1].close).toHaveBeenCalledOnce());
      f.runs[1].child.emit('close');
      await running;
      expect(store.getSession('retained')).toMatchObject({
        inputTokens: 1100,
        outputTokens: 320,
        cacheReadTokens: 210,
        cacheCreationTokens: 55,
        numTurns: 5,
        durationMs: 10000,
        durationApiMs: 7800,
      });
      expect(store.getSession('retained')!.totalCostUsd).toBeCloseTo(0.9);
      expect(report.mock.calls[1][1]).toMatchObject({
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        turns: 1,
        durationMs: 1000,
        durationApiMs: 800,
      });
      expect(report.mock.calls[1][1].costUsd).toBeCloseTo(0.1);
      expect(sent.filter((event) => event.type === 'session_end')).toHaveLength(2);
      expect(f.create).toHaveBeenCalledTimes(2);
      expect(second).toMatchObject({ total_cost_usd: 0.1, num_turns: 1 });
    } finally {
      f.controller.abort();
      await running.catch(() => {});
      registry.dispose();
      store.close();
      report.mockRestore();
      vi.unstubAllGlobals();
    }
  },
);
it('resumes the original history only after callbacks, result delivery and actual process close; late first-arriving callbacks keep the original owner', async () => {
  const f = fixture();
  f.message('first');
  const output = f.q[Symbol.asyncIterator]();
  const callback = f.runs[0].options.canUseTool!('Bash', {}, {
    signal: f.controller.signal,
    toolUseID: 'old',
  } as never);
  await vi.waitFor(() => expect(f.permission).toHaveBeenCalledOnce());
  f.message('second');
  f.runs[0].events.push({ type: 'result', session_id: 'retained' });
  const terminal = output.next();
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.create).toHaveBeenCalledOnce();
  f.finish();
  expect(await callback).toMatchObject({ behavior: 'deny' });
  expect((await terminal).value).toMatchObject({ type: 'result' });
  await (f.q as unknown as { interrupt(): Promise<void> }).interrupt();
  await (f.q as unknown as { setPermissionMode(mode: string): Promise<void> }).setPermissionMode(
    'ask',
  );
  await (f.q as unknown as { setModel(model: string): Promise<void> }).setModel('changed-model');
  await (f.q as unknown as { setMaxThinkingTokens(n: number): Promise<void> }).setMaxThinkingTokens(
    1234,
  );
  const next = output.next();
  await vi.waitFor(() => expect(f.runs[0].close).toHaveBeenCalledOnce());
  expect(f.create).toHaveBeenCalledOnce();
  f.runs[0].child.emit('close');
  await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(2));
  expect(f.history).toHaveBeenCalledWith('retained', '/offline');
  expect(f.runs[1].options).toMatchObject({
    resume: 'retained',
    mcpServers: {},
    permissionMode: 'plan',
    model: 'changed-model',
    maxThinkingTokens: 1234,
  });
  expect(f.runs[1].options.sessionId).toBeUndefined();
  await expect(
    f.runs[0].options.canUseTool!('Bash', {}, {
      signal: f.controller.signal,
      toolUseID: 'first-arrives-late',
    } as never),
  ).resolves.toMatchObject({ behavior: 'deny' });
  const effect = vi.fn(async () => true);
  await expect(f.runs[0].work(effect)).rejects.toMatchObject({ code: 'turn_completed' });
  expect(effect).not.toHaveBeenCalled();
  await expect(f.runs[1].work(effect)).resolves.toBe(true);
  const execute = vi.fn(async () => ({ content: 'must not execute', isError: false }));
  const staleServer = createWebAccessSdkServer(
    execute,
    f.controller.signal,
    undefined,
    f.runs[0].work,
  );
  const client = new Client({ name: 'late-original', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await staleServer.instance.connect(a);
  await client.connect(b);
  try {
    expect(
      await client.callTool({
        name: 'RequestWebAccess',
        arguments: { operation: 'search', query: 'fixture', reason: 'fixture' },
      }),
    ).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await staleServer.instance.close();
  }
  f.controller.abort();
  await next;
  expect(f.runs[1].close).toHaveBeenCalledOnce();
});
it('does not create a successor when the original saved history cannot be requalified', async () => {
  const f = fixture();
  f.message('first');
  f.message('second');
  f.history.mockRejectedValue(Error('history unavailable'));
  f.runs[0].events.push({ type: 'result', session_id: 'retained' });
  const output = f.q[Symbol.asyncIterator]();
  await output.next();
  const next = expect(output.next()).rejects.toMatchObject({ code: 'input_not_dispatched' });
  f.runs[0].child.emit('close');
  await next;
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.runs[0].close).toHaveBeenCalledOnce();
  expect(f.unsent).toHaveBeenCalledWith(
    expect.objectContaining({ mitzoMessageId: 'second' }),
    expect.objectContaining({ code: 'input_not_dispatched' }),
  );
});
it('does not deliver a successful result or admit queued input after unknown callback failure', async () => {
  const f = fixture();
  f.message('first');
  f.message('second');
  let reject!: (error: Error) => void;
  const callback = f.runs[0]
    .work(
      () =>
        new Promise<void>((_resolve, no) => {
          reject = no;
        }),
    )
    .catch(() => {});
  f.runs[0].events.push({ type: 'result', session_id: 'retained' });
  const result = expect(f.q[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    code: 'callbacks_failed',
  });
  reject(Error('unknown external effect'));
  await callback;
  await result;
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.history).not.toHaveBeenCalled();
  expect(f.runs[0].close).toHaveBeenCalledOnce();
});
it('closes once on abort during settlement without starting queued input', async () => {
  const f = fixture();
  f.message('first');
  f.message('second');
  void f.runs[0].work(() => new Promise(() => {}));
  f.runs[0].events.push({ type: 'result', session_id: 'retained' });
  const output = f.q[Symbol.asyncIterator]().next();
  const rejected = expect(output).rejects.toBeDefined();
  f.controller.abort();
  await rejected;
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.runs[0].close).toHaveBeenCalledOnce();
});
it('delivers a native failure result once and does not start a queued successor', async () => {
  const f = fixture();
  f.message('first');
  f.message('second');
  f.runs[0].events.push({ type: 'result', session_id: 'retained', is_error: true });
  const output = f.q[Symbol.asyncIterator]();
  expect((await output.next()).value).toMatchObject({ is_error: true });
  expect(await output.next()).toMatchObject({ done: true });
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.history).not.toHaveBeenCalled();
  expect(f.runs[0].close).toHaveBeenCalledOnce();
});
it('interrupts an idle owner without touching its closed native query, then accepts only the new input', async () => {
  const f = fixture();
  f.message('first');
  f.runs[0].events.push({ type: 'result', session_id: 'retained' });
  const output = f.q[Symbol.asyncIterator]();
  await output.next();
  const waiting = output.next();
  await vi.waitFor(() => expect(f.runs[0].close).toHaveBeenCalledOnce());
  f.runs[0].child.emit('close');
  await (f.q as unknown as { interrupt(): Promise<void> }).interrupt();
  expect(f.runs[0].interrupt).not.toHaveBeenCalled();
  f.message('second');
  await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(2));
  f.controller.abort();
  await waiting;
});
it('settles an original active interrupt RPC before retiring its transport', async () => {
  const f = fixture();
  f.message('first');
  let finish!: () => void;
  f.runs[0].interrupt.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const interrupt = (f.q as unknown as { interrupt(): Promise<void> }).interrupt();
  f.runs[0].events.push({ type: 'result', session_id: 'retained' });
  const output = f.q[Symbol.asyncIterator]();
  let delivered = false;
  const terminal = output.next().then((value) => {
    delivered = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(delivered).toBe(false);
  expect(f.runs[0].close).not.toHaveBeenCalled();
  finish();
  await interrupt;
  await terminal;
  f.controller.abort();
  await output.return?.();
});

it('accepts interrupt and settings during callback settlement without borrowing the sealed owner', async () => {
  const f = fixture();
  f.message('first');
  const callback = f.runs[0].options.canUseTool!('Read', {}, {
    signal: f.controller.signal,
    toolUseID: 'pending',
  } as never);
  await vi.waitFor(() => expect(f.permission).toHaveBeenCalledOnce());
  const output = f.q[Symbol.asyncIterator]();
  f.runs[0].events.push({ type: 'result', session_id: 'retained' });
  const terminal = output.next();
  await new Promise((resolve) => setImmediate(resolve));
  const controls = f.q as unknown as {
    interrupt(): Promise<void>;
    setModel(value: string): Promise<void>;
  };
  await expect(controls.interrupt()).resolves.toBeUndefined();
  await controls.setModel('next-model');
  f.message('replacement');
  expect(f.runs[0].interrupt).not.toHaveBeenCalled();
  expect(f.create).toHaveBeenCalledOnce();
  f.finish();
  await callback;
  await terminal;
  const successor = output.next();
  await vi.waitFor(() => expect(f.runs[0].close).toHaveBeenCalledOnce());
  f.runs[0].child.emit('close');
  await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(2));
  expect(f.runs[1].options).toMatchObject({ resume: 'retained', model: 'next-model' });
  f.controller.abort();
  await expect(successor).resolves.toMatchObject({ done: true });
});
