import { expect, it } from 'vitest';
import { readTelosChatReturn, telosChatReturnState } from '../telos-chat-return';
it.each([
  '/todos/item?view=Materials',
  '/todos/item?view=Chat&chooseChat=1',
  '/chat/lead?telosChatItem=other',
])('retains the explicit local navigation snapshot %s', (path) => {
  const state = { activeProfile: 'manual', scrollTop: 600, telosHistory: [] };
  const wrapped = telosChatReturnState(state, 'item', 'origin', path);
  expect(readTelosChatReturn(wrapped, 'item', '/chat/origin')).toEqual({ path, state });
  expect(readTelosChatReturn(wrapped, 'other', '/chat/origin')).toBeNull();
  expect(readTelosChatReturn(wrapped, 'item', '/chat/unrelated')).toBeNull();
});
it.each([
  'javascript:alert(1)',
  '//elsewhere/chat/origin',
  'https://elsewhere/chat/origin',
  '/settings',
  '/todos/item#script',
  '/todos/item/../other',
])('refuses an unqualified return target %s', (path) => {
  expect(
    readTelosChatReturn(telosChatReturnState(null, 'item', 'origin', path), 'item', '/chat/origin'),
  ).toBeNull();
});
