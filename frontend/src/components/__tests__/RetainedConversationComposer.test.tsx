// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RetainedConversationComposer } from '../RetainedConversationComposer';
vi.mock('../SessionResourcesDialog', () => ({ SessionResourcesDialog: () => null }));
vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it('copies the current unavailable recipient draft to a new chat without queueing or clearing it', () => {
  const onContinueInNewChat = vi.fn();
  const onQueue = vi.fn();
  render(
    <RetainedConversationComposer
      sessionId="retained"
      recipient="a"
      seats={[{ id: 'a', name: 'Analyst' }]}
      onSelectRecipient={() => {}}
      enabled={false}
      onQueue={onQueue}
      onContinueInNewChat={onContinueInNewChat}
    />,
  );
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Latest unsaved text' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue in new chat' }));
  expect(onContinueInNewChat).toHaveBeenCalledWith('Latest unsaved text');
  expect(input.value).toBe('Latest unsaved text');
  expect(onQueue).not.toHaveBeenCalled();
});
it('uses the real ordinary composer, preserves draft while queueing and clears only on a confirmed receipt', async () => {
  let finish!: (value: boolean) => void;
  const onQueue = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <RetainedConversationComposer
      sessionId="retained"
      recipient="a"
      seats={[{ id: 'a', name: 'Analyst' }]}
      onSelectRecipient={() => {}}
      enabled
      onQueue={onQueue}
    />,
  );
  const input = screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Review the design' } });
  fireEvent.click(screen.getByRole('button', { name: 'Queue for approval' }));
  expect(onQueue).toHaveBeenCalledWith(['a'], 'Review the design');
  expect(input.value).toBe('Review the design');
  await act(async () => finish(true));
  await waitFor(() => expect(input.value).toBe(''));
  expect(screen.queryByRole('combobox', { name: 'Message recipient' })).toBeNull();
});
it('keeps failed text and distinct recipient drafts; choosing a history preview cannot change the send target', async () => {
  const onQueue = vi.fn(async () => false);
  const props = {
    sessionId: 'retained',
    seats: [
      { id: 'a', name: 'Analyst' },
      { id: 'b', name: 'Reviewer' },
    ],
    onSelectRecipient: vi.fn(),
    enabled: true,
    onQueue,
  };
  const view = render(<RetainedConversationComposer {...props} recipient="a" />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Private draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Queue for approval' }));
  await waitFor(() => expect(onQueue).toHaveBeenCalled());
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Private draft');
  view.rerender(<RetainedConversationComposer {...props} recipient="b" />);
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  view.rerender(<RetainedConversationComposer {...props} recipient="a" />);
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Private draft');
});

it.each([
  { accepted: true, edit: undefined, remaining: '' },
  { accepted: false, edit: undefined, remaining: 'Pending text' },
  { accepted: true, edit: 'A newer draft', remaining: 'A newer draft' },
])(
  'keeps recipient ownership through a pending queue receipt ($accepted, $edit)',
  async ({ accepted, edit, remaining }) => {
    let finish!: (value: boolean) => void;
    const onQueue = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    function Controlled() {
      const [recipient, setRecipient] = useState('a');
      return (
        <RetainedConversationComposer
          sessionId="retained"
          recipient={recipient}
          seats={[
            { id: 'a', name: 'Analyst' },
            { id: 'b', name: 'Reviewer' },
          ]}
          onSelectRecipient={setRecipient}
          enabled
          onQueue={onQueue}
        />
      );
    }
    render(<Controlled />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Pending text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue for approval' }));
    const chooser = screen.getByRole('button', { name: 'Choose who replies' }) as HTMLButtonElement;
    expect(chooser.disabled).toBe(true);
    fireEvent.click(chooser);
    expect(screen.queryByRole('checkbox', { name: 'Reviewer' })).toBeNull();
    if (edit) fireEvent.change(input, { target: { value: edit } });
    await act(async () => finish(accepted));
    await waitFor(() => expect(chooser.disabled).toBe(false));
    fireEvent.click(chooser);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Reviewer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose who replies' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Analyst' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(remaining);
    expect(onQueue).toHaveBeenCalledTimes(1);
  },
);
