// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useConversationPins } from '../useConversationPins';
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it('shares conversation pins across consumers while leaving Today pins separate', () => {
  const a = renderHook(() => useConversationPins());
  const b = renderHook(() => useConversationPins());
  act(() => a.result.current.toggle({ id: 'one', summary: 'A chat', lastModified: 1 }));
  expect(b.result.current.pins.map((pin) => pin.id)).toEqual(['one']);
  expect(localStorage.getItem('mitzo-home-preferences')).toBeNull();
  act(() => b.result.current.toggle({ id: 'one', summary: 'A chat', lastModified: 1 }));
  expect(a.result.current.pins).toHaveLength(0);
});
it('restores saved pin titles and ignores malformed data', () => {
  localStorage.setItem(
    'mitzo-conversation-pins',
    '[{"id":"one","summary":"Saved title","lastModified":1},null,{"id":7}]',
  );
  const hook = renderHook(() => useConversationPins());
  expect(hook.result.current.pins).toEqual([
    { id: 'one', summary: 'Saved title', lastModified: 1 },
  ]);
});
