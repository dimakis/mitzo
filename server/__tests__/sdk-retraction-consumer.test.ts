import { expect, it, vi } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../async-queue.js';
import { EventStore } from '../event-store.js';
import {
  createOrdinaryLocalVertexSdkQuery,
  SdkHookLifetime,
} from '../ordinary-local-vertex-sdk-query.js';
import { runQueryLoop } from '../query-loop.js';
import { replayEventsToMessages, replayEventsToTranscript } from '../conversation-transcript.js';
import { RETRACTED_TOOL_RESULT } from '@mitzo/protocol';
import { parseServerMessage } from '../../packages/client/src/protocol-parser.js';
import {
  messagesReducer,
  INITIAL_MESSAGES_STATE,
} from '../../packages/client/src/slices/messages.js';
import type { SessionRegistry } from '../session-registry.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

it.each(
  ['anthropic-claude', 'anthropic-vertex', 'anthropic-api'].flatMap((provider) =>
    [false, true].map((hasTool) => ({ provider, hasTool })),
  ),
)(
  'retracts native response text through live and cold projections %j',
  async ({ provider, hasTool }) => {
    vi.mocked(query).mockClear();
    const sessionId = 'aaaabbbb-1111-4222-8333-444455556666';
    const oldUuid = '11111111-1111-4111-8111-111111111111';
    const nextUuid = '22222222-2222-4222-8222-222222222222';
    const toolUuid = '44444444-4444-4444-8444-444444444444';
    const events = new AsyncQueue<Record<string, unknown>>();
    vi.mocked(query).mockReturnValue({
      close: vi.fn(),
      [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    } as never);
    const controller = new AbortController();
    const sdk = createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
      options: { sessionId },
      input: new AsyncQueue(),
      controller,
      lifetime: new SdkHookLifetime(),
      sdkSessionId: sessionId,
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
    const session = {
      transport,
      sessionId,
      accountBinding: {
        provider,
        accountId: 'synthetic',
        profileRevision: 'fixed',
        accountLabel: 'Synthetic',
        model: 'synthetic',
      },
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
    store.upsertSession({ sessionId, cwd: '/task' });
    function message(id: string, uuid: string, text: string, supersedes?: string[], tool = false) {
      const push = (event: Record<string, unknown>) =>
        events.push({
          type: 'stream_event',
          session_id: sessionId,
          parent_tool_use_id: null,
          event,
        });
      push({
        type: 'message_start',
        message: { id, model: 'synthetic', usage: { input_tokens: 1 } },
      });
      push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      push({ type: 'content_block_stop', index: 0 });
      if (tool) {
        push({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'observed-tool', name: 'Bash', input: {} },
        });
        push({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        });
        push({ type: 'content_block_stop', index: 1 });
      }
      push({ type: 'message_stop' });
      events.push({
        type: 'assistant',
        session_id: sessionId,
        parent_tool_use_id: null,
        uuid,
        message: {
          id,
          role: 'assistant',
          content: [
            { type: 'text', text },
            ...(tool ? [{ type: 'tool_use', id: 'observed-tool', name: 'Bash', input: {} }] : []),
          ],
        },
        ...(supersedes ? { supersedes } : {}),
      });
    }
    message('msg_old', oldUuid, 'REFUSED_LEG_TEXT', undefined, hasTool);
    if (hasTool)
      events.push({
        type: 'user',
        session_id: sessionId,
        parent_tool_use_id: null,
        uuid: toolUuid,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'observed-tool', content: 'RETRACTED_RESULT_TEXT' },
          ],
        },
      });
    const replaced = [oldUuid, ...(hasTool ? [toolUuid] : [])];
    message('msg_replacement', nextUuid, 'CANONICAL_REPLACEMENT', replaced);
    events.push({
      type: 'system',
      subtype: 'model_refusal_fallback',
      session_id: sessionId,
      uuid: '33333333-3333-4333-8333-333333333333',
      trigger: 'refusal',
      direction: 'retry',
      original_model: 'synthetic-original',
      fallback_model: 'synthetic-replacement',
      request_id: null,
      retracted_message_uuids: replaced,
      content: 'Synthetic replacement receipt',
    });
    events.push({ type: 'result', session_id: sessionId, is_error: false });
    events.close();
    try {
      await runQueryLoop(sdk.query, 'client', registry, controller, store, undefined, {
        onResultDelivered: async () => (sdk.query as unknown as { close(): void }).close(),
      });
      let live = INITIAL_MESSAGES_STATE;
      for (const event of sent) {
        const parsed = parseServerMessage(
          event as never,
          { currentSessionId: sessionId },
          { onSessionAssigned: vi.fn(), onSessionExpired: vi.fn(), setWsRunning: vi.fn() },
          'client',
        );
        live = parsed.messagesActions.reduce(messagesReducer, live);
      }
      const cold = replayEventsToMessages(store.getEventsAfter(sessionId, 0));
      const reconnect = replayEventsToTranscript(store.getEventsAfter(sessionId, 0));
      expect(JSON.stringify(live.messages)).toContain('CANONICAL_REPLACEMENT');
      expect(JSON.stringify(cold)).toContain('CANONICAL_REPLACEMENT');
      const observed = {
        liveContainsSuperseded: JSON.stringify(live.messages).includes('REFUSED_LEG_TEXT'),
        coldContainsSuperseded: JSON.stringify(cold).includes('REFUSED_LEG_TEXT'),
      };
      expect(observed).toEqual({ liveContainsSuperseded: false, coldContainsSuperseded: false });
      expect(JSON.stringify(reconnect)).not.toContain('REFUSED_LEG_TEXT');
      expect(JSON.stringify(reconnect)).toContain('CANONICAL_REPLACEMENT');
      for (const projection of [live.messages, cold, reconnect.messages]) {
        expect(JSON.stringify(projection)).not.toContain('RETRACTED_RESULT_TEXT');
        if (hasTool) {
          expect(JSON.stringify(projection)).toContain('Bash');
          expect(JSON.stringify(projection)).toContain(RETRACTED_TOOL_RESULT);
        }
      }
      expect(JSON.stringify(store.getEventsAfter(sessionId, 0))).toContain('REFUSED_LEG_TEXT');
      if (hasTool)
        expect(JSON.stringify(store.getEventsAfter(sessionId, 0))).toContain(
          'RETRACTED_RESULT_TEXT',
        );
      expect(vi.mocked(query).mock.calls).toHaveLength(1);
    } finally {
      controller.abort();
      events.close();
      store.close();
    }
  },
);
