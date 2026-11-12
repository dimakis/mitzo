import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  query,
  type Options,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../async-queue.js';
import { createSdkTurnQuery } from '../sdk-turn-query.js';
import {
  createOrdinaryLocalVertexSdkQuery,
  SdkHookLifetime,
} from '../ordinary-local-vertex-sdk-query.js';
import { runQueryLoop } from '../query-loop.js';
import type { SessionRegistry } from '../session-registry.js';
import { EventStore } from '../event-store.js';
import { replayEventsToMessages } from '../conversation-transcript.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  getSessionInfo: vi.fn(async () => ({ sessionId: 'original', cwd: '/offline' })),
  getSessionMessages: vi.fn(async () => [{ uuid: 'input-1' }]),
}));

function childEvents(id: string) {
  const stream = (event: Record<string, unknown>, parent?: string) => ({
    type: 'stream_event',
    parent_tool_use_id: parent ?? null,
    event,
  });
  return [
    stream({ type: 'message_start', message: { id: `parent-${id}` } }),
    stream({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', name: 'Agent', id },
    }),
    stream({ type: 'content_block_stop', index: 0 }),
    { type: 'system', subtype: 'task_started', task_id: `task-${id}`, tool_use_id: id },
    stream({ type: 'message_start', message: { id: `child-${id}` } }, id),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, id),
    stream(
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: `Retained ${id}` },
      },
      id,
    ),
    stream({ type: 'content_block_stop', index: 0 }, id),
  ];
}

