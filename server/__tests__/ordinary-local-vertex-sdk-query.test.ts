import { expect, it, vi } from 'vitest';
import {
  query,
  type Options,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { SessionRuntimeError } from '../session-runtime-error.js';
import { AsyncQueue } from '../async-queue.js';
import { retainCallbackOutcome } from '../turn-callbacks.js';
import {
  createOrdinaryLocalVertexSdkQuery,
  SdkHookLifetime,
} from '../ordinary-local-vertex-sdk-query.js';
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  getSessionInfo: vi.fn(async () => ({ sessionId: 'original', cwd: '/task' })),
  getSessionMessages: vi.fn(async () => [{ uuid: 'input' }]),
}));
it.each([
  { type: 'custom', prompt: 'reviewed instructions', snapshot: true },
  { type: 'custom', prompt: ['reviewed instructions', 'second block'], snapshot: true },
  { type: 'preset', preset: 'claude_code', append: 'reviewed instructions', snapshot: true },
] satisfies NonNullable<Options['systemPrompt']>[])(
  'retains the $type prompt and snapshot while adding native route guidance',
  (systemPrompt) => {
    vi.mocked(query).mockReturnValue({ close: vi.fn() } as never);
    const controller = new AbortController();
    createOrdinaryLocalVertexSdkQuery({
      options: { systemPrompt },
      input: new AsyncQueue(),
      controller,
      lifetime: new SdkHookLifetime(),
      sdkSessionId: 'original',
      cwd: '/task',
      authorize: async () => {},
      authorizeSync: () => {},
      adapt: (native) => native as never,
      settings: () => ({}),
      inputChanged: () => {},
      onUnsent: vi.fn(),
    });
    try {
      const actual = vi.mocked(query).mock.calls.at(-1)![0].options!.systemPrompt;
      expect(actual).toMatchObject({ type: systemPrompt.type, snapshot: true });
      if (!actual || typeof actual !== 'object' || Array.isArray(actual))
        throw Error('Original structured prompt must be retained');
      const contents = actual.type === 'custom' ? actual.prompt : actual.append;
      const text = Array.isArray(contents) ? contents.join('') : contents;
      expect(text).toContain('reviewed instructions');
      expect(text).toContain('This is the selected local Mac Claude SDK route.');
      if (actual.type === 'custom') {
        expect(actual).not.toHaveProperty('append');
        if (Array.isArray(systemPrompt.prompt)) {
          expect(actual.prompt).toEqual([
            ...systemPrompt.prompt,
            expect.stringContaining('This is the selected local Mac Claude SDK route.'),
          ]);
        }
      } else expect(actual.preset).toBe('claude_code');
    } finally {
      controller.abort();
    }
  },
);

it.each([undefined, { still_queued: ['successor-input'] }] satisfies Awaited<
  ReturnType<Query['interrupt']>
>[])(
  'keeps native interrupt receipt %j behind the current query and authority fences',
  async (receipt) => {
    const interrupt = vi.fn(async () => receipt);
    const original = { interrupt, close: vi.fn() };
    const successor = { interrupt: vi.fn(async () => receipt), close: vi.fn() };
    let created = 0;
    vi.mocked(query).mockImplementation(() => (created++ === 0 ? original : successor) as never);
    const controller = new AbortController();
    const owner = createOrdinaryLocalVertexSdkQuery({
      options: {},
      input: new AsyncQueue(),
      controller,
      lifetime: new SdkHookLifetime(),
      sdkSessionId: 'original',
      cwd: '/task',
      authorize: async () => {},
      authorizeSync: () => {},
      adapt: (native) => native as never,
      settings: (selection) => ({ model: selection.model }),
      inputChanged: () => {},
      onUnsent: vi.fn(),
    });
    try {
      await owner.apply({ model: 'original' } as never);
      const target = owner.captureInterruptTarget()!;
      expect(target).toBeDefined();
      expect(await owner.interruptIfCurrent({})).toBe(false);
      expect(interrupt).not.toHaveBeenCalled();
      expect(await owner.interruptIfCurrent(target)).toBe(true);
      expect(interrupt).toHaveBeenCalledOnce();
      expect(interrupt.mock.contexts[0]).toBe(original);
      await owner.apply({ model: 'successor' } as never);
      expect(await owner.interruptIfCurrent(target)).toBe(false);
      expect(interrupt).toHaveBeenCalledOnce();
      const nextTarget = owner.captureInterruptTarget()!;
      expect(nextTarget).toBeDefined();
      controller.abort();
      expect(await owner.interruptIfCurrent(nextTarget)).toBe(false);
      expect(successor.interrupt).not.toHaveBeenCalled();
    } finally {
      controller.abort();
    }
  },
);

