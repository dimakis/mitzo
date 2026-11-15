import { expect, it, vi } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../async-queue.js';
import { EventStore } from '../event-store.js';
import {
  createOrdinaryLocalVertexSdkQuery,
  SdkHookLifetime,
} from '../ordinary-local-vertex-sdk-query.js';
import { runQueryLoop } from '../query-loop.js';
import { retainedRuntimeFailure } from '../runtime-failure-diagnostics.js';
import { replayEventsToMessages } from '../conversation-transcript.js';
import { parseServerMessage } from '../../packages/client/src/protocol-parser.js';
import {
  messagesReducer,
  INITIAL_MESSAGES_STATE,
} from '../../packages/client/src/slices/messages.js';
import type { SessionRegistry } from '../session-registry.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
const sink = vi.hoisted(() => ({ failure: undefined as Error | undefined }));
vi.mock('../logger.js', async (original) => {
  const module = await original<typeof import('../logger.js')>();
  return {
    ...module,
    createLogger(name: string) {
      const logger = module.createLogger(name);
      return {
        ...logger,
        warn(message: string, context?: Record<string, unknown>) {
          if (
            name === 'query-loop' &&
            message === 'Claude reported a request failure' &&
            sink.failure
          )
            throw sink.failure;
          logger.warn(message, context);
        },
      };
    },
  };
});

it.each([
  ['anthropic-claude', false, 2],
  ['anthropic-vertex', false, 1],
  ['anthropic-api', false, 1],
  ['anthropic-claude', true, 2],
] as const)(
  'keeps %s native retry feedback nonfatal through live/cold consumers, log failure=%s',
  async (provider, failLogging, count) => {
    vi.mocked(query).mockClear();
    const events = new AsyncQueue<Record<string, unknown>>();
    vi.mocked(query).mockReturnValue({
      close: vi.fn(),
      [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    } as never);
    const controller = new AbortController();
    const sdk = createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
      options: { sessionId: 'session' },
      input: new AsyncQueue(),
      controller,
      lifetime: new SdkHookLifetime(),
      sdkSessionId: 'session',
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
    const transport = {
      send: (event: Record<string, unknown>) => sent.push(event),
      isOpen: () => true,
    };
    const accountBinding = {
      provider,
      accountId: 'selected',
      profileRevision: 'profile',
      accountLabel: 'Selected',
      model: 'selected-model',
    };
    const session = {
      transport,
      sessionId: 'session',
      accountBinding,
      observers: new Set(),
      currentSnapshot: null,
      cumulativeSessionTokens: 0,
      cumulativeCostUsd: 0,
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
    store.upsertSession({ sessionId: 'session', cwd: '/task' });
    store.append('session', 'user_message', {
      v: 2,
      type: 'user_message',
      sessionId: 'session',
      messageId: 'retained-input',
      text: 'Keep my request',
    });
    const retry = {
      type: 'system',
      subtype: 'api_retry',
      session_id: 'session',
      uuid: '693ad15b-2a21-4b33-94e7-8bfc5ed4fe72',
      attempt: 1,
      max_retries: 5,
      retry_delay_ms: 3000,
      error: 'PRIVATE_NATIVE_CAUSE',
    };
    const rate = {
      type: 'rate_limit_event',
      session_id: 'session',
      uuid: 'ef6d4944-154d-440e-baf1-ab4fa442fd02',
      rate_limit_info: { status: 'rejected', private: 'PRIVATE_LIMIT_DATA' },
    };
    events.push(retry);
    events.push(retry);
    events.push(rate);
    events.push({ type: 'result', session_id: 'session', is_error: false });
    events.close();
    sink.failure = failLogging ? new Error('PRIVATE_LOGGING_CAUSE') : undefined;
    try {
      await runQueryLoop(sdk.query, 'client', registry, controller, store, undefined, {
        onResultDelivered: async () => (sdk.query as unknown as { close(): void }).close(),
      });
      const notices = sent.filter((event) =>
        ['claude_api_retry', 'claude_rate_limit'].includes(String(event.code)),
      );
      expect(notices).toHaveLength(count);
      expect(vi.mocked(query)).toHaveBeenCalledOnce();
      expect(session.accountBinding).toBe(accountBinding);
      for (const notice of notices) {
        expect(notice.nonfatal).toBe(true);
        const retained = retainedRuntimeFailure(String(notice.correlationId));
        expect(retained?.cause).toBe(notice.code === 'claude_api_retry' ? retry : rate);
        expect(retained?.diagnosticCause).toBe(sink.failure);
        const setRunning = vi.fn();
        const parsed = parseServerMessage(
          notice as never,
          { currentSessionId: 'session' },
          { onSessionAssigned: vi.fn(), onSessionExpired: vi.fn(), setWsRunning: setRunning },
          'client',
        );
        const state = parsed.messagesActions.reduce(messagesReducer, {
          ...INITIAL_MESSAGES_STATE,
          running: true,
          current: { messageId: 'successor', blocks: new Map(), blockOrder: [] },
        });
        expect(setRunning).not.toHaveBeenCalled();
        expect(state.running).toBe(true);
        expect(state.current?.messageId).toBe('successor');
        expect(state.messages.at(-1)?.blocks[0].content).toContain(String(notice.error));
      }
      const restored = replayEventsToMessages(store.getEventsAfter('session', 0));
      expect(restored).toHaveLength(count + 1);
      expect(JSON.stringify(restored)).toContain('Keep my request');
      expect(JSON.stringify({ sent, restored })).not.toContain('PRIVATE');
    } finally {
      sink.failure = undefined;
      controller.abort();
      events.close();
      store.close();
    }
  },
);
