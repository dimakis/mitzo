// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { ChatInput } from '../ChatInput';

// Mock child components that fetch data
vi.mock('../SlashPicker', () => ({
  SlashPicker: () => null,
}));
vi.mock('../ContextPicker', () => ({
  ContextPicker: ({ selected }: { selected: string[] }) => (
    <div data-testid="context-picker">{selected.join(',')}</div>
  ),
}));
vi.mock('../MicButton', () => ({
  MicButton: () => null,
}));

afterEach(() => cleanup());

describe('ChatInput with externalContextBlocks', () => {
  const baseProps = {
    onSend: vi.fn().mockReturnValue(true),
    onStop: vi.fn(),
    running: false,
  };

  it('hides @ button when externalContextBlocks provided', () => {
    const { container } = render(
      <ChatInput {...baseProps} externalContextBlocks={['boot-context']} />,
    );
    expect(container.querySelector('.chat-input-btn--context')).toBeNull();
  });

  it('shows @ button when externalContextBlocks not provided', () => {
    const { container } = render(<ChatInput {...baseProps} />);
    expect(container.querySelector('.chat-input-btn--context')).toBeTruthy();
  });

  it('does not show inline context pills when external blocks provided', () => {
    const { container } = render(
      <ChatInput {...baseProps} externalContextBlocks={['boot-context']} />,
    );
    // External blocks are managed by parent, not shown as pills in ChatInput
    expect(container.querySelector('.chat-input-context-pills')).toBeNull();
  });

  it('passes external context blocks to onSend', () => {
    const onSend = vi.fn().mockReturnValue(true);
    render(
      <ChatInput
        {...baseProps}
        onSend={onSend}
        externalContextBlocks={['boot-context', 'constitution']}
      />,
    );

    const textarea = screen.getByPlaceholderText('Message Mitzo...');
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSend).toHaveBeenCalledWith('hello', undefined, ['boot-context', 'constitution']);
  });

  it('does NOT clear external context blocks on send', async () => {
    const onSend = vi.fn().mockReturnValue(true);
    const blocks = ['boot-context'];
    const { rerender } = render(
      <ChatInput {...baseProps} onSend={onSend} externalContextBlocks={blocks} />,
    );

    const textarea = screen.getByPlaceholderText('Message Mitzo...');
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    // Re-render with same blocks (parent controls them, they persist)
    rerender(<ChatInput {...baseProps} onSend={onSend} externalContextBlocks={blocks} />);

    // A distinct user send happens after the same-frame duplicate-send guard resets.
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    // Send again
    fireEvent.change(screen.getByPlaceholderText('Message Mitzo...'), {
      target: { value: 'second message' },
    });
    fireEvent.keyDown(screen.getByPlaceholderText('Message Mitzo...'), { key: 'Enter' });

    // Both sends should include the external blocks
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenNthCalledWith(2, 'second message', undefined, ['boot-context']);
  });
});
