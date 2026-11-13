// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useReplyReadReceipt } from '../useReplyReadReceipt';
import { changeConversationReadState } from '../../lib/conversation-read-state';
vi.mock('../../lib/conversation-read-state', () => ({
  changeConversationReadState: vi.fn(async () => ({})),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it('acknowledges a visible completed reply once per visit and never from a hidden tab', async () => {
  let visible: (entries: { isIntersecting: boolean }[]) => void = () => {};
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof visible) {
        visible = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  function View({ id }: { id: string }) {
    const ref = useRef<HTMLDivElement>(null);
    useReplyReadReceipt(id, 42, ref);
    return (
      <div ref={ref}>
        <div data-read-reply-seq="42">Reply</div>
      </div>
    );
  }
  const view = render(<View id="chat" />);
  await act(async () => visible([{ isIntersecting: true }]));
  expect(changeConversationReadState).not.toHaveBeenCalled();
  hidden.mockReturnValue('visible');
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(changeConversationReadState).toHaveBeenCalledWith('chat', { readReplySeq: 42 });
  await act(async () => visible([{ isIntersecting: true }]));
  expect(changeConversationReadState).toHaveBeenCalledTimes(1);
  view.rerender(<View id="other" />);
  await act(async () => visible([{ isIntersecting: true }]));
  expect(changeConversationReadState).toHaveBeenCalledTimes(2);
  hidden.mockRestore();
});
