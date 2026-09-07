import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AccountBinding } from '@mitzo/protocol';
import { NativeResponsesStore, NativeResponsesRunner } from '../native-responses-runner.js';

const binding: AccountBinding = {
  accountId: 'personal',
  accountLabel: 'Personal API',
  provider: 'openai',
  model: 'test-model',
  profileRevision: 'ref-digest',
};
function response(tool = false) {
  const output: Record<string, unknown>[] = tool
    ? [
        {
          type: 'function_call',
          call_id: 'call-1',
          name: 'Write',
          arguments: '{"file_path":"note","content":"hello"}',
        },
      ]
    : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }];
  const events = [
    { type: 'response.created', response: { id: 'resp-provider-only', model: 'test-model' } },
    ...(tool
      ? [
          { type: 'response.output_item.added', output_index: 0, item: output[0] },
          {
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            delta: output[0].arguments,
          },
          { type: 'response.output_item.done', output_index: 0, item: output[0] },
        ]
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
});
