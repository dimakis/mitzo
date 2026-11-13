// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MessageBubble, UserBubble } from '../MessageBubble';
import { installDialogStub } from './dialog-stub';
import { MessageActions } from '../MessageActions';

beforeEach(installDialogStub);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('opens the selected restored attachment unchanged and restores focus and scrolling on close', () => {
  const images = ['data:image/png;base64,first', 'data:image/jpeg;base64,second'];
  document.body.style.overflow = 'auto';
  render(
    <MessageBubble
      message={{
        messageId: 'old-screenshot',
        role: 'user',
        blocks: [{ blockId: 'prompt', blockType: 'text', content: 'An earlier screenshot' }],
        images,
        timestamp: 1,
      }}
    />,
  );
  const trigger = screen.getByRole('button', { name: 'Open attachment 2' });
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Image preview' });
  const fullImage = within(dialog).getByAltText('Attachment 2');
  expect(fullImage.getAttribute('src')).toBe(images[1]);
  expect(within(dialog).queryByRole('button', { name: 'Save image' })).toBeNull();
  fireEvent.load(fullImage);
  expect(within(dialog).queryByRole('status')).toBeNull();
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).toBe('auto');
});

it('wraps keyboard focus around the lone Close control and the available retry action', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  render(<UserBubble images={['/retained-picture.png']} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open attachment 1' }));
  const dialog = screen.getByRole('dialog', { name: 'Image preview' });
  const close = within(dialog).getByRole('button', { name: 'Close' });
  const tab = (control: HTMLElement, shiftKey = false) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      altKey: true,
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(control, event);
    expect(event.defaultPrevented).toBe(true);
  };
  close.focus();
  tab(close);
  expect(document.activeElement).toBe(close);
  tab(close, true);
  expect(document.activeElement).toBe(close);
  fireEvent.error(within(dialog).getByAltText('Attachment 1'));
  const retry = within(dialog).getByRole('button', { name: 'Retry image' });
  tab(close, true);
  expect(document.activeElement).toBe(retry);
  tab(retry);
  expect(document.activeElement).toBe(close);
});

it('keeps preview, text editing and the original message independent', () => {
  const edit = vi.fn();
  render(<UserBubble images={['/retained-picture.png']} text="Keep this message" onEdit={edit} />);
  const trigger = screen.getByRole('button', { name: 'Open attachment 1' });
  expect(trigger.closest('[role="button"]')).toBeNull();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Image preview' });
  fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }));
  expect(edit).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
  const text = screen.getByRole('button', { name: 'Keep this message' });
  fireEvent.keyDown(text, { key: 'Enter' });
  expect(edit).toHaveBeenCalledExactlyOnceWith('Keep this message');
});

it('shows a failed load and retries the same image without exposing its URL in diagnostics', () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  render(<UserBubble images={['/retained-private-image.png']} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open attachment 1' }));
  const dialog = screen.getByRole('dialog', { name: 'Image preview' });
  const image = within(dialog).getByAltText('Attachment 1');
  fireEvent.error(image);
  expect(within(dialog).getByRole('alert').textContent).toContain('could not be loaded');
  expect(warning).toHaveBeenCalledExactlyOnceWith('[mitzo] Chat image preview failed', {
    code: 'chat_image_preview_load_failed',
    stage: 'load',
    attachment: 1,
    attempt: 0,
  });
  const retry = within(dialog).getByRole('button', { name: 'Retry image' });
  retry.focus();
  fireEvent.click(retry);
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }));
  const retried = within(dialog).getByAltText('Attachment 1');
  expect(retried).not.toBe(image);
  expect(retried.getAttribute('src')).toBe('/retained-private-image.png');
  fireEvent.load(retried);
  expect(within(dialog).queryByRole('alert')).toBeNull();
});

it('closes an old preview when the retained message attachments change', () => {
  const { rerender } = render(<UserBubble images={['/old-chat.png']} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open attachment 1' }));
  rerender(<UserBubble images={['/new-chat.png']} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open attachment 1' }));
  expect(within(screen.getByRole('dialog')).getByAltText('Attachment 1').getAttribute('src')).toBe(
    '/new-chat.png',
  );
});

it.each(['touch', 'pen'])(
  'keeps %s gestures in the image viewer from replying to its transcript message',
  (pointerType) => {
    class PreviewPointerEvent extends MouseEvent {
      pointerType: string;
      constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
        super(type, init);
        this.pointerType = init.pointerType ?? 'touch';
      }
    }
    vi.stubGlobal('PointerEvent', PreviewPointerEvent);
    const reply = vi.fn();
    render(
      <MessageActions
        message={{ messageId: 'retained', role: 'user', text: 'Earlier picture' }}
        onReply={reply}
      >
        <UserBubble images={['/retained.png']} text="Earlier picture" />
      </MessageActions>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open attachment 1' }));
    const image = within(screen.getByRole('dialog')).getByAltText('Attachment 1');
    fireEvent.pointerDown(image, { button: 0, pointerType, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(image, { pointerType, clientX: 110, clientY: 10 });
    expect(reply).not.toHaveBeenCalled();
  },
);

it('keeps the native image context menu from opening transcript actions behind the modal', () => {
  render(
    <MessageActions
      message={{ messageId: 'retained', role: 'user', text: 'Earlier picture' }}
      onReply={vi.fn()}
    >
      <UserBubble images={['/retained.png']} text="Earlier picture" />
    </MessageActions>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open attachment 1' }));
  const dialog = screen.getByRole('dialog');
  for (const target of [
    within(dialog).getByAltText('Attachment 1'),
    within(dialog).getByText('Image preview'),
  ]) {
    expect(fireEvent.contextMenu(target, { clientX: 20, clientY: 20 })).toBe(true);
    expect(screen.queryByRole('menu', { name: 'Message actions' })).toBeNull();
  }
});
