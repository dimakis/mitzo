import { createRef, Profiler } from 'react';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatInput, type ChatInputDraftControl } from '../ChatInput';
import { renderToString } from 'react-dom/server';
import { createChatDraft, getChatDraft, saveChatDraft } from '../../lib/chat-drafts';
vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../SessionResourcesDialog', () => ({ SessionResourcesDialog: () => null }));
vi.mock('../MicButton', () => ({ MicButton: () => null }));
vi.mock('../../lib/haptics', () => ({ impactMedium: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('flushes an intentionally removed empty rich draft from its owned settings seed', () => {
  const draft = createChatDraft();
  const control = createRef<ChatInputDraftControl>();
  render(
    <ChatInput
      onSend={() => false}
      onStop={() => {}}
      running={false}
      savedChatDraft={draft}
      draftControl={control}
    />,
  );
  expect(getChatDraft(draft.id)).toBeNull();
  expect(control.current?.flush?.()).toBe(true);
  expect(getChatDraft(draft.id)).toBeNull();
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', '');
});

it('refuses rich fallback when an existing stored revision is unreadable', () => {
  const draft = { ...createChatDraft(), text: 'Owned text' };
  const control = createRef<ChatInputDraftControl>();
  render(
    <ChatInput
      onSend={() => false}
      onStop={() => {}}
      running={false}
      savedChatDraft={draft}
      draftControl={control}
    />,
  );
  const key = 'mitzo-chat-draft:' + draft.id;
  localStorage.setItem(key, 'unreadable newer revision');
  expect(control.current?.flush?.()).toBe(false);
  expect(localStorage.getItem(key)).toBe('unreadable newer revision');
});

it('resizes edited drafts in the layout commit before the browser can paint stale lines', () => {
  const draft = { ...createChatDraft(), text: 'Previous draft' };
  const committed: Array<{ text: string; height: string }> = [];
  const view = render(
    <Profiler
      id="composer"
      onRender={() => {
        const input = document.querySelector<HTMLTextAreaElement>('.chat-input-field');
        if (input) committed.push({ text: input.value, height: input.style.height });
      }}
    >
      <ChatInput onSend={() => false} onStop={() => {}} running={false} savedChatDraft={draft} />
    </Profiler>,
  );
  const input = screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement;
  vi.spyOn(input, 'scrollHeight', 'get').mockImplementation(() =>
    input.value.includes('\n') ? 120 : 40,
  );
  fireEvent.change(input, { target: { value: 'Current draft' } });
  committed.length = 0;
  fireEvent.change(input, { target: { value: 'Current draft\nNew line' } });
  expect(committed.length).toBeGreaterThan(0);
  expect(committed).toEqual(
    committed.map(() => ({ text: 'Current draft\nNew line', height: '120px' })),
  );
  expect(getChatDraft(draft.id)?.text).toBe('Current draft\nNew line');
  view.unmount();
});

it('does not announce a save before the composer has persisted content', () => {
  const draft = { ...createChatDraft(), text: 'Not saved yet' };
  const html = renderToString(
    <ChatInput onSend={() => false} onStop={() => {}} running={false} savedChatDraft={draft} />,
  );
  expect(html).not.toContain('Saved to Drafts');
  expect(html).not.toContain('Draft saved on this device');
  expect(getChatDraft(draft.id)).toBeNull();
});

it('announces a confirmed local save only while the composer has a stored draft', () => {
  const draft = createChatDraft();
  render(
    <ChatInput onSend={() => false} onStop={() => {}} running={false} savedChatDraft={draft} />,
  );
  expect(screen.queryByRole('status')).toBeNull();
  expect(getChatDraft(draft.id)).toBeNull();

  fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: 'Just a test.' } });
  expect(screen.getByRole('status').textContent).toBe('Draft saved on this device');
  expect(getChatDraft(draft.id)?.text).toBe('Just a test.');

  fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: '' } });
  expect(screen.queryByRole('status')).toBeNull();
  expect(getChatDraft(draft.id)).toBeNull();
});

