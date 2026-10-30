import { expect, it, vi } from 'vitest';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../async-queue.js';
import {
  createOrdinaryLocalVertexSdkQuery,
  SdkHookLifetime,
} from '../ordinary-local-vertex-sdk-query.js';
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  getSessionInfo: vi.fn(async () => ({ sessionId: 'original', cwd: '/task' })),
  getSessionMessages: vi.fn(async () => [{ uuid: 'input' }]),
}));
it.each(['hook', 'permission', 'tool'] as const)(
  'settles an original SDK %s callback before exposing the terminal result',
  async (kind) => {
    const events = new AsyncQueue<Record<string, unknown>>();
    let captured!: Options;
    vi.mocked(query).mockImplementation((request) => {
      captured = request.options!;
      return {
        close: vi.fn(),
        [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
      } as never;
    });
    let finish!: () => void;
    const pending = async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { continue: true };
    };
    let tool!: <T>(operation: () => Promise<T>) => Promise<T>;
    const controller = new AbortController();
    const owner = createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
      options: {
        sessionId: 'original',
        hooks: { PreToolUse: [{ hooks: [pending] }] },
        canUseTool: (async () => {
          await pending();
          return { behavior: 'allow', updatedInput: {} };
        }) as never,
      },
      input: new AsyncQueue(),
      lifetime: new SdkHookLifetime(),
      sdkSessionId: 'original',
      cwd: '/task',
      controller,
      authorize: async () => {},
      authorizeSync: () => {},
      adapt: (q) => q as never,
      settings: () => ({}),
      inputChanged: () => {},
      mcpServers: (state) => {
        tool = state.runCallback;
        return {};
      },
    });
    const callback =
      kind === 'tool'
        ? tool(pending)
        : kind === 'hook'
          ? captured.hooks!.PreToolUse![0].hooks[0]({} as never, 'tool', {
              signal: controller.signal,
            })
          : captured.canUseTool!('Read', {}, {
              signal: controller.signal,
              toolUseID: 'tool',
            } as never);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const iterator = owner.query[Symbol.asyncIterator]();
    events.push({ type: 'result', session_id: 'original' });
    let delivered = false;
    const result = iterator.next().then((event) => {
      delivered = true;
      return event;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(delivered).toBe(false);
    finish();
    const callbackResult = await callback;
    if (kind === 'permission') expect(callbackResult).toMatchObject({ behavior: 'deny' });
    expect((await result).value).toMatchObject({ type: 'result' });
    await expect(tool(pending)).rejects.toThrow('already finished');
    controller.abort();
  },
);
it.each(['hook', 'tool'] as const)(
  'does not expose successful SDK completion after an unknown %s outcome',
  async (kind) => {
    const events = new AsyncQueue<Record<string, unknown>>();
    let captured!: Options;
    vi.mocked(query).mockImplementation((request) => {
      captured = request.options!;
      return {
        close: vi.fn(),
        [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
      } as never;
    });
    let finish!: () => void;
    const work = async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (kind === 'hook') throw Error('private unknown effect');
      return { isError: true, content: 'unknown effect' };
    };
    let tool!: <T>(operation: () => Promise<T>) => Promise<T>;
    const controller = new AbortController();
    const owner = createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
      options: { sessionId: 'original', hooks: { PostToolUse: [{ hooks: [work as never] }] } },
      input: new AsyncQueue(),
      lifetime: new SdkHookLifetime(),
      sdkSessionId: 'original',
      cwd: '/task',
      controller,
      authorize: async () => {},
      authorizeSync: () => {},
      adapt: (q) => q as never,
      settings: () => ({}),
      inputChanged: () => {},
      mcpServers: (state) => {
        tool = state.runCallback;
        return {};
      },
    });
    const callback =
      kind === 'tool'
        ? tool(work)
        : captured.hooks!.PostToolUse![0].hooks[0]({} as never, 'tool', {
            signal: controller.signal,
          });
    const observed = Promise.resolve(callback).catch(() => {});
    await vi.waitFor(() => expect(finish).toBeDefined());
    events.push({ type: 'result', session_id: 'original' });
    const result = owner.query[Symbol.asyncIterator]().next();
    const blocked = expect(result).rejects.toMatchObject({ code: 'callbacks_failed' });
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    await observed;
    await blocked;
    controller.abort();
  },
);

