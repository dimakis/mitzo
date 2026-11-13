import { expect, it, vi } from 'vitest';
import { parseServerMessage } from '../src/protocol-parser.js';
import { messagesReducer, INITIAL_MESSAGES_STATE } from '../src/slices/messages.js';
it('carries a durable live completion through parser and reducer for the visible read receipt', () => {
  let state = INITIAL_MESSAGES_STATE;
  const callbacks = {
    onSessionAssigned: vi.fn(),
    onSessionExpired: vi.fn(),
    onMessagesRestored: vi.fn(),
    onSessionRenamed: vi.fn(),
    setWsRunning: vi.fn(),
  };
  for (const message of [
    { type: 'message_start', messageId: 'reply', role: 'assistant', seq: 1 },
    { type: 'block_start', messageId: 'reply', blockId: 'text', blockType: 'text' },
    {
      type: 'block_delta',
      messageId: 'reply',
      blockId: 'text',
      blockType: 'text',
      delta: 'Visible reply',
    },
    { type: 'message_end', messageId: 'reply', seq: 4 },
  ]) {
    const parsed = parseServerMessage(
      message as never,
      { currentSessionId: 'c' },
      callbacks,
      'session:c',
    );
    for (const action of parsed.messagesActions) state = messagesReducer(state, action);
  }
  expect(state.messages[0]).toMatchObject({ messageId: 'reply', completedSeq: 4, replyReadSeq: 4 });
});