it.each([
  ['continuous', false],
  ['owned', false],
  ['owned', true],
] as const)(
  'retires unresolved children through the real %s SDK wrapper while the outer iterator stays open (post-terminal failure: %s)',
  async (route, postTerminalFailure) => {
    const controller = new AbortController();
    const input = new AsyncQueue<SDKUserMessage>();
    const runs: Array<{
      events: AsyncQueue<Record<string, unknown>>;
      close: ReturnType<typeof vi.fn>;
    }> = [];
    const inputErrors: unknown[] = [];
    const create = (request: { options: Options; prompt: AsyncIterable<SDKUserMessage> }) => {
      const events = new AsyncQueue<Record<string, unknown>>();
      const child = request.options.spawnClaudeCodeProcess!({
        signal: controller.signal,
      } as never) as unknown as EventEmitter;
      const close = vi.fn(() => {
        events.close();
        child.emit('close', 0, null);
      });
      const firstRun = runs.length === 0;
      runs.push({ events, close });
      void request.prompt[Symbol.asyncIterator]()
        .next()
        .then(
          ({ value, done }) => {
            if (!done)
              events.push({
                type: 'user',
                session_id: 'original',
                uuid: value.uuid,
                message: value.message,
              });
          },
          (error) => {
            inputErrors.push(error);
            events.close();
          },
        );
      return {
        close,
        interrupt: vi.fn(),
        async *[Symbol.asyncIterator]() {
          yield* events;
          if (postTerminalFailure && firstRun) throw Error('native iterator close failed');
        },
      } as unknown as Query;
    };
    vi.mocked(query).mockImplementation((request) => {
      if (typeof request.prompt === 'string' || !request.options)
        throw Error('Retirement fixture requires streaming SDK input and options');
      return create({ prompt: request.prompt, options: request.options });
    });
    const options: Options = { spawnClaudeCodeProcess: () => new EventEmitter() as never };
    const lifetime = new SdkHookLifetime();
    const owner =
      route === 'owned'
        ? createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
            options,
            input,
            controller,
            lifetime,
            sdkSessionId: 'original',
            cwd: '/offline',
            authorize: async () => {},
            authorizeSync: () => {},
            adapt: (native) => native as never,
            settings: () => ({}),
            inputChanged: () => {},
            onUnsent: (_message, error) => {
              throw error;
            },
          })
        : undefined;
    const q =
      owner?.query ??
      createSdkTurnQuery<AsyncIterable<Record<string, unknown>>>({
        input,
        controller,
        lifetime,
        sdkSessionId: 'original',
        cwd: '/offline',
        authorize: async () => {},
        assertHistory: async () => {},
        options: () => options,
        create,
        adapt: (native) => native as never,
      });
    const push = (id: string) => {
      const message = {
        type: 'user',
        parent_tool_use_id: null,
        uuid: id,
        message: { role: 'user', content: id },
      } as SDKUserMessage;
      if (owner) owner.push(message);
      else input.push(message);
    };
    await owner?.apply({ model: 'first' } as never);
    const store = new EventStore(':memory:');
    store.upsertSession({ sessionId: 'original', cwd: '/offline' });
    const session = {
      sessionId: 'original',
      cwd: '/offline',
      mode: 'agent',
      queryInstance: q,
      transport: { send: vi.fn(), isOpen: () => true, close: vi.fn() },
      cumulativeSessionTokens: 0,
      cumulativeCostUsd: 0,
      currentSnapshot: null,
      observers: new Set(),
      activeTaskIds: new Map<string, string>(),
    };
    const registry = {
      get: () => session,
      setSessionId: vi.fn(),
      isAttached: () => true,
      isSuspended: () => false,
      bufferEvent: vi.fn(),
      remove: vi.fn(),
    } as unknown as SessionRegistry;
    const onResult = vi.fn();
    const onUserInput = vi.fn();
    let ended = false;
    const loop = runQueryLoop(q, 'client', registry, controller, store, undefined, {
      onResult,
      onUserInput,
    }).then(() => {
      ended = true;
    });
    const restored = (id: string) =>
      replayEventsToMessages(store.getSessionEvents('original'))
        .flatMap((message) => message.blocks)
        .find((block) => block.toolId === id)?.subagent;
    let firstOutcome: ReturnType<typeof restored>;
    try {
      push('input-1');
      await vi.waitFor(() => expect(onUserInput).toHaveBeenCalledOnce());
      for (const event of childEvents('first')) runs[0].events.push(event);
      await vi.waitFor(() => expect(restored('first')).toMatchObject({ status: 'running' }));
      runs[0].events.push({ type: 'sdk_query_retired' });
      runs[0].events.push({
        type: 'stream_event',
        parent_tool_use_id: 'first',
        event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
      });
      runs[0].events.push({
        type: 'stream_event',
        parent_tool_use_id: 'first',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'Still live' },
        },
      });
      runs[0].events.push({
        type: 'stream_event',
        parent_tool_use_id: 'first',
        event: { type: 'content_block_stop', index: 1 },
      });
      await vi.waitFor(() =>
        expect(restored('first')).toMatchObject({
          status: 'running',
          blocks: [expect.anything(), expect.objectContaining({ content: 'Still live' })],
        }),
      );
      runs[0].events.push({ type: 'result', session_id: 'original', is_error: false });
      await vi.waitFor(() => expect(onResult).toHaveBeenCalledOnce());
      await owner?.apply({ model: 'second' } as never);
      await vi.waitFor(() => expect(runs[0].close).toHaveBeenCalled());
      await vi.waitFor(() =>
        expect(restored('first')).toMatchObject({
          status: 'unavailable',
          blocks: [
            expect.objectContaining({ content: 'Retained first' }),
            expect.objectContaining({ content: 'Still live' }),
          ],
        }),
      );
      expect(ended).toBe(false);
      firstOutcome = structuredClone(restored('first'));
      push('input-2');
      await vi.waitFor(() => expect(runs).toHaveLength(2));
      await vi.waitFor(() => expect(onUserInput).toHaveBeenCalledTimes(2));
      for (const event of childEvents('second')) runs[1].events.push(event);
      await vi.waitFor(() => expect(restored('second')).toMatchObject({ status: 'running' }));
      expect(restored('first')).toMatchObject({ status: 'unavailable' });
      expect(onResult).toHaveBeenCalledExactlyOnceWith(
        'client',
        expect.objectContaining({ is_error: false }),
        'input-1',
      );
      expect(inputErrors).toEqual([]);
    } finally {
      controller.abort();
      input.close();
      try {
        await loop;
        if (firstOutcome) {
          expect(restored('first')).toEqual(firstOutcome);
          expect(restored('second')).toMatchObject({ status: 'unavailable' });
          expect(
            store
              .getSessionEvents('original')
              .filter(
                (event) => event.type === 'subagent_end' && event.payload.parentToolId === 'first',
              ),
          ).toHaveLength(1);
        }
      } finally {
        store.close();
      }
    }
  },
);
