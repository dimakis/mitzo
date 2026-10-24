import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AccountBinding } from '@mitzo/protocol';
import { NativeResponsesRunner } from '../native-responses-runner.js';
import { NativeResponsesStore } from '../native-responses-store.js';
const binding: AccountBinding = {
  accountId: 'personal',
  accountLabel: 'Deferred Gemini',
  provider: 'google-vertex',
  model: 'gemini-3.8-flash',
  profileRevision: 'ref-digest',
};
const gemini = {
  accountId: binding.accountId,
  projectId: 'fixture-project',
  region: 'global',
  getAccessToken: async () => 'private-google-token',
};
const toolName = `tool_${createHash('sha256').update('Write').digest('hex').slice(0, 40)}`;
function response(tools = 0) {
  return Response.json({
    responseId: 'fixture-provider-id',
    candidates: [
      {
        finishReason: 'STOP',
        content: {
          role: 'model',
          parts: tools
            ? Array.from({ length: tools }, (_, i) => ({
                functionCall: {
                  name: toolName,
                  args: { file_path: `note-${i}`, content: 'hello' },
                },
                thoughtSignature: 'private-signed-part',
              }))
            : [{ text: 'done' }],
        },
      },
    ],
  });
}
async function collect(source: AsyncIterable<unknown>) {
  const events = [];
  for await (const event of source) events.push(event);
  return events;
}
describe('deferred Gemini durable compatibility', () => {
  let root: string;
  let store: NativeResponsesStore;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mitzo-gemini-'));
    store = new NativeResponsesStore(join(root, 'continuation.db'));
    fetchMock = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(async () => {
    store.close();
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });
  const options = () => ({
    conversationId: 'app-id',
    binding,
    gemini,
    store,
    systemPrompt: 'Pinned execution context',
    maxTokens: 100,
    tools: [{ name: 'Write', description: 'Write fixture', input_schema: { type: 'object' } }],
    executeTool: vi.fn(async (block: import('@mitzo/harness').ToolUseBlock) => ({
      type: 'tool_result' as const,
      tool_use_id: block.id,
      content: 'written',
    })),
  });
  it('persists signed history and tool outcomes before another request, without exposing credentials', async () => {
    fetchMock.mockResolvedValueOnce(response(1));
    const opts = options();
    opts.executeTool.mockImplementationOnce(async (block) => {
      expect(store.load('app-id', binding)?.checkpoint?.history.at(-1)?.role).toBe('assistant');
      return { type: 'tool_result', tool_use_id: block.id, content: 'written' };
    });
    const events = await collect(new NativeResponsesRunner(opts).run('write'));
    expect(opts.executeTool).toHaveBeenCalledOnce();
    expect(store.load('app-id', binding)?.status).toBe('idle');
    expect(JSON.stringify(events)).not.toContain('private-signed-part');
    store.close();
    store = new NativeResponsesStore(join(root, 'continuation.db'));
    await collect(new NativeResponsesRunner(options()).run('inspect'));
    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
    expect(JSON.stringify(body.contents)).toContain('private-signed-part');
    expect(JSON.stringify(body.contents)).toContain('written');
    expect(
      (await readFile(join(root, 'continuation.db'))).includes(Buffer.from('private-google-token')),
    ).toBe(false);
    expect((await stat(join(root, 'continuation.db'))).mode & 0o777).toBe(0o600);
  });
  it('never replays an uncertain tool after cancellation and restart', async () => {
    fetchMock.mockResolvedValueOnce(response(1));
    const opts = options();
    const native = new NativeResponsesRunner(opts);
    opts.executeTool.mockImplementationOnce(async () => {
      native.interrupt();
      throw Error('unknown effect');
    });
    await expect(collect(native.run('write'))).rejects.toThrow(/interrupt/i);
    const old = store.load('app-id', binding)!;
    store.close();
    store = new NativeResponsesStore(join(root, 'continuation.db'));
    store.recoverAtStartup();
    const next = options();
    await collect(new NativeResponsesRunner(next).run('inspect current state'));
    expect(opts.executeTool).toHaveBeenCalledOnce();
    expect(next.executeTool).not.toHaveBeenCalled();
    expect(old.status).toBe('interrupted');
    expect(JSON.stringify(fetchMock.mock.calls.at(-1)![1].body)).toMatch(/interrupt|unknown/i);
  });
  it('fills unanswered crash tool calls with uncertainty instead of rerunning them', async () => {
    fetchMock.mockResolvedValueOnce(response(1));
    const opts = { ...options(), maxTurns: 1 };
    await expect(collect(new NativeResponsesRunner(opts).run('write'))).rejects.toThrow(/limit/i);
    const state = store.load('app-id', binding)!;
    store.save('app-id', binding, {
      ...state,
      status: 'running',
      history: state.checkpoint!.history,
    });
    store.recoverAtStartup();
    const next = options();
    await collect(new NativeResponsesRunner(next).run('inspect pending work'));
    expect(next.executeTool).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.at(-1)![1].body).toContain('Outcome unknown');
  });
  it('keeps prepared or abandoned work out of durable history until actual consumption', async () => {
    const native = new NativeResponsesRunner(options());
    native.prepare('abandoned', 'Never dispatched');
    store.recoverAtStartup();
    expect(store.load('app-id', binding)).toBeUndefined();
    native.abandon('abandoned');
    native.prepare('next', 'Explicit follow-up');
    await collect(native.run('Explicit follow-up', undefined, 'next'));
    expect(fetchMock.mock.calls[0][1].body).not.toContain('Never dispatched');
  });
  it('rejects account/model/credential-reference drift and preserves old history', async () => {
    await collect(new NativeResponsesRunner(options()).run('hello'));
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
    }
    expect(store.load('app-id', binding)?.history.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('rejects overlapping turns and cancels without claiming success', async () => {
    fetchMock.mockImplementationOnce(
      (_url, opts) =>
        new Promise((_resolve, reject) =>
          opts.signal.addEventListener('abort', () => reject(Error('aborted'))),
        ),
    );
    const native = new NativeResponsesRunner(options());
    const first = collect(native.run('first'));
    const rejection = expect(first).rejects.toThrow(/interrupt/i);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await expect(collect(new NativeResponsesRunner(options()).run('second'))).rejects.toThrow(
      /running/i,
    );
    native.interrupt();
    await rejection;
    expect(store.load('app-id', binding)?.status).toBe('interrupted');
  });
  it('revalidates context after credentials and before a provider request', async () => {
    let current = true;
    const opts = {
      ...options(),
      gemini: {
        ...gemini,
        getAccessToken: async () => {
          current = false;
          return 'fixture-token';
        },
      },
      prepareAgentContext: async () => {
        if (!current) throw Error('Revoked source');
      },
    };
    await expect(collect(new NativeResponsesRunner(opts).run('blocked'))).rejects.toThrow(
      'Revoked source',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('stops before side effects if checkpoint persistence fails', async () => {
    fetchMock.mockResolvedValueOnce(response(1));
    const original = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementation((id, account, state) => {
      if (state.checkpoint) throw Error('disk full');
      original(id, account, state);
    });
    const opts = options();
    await expect(collect(new NativeResponsesRunner(opts).run('write'))).rejects.toThrow(
      'disk full',
    );
    expect(opts.executeTool).not.toHaveBeenCalled();
  });
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
        responseId: `vertex-provider-${turn}`,
        candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }],
      });
    });
    const executeTool = vi.fn(async (block: import('@mitzo/harness').ToolUseBlock) => ({
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
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'stream_event',
        event: expect.objectContaining({
          type: 'message_start',
          providerReceipt: { provider: 'google-vertex', responseId: 'vertex-provider-1' },
        }),
      }),
    );
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0][0]).toMatchObject({ name: 'Read', input: { path: 'note' } });
    expect(store.load('gemini-app', googleBinding)?.status).toBe('idle');
    expect(JSON.stringify(events)).not.toContain('private-signature');
    await collect(new NativeResponsesRunner(opts).run('continue'));
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(store.load('gemini-app', googleBinding)?.history.at(-1)?.role).toBe('assistant');
  });
});
