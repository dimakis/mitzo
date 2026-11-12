// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { chatStorage } from '../../lib/large-chat-storage';
import { useQueuedMessages } from '../useQueuedMessages';
afterEach(() => {
  cleanup();
  localStorage.clear();
});
function setup() {
  const entries = ['Unconfirmed', 'First draft', 'Second draft'].map((text, i) => ({
    queueEntryId: 'id-' + i,
    text,
    dispatchPending: i === 0,
    images: [],
    contextBlocks: [],
  }));
  chatStorage.setItem('mitzo-queue-order-fence', JSON.stringify(entries));
  return renderHook(() => useQueuedMessages('order-fence'));
}
it('rejects moving a pending draft across an unconfirmed dispatch', () => {
  const hook = setup(),
    before = hook.result.current.queue;
  act(() => expect(hook.result.current.update(1, before[1], 0)).toBe(false));
  expect(hook.result.current.queue).toEqual(before);
});
it('reorders only unsent drafts while retaining the original delivery fence', () => {
  const hook = setup(),
    before = hook.result.current.queue;
  act(() => expect(hook.result.current.update(2, before[2], 1)).toBe(true));
  expect(hook.result.current.queue).toEqual([before[0], before[2], before[1]]);
  expect(hook.result.current.dequeue()).toBeUndefined();
});
it('refuses a stale row identity instead of overwriting a different pending prompt', () => {
  const hook = setup(),
    before = hook.result.current.queue;
  act(() => expect(hook.result.current.update(1, before[2], 1)).toBe(false));
  expect(hook.result.current.queue).toEqual(before);
});
