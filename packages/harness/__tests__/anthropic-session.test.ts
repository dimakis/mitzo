import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicSession } from '../src/providers/anthropic-session.js';
import type {
  ModelSessionConfig,
  StreamEvent,
  ConversationMessage,
} from '../src/providers/session-types.js';

/** Build a minimal session config for testing. */
function testConfig(overrides: Partial<ModelSessionConfig> = {}): ModelSessionConfig {
  return {
    model: 'claude-haiku-4-5',
    systemPrompt: 'You are a test assistant.',
    maxTokens: 100,
    ...overrides,
  };
}

/** Encode text as a ReadableStream chunk. */
function encodeChunk(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Build a mock SSE response body from events. */
function mockSSEStream(events: Array<{ event: string; data: string }>): ReadableStream<Uint8Array> {
  const chunks = events.map((e) => `event: ${e.event}\ndata: ${e.data}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encodeChunk(chunks));
      controller.close();
    },
  });
}

/** Collect all events from an async iterable. */
async function collectEvents(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

describe('AnthropicSession', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('constructor', () => {
    it('creates session with default options', () => {
      const session = new AnthropicSession(testConfig());
      expect(session.provider).toBe('anthropic');
    });

    it('uses praxis proxy when MITZO_USE_PRAXIS is set', () => {
      vi.stubEnv('MITZO_USE_PRAXIS', '1');
      const session = new AnthropicSession(testConfig());
      expect(session.provider).toBe('anthropic');
      vi.unstubAllEnvs();
    });

    it('uses explicit baseUrl over env var', () => {
      const session = new AnthropicSession(testConfig(), {
        baseUrl: 'http://custom:8080',
      });
      expect(session.provider).toBe('anthropic');
    });
  });

  describe('turn()', () => {
    it('streams message_start event', async () => {
      const sseBody = mockSSEStream([
        {
          event: 'message_start',
          data: JSON.stringify({
            type: 'message_start',
            message: {
              id: 'msg_123',
              model: 'claude-haiku-4-5',
              role: 'assistant',
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          }),
        },
        {
          event: 'message_delta',
          data: JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 5 },
          }),
        },
      ]);

      fetchSpy.mockResolvedValueOnce(
        new Response(sseBody, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

      const session = new AnthropicSession(testConfig(), {
        baseUrl: 'http://test:9090',
        apiKey: 'test-key',
      });

      const messages: ConversationMessage[] = [{ role: 'user', content: 'hello' }];
      const events = await collectEvents(session.turn(messages));

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('message_start');
      expect(events[1].type).toBe('message_delta');
    });

    it('streams content blocks with text deltas', async () => {
      const sseBody = mockSSEStream([
        {
          event: 'message_start',
          data: JSON.stringify({
            type: 'message_start',
            message: {
              id: 'msg_456',
              model: 'claude-haiku-4-5',
              role: 'assistant',
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          }),
        },
        {
          event: 'content_block_start',
          data: JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }),
        },
        {
          event: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Hello!' },
          }),
        },
        {
          event: 'content_block_stop',
          data: JSON.stringify({
            type: 'content_block_stop',
            index: 0,
          }),
        },
        {
          event: 'message_delta',
          data: JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 3 },
          }),
        },
      ]);

      fetchSpy.mockResolvedValueOnce(
        new Response(sseBody, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

      const session = new AnthropicSession(testConfig(), {
        baseUrl: 'http://test:9090',
        apiKey: 'test-key',
      });

      const events = await collectEvents(session.turn([{ role: 'user', content: 'hi' }]));

      expect(events).toHaveLength(5);
      expect(events[0].type).toBe('message_start');
      expect(events[1].type).toBe('content_block_start');
      expect(events[2].type).toBe('content_block_delta');
      if (events[2].type === 'content_block_delta' && events[2].delta.type === 'text_delta') {
        expect(events[2].delta.text).toBe('Hello!');
      }
      expect(events[3].type).toBe('content_block_stop');
      expect(events[4].type).toBe('message_delta');
    });

    it('streams tool_use blocks', async () => {
      const sseBody = mockSSEStream([
        {
          event: 'message_start',
          data: JSON.stringify({
            type: 'message_start',
            message: {
              id: 'msg_789',
              model: 'gpt-5.5',
              role: 'assistant',
              usage: { input_tokens: 20, output_tokens: 0 },
            },
          }),
        },
        {
          event: 'content_block_start',
          data: JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'toolu_abc',
              name: 'Read',
              input: {},
            },
          }),
        },
        {
          event: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/test"}' },
          }),
        },
        {
          event: 'content_block_stop',
          data: JSON.stringify({ type: 'content_block_stop', index: 0 }),
        },
        {
          event: 'message_delta',
          data: JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'tool_use', stop_sequence: null },
            usage: { output_tokens: 15 },
          }),
        },
      ]);

      fetchSpy.mockResolvedValueOnce(
        new Response(sseBody, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

      const session = new AnthropicSession(
        testConfig({
          model: 'gpt-5.5',
          tools: [
            {
              name: 'Read',
              description: 'Read a file',
              input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
            },
          ],
        }),
        { baseUrl: 'http://test:9090', apiKey: 'test-key' },
      );

      const events = await collectEvents(session.turn([{ role: 'user', content: 'read /tmp/test' }]));

      expect(events).toHaveLength(5);

      // Verify tool_use block
      const blockStart = events[1];
      expect(blockStart.type).toBe('content_block_start');
      if (blockStart.type === 'content_block_start') {
        expect(blockStart.content_block.type).toBe('tool_use');
        if (blockStart.content_block.type === 'tool_use') {
          expect(blockStart.content_block.name).toBe('Read');
          expect(blockStart.content_block.id).toBe('toolu_abc');
        }
      }

      // Verify stop_reason is tool_use
      const msgDelta = events[4];
      if (msgDelta.type === 'message_delta') {
        expect(msgDelta.delta.stop_reason).toBe('tool_use');
      }
    });

    it('sends correct request body with system prompt and tools', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          mockSSEStream([
            {
              event: 'message_delta',
              data: JSON.stringify({
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: 0 },
              }),
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );

      const tools = [
        {
          name: 'Bash',
          description: 'Run a command',
          input_schema: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ];

      const session = new AnthropicSession(
        testConfig({ model: 'gpt-5.5', tools }),
        { baseUrl: 'http://test:9090', apiKey: 'test-key' },
      );

      await collectEvents(session.turn([{ role: 'user', content: 'list files' }]));

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://test:9090/v1/messages');

      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe('gpt-5.5');
      expect(body.max_tokens).toBe(100);
      expect(body.stream).toBe(true);
      expect(body.system).toBe('You are a test assistant.');
      expect(body.tools).toEqual(tools);
      expect(body.messages).toEqual([{ role: 'user', content: 'list files' }]);
    });

    it('throws on API error', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('{"error": "rate limited"}', { status: 429 }),
      );

      const session = new AnthropicSession(testConfig(), {
        baseUrl: 'http://test:9090',
        apiKey: 'test-key',
      });

      await expect(
        collectEvents(session.turn([{ role: 'user', content: 'hello' }])),
      ).rejects.toThrow('Anthropic API error 429');
    });

    it('skips ping and message_stop SSE events', async () => {
      const sseBody = mockSSEStream([
        { event: 'ping', data: '{}' },
        {
          event: 'message_start',
          data: JSON.stringify({
            type: 'message_start',
            message: {
              id: 'msg_ping',
              model: 'claude-haiku-4-5',
              role: 'assistant',
              usage: { input_tokens: 5, output_tokens: 0 },
            },
          }),
        },
        { event: 'message_stop', data: '{}' },
        {
          event: 'message_delta',
          data: JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 1 },
          }),
        },
      ]);

      fetchSpy.mockResolvedValueOnce(
        new Response(sseBody, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

      const session = new AnthropicSession(testConfig(), {
        baseUrl: 'http://test:9090',
        apiKey: 'test-key',
      });

      const events = await collectEvents(session.turn([{ role: 'user', content: 'hi' }]));

      // Only message_start + message_delta (ping and message_stop filtered)
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('message_start');
      expect(events[1].type).toBe('message_delta');
    });

    it('handles chunked SSE delivery (split across reads)', async () => {
      // Simulate SSE data arriving in multiple chunks, with event split across reads
      const chunk1 = 'event: message_start\ndata: {"type":"message_start","message":';
      const chunk2 =
        '{"id":"msg_chunked","model":"claude-haiku-4-5","role":"assistant","usage":{"input_tokens":5,"output_tokens":0}}}\n\n';
      const chunk3 =
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n';

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encodeChunk(chunk1));
          controller.enqueue(encodeChunk(chunk2));
          controller.enqueue(encodeChunk(chunk3));
          controller.close();
        },
      });

      fetchSpy.mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

      const session = new AnthropicSession(testConfig(), {
        baseUrl: 'http://test:9090',
        apiKey: 'test-key',
      });

      const events = await collectEvents(session.turn([{ role: 'user', content: 'hi' }]));
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('message_start');
      expect(events[1].type).toBe('message_delta');
    });
  });

  describe('headers', () => {
    it('sends correct auth and version headers', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          mockSSEStream([
            {
              event: 'message_delta',
              data: JSON.stringify({
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: 0 },
              }),
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );

      const session = new AnthropicSession(testConfig(), {
        baseUrl: 'http://test:9090',
        apiKey: 'my-key-123',
        apiVersion: '2024-01-01',
      });

      await collectEvents(session.turn([{ role: 'user', content: 'hi' }]));

      const headers = (fetchSpy.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
      expect(headers['x-api-key']).toBe('my-key-123');
      expect(headers['anthropic-version']).toBe('2024-01-01');
      expect(headers['Content-Type']).toBe('application/json');
    });
  });
});
