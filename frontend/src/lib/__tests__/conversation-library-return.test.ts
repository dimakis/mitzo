import { expect, it } from 'vitest';
import { conversationLibraryReturn } from '../conversation-library-return';

it('restores a search through the actual Back to chats destination', () => {
  expect(
    conversationLibraryReturn({
      conversationLibraryReturn: { query: 'Claude personal', scrollTop: 350 },
    }),
  ).toEqual({ path: '/sessions?q=Claude+personal', state: { conversationSearchScroll: 350 } });
});
it('keeps unrelated and malformed navigation state on the normal library route', () => {
  for (const state of [null, {}, { conversationLibraryReturn: { query: 'x'.repeat(513) } }])
    expect(conversationLibraryReturn(state)).toEqual({ path: '/sessions', state: undefined });
});
it('does not accept a route destination from retained state', () => {
  const target = conversationLibraryReturn({
    conversationLibraryReturn: {
      query: '/settings?delete=true',
      scrollTop: -5,
      path: 'https://example.test',
    },
  });
  expect(target.path).toBe('/sessions?q=%2Fsettings%3Fdelete%3Dtrue');
  expect(target.state).toEqual({ conversationSearchScroll: 0 });
});
