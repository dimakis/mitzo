// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChatInput } from '../ChatInput';

// Mock SlashPicker to avoid Router dependency
vi.mock('../SlashPicker', () => ({
  SlashPicker: () => null,
}));

afterEach(() => cleanup());

const noop = () => true;
const noopVoid = () => {};

describe('ChatInput Enter key routing', () => {
  it('calls onSend on Enter when not running', () => {
    const onSend = vi.fn(() => true);
    render(<ChatInput onSend={onSend} onStop={noopVoid} running={false} />);
    const textarea = screen.getByPlaceholderText('Message Mitzo...');
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello', undefined, undefined);
  });

  it('calls onInterrupt on Enter when running and onInterrupt provided', () => {
    const onSend = vi.fn(() => true);
    const onInterrupt = vi.fn();
    render(
      <ChatInput onSend={onSend} onStop={noopVoid} onInterrupt={onInterrupt} running={true} />,
    );
    const textarea = screen.getByPlaceholderText('Type to queue or interrupt...');
    fireEvent.change(textarea, { target: { value: 'stop that' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onInterrupt).toHaveBeenCalledWith('stop that', undefined, undefined);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('falls through to onSend when running but onInterrupt is undefined', () => {
    const onSend = vi.fn(() => true);
    render(<ChatInput onSend={onSend} onStop={noopVoid} running={true} />);
    const textarea = screen.getByPlaceholderText('Type to queue or interrupt...');
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello', undefined, undefined);
  });

  it('does not send on Shift+Enter', () => {
    const onSend = vi.fn(() => true);
    render(<ChatInput onSend={onSend} onStop={noopVoid} running={false} />);
    const textarea = screen.getByPlaceholderText('Message Mitzo...');
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});
