import { expect, it } from 'vitest';
import { messagesReducer, INITIAL_MESSAGES_STATE } from '../slices/messages.js';
it('keeps late output attributed to A while B waits, and preserves attribution in snapshots', () => {
  let state = messagesReducer(INITIAL_MESSAGES_STATE, {
    type: 'USER_MESSAGE_RECEIVED',
    messageId: 'a',
    text: 'First',
    startedSeq: 1,
  });
  state = messagesReducer(state, {
    type: 'COMMAND_STATE',
    messageId: 'a',
    commandState: 'running',
  });
  state = messagesReducer(state, {
    type: 'USER_MESSAGE_RECEIVED',
    messageId: 'b',
    text: 'Correction',
    startedSeq: 2,
  });
  state = messagesReducer(state, { type: 'COMMAND_STATE', messageId: 'b', commandState: 'queued' });
  state = messagesReducer(state, {
    type: 'REPLY_SOURCE',
    messageId: 'answer-a',
    replyToMessageId: 'a',
  });
  state = messagesReducer(state, { type: 'MESSAGE_START', messageId: 'answer-a', startedSeq: 3 });
  expect(state.current?.replyToMessageId).toBe('a');
  expect(state.messages.find((m) => m.messageId === 'b')?.commandState).toBe('queued');
  state = messagesReducer(state, { type: 'MESSAGE_SNAPSHOT', messageId: 'answer-a', blocks: [] });
  expect(state.current?.replyToMessageId).toBe('a');
});

it('retains the established malformed-cache tolerance while deriving metadata', () => {
  const state = messagesReducer(INITIAL_MESSAGES_STATE, {
    type: 'RESTORE',
    messages: [
      null,
      { messageId: 'a', role: 'user', blocks: [] },
    ] as unknown as import('@mitzo/protocol').FinishedMessage[],
  });
  expect(state.messages.map((m) => m.messageId)).toEqual(['a']);
});
