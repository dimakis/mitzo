import { expect, it, vi } from 'vitest';
import type { StoredEvent } from '@mitzo/protocol';
import { replayEventsToMessages } from '../conversation-transcript';
import { parseServerMessage } from '../../packages/client/src/protocol-parser';
import { INITIAL_MESSAGES_STATE, messagesReducer } from '../../packages/client/src/slices/messages';

it.each(['cancelled', 'unavailable'] as const)(
  'keeps explicit restart evidence distinct from %s through live/cold replay',
  (status) => {
    // Contract fixture only. Today's producer emits unavailable on retirement,
    // and does not claim the process_restart terminal evidence exercised here.
    const payloads = [
      { type: 'message_start', messageId: 'parent' },
      {
        type: 'block_start',
        messageId: 'parent',
        blockId: 'tool',
        blockType: 'tool_use',
        toolName: 'Agent',
      },
      {
        type: 'block_end',
        messageId: 'parent',
        blockId: 'tool',
        blockType: 'tool_use',
        toolName: 'Agent',
        toolId: 'launch',
        input: 'Inspect sources',
      },
      {
        type: 'subagent_start',
        messageId: 'parent',
        parentBlockId: 'tool',
        subagentMessageId: 'child',
        backgroundTask: { taskId: 'task', runId: 'run' },
      },
      {
        type: 'subagent_block_start',
        messageId: 'parent',
        parentBlockId: 'tool',
        blockId: 'output',
        blockType: 'text',
      },
      {
        type: 'subagent_block_delta',
        messageId: 'parent',
        parentBlockId: 'tool',
        blockId: 'output',
        delta: 'retained',
      },
      {
        type: 'subagent_end',
        messageId: 'parent',
        parentBlockId: 'tool',
        status,
        stopReason: 'process_restart',
      },
      { type: 'message_end', messageId: 'parent' },
    ];
    const events: StoredEvent[] = payloads.map((payload, i) => ({
      type: payload.type,
      payload,
      seq: i + 1,
      createdAt: i,
      sessionId: 'chat',
    }));
    const cold = replayEventsToMessages(events)[0].blocks[0].subagent!;
    const actions = events.flatMap(
      (event) =>
        parseServerMessage(
          { ...event.payload, v: 2, seq: event.seq, sessionId: 'chat' } as never,
          { currentSessionId: 'chat' },
          { onSessionAssigned: vi.fn(), onSessionExpired: vi.fn() },
          'client',
        ).messagesActions,
    );
    const live = actions.reduce(messagesReducer, INITIAL_MESSAGES_STATE).messages[0].blocks[0]
      .subagent!;
    for (const sub of [cold, live]) {
      expect(sub.status).toBe(status);
      expect(sub.stopReason).toBe(status === 'cancelled' ? 'process_restart' : undefined);
      expect(sub.blocks[0].content).toBe('retained');
    }
  },
);
