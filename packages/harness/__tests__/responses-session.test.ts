import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsesSession } from '../src/providers/responses-session.js';
import { runAgenticLoop } from '../src/providers/sdk-adapter.js';
import type { ConversationMessage } from '../src/providers/session-types.js';

const config = { model: 'test-model', systemPrompt: 'Use native tools.', maxTokens: 1000 };
const prompt: ConversationMessage[] = [{ role: 'user', content: 'Read the marker.' }];
function response(events: object[], fragment = false) {
  const wire = events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join('');
  const bytes = new TextEncoder().encode(wire);
  return new Response(
    new ReadableStream({
      start(controller) {
        if (fragment) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        else controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function textEvents(text = 'Done ✓') {
  return [
    { type: 'response.created', response: { id: 'resp-1', model: 'test-model' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-1' } },
    {
      type: 'response.content_part.added',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.content_part.done', output_index: 0, content_index: 0 },
    {
      type: 'response.completed',
      response: {
        id: 'resp-1',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
        usage: { input_tokens: 12, output_tokens: 3 },
      },
    },
  ];
}
async function collect(session: ResponsesSession, messages = prompt) {
  return Array.fromAsync(session.turn(messages));
}
afterEach(() => vi.unstubAllGlobals());

describe('ResponsesSession', () => {
  it('requires explicit API credentials and rejects Anthropic thinking options', () => {
    expect(() => new ResponsesSession(config, { accountId: 'personal', apiKey: '' })).toThrow(
      /API key/,
    );
    expect(
      () =>
        new ResponsesSession(
          { ...config, thinking: { type: 'enabled', budget_tokens: 100 } },
          { accountId: 'personal', apiKey: 'test' },
        ),
    ).toThrow(/thinking/);
  });

  it('streams fragmented UTF-8 and sends an explicit Responses request', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(textEvents(), true));
    vi.stubGlobal('fetch', fetcher);
    const session = new ResponsesSession(config, { accountId: 'personal', apiKey: 'test' });
    const events = await collect(session);
    expect(events).toContainEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Done ✓' },
    });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      model: 'test-model',
      instructions: config.systemPrompt,
      max_output_tokens: 1000,
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
    });
    expect(events.at(-1)).toMatchObject({
      type: 'message_delta',
      usage: { input_tokens: 12, output_tokens: 3 },
    });
  });

  it('executes a tool round trip and preserves opaque reasoning for continuation', async () => {
    const call = {
      type: 'function_call',
      id: 'fc-1',
      call_id: 'call-1',
      name: 'Read',
      arguments: '{"file_path":"marker.txt"}',
    };
    const reasoning = {
      type: 'reasoning',
      id: 'rs-1',
      summary: [],
      encrypted_content: 'opaque-test-data',
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response([
          { type: 'response.created', response: { id: 'resp-tools', model: 'test-model' } },
          { type: 'response.output_item.added', output_index: 0, item: reasoning },
          { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
          {
            type: 'response.function_call_arguments.delta',
            output_index: 1,
            delta: call.arguments,
          },
          { type: 'response.output_item.done', output_index: 1, item: call },
          {
            type: 'response.completed',
            response: {
              id: 'resp-tools',
              output: [reasoning, call],
              usage: { input_tokens: 4, output_tokens: 2 },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(response(textEvents('marker')));
    vi.stubGlobal('fetch', fetcher);
    const session = new ResponsesSession(
      {
        ...config,
        tools: [{ name: 'Read', description: 'Read file', input_schema: { type: 'object' } }],
      },
      { accountId: 'personal', apiKey: 'test' },
    );
    const executeTool = vi.fn(async (block) => ({
      type: 'tool_result' as const,
      tool_use_id: block.id,
      content: 'marker',
    }));
    const events = await Array.fromAsync(
      runAgenticLoop(session, prompt, { sessionId: 'app-id', maxTurns: 3, executeTool }),
    );
    expect(executeTool).toHaveBeenCalledWith({
      type: 'tool_use',
      id: 'call-1',
      name: 'Read',
      input: { file_path: 'marker.txt' },
    });
    const second = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(second.input).toContainEqual(reasoning);
    expect(second.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call-1',
      output: 'marker',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      session_id: 'app-id',
      usage: { input_tokens: 12, output_tokens: 5 },
    });
  });

  it('restores a checkpoint without replaying assistant output twice', async () => {
    const fetcher = vi.fn().mockImplementation(async () => response(textEvents()));
    vi.stubGlobal('fetch', fetcher);
    const session = new ResponsesSession(config, { accountId: 'personal', apiKey: 'test' });
    await collect(session);
    const checkpoint = session.checkpoint();
    expect(JSON.stringify(checkpoint)).not.toContain('apiKey');
    const resumed = new ResponsesSession(config, {
      accountId: 'personal',
      apiKey: 'test',
      checkpoint,
    });
    await collect(resumed, [...checkpoint.history, { role: 'user', content: 'Continue' }]);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).input).toHaveLength(3);
    await expect(
      collect(resumed, [{ role: 'user', content: 'Different history' }]),
    ).rejects.toThrow(/history/);
  });

  it('rejects a checkpoint from another account or model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => response(textEvents())),
    );
    const session = new ResponsesSession(config, { accountId: 'personal', apiKey: 'test' });
    await collect(session);
    const checkpoint = session.checkpoint();
    expect(
      () => new ResponsesSession(config, { accountId: 'work', apiKey: 'test', checkpoint }),
    ).toThrow(/account/);
    expect(
      () =>
        new ResponsesSession(
          { ...config, model: 'other' },
          { accountId: 'personal', apiKey: 'test', checkpoint },
        ),
    ).toThrow(/model/);
  });

  it.each(['response.failed', 'response.incomplete'])(
    'rejects %s without committing a checkpoint',
    async (type) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            response([{ type, response: { error: { message: 'sensitive body' } } }]),
          ),
      );
      const session = new ResponsesSession(config, { accountId: 'personal', apiKey: 'test' });
      await expect(collect(session)).rejects.toThrow(/OpenAI response/);
      expect(session.checkpoint().history).toEqual([]);
    },
  );

  it('rejects truncated streams', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(textEvents().slice(0, -1))));
    await expect(
      collect(new ResponsesSession(config, { accountId: 'personal', apiKey: 'test' })),
    ).rejects.toThrow(/completion/);
  });

  it('redacts HTTP error bodies and never retries across accounts', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('secret-test-key', { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      collect(new ResponsesSession(config, { accountId: 'personal', apiKey: 'test' })),
    ).rejects.toThrow('OpenAI API request failed (401)');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('passes cancellation to fetch', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      collect(
        new ResponsesSession(
          { ...config, signal: controller.signal },
          { accountId: 'personal', apiKey: 'test' },
        ),
      ),
    ).rejects.toThrow('Aborted');
    expect(fetcher.mock.calls[0][1].signal).toBe(controller.signal);
  });
});