it('retires old native hooks and permissions without executing or aborting the successor owner', async () => {
  const requests: Array<{ options: Options }> = [];
  vi.mocked(query).mockImplementation((request) => {
    requests.push({ options: request.options! });
    return { close: vi.fn(), async *[Symbol.asyncIterator]() {} } as never;
  });
  const controller = new AbortController(),
    lifetime = new SdkHookLifetime();
  const effect = vi.fn(async () => ({ continue: true })),
    permission = vi.fn(async () => ({ behavior: 'allow', updatedInput: {} }));
  const owner = createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
    options: {
      sessionId: 'original',
      extraArgs: { 'offline-existing-flag': null },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Original profile context.' },
      hooks: { PreToolUse: [{ hooks: [effect] }] },
      canUseTool: permission as never,
    },
    input: new AsyncQueue(),
    lifetime,
    sdkSessionId: 'original',
    cwd: '/task',
    controller,
    authorize: async () => {},
    authorizeSync: () => {},
    adapt: (q) => q as never,
    settings: (selection) => ({ model: selection.model, effort: selection.thinking as never }),
    inputChanged: () => {},
  });
  expect(requests[0].options.extraArgs).toEqual({
    'offline-existing-flag': null,
    'replay-user-messages': null,
  });
  expect(requests[0].options.systemPrompt).toMatchObject({
    type: 'preset',
    preset: 'claude_code',
    append: expect.stringContaining('Original profile context.'),
  });
  expect((requests[0].options.systemPrompt as { append: string }).append).toContain('gws --help');
  expect(requests[0].options.tools).toBeUndefined();
  await owner.apply({ model: 'first' } as never);
  await owner.apply({ model: 'second', thinking: 'high' } as never);
  const signal = new AbortController().signal;
  expect(
    await requests[0].options.hooks!.PreToolUse![0].hooks[0]({} as never, 'tool', { signal }),
  ).toMatchObject({ continue: false });
  expect(
    await requests[0].options.canUseTool!('Bash', {}, { signal, toolUseID: 'tool' } as never),
  ).toMatchObject({
    behavior: 'deny',
  });
  expect(effect).not.toHaveBeenCalled();
  expect(permission).not.toHaveBeenCalled();
  expect(controller.signal.aborted).toBe(false);
  await requests[1].options.hooks!.PreToolUse![0].hooks[0]({} as never, 'tool', {
    signal: new AbortController().signal,
  });
  expect(effect).toHaveBeenCalledTimes(1);
  expect(requests[1].options).toMatchObject({
    resume: 'original',
    model: 'second',
    effort: 'high',
  });
  expect(requests[1].options).not.toHaveProperty('sessionId');
  expect(requests[1].options.extraArgs?.['replay-user-messages']).toBeNull();
  controller.abort();
});
it('refuses old native approval completions after retirement even when the SDK reuses an abort signal', async () => {
  const requests: Array<{ options: Options }> = [];
  vi.mocked(query).mockImplementation((request) => {
    requests.push({ options: request.options! });
    return { close: vi.fn(), async *[Symbol.asyncIterator]() {} } as never;
  });
  let release: () => void = () => {};
  const approved = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstHook = true;
  const controller = new AbortController(),
    lifetime = new SdkHookLifetime();
  const hook = vi.fn(async () => {
    if (firstHook) {
      firstHook = false;
      await approved;
    }
    return { continue: true };
  });
  const permission = vi.fn(async () => {
    await approved;
    return { behavior: 'allow', updatedInput: {} };
  });
  const owner = createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
    options: {
      sessionId: 'original',
      hooks: { PreToolUse: [{ hooks: [hook] }] },
      canUseTool: permission as never,
    },
    input: new AsyncQueue(),
    lifetime,
    sdkSessionId: 'original',
    cwd: '/task',
    controller,
    authorize: async () => {},
    authorizeSync: () => {},
    adapt: (q) => q as never,
    settings: (selection) => ({ model: selection.model }),
    inputChanged: () => {},
  });
  await owner.apply({ model: 'first' } as never);
  const sharedSignal = new AbortController().signal;
  const oldHook = requests[0].options.hooks!.PreToolUse![0].hooks[0]({} as never, 'old', {
    signal: sharedSignal,
  });
  const oldPermission = requests[0].options.canUseTool!('Bash', {}, {
    signal: sharedSignal,
    toolUseID: 'old',
  } as never);
  await owner.apply({ model: 'second' } as never);
  await requests[1].options.hooks!.PreToolUse![0].hooks[0]({} as never, 'new', {
    signal: sharedSignal,
  });
  release();
  expect(await oldHook).toMatchObject({ continue: false });
  expect(await oldPermission).toMatchObject({ behavior: 'deny' });
  expect(controller.signal.aborted).toBe(false);
  controller.abort();
});
it('does not replace a native query until its exact spawned process closes and full authority is rechecked', async () => {
  const { EventEmitter } = await import('node:events');
  const processes: InstanceType<typeof EventEmitter>[] = [];
  const requests: Array<{ options: Options }> = [];
  const controller = new AbortController(),
    authorize = vi.fn(async () => {}),
    authorizeSync = vi.fn();
  vi.mocked(query).mockImplementation((request) => {
    requests.push({ options: request.options! });
    request.options!.spawnClaudeCodeProcess!({ signal: controller.signal } as never);
    return { close: vi.fn(), async *[Symbol.asyncIterator]() {} } as never;
  });
  const spawn = vi.fn(() => {
    const process = new EventEmitter();
    processes.push(process);
    return process as never;
  });
  const owner = createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
    options: { sessionId: 'original', spawnClaudeCodeProcess: spawn },
    input: new AsyncQueue(),
    lifetime: new SdkHookLifetime(),
    sdkSessionId: 'original',
    cwd: '/task',
    controller,
    authorize,
    authorizeSync,
    adapt: (q) => q as never,
    settings: (selection) => ({ model: selection.model }),
    inputChanged: () => {},
  });
  await owner.apply({ model: 'first' } as never);
  const replacement = owner.apply({ model: 'second' } as never);
  await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(3));
  expect(requests).toHaveLength(1);
  processes[0].emit('exit', 0, null);
  await Promise.resolve();
  expect(requests).toHaveLength(1);
  const before = authorize.mock.calls.length;
  processes[0].emit('close', 0, null);
  await replacement;
  expect(authorize.mock.calls.length).toBeGreaterThan(before);
  expect(requests).toHaveLength(2);
  expect(requests[1].options).toMatchObject({ resume: 'original', model: 'second' });
  expect(authorizeSync).toHaveBeenCalled();
  controller.abort();
  processes[1].emit('close', 0, null);
});

it('preserves segmented SDK system prompts when appending local CLI guidance', () => {
  const requests: Array<{ options: Options }> = [];
  vi.mocked(query).mockImplementation((request) => {
    requests.push({ options: request.options! });
    return { close: vi.fn(), async *[Symbol.asyncIterator]() {} } as never;
  });
  const controller = new AbortController();
  createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
    options: {
      sessionId: 'original',
      systemPrompt: ['Original profile.', 'Original instructions.'],
    },
    input: new AsyncQueue(),
    lifetime: new SdkHookLifetime(),
    sdkSessionId: 'original',
    cwd: '/task',
    controller,
    authorize: async () => {},
    authorizeSync: () => {},
    adapt: (q) => q as never,
    settings: (selection) => ({ model: selection.model }),
    inputChanged: () => {},
  });
  expect(requests[0].options.systemPrompt).toEqual([
    'Original profile.',
    'Original instructions.',
    expect.stringContaining('gws --help'),
  ]);
  controller.abort();
});
