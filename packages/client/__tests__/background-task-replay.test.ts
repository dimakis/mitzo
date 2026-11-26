import { expect, it, vi } from 'vitest';
import { parseServerMessage } from '../src/protocol-parser';
import { INITIAL_MESSAGES_STATE, messagesReducer } from '../src/slices/messages';

function feed(events: Record<string, unknown>[]) {
  return events
    .flatMap(
      (event) =>
        parseServerMessage(
          { v: 2, sessionId: 'chat', ...event } as never,
          { currentSessionId: 'chat' },
          { onSessionAssigned: vi.fn(), onSessionExpired: vi.fn() },
          'client',
        ).messagesActions,
    )
    .reduce(messagesReducer, INITIAL_MESSAGES_STATE);
}
const start = [
  { type: 'message_start', messageId: 'parent' },
  { type: 'block_start', blockId: 'tool', blockType: 'tool_use', toolName: 'Agent' },
  {
    type: 'subagent_start',
    parentBlockId: 'tool',
    subagentMessageId: 'opaque-execution',
    seq: 3,
    backgroundTask: { taskId: 'task', runId: 'opaque-run', description: 'Inspect files' },
  },
  {
    type: 'subagent_block_start',
    parentBlockId: 'tool',
    blockId: 'output',
    blockType: 'text',
    seq: 4,
  },
  {
    type: 'subagent_block_delta',
    parentBlockId: 'tool',
    blockId: 'output',
    delta: 'Retained output',
    seq: 5,
  },
];

it('ignores duplicate output and foreign execution receipts without parsing opaque IDs', () => {
  const state = feed([
    ...start,
    start[4],
    {
      type: 'subagent_end',
      parentBlockId: 'tool',
      subagentMessageId: 'old-execution',
      backgroundTask: { taskId: 'task', runId: 'old-run' },
      status: 'completed',
      seq: 6,
    },
  ]);
  const sub = state.current!.blocks.get('tool')!.subagent!;
  expect(sub.status).toBe('running');
  expect(sub.blocks instanceof Map && sub.blocks.get('output')!.content).toBe('Retained output');
});

it('retains a newer finished task when cold history hydration races a live terminal event', () => {
  let state = feed([
    ...start,
    { type: 'subagent_end', parentBlockId: 'tool', status: 'failed', seq: 8 },
    { type: 'message_end', messageId: 'parent' },
  ]);
  state = messagesReducer(state, {
    type: 'RESTORE',
    messages: [
      {
        messageId: 'parent',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            blockId: 'tool',
            blockType: 'tool_use',
            content: '',
            subagent: {
              messageId: 'opaque-execution',
              status: 'running',
              blocks: [],
              lastEventSeq: 3,
            },
          },
        ],
      },
      { messageId: 'new-history-message', role: 'assistant', timestamp: 2, blocks: [] },
    ],
  } as never);
  expect(state.messages[0].blocks[0].subagent?.status).toBe('failed');
});

it('retains terminal evidence and output when a stale running snapshot arrives', () => {
  const state = feed([
    ...start,
    {
      type: 'subagent_end',
      parentBlockId: 'tool',
      subagentMessageId: 'opaque-execution',
      status: 'failed',
      seq: 8,
    },
    {
      type: 'message_snapshot',
      messageId: 'parent',
      blocks: [
        {
          blockId: 'tool',
          blockType: 'tool_use',
          content: '',
          subagent: {
            messageId: 'opaque-execution',
            status: 'running',
            running: true,
            blocks: [],
            lastEventSeq: 3,
          },
        },
      ],
    },
  ]);
  const sub = state.current!.blocks.get('tool')!.subagent!;
  expect(sub.status).toBe('failed');
  expect(Array.isArray(sub.blocks) && sub.blocks[0].content).toBe('Retained output');
});

it('keeps observation loss separate from cancellation and accepts a later exact terminal receipt', () => {
  const unavailable = {
    type: 'subagent_end',
    parentBlockId: 'tool',
    subagentMessageId: 'opaque-execution',
    status: 'unavailable',
    seq: 7,
  };
  const state = feed([
    ...start,
    unavailable,
    {
      type: 'subagent_end',
      parentBlockId: 'tool',
      subagentMessageId: 'opaque-execution',
      status: 'cancelled',
      seq: 9,
    },
    unavailable,
  ]);
  expect(state.current!.blocks.get('tool')!.subagent!.status).toBe('cancelled');
});
