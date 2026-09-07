import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { SseConnection } from '@mitzo/client';
import { ConnectionRegistry } from '@mitzo/harness';
import { SessionSseRegistry } from '../session-sse-registry.js';
import { NativeCommandRegistry } from '../native-commands.js';
import { SseTransport } from '../sse-transport.js';
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: vi.fn(),
}));
vi.mock('../session-index.js', async (original) => ({
  ...(await original<object>()),
  registerSession: vi.fn(),
}));
vi.mock('../prompt-compare.js', () => ({
  capturePromptComparison: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../app.js', () => ({
  buildSkillRegistry: () => new Map(),
  isAllowedPath: () => true,
  NATIVE_COMMAND_NAMES: new Set(),
}));

it('delivers one prompt after background/reconnect even when its HTTP acknowledgement is lost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mitzo-reconnect-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ boot: { tokens: 1, fullMarkdown: 'boot' } }))),
  );
  const chat = await import('../chat.js');
  const { createChatRestRouter } = await import('../chat-rest-handler.js');
  const connections = new ConnectionRegistry();
  const streams = new SessionSseRegistry();
  chat.setConnectionRegistry(connections);
  const ctx = {
    connRegistry: connections,
    sessionRegistry: chat.registry,
    eventStore: chat.eventStore,
    nativeCommands: new NativeCommandRegistry(),
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/chat',
    createChatRestRouter(streams, ctx as Parameters<typeof createChatRestRouter>[1]),
  );
  const inputs: string[] = [];
  vi.mocked(query).mockImplementation(
    (args) =>
      (async function* () {
        for await (const input of args.prompt as AsyncIterable<{ message: { content: string } }>) {
          inputs.push(input.message.content);
          const n = inputs.length;
          const sessionId = args.options!.sessionId!;
          yield {
            type: 'stream_event',
            event: { type: 'message_start', message: { id: `answer-${n}` } },
          };
          yield {
            type: 'stream_event',
            event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          };
          yield {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: `response-${n}` },
            },
          };
          yield { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } };
          yield { type: 'assistant', session_id: sessionId, message: { content: [] } };
          yield { type: 'result', session_id: sessionId };
        }
      })() as ReturnType<typeof query>,
  );

  let nextConnection = 0;
  let loseNextAck = false;
  let sendRequests = 0;
  const clientEvents: Record<string, unknown>[] = [];
  const client = new SseConnection({
    baseUrl: '',
    fetch: async (url, init) => {
      const r = request(app)
        .post(url)
        .send(JSON.parse(String(init?.body)));
      for (const [key, value] of Object.entries(init?.headers ?? {})) r.set(key, String(value));
      const res = await r;
      if (url.endsWith('/send')) {
        sendRequests++;
        if (loseNextAck) {
          loseNextAck = false;
          throw new Error('simulated lost acknowledgement');
        }
      }
      return new Response(JSON.stringify(res.body), { status: res.status });
    },
    createEventSource: () => {
      const id = `conn-${++nextConnection}`;
      const listeners = new Map<string, (event: MessageEvent) => void>();
      const es = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        onerror: null,
        addEventListener: (type: string, listener: (event: MessageEvent) => void) =>
          listeners.set(type, listener),
        close: () => {
          streams.remove(id);
          connections.remove(id);
        },
      };
      const response = {
        writableEnded: false,
        end: () => {},
        write: (frame: string) => {
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (data) {
            const event = new MessageEvent('message', { data });
            if (frame.includes('event: welcome')) listeners.get('welcome')?.(event);
            else es.onmessage?.(event);
          }
          return true;
        },
      };
      streams.add(id, response as unknown as express.Response);
      connections.register(id, new SseTransport(id, streams));
      queueMicrotask(() => streams.sendTo(id, { type: 'welcome', connectionId: id }));
      return es as unknown as EventSource;
    },
  });
  client.onMessage((event) => clientEvents.push(event));
  try {
    client.connect();
    client.send({
      type: 'send',
      sessionId: null,
      clientMsgId: 'initial',
      prompt: 'hello',
      cwd: root,
      isolation: false,
    });
    await vi.waitFor(() => expect(clientEvents.some((e) => e.type === 'session_end')).toBe(true));
    const sessionId = clientEvents.find((e) => e.type === '_send_accepted')!.sessionId as string;
    const runtimeId = chat.registry.findBySessionId(sessionId)!.clientId;
    client.sendSuspend();
    await vi.waitFor(() => expect(chat.registry.isSuspended(runtimeId)).toBe(true));
    client.checkAndReconnect(true);
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));
    loseNextAck = true;
    client.send({
      type: 'send',
      sessionId,
      clientMsgId: 'after-foreground',
      prompt: 'wake on this first prompt',
    });
    await vi.waitFor(
      () =>
        expect(clientEvents).toContainEqual(
          expect.objectContaining({ type: 'block_delta', delta: 'response-2' }),
        ),
      { timeout: 3000 },
    );
    await vi.waitFor(
      () =>
        expect(clientEvents).toContainEqual(
          expect.objectContaining({ type: '_send_accepted', clientMsgId: 'after-foreground' }),
        ),
      { timeout: 3000 },
    );
    expect(inputs).toHaveLength(2);
    expect(sendRequests).toBe(3); // initial + lost ack + retry, only two SDK inputs
    expect(chat.registry.findBySessionId(sessionId)!.clientId).toBe(runtimeId);
    expect(query).toHaveBeenCalledTimes(1);
  } finally {
    client.disconnect();
    for (const [, session] of chat.registry.entries()) session.inputQueue?.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    connections.dispose();
    streams.destroy();
    chat.eventStore.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
