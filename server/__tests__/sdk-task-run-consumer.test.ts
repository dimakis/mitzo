import { expect, it, vi } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../async-queue.js';
import { EventStore } from '../event-store.js';
import {
  createOrdinaryLocalVertexSdkQuery,
  SdkHookLifetime,
} from '../ordinary-local-vertex-sdk-query.js';
import { runQueryLoop } from '../query-loop.js';
import { replayEventsToMessages } from '../conversation-transcript.js';
import type { SessionRegistry } from '../session-registry.js';
import { parseServerMessage } from '../../packages/client/src/protocol-parser.js';
import {
  INITIAL_MESSAGES_STATE,
  messagesReducer,
} from '../../packages/client/src/slices/messages.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

it.each([
  ['completed predecessor', true, true, true, true, false],
  ['late predecessor', false, true, true, true, false],
  ['legacy distinct tasks', true, false, true, true, false],
  ['missing predecessor receipt', false, true, false, true, false],
  ['both receipts missing at native retirement', false, true, false, false, false],
  ['native child starts before background announcement', false, true, true, true, true],
] as const)(
  'keeps native task runs distinct through live/cold consumers: %s',
  async (
    _scenario,
    firstCompleted,
    hasRunIds,
    firstReceiptArrives,
    secondReceiptArrives,
    nativeChildFirst,
  ) => {
    const events = new AsyncQueue<Record<string, unknown>>();
    vi.mocked(query).mockReturnValue({
      close: vi.fn(),
      [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    } as never);
    const controller = new AbortController();
    const sdk = createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
      options: { sessionId: 'task-session' },
      input: new AsyncQueue(),
      controller,
      lifetime: new SdkHookLifetime(),
      sdkSessionId: 'task-session',
      cwd: '/task',
      authorize: async () => {},
      authorizeSync: () => {},
      adapt: (native) => native as never,
      settings: () => ({}),
      inputChanged: () => {},
      onUnsent: (_input, cause) => {
        throw cause;
      },
    });
    const sent: Record<string, unknown>[] = [];
    const session = {
      transport: { send: (event: Record<string, unknown>) => sent.push(event), isOpen: () => true },
      sessionId: 'task-session',
      observers: new Set(),
      currentSnapshot: null,
      cumulativeSessionTokens: 0,
      cumulativeCostUsd: 0,
      activeTaskIds: new Map(),
      accountBinding: {
        provider: 'anthropic-claude',
        accountId: 'fixture',
        profileRevision: 'fixture',
        accountLabel: 'Offline',
        model: 'fixture-model',
      },
      queryInstance: sdk.query,
    };
    const registry = {
      get: () => session,
      findBySessionId: () => undefined,
      setSessionId: () => {},
      remove: () => {},
      isAttached: () => true,
      isSuspended: () => false,
      bufferEvent: () => false,
    } as unknown as SessionRegistry;
    const store = new EventStore(':memory:');
    store.upsertSession({ sessionId: 'task-session', cwd: '/task' });
    const push = (event: Record<string, unknown>) =>
      events.push({ session_id: 'task-session', ...event });
    push({ type: 'assistant', message: { content: [] } });
    push({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'parent', usage: { input_tokens: 1 } } },
      parent_tool_use_id: null,
    });
    const startTool = (index: number, id: string) => {
      push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id, name: 'Agent' },
        },
      });
      push({ type: 'stream_event', event: { type: 'content_block_stop', index } });
    };
    startTool(0, 'spawn-first');
    // Real child output can start before the SDK announces its background task.
    if (nativeChildFirst)
      push({
        type: 'stream_event',
        parent_tool_use_id: 'spawn-first',
        event: { type: 'message_start', message: { id: 'native-first-turn' } },
      });
    const firstStart = {
      type: 'system',
      subtype: 'task_started',
      task_id: 'same-task',
      run_id: hasRunIds ? '001' : undefined,
      tool_use_id: 'spawn-first',
      description: 'First run',
    };
    push(firstStart);
    const firstResult = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'same-task',
      run_id: hasRunIds ? '001' : undefined,
      tool_use_id: 'spawn-first',
      status: 'completed',
      summary: 'First result',
    };
    if (firstCompleted) push(firstResult);
    startTool(1, 'resume-second');
    const secondTask = hasRunIds ? 'same-task' : 'second-task';
    push({
      type: 'system',
      subtype: 'task_started',
      task_id: secondTask,
      run_id: hasRunIds ? '002' : undefined,
      tool_use_id: 'resume-second',
      description: 'Resumed run',
    });
    // A delayed prior-run notification must never complete the resumed run.
    if (firstReceiptArrives) push(firstResult);
    push(firstStart);
    if (hasRunIds) {
      // Neither an unobserved run nor an ambiguous/mismatched receipt can settle it.
      for (const receipt of [
        { run_id: '002', tool_use_id: 'spawn-first' },
        { run_id: '003', tool_use_id: 'resume-second' },
        { tool_use_id: 'resume-second' },
      ])
        push({
          type: 'system',
          subtype: 'task_notification',
          task_id: secondTask,
          status: 'completed',
          ...receipt,
        });
    }
    const firstStatus = firstReceiptArrives ? 'completed' : 'unavailable';
    const secondStatus = !secondReceiptArrives
      ? 'unavailable'
      : firstCompleted
        ? 'completed'
        : 'failed';
    const secondResult = {
      type: 'system',
      subtype: 'task_notification',
      task_id: secondTask,
      run_id: hasRunIds ? '002' : undefined,
      tool_use_id: 'resume-second',
      status: secondStatus,
      summary: 'Second result',
    };
    if (secondReceiptArrives) {
      push(secondResult);
      push(secondResult);
    }
    push({ type: 'result', is_error: false });
    events.close();
    try {
      await runQueryLoop(sdk.query, 'client', registry, controller, store, undefined, {
        onResultDelivered: async () => {
          if (secondReceiptArrives) (sdk.query as unknown as { close(): void }).close();
        },
        onEvent: (event) => {
          if (
            !firstCompleted &&
            firstReceiptArrives &&
            event.type === 'subagent_end' &&
            event.parentToolId === 'spawn-first'
          )
            expect(session.activeTaskIds.get('same-task')).toBe('resume-second');
          if (!secondReceiptArrives && event.type === 'subagent_end') {
            // Native stream retirement must publish uncertainty while the
            // joined owner remains open and keeps the current cancellation map.
            expect(event.status).toBe('unavailable');
            expect(session.activeTaskIds.get(secondTask)).toBe('resume-second');
            (sdk.query as unknown as { close(): void }).close();
          }
        },
      });
      const children = sent.filter((event) => event.type === 'subagent_end');
      expect(children.filter((event) => event.parentToolId === 'spawn-first')).toEqual([
        expect.objectContaining({
          parentToolId: 'spawn-first',
          taskId: 'same-task',
          status: firstStatus,
        }),
      ]);
      expect(children.filter((event) => event.parentToolId === 'resume-second')).toEqual([
        expect.objectContaining({
          parentToolId: 'resume-second',
          taskId: secondTask,
          status: secondStatus,
        }),
      ]);
      const restored = replayEventsToMessages(store.getEventsAfter('task-session', 0));
      const second = restored
        .flatMap((message) => message.blocks)
        .find((block) => block.toolId === 'resume-second');
      expect(second?.subagent?.status).toBe(secondStatus);
      const actions = sent.flatMap(
        (event) =>
          parseServerMessage(
            event as never,
            { currentSessionId: 'task-session' },
            { onSessionAssigned: vi.fn(), onSessionExpired: vi.fn(), setWsRunning: vi.fn() },
            'client',
          ).messagesActions,
      );
      const live = actions.reduce(messagesReducer, INITIAL_MESSAGES_STATE);
      const liveSecond = live.messages
        .flatMap((message) => message.blocks)
        .find((block) => block.toolId === 'resume-second');
      expect(liveSecond?.subagent?.status).toBe(secondStatus);
      // The actual producer must retain task identity through both consumers;
      // display metadata is not a process-generation witness or Stop authority.
      const backgroundTask = {
        taskId: secondTask,
        ...(hasRunIds ? { runId: '002' } : {}),
        description: 'Resumed run',
      };
      expect(second?.subagent?.backgroundTask).toEqual(backgroundTask);
      expect(liveSecond?.subagent?.backgroundTask).toEqual(backgroundTask);
      if (secondReceiptArrives) {
        expect(second?.subagent?.summary).toBe('Second result');
        expect(liveSecond?.subagent?.summary).toBe('Second result');
      }
      const first = restored
        .flatMap((message) => message.blocks)
        .find((block) => block.toolId === 'spawn-first');
      const liveFirst = live.messages
        .flatMap((message) => message.blocks)
        .find((block) => block.toolId === 'spawn-first');
      expect(first?.subagent?.status).toBe(firstStatus);
      expect(first?.subagent?.backgroundTask).toMatchObject({
        taskId: 'same-task',
        description: 'First run',
      });
      expect(liveFirst?.subagent?.backgroundTask).toEqual(first?.subagent?.backgroundTask);
      expect(liveFirst?.subagent?.status).toBe(firstStatus);
      if (!firstReceiptArrives) {
        expect(first?.subagent?.diagnostic?.code).toBe('claude_child_outcome_unavailable');
        expect(liveFirst?.subagent?.diagnostic).toEqual(first?.subagent?.diagnostic);
      }
      if (!secondReceiptArrives) {
        expect(second?.subagent?.diagnostic?.code).toBe('claude_child_outcome_unavailable');
        expect(liveSecond?.subagent?.diagnostic).toEqual(second?.subagent?.diagnostic);
        expect(session.activeTaskIds.get(secondTask)).toBe('resume-second');
      }
      expect(first?.subagent?.messageId).toBe(
        nativeChildFirst
          ? 'native-first-turn'
          : hasRunIds
            ? 'task-same-task-run-001'
            : 'task-same-task',
      );
      expect(first?.subagent?.messageId).not.toBe(second?.subagent?.messageId);
    } finally {
      controller.abort();
      events.close();
      store.close();
    }
  },
);
