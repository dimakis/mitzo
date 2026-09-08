import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AccountBinding } from '@mitzo/protocol';
import { SessionRegistry } from '@mitzo/harness';
import { createNativeToolExecutor, nativeToolDefinitions } from '../native-tool-executor.js';
import { NativeResponsesRunner } from '../native-responses-runner.js';
import { NativeResponsesStore } from '../native-responses-store.js';

const binding: AccountBinding = {
  accountId: 'personal',
  accountLabel: 'Personal API',
  provider: 'openai',
  model: 'test-model',
  profileRevision: 'ref-digest',
};
function response(tool: boolean | number = false) {
  const output: Record<string, unknown>[] = tool
    ? Array.from({ length: Number(tool) }, (_, i) => ({
        type: 'function_call',
        call_id: `call-${i + 1}`,
        name: 'Write',
        arguments: '{"file_path":"note","content":"hello"}',
      }))
    : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }];
  const events = [
    { type: 'response.created', response: { id: 'resp-provider-only', model: 'test-model' } },
    ...(tool
      ? output.flatMap((item, output_index) => [
          { type: 'response.output_item.added', output_index, item },
          {
            type: 'response.function_call_arguments.delta',
            output_index,
            delta: item.arguments,
          },
          { type: 'response.output_item.done', output_index, item },
        ])
      : [
          {
            type: 'response.content_part.added',
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text' },
          },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'done' },
          { type: 'response.content_part.done', output_index: 0, content_index: 0 },
        ]),
    {
      type: 'response.completed',
      response: {
        output: [...output, { type: 'reasoning', encrypted_content: 'opaque-continuation' }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
}
async function collect(source: AsyncIterable<unknown>) {
  const events = [];
  for await (const event of source) events.push(event);
  return events;
}

describe('durable native Responses turns', () => {
  let root: string;
  let store: NativeResponsesStore;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mitzo-responses-'));
    store = new NativeResponsesStore(join(root, 'continuation.db'));
    fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response()));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(async () => {
    store.close();
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });
  function runner(
    executeTool = vi
      .fn()
      .mockResolvedValue({ type: 'tool_result', tool_use_id: 'call-1', content: 'written' }),
  ) {
    return new NativeResponsesRunner({
      conversationId: 'app-id',
      binding,
      apiKey: 'test-only-credential',
      systemPrompt: 'boot context and worktree instructions',
      maxTokens: 100,
      store,
      executeTool,
    });
  }
  it('runs and resumes Gemini tool turns with the same durable native tool loop', async () => {
    const googleBinding = { ...binding, provider: 'google-vertex', model: 'gemini-3.8-flash' };
    let turn = 0;
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      const parts =
        turn++ === 0
          ? [
              {
                functionCall: {
                  name: body.tools[0].functionDeclarations[0].name,
                  args: { path: 'note' },
                },
                thoughtSignature: 'private-signature',
              },
            ]
          : [{ text: 'done' }];
      return Response.json({
        candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }],
      });
    });
    const executeTool = vi.fn(async (block) => ({
      type: 'tool_result' as const,
      tool_use_id: block.id,
      content: 'contents',
    }));
    const opts = {
      conversationId: 'gemini-app',
      binding: googleBinding,
      store,
      systemPrompt: 'help',
      maxTokens: 1024,
      tools: [{ name: 'Read', description: 'Read', input_schema: { type: 'object' } }],
      gemini: {
        accountId: binding.accountId,
        projectId: 'work-project',
        region: 'global',
        getAccessToken: async () => 'private-google-token',
      },
      executeTool,
    };
    const events = await collect(new NativeResponsesRunner(opts).run('read note'));
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0][0]).toMatchObject({ name: 'Read', input: { path: 'note' } });
    expect(store.load('gemini-app', googleBinding)?.status).toBe('idle');
    expect(JSON.stringify(events)).not.toContain('private-signature');
    await collect(new NativeResponsesRunner(opts).run('continue'));
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(store.load('gemini-app', googleBinding)?.history.at(-1)?.role).toBe('assistant');
  });
  it('persists tool outcomes before the next request and resumes with opaque reasoning after restart', async () => {
    fetchMock.mockResolvedValueOnce(response(true)).mockResolvedValueOnce(response());
    const execute = vi.fn().mockImplementation(async () => {
      expect(store.load('app-id', binding)?.checkpoint?.history.at(-1)?.role).toBe('assistant');
      return { type: 'tool_result', tool_use_id: 'call-1', content: 'written' };
    });
    const events = await collect(runner(execute).run('write a note'));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'result', session_id: 'app-id' }),
    );
    expect(store.load('app-id', binding)?.status).toBe('idle');
    store.close();
    store = new NativeResponsesStore(join(root, 'continuation.db'));
    await collect(runner().run('follow-up'));
    const request = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(request.instructions).toBe('boot context and worktree instructions');
    expect(request.store).toBe(false);
    expect(request.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call-1',
      output: 'written',
    });
    expect(request.input).toContainEqual({
      type: 'reasoning',
      encrypted_content: 'opaque-continuation',
    });
    expect(
      (await readFile(join(root, 'continuation.db'))).includes(Buffer.from('test-only-credential')),
    ).toBe(false);
    expect((await stat(join(root, 'continuation.db'))).mode & 0o777).toBe(0o600);
  });
  it('rejects changed account, model or credential reference binding before a request', async () => {
    await collect(runner().run('hello'));
    for (const change of [
      { accountId: 'other' },
      { model: 'other' },
      { profileRevision: 'changed' },
      { provider: 'other' },
    ]) {
      expect(() => store.load('app-id', { ...binding, ...change })).toThrow(/binding/i);
      expect(() =>
        store.save('app-id', { ...binding, ...change }, { status: 'idle', history: [] }),
      ).toThrow(/binding/i);
      expect(store.load('app-id', binding)?.history.length).toBeGreaterThan(0);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects concurrent turns and leaves cancelled work explicitly interrupted', async () => {
    fetchMock.mockImplementationOnce(
      (_url, opts) =>
        new Promise((_resolve, reject) =>
          opts.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    const instance = runner();
    const first = collect(instance.run('first'));
    const rejection = expect(first).rejects.toThrow(/interrupt/i);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await expect(collect(runner().run('second'))).rejects.toThrow(/running/i);
    instance.interrupt();
    await rejection;
    expect(store.load('app-id', binding)?.status).toBe('interrupted');
  });
  it('persists a prepared follow-up before its generator is consumed', async () => {
    const instance = runner();
    instance.prepare('message-1', 'durable follow-up');
    expect(store.load('app-id', binding)).toMatchObject({
      status: 'running',
      history: [{ role: 'user', content: 'durable follow-up' }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await collect(instance.run('durable follow-up', undefined, 'message-1'));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.load('app-id', binding)?.status).toBe('idle');
  });
  it('never replays an uncertain side effect after interruption', async () => {
    fetchMock.mockResolvedValueOnce(response(true));
    const execute = vi.fn().mockImplementation(async () => {
      instance.interrupt();
      throw new Error('effect may have occurred');
    });
    const instance = runner(execute);
    await expect(collect(instance.run('write'))).rejects.toThrow(/interrupt/i);
    await collect(runner(execute).run('inspect the result'));
    expect(execute).toHaveBeenCalledTimes(1);
    const request = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(request.input).toContainEqual(
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call-1',
        output: expect.stringMatching(/interrupt|unknown/i),
      }),
    );
  });
  it('marks a crashed running turn interrupted only through explicit startup recovery', async () => {
    store.begin('app-id', binding);
    expect(() => store.begin('app-id', binding)).toThrow(/running/i);
    store.recoverAtStartup();
    expect(store.load('app-id', binding)?.status).toBe('interrupted');
    await collect(runner().run('continue explicitly'));
  });
  it('does not report success after exhausting the tool loop limit', async () => {
    fetchMock.mockResolvedValueOnce(response(true));
    const instance = new NativeResponsesRunner({
      conversationId: 'app-id',
      binding,
      apiKey: 'test-only',
      systemPrompt: '',
      maxTokens: 100,
      maxTurns: 1,
      store,
      executeTool: vi
        .fn()
        .mockResolvedValue({ type: 'tool_result', tool_use_id: 'call-1', content: 'written' }),
    });
    await expect(collect(instance.run('write'))).rejects.toThrow(/limit/i);
    expect(store.load('app-id', binding)?.status).toBe('interrupted');
  });
  it('runs a streamed Responses function call through the real native executor', async () => {
    const registry = new SessionRegistry();
    registry.register('client', {
      cwd: root,
      sessionId: 'app-id',
      mode: 'agent',
      sessionAllowList: new Set(),
      abortController: new AbortController(),
      transport: { send: () => {}, isOpen: () => true },
    });
    fetchMock.mockResolvedValueOnce(response(true)).mockResolvedValueOnce(response());
    try {
      const instance = new NativeResponsesRunner({
        conversationId: 'app-id',
        binding,
        apiKey: 'test-only',
        systemPrompt: 'ContexGin boot payload',
        tools: nativeToolDefinitions,
        maxTokens: 100,
        store,
        executeTool: createNativeToolExecutor('client', registry, { env: {} }),
      });
      await collect(instance.run('write hello'));
      expect(await readFile(join(root, 'note'), 'utf8')).toBe('hello');
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).tools).toContainEqual(
        expect.objectContaining({ name: 'Write' }),
      );
    } finally {
      registry.dispose();
    }
  });
  it('recovers a crash checkpoint with an unanswered function call without replay', async () => {
    fetchMock.mockResolvedValueOnce(response(true));
    const instance = new NativeResponsesRunner({
      conversationId: 'app-id',
      binding,
      apiKey: 'test-only',
      systemPrompt: '',
      maxTokens: 100,
      maxTurns: 1,
      store,
      executeTool: vi
        .fn()
        .mockResolvedValue({ type: 'tool_result', tool_use_id: 'call-1', content: 'written' }),
    });
    await expect(collect(instance.run('write'))).rejects.toThrow(/limit/i);
    const state = store.load('app-id', binding)!;
    // A crash after model persistence but before the tool outcome was committed.
    store.save('app-id', binding, {
      ...state,
      status: 'running',
      history: state.checkpoint!.history,
    });
    store.close();
    store = new NativeResponsesStore(join(root, 'continuation.db'));
    store.recoverAtStartup();
    const execute = vi.fn();
    await collect(runner(execute).run('inspect before retrying'));
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).input).toContainEqual(
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call-1',
        output: expect.stringContaining('Outcome unknown'),
      }),
    );
  });
  it('recovers a partial multi-tool batch without replaying the completed tool', async () => {
    fetchMock.mockResolvedValueOnce(response(2));
    const controller = new AbortController();
    const execute = vi.fn(async () => {
      controller.abort();
      return { type: 'tool_result', tool_use_id: 'call-1', content: 'A persisted' };
    });
    await collect(runner(execute).run('two writes', controller.signal)).catch(() => {});
    expect(execute).toHaveBeenCalledTimes(1);
    const partial = store.load('app-id', binding)!;
    expect(partial.history.at(-1)?.content).toContainEqual(
      expect.objectContaining({ tool_use_id: 'call-1', content: 'A persisted' }),
    );
    // Recreate process loss at this durable boundary, before B has any recorded outcome.
    store.save('app-id', binding, { ...partial, status: 'running' });
    store.close();
    store = new NativeResponsesStore(join(root, 'continuation.db'));
    store.recoverAtStartup();
    const resumedExecute = vi.fn();
    await collect(runner(resumedExecute).run('inspect pending work'));
    expect(resumedExecute).not.toHaveBeenCalled();
    const input = JSON.parse(fetchMock.mock.calls[1][1].body).input;
    expect(input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call-1',
      output: 'A persisted',
    });
    expect(input).toContainEqual(
      expect.objectContaining({
        call_id: 'call-2',
        output: expect.stringContaining('Outcome unknown'),
      }),
    );
  });
  it('stops before side effects if checkpoint persistence fails', async () => {
    fetchMock.mockResolvedValueOnce(response(true));
    const original = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementation((id, account, state) => {
      if (state.checkpoint) throw new Error('disk full');
      original(id, account, state);
    });
    const execute = vi.fn();
    await expect(collect(runner(execute).run('write'))).rejects.toThrow('disk full');
    expect(execute).not.toHaveBeenCalled();
    expect(store.load('app-id', binding)?.status).toBe('running');
    store.recoverAtStartup();
    expect(store.load('app-id', binding)?.status).toBe('interrupted');
  });
  it('preserves the original provider failure when interruption persistence also fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('provider unavailable'));
    const save = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementation((id, account, state) => {
      if (state.status === 'interrupted') throw new Error('database locked');
      save(id, account, state);
    });
    await expect(collect(runner().run('hello'))).rejects.toThrow('provider unavailable');
    expect(store.load('app-id', binding)?.status).toBe('running');
    store.recoverAtStartup();
    expect(store.load('app-id', binding)?.status).toBe('interrupted');
  });
});
