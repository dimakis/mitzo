import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import type { StoreApi } from 'zustand/vanilla';
import type { MitzoStoreState, TransportAdapter } from '@mitzo/client';
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

type ClientEvent = Record<string, unknown>;

interface TestEventSource {
  readonly id: string;
  readonly events: ClientEvent[];
  welcome(): void;
  serverClose(): void;
}

/** chat.ts creates process globals at evaluation, hence imports are delayed. */
async function createReconnectHarness() {
  vi.resetModules();
  vi.clearAllMocks();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-reconnect-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ boot: { tokens: 1, fullMarkdown: 'boot' } }))),
  );

  const chat = await import('../chat.js');
  const { createChatRestRouter } = await import('../chat-rest-handler.js');
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { AsyncQueue } = await import('@mitzo/protocol');
  const { createMitzoStore } = await import('@mitzo/client');
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
  app.use('/api/chat', createChatRestRouter(streams, ctx));

  const inputs: string[] = [];
  const outputQueue = new AsyncQueue<ClientEvent>();
  let inputConsumer: Promise<void> | undefined;
  vi.mocked(query).mockImplementation(((args) => {
    const fake = {
      async *[Symbol.asyncIterator]() {
        const prompt = args.prompt as AsyncIterable<{ message: { content: string } }> & {
          close?: () => void;
        };
        inputConsumer ??= (async () => {
          for await (const input of prompt) inputs.push(input.message.content);
        })();
        try {
          yield* outputQueue;
        } finally {
          prompt.close?.();
        }
      },
      close: vi.fn(() => outputQueue.close()),
      interrupt: vi.fn(),
      stopTask: vi.fn(),
      setPermissionMode: vi.fn(),
    };
    return fake as unknown as ReturnType<typeof query>;
  }) as typeof query);

  let connectionNumber = 0;
  const sources: TestEventSource[] = [];
  const clientFrames: Array<{ sourceId: string; event: ClientEvent }> = [];
  const createEventSource = () => {
    const id = `conn-${++connectionNumber}`;
    const listeners = new Map<string, (event: MessageEvent) => void>();
    let writableEnded = false;
    const events: ClientEvent[] = [];
    const es = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((event: Event) => void) | null,
      addEventListener: (type: string, listener: (event: MessageEvent) => void) =>
        listeners.set(type, listener),
      close: () => {
        writableEnded = true;
        streams.remove(id);
        connections.remove(id);
      },
    };
    const response = {
      get writableEnded() {
        return writableEnded;
      },
      end: () => {
        writableEnded = true;
      },
      write: (frame: string) => {
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (!data) return true;
        const event = JSON.parse(data) as ClientEvent;
        events.push(event);
        clientFrames.push({ sourceId: id, event });
        const message = new MessageEvent('message', { data });
        if (frame.includes('event: welcome')) listeners.get('welcome')?.(message);
        else es.onmessage?.(message);
        return true;
      },
    };
    streams.add(id, response as unknown as express.Response);
    connections.register(id, new SseTransport(id, streams));
    const source: TestEventSource = {
      id,
      events,
      welcome: () => streams.sendTo(id, { type: 'welcome', connectionId: id }),
      serverClose: () => {
        writableEnded = true;
        streams.remove(id);
        connections.remove(id);
        es.onerror?.(new Event('error'));
      },
    };
    sources.push(source);
    return es as unknown as EventSource;
  };

  let loseNextAcknowledgement = false;
  let sendRequests = 0;
  const sseFetch = async (url: string, init?: RequestInit) => {
    const response = request(app)
      .post(url)
      .send(JSON.parse(String(init?.body ?? '{}')));
    for (const [key, value] of Object.entries(init?.headers ?? {}))
      response.set(key, String(value));
    const result = await response;
    if (url.endsWith('/send')) {
      sendRequests++;
      if (loseNextAcknowledgement) {
        loseNextAcknowledgement = false;
        throw new Error('simulated lost acknowledgement');
      }
    }
    return new Response(JSON.stringify(result.body), { status: result.status });
  };
  const apiTransport: TransportAdapter = { fetch: async () => new Response(JSON.stringify([])) };
  const store: StoreApi<MitzoStoreState> = createMitzoStore({
    transport: apiTransport,
    wsConfig: {
      buildUrl: () => 'ws://unused.test/ws',
      createWebSocket: () => {
        throw new Error('SSE configuration should bypass WebSocket construction');
      },
    },
    sseConfig: { baseUrl: '', fetch: sseFetch, createEventSource, reconnectDelayMs: 1 },
  });

  async function waitFor(check: () => void, timeout = 3_000) {
    await vi.waitFor(check, { timeout });
  }
  async function dispose() {
    store.getState().invalidateAuthentication();
    outputQueue.close();
    for (const [, session] of chat.registry.entries()) {
      session.inputQueue?.close();
      session.queryInstance?.close();
    }
    await waitFor(() => expect(Array.from(chat.registry.entries())).toHaveLength(0));
    await inputConsumer;
    connections.dispose();
    streams.destroy();
    chat.eventStore.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
  return {
    root,
    chat,
    store,
    sources,
    inputs,
    outputQueue,
    clientFrames,
    get sendRequests() {
      return sendRequests;
    },
    loseNextAcknowledgement: () => {
      loseNextAcknowledgement = true;
    },
    waitFor,
    dispose,
  };
}

