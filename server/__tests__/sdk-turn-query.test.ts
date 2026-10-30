import { expect, it, vi } from 'vitest';
import { AsyncQueue } from '../async-queue.js';
import { createSdkTurnQuery } from '../sdk-turn-query.js';
import { SdkHookLifetime } from '../ordinary-local-vertex-sdk-query.js';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWebAccessSdkServer } from '../web-access-sdk.js';

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
  const q = createSdkTurnQuery({
    input: inputs,
    controller,
    lifetime: new SdkHookLifetime(),
    sdkSessionId: 'retained',
    cwd: '/offline',
    authorize: async () => {},
    assertHistory: history,
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
  const message = (content: string) => inputs.push({ message: { role: 'user', content } } as never);
  return {
    q,
    inputs,
    runs,
    message,
    controller,
    create,
    history,
    permission,
    finish: () => finish(),
  };
}
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
  const next = expect(output.next()).rejects.toThrow('history unavailable');
  f.runs[0].child.emit('close');
  await next;
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.runs[0].close).toHaveBeenCalledOnce();
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
