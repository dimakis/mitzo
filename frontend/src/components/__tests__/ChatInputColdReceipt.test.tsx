// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SendMessageOptions } from '@mitzo/client';
import { ChatInput } from '../ChatInput';
import {
  createChatDraft,
  saveChatDraft,
  getChatDraft,
  chatDraftStorageKey,
} from '../../lib/chat-drafts';
import { acceptedComposerDraftKey } from '../../lib/composer-draft-proof';

vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../MicButton', () => ({ MicButton: () => null }));
vi.mock('../SessionResourcesDialog', () => ({ SessionResourcesDialog: () => null }));
vi.mock('../../lib/haptics', () => ({ impactMedium: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

function submit() {
  const onSend = vi.fn(() => true);
  const view = render(
    <ChatInput sessionId="chat" onSend={onSend} onStop={() => {}} running={false} />,
  );
  fireEvent.change(screen.getByLabelText('Message Mitzo'), {
    target: { value: 'Submitted exactly once' },
  });
  fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
  expect(onSend).toHaveBeenCalledOnce();
  const proof = (onSend.mock.calls[0] as unknown[])[5] as SendMessageOptions['composerDraft'];
  return { view, proof };
}

it.each([false, true])(
  'consumes the exact reloaded draft with receipt already present: %s',
  (early) => {
    const { view, proof } = submit();
    expect(proof).toMatchObject({ storageKey: 'mitzo-draft-chat' });
    view.unmount();
    const props = { sessionId: 'chat', onSend: () => false, onStop: () => {}, running: false };
    const restored = render(
      <ChatInput {...props} acceptedComposerDraft={early ? proof : undefined} />,
    );
    if (!early) {
      expect(screen.getByLabelText('Message Mitzo')).toHaveProperty(
        'value',
        'Submitted exactly once',
      );
      restored.rerender(<ChatInput {...props} acceptedComposerDraft={proof} />);
    }
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', '');
    expect(localStorage.getItem('mitzo-draft-chat')).toBeNull();
  },
);

it.each(['before-reload', 'after-reload'] as const)(
  'preserves a same-valued newer draft edited %s',
  (when) => {
    const { view, proof } = submit();
    expect(proof?.revisionToken).toBeTruthy();
    const edit = () => {
      fireEvent.change(screen.getByLabelText('Message Mitzo'), {
        target: { value: 'Independent edit' },
      });
      fireEvent.change(screen.getByLabelText('Message Mitzo'), {
        target: { value: 'Submitted exactly once' },
      });
    };
    if (when === 'before-reload') edit();
    view.unmount();
    const props = { sessionId: 'chat', onSend: () => false, onStop: () => {}, running: false };
    const restored = render(<ChatInput {...props} />);
    if (when === 'after-reload') edit();
    restored.rerender(<ChatInput {...props} acceptedComposerDraft={proof} />);
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty(
      'value',
      'Submitted exactly once',
    );
  },
);

it('preserves another composer owner and unproven legacy text', () => {
  const { view, proof } = submit();
  expect(proof?.revisionToken).toBeTruthy();
  view.unmount();
  localStorage.setItem('mitzo-draft-other-chat', 'Submitted exactly once');
  const restored = render(
    <ChatInput
      sessionId="other-chat"
      onSend={() => false}
      onStop={() => {}}
      running={false}
      acceptedComposerDraft={proof}
    />,
  );
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', 'Submitted exactly once');
  restored.unmount();
  render(<ChatInput sessionId="chat" onSend={() => false} onStop={() => {}} running={false} />);
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', 'Submitted exactly once');
});

it.each([false, true])(
  'consumes accepted rich attachments and context on cold owner restoration: %s',
  (switchOwner) => {
    const draft = {
      ...createChatDraft(),
      text: 'Accepted rich draft',
      images: [{ data: 'YWJj', preview: 'data:image/png;base64,YWJj', mediaType: 'image/png' }],
      contextBlocks: ['Accepted context'],
    };
    saveChatDraft(draft);
    const onSend = vi.fn(() => true);
    const first = render(
      <ChatInput savedChatDraft={draft} onSend={onSend} onStop={() => {}} running={false} />,
    );
    fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
    const proof = (onSend.mock.calls[0] as unknown[])[5] as NonNullable<
      SendMessageOptions['composerDraft']
    >;
    expect(proof.storageKey).toBe(chatDraftStorageKey(draft.id));
    first.unmount();
    localStorage.setItem(acceptedComposerDraftKey(proof.storageKey), JSON.stringify(proof));
    const props = { onSend: () => false, onStop: () => {}, running: false };
    const restored = render(
      <ChatInput
        {...props}
        savedChatDraft={switchOwner ? createChatDraft() : getChatDraft(draft.id)!}
      />,
    );
    if (switchOwner)
      restored.rerender(<ChatInput {...props} savedChatDraft={getChatDraft(draft.id)!} />);
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', '');
    expect(screen.queryByAltText('Attachment 1')).toBeNull();
    expect(getChatDraft(draft.id)).toBeNull();
  },
);
