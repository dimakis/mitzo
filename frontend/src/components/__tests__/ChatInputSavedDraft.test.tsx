// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatInput } from '../ChatInput';
import { createChatDraft, getChatDraft, saveChatDraft } from '../../lib/chat-drafts';
vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../SessionTray', () => ({ SessionTray: () => null }));
vi.mock('../MicButton', () => ({ MicButton: () => null }));
vi.mock('../../lib/haptics', () => ({ impactMedium: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

it('restores full content, saves instant edits, and never puts a fresh composer in the shared key', () => {
  const draft = { ...createChatDraft(), text: 'Morning briefing', contextBlocks: ['Context'] };
  saveChatDraft(draft);
  const view = render(
    <ChatInput onSend={() => false} onStop={() => {}} running={false} savedChatDraft={draft} />,
  );
  expect((screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement).value).toBe(draft.text);
  fireEvent.change(screen.getByLabelText('Message Mitzo'), {
    target: { value: 'Edited instantly' },
  });
  view.unmount();
  expect(getChatDraft(draft.id)).toMatchObject({
    text: 'Edited instantly',
    contextBlocks: ['Context'],
  });
  render(
    <ChatInput
      onSend={() => false}
      onStop={() => {}}
      running={false}
      savedChatDraft={createChatDraft()}
    />,
  );
  expect((screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement).value).toBe('');
  expect(localStorage.getItem('mitzo-draft-new')).toBeNull();
});
it.each(['failed', 'uncertain', 'accepted'] as const)(
  'retains a saved draft until an accepted receipt: %s',
  (status) => {
    const draft = {
      ...createChatDraft(),
      text: 'Unsent',
      images: [{ data: 'abc', preview: 'data:image/png;base64,abc', mediaType: 'image/png' }],
    };
    saveChatDraft(draft);
    let receipt: ((status: 'failed' | 'uncertain' | 'accepted') => void) | undefined;
    const send = vi.fn((_text, _images, _context, callback) => {
      receipt = callback;
      return true;
    });
    const view = render(
      <ChatInput onSend={send} onStop={() => {}} running={false} savedChatDraft={draft} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(send.mock.calls[0][1]).toEqual(draft.images);
    expect(getChatDraft(draft.id)).not.toBeNull();
    act(() => receipt?.(status));
    view.unmount();
    expect(getChatDraft(draft.id) === null).toBe(status === 'accepted');
  },
);
it('retains an edit made while an older message is awaiting confirmation', () => {
  const draft = { ...createChatDraft(), text: 'Original' };
  saveChatDraft(draft);
  let receipt: ((status: 'accepted') => void) | undefined;
  const view = render(
    <ChatInput
      onSend={(_text, _images, _context, callback) => {
        receipt = callback;
        return true;
      }}
      onStop={() => {}}
      running={false}
      savedChatDraft={draft}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: 'Newer thought' } });
  act(() => receipt?.('accepted'));
  view.unmount();
  expect(getChatDraft(draft.id)?.text).toBe('Newer thought');
});
it('switches saved owners without copying prior text, images or context to the new draft', () => {
  const first = {
    ...createChatDraft(),
    text: 'First',
    contextBlocks: ['First context'],
    images: [{ data: 'one', preview: 'data:image/png;base64,one', mediaType: 'image/png' }],
  };
  const second = { ...createChatDraft(), text: 'Second', contextBlocks: ['Second context'] };
  saveChatDraft(first);
  saveChatDraft(second);
  const view = render(
    <ChatInput onSend={() => false} onStop={() => {}} running={false} savedChatDraft={first} />,
  );
  view.rerender(
    <ChatInput onSend={() => false} onStop={() => {}} running={false} savedChatDraft={second} />,
  );
  expect((screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement).value).toBe('Second');
  expect(getChatDraft(second.id)).toMatchObject({
    text: 'Second',
    contextBlocks: ['Second context'],
    images: [],
  });
  expect(getChatDraft(first.id)?.text).toBe('First');
});
it('keeps the composer and stored content when settings changed while an older send was pending', () => {
  const draft = { ...createChatDraft(), text: 'Original' };
  saveChatDraft(draft);
  let receipt: ((status: 'accepted') => void) | undefined;
  const view = render(
    <ChatInput
      onSend={(_text, _images, _context, callback) => {
        receipt = callback;
        return true;
      }}
      onStop={() => {}}
      running={false}
      savedChatDraft={draft}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  const changed = { ...draft, settings: { ...draft.settings, mode: 'ask' as const } };
  saveChatDraft(changed);
  view.rerender(
    <ChatInput onSend={() => false} onStop={() => {}} running={false} savedChatDraft={changed} />,
  );
  act(() => receipt?.('accepted'));
  expect((screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement).value).toBe('Original');
  expect(getChatDraft(draft.id)?.settings.mode).toBe('ask');
});
it('consumes the accepted revision after navigation unmounts the composer', () => {
  const draft = { ...createChatDraft(), text: 'Original' };
  saveChatDraft(draft);
  let receipt: ((status: 'accepted') => void) | undefined;
  const view = render(
    <ChatInput
      onSend={(_text, _images, _context, callback) => {
        receipt = callback;
        return true;
      }}
      onStop={() => {}}
      running={false}
      savedChatDraft={draft}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  view.unmount();
  act(() => receipt?.('accepted'));
  expect(getChatDraft(draft.id)).toBeNull();
});
