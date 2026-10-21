import { expect, it } from 'vitest';
import { INITIAL_MESSAGES_STATE, messagesReducer } from '../src/slices/messages.js';
import type { MessagesState } from '../src/slices/messages.js';

function pending(state: MessagesState, id: string) {
  state = messagesReducer(state, { type: 'MESSAGE_START', messageId: id });
  state = messagesReducer(state, {
    type: 'BLOCK_START',
    messageId: id,
    blockId: id,
    blockType: 'tool_use',
  });
  return messagesReducer(state, {
    type: 'BLOCK_END',
    messageId: id,
    blockId: id,
    blockType: 'tool_use',
    toolId: id,
    toolName: 'TelosCreateOutcome',
    input: 'original selected source',
  });
}

it('ends an unanswered call after message_end without inventing any result or error', () => {
  let state = pending(INITIAL_MESSAGES_STATE, 'pending');
  state = messagesReducer(state, { type: 'MESSAGE_END', messageId: 'pending' });
  const original = state.messages[0].blocks[0];
  expect(original).not.toHaveProperty('toolInterrupted');
  state = messagesReducer(state, { type: 'SESSION_STATE_CHANGED', state: 'idle' });
  expect(state.messages[0].blocks[0]).toBe(original);
  state = messagesReducer(state, { type: 'SESSION_END' });
  expect(state.messages[0].blocks[0]).toEqual({ ...original, toolInterrupted: true });
  expect(state.messages[0].blocks[0].toolResult).toBeUndefined();
  expect(state.messages[0].blocks[0].toolError).toBeUndefined();
  expect(state.current).toBeNull();
  expect(state.running).toBe(false);
});

it('preserves actual empty and image results and accepts a genuine late result after termination', () => {
  let state = pending(INITIAL_MESSAGES_STATE, 'empty');
  state = messagesReducer(state, {
    type: 'TOOL_RESULT',
    toolId: 'empty',
    result: '',
    isError: false,
  });
  state = messagesReducer(state, { type: 'MESSAGE_END', messageId: 'empty' });
  const completed = state.messages[0];
  state = pending(state, 'pending');
  state = messagesReducer(state, { type: 'SESSION_END' });
  expect(state.messages[0]).toBe(completed);
  expect(state.messages[1].blocks[0]).toHaveProperty('toolInterrupted', true);
  state = messagesReducer(state, {
    type: 'TOOL_RESULT',
    toolId: 'pending',
    result: 'original late receipt',
    isError: true,
    images: [{ id: 'retained-image', mediaType: 'image/png' }],
  });
  expect(state.messages[1].blocks[0]).toMatchObject({
    toolResult: 'original late receipt',
    toolError: true,
    toolResultImages: [{ id: 'retained-image', mediaType: 'image/png' }],
  });
});

it('retains an image-only result and interrupts unresolved delegated tools without receipts', () => {
  const image = {
    blockId: 'image',
    blockType: 'tool_use' as const,
    content: '',
    toolResultImages: [{ id: 'original-image', mediaType: 'image/png' }],
  };
  let state = messagesReducer(INITIAL_MESSAGES_STATE, {
    type: 'RESTORE',
    messages: [{ messageId: 'image-only', role: 'assistant', blocks: [image] }],
  });
  state = pending(state, 'delegate');
  state = messagesReducer(state, {
    type: 'SUBAGENT_START',
    parentBlockId: 'delegate',
    subagentMessageId: 'worker',
  });
  state = messagesReducer(state, {
    type: 'SUBAGENT_BLOCK_START',
    parentBlockId: 'delegate',
    blockId: 'child',
    blockType: 'tool_use',
    toolName: 'Bash',
  });
  state = messagesReducer(state, { type: 'SESSION_END' });
  expect(state.messages[0].blocks[0]).toEqual(image);
  expect(state.messages[0].blocks[0]).not.toHaveProperty('toolInterrupted');
  const parent = state.messages[1].blocks[0];
  expect(parent).toHaveProperty('toolInterrupted', true);
  expect(parent.subagent?.blocks[0]).toMatchObject({ toolName: 'Bash', toolInterrupted: true });
  expect(parent.subagent?.blocks[0].toolResult).toBeUndefined();
});