it('replaces the save confirmation with a warning when a newer edit cannot be stored', () => {
  const draft = { ...createChatDraft(), text: 'Saved text' };
  render(
    <ChatInput onSend={() => false} onStop={() => {}} running={false} savedChatDraft={draft} />,
  );
  expect(screen.getByRole('status').textContent).toBe('Draft saved on this device');
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Storage full');
  });
  fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: 'Unsaved edit' } });
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain(
    'Couldn’t save this draft on this device',
  );
  expect(getChatDraft(draft.id)?.text).toBe('Saved text');

  storage.mockRestore();
  fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: 'Recovered edit' } });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('Draft saved on this device');
  expect(getChatDraft(draft.id)?.text).toBe('Recovered edit');
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
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', '');
    expect(screen.queryByText('Draft saved on this device')).toBeNull();
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
it('retains an identical next saved draft after the older send is accepted', () => {
  const draft = { ...createChatDraft(), text: 'Same next message' };
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
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', '');
  fireEvent.change(screen.getByLabelText('Message Mitzo'), {
    target: { value: 'Same next message' },
  });
  act(() => receipt?.('accepted'));
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', 'Same next message');
  view.unmount();
  expect(getChatDraft(draft.id)?.text).toBe('Same next message');
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
it('retains an unmounted accepted revision until a replacement composer can consume its receipt', () => {
  const draft = { ...createChatDraft(), text: 'Original' };
  saveChatDraft(draft);
  let receipt: ((status: 'accepted') => void) | undefined;
  let proof: import('@mitzo/client').SendMessageOptions['composerDraft'];
  const view = render(
    <ChatInput
      onSend={(_text, _images, _context, callback, _assigned, submittedProof) => {
        receipt = callback;
        proof = submittedProof;
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
  expect(getChatDraft(draft.id)?.text).toBe('Original');
  render(
    <ChatInput
      onSend={() => false}
      onStop={() => {}}
      running={false}
      savedChatDraft={getChatDraft(draft.id)!}
      acceptedComposerDraft={proof}
    />,
  );
  expect(getChatDraft(draft.id)).toBeNull();
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', '');
});

import * as draftOwner from '../../lib/chat-drafts';
it('restores the exact silently bound saved draft through the ordinary composer owner after reload', () => {
  const bind = Reflect.get(draftOwner, 'bindChatDraftToSession') as
    ((draftId: string, sessionId: string) => string) | undefined;
  const read = Reflect.get(draftOwner, 'getSessionChatDraft') as
    ((sessionId: string) => ReturnType<typeof getChatDraft>) | undefined;
  expect(bind).toBeDefined();
  expect(read).toBeDefined();
  const draft = {
    ...createChatDraft(),
    text: 'Typed before binding',
    images: [
      { data: 'ZmFrZQ==', preview: 'data:image/png;base64,ZmFrZQ==', mediaType: 'image/png' },
    ],
    contextBlocks: ['Selected resource'],
  };
  saveChatDraft(draft);
  const before = render(
    <ChatInput onSend={() => false} onStop={() => {}} running={false} savedChatDraft={draft} />,
  );
  fireEvent.change(screen.getByLabelText('Message Mitzo'), {
    target: { value: 'Latest unsent setup text' },
  });
  expect(bind?.(draft.id, 'bound-chat')).toBe('bound');
  before.unmount();
  const selected = read?.('bound-chat');
  expect(selected?.settings).toEqual(draft.settings);
  render(
    <ChatInput
      onSend={() => false}
      onStop={() => {}}
      running={false}
      sessionId="bound-chat"
      savedChatDraft={selected ?? undefined}
    />,
  );
  expect((screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement).value).toBe(
    'Latest unsent setup text',
  );
  expect(screen.getByAltText('Attachment 1').getAttribute('src')).toBe(draft.images[0].preview);
  expect(getChatDraft(draft.id)?.contextBlocks).toEqual(['Selected resource']);
});
