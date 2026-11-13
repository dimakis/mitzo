// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatArea } from '../ChatArea';
import { parseServerMessage } from '../../../../packages/client/src/protocol-parser';
import {
  INITIAL_MESSAGES_STATE,
  messagesReducer,
} from '../../../../packages/client/src/slices/messages';
import { useReplyReadReceipt } from '../../hooks/useReplyReadReceipt';
vi.mock('../../hooks/useReplyReadReceipt', () => ({
  useReplyReadReceipt: vi.fn(() => ({ error: undefined, retry: vi.fn() })),
}));
afterEach(cleanup);
it('acknowledges the live parsed reply and excludes a newer synthetic provider error', () => {
  let state = INITIAL_MESSAGES_STATE;
  const callbacks = {
    onSessionAssigned: vi.fn(),
    onSessionExpired: vi.fn(),
    onMessagesRestored: vi.fn(),
    onSessionRenamed: vi.fn(),
    setWsRunning: vi.fn(),
  };
  for (const message of [
    { type: 'message_start', messageId: 'reply', seq: 1 },
    { type: 'block_start', messageId: 'reply', blockId: 'text', blockType: 'text' },
    {
      type: 'block_delta',
      messageId: 'reply',
      blockId: 'text',
      blockType: 'text',
      delta: 'A completed reply',
    },
    { type: 'message_end', messageId: 'reply', seq: 4 },
  ])
    for (const action of parseServerMessage(
      message as never,
      { currentSessionId: 'c' },
      callbacks,
      'session:c',
    ).messagesActions)
      state = messagesReducer(state, action);
  const view = render(
    <ChatArea
      sessionId="c"
      messages={[
        ...state.messages,
        {
          messageId: 'provider-error-9',
          role: 'assistant',
          completedSeq: 9,
          blocks: [{ blockId: 'error', blockType: 'text', content: 'Retained provider failure' }],
        },
      ]}
      current={null}
      running={false}
      permission={null}
      onPermissionRespond={vi.fn()}
    />,
    { wrapper: MemoryRouter },
  );
  expect(useReplyReadReceipt).toHaveBeenLastCalledWith('c', 4, expect.anything());
  expect(view.container.querySelector('[data-read-reply-seq="4"]')).toBeTruthy();
  expect(view.container.querySelector('[data-read-reply-seq="9"]')).toBeNull();
});
