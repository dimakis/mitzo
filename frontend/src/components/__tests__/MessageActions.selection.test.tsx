// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MessageActions } from '../MessageActions';
import { TextBubble, UserBubble } from '../MessageBubble';

class TestPointerEvent extends MouseEvent {
  pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? 'touch';
  }
}
vi.stubGlobal('PointerEvent', TestPointerEvent);
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
});
const message = { messageId: 'source', role: 'assistant' as const, text: 'Select these words' };
function selectWords() {
  const text = screen.getByText(message.text).firstChild!;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 6);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent(document, new Event('selectionchange'));
}

for (const pointerType of ['touch', 'pen']) {
  it(`leaves ${pointerType} hold and context menu to native selection`, () => {
    vi.useFakeTimers();
    render(
      <MessageActions message={message} onReply={vi.fn()}>
        <p>{message.text}</p>
      </MessageActions>,
    );
    const text = screen.getByText(message.text);
    fireEvent.pointerDown(text, { pointerType, button: 0 });
    act(() => vi.advanceTimersByTime(600));
    // iOS may dispatch contextmenu before selectionchange and omit pointerType.
    const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(text, context);
    expect(context.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
    selectWords();
    expect(window.getSelection()!.toString()).toBe('Select');
  });
}

it('keeps selected text and its native context menu without replying during handle drags', () => {
  const reply = vi.fn();
  render(
    <MessageActions message={message} onReply={reply}>
      <p>{message.text}</p>
    </MessageActions>,
  );
  const text = screen.getByText(message.text);
  fireEvent.pointerDown(text, { pointerType: 'touch', button: 0, clientX: 10 });
  selectWords();
  fireEvent.pointerUp(text, { pointerType: 'touch', clientX: 110 });
  expect(reply).not.toHaveBeenCalled();
  fireEvent.pointerDown(text, { pointerType: 'mouse', button: 2 });
  const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  fireEvent(text, context);
  expect(context.defaultPrevented).toBe(false);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(window.getSelection()!.toString()).toBe('Select');
});

it('closes an existing menu when text selection begins', () => {
  render(
    <MessageActions message={message} onReply={vi.fn()}>
      <p>{message.text}</p>
    </MessageActions>,
  );
  fireEvent.contextMenu(screen.getByText(message.text));
  expect(screen.getByRole('menu')).toBeDefined();
  selectWords();
  expect(screen.queryByRole('menu')).toBeNull();
});

for (const role of ['user', 'assistant'] as const) {
  it(`offers ${role} actions in the bubble footer and restores button focus`, () => {
    const reply = vi.fn(),
      edit = vi.fn();
    render(
      <MemoryRouter>
        <MessageActions message={{ ...message, role }} onReply={reply}>
          {role === 'user' ? (
            <UserBubble text={message.text} onEdit={edit} />
          ) : (
            <TextBubble content={message.text} />
          )}
        </MessageActions>
      </MemoryRouter>,
    );
    const button = screen.getByRole('button', { name: 'Message actions' });
    expect(button.closest('.msg-bubble-footer')).not.toBeNull();
    fireEvent.click(button);
    expect(edit).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitem', { name: 'Reply' })).toBeDefined();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reply' }));
    expect(reply).toHaveBeenCalledWith({ ...message, role });
  });
}