function streamingEvents(sessionId: string, response: string): ClientEvent[] {
  return [
    { type: 'assistant', session_id: sessionId, message: { content: [] } },
    {
      type: 'stream_event',
      event: { type: 'message_start', message: { id: `answer-${response}` } },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: response },
      },
    },
  ];
}

it('delivers one prompt after background/reconnect even when its HTTP acknowledgement is lost', async () => {
  const h = await createReconnectHarness();
  try {
    h.sources[0].welcome();
    h.store.getState().sendMessage('hello', { cwd: h.root, isolation: false });
    await h.waitFor(() => expect(h.store.getState().sessions.active).toBeTruthy());
    const sessionId = h.store.getState().sessions.active!;
    await h.waitFor(() => expect(h.inputs).toEqual(['hello']));
    for (const event of streamingEvents(sessionId, 'response-1')) h.outputQueue.push(event);
    h.outputQueue.push({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    h.outputQueue.push({ type: 'assistant', session_id: sessionId, message: { content: [] } });
    h.outputQueue.push({ type: 'result', session_id: sessionId });
    await h.waitFor(() =>
      expect(h.clientFrames.some(({ event }) => event.type === 'session_end')).toBe(true),
    );
    const runtimeId = h.chat.registry.findBySessionId(sessionId)!.clientId;
    h.store.getState().sendSuspend();
    await h.waitFor(() => expect(h.chat.registry.isSuspended(runtimeId)).toBe(true));
    h.store.getState().forceReconnect();
    await h.waitFor(() => expect(h.sources).toHaveLength(2));
    h.sources[1].welcome();
    await h.waitFor(() => expect(h.store.getState().connection.status).toBe('connected'));
    h.loseNextAcknowledgement();
    h.store.getState().sendMessage('wake on this first prompt');
    await h.waitFor(() => expect(h.inputs).toEqual(['hello', 'wake on this first prompt']));
    for (const event of streamingEvents(sessionId, 'response-2').slice(1))
      h.outputQueue.push(event);
    await h.waitFor(() =>
      expect(h.clientFrames).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({ type: 'block_delta', delta: 'response-2' }),
        }),
      ),
    );
    await h.waitFor(() => expect(h.sendRequests).toBe(3));
    expect(h.chat.registry.findBySessionId(sessionId)!.clientId).toBe(runtimeId);
  } finally {
    await h.dispose();
  }
});