it.each(['settled', 'unknown'] as const)(
  'retains an explicitly %s callback outcome that finishes before the native result',
  async (outcome) => {
    const events = new AsyncQueue<Record<string, unknown>>();
    vi.mocked(query).mockImplementation(
      () =>
        ({ close: vi.fn(), [Symbol.asyncIterator]: () => events[Symbol.asyncIterator]() }) as never,
    );
    const controller = new AbortController();
    let tool!: <T>(work: () => Promise<T>) => Promise<T>;
    const owner = createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
      options: { sessionId: 'original' },
      input: new AsyncQueue(),
      lifetime: new SdkHookLifetime(),
      sdkSessionId: 'original',
      cwd: '/task',
      controller,
      authorize: async () => {},
      authorizeSync: () => {},
      adapt: (native) => native as never,
      settings: () => ({}),
      inputChanged: () => {},
      mcpServers: (state) => {
        tool = state.runCallback;
        return {};
      },
      onUnsent: (_message, error) => {
        throw error;
      },
    });
    await tool(async () => retainCallbackOutcome({ isError: true }, outcome));
    await new Promise<void>((resolve) => setImmediate(resolve));
    events.push({ type: 'result', session_id: 'original' });
    const next = owner.query[Symbol.asyncIterator]().next();
    if (outcome === 'unknown')
      await expect(next).rejects.toMatchObject({ code: 'callbacks_failed' });
    else expect((await next).value).toMatchObject({ type: 'result' });
    controller.abort();
    events.close();
  },
);
it.each(['completed', 'retired'])(
  'does not forward late parent input or message events from a %s query into its successor',
  async (phase) => {
    const streams = [
      new AsyncQueue<Record<string, unknown>>(),
      new AsyncQueue<Record<string, unknown>>(),
    ];
    let created = 0;
    vi.mocked(query).mockImplementation(() => {
      const stream = streams[created++];
      return {
        close: vi.fn(),
        [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
      } as never;
    });
    const controller = new AbortController();
    const owner = createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
      options: { sessionId: 'original' },
      input: new AsyncQueue(),
      lifetime: new SdkHookLifetime(),
      sdkSessionId: 'original',
      cwd: '/task',
      controller,
      authorize: async () => {},
      authorizeSync: () => {},
      adapt: (native) => native as never,
      settings: () => ({}),
      inputChanged: () => {},
      onUnsent: (_message, error) => {
        throw error;
      },
    });
    const iterator = owner.query[Symbol.asyncIterator]();
    streams[0].push({ type: 'result', session_id: 'original' });
    expect((await iterator.next()).value).toMatchObject({ type: 'result' });
    await owner.apply({ model: 'first' } as never);
    if (phase === 'retired') await owner.apply({ model: 'second' } as never);
    const next = iterator.next();
    // These callbacks would otherwise be interpreted using the current FIFO
    // command, falsely acknowledging or assigning old output to the successor.
    streams[0].push({ type: 'user', uuid: 'old-input', session_id: 'original' });
    streams[0].push({
      type: 'stream_event',
      event: { type: 'message_start' },
      session_id: 'original',
    });
    streams[0].push({ type: 'result', session_id: 'original' });
    streams[0].close();
    if (phase === 'completed') {
      await owner.apply({ model: 'second' } as never);
    }
    streams[1].push({ type: 'assistant', session_id: 'original', uuid: 'successor-output' });
    expect((await next).value).toMatchObject({ type: 'sdk_query_retired' });
    expect((await iterator.next()).value).toMatchObject({
      type: 'assistant',
      uuid: 'successor-output',
    });
    controller.abort();
    streams[1].close();
    await iterator.return?.();
  },
);
it.each(['current', 'revoked', 'missing_identity', 'async_fence'])(
  'checks exact sharing custody after awaited personal-account renewal, before native input: %s',
  async (scenario) => {
    let prompt!: AsyncIterable<unknown>;
    let release!: () => void;
    let sharingCurrent = true;
    const account = new Promise<void>((resolve) => {
      release = resolve;
    });
    const accountInfo = vi.fn(async () => {
      await account;
      return { email: 'person@example.test', subscriptionType: 'max', apiProvider: 'firstParty' };
    });
    vi.mocked(query).mockImplementation((request) => {
      prompt = request.prompt as AsyncIterable<unknown>;
      return {
        accountInfo,
        close: vi.fn(),
        [Symbol.asyncIterator]: () => new AsyncQueue()[Symbol.asyncIterator](),
      } as never;
    });
    const beforeInput = vi.fn((id: string) => {
      expect(id).toBe('exact-command');
      if (!sharingCurrent) throw Error('Original shared source revoked');
      if (scenario === 'async_fence') return Promise.resolve() as never;
    });
    const sync = vi.fn();
    const controller = new AbortController();
    const input = new AsyncQueue<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>();
    const onUnsent = vi.fn((_message: SDKUserMessage, error: SessionRuntimeError) => {
      expect(controller.signal.aborted).toBe(false);
      expect(error).toMatchObject({ code: 'input_not_dispatched' });
    });
    createOrdinaryLocalVertexSdkQuery({
      options: {
        env: {
          MITZO_CLAUDE_EXPECTED_EMAIL: 'person@example.test',
          MITZO_CLAUDE_EXPECTED_PLAN: 'max',
        },
      },
      input,
      lifetime: new SdkHookLifetime(),
      sdkSessionId: 'original',
      cwd: '/task',
      controller,
      authorize: async () => {},
      authorizeSync: sync,
      beforeInput,
      adapt: (q) => q as never,
      settings: () => ({}),
      inputChanged: () => {},
      onUnsent,
    });
    const message = {
      type: 'user' as const,
      session_id: 'original',
      parent_tool_use_id: null,
      message: { role: 'user' as const, content: 'Exact reviewed private context' },
      ...(scenario === 'missing_identity' ? {} : { mitzoMessageId: 'exact-command' }),
    };
    input.push(message);
    const pending = prompt[Symbol.asyncIterator]().next();
    await vi.waitFor(() => expect(accountInfo).toHaveBeenCalledOnce());
    expect(beforeInput).not.toHaveBeenCalled();
    if (scenario === 'revoked') sharingCurrent = false;
    release();
    if (scenario === 'current') {
      expect((await pending).value).toEqual(message);
      expect(onUnsent).not.toHaveBeenCalled();
    } else {
      await expect(pending).rejects.toMatchObject({ code: 'input_not_dispatched' });
      expect(onUnsent).toHaveBeenCalledOnce();
      expect(onUnsent.mock.calls[0][0]).toBe(message);
      expect(onUnsent.mock.calls[0][1].cause).toMatchObject({
        message: expect.stringContaining(
          scenario === 'revoked'
            ? 'shared source revoked'
            : scenario === 'async_fence'
              ? 'Synchronous ordinary turn authority'
              : 'input command identity',
        ),
      });
      expect(controller.signal.aborted).toBe(true);
    }
    expect(sync).toHaveBeenCalledOnce();
    expect(beforeInput).toHaveBeenCalledTimes(scenario === 'missing_identity' ? 0 : 1);
    input.close();
    controller.abort();
  },
);
it('checks peer input immediately before stdin yield and consumes peer ACKs before ordinary result correlation', async () => {
  let prompt!: AsyncIterable<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>;
  const events = new AsyncQueue<Record<string, unknown>>();
  vi.mocked(query).mockImplementation((request) => {
    prompt = request.prompt as typeof prompt;
    return {
      close: vi.fn(),
      [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    } as never;
  });
  const input = new AsyncQueue<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>();
  const controller = new AbortController();
  const revokedPeerId = '00000000-0000-4000-8000-000000000001';
  const beforeInput = vi.fn((message: { uuid?: string }) => message.uuid !== revokedPeerId);
  const observe = vi.fn(
    (event: Readonly<Record<string, unknown>>) =>
      event.type === 'user' && event.uuid === 'peer-ack',
  );
  const owner = createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
    options: {},
    input,
    controller,
    lifetime: new SdkHookLifetime(),
    sdkSessionId: 'original',
    cwd: '/task',
    authorize: async () => {},
    authorizeSync: () => {},
    adapt: (q) => q as never,
    settings: () => ({}),
    inputChanged: () => {},
    onUnsent: (_message, error) => {
      throw error;
    },
    peerMessages: () => ({ beforeInput, observe }),
  });
  input.push({
    type: 'user',
    uuid: revokedPeerId,
    parent_tool_use_id: null,
    message: { role: 'user', content: 'Must not reach stdin' },
  });
  input.close();
  expect((await prompt[Symbol.asyncIterator]().next()).done).toBe(true);
  expect(beforeInput).toHaveBeenCalledOnce();
  const original = { type: 'user', session_id: 'original', uuid: 'original-input' };
  events.push(original);
  events.push({ type: 'user', session_id: 'original', uuid: 'peer-ack' });
  events.push({ type: 'result', session_id: 'original' });
  const output = owner.query[Symbol.asyncIterator]();
  expect((await output.next()).value).toEqual(original);
  expect((await output.next()).value).toMatchObject({ type: 'result' });
  controller.abort();
});
it.each(['person@example.test', 'other@example.test'])(
  'verifies the running personal SDK account before yielding a prompt: %s',
  async (email) => {
    let prompt!: AsyncIterable<unknown>;
    const events = new AsyncQueue<Record<string, unknown>>();
    const accountInfo = vi.fn(async () => ({
      email,
      subscriptionType: 'Claude Max',
      apiProvider: 'firstParty',
    }));
    vi.mocked(query).mockImplementation((request) => {
      prompt = request.prompt as AsyncIterable<unknown>;
      return {
        accountInfo,
        close: vi.fn(),
        [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
      } as never;
    });
    const input = new AsyncQueue<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>();
    const controller = new AbortController();
    const onUnsent = vi.fn(() => expect(controller.signal.aborted).toBe(false));
    createOrdinaryLocalVertexSdkQuery({
      options: {
        env: {
          MITZO_CLAUDE_EXPECTED_EMAIL: 'person@example.test',
          MITZO_CLAUDE_EXPECTED_PLAN: 'max',
        },
      },
      input,
      lifetime: new SdkHookLifetime(),
      sdkSessionId: 'original',
      cwd: '/task',
      controller,
      authorize: async () => {},
      authorizeSync: () => {},
      adapt: (native) => native as never,
      settings: () => ({}),
      inputChanged: () => {},
      onUnsent,
    });
    input.push({
      type: 'user',
      session_id: 'original',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Private task' },
    });
    const pending = prompt[Symbol.asyncIterator]().next();
    if (email === 'person@example.test') {
      expect((await pending).value).toMatchObject({ type: 'user' });
      expect(onUnsent).not.toHaveBeenCalled();
    } else {
      await expect(pending).rejects.toMatchObject({ code: 'input_not_dispatched' });
      expect(controller.signal.reason.cause.message).toContain('Claude subscription');
      expect(onUnsent).toHaveBeenCalledOnce();
      expect(controller.signal.aborted).toBe(true);
    }
    expect(accountInfo).toHaveBeenCalledTimes(1);
    input.close();
    controller.abort();
  },
);
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
        // The fixture never refuses input, but keeps the required reporter.
        tool = state.runCallback;
        return {};
      },
      onUnsent: vi.fn(),
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
      onUnsent: vi.fn(),
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
      resume: 'original',
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
    onUnsent: vi.fn(),
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
    onUnsent: vi.fn(),
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
    options: { resume: 'original', spawnClaudeCodeProcess: spawn },
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
    onUnsent: vi.fn(),
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
    onUnsent: vi.fn(),
  });
  expect(requests[0].options.systemPrompt).toEqual([
    'Original profile.',
    'Original instructions.',
    expect.stringContaining('gws --help'),
  ]);
  controller.abort();
});
