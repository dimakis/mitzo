// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatInput } from '../ChatInput';
vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../SessionTray', () => ({ SessionTray: () => null }));
vi.mock('../MicButton', () => ({ MicButton: () => null }));
vi.mock('../../lib/haptics', () => ({ impactMedium: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});
it.each(['debounced', 'immediate'] as const)(
  'keeps a user-cleared preparation empty after %s reload and blocks Send',
  (timing) => {
    vi.useFakeTimers();
    localStorage.setItem('mitzo-draft-new', 'ordinary draft');
    const onSend = vi.fn(() => true);
    const props = {
      onSend,
      onStop: vi.fn(),
      running: false,
      initialText: 'Prepared task',
      draftStorageKey: 'mitzo-repository-prompt:prep-a',
    };
    const first = render(<ChatInput {...props} />);
    fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: '' } });
    if (timing === 'debounced') act(() => vi.advanceTimersByTime(500));
    first.unmount();
    render(<ChatInput {...props} />);
    expect((screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement).value).toBe('');
    expect(
      (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(localStorage.getItem('mitzo-repository-prompt:prep-a')).toBe('');
    expect(localStorage.getItem('mitzo-draft-new')).toBe('ordinary draft');
  },
);
it('uses a preparation-owned storage key without changing runtime session identity', () => {
  vi.useFakeTimers();
  localStorage.setItem('mitzo-draft-new', 'ordinary draft\n keep these bytes');
  const onSend = vi.fn(() => true);
  const { unmount, rerender } = render(
    <ChatInput
      onSend={onSend}
      onStop={vi.fn()}
      running={false}
      initialText="Prepared task"
      draftStorageKey="mitzo-repository-prompt:prep-a"
    />,
  );
  fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: 'Reviewed task' } });
  act(() => vi.advanceTimersByTime(500));
  expect(localStorage.getItem('mitzo-repository-prompt:prep-a')).toBe('Reviewed task');
  expect(localStorage.getItem('mitzo-draft-new')).toBe('ordinary draft\n keep these bytes');
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  expect(onSend).toHaveBeenCalledWith('Reviewed task', undefined, undefined);
  rerender(<ChatInput onSend={onSend} onStop={vi.fn()} running sessionId="assigned" />);
  expect((screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement).value).toBe('');
  rerender(<ChatInput onSend={onSend} onStop={vi.fn()} running={false} sessionId="assigned" />);
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem('mitzo-draft-assigned')).toBeNull();
  unmount();
  expect(localStorage.getItem('mitzo-repository-prompt:prep-a')).toBeNull();
  expect(localStorage.getItem('mitzo-draft-new')).toBe('ordinary draft\n keep these bytes');
});