it('replays every offline durable event before the authoritative running snapshot after SSE loss', async () => {
  const h = await createReconnectHarness();
  try {
    h.sources[0].welcome();
    h.store.getState().sendMessage('keep running', { cwd: h.root, isolation: false });
    await h.waitFor(() => expect(h.store.getState().sessions.active).toBeTruthy());
    const sessionId = h.store.getState().sessions.active!;
    await h.waitFor(() => expect(h.inputs).toEqual(['keep running']));
    for (const event of streamingEvents(sessionId, 'online')) h.outputQueue.push(event);
    await h.waitFor(() =>
      expect(h.clientFrames.some(({ event }) => event.type === 'block_delta')).toBe(true),
    );
    const oldSeq = Math.max(
      ...h.clientFrames
        .map(({ event }) => event)
        .filter((event) => event.sessionId === sessionId && typeof event.seq === 'number')
        .map((event) => event.seq as number),
    );
    expect(oldSeq).toBeGreaterThan(0);
    const runtimeId = h.chat.registry.findBySessionId(sessionId)!.clientId;
    h.store.getState().sendSuspend();
    await h.waitFor(() => expect(h.chat.registry.isSuspended(runtimeId)).toBe(true));
    h.sources[0].serverClose();
    h.outputQueue.push({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' offline-1' },
      },
    });
    h.outputQueue.push({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' offline-2' },
      },
    });
    // This final, valid SDK delta is a queue barrier: seeing it durably stored
    // proves both required offline deltas have been consumed before reconnect.
    h.outputQueue.push({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' offline-barrier' },
      },
    });
    await h.waitFor(() =>
      expect(
        h.chat.eventStore
          .getEventsAfter(sessionId, oldSeq)
          .some((event) => event.payload.delta === ' offline-barrier'),
      ).toBe(true),
    );
    h.store.getState().forceReconnect();
    await h.waitFor(() => expect(h.sources).toHaveLength(2));
    const reconnecting = h.sources[1];
    reconnecting.welcome();
    await h.waitFor(() =>
      expect(reconnecting.events.some((event) => event.type === 'session_execution_snapshot')).toBe(
        true,
      ),
    );
    const expectedReplay = h.chat.eventStore.getEventsAfter(sessionId, oldSeq);
    const replayed = reconnecting.events.filter(
      (event) => event.sessionId === sessionId && typeof event.seq === 'number',
    );
    expect(replayed.map((event) => event.seq)).toEqual(expectedReplay.map((event) => event.seq));
    expect(replayed.map((event) => event.seq)).toEqual(
      [...replayed.map((event) => event.seq)].sort((a, b) => Number(a) - Number(b)),
    );
    expect(new Set(replayed.map((event) => event.seq)).size).toBe(replayed.length);
    const snapshotIndex = reconnecting.events.findIndex(
      (event) => event.type === 'session_execution_snapshot',
    );
    const lastReplayIndex = reconnecting.events.reduce(
      (last, event, index) =>
        event.sessionId === sessionId && typeof event.seq === 'number' ? index : last,
      -1,
    );
    const snapshot = reconnecting.events[snapshotIndex];
    expect(snapshotIndex).toBeGreaterThan(lastReplayIndex);
    expect(snapshot).toMatchObject({
      type: 'session_execution_snapshot',
      sessionId,
      state: 'running',
      internalState: 'ACTIVE',
      lastSeq: expectedReplay.at(-1)!.seq,
    });
    expect(h.store.getState().messages.running).toBe(true);
    expect(h.chat.registry.isSuspended(runtimeId)).toBe(false);
  } finally {
    await h.dispose();
  }
});

