// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { MessageActions } from '../MessageActions';
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
class TestPointerEvent extends MouseEvent {
  pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? 'touch';
  }
}
vi.stubGlobal('PointerEvent', TestPointerEvent);
const message = {
  messageId: 'original',
  role: 'assistant' as const,
  text: 'Original answer',
  timestamp: 1793356740000,
};
it('opens exact-message reply, copy and voice actions with a full timestamp on right-click', () => {
  const reply = vi.fn();
  render(
    <MessageActions message={message} onReply={reply}>
      <p>Original answer</p>
    </MessageActions>,
  );
  fireEvent.contextMenu(screen.getByText('Original answer'), { clientX: 20, clientY: 20 });
  expect(screen.getByRole('menu', { name: 'Message actions' })).toBeDefined();
  expect(screen.getByText(/2026/)).toBeDefined();
  expect(screen.getByRole('menuitem', { name: 'Copy text' })).toBeDefined();
  expect(screen.getByRole('menuitem', { name: 'Read aloud' })).toBeDefined();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Reply' }));
  expect(reply).toHaveBeenCalledWith(message);
});
it('supports phone swipe and hold without treating vertical scrolling as a reply', () => {
  vi.useFakeTimers();
  const reply = vi.fn();
  render(
    <MessageActions message={message} onReply={reply}>
      <p>Source</p>
    </MessageActions>,
  );
  const source = screen.getByText('Source');
  fireEvent.pointerDown(source, { button: 0, pointerType: 'touch', clientX: 10, clientY: 10 });
  fireEvent.pointerMove(source, { pointerType: 'touch', clientX: 90, clientY: 15 });
  fireEvent.pointerUp(source, { pointerType: 'touch', clientX: 90, clientY: 15 });
  expect(reply).toHaveBeenCalledOnce();
  fireEvent.pointerDown(source, { button: 0, pointerType: 'touch', clientX: 10, clientY: 10 });
  fireEvent.pointerMove(source, { pointerType: 'touch', clientX: 15, clientY: 100 });
  fireEvent.pointerUp(source, { pointerType: 'touch', clientX: 15, clientY: 100 });
  expect(reply).toHaveBeenCalledOnce();
  fireEvent.pointerDown(source, { button: 0, pointerType: 'touch', clientX: 10, clientY: 10 });
  act(() => vi.advanceTimersByTime(600));
  expect(screen.getByRole('menu', { name: 'Message actions' })).toBeDefined();
});