it('replays one offline completion and then advances the reconnect cursor past its terminal state', async () => {
  const h = await createReconnectHarness();
  const runningTransitions: boolean[] = [];
  let previousRunning = h.store.getState().messages.running;
  const unsubscribe = h.store.subscribe((state) => {
    if (state.messages.running !== previousRunning) {
      previousRunning = state.messages.running;
      runningTransitions.push(previousRunning);
    }
  });
  try {
    h.sources[0].welcome();
    h.store.getState().sendMessage('finish while offline', { cwd: h.root, isolation: false });
    await h.waitFor(() => expect(h.store.getState().sessions.active).toBeTruthy());
    const sessionId = h.store.getState().sessions.active!;
    await h.waitFor(() => expect(h.inputs).toEqual(['finish while offline']));
    for (const event of streamingEvents(sessionId, 'online')) h.outputQueue.push(event);
    await h.waitFor(() =>
      expect(h.clientFrames.some(({ event }) => event.type === 'block_delta')).toBe(true),
    );

    // A real reconnect establishes the store's authoritative running state
    // before the browser backgrounds and loses its SSE stream.
    h.store.getState().forceReconnect();
    await h.waitFor(() => expect(h.sources).toHaveLength(2));
    h.sources[1].welcome();
    await h.waitFor(() => expect(h.store.getState().messages.running).toBe(true));
    await h.waitFor(() => expect(h.store.getState().connection.status).toBe('connected'));
    const oldSeq = Math.max(
      ...h.clientFrames
        .map(({ event }) => event)
        .filter((event) => event.sessionId === sessionId && typeof event.seq === 'number')
        .map((event) => event.seq as number),
    );
    const runtimeId = h.chat.registry.findBySessionId(sessionId)!.clientId;
    h.store.getState().sendSuspend();
    await h.waitFor(() => expect(h.chat.registry.isSuspended(runtimeId)).toBe(true));
    h.sources[1].serverClose();

    h.outputQueue.push({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    h.outputQueue.push({ type: 'assistant', session_id: sessionId, message: { content: [] } });
    h.outputQueue.push({ type: 'result', session_id: sessionId });
    h.outputQueue.close();
    await h.waitFor(() => expect(h.chat.eventStore.getSessionState(sessionId)).toBe('ENDED'));
    await h.waitFor(() => expect(Array.from(h.chat.registry.entries())).toHaveLength(0));

    h.store.getState().forceReconnect();
    await h.waitFor(() => expect(h.sources).toHaveLength(3));
    const completionReplay = h.sources[2];
    completionReplay.welcome();
    await h.waitFor(() =>
      expect(
        completionReplay.events.some((event) => event.type === 'session_execution_snapshot'),
      ).toBe(true),
    );
    const expectedReplay = h.chat.eventStore.getEventsAfter(sessionId, oldSeq);
    const replayed = completionReplay.events.filter(
      (event) => event.sessionId === sessionId && typeof event.seq === 'number',
    );
    expect(replayed.map((event) => event.seq)).toEqual(expectedReplay.map((event) => event.seq));
    expect(replayed.map((event) => event.seq)).toEqual(
      [...replayed.map((event) => event.seq)].sort((a, b) => Number(a) - Number(b)),
    );
    expect(new Set(replayed.map((event) => event.seq)).size).toBe(replayed.length);

    const terminalEvent = expectedReplay.filter((event) => event.type === 'session_end');
    const terminalState = expectedReplay.filter(
      (event) => event.type === 'session_state_changed' && event.payload.internalState === 'ENDED',
    );
    expect(terminalEvent).toHaveLength(1);
    expect(terminalState).toHaveLength(1);
    expect(completionReplay.events.filter((event) => event.type === 'session_end')).toHaveLength(1);
    expect(
      completionReplay.events.filter(
        (event) => event.type === 'session_state_changed' && event.internalState === 'ENDED',
      ),
    ).toHaveLength(1);
    const snapshotIndex = completionReplay.events.findIndex(
      (event) => event.type === 'session_execution_snapshot',
    );
    const lastReplayIndex = completionReplay.events.reduce(
      (last, event, index) =>
        event.sessionId === sessionId && typeof event.seq === 'number' ? index : last,
      -1,
    );
    expect(snapshotIndex).toBeGreaterThan(lastReplayIndex);
    expect(completionReplay.events[snapshotIndex]).toMatchObject({
      type: 'session_execution_snapshot',
      sessionId,
      state: 'idle',
      internalState: 'ENDED',
      generation: terminalState[0].payload.generation,
      lastSeq: expectedReplay.at(-1)!.seq,
    });
    await h.waitFor(() => expect(h.store.getState().messages.running).toBe(false));
    expect(runningTransitions).toEqual([true, false]);

    h.store.getState().forceReconnect();
    await h.waitFor(() => expect(h.sources).toHaveLength(4));
    const caughtUp = h.sources[3];
    caughtUp.welcome();
    await h.waitFor(() =>
      expect(caughtUp.events.some((event) => event.type === 'session_execution_snapshot')).toBe(
        true,
      ),
    );
    expect(caughtUp.events.filter((event) => event.type === 'session_end')).toHaveLength(0);
    expect(
      caughtUp.events.filter(
        (event) => event.type === 'session_state_changed' && event.internalState === 'ENDED',
      ),
    ).toHaveLength(0);
    expect(runningTransitions).toEqual([true, false]);
  } finally {
    unsubscribe();
    await h.dispose();
  }
});
